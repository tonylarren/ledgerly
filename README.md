# Ledgerly — self-hosted finance suite

Accounting, invoicing, recurring billing, bills, banking, inventory, payroll, budgets and reports for **multiple organisations** in one self-hosted app.
It has **zero npm dependencies**: just Node.js (≥ 22.13) and a single SQLite file. It even includes its own SMTP client and PDF generator.

## Features

| Area | What you get |
|---|---|
| **Multi-organisation** | Any number of companies, households or projects per user. The "All organisations" page shows cash, receivables, payables, YTD net income and a trend line for each one. |
| **Roles** | Per organisation: **Owner** (everything, incl. members and settings), **Accountant** (record and edit), **Viewer** (read-only, to "just have a look"). Instance **admins** manage users and backups. |
| **Multi-currency** | Books are kept in a base currency (USD, EUR, MGA or any ISO code). Invoices, bills and bank accounts can be in **USD, EUR or MGA**. Dated exchange rates are entered manually, or fetched with one click. Realised exchange gains/losses are posted automatically when foreign documents are paid. Foreign-currency bank accounts keep both their own balance and their book value, and can be revalued. |
| **Double-entry ledger** | Every action posts balanced journal entries. Default chart of accounts, custom accounts, archiving, manual journal entries, and reversals instead of deletes, so you keep a full audit trail. |
| **Invoices** | Draft → sent → partial → paid / void. Products or free-text lines, per-line tax and revenue account, auto-numbering, overdue tracking. **PDF download**, print view, and **email with the PDF attached**. Every send is logged. |
| **Recurring invoices** | Weekly / monthly / quarterly / yearly (every N periods), optional end date. Each invoice can be posted and **emailed automatically**. Missed periods are caught up after downtime. |
| **Bills & expenses** | Same workflow for vendor bills (draft → approved → paid), with expense categorisation and stock purchases. |
| **Inventory** | Products (stock items, services, non-stock items), SKUs, units and reorder levels. Bills add stock; invoices remove it at **weighted-average cost** and post cost of goods sold. Manual adjustments, opening stock, movement history, low-stock alerts and an inventory valuation report checked against the ledger. |
| **Banking** | Bank, cash, card and mobile-money accounts in any enabled currency. Registers with running balances, money in / out, cross-currency transfers, and CSV statement import. |
| **Bank fees** | A fixed and/or % fee per account (e.g. 1% for MVola), suggested automatically on payments and transfers. Monthly account fees are posted automatically. Fees are tracked year-to-date. |
| **Payroll** | Two schemes per organisation: **flat rates** (any country) or **Madagascar** — CNaPS, health organisation (OSTIE/SMIE), FMFP and progressive **IRSA** with the ceiling, dependant reductions and minimum tax. Each contribution is posted to its own payable account. Printable payslips show the breakdown. |
| **Reports** | Profit & loss, balance sheet, trial balance, general ledger (incl. foreign balances), receivables / payables aging, income vs expenses, sales tax (TVA), **inventory valuation**, and **payroll taxes** (totals plus per-employee figures for CNaPS DNS / IRSA statements). Each has CSV export and print. |
| **Budgets** | Annual budget per income / expense account, with live budget vs actual, variance and % used. |
| **Audit log** | Who did what, and when, per organisation (including scheduler actions). |
| **Admin** | User management, password resets, and one-click consistent database backup. |
| **UI** | Responsive (desktop and phone), light / dark / system theme, number format per organisation (e.g. `fr-MG`). |

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
This seeds three organisations with 12 months of history:
- **Northwind Studio** (USD) and **Bluefin Café** (EUR)
- **Tsara Vanille SARL** (MGA), a vanilla exporter with EUR/USD sales, an EUR bank account, MVola, stock, Madagascar payroll and recurring invoices

Sign in as `demo@ledgerly.local` / `demo12345`.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `DATA_DIR` | `./data` | Where `ledgerly.db` is stored |
| `ALLOW_SIGNUP` | `false` | Let anyone register. When off, admins create users (Administration) and owners add members (Settings → Members). |
| `SECURE_COOKIES` | `false` | Set to `true` when serving over HTTPS |
| `TRUST_PROXY` | `false` | Set to `true` behind a reverse proxy, so the login throttle uses the client IP from `X-Forwarded-For`. Leave it off when Ledgerly is exposed directly; otherwise clients could spoof that header. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | — | Optional instance-wide email. `SMTP_SECURE` is `starttls` (default), `tls` or `none`. Each organisation can override this in Settings → Email. |
| `SMTP_ALLOW_SELF_SIGNED` | `false` | Accept self-signed certificates on an internal mail relay |
| `DISABLE_SCHEDULER` | `false` | Turn off the hourly job that generates recurring invoices and monthly bank fees |

## Email

Configure SMTP per organisation in **Settings → Email** (Gmail, Microsoft 365, Brevo or your own server), or instance-wide with the `SMTP_*` variables.
Invoices go out as a formatted HTML email with the PDF attached. The subject and message templates support `{number} {customer} {company} {total} {due} {due_date} {issue_date} {reference}`.
SMTP passwords are stored in the database and never sent back to the browser. Protect the server and its backups accordingly.

## Madagascar payroll

Defaults were verified in October 2026 and are editable in **Settings → Payroll**, because they change by decree and finance law:

| Item | Employee | Employer | Base |
|---|---|---|---|
| CNaPS | 1% | 13% | gross, capped at 8 × SME |
| OSTIE (or AMIT, ESIA, FUNHECE, SMIE…) | 1% | 5% | gross, capped at 8 × SME |
| FMFP | — | 1% | gross, uncapped |
| IRSA | progressive | — | gross − employee CNaPS & health, rounded down to 100 Ar |

- **IRSA 2026 bands:** 0% to 350,000 Ar · 5% to 400,000 · 10% to 500,000 · 15% to 600,000 · 20% to 4,000,000 · 25% above. Minimum 3,000 Ar; 2,000 Ar reduction per dependant.
- **SME history:** 262,680 Ar (03/2024), 300,000 Ar (03/2026), 315,000 Ar (10/2026). The SME in force at the end of each pay period is used, so the ceiling is 2,520,000 Ar from October 2026.

Always confirm figures with your accountant, CNaPS or the DGI before filing.

## Running in production

**Step-by-step guide for an Ubuntu server (Contabo, Hetzner, …): [DEPLOY.md](DEPLOY.md).** It covers Caddy with automatic HTTPS, nightly backups and restores.


- Put it behind a reverse proxy with HTTPS (Caddy is easiest: `ledger.example.com { reverse_proxy localhost:8080 }`), then set `SECURE_COOKIES=true` and `TRUST_PROXY=true`.
- **Backups:** Administration → *Download backup* gives a consistent snapshot. To automate, copy `data/ledgerly.db` while stopped, or run `sqlite3 data/ledgerly.db ".backup backup.db"` on a cron.
- **Restore:** stop the app, replace `data/ledgerly.db`, then start it again.
- **Upgrades:** the database schema migrates automatically on start-up. Existing data is kept, and new system accounts are added to existing organisations.

## How the accounting works

| Event | Debit | Credit |
|---|---|---|
| Invoice sent | Accounts Receivable | Revenue (per line) + Sales Tax Payable; and for stock items, Inventory (with a matching debit to COGS) |
| Payment received | Bank (net of fee) + Bank Fees | Accounts Receivable; FX gain/loss for any difference |
| Bill approved | Expense or Inventory (per line) + Tax Recoverable | Accounts Payable |
| Bill paid | Accounts Payable + Bank Fees | Bank; FX gain/loss for any difference |
| Payroll posted (flat) | Salaries & Wages + Employer Payroll Taxes | Payroll Liabilities + Bank (net pay) |
| Payroll posted (Madagascar) | Salaries & Wages + Employer Payroll Taxes | CNaPS, health, IRSA and FMFP payables + Bank (net pay) |
| Stock adjustment | Inventory ⇄ Inventory Adjustments (or chosen account) | |
| FX revaluation | Foreign bank account ⇄ Foreign Exchange Gains/Losses | |

The ledger is always in the base currency. Foreign lines also store their original amount.
Finalised documents are locked. Voiding posts a reversing entry and undoes stock movements, so history is never rewritten.
All amounts are stored as integer cents.

## Project layout
```
src/db.js          schema, migrations, default chart of accounts
src/ledger.js      posting engine and financial reports
src/currency.js    enabled currencies, dated exchange rates, optional rate fetch
src/documents.js   invoices & bills, payments (fees, FX), recurring generation
src/inventory.js   products, stock moves, weighted-average cost
src/banking.js     transactions, transfers, revaluation, monthly fees
src/payroll.js     flat and Madagascar payroll schemes, posting, tax report
src/mailer.js      dependency-free SMTP client + MIME builder
src/pdf.js         dependency-free PDF writer + invoice layout
src/email.js       invoice email templates and delivery log
src/scheduler.js   hourly jobs (recurring invoices, monthly bank fees)
src/server.js      HTTP server, auth, roles, REST API
public/js/         single-page frontend modules (vanilla JS, no build step)
scripts/           demo data seeder
test/              end-to-end suites (see Testing)
```

## Testing

```bash
npm test           # everything (~15 s)
npm run test:api   # API suite only
npm run test:ui    # browser suite only
```

Both suites use only Node's built-in test runner and run against a throwaway database. A fake SMTP server captures every email.

- **`test/api.e2e.test.js`** (115 checks) covers:
  - setup and auth, including login throttling
  - admin, organisations, roles and the chart of accounts
  - journal, contacts, invoices and bills
  - banking and fees, multi-currency and FX, inventory
  - email, recurring invoices and the scheduler
  - flat and Madagascar payroll (checked against an independent implementation of the published rules)
  - reports, budgets, and organisation deletion

  After each section it checks that the books balance and that AR, AP and stock match the ledger.
- **`test/ui.e2e.test.js`** (10 scenarios) drives a real headless Chrome/Edge over the DevTools protocol, with no Playwright or Puppeteer. It runs:
  - first-run setup, the document editors, payments with an exchange gain, and emailing
  - recurring invoices, banking and payroll
  - a sweep of every screen, the read-only viewer, and the phone layout

  It fails on any JavaScript error in the page. Set `CHROME_PATH` if your browser isn't found; it is skipped when none is installed.

## Security notes
Passwords are hashed with scrypt. Sessions use HttpOnly SameSite cookies. Every state-changing request needs a custom header (CSRF protection). Login attempts are rate-limited. A strict Content-Security-Policy is applied (no inline scripts). Every API call checks roles server-side.
The only outbound connections are to your SMTP server, and to open.er-api.com when someone presses "Fetch latest rates".

## Not included (yet)
Live bank feeds, emailing payslips, revaluation of open foreign-currency invoices at period end, Madagascar agricultural-regime payroll rates, and VAT return forms.
