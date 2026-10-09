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

// Default chart of accounts for every new organisation.
// system_key lets the ledger find the accounts it posts to automatically.
const DEFAULT_ACCOUNTS = [
  ['1000', 'Cash on Hand', 'asset', 'current', 1, 'cash'],
  ['1010', 'Business Checking', 'asset', 'current', 1, 'bank'],
  ['1020', 'Savings Account', 'asset', 'current', 1, null],
  ['1100', 'Accounts Receivable', 'asset', 'current', 0, 'ar'],
  ['1200', 'Tax Recoverable', 'asset', 'current', 0, 'tax_in'],
  ['1300', 'Inventory', 'asset', 'current', 0, null],
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
  ['5000', 'Cost of Goods Sold', 'expense', 'cogs', 0, null],
  ['6000', 'Salaries & Wages', 'expense', null, 0, 'wages'],
  ['6010', 'Employer Payroll Taxes', 'expense', null, 0, 'payroll_tax'],
  ['6100', 'Rent', 'expense', null, 0, null],
  ['6200', 'Utilities', 'expense', null, 0, null],
  ['6300', 'Office Supplies', 'expense', null, 0, null],
  ['6400', 'Software & Subscriptions', 'expense', null, 0, null],
  ['6500', 'Marketing & Advertising', 'expense', null, 0, null],
  ['6600', 'Travel & Meals', 'expense', null, 0, null],
  ['6700', 'Bank Fees', 'expense', null, 0, null],
  ['6800', 'Professional Fees', 'expense', null, 0, null],
  ['6850', 'Insurance', 'expense', null, 0, null],
  ['6900', 'Depreciation', 'expense', null, 0, null],
  ['6990', 'Other Expenses', 'expense', null, 0, 'other_exp'],
];

function seedAccounts(orgId) {
  const ins = db.prepare('INSERT INTO accounts (org_id, code, name, type, subtype, is_bank, system_key) VALUES (?,?,?,?,?,?,?)');
  for (const a of DEFAULT_ACCOUNTS) ins.run(orgId, ...a);
}

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

module.exports = { db, DB_PATH, DATA_DIR, tx, all, get, run, seedAccounts };
