'use strict';
// Banking: money in/out, transfers (incl. cross-currency), bank fees, revaluation and monthly account fees.
const { tx, all, get, run } = require('./db');
const L = require('./ledger');
const C = require('./currency');
const { bad } = L;

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const cents = (v) => { const n = Math.round(Number(v)); if (!Number.isFinite(n)) throw bad('Invalid amount'); return n; };
const str = (v, max = 500) => (v == null ? null : String(v).trim().slice(0, max) || null);

function bankAccount(org, id) {
  const a = L.assertAccount(org.id, id);
  if (!a.is_bank) throw bad('Choose a bank / cash account');
  return { ...a, cur: a.currency || org.currency };
}
const fxFields = (org, acc, amount) => (acc.cur !== org.currency ? { fx_currency: acc.cur, fx_amount: amount } : {});

// Money in / money out against a category account. Amount and fee are in the bank account's currency.
function transaction(org, t, userId) {
  if (!isDate(t.date)) throw bad('Date is required');
  const bank = bankAccount(org, t.account_id);
  const amount = cents(t.amount), fee = Math.max(0, cents(t.fee || 0));
  if (amount <= 0) throw bad('Amount must be positive');
  const other = L.assertAccount(org.id, t.category_id);
  if (other.id === bank.id) throw bad('Category must be a different account');
  const rate = C.rateFor(org, bank.cur, t.date, bank.cur === org.currency ? undefined : t.exchange_rate);
  const base = Math.round(amount * rate), feeBase = Math.round(fee * rate);
  const contact = t.contact_id ? +t.contact_id : null;
  const feeAcc = L.sysAccount(org.id, 'bank_fees').id;
  const lines = t.direction === 'in'
    ? [{ account_id: bank.id, debit: base - feeBase, ...fxFields(org, bank, amount - fee) }, { account_id: feeAcc, debit: feeBase, description: 'Bank fee' }, { account_id: other.id, credit: base, contact_id: contact }]
    : [{ account_id: other.id, debit: base, contact_id: contact }, { account_id: feeAcc, debit: feeBase, description: 'Bank fee' }, { account_id: bank.id, credit: base + feeBase, ...fxFields(org, bank, amount + fee) }];
  if (t.direction === 'in' && fee >= amount) throw bad('Fee cannot exceed the amount received');
  return L.postEntry(org.id, { date: t.date, memo: str(t.description) || (t.direction === 'in' ? 'Money in' : 'Money out'), ref_type: 'bank', lines, userId });
}

// Transfer between two bank accounts. `amount` and `fee` are in the source currency; `to_amount` in the target currency.
function transfer(org, t, userId) {
  if (!isDate(t.date)) throw bad('Date is required');
  const from = bankAccount(org, t.from_id), to = bankAccount(org, t.to_id);
  if (from.id === to.id) throw bad('Choose two different accounts');
  const amount = cents(t.amount), fee = Math.max(0, cents(t.fee || 0));
  if (amount <= 0) throw bad('Amount must be positive');
  const toAmount = from.cur === to.cur ? amount : cents(t.to_amount || 0);
  if (toAmount <= 0) throw bad(`Enter the amount received in ${to.cur}`);
  const rate = C.rateFor(org, from.cur, t.date, from.cur === org.currency ? undefined : t.exchange_rate);
  const base = Math.round(amount * rate), feeBase = Math.round(fee * rate);
  return L.postEntry(org.id, {
    date: t.date, memo: str(t.description) || `Transfer ${from.name} → ${to.name}`, ref_type: 'bank', userId,
    lines: [
      { account_id: to.id, debit: base, ...fxFields(org, to, toAmount) },
      { account_id: L.sysAccount(org.id, 'bank_fees').id, debit: feeBase, description: 'Transfer fee' },
      { account_id: from.id, credit: base + feeBase, ...fxFields(org, from, amount + fee) },
    ],
  });
}

// Bring a foreign-currency account's base value in line with the current rate (unrealised FX gain/loss).
function revalue(org, accountId, { date, exchange_rate }, userId) {
  const acc = bankAccount(org, accountId);
  if (acc.cur === org.currency) throw bad('Only foreign-currency accounts can be revalued');
  date = isDate(date) ? date : new Date().toISOString().slice(0, 10);
  const bal = L.accountBalances(org.id, { to: date }).find((a) => a.id === acc.id);
  const rate = C.rateFor(org, acc.cur, date, exchange_rate);
  const target = Math.round(bal.fx_balance * rate);
  const diff = target - bal.balance;
  if (!diff) return { diff: 0 };
  L.postEntry(org.id, {
    date, memo: `FX revaluation ${acc.name} @ ${rate}`, ref_type: 'bank', userId,
    lines: [{ account_id: acc.id, debit: diff, description: 'Revaluation' }, { account_id: L.sysAccount(org.id, 'fx').id, credit: diff, description: 'Unrealised exchange difference' }],
  });
  return { diff, rate };
}

// Post configured monthly account-maintenance fees that have fallen due (idempotent per month).
function postMonthlyFees(org, now = new Date()) {
  const ym = now.toISOString().slice(0, 7), day = now.getUTCDate();
  const accounts = all('SELECT * FROM accounts WHERE org_id = ? AND is_bank = 1 AND archived = 0 AND monthly_fee > 0', org.id);
  let posted = 0;
  for (const a of accounts) {
    if ((a.last_monthly_fee || '') >= ym || day < (a.monthly_fee_day || 1)) continue;
    const date = `${ym}-${String(Math.min(a.monthly_fee_day || 1, 28)).padStart(2, '0')}`;
    try {
      tx(() => {
        transaction(org, { account_id: a.id, category_id: L.sysAccount(org.id, 'bank_fees').id, direction: 'out', amount: a.monthly_fee, date, description: `Monthly account fee — ${a.name}` }, null);
        run('UPDATE accounts SET last_monthly_fee = ? WHERE id = ?', ym, a.id);
      });
      posted++;
    } catch (e) {
      console.error(`Monthly fee for account ${a.id} not posted: ${e.message}`);
    }
  }
  return posted;
}

function feesSummary(orgId, from, to) {
  return get(`SELECT COALESCE(SUM(l.debit - l.credit),0) total FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
    JOIN accounts a ON a.id = l.account_id WHERE e.org_id = ? AND a.system_key = 'bank_fees' AND e.date BETWEEN ? AND ?`, orgId, from, to).total;
}

module.exports = { transaction, transfer, revalue, postMonthlyFees, feesSummary };
