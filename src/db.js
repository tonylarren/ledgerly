'use strict';
// Database layer: schema, migrations and small helpers on top of node:sqlite.
// All money is stored as INTEGER cents to avoid floating point errors.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'ledgerly.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
  password_hash TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS orgs (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, legal_name TEXT, currency TEXT NOT NULL DEFAULT 'USD',
  address TEXT, tax_id TEXT, email TEXT, phone TEXT,
  default_tax_rate REAL NOT NULL DEFAULT 0, payment_terms INTEGER NOT NULL DEFAULT 30,
  invoice_prefix TEXT NOT NULL DEFAULT 'INV-', next_invoice_no INTEGER NOT NULL DEFAULT 1,
  bill_prefix TEXT NOT NULL DEFAULT 'BILL-', next_bill_no INTEGER NOT NULL DEFAULT 1,
  invoice_footer TEXT, fiscal_year_start INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS memberships (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','accountant','viewer')),
  PRIMARY KEY (user_id, org_id)
);
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  code TEXT NOT NULL, name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('asset','liability','equity','income','expense')),
  subtype TEXT, is_bank INTEGER NOT NULL DEFAULT 0, system_key TEXT,
  archived INTEGER NOT NULL DEFAULT 0, description TEXT,
  UNIQUE (org_id, code)
);
CREATE TABLE IF NOT EXISTS journal_entries (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  date TEXT NOT NULL, memo TEXT, ref_type TEXT NOT NULL DEFAULT 'manual', ref_id INTEGER,
  reversed_by INTEGER, created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_je_org_date ON journal_entries(org_id, date);
CREATE INDEX IF NOT EXISTS ix_je_ref ON journal_entries(org_id, ref_type, ref_id);
CREATE TABLE IF NOT EXISTS journal_lines (
  id INTEGER PRIMARY KEY, entry_id INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  debit INTEGER NOT NULL DEFAULT 0, credit INTEGER NOT NULL DEFAULT 0, description TEXT,
  contact_id INTEGER
);
CREATE INDEX IF NOT EXISTS ix_jl_entry ON journal_lines(entry_id);
CREATE INDEX IF NOT EXISTS ix_jl_account ON journal_lines(account_id);
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('customer','vendor','both')), name TEXT NOT NULL,
  email TEXT, phone TEXT, address TEXT, tax_id TEXT, notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('invoice','bill')), number TEXT NOT NULL,
  contact_id INTEGER REFERENCES contacts(id), issue_date TEXT NOT NULL, due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft', reference TEXT, notes TEXT,
  subtotal INTEGER NOT NULL DEFAULT 0, tax INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0,
  amount_paid INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_doc_org ON documents(org_id, kind, status);
CREATE TABLE IF NOT EXISTS document_items (
  id INTEGER PRIMARY KEY, document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  description TEXT NOT NULL, quantity REAL NOT NULL DEFAULT 1, unit_price INTEGER NOT NULL DEFAULT 0,
  tax_rate REAL NOT NULL DEFAULT 0, account_id INTEGER REFERENCES accounts(id), position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  date TEXT NOT NULL, amount INTEGER NOT NULL, account_id INTEGER NOT NULL REFERENCES accounts(id),
  method TEXT, reference TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL, email TEXT, position TEXT, department TEXT, start_date TEXT,
  pay_type TEXT NOT NULL DEFAULT 'salary' CHECK (pay_type IN ('salary','hourly')),
  pay_rate INTEGER NOT NULL DEFAULT 0,
  income_tax_rate REAL NOT NULL DEFAULT 0, social_rate REAL NOT NULL DEFAULT 0,
  employer_rate REAL NOT NULL DEFAULT 0, fixed_deduction INTEGER NOT NULL DEFAULT 0,
  bank_details TEXT, active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS payroll_runs (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  period_start TEXT NOT NULL, period_end TEXT NOT NULL, pay_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft', bank_account_id INTEGER REFERENCES accounts(id), notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS payslips (
  id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  hours REAL NOT NULL DEFAULT 0, base INTEGER NOT NULL DEFAULT 0, bonus INTEGER NOT NULL DEFAULT 0,
  gross INTEGER NOT NULL DEFAULT 0, income_tax INTEGER NOT NULL DEFAULT 0, social INTEGER NOT NULL DEFAULT 0,
  other_deductions INTEGER NOT NULL DEFAULT 0, net INTEGER NOT NULL DEFAULT 0, employer_cost INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS budgets (
  org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  year INTEGER NOT NULL, amount INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, account_id, year)
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY, org_id INTEGER, user_id INTEGER, action TEXT NOT NULL,
  entity TEXT, entity_id INTEGER, details TEXT, at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_audit_org ON audit_log(org_id, id);
`;
db.exec(SCHEMA);

// ---------- migrations (additive, safe to run on every start) ----------
function addColumns(table, defs) {
  const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  for (const [name, def] of Object.entries(defs)) if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
}
addColumns('orgs', {
  currencies: "TEXT NOT NULL DEFAULT 'USD,EUR,MGA'", locale: "TEXT NOT NULL DEFAULT 'en-US'",
  smtp_host: 'TEXT', smtp_port: 'INTEGER', smtp_secure: "TEXT NOT NULL DEFAULT 'starttls'", smtp_user: 'TEXT', smtp_pass: 'TEXT', smtp_from: 'TEXT',
  email_subject: 'TEXT', email_body: 'TEXT',
  payroll_scheme: "TEXT NOT NULL DEFAULT 'flat'", payroll_config: 'TEXT',
});
addColumns('accounts', {
  currency: 'TEXT', fee_fixed: 'INTEGER NOT NULL DEFAULT 0', fee_percent: 'REAL NOT NULL DEFAULT 0',
  monthly_fee: 'INTEGER NOT NULL DEFAULT 0', monthly_fee_day: 'INTEGER NOT NULL DEFAULT 1', last_monthly_fee: 'TEXT',
});
addColumns('journal_lines', { fx_currency: 'TEXT', fx_amount: 'INTEGER' });
addColumns('documents', {
  currency: 'TEXT', exchange_rate: 'REAL NOT NULL DEFAULT 1', total_base: 'INTEGER', paid_base: 'INTEGER NOT NULL DEFAULT 0',
  recurring_id: 'INTEGER', last_emailed_at: 'TEXT',
});
addColumns('document_items', { product_id: 'INTEGER' });
addColumns('payments', { currency: 'TEXT', exchange_rate: 'REAL NOT NULL DEFAULT 1', fee: 'INTEGER NOT NULL DEFAULT 0', ar_base: 'INTEGER' });
addColumns('employees', { dependents: 'INTEGER NOT NULL DEFAULT 0', cnaps_number: 'TEXT', tax_number: 'TEXT' });
addColumns('payslips', { details: 'TEXT' });
db.exec(`
CREATE TABLE IF NOT EXISTS exchange_rates (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  currency TEXT NOT NULL, date TEXT NOT NULL, rate REAL NOT NULL, source TEXT,
  UNIQUE (org_id, currency, date)
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  sku TEXT, name TEXT NOT NULL, description TEXT,
  kind TEXT NOT NULL DEFAULT 'inventory' CHECK (kind IN ('inventory','service','non_inventory')),
  unit TEXT, sale_price INTEGER NOT NULL DEFAULT 0, purchase_price INTEGER NOT NULL DEFAULT 0, tax_rate REAL,
  income_account_id INTEGER REFERENCES accounts(id), expense_account_id INTEGER REFERENCES accounts(id),
  qty REAL NOT NULL DEFAULT 0, value INTEGER NOT NULL DEFAULT 0, reorder_level REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS stock_moves (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE, date TEXT NOT NULL,
  qty REAL NOT NULL, value INTEGER NOT NULL, ref_type TEXT NOT NULL, ref_id INTEGER, note TEXT,
  reversed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_moves_product ON stock_moves(product_id, date);
CREATE INDEX IF NOT EXISTS ix_moves_ref ON stock_moves(org_id, ref_type, ref_id);
CREATE TABLE IF NOT EXISTS recurring_invoices (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT, contact_id INTEGER NOT NULL REFERENCES contacts(id), currency TEXT, items TEXT NOT NULL,
  frequency TEXT NOT NULL DEFAULT 'monthly' CHECK (frequency IN ('weekly','monthly','quarterly','yearly')),
  interval_count INTEGER NOT NULL DEFAULT 1, start_date TEXT NOT NULL, next_date TEXT NOT NULL, end_date TEXT,
  due_days INTEGER, reference TEXT, notes TEXT, auto_finalize INTEGER NOT NULL DEFAULT 1, auto_email INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1, generated INTEGER NOT NULL DEFAULT 0, last_run_at TEXT, last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS email_log (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE, user_id INTEGER,
  to_addr TEXT NOT NULL, cc TEXT, subject TEXT, status TEXT NOT NULL, error TEXT,
  sent_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
// Backfill base-currency figures for documents/payments created before multi-currency existed.
db.exec(`UPDATE documents SET total_base = total WHERE total_base IS NULL;
  UPDATE payments SET ar_base = amount WHERE ar_base IS NULL;
  UPDATE documents SET paid_base = amount_paid WHERE paid_base = 0 AND amount_paid > 0 AND (currency IS NULL);`);

// Default chart of accounts for every new organisation.
// system_key lets the ledger find the accounts it posts to automatically.
const DEFAULT_ACCOUNTS = [
  ['1000', 'Cash on Hand', 'asset', 'current', 1, 'cash'],
  ['1010', 'Business Checking', 'asset', 'current', 1, 'bank'],
  ['1020', 'Savings Account', 'asset', 'current', 1, null],
  ['1100', 'Accounts Receivable', 'asset', 'current', 0, 'ar'],
  ['1200', 'Tax Recoverable', 'asset', 'current', 0, 'tax_in'],
  ['1300', 'Inventory', 'asset', 'current', 0, 'inventory'],
  ['1500', 'Equipment', 'asset', 'fixed', 0, null],
  ['1590', 'Accumulated Depreciation', 'asset', 'fixed', 0, null],
  ['2000', 'Accounts Payable', 'liability', 'current', 0, 'ap'],
  ['2100', 'Sales Tax Payable', 'liability', 'current', 0, 'tax_out'],
  ['2200', 'Payroll Liabilities', 'liability', 'current', 0, 'payroll_liab'],
  ['2300', 'Credit Card', 'liability', 'current', 1, null],
  ['2500', 'Loans Payable', 'liability', 'long_term', 0, null],
  ['3000', "Owner's Capital", 'equity', null, 0, 'capital'],
  ['3100', "Owner's Drawings", 'equity', null, 0, null],
  ['3200', 'Retained Earnings', 'equity', null, 0, 'retained'],
  ['4000', 'Sales Revenue', 'income', null, 0, 'sales'],
  ['4100', 'Service Revenue', 'income', null, 0, null],
  ['4900', 'Other Income', 'income', null, 0, null],
  ['4950', 'Foreign Exchange Gains/Losses', 'income', null, 0, 'fx'],
  ['5000', 'Cost of Goods Sold', 'expense', 'cogs', 0, 'cogs'],
  ['5100', 'Inventory Adjustments', 'expense', 'cogs', 0, 'inv_adjust'],
  ['6000', 'Salaries & Wages', 'expense', null, 0, 'wages'],
  ['6010', 'Employer Payroll Taxes', 'expense', null, 0, 'payroll_tax'],
  ['6100', 'Rent', 'expense', null, 0, null],
  ['6200', 'Utilities', 'expense', null, 0, null],
  ['6300', 'Office Supplies', 'expense', null, 0, null],
  ['6400', 'Software & Subscriptions', 'expense', null, 0, null],
  ['6500', 'Marketing & Advertising', 'expense', null, 0, null],
  ['6600', 'Travel & Meals', 'expense', null, 0, null],
  ['6700', 'Bank Fees', 'expense', null, 0, 'bank_fees'],
  ['6800', 'Professional Fees', 'expense', null, 0, null],
  ['6850', 'Insurance', 'expense', null, 0, null],
  ['6900', 'Depreciation', 'expense', null, 0, null],
  ['6990', 'Other Expenses', 'expense', null, 0, 'other_exp'],
];

function seedAccounts(orgId) {
  const ins = db.prepare('INSERT INTO accounts (org_id, code, name, type, subtype, is_bank, system_key) VALUES (?,?,?,?,?,?,?)');
  for (const a of DEFAULT_ACCOUNTS) ins.run(orgId, ...a);
}

// Find (or create) the account behind a system key. Existing orgs get new system accounts this way:
// an unkeyed account with the preferred code is adopted, otherwise a new one is added.
function ensureAccount(orgId, key, code, name, type, subtype = null) {
  const found = db.prepare('SELECT * FROM accounts WHERE org_id = ? AND system_key = ?').get(orgId, key);
  if (found) return found;
  const byCode = db.prepare('SELECT * FROM accounts WHERE org_id = ? AND code = ?').get(orgId, code);
  if (byCode && !byCode.system_key && byCode.type === type) {
    db.prepare('UPDATE accounts SET system_key = ? WHERE id = ?').run(key, byCode.id);
    return { ...byCode, system_key: key };
  }
  let c = code;
  while (db.prepare('SELECT 1 FROM accounts WHERE org_id = ? AND code = ?').get(orgId, c)) c = String(+c + 1);
  const { lastInsertRowid } = db.prepare('INSERT INTO accounts (org_id, code, name, type, subtype, system_key) VALUES (?,?,?,?,?,?)').run(orgId, c, name, type, subtype, key);
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(lastInsertRowid);
}
function ensureSystemAccounts(orgId) {
  for (const [code, name, type, subtype, , key] of DEFAULT_ACCOUNTS) if (key) ensureAccount(orgId, key, code, name, type, subtype);
}
for (const o of db.prepare('SELECT id FROM orgs').all()) ensureSystemAccounts(o.id);

// Run fn inside a transaction; nested calls join the outer one.
let txDepth = 0;
function tx(fn) {
  if (txDepth > 0) return fn();
  txDepth++;
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    txDepth--;
  }
}

const all = (sql, ...p) => db.prepare(sql).all(...p);
const get = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);

module.exports = { db, DB_PATH, DATA_DIR, tx, all, get, run, seedAccounts, ensureAccount };
