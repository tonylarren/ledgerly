'use strict';
// Invoices & bills: create/edit drafts, post to the ledger (incl. inventory and foreign currency),
// payments with bank fees and realised exchange differences, voids, and recurring generation.
const { tx, all, get, run } = require('./db');
const L = require('./ledger');
const C = require('./currency');
const I = require('./inventory');
const { bad, HttpError } = L;

const OPEN = { invoice: 'sent', bill: 'open' };
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const str = (v, max = 500) => (v == null ? null : String(v).trim().slice(0, max) || null);
const cents = (v) => { const n = Math.round(Number(v)); if (!Number.isFinite(n)) throw bad('Invalid amount'); return n; };

function load(org, kind, id) {
  const d = get(`SELECT d.*, c.name contact_name, c.email contact_email, c.address contact_address, c.tax_id contact_tax_id
    FROM documents d LEFT JOIN contacts c ON c.id = d.contact_id WHERE d.id = ? AND d.org_id = ? AND d.kind = ?`, id, org.id, kind);
  if (!d) throw new HttpError(404, `${kind} not found`);
  d.currency = d.currency || org.currency;
  return d;
}

function full(org, kind, id) {
  const d = load(org, kind, id);
  return { ...d,
    items: all(`SELECT i.*, a.code account_code, a.name account_name, p.name product_name, p.sku product_sku, p.kind product_kind
      FROM document_items i LEFT JOIN accounts a ON a.id = i.account_id LEFT JOIN products p ON p.id = i.product_id
      WHERE document_id = ? ORDER BY position`, d.id),
    payments: all('SELECT p.*, a.name account_name, a.currency account_currency FROM payments p JOIN accounts a ON a.id = p.account_id WHERE document_id = ? ORDER BY date', d.id),
    emails: all('SELECT e.*, u.name user_name FROM email_log e LEFT JOIN users u ON u.id = e.user_id WHERE document_id = ? ORDER BY e.id DESC', d.id),
  };
}

// Base-currency breakdown of computed items (sum of rounded lines, so the entry always balances).
function baseTotals(calc, rate) {
  let total = 0;
  const lines = calc.map((it) => { const line = Math.round(it.line * rate), tax = Math.round(it.lineTax * rate); total += line + tax; return { ...it, lineBase: line, taxBase: tax }; });
  return { lines, total };
}

function save(org, kind, body, existing, userId) {
  if (!isDate(body.issue_date)) throw bad('Issue date is required');
  const due = isDate(body.due_date) ? body.due_date : addDays(body.issue_date, org.payment_terms);
  if (due < body.issue_date) throw bad('Due date cannot be before the issue date');
  const contact = body.contact_id ? get('SELECT id FROM contacts WHERE id = ? AND org_id = ?', body.contact_id, org.id) : null;
  if (!contact) throw bad(`Choose a ${kind === 'invoice' ? 'customer' : 'vendor'}`);
  const currency = C.normalize(org, body.currency);
  const rate = C.rateFor(org, currency, body.issue_date, currency === org.currency ? undefined : body.exchange_rate);
  const items = (Array.isArray(body.items) ? body.items : []).filter((i) => str(i.description));
  if (!items.length) throw bad('Add at least one line item');
  for (const i of items) {
    if (i.account_id) L.assertAccount(org.id, i.account_id);
    if (i.product_id) I.loadProduct(org.id, i.product_id);
  }
  const c = L.computeItems(items);
  const totalBase = baseTotals(c.items, rate).total;
  return tx(() => {
    let id;
    if (existing) {
      id = existing.id;
      run(`UPDATE documents SET contact_id=?, issue_date=?, due_date=?, reference=?, notes=?, subtotal=?, tax=?, total=?, number=?,
        currency=?, exchange_rate=?, total_base=? WHERE id = ?`,
        contact.id, body.issue_date, due, str(body.reference), str(body.notes, 5000), c.subtotal, c.tax, c.total, str(body.number, 40) || existing.number,
        currency, rate, totalBase, id);
      run('DELETE FROM document_items WHERE document_id = ?', id);
    } else {
      const o = get(`SELECT ${kind}_prefix p, next_${kind}_no n FROM orgs WHERE id = ?`, org.id);
      const number = str(body.number, 40) || `${o.p}${String(o.n).padStart(4, '0')}`;
      if (!str(body.number, 40)) run(`UPDATE orgs SET next_${kind}_no = next_${kind}_no + 1 WHERE id = ?`, org.id);
      if (get('SELECT 1 FROM documents WHERE org_id = ? AND kind = ? AND number = ?', org.id, kind, number)) throw bad(`Number ${number} is already used`);
      id = Number(run(`INSERT INTO documents (org_id, kind, number, contact_id, issue_date, due_date, reference, notes, subtotal, tax, total, currency, exchange_rate, total_base, recurring_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        org.id, kind, number, contact.id, body.issue_date, due, str(body.reference), str(body.notes, 5000), c.subtotal, c.tax, c.total, currency, rate, totalBase, body.recurring_id || null).lastInsertRowid);
    }
    for (const it of c.items) run('INSERT INTO document_items (document_id, description, quantity, unit_price, tax_rate, account_id, product_id, position) VALUES (?,?,?,?,?,?,?,?)',
      id, str(it.description, 1000), it.quantity, it.unit_price, it.tax_rate, it.account_id || null, it.product_id || null, it.position);
    return id;
  });
}

function post(org, doc, userId) {
  const items = all('SELECT * FROM document_items WHERE document_id = ? ORDER BY position', doc.id);
  const rate = doc.exchange_rate || 1;
  const { lines: calc, total: totalBase } = baseTotals(L.computeItems(items).items, rate);
  const isInv = doc.kind === 'invoice';
  const fallback = L.sysAccount(org.id, isInv ? 'sales' : 'other_exp').id;
  const byAcc = new Map();
  let taxBase = 0, cogs = 0;
  for (const it of calc) {
    const product = it.product_id ? get('SELECT * FROM products WHERE id = ?', it.product_id) : null;
    const stock = product && product.kind === 'inventory';
    let acc;
    if (isInv) {
      acc = it.account_id || (product && product.income_account_id) || fallback;
      if (stock && it.quantity) {
        if (it.quantity > 0) cogs += I.issue(org.id, product, it.quantity, doc.issue_date, 'invoice', doc.id);
        else { const back = Math.round(I.avgCost(product) * -it.quantity); I.receive(org.id, product, -it.quantity, back, doc.issue_date, 'invoice', doc.id); cogs -= back; }
      }
    } else {
      acc = stock ? L.sysAccount(org.id, 'inventory').id : it.account_id || (product && product.expense_account_id) || fallback;
      if (stock && it.quantity) I.receive(org.id, product, it.quantity, it.lineBase, doc.issue_date, 'bill', doc.id);
    }
    byAcc.set(acc, (byAcc.get(acc) || 0) + it.lineBase);
    taxBase += it.taxBase;
  }
  const foreign = doc.currency && doc.currency !== org.currency;
  const fx = foreign ? { fx_currency: doc.currency, fx_amount: doc.total } : {};
  const lines = [];
  if (isInv) {
    lines.push({ account_id: L.sysAccount(org.id, 'ar').id, debit: totalBase, contact_id: doc.contact_id, ...fx });
    for (const [acc, amt] of byAcc) lines.push({ account_id: acc, credit: amt });
    if (taxBase) lines.push({ account_id: L.sysAccount(org.id, 'tax_out').id, credit: taxBase });
    if (cogs) lines.push({ account_id: L.sysAccount(org.id, 'cogs').id, debit: cogs, description: 'Cost of goods sold' }, { account_id: L.sysAccount(org.id, 'inventory').id, credit: cogs, description: 'Cost of goods sold' });
  } else {
    lines.push({ account_id: L.sysAccount(org.id, 'ap').id, credit: totalBase, contact_id: doc.contact_id, ...fx });
    for (const [acc, amt] of byAcc) lines.push({ account_id: acc, debit: amt });
    if (taxBase) lines.push({ account_id: L.sysAccount(org.id, 'tax_in').id, debit: taxBase });
  }
  L.postEntry(org.id, { date: doc.issue_date, memo: `${isInv ? 'Invoice' : 'Bill'} ${doc.number}${foreign ? ` (${doc.currency})` : ''}`, ref_type: doc.kind, ref_id: doc.id, lines, userId });
  run('UPDATE documents SET total_base = ? WHERE id = ?', totalBase, doc.id);
}

function finalize(org, kind, id, userId) {
  return tx(() => {
    const d = load(org, kind, id);
    if (d.status !== 'draft') throw bad('Already finalised');
    post(org, d, userId);
    run('UPDATE documents SET status = ? WHERE id = ?', OPEN[kind], d.id);
    return d;
  });
}

function voidDoc(org, kind, id, userId) {
  const d = load(org, kind, id);
  if (d.status === 'draft' || d.status === 'void') throw bad('Only finalised documents can be voided');
  if (d.amount_paid > 0) throw bad('Remove payments before voiding');
  tx(() => {
    L.reverseRef(org.id, kind, d.id, today(), userId);
    I.reverseMoves(org.id, kind, d.id, today());
    run(`UPDATE documents SET status = 'void' WHERE id = ?`, d.id);
  });
  return d;
}

function refreshStatus(docId) {
  const d = get('SELECT * FROM documents WHERE id = ?', docId);
  if (!d || d.status === 'draft' || d.status === 'void') return;
  const p = get('SELECT COALESCE(SUM(amount),0) paid, COALESCE(SUM(ar_base),0) base FROM payments WHERE document_id = ?', docId);
  const status = p.paid >= d.total ? 'paid' : p.paid > 0 ? 'partial' : OPEN[d.kind];
  run('UPDATE documents SET amount_paid = ?, paid_base = ?, status = ? WHERE id = ?', p.paid, p.base, status, docId);
}

// Suggested fee for a bank account: fixed + percentage of the amount (in the account's currency).
const suggestedFee = (bank, amount) => Math.round((bank.fee_fixed || 0) + (amount * (bank.fee_percent || 0)) / 100);

function addPayment(org, kind, id, body, userId) {
  const d = load(org, kind, id);
  if (!['sent', 'open', 'partial'].includes(d.status)) throw bad(`Payments can only be recorded on unpaid ${kind}s`);
  const amount = cents(body.amount);
  if (amount <= 0) throw bad('Amount must be positive');
  const remaining = d.total - d.amount_paid;
  if (amount > remaining) throw bad('Payment is larger than the amount due');
  const date = isDate(body.date) ? body.date : today();
  const bank = L.assertAccount(org.id, body.account_id);
  if (!bank.is_bank) throw bad('Payments must go through a bank / cash account');
  const base = org.currency, docCur = d.currency, bankCur = bank.currency || base;
  if (bankCur !== base && bankCur !== docCur) throw bad(`Use an account in ${docCur}${docCur !== base ? ' or ' + base : ''} for this payment`);
  const payRate = docCur === base ? 1 : C.rateFor(org, docCur, date, body.exchange_rate);
  const fee = Math.max(0, cents(body.fee || 0));
  const feeBase = bankCur === base ? fee : Math.round(fee * payRate);
  const paidBase = Math.round(amount * payRate);
  const arBase = amount === remaining ? d.total_base - d.paid_base : Math.round(amount * d.exchange_rate);
  const diff = paidBase - arBase;
  const isInv = kind === 'invoice';
  const bankFx = bankCur !== base ? { fx_currency: bankCur, fx_amount: isInv ? amount - fee : amount + fee } : {};
  const ctrlFx = docCur !== base ? { fx_currency: docCur, fx_amount: amount } : {};
  if (isInv && paidBase - feeBase <= 0) throw bad('Bank fee cannot exceed the payment');
  const ctrl = L.sysAccount(org.id, isInv ? 'ar' : 'ap').id;
  const feeAcc = L.sysAccount(org.id, 'bank_fees').id;
  const fxAcc = L.sysAccount(org.id, 'fx').id;
  return tx(() => {
    const pid = Number(run(`INSERT INTO payments (org_id, document_id, date, amount, account_id, method, reference, currency, exchange_rate, fee, ar_base)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`, org.id, d.id, date, amount, bank.id, str(body.method, 40), str(body.reference, 100), docCur, payRate, fee, arBase).lastInsertRowid);
    const lines = isInv
      ? [
        { account_id: bank.id, debit: paidBase - feeBase, ...bankFx },
        { account_id: feeAcc, debit: feeBase, description: 'Bank fee' },
        { account_id: ctrl, credit: arBase, contact_id: d.contact_id, ...ctrlFx },
        { account_id: fxAcc, credit: diff, description: 'Realised exchange difference' },
      ]
      : [
        { account_id: ctrl, debit: arBase, contact_id: d.contact_id, ...ctrlFx },
        { account_id: feeAcc, debit: feeBase, description: 'Bank fee' },
        { account_id: bank.id, credit: paidBase + feeBase, ...bankFx },
        { account_id: fxAcc, debit: diff, description: 'Realised exchange difference' },
      ];
    L.postEntry(org.id, { date, memo: `Payment ${isInv ? 'received for' : 'made on'} ${d.number}`, ref_type: 'payment', ref_id: pid, lines, userId });
    refreshStatus(d.id);
    return { id: pid, amount, fee, diff };
  });
}

function deletePayment(org, kind, id, pid, userId) {
  const d = load(org, kind, id);
  const p = get('SELECT * FROM payments WHERE id = ? AND document_id = ?', pid, d.id);
  if (!p) throw new HttpError(404, 'Payment not found');
  tx(() => {
    L.reverseRef(org.id, 'payment', p.id, today(), userId);
    run('DELETE FROM payments WHERE id = ?', p.id);
    refreshStatus(d.id);
  });
  return p;
}

// ---------- recurring invoices ----------
const FREQ_MONTHS = { monthly: 1, quarterly: 3, yearly: 12 };
function nextDate(date, frequency, n, anchorDay) {
  const d = new Date(date + 'T00:00:00Z');
  if (frequency === 'weekly') return addDays(date, 7 * n);
  const months = FREQ_MONTHS[frequency] * n;
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + months;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(anchorDay || d.getUTCDate(), last))).toISOString().slice(0, 10);
}

function generateFromTemplate(org, tpl, date, userId = null) {
  const id = save(org, 'invoice', {
    contact_id: tpl.contact_id, currency: tpl.currency || org.currency, issue_date: date,
    due_date: addDays(date, tpl.due_days != null ? tpl.due_days : org.payment_terms),
    reference: tpl.reference, notes: tpl.notes, items: JSON.parse(tpl.items), recurring_id: tpl.id,
  }, null, userId);
  if (tpl.auto_finalize) finalize(org, 'invoice', id, userId);
  return id;
}

module.exports = { OPEN, load, full, save, post, finalize, voidDoc, refreshStatus, suggestedFee, addPayment, deletePayment, nextDate, generateFromTemplate };
