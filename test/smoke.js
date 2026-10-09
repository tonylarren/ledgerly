// End-to-end smoke test against a throwaway database.
const os = require('node:os'), path = require('node:path'), fs = require('node:fs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-test-'));
const http = require('node:http');
const { handle } = require('../src/server');
const assert = require('node:assert');

const srv = http.createServer(handle).listen(0, async () => {
  const base = `http://127.0.0.1:${srv.address().port}`;
  let cookie = '';
  const api = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ledgerly', cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const j = await r.json();
    if (!r.ok) throw new Error(`${method} ${url} -> ${r.status} ${j.error}`);
    return j;
  };
  try {
    assert.equal((await api('GET', '/api/setup')).needsSetup, true);
    await api('POST', '/api/auth/register', { name: 'Admin', email: 'a@x.io', password: 'password123' });
    const { id: org } = await api('POST', '/api/orgs', { name: 'Acme', currency: 'EUR' });
    const o = `/api/orgs/${org}`;
    const accts = await api('GET', `${o}/accounts`);
    const byKey = (k) => accts.find((a) => a.system_key === k).id;
    // Capital injection
    await api('POST', `${o}/bank/transactions`, { account_id: byKey('bank'), category_id: byKey('capital'), direction: 'in', amount: 1000000, date: '2026-01-02', description: 'Seed capital' });
    const { id: cust } = await api('POST', `${o}/contacts`, { name: 'Globex', kind: 'customer' });
    const { id: inv } = await api('POST', `${o}/invoices`, { contact_id: cust, issue_date: '2026-09-01', items: [{ description: 'Consulting', quantity: 10, unit_price: 15000, tax_rate: 20 }], finalize: true });
    let d = await api('GET', `${o}/invoices/${inv}`);
    assert.equal(d.total, 180000); assert.equal(d.status, 'sent');
    await api('POST', `${o}/invoices/${inv}/payments`, { amount: 80000, account_id: byKey('bank'), date: '2026-09-10' });
    d = await api('GET', `${o}/invoices/${inv}`); assert.equal(d.status, 'partial');
    const { id: ven } = await api('POST', `${o}/contacts`, { name: 'Landlord', kind: 'vendor' });
    const rent = accts.find((a) => a.code === '6100').id;
    const { id: bill } = await api('POST', `${o}/bills`, { contact_id: ven, issue_date: '2026-09-01', items: [{ description: 'Rent', quantity: 1, unit_price: 200000, account_id: rent }], finalize: true });
    await api('POST', `${o}/bills/${bill}/payments`, { amount: 200000, account_id: byKey('bank'), date: '2026-09-05' });
    await api('POST', `${o}/employees`, { name: 'Jane', pay_type: 'salary', pay_rate: 400000, income_tax_rate: 10, social_rate: 5, employer_rate: 12 });
    const { id: run } = await api('POST', `${o}/payroll`, { period_start: '2026-09-01', period_end: '2026-09-30', pay_date: '2026-09-30' });
    await api('POST', `${o}/payroll/${run}/post`);
    const pnl = await api('GET', `${o}/reports/pnl?from=2026-01-01&to=2026-12-31`);
    // income 150000; expenses rent 200000 + wages 400000 + employer 48000
    assert.equal(pnl.totalIncome, 150000); assert.equal(pnl.netIncome, 150000 - 648000);
    const bs = await api('GET', `${o}/reports/balance-sheet?asOf=2026-12-31`);
    assert.ok(bs.balanced, 'balance sheet must balance: ' + JSON.stringify([bs.totalAssets, bs.totalLiabilities, bs.totalEquity]));
    const tb = await api('GET', `${o}/reports/trial-balance?asOf=2026-12-31`);
    assert.equal(tb.totalDebit, tb.totalCredit);
    // bank: 1,000,000 + 80,000 - 200,000 - net pay (400000-40000-20000=340000) = 540,000
    const bank = (await api('GET', `${o}/accounts`)).find((a) => a.system_key === 'bank');
    assert.equal(bank.balance, 540000);
    // void payroll and check reversal
    await api('POST', `${o}/payroll/${run}/void`);
    assert.equal((await api('GET', `${o}/reports/pnl?from=2026-01-01&to=2026-12-31`)).netIncome, 150000 - 200000);
    // viewer cannot write
    await api('POST', `${o}/members`, { email: 'v@x.io', name: 'Viewer', password: 'password123', role: 'viewer' });
    await api('POST', '/api/auth/logout');
    await api('POST', '/api/auth/login', { email: 'v@x.io', password: 'password123' });
    await api('GET', `${o}/dashboard`);
    await assert.rejects(api('POST', `${o}/contacts`, { name: 'x' }), /403/);
    await api('GET', '/api/portfolio');
    console.log('ALL SMOKE TESTS PASSED');
  } catch (e) { console.error('FAIL', e); process.exitCode = 1; }
  srv.close(); setTimeout(() => process.exit(), 50);
});
