'use strict';
// Double-entry ledger core: posting, reversals and financial reports.
// All ledger amounts are integer cents in the organisation's base currency. Lines may also
// carry the original foreign-currency amount (fx_currency / fx_amount) for multi-currency accounts.
const { tx, all, get, run } = require('./db');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);

const DEBIT_NORMAL = new Set(['asset', 'expense']);
const signed = (type, debit, credit) => (DEBIT_NORMAL.has(type) ? debit - credit : credit - debit);

function sysAccount(orgId, key) {
  const a = get('SELECT * FROM accounts WHERE org_id = ? AND system_key = ?', orgId, key);
  if (!a) throw bad(`System account "${key}" is missing from the chart of accounts`);
  return a;
}

function assertAccount(orgId, accountId) {
  const a = get('SELECT * FROM accounts WHERE id = ? AND org_id = ?', accountId, orgId);
  if (!a) throw bad(`Account ${accountId} not found`);
  if (a.archived) throw bad(`Account ${a.code} ${a.name} is archived`);
  return a;
}

// lines: [{account_id, debit, credit, description, contact_id, fx_currency, fx_amount}] amounts in base cents
function postEntry(orgId, { date, memo, ref_type = 'manual', ref_id = null, lines, userId = null }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw bad('A valid date (YYYY-MM-DD) is required');
  // Net each line to a single positive side (a negative debit becomes a credit and vice versa).
  const clean = (lines || []).map((l) => {
    const net = Math.round(+l.debit || 0) - Math.round(+l.credit || 0);
    return { ...l, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 };
  }).filter((l) => l.debit !== 0 || l.credit !== 0);
  if (clean.length < 2) throw bad('A journal entry needs at least two non-zero lines');
  let dr = 0, cr = 0;
  for (const l of clean) {
    assertAccount(orgId, l.account_id);
    dr += l.debit; cr += l.credit;
  }
  if (dr !== cr) throw bad(`Entry is not balanced (debits ${dr / 100} ≠ credits ${cr / 100})`);
  return tx(() => {
    const { lastInsertRowid: id } = run(
      'INSERT INTO journal_entries (org_id, date, memo, ref_type, ref_id, created_by) VALUES (?,?,?,?,?,?)',
      orgId, date, memo || null, ref_type, ref_id, userId);
    for (const l of clean) {
      run('INSERT INTO journal_lines (entry_id, account_id, debit, credit, description, contact_id, fx_currency, fx_amount) VALUES (?,?,?,?,?,?,?,?)',
        id, l.account_id, l.debit, l.credit, l.description || null, l.contact_id || null,
        l.fx_currency || null, l.fx_currency ? Math.abs(Math.round(+l.fx_amount || 0)) : null);
    }
    return Number(id);
  });
}

function reverseEntry(orgId, entry, { date, memo, ref_type, ref_id, userId }) {
  const lines = all('SELECT * FROM journal_lines WHERE entry_id = ?', entry.id);
  const rid = postEntry(orgId, {
    date: date || entry.date, memo: memo || `Reversal: ${entry.memo || '#' + entry.id}`, ref_type, ref_id, userId,
    lines: lines.map((l) => ({ account_id: l.account_id, debit: l.credit, credit: l.debit, description: l.description, contact_id: l.contact_id, fx_currency: l.fx_currency, fx_amount: l.fx_amount })),
  });
  run('UPDATE journal_entries SET reversed_by = ? WHERE id = ?', rid, entry.id);
  run('UPDATE journal_entries SET reversed_by = ? WHERE id = ?', entry.id, rid);
  return rid;
}

// Reverse every live entry linked to a reference (keeps a full audit trail).
function reverseRef(orgId, ref_type, ref_id, date, userId) {
  const entries = all('SELECT * FROM journal_entries WHERE org_id = ? AND ref_type = ? AND ref_id = ? AND reversed_by IS NULL', orgId, ref_type, ref_id);
  return tx(() => entries.map((e) => reverseEntry(orgId, e, { date, ref_type: ref_type + '_reversal', ref_id, userId })));
}

// Document line maths in document currency (cents).
function computeItems(items) {
  let subtotal = 0, tax = 0;
  const out = items.map((it, i) => {
    const qty = +it.quantity || 0, price = Math.round(+it.unit_price || 0), rate = +it.tax_rate || 0;
    const line = Math.round(qty * price);
    const lineTax = Math.round((line * rate) / 100);
    subtotal += line; tax += lineTax;
    return { ...it, quantity: qty, unit_price: price, tax_rate: rate, line, lineTax, position: i };
  });
  return { items: out, subtotal, tax, total: subtotal + tax };
}

// ---------- Reports ----------
function accountBalances(orgId, { from = null, to = null } = {}) {
  const rows = all(`
    SELECT a.*,
      COALESCE(SUM(l.debit),0) debit, COALESCE(SUM(l.credit),0) credit,
      COALESCE(SUM(CASE WHEN l.fx_currency = a.currency THEN (CASE WHEN l.debit > 0 THEN l.fx_amount ELSE -l.fx_amount END) END),0) fx_net
    FROM accounts a
    LEFT JOIN journal_lines l ON l.account_id = a.id
      AND l.entry_id IN (SELECT id FROM journal_entries WHERE org_id = ?1
        AND (?2 IS NULL OR date >= ?2) AND (?3 IS NULL OR date <= ?3))
    WHERE a.org_id = ?1 GROUP BY a.id ORDER BY a.code`, orgId, from, to);
  return rows.map((r) => ({ ...r, balance: signed(r.type, r.debit, r.credit), fx_balance: r.currency ? (DEBIT_NORMAL.has(r.type) ? r.fx_net : -r.fx_net) : null }));
}

function profitAndLoss(orgId, from, to) {
  const b = accountBalances(orgId, { from, to });
  const income = b.filter((a) => a.type === 'income' && a.balance !== 0);
  const cogs = b.filter((a) => a.type === 'expense' && a.subtype === 'cogs' && a.balance !== 0);
  const expenses = b.filter((a) => a.type === 'expense' && a.subtype !== 'cogs' && a.balance !== 0);
  const sum = (xs) => xs.reduce((s, a) => s + a.balance, 0);
  const totalIncome = sum(income), totalCogs = sum(cogs), totalExpenses = sum(expenses);
  return { from, to, income, cogs, expenses, totalIncome, totalCogs, grossProfit: totalIncome - totalCogs, totalExpenses, netIncome: totalIncome - totalCogs - totalExpenses };
}

function balanceSheet(orgId, asOf) {
  const b = accountBalances(orgId, { to: asOf });
  const pick = (t) => b.filter((a) => a.type === t && a.balance !== 0);
  const sum = (xs) => xs.reduce((s, a) => s + a.balance, 0);
  const earnings = sum(b.filter((a) => a.type === 'income')) - sum(b.filter((a) => a.type === 'expense'));
  const assets = pick('asset'), liabilities = pick('liability'), equity = pick('equity');
  const totalAssets = sum(assets), totalLiabilities = sum(liabilities), totalEquity = sum(equity) + earnings;
  return { asOf, assets, liabilities, equity, earnings, totalAssets, totalLiabilities, totalEquity, balanced: totalAssets === totalLiabilities + totalEquity };
}

function trialBalance(orgId, asOf) {
  const rows = accountBalances(orgId, { to: asOf }).filter((a) => a.debit || a.credit).map((a) => {
    const net = a.debit - a.credit;
    return { ...a, tb_debit: net > 0 ? net : 0, tb_credit: net < 0 ? -net : 0 };
  });
  return { asOf, rows, totalDebit: rows.reduce((s, r) => s + r.tb_debit, 0), totalCredit: rows.reduce((s, r) => s + r.tb_credit, 0) };
}

function generalLedger(orgId, accountId, from, to) {
  const acc = get('SELECT * FROM accounts WHERE id = ? AND org_id = ?', accountId, orgId);
  if (!acc) throw new HttpError(404, 'Account not found');
  const fxSign = (l) => (l.fx_currency && l.fx_currency === acc.currency ? (l.debit > 0 ? l.fx_amount : -l.fx_amount) * (DEBIT_NORMAL.has(acc.type) ? 1 : -1) : 0);
  const open = from ? get(`SELECT COALESCE(SUM(l.debit),0) d, COALESCE(SUM(l.credit),0) c,
      COALESCE(SUM(CASE WHEN l.fx_currency = ? THEN (CASE WHEN l.debit > 0 THEN l.fx_amount ELSE -l.fx_amount END) END),0) fx
    FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE l.account_id = ? AND e.date < ?`, acc.currency, accountId, from) : { d: 0, c: 0, fx: 0 };
  let bal = signed(acc.type, open.d, open.c);
  let fxBal = acc.currency ? open.fx * (DEBIT_NORMAL.has(acc.type) ? 1 : -1) : null;
  const opening = bal, fxOpening = fxBal;
  const lines = all(`SELECT l.*, e.date, e.memo, e.ref_type, e.ref_id, c.name contact_name FROM journal_lines l
    JOIN journal_entries e ON e.id = l.entry_id LEFT JOIN contacts c ON c.id = l.contact_id
    WHERE l.account_id = ? AND (? IS NULL OR e.date >= ?) AND (? IS NULL OR e.date <= ?)
    ORDER BY e.date, e.id, l.id`, accountId, from, from, to, to).map((l) => {
    bal += signed(acc.type, l.debit, l.credit);
    if (acc.currency) fxBal += fxSign(l);
    return { ...l, balance: bal, fx_balance: fxBal };
  });
  return { account: acc, from, to, opening, closing: bal, fxOpening, fxClosing: fxBal, lines };
}

function aging(orgId, kind, asOf) {
  const docs = all(`SELECT d.*, c.name contact_name FROM documents d LEFT JOIN contacts c ON c.id = d.contact_id
    WHERE d.org_id = ? AND d.kind = ? AND d.status NOT IN ('draft','void','paid') ORDER BY d.due_date`, orgId, kind);
  const buckets = ['current', '1-30', '31-60', '61-90', '90+'];
  const totals = Object.fromEntries(buckets.map((b) => [b, 0]));
  const day = 86400000, ref = Date.parse(asOf);
  const rows = docs.map((d) => {
    const due = d.total - d.amount_paid, dueBase = d.total_base - d.paid_base;
    const late = Math.floor((ref - Date.parse(d.due_date)) / day);
    const bucket = late <= 0 ? 'current' : late <= 30 ? '1-30' : late <= 60 ? '31-60' : late <= 90 ? '61-90' : '90+';
    totals[bucket] += dueBase;
    return { ...d, due, due_base: dueBase, days_overdue: Math.max(0, late), bucket };
  });
  return { asOf, kind, buckets, rows, totals, total: rows.reduce((s, r) => s + r.due_base, 0) };
}

function monthlySeries(orgId, months = 12) {
  const now = new Date();
  const out = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const from = d.toISOString().slice(0, 10);
    const to = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    const r = get(`SELECT
      COALESCE(SUM(CASE WHEN a.type='income' THEN l.credit - l.debit END),0) income,
      COALESCE(SUM(CASE WHEN a.type='expense' THEN l.debit - l.credit END),0) expense
      FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
      WHERE e.org_id = ? AND e.date BETWEEN ? AND ?`, orgId, from, to);
    out.push({ month: from.slice(0, 7), income: r.income, expense: r.expense, net: r.income - r.expense });
  }
  return out;
}

function budgetVsActual(orgId, year) {
  const from = `${year}-01-01`, to = `${year}-12-31`;
  const bal = accountBalances(orgId, { from, to }).filter((a) => a.type === 'income' || a.type === 'expense');
  const budgets = new Map(all('SELECT account_id, amount FROM budgets WHERE org_id = ? AND year = ?', orgId, year).map((b) => [b.account_id, b.amount]));
  const rows = bal.filter((a) => !a.archived || budgets.has(a.id) || a.balance)
    .map((a) => ({ id: a.id, code: a.code, name: a.name, type: a.type, budget: budgets.get(a.id) || 0, actual: a.balance, variance: a.balance - (budgets.get(a.id) || 0) }));
  return { year, rows };
}

function inventoryValuation(orgId) {
  const products = all(`SELECT * FROM products WHERE org_id = ? AND kind = 'inventory' ORDER BY name`, orgId)
    .map((p) => ({ ...p, avg_cost: p.qty > 0 ? Math.round(p.value / p.qty) : 0, low: p.reorder_level > 0 && p.qty <= p.reorder_level }));
  const inv = get(`SELECT id FROM accounts WHERE org_id = ? AND system_key = 'inventory'`, orgId);
  const ledger = inv ? accountBalances(orgId).find((a) => a.id === inv.id).balance : 0;
  const total = products.reduce((s, p) => s + p.value, 0);
  return { products, total, ledger, difference: ledger - total };
}

function summary(orgId) {
  const today = new Date().toISOString().slice(0, 10);
  const yearStart = today.slice(0, 4) + '-01-01', monthStart = today.slice(0, 8) + '01';
  const bal = accountBalances(orgId, { to: today });
  const cash = bal.filter((a) => a.is_bank && a.type === 'asset').reduce((s, a) => s + a.balance, 0);
  const ar = get(`SELECT COALESCE(SUM(total_base - paid_base),0) s, COUNT(*) n, COALESCE(SUM(CASE WHEN due_date < ? THEN total_base - paid_base END),0) overdue
    FROM documents WHERE org_id = ? AND kind='invoice' AND status IN ('sent','partial')`, today, orgId);
  const ap = get(`SELECT COALESCE(SUM(total_base - paid_base),0) s, COUNT(*) n FROM documents WHERE org_id = ? AND kind='bill' AND status IN ('open','partial')`, orgId);
  const ytd = profitAndLoss(orgId, yearStart, today), mtd = profitAndLoss(orgId, monthStart, today);
  const stock = get(`SELECT COALESCE(SUM(value),0) value, COALESCE(SUM(CASE WHEN reorder_level > 0 AND qty <= reorder_level THEN 1 END),0) low
    FROM products WHERE org_id = ? AND kind = 'inventory' AND active = 1`, orgId);
  return { cash, ar: ar.s, arCount: ar.n, overdue: ar.overdue, ap: ap.s, apCount: ap.n,
    ytdIncome: ytd.totalIncome, ytdExpenses: ytd.totalExpenses + ytd.totalCogs, ytdNet: ytd.netIncome, mtdNet: mtd.netIncome,
    employees: get('SELECT COUNT(*) n FROM employees WHERE org_id = ? AND active = 1', orgId).n,
    stockValue: stock.value, lowStock: stock.low };
}

module.exports = {
  HttpError, bad, signed, sysAccount, assertAccount, postEntry, reverseEntry, reverseRef, computeItems,
  accountBalances, profitAndLoss, balanceSheet, trialBalance, generalLedger, aging, monthlySeries, budgetVsActual, inventoryValuation, summary,
};
