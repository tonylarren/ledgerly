# Ledgerly — self-hosted finance suite

Accounting, invoicing, bills, banking, payroll, budgets and reports for **multiple organisations** in one self-hosted app.
It has **zero npm dependencies**: just Node.js (≥ 22.13) and a single SQLite file.

## Features

| Area | What you get |
|---|---|
| **Multi-organisation** | Any number of companies, households or projects per user. The "All organisations" page shows cash, receivables, payables, YTD net income and a trend line for each one. |
| **Roles** | Per organisation: **Owner** (everything, incl. members and settings), **Accountant** (record and edit), **Viewer** (read-only, to "just have a look"). Instance **admins** manage users and backups. |
| **Double-entry ledger** | Every action posts balanced journal entries. Default chart of accounts, custom accounts, archiving, manual journal entries, and reversals instead of deletes, so you keep a full audit trail. |
| **Invoices** | Draft → sent → partial → paid / void. Line items with per-line tax and revenue account, auto-numbering, payments, overdue tracking, print / save as PDF. |
| **Bills & expenses** | Same workflow for vendor bills (draft → approved → paid), with expense categorisation. |
| **Banking** | Multiple bank / cash / card accounts, account registers with running balances, money in / out, transfers, and **CSV statement import** (handles `,`/`;` delimiters, EU and US number formats, debit/credit columns). |
| **Payroll** | Employees (salaried or hourly), income tax, employee social contributions, employer contributions and fixed deductions as configurable % rates, so it works for any country. Pay runs with editable hours, bonuses and deductions, posted to the ledger. Printable payslips. |
| **Reports** | Profit & loss, balance sheet, trial balance, general ledger, receivables / payables aging, income vs expenses by month, sales-tax summary. Each has CSV export and print. |
| **Budgets** | Annual budget per income / expense account, with live budget vs actual, variance and % used. |
| **Audit log** | Who did what, and when, per organisation. |
| **Admin** | User management, password resets, and one-click consistent database backup. |
| **UI** | Responsive (desktop and phone), light / dark / system theme. |

## Quick start

### Docker (recommended)
```bash
docker compose up -d
```
Open http://localhost:8080. **The first account you create becomes the administrator.** Data lives in `./data/ledgerly.db`.

### Plain Node.js
```bash
npm start
```
No `npm install` step is needed.

### Try it with demo data
```bash
DATA_DIR=./demo-data npm run demo
DATA_DIR=./demo-data PORT=8787 npm start
```
This seeds two organisations (USD design studio and EUR café) with 12 months of invoices, bills, payroll and budgets.
Sign in as `demo@ledgerly.local` / `demo12345`.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `DATA_DIR` | `./data` | Where `ledgerly.db` is stored |
| `ALLOW_SIGNUP` | `false` | Let anyone register. When off, admins create users (Administration) and owners add members (Settings → Members). |
| `SECURE_COOKIES` | `false` | Set to `true` when serving over HTTPS |

## Running in production

- Put it behind a reverse proxy with HTTPS (Caddy is easiest: `ledger.example.com { reverse_proxy localhost:8080 }`), then set `SECURE_COOKIES=true`.
- **Backups:** Administration → *Download backup* gives a consistent snapshot. To automate, copy `data/ledgerly.db` while stopped, or run `sqlite3 data/ledgerly.db ".backup backup.db"` on a cron.
- **Restore:** stop the app, replace `data/ledgerly.db`, then start it again.

## How the accounting works

| Event | Debit | Credit |
|---|---|---|
| Invoice sent | Accounts Receivable | Revenue (per line) + Sales Tax Payable |
| Payment received | Bank | Accounts Receivable |
| Bill approved | Expense (per line) + Tax Recoverable | Accounts Payable |
| Bill paid | Accounts Payable | Bank |
| Payroll posted | Salaries & Wages (gross) + Employer Payroll Taxes | Payroll Liabilities (withholdings + employer contrib.) + Bank (net pay) |
| Money in / out | Bank / category | category / Bank |

Finalised documents are locked. Voiding posts a reversing entry, so history is never rewritten.
All amounts are stored as integer cents.

## Project layout
```
src/db.js        schema, default chart of accounts, transaction helper
src/ledger.js    posting engine, document & payroll math, reports
src/server.js    HTTP server, auth, roles, REST API (~70 endpoints)
public/          single-page frontend (vanilla JS, no build step)
scripts/         demo data seeder
test/smoke.js    end-to-end test: npm test
```

## Security notes
Passwords are hashed with scrypt. Sessions use HttpOnly SameSite cookies. Every state-changing request needs a custom header (CSRF protection). Login attempts are rate-limited. A strict Content-Security-Policy is applied (no inline scripts). Every API call checks roles server-side.

## Not included (yet)
Multi-currency within one organisation, recurring invoices, emailing invoices directly, bank feeds (Plaid / GoCardless), inventory tracking, and country-specific payroll tax tables.
