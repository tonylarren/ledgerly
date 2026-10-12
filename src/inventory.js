'use strict';
// Inventory: products, stock movements and weighted-average costing.
// Product value and movement values are base-currency cents; quantities may be fractional.
const { tx, all, get, run } = require('./db');
const L = require('./ledger');
const { bad, HttpError } = L;

const KINDS = ['inventory', 'service', 'non_inventory'];

function loadProduct(orgId, id) {
  const p = get('SELECT * FROM products WHERE id = ? AND org_id = ?', id, orgId);
  if (!p) throw new HttpError(404, 'Product not found');
  return p;
}

const avgCost = (p) => (p.qty > 0 ? p.value / p.qty : p.purchase_price);

// Record a stock movement and update the product's running quantity and value.
function move(orgId, productId, { date, qty, value, ref_type, ref_id = null, note = null }) {
  run('INSERT INTO stock_moves (org_id, product_id, date, qty, value, ref_type, ref_id, note) VALUES (?,?,?,?,?,?,?,?)',
    orgId, productId, date, qty, Math.round(value), ref_type, ref_id, note);
  run('UPDATE products SET qty = qty + ?, value = value + ? WHERE id = ?', qty, Math.round(value), productId);
}

// Goods leaving stock at average cost; returns the cost of the goods (positive cents).
function issue(orgId, product, qty, date, ref_type, ref_id) {
  const p = get('SELECT * FROM products WHERE id = ?', product.id);
  const cost = Math.round(avgCost(p) * qty);
  move(orgId, p.id, { date, qty: -qty, value: -cost, ref_type, ref_id });
  return cost;
}

function receive(orgId, product, qty, cost, date, ref_type, ref_id) {
  move(orgId, product.id, { date, qty, value: cost, ref_type, ref_id });
}

// Undo the stock effect of a document (void / reversal) using the exact original values.
function reverseMoves(orgId, ref_type, ref_id, date) {
  const moves = all('SELECT * FROM stock_moves WHERE org_id = ? AND ref_type = ? AND ref_id = ? AND reversed = 0', orgId, ref_type, ref_id);
  for (const m of moves) {
    move(orgId, m.product_id, { date, qty: -m.qty, value: -m.value, ref_type: ref_type + '_reversal', ref_id, note: `Reversal of movement #${m.id}` });
    run('UPDATE stock_moves SET reversed = 1 WHERE id = ?', m.id);
  }
}

// Manual stock adjustment (count correction, damage, opening stock).
function adjust(orgId, productId, { date, qty, unit_cost, account_id, note }, userId) {
  const p = loadProduct(orgId, productId);
  if (p.kind !== 'inventory') throw bad('Only stock items can be adjusted');
  qty = Number(qty);
  if (!qty || !Number.isFinite(qty)) throw bad('Enter a non-zero quantity');
  const inv = L.sysAccount(orgId, 'inventory');
  const offset = account_id ? L.assertAccount(orgId, account_id) : L.sysAccount(orgId, 'inv_adjust');
  return tx(() => {
    const value = qty > 0 ? Math.round(qty * (unit_cost != null && unit_cost !== '' ? Math.round(+unit_cost) : avgCost(p))) : -Math.round(avgCost(p) * -qty);
    const { lastInsertRowid } = run('INSERT INTO stock_moves (org_id, product_id, date, qty, value, ref_type, note) VALUES (?,?,?,?,?,?,?)',
      orgId, p.id, date, qty, value, 'adjustment', note || null);
    run('UPDATE products SET qty = qty + ?, value = value + ? WHERE id = ?', qty, value, p.id);
    if (value) {
      L.postEntry(orgId, {
        date, memo: `Stock adjustment: ${p.name}${note ? ' — ' + note : ''}`, ref_type: 'stock', ref_id: Number(lastInsertRowid), userId,
        lines: value > 0
          ? [{ account_id: inv.id, debit: value }, { account_id: offset.id, credit: value }]
          : [{ account_id: offset.id, debit: -value }, { account_id: inv.id, credit: -value }],
      });
    }
    return { qty, value };
  });
}

function productValues(b, prev = {}) {
  const v = {
    sku: b.sku !== undefined ? (String(b.sku || '').trim().slice(0, 60) || null) : prev.sku ?? null,
    name: b.name !== undefined ? String(b.name || '').trim().slice(0, 200) : prev.name,
    description: b.description !== undefined ? (String(b.description || '').trim().slice(0, 2000) || null) : prev.description ?? null,
    unit: b.unit !== undefined ? (String(b.unit || '').trim().slice(0, 20) || null) : prev.unit ?? null,
    kind: KINDS.includes(b.kind) ? b.kind : prev.kind || 'inventory',
    sale_price: b.sale_price !== undefined ? Math.max(0, Math.round(+b.sale_price || 0)) : prev.sale_price ?? 0,
    purchase_price: b.purchase_price !== undefined ? Math.max(0, Math.round(+b.purchase_price || 0)) : prev.purchase_price ?? 0,
    tax_rate: b.tax_rate !== undefined ? (b.tax_rate === '' || b.tax_rate == null ? null : +b.tax_rate) : prev.tax_rate ?? null,
    income_account_id: b.income_account_id !== undefined ? (+b.income_account_id || null) : prev.income_account_id ?? null,
    expense_account_id: b.expense_account_id !== undefined ? (+b.expense_account_id || null) : prev.expense_account_id ?? null,
    reorder_level: b.reorder_level !== undefined ? Math.max(0, +b.reorder_level || 0) : prev.reorder_level ?? 0,
    active: b.active !== undefined ? (b.active ? 1 : 0) : prev.active ?? 1,
  };
  if (!v.name) throw bad('Product name is required');
  if (prev.id && prev.kind === 'inventory' && v.kind !== 'inventory' && (prev.qty || get('SELECT 1 FROM stock_moves WHERE product_id = ? LIMIT 1', prev.id)))
    throw bad('This product has stock history and must stay a stock item');
  return v;
}

const lowStock = (p) => p.kind === 'inventory' && p.reorder_level > 0 && p.qty <= p.reorder_level;

function list(orgId) {
  return all('SELECT * FROM products WHERE org_id = ? ORDER BY active DESC, name', orgId)
    .map((p) => ({ ...p, avg_cost: p.qty > 0 ? Math.round(p.value / p.qty) : p.purchase_price, low: lowStock(p) }));
}

function detail(orgId, id) {
  const p = loadProduct(orgId, id);
  const moves = all(`SELECT m.*, d.number doc_number, d.kind doc_kind FROM stock_moves m
    LEFT JOIN documents d ON d.id = m.ref_id AND m.ref_type IN ('invoice','bill','invoice_reversal','bill_reversal')
    WHERE m.product_id = ? ORDER BY m.date DESC, m.id DESC LIMIT 500`, p.id);
  return { ...p, avg_cost: p.qty > 0 ? Math.round(p.value / p.qty) : p.purchase_price, low: lowStock(p), moves };
}

module.exports = { KINDS, loadProduct, avgCost, issue, receive, reverseMoves, adjust, productValues, list, detail };
