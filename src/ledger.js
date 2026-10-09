'use strict';
// Double-entry ledger: posting, reversals, document math and financial reports.
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

// lines: [{account_id, debit, credit, description, contact_id}] amounts in cents
function postEntry(orgId, { date, memo, ref_type = 'manual', ref_id = null, lines, userId = null }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw bad('A valid date (YYYY-MM-DD) is required');
  const clean = (lines || [])
    .map((l) => ({ ...l, debit: Math.round(+l.debit || 0), credit: Math.round(+l.credit || 0) }))
    .filter((l) => l.debit !== 0 || l.credit !== 0);
  if (clean.length < 2) throw bad('A journal entry needs at least two non-zero lines');
  let dr = 0, cr = 0;
  for (const l of clean) {
    if (l.debit < 0 || l.credit < 0) throw bad('Debits and credits must be positive');
    if (l.debit && l.credit) throw bad('A line cannot have both a debit and a credit');
    assertAccount(orgId, l.account_id);
    dr += l.debit; cr += l.credit;
  }
  if (dr !== cr) throw bad(`Entry is not balanced (debits ${dr / 100} ≠ credits ${cr / 100})`);
  return tx(() => {
    const { lastInsertRowid: id } = run(
      'INSERT INTO journal_entries (org_id, date, memo, ref_type, ref_id, created_by) VALUES (?,?,?,?,?,?)',
      orgId, date, memo || null, ref_type, ref_id, userId);
    const ins = run.bind(null, 'INSERT INTO journal_lines (entry_id, account_id, debit, credit, description, contact_id) VALUES (?,?,?,?,?,?)');
    for (const l of clean) ins(id, l.account_id, l.debit, l.credit, l.description || null, l.contact_id || null);
    return Number(id);
  });
}

// Reverse every live entry linked to a reference (keeps a full audit trail).
function reverseRef(orgId, ref_type, ref_id, date, userId) {
  const entries = all('SELECT * FROM journal_entries WHERE org_id = ? AND ref_type = ? AND ref_id = ? AND reversed_by IS NULL',
    orgId, ref_type, ref_id);
  for (const e of entries) {
    const lines = all('SELECT * FROM journal_lines WHERE entry_id = ?', e.id);
    const rid = postEntry(orgId, {
      date: date || e.date, memo: `Reversal: ${e.memo || ''}`.trim(), ref_type: ref_type + '_reversal', ref_id,
      userId, lines: lines.map((l) => ({ account_id: l.account_id, debit: l.credit, credit: l.debit, description: l.description, contact_id: l.contact_id })),
    });
    run('UPDATE journal_entries SET reversed_by = ? WHERE id = ?', rid, e.id);
    run('UPDATE journal_entries SET reversed_by = ? WHERE id = ?', e.id, rid);
  }
}

// ---------- Documents (invoices & bills) ----------
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

function postDocument(orgId, doc, userId) {
  const items = all('SELECT * FROM document_items WHERE document_id = ? ORDER BY position', doc.id);
  const { items: calc } = computeItems(items);
  const lines = [];
  const isInv = doc.kind === 'invoice';
  const fallback = sysAccount(orgId, isInv ? 'sales' : 'other_exp').id;
  // Group revenue/expense by account
  const byAcc = new Map();
  let tax = 0;
  for (const it of calc) {
    const acc = it.account_id || fallback;
    byAcc.set(acc, (byAcc.get(acc) || 0) + it.line);
    tax += it.lineTax;
  }
  const memo = `${isInv ? 'Invoice' : 'Bill'} ${doc.number}`;
  if (isInv) {
    lines.push({ account_id: sysAccount(orgId, 'ar').id, debit: doc.total, contact_id: doc.contact_id });
    for (const [acc, amt] of byAcc) lines.push(amt >= 0 ? { account_id: acc, credit: amt } : { account_id: acc, debit: -amt });
    if (tax) lines.push({ account_id: sysAccount(orgId, 'tax_out').id, credit: tax });
  } else {
    lines.push({ account_id: sysAccount(orgId, 'ap').id, credit: doc.total, contact_id: doc.contact_id });
    for (const [acc, amt] of byAcc) lines.push(amt >= 0 ? { account_id: acc, debit: amt } : { account_id: acc, credit: -amt });
    if (tax) lines.push({ account_id: sysAccount(orgId, 'tax_in').id, debit: tax });
  }
  postEntry(orgId, { date: doc.issue_date, memo, ref_type: doc.kind, ref_id: doc.id, lines, userId });
}

function refreshDocStatus(docId) {
  const d = get('SELECT * FROM documents WHERE id = ?', docId);
  if (!d || d.status === 'draft' || d.status === 'void') return;
  const paid = get('SELECT COALESCE(SUM(amount),0) s FROM payments WHERE document_id = ?', docId).s;
  const status = paid >= d.total ? 'paid' : paid > 0 ? 'partial' : (d.kind === 'invoice' ? 'sent' : 'open');
  run('UPDATE documents SET amount_paid = ?, status = ? WHERE id = ?', paid, status, docId);
}

function postPayment(orgId, doc, payment, userId) {
  const bank = assertAccount(orgId, payment.account_id);
  if (!bank.is_bank) throw bad('Payments must go to a bank / cash account');
  const isInv = doc.kind === 'invoice';
  const ctrl = sysAccount(orgId, isInv ? 'ar' : 'ap').id;
  const lines = isInv
    ? [{ account_id: bank.id, debit: payment.amount }, { account_id: ctrl, credit: payment.amount, contact_id: doc.contact_id }]
    : [{ account_id: ctrl, debit: payment.amount, contact_id: doc.contact_id }, { account_id: bank.id, credit: payment.amount }];
  postEntry(orgId, { date: payment.date, memo: `Payment ${isInv ? 'received for' : 'made on'} ${doc.number}`, ref_type: 'payment', ref_id: payment.id, lines, userId });
}

// ---------- Payroll ----------
function computePayslip(emp, { hours = 0, bonus = 0, other_deductions = null }) {
  const base = emp.pay_type === 'hourly' ? Math.round((+hours || 0) * emp.pay_rate) : emp.pay_rate;
  const gross = base + Math.round(+bonus || 0);
  const income_tax = Math.round((gross * emp.income_tax_rate) / 100);
  const social = Math.round((gross * emp.social_rate) / 100);
  const other = other_deductions == null ? emp.fixed_deduction : Math.round(+other_deductions || 0);
  const employer_cost = Math.round((gross * emp.employer_rate) / 100);
  return { hours: +hours || 0, base, bonus: Math.round(+bonus || 0), gross, income_tax, social, other_deductions: other, net: gross - income_tax - social - other, employer_cost };
}

function postPayroll(orgId, runRow, userId) {
  const slips = all('SELECT * FROM payslips WHERE run_id = ?', runRow.id);
  if (!slips.length) throw bad('This payroll run has no payslips');
  const t = slips.reduce((a, s) => {
    a.gross += s.gross; a.withheld += s.income_tax + s.social + s.other_deductions; a.net += s.net; a.employer += s.employer_cost; return a;
  }, { gross: 0, withheld: 0, net: 0, employer: 0 });
  const bank = assertAccount(orgId, runRow.bank_account_id || sysAccount(orgId, 'bank').id);
  postEntry(orgId, {
    date: runRow.pay_date, memo: `Payroll ${runRow.period_start} → ${runRow.period_end}`, ref_type: 'payroll', ref_id: runRow.id, userId,
    lines: [
      { account_id: sysAccount(orgId, 'wages').id, debit: t.gross, description: 'Gross wages' },
      { account_id: sysAccount(orgId, 'payroll_tax').id, debit: t.employer, description: 'Employer contributions' },
      { account_id: sysAccount(orgId, 'payroll_liab').id, credit: t.withheld + t.employer, description: 'Withholdings & employer contributions' },
      { account_id: bank.id, credit: t.net, description: 'Net pay' },
    ],
  });
}

// ---------- Reports ----------
function accountBalances(orgId, { from = null, to = null } = {}) {
  const rows = all(`
    SELECT a.id, a.code, a.name, a.type, a.subtype, a.is_bank, a.archived, a.system_key,
      COALESCE(SUM(l.debit),0) debit, COALESCE(SUM(l.credit),0) credit
    FROM accounts a
    LEFT JOIN journal_lines l ON l.account_id = a.id
      AND l.entry_id IN (SELECT id FROM journal_entries WHERE org_id = ?1
        AND (?2 IS NULL OR date >= ?2) AND (?3 IS NULL OR date <= ?3))
    WHERE a.org_id = ?1 GROUP BY a.id ORDER BY a.code`, orgId, from, to);
  return rows.map((r) => ({ ...r, balance: signed(r.type, r.debit, r.credit) }));
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
  const open = from ? get(`SELECT COALESCE(SUM(l.debit),0) d, COALESCE(SUM(l.credit),0) c FROM journal_lines l
    JOIN journal_entries e ON e.id = l.entry_id WHERE l.account_id = ? AND e.date < ?`, accountId, from) : { d: 0, c: 0 };
  let bal = signed(acc.type, open.d, open.c);
  const opening = bal;
  const lines = all(`SELECT l.*, e.date, e.memo, e.ref_type, e.ref_id, c.name contact_name FROM journal_lines l
    JOIN journal_entries e ON e.id = l.entry_id LEFT JOIN contacts c ON c.id = l.contact_id
    WHERE l.account_id = ? AND (? IS NULL OR e.date >= ?) AND (? IS NULL OR e.date <= ?)
    ORDER BY e.date, e.id, l.id`, accountId, from, from, to, to).map((l) => {
    bal += signed(acc.type, l.debit, l.credit);
    return { ...l, balance: bal };
  });
  return { account: acc, from, to, opening, closing: bal, lines };
}

function aging(orgId, kind, asOf) {
  const docs = all(`SELECT d.*, c.name contact_name FROM documents d LEFT JOIN contacts c ON c.id = d.contact_id
    WHERE d.org_id = ? AND d.kind = ? AND d.status NOT IN ('draft','void','paid') ORDER BY d.due_date`, orgId, kind);
  const buckets = ['current', '1-30', '31-60', '61-90', '90+'];
  const totals = Object.fromEntries(buckets.map((b) => [b, 0]));
  const day = 86400000, ref = Date.parse(asOf);
  const rows = docs.map((d) => {
    const due = d.total - d.amount_paid;
    const late = Math.floor((ref - Date.parse(d.due_date)) / day);
    const bucket = late <= 0 ? 'current' : late <= 30 ? '1-30' : late <= 60 ? '31-60' : late <= 90 ? '61-90' : '90+';
    totals[bucket] += due;
    return { ...d, due, days_overdue: Math.max(0, late), bucket };
  });
  return { asOf, kind, buckets, rows, totals, total: rows.reduce((s, r) => s + r.due, 0) };
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

function summary(orgId) {
  const today = new Date().toISOString().slice(0, 10);
  const yearStart = today.slice(0, 4) + '-01-01', monthStart = today.slice(0, 8) + '01';
  const bal = accountBalances(orgId, { to: today });
  const cash = bal.filter((a) => a.is_bank && a.type === 'asset').reduce((s, a) => s + a.balance, 0);
  const ar = get(`SELECT COALESCE(SUM(total - amount_paid),0) s, COUNT(*) n, COALESCE(SUM(CASE WHEN due_date < ? THEN total-amount_paid END),0) overdue
    FROM documents WHERE org_id = ? AND kind='invoice' AND status IN ('sent','partial')`, today, orgId);
  const ap = get(`SELECT COALESCE(SUM(total - amount_paid),0) s, COUNT(*) n FROM documents WHERE org_id = ? AND kind='bill' AND status IN ('open','partial')`, orgId);
  const ytd = profitAndLoss(orgId, yearStart, today), mtd = profitAndLoss(orgId, monthStart, today);
  return { cash, ar: ar.s, arCount: ar.n, overdue: ar.overdue, ap: ap.s, apCount: ap.n,
    ytdIncome: ytd.totalIncome, ytdExpenses: ytd.totalExpenses + ytd.totalCogs, ytdNet: ytd.netIncome, mtdNet: mtd.netIncome,
    employees: get('SELECT COUNT(*) n FROM employees WHERE org_id = ? AND active = 1', orgId).n };
}

module.exports = {
  HttpError, bad, signed, sysAccount, assertAccount, postEntry, reverseRef,
  computeItems, postDocument, refreshDocStatus, postPayment, computePayslip, postPayroll,
  accountBalances, profitAndLoss, balanceSheet, trialBalance, generalLedger, aging, monthlySeries, budgetVsActual, summary,
};
