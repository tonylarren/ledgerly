'use strict';
// End-to-end API suite: exercises every feature through HTTP against a fresh database,
// asserting accounting invariants (balanced books, AR/AP and stock sub-ledgers) along the way.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startApp, Client, fakeSmtp, parseMail, assertBooks, daysFromToday, iso, Ar } = require('./helpers');

let app, smtp, admin;
const ids = {};
const PW = 'correct-horse-9';

before(async () => {
  smtp = await fakeSmtp();
  app = await startApp();
  admin = new Client(app.base, { ip: '10.0.0.1' });
});
after(async () => { await app.close(); await smtp.close(); });

const A = () => `/api/orgs/${ids.acme}`;
const T = () => `/api/orgs/${ids.tsara}`;
async function accounts(c, o) {
  const list = await c.get(`${o}/accounts`);
  return { list, key: (k) => list.find((a) => a.system_key === k), code: (c2) => list.find((a) => a.code === c2), byId: (id) => list.find((a) => a.id === id) };
}
const rawGet = (path) => new Promise((resolve, reject) => {
  http.get(app.base + path, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers })); }).on('error', reject);
});

// ======================================================================
test('1. platform, static files & request hardening', async (t) => {
  await t.test('serves the SPA with security headers', async () => {
    const r = await rawGet('/');
    assert.equal(r.status, 200);
    assert.match(r.body, /<script src="\/js\/core.js">/);
    assert.match(r.headers['content-security-policy'], /script-src 'self'/);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
  });
  await t.test('serves modules and falls back to index.html for deep links', async () => {
    const js = await rawGet('/js/core.js');
    assert.match(js.headers['content-type'], /javascript/);
    const deep = await rawGet('/some/deep/link');
    assert.match(deep.body, /<div id="app">/);
  });
  await t.test('blocks path traversal', async () => {
    for (const p of ['/..%2Fsrc%2Fserver.js', '/%2e%2e/src/server.js', '/../package.json']) {
      const r = await rawGet(p);
      assert.ok(!r.body.includes("require('node:http')") && !r.body.includes('"engines"'), `leaked file via ${p}`);
    }
  });
  await t.test('malformed URLs return 400 and do not crash the server', async () => {
    const r = await rawGet('/%E0%A4%A');
    assert.equal(r.status, 400);
    assert.equal((await rawGet('/api/setup')).status, 200);
  });
  await t.test('unknown endpoints, CSRF header and body validation', async () => {
    const c = new Client(app.base);
    await c.fails('GET', '/api/nope', undefined, 404);
    const csrf = await c.req('POST', '/api/auth/login', { email: 'x', password: 'y' }, { csrf: false });
    assert.equal(csrf.status, 403);
    await c.fails('POST', '/api/auth/login', '{not json', 400, /Invalid JSON/);
    await c.fails('POST', '/api/auth/login', '[1,2]', 400, /JSON object/);
    await c.fails('POST', '/api/auth/login', 'null', 400, /JSON object/);
    await c.fails('GET', '/api/me', undefined, 401);
  });
});

// ======================================================================
test('2. first-run setup, authentication & profile', async (t) => {
  await t.test('first user becomes administrator', async () => {
    assert.equal((await admin.get('/api/setup')).needsSetup, true);
    await admin.post('/api/auth/register', { name: 'Ada Admin', email: 'ada@ledgerly.test', password: PW });
    const me = await admin.get('/api/me');
    assert.equal(me.user.is_admin, true);
    assert.equal((await admin.get('/api/setup')).needsSetup, false);
  });
  await t.test('public registration is closed afterwards', async () => {
    await new Client(app.base).fails('POST', '/api/auth/register', { name: 'X', email: 'x@x.test', password: PW }, 403, /disabled/);
  });
  await t.test('login, logout and wrong credentials', async () => {
    const c = new Client(app.base, { ip: '10.0.0.2' });
    await c.fails('POST', '/api/auth/login', { email: 'ada@ledgerly.test', password: 'wrong-password' }, 401);
    await c.login('ada@ledgerly.test', PW);
    assert.equal((await c.get('/api/me')).user.email, 'ada@ledgerly.test');
    await c.post('/api/auth/logout');
    await c.fails('GET', '/api/me', undefined, 401);
  });
  await t.test('profile rename and password change', async () => {
    await admin.put('/api/me', { name: 'Ada Lovelace' });
    assert.equal((await admin.get('/api/me')).user.name, 'Ada Lovelace');
    await admin.fails('PUT', '/api/me', { current_password: 'nope', new_password: 'another-pass-1' }, 400, /incorrect/);
    await admin.fails('PUT', '/api/me', { current_password: PW, new_password: 'short' }, 400, /8 characters/);
    await admin.put('/api/me', { current_password: PW, new_password: 'another-pass-1' });
    await new Client(app.base, { ip: '10.0.0.3' }).login('ada@ledgerly.test', 'another-pass-1');
    await admin.put('/api/me', { current_password: 'another-pass-1', new_password: PW });
  });
  await t.test('login throttling per client IP (behind a trusted proxy)', async () => {
    const attacker = new Client(app.base, { ip: '203.0.113.9' });
    for (let i = 0; i < 10; i++) await attacker.fails('POST', '/api/auth/login', { email: 'ada@ledgerly.test', password: 'guess' + i }, 401);
    await attacker.fails('POST', '/api/auth/login', { email: 'ada@ledgerly.test', password: PW }, 429, /Too many/);
    await new Client(app.base, { ip: '203.0.113.10' }).login('ada@ledgerly.test', PW); // other clients unaffected
  });
});

// ======================================================================
test('3. instance administration', async (t) => {
  await t.test('create users and reject duplicates / weak passwords', async () => {
    ids.bob = (await admin.post('/api/admin/users', { name: 'Bob', email: 'bob@ledgerly.test', password: PW })).id;
    ids.dave = (await admin.post('/api/admin/users', { name: 'Dave Viewer', email: 'dave@ledgerly.test', password: PW })).id;
    ids.eve = (await admin.post('/api/admin/users', { name: 'Eve Outsider', email: 'eve@ledgerly.test', password: PW })).id;
    await admin.fails('POST', '/api/admin/users', { name: 'Bob 2', email: 'BOB@ledgerly.test', password: PW }, 400, /already in use/);
    await admin.fails('POST', '/api/admin/users', { name: 'Weak', email: 'weak@ledgerly.test', password: '123' }, 400, /8 characters/);
    assert.equal((await admin.get('/api/admin/users')).length, 4);
  });
  await t.test('non-admins are refused', async () => {
    const bob = await new Client(app.base, { ip: '10.0.1.1' }).login('bob@ledgerly.test', PW);
    await bob.fails('GET', '/api/admin/users', undefined, 403);
    await bob.fails('GET', '/api/admin/backup', undefined, 403);
  });
  await t.test('password reset signs the user out everywhere', async () => {
    const bob = await new Client(app.base, { ip: '10.0.1.2' }).login('bob@ledgerly.test', PW);
    await admin.put(`/api/admin/users/${ids.bob}`, { password: 'reset-pass-77' });
    await bob.fails('GET', '/api/me', undefined, 401);
    await bob.login('bob@ledgerly.test', 'reset-pass-77');
  });
  await t.test('admin flag toggling and self-protection', async () => {
    await admin.put(`/api/admin/users/${ids.bob}`, { is_admin: true });
    assert.equal((await admin.get('/api/admin/users')).find((u) => u.id === ids.bob).is_admin, 1);
    await admin.put(`/api/admin/users/${ids.bob}`, { is_admin: false });
    const me = (await admin.get('/api/me')).user.id;
    await admin.fails('PUT', `/api/admin/users/${me}`, { is_admin: false }, 400, /own admin/);
    await admin.fails('DELETE', `/api/admin/users/${me}`, undefined, 400, /yourself/);
  });
  await t.test('consistent SQLite backup download', async () => {
    const r = await admin.req('GET', '/api/admin/backup');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition'), /ledgerly-.*\.db/);
    assert.equal(r.data.subarray(0, 16).toString('latin1'), 'SQLite format 3\0');
  });
  await t.test('delete a user', async () => {
    await admin.del(`/api/admin/users/${ids.bob}`);
    await new Client(app.base, { ip: '10.0.1.3' }).fails('POST', '/api/auth/login', { email: 'bob@ledgerly.test', password: 'reset-pass-77' }, 401);
  });
});

// ======================================================================
test('4. organisations, settings, members & roles', async (t) => {
  await t.test('create organisations with sensible defaults per currency', async () => {
    ids.acme = (await admin.post('/api/orgs', { name: 'Acme Corp', currency: 'usd', default_tax_rate: 10 })).id;
    ids.tsara = (await admin.post('/api/orgs', { name: 'Tsara Vanille', currency: 'MGA', default_tax_rate: 20 })).id;
    const acme = await admin.get(A()), tsara = await admin.get(T());
    assert.equal(acme.currency, 'USD'); assert.equal(acme.payroll_scheme, 'flat'); assert.equal(acme.locale, 'en-US');
    assert.equal(tsara.payroll_scheme, 'madagascar'); assert.equal(tsara.locale, 'fr-MG');
    assert.deepEqual([...tsara.enabled_currencies].sort(), ['EUR', 'MGA', 'USD']);
    const keys = (await accounts(admin, A())).list.map((a) => a.system_key).filter(Boolean);
    for (const k of ['cash', 'bank', 'ar', 'ap', 'tax_in', 'tax_out', 'payroll_liab', 'capital', 'retained', 'sales', 'wages', 'payroll_tax', 'other_exp', 'inventory', 'cogs', 'inv_adjust', 'fx', 'bank_fees'])
      assert.ok(keys.includes(k), `missing system account ${k}`);
  });
  await t.test('validation of organisation input', async () => {
    await admin.fails('POST', '/api/orgs', { name: '' }, 400, /name is required/);
    await admin.fails('POST', '/api/orgs', { name: 'Bad', currency: 'DOLLARS' }, 400, /3-letter/);
  });
  await t.test('owners update settings', async () => {
    await admin.put(A(), { legal_name: 'Acme Corporation LLC', address: '1 Main St\nSpringfield', tax_id: 'US-123', invoice_prefix: 'AC-', next_invoice_no: 100, payment_terms: 15,
      invoice_footer: 'Thanks!', email: 'billing@acme.test', locale: 'en-GB' });
    const o = await admin.get(A());
    assert.equal(o.legal_name, 'Acme Corporation LLC'); assert.equal(o.payment_terms, 15); assert.equal(o.locale, 'en-GB'); assert.equal(o.next_invoice_no, 100);
    await admin.fails('PUT', A(), { locale: 'not a locale!' }, 400, /locale/);
    await admin.fails('PUT', A(), { name: '' }, 400, /Name is required/);
    await admin.fails('PUT', A(), { smtp_secure: 'ssl3' }, 400, /security mode/);
  });
  await t.test('members: create, invite existing, change roles', async () => {
    await admin.fails('POST', `${A()}/members`, { email: 'carol@ledgerly.test', role: 'accountant' }, 400, /temporary password/);
    await admin.post(`${A()}/members`, { email: 'carol@ledgerly.test', name: 'Carol Accountant', password: PW, role: 'accountant' });
    await admin.post(`${A()}/members`, { email: 'dave@ledgerly.test', role: 'owner' });
    const dave = (await admin.get(`${A()}/members`)).find((m) => m.email === 'dave@ledgerly.test');
    await admin.put(`${A()}/members/${dave.id}`, { role: 'viewer' });
    await admin.fails('PUT', `${A()}/members/${dave.id}`, { role: 'emperor' }, 400, /Invalid role/);
    ids.carol = (await admin.get(`${A()}/members`)).find((m) => m.email === 'carol@ledgerly.test').id;
    assert.equal((await admin.get(`${A()}/members`)).length, 3);
  });
  await t.test('an organisation always keeps an owner', async () => {
    const me = (await admin.get('/api/me')).user.id;
    await admin.fails('PUT', `${A()}/members/${me}`, { role: 'viewer' }, 400, /at least one owner/);
    await admin.fails('DELETE', `${A()}/members/${me}`, undefined, 400, /at least one owner/);
  });
  await t.test('role enforcement: viewer, accountant, outsider', async () => {
    const dave = await new Client(app.base, { ip: '10.0.2.1' }).login('dave@ledgerly.test', PW);
    const carol = await new Client(app.base, { ip: '10.0.2.2' }).login('carol@ledgerly.test', PW);
    const eve = await new Client(app.base, { ip: '10.0.2.3' }).login('eve@ledgerly.test', PW);
    assert.equal((await dave.get(A())).role, 'viewer');
    await dave.get(`${A()}/dashboard`);
    await dave.fails('POST', `${A()}/contacts`, { name: 'Nope' }, 403, /read-only/);
    await dave.fails('POST', `${A()}/invoices`, {}, 403);
    ids.carolContact = (await carol.post(`${A()}/contacts`, { name: 'Carol Made This', kind: 'customer' })).id;
    await carol.fails('PUT', A(), { name: 'Hijack' }, 403, /Only owners/);
    await carol.fails('POST', `${A()}/members`, { email: 'eve@ledgerly.test' }, 403);
    await eve.fails('GET', A(), undefined, 404);
    await eve.fails('GET', `${T()}/invoices`, undefined, 404);
    assert.equal((await eve.get('/api/me')).orgs.length, 0);
    assert.ok(!(await dave.get('/api/portfolio')).some((o) => o.id === ids.tsara));
  });
  await t.test('portfolio and audit trail', async () => {
    const p = await admin.get('/api/portfolio');
    assert.deepEqual(p.map((o) => o.name).sort(), ['Acme Corp', 'Tsara Vanille']);
    assert.ok(p.every((o) => 'cash' in o.summary && o.series.length === 6));
    const log = await admin.get(`${A()}/audit`);
    for (const a of ['org.create', 'org.update', 'member.add', 'member.role', 'contact.create']) assert.ok(log.some((l) => l.action === a), `audit missing ${a}`);
  });
});

// ======================================================================
test('5. chart of accounts & manual journal', async (t) => {
  await t.test('custom accounts: create, validate, update, archive, delete', async () => {
    ids.cowork = (await admin.post(`${A()}/accounts`, { code: '6150', name: 'Coworking', type: 'expense' })).id;
    await admin.fails('POST', `${A()}/accounts`, { code: '6150', name: 'Dup', type: 'expense' }, 400, /already used/);
    await admin.fails('POST', `${A()}/accounts`, { code: '9999', name: 'Bad', type: 'magic' }, 400, /Invalid account type/);
    await admin.put(`${A()}/accounts/${ids.cowork}`, { name: 'Coworking space' });
    const tmp = (await admin.post(`${A()}/accounts`, { code: '6151', name: 'Temp', type: 'expense' })).id;
    await admin.del(`${A()}/accounts/${tmp}`);
    assert.equal((await accounts(admin, A())).byId(ids.cowork).name, 'Coworking space');
  });
  await t.test('system accounts are protected', async () => {
    const ar = (await accounts(admin, A())).key('ar');
    await admin.fails('PUT', `${A()}/accounts/${ar.id}`, { archived: true }, 400, /cannot be archived/);
    await admin.fails('PUT', `${A()}/accounts/${ar.id}`, { type: 'expense' }, 400, /Cannot change the type/);
    await admin.fails('DELETE', `${A()}/accounts/${ar.id}`, undefined, 400, /cannot be deleted/);
  });
  await t.test('manual journal entries must balance', async () => {
    const acc = await accounts(admin, A());
    const bank = acc.key('bank').id, capital = acc.key('capital').id;
    await admin.fails('POST', `${A()}/journal`, { date: '2026-01-02', memo: 'x', lines: [{ account_id: bank, debit: 100 }, { account_id: capital, credit: 90 }] }, 400, /not balanced/);
    await admin.fails('POST', `${A()}/journal`, { date: '2026-01-02', memo: 'x', lines: [{ account_id: bank, debit: 100 }] }, 400, /at least two/);
    await admin.fails('POST', `${A()}/journal`, { date: '02/01/2026', memo: 'x', lines: [{ account_id: bank, debit: 1 }, { account_id: capital, credit: 1 }] }, 400, /valid date/);
    await admin.fails('POST', `${A()}/journal`, { date: '2026-01-02', memo: 'x', lines: [{ account_id: 999999, debit: 1 }, { account_id: capital, credit: 1 }] }, 400, /not found/);
    ids.capitalEntry = (await admin.post(`${A()}/journal`, { date: '2026-01-02', memo: 'Opening capital', lines: [{ account_id: bank, debit: Ar(50000) }, { account_id: capital, credit: Ar(50000) }] })).id;
    const e = (await admin.post(`${A()}/journal`, { date: '2026-01-03', memo: 'Coworking prepaid by owner', lines: [{ account_id: ids.cowork, debit: 25000 }, { account_id: capital, credit: 25000 }] })).id;
    ids.coworkEntry = e;
  });
  await t.test('search, filter and reverse entries', async () => {
    const found = await admin.get(`${A()}/journal?q=Coworking`);
    assert.equal(found.total, 1);
    assert.equal(found.entries[0].lines.length, 2);
    assert.equal((await admin.get(`${A()}/journal?type=manual&from=2026-01-03&to=2026-01-03`)).total, 1);
    await admin.post(`${A()}/journal/${ids.coworkEntry}/reverse`);
    await admin.fails('POST', `${A()}/journal/${ids.coworkEntry}/reverse`, {}, 400, /already reversed/);
    assert.equal((await accounts(admin, A())).byId(ids.cowork).balance, 0);
  });
  await t.test('archived accounts refuse new postings', async () => {
    await admin.put(`${A()}/accounts/${ids.cowork}`, { archived: true });
    const capital = (await accounts(admin, A())).key('capital').id;
    await admin.fails('POST', `${A()}/journal`, { date: '2026-01-04', memo: 'x', lines: [{ account_id: ids.cowork, debit: 1 }, { account_id: capital, credit: 1 }] }, 400, /archived/);
    await admin.fails('DELETE', `${A()}/accounts/${ids.cowork}`, undefined, 400, /archive it instead/);
    await admin.put(`${A()}/accounts/${ids.cowork}`, { archived: false });
  });
  await assertBooks(admin, ids.acme, 'journal');
});

// ======================================================================
test('6. contacts', async (t) => {
  ids.globex = (await admin.post(`${A()}/contacts`, { name: 'Globex', kind: 'customer', email: 'ap@globex.test', address: '42 Elm St', tax_id: 'GB123' })).id;
  ids.initech = (await admin.post(`${A()}/contacts`, { name: 'Initech', kind: 'both', email: 'billing@initech.test' })).id;
  ids.landlord = (await admin.post(`${A()}/contacts`, { name: 'City Properties', kind: 'vendor' })).id;
  await t.test('validation and filters', async () => {
    await admin.fails('POST', `${A()}/contacts`, { name: '  ' }, 400, /Name is required/);
    const customers = await admin.get(`${A()}/contacts?kind=customer`);
    assert.ok(customers.some((c) => c.name === 'Initech'), '"both" contacts appear as customers');
    assert.ok(!customers.some((c) => c.name === 'City Properties'));
    assert.ok((await admin.get(`${A()}/contacts?kind=vendor`)).some((c) => c.name === 'Initech'));
  });
  await t.test('update and delete', async () => {
    await admin.put(`${A()}/contacts/${ids.globex}`, { phone: '+1 555 0100' });
    assert.equal((await admin.get(`${A()}/contacts`)).find((c) => c.id === ids.globex).phone, '+1 555 0100');
    await admin.del(`${A()}/contacts/${ids.carolContact}`);
  });
});

// ======================================================================
test('7. invoices & bills lifecycle', async (t) => {
  const acc = await accounts(admin, A());
  const bank = acc.key('bank').id;
  const svc = acc.code('4100').id;
  await t.test('draft invoice: numbering, terms, tax maths, no ledger impact', async () => {
    const r = await admin.post(`${A()}/invoices`, { contact_id: ids.globex, issue_date: '2026-03-01', items: [
      { description: 'Consulting', quantity: 10, unit_price: 15000, tax_rate: 10, account_id: svc },
      { description: 'Discount', quantity: 1, unit_price: -10000, tax_rate: 10, account_id: svc },
      { description: 'Expenses (no tax)', quantity: 2.5, unit_price: 3333, tax_rate: 0 },
    ] });
    ids.inv1 = r.id;
    const d = await admin.get(`${A()}/invoices/${ids.inv1}`);
    assert.equal(d.number, 'AC-0100');
    assert.equal(d.due_date, '2026-03-16');
    assert.equal(d.subtotal, 150000 - 10000 + 8333);
    assert.equal(d.tax, 15000 - 1000);
    assert.equal(d.total, d.subtotal + d.tax);
    assert.equal(d.status, 'draft');
    assert.equal((await accounts(admin, A())).key('ar').balance, 0);
  });
  await t.test('validation', async () => {
    await admin.fails('POST', `${A()}/invoices`, { issue_date: '2026-03-01', items: [{ description: 'x', quantity: 1, unit_price: 1 }] }, 400, /customer/);
    await admin.fails('POST', `${A()}/invoices`, { contact_id: ids.globex, issue_date: '2026-03-01', items: [] }, 400, /line item/);
    await admin.fails('POST', `${A()}/invoices`, { contact_id: ids.globex, issue_date: '2026-03-01', due_date: '2026-02-01', items: [{ description: 'x', quantity: 1, unit_price: 1 }] }, 400, /before the issue/);
    await admin.fails('POST', `${A()}/invoices`, { contact_id: ids.globex, issue_date: 'yesterday', items: [{ description: 'x', quantity: 1, unit_price: 1 }] }, 400, /Issue date/);
    await admin.fails('POST', `${A()}/invoices`, { contact_id: ids.globex, number: 'AC-0100', issue_date: '2026-03-01', items: [{ description: 'x', quantity: 1, unit_price: 1 }] }, 400, /already used/);
  });
  await t.test('edit and delete drafts', async () => {
    await admin.put(`${A()}/invoices/${ids.inv1}`, { contact_id: ids.globex, issue_date: '2026-03-01', due_date: '2026-03-31', number: 'AC-0100',
      items: [{ description: 'Consulting', quantity: 12, unit_price: 15000, tax_rate: 10, account_id: svc }] });
    const d = await admin.get(`${A()}/invoices/${ids.inv1}`);
    assert.equal(d.total, 198000); assert.equal(d.items.length, 1);
    const tmp = (await admin.post(`${A()}/invoices`, { contact_id: ids.globex, issue_date: '2026-03-02', items: [{ description: 'tmp', quantity: 1, unit_price: 1 }] })).id;
    await admin.del(`${A()}/invoices/${tmp}`);
    await admin.fails('GET', `${A()}/invoices/${tmp}`, undefined, 404);
  });
  await t.test('finalise posts AR, revenue and sales tax; document locks', async () => {
    await admin.post(`${A()}/invoices/${ids.inv1}/finalize`);
    const a = await accounts(admin, A());
    assert.equal(a.key('ar').balance, 198000);
    assert.equal(a.code('4100').balance, 180000);
    assert.equal(a.key('tax_out').balance, 18000);
    await admin.fails('PUT', `${A()}/invoices/${ids.inv1}`, { contact_id: ids.globex, issue_date: '2026-03-01', items: [{ description: 'x', quantity: 1, unit_price: 1 }] }, 400, /Only draft/);
    await admin.fails('POST', `${A()}/invoices/${ids.inv1}/finalize`, {}, 400, /Already finalised/);
    await admin.fails('DELETE', `${A()}/invoices/${ids.inv1}`, undefined, 400, /void/);
    const entry = (await admin.get(`${A()}/journal?type=invoice`)).entries[0];
    await admin.fails('POST', `${A()}/journal/${entry.id}/reverse`, {}, 400, /reverse it from there/);
  });
  await t.test('payments: partial, overpayment guard, full, removal', async () => {
    await admin.fails('POST', `${A()}/invoices/${ids.inv1}/payments`, { amount: 0, account_id: bank }, 400, /positive/);
    await admin.fails('POST', `${A()}/invoices/${ids.inv1}/payments`, { amount: 1, account_id: acc.code('4100').id }, 400, /bank/);
    await admin.post(`${A()}/invoices/${ids.inv1}/payments`, { amount: 98000, account_id: bank, date: '2026-03-10', method: 'Card' });
    assert.equal((await admin.get(`${A()}/invoices/${ids.inv1}`)).status, 'partial');
    await admin.fails('POST', `${A()}/invoices/${ids.inv1}/payments`, { amount: 100001, account_id: bank }, 400, /larger than the amount due/);
    await admin.post(`${A()}/invoices/${ids.inv1}/payments`, { amount: 100000, account_id: bank, date: '2026-03-20' });
    let d = await admin.get(`${A()}/invoices/${ids.inv1}`);
    assert.equal(d.status, 'paid'); assert.equal(d.amount_paid, 198000);
    await admin.fails('POST', `${A()}/invoices/${ids.inv1}/payments`, { amount: 1, account_id: bank }, 400, /unpaid/);
    await admin.del(`${A()}/invoices/${ids.inv1}/payments/${d.payments[1].id}`);
    d = await admin.get(`${A()}/invoices/${ids.inv1}`);
    assert.equal(d.status, 'partial'); assert.equal(d.amount_paid, 98000);
    await assertBooks(admin, ids.acme, 'after payments');
  });
  await t.test('void: blocked with payments, then fully reversed', async () => {
    await admin.fails('POST', `${A()}/invoices/${ids.inv1}/void`, {}, 400, /Remove payments/);
    const d = await admin.get(`${A()}/invoices/${ids.inv1}`);
    await admin.del(`${A()}/invoices/${ids.inv1}/payments/${d.payments[0].id}`);
    await admin.post(`${A()}/invoices/${ids.inv1}/void`);
    const a = await accounts(admin, A());
    assert.equal(a.key('ar').balance, 0); assert.equal(a.code('4100').balance, 0); assert.equal(a.key('tax_out').balance, 0);
    assert.ok((await admin.get(`${A()}/journal?type=invoice_reversal`)).total >= 1);
    await admin.fails('POST', `${A()}/invoices/${ids.inv1}/void`, {}, 400);
  });
  await t.test('overdue tracking, aging and dashboard', async () => {
    ids.overdue = (await admin.post(`${A()}/invoices`, { contact_id: ids.initech, issue_date: daysFromToday(-50), due_date: daysFromToday(-35), finalize: true,
      items: [{ description: 'Old work', quantity: 1, unit_price: 70000, tax_rate: 0 }] })).id;
    const overdue = await admin.get(`${A()}/invoices?status=overdue`);
    assert.deepEqual(overdue.map((d) => d.id), [ids.overdue]);
    const aging = await admin.get(`${A()}/reports/aging?kind=invoice`);
    assert.equal(aging.totals['31-60'], 70000); assert.equal(aging.total, 70000);
    const dash = await admin.get(`${A()}/dashboard`);
    assert.equal(dash.summary.overdue, 70000);
    assert.ok(dash.overdue.some((d) => d.id === ids.overdue));
  });
  await t.test('server-side PDF', async () => {
    const r = await admin.req('GET', `${A()}/invoices/${ids.overdue}/pdf?download=1`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/pdf');
    assert.match(r.headers.get('content-disposition'), /attachment; filename="AC-\d+\.pdf"/);
    const pdf = r.data, text = pdf.toString('latin1');
    assert.equal(text.slice(0, 5), '%PDF-'); assert.ok(text.trimEnd().endsWith('%%EOF'));
    const xref = +/startxref\n(\d+)/.exec(text)[1];
    assert.equal(text.slice(xref, xref + 4), 'xref');
    for (const [, n, off] of text.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm).map((m, i) => [m, i + 1, +m[1]])) assert.ok(text.startsWith(`${n} 0 obj`, off), `xref offset for object ${n}`);
    assert.match(text, /\(Initech\) Tj/);
  });
  await t.test('bills: approve, tax recoverable, pay, AP reconciles', async () => {
    const rent = acc.code('6100').id;
    ids.bill1 = (await admin.post(`${A()}/bills`, { contact_id: ids.landlord, issue_date: '2026-03-01', items: [{ description: 'March rent', quantity: 1, unit_price: 200000, tax_rate: 5, account_id: rent }] })).id;
    let b = await admin.get(`${A()}/bills/${ids.bill1}`);
    assert.equal(b.number, 'BILL-0001'); assert.equal(b.status, 'draft');
    await admin.post(`${A()}/bills/${ids.bill1}/finalize`);
    const a = await accounts(admin, A());
    assert.equal(a.key('ap').balance, 210000); assert.equal(a.code('6100').balance, 200000); assert.equal(a.key('tax_in').balance, 10000);
    await admin.post(`${A()}/bills/${ids.bill1}/payments`, { amount: 210000, account_id: bank, date: '2026-03-05' });
    b = await admin.get(`${A()}/bills/${ids.bill1}`);
    assert.equal(b.status, 'paid');
    const tax = await admin.get(`${A()}/reports/tax?from=2026-01-01&to=2026-12-31`);
    assert.equal(tax.paid, 10000);
  });
  await t.test('contacts with documents cannot be deleted', async () => {
    await admin.fails('DELETE', `${A()}/contacts/${ids.landlord}`, undefined, 400, /cannot be deleted/);
  });
  await assertBooks(admin, ids.acme, 'invoices & bills');
});

// ======================================================================
test('8. banking & bank fees', async (t) => {
  let acc = await accounts(admin, A());
  const bank = acc.key('bank').id, savings = acc.code('1020').id, fees = () => acc.key('bank_fees').balance;
  const today = daysFromToday(0);
  await t.test('per-account fee settings', async () => {
    await admin.put(`${A()}/accounts/${bank}`, { fee_fixed: 100, fee_percent: 1, monthly_fee: 1500, monthly_fee_day: 1 });
    acc = await accounts(admin, A());
    const b = acc.byId(bank);
    assert.equal(b.fee_fixed, 100); assert.equal(b.fee_percent, 1); assert.equal(b.monthly_fee, 1500);
  });
  await t.test('money in / out with fees', async () => {
    const before = acc.byId(bank).balance, feeBefore = fees();
    await admin.post(`${A()}/bank/transactions`, { account_id: bank, category_id: acc.code('6300').id, direction: 'out', amount: 10000, fee: 150, date: today, description: 'Printer paper' });
    await admin.post(`${A()}/bank/transactions`, { account_id: bank, category_id: acc.code('4900').id, direction: 'in', amount: 20000, fee: 250, date: today, description: 'Grant' });
    acc = await accounts(admin, A());
    assert.equal(acc.byId(bank).balance, before - 10150 + 19750);
    assert.equal(fees(), feeBefore + 400);
    await admin.fails('POST', `${A()}/bank/transactions`, { account_id: bank, category_id: acc.code('4900').id, direction: 'in', amount: 100, fee: 100, date: today }, 400, /Fee cannot exceed/);
    await admin.fails('POST', `${A()}/bank/transactions`, { account_id: acc.code('4900').id, category_id: bank, direction: 'in', amount: 100, date: today }, 400, /bank/);
    await admin.fails('POST', `${A()}/bank/transactions`, { account_id: bank, category_id: bank, direction: 'in', amount: 100, date: today }, 400, /different account/);
  });
  await t.test('transfers with fee', async () => {
    const b0 = acc.byId(bank).balance, s0 = acc.byId(savings).balance, f0 = fees();
    await admin.post(`${A()}/bank/transfer`, { from_id: bank, to_id: savings, amount: 500000, fee: 300, date: today });
    acc = await accounts(admin, A());
    assert.equal(acc.byId(bank).balance, b0 - 500300); assert.equal(acc.byId(savings).balance, s0 + 500000); assert.equal(fees(), f0 + 300);
    await admin.fails('POST', `${A()}/bank/transfer`, { from_id: bank, to_id: bank, amount: 1, date: today }, 400, /two different/);
  });
  await t.test('invoice payment with a bank fee deducted', async () => {
    const id = (await admin.post(`${A()}/invoices`, { contact_id: ids.globex, issue_date: today, finalize: true, items: [{ description: 'Workshop', quantity: 1, unit_price: 50000, tax_rate: 0 }] })).id;
    const b0 = acc.byId(bank).balance, f0 = fees();
    await admin.fails('POST', `${A()}/invoices/${id}/payments`, { amount: 50000, fee: 60000, account_id: bank, date: today }, 400, /fee cannot exceed/i);
    await admin.post(`${A()}/invoices/${id}/payments`, { amount: 50000, fee: 600, account_id: bank, date: today });
    acc = await accounts(admin, A());
    assert.equal(acc.byId(bank).balance, b0 + 49400); assert.equal(fees(), f0 + 600);
    assert.equal((await admin.get(`${A()}/invoices/${id}`)).status, 'paid');
  });
  await t.test('CSV statement import is atomic', async () => {
    const count = async () => (await admin.get(`${A()}/journal?type=bank`)).total;
    const c0 = await count();
    const rows = [{ date: today, description: 'Card sale', amount: 12345 }, { date: today, description: 'SaaS', amount: -4999 }, { date: today, description: 'Zero row', amount: 0 }];
    const r = await admin.post(`${A()}/bank/import`, { account_id: savings, income_category_id: acc.key('sales').id, expense_category_id: acc.code('6400').id, rows });
    assert.equal(r.imported, 2);
    assert.equal(await count(), c0 + 2);
    await admin.fails('POST', `${A()}/bank/import`, { account_id: savings, income_category_id: acc.key('sales').id, expense_category_id: acc.code('6400').id,
      rows: [{ date: today, description: 'ok', amount: 100 }, { date: 'garbage', description: 'bad', amount: 100 }] }, 400, /Row 2/);
    assert.equal(await count(), c0 + 2, 'failed import must not leave partial rows');
    await admin.fails('POST', `${A()}/bank/import`, { account_id: savings, rows: [] }, 400, /Nothing to import/);
  });
  await t.test('reversing a bank transaction', async () => {
    const e = (await admin.get(`${A()}/journal?type=bank&q=Printer`)).entries[0];
    await admin.post(`${A()}/journal/${e.id}/reverse`);
    assert.ok((await admin.get(`${A()}/journal?type=bank_reversal`)).total >= 1);
  });
  await t.test('monthly account fee posts once per month', async () => {
    const B = app.src('banking'), { get } = app.src('db');
    const org = get('SELECT * FROM orgs WHERE id = ?', ids.acme);
    const f0 = (await accounts(admin, A())).key('bank_fees').balance;
    assert.equal(B.postMonthlyFees(org), 1);
    assert.equal(B.postMonthlyFees(org), 0);
    assert.equal((await accounts(admin, A())).key('bank_fees').balance, f0 + 1500);
    assert.equal(get('SELECT last_monthly_fee FROM accounts WHERE id = ?', bank).last_monthly_fee, today.slice(0, 7));
  });
  await t.test('banking overview', async () => {
    const data = await admin.get(`${A()}/bank?account_id=${bank}`);
    assert.ok(data.accounts.length >= 3);
    assert.equal(data.ledger.account.id, bank);
    assert.equal(data.ledger.closing, (await accounts(admin, A())).byId(bank).balance);
    assert.equal(data.feesYtd, 250 + 300 + 600 + 1500, 'the reversed "Printer paper" fee no longer counts');
  });
  await assertBooks(admin, ids.acme, 'banking');
});

// ======================================================================
test('9. multi-currency (MGA base with EUR / USD)', async (t) => {
  let acc = await accounts(admin, T());
  const mgaBank = acc.key('bank').id;
  await admin.post(`${T()}/bank/transactions`, { account_id: mgaBank, category_id: acc.key('capital').id, direction: 'in', amount: Ar(500000000), date: '2026-01-01', description: 'Capital' });
  await t.test('exchange rates: create, validate, look up, delete', async () => {
    await admin.post(`${T()}/rates`, { currency: 'EUR', date: '2026-01-01', rate: 5000 });
    await admin.post(`${T()}/rates`, { currency: 'EUR', date: '2026-03-01', rate: 5100 });
    await admin.post(`${T()}/rates`, { currency: 'EUR', date: '2026-03-01', rate: 5150 }); // upsert same date
    await admin.fails('POST', `${T()}/rates`, { currency: 'MGA', date: '2026-01-01', rate: 1 }, 400, /base currency/);
    await admin.fails('POST', `${T()}/rates`, { currency: 'GBP', date: '2026-01-01', rate: 6000 }, 400, /not enabled/);
    await admin.fails('POST', `${T()}/rates`, { currency: 'EUR', date: '2026-01-01', rate: -5 }, 400, /positive/);
    assert.equal((await admin.get(`${T()}/rates/lookup?currency=EUR&date=2026-02-15`)).rate, 5000);
    assert.equal((await admin.get(`${T()}/rates/lookup?currency=EUR&date=2026-03-02`)).rate, 5150);
    assert.equal((await admin.get(`${T()}/rates/lookup?currency=EUR&date=2025-06-01`)).rate, 5000, 'falls back to earliest rate');
    assert.equal((await admin.get(`${T()}/rates/lookup?currency=MGA`)).rate, 1);
    assert.equal((await admin.get(`${T()}/rates/lookup?currency=USD`)).found, false);
    const tmp = (await admin.get(`${T()}/rates`)).rates.find((r) => r.date === '2026-03-01');
    await admin.del(`${T()}/rates/${tmp.id}`);
    await admin.post(`${T()}/rates`, { currency: 'EUR', date: '2026-03-01', rate: 5100 });
  });
  await t.test('enabling another currency', async () => {
    await admin.put(T(), { currencies: ['MGA', 'EUR', 'USD', 'GBP'] });
    await admin.post(`${T()}/rates`, { currency: 'GBP', date: '2026-01-01', rate: 5900 });
    await admin.put(T(), { currencies: 'MGA,EUR,USD' });
    await admin.fails('GET', `${T()}/rates/lookup?currency=GBP`, undefined, 400, /not enabled/);
  });
  ids.paris = (await admin.post(`${T()}/contacts`, { name: 'Paris Import SA', kind: 'customer', email: 'compta@paris-import.test', address: '12 rue des Arômes\nMarseille' })).id;
  ids.brooklyn = (await admin.post(`${T()}/contacts`, { name: 'Brooklyn Pastry', kind: 'customer', email: 'billing@bkpastry.test' })).id;
  await t.test('foreign invoice needs a rate (saved or explicit)', async () => {
    await admin.fails('POST', `${T()}/invoices`, { contact_id: ids.brooklyn, currency: 'USD', issue_date: '2026-02-01', items: [{ description: 'Vanilla', quantity: 1, unit_price: 100000 }] }, 400, /No exchange rate/);
    ids.usdInv = (await admin.post(`${T()}/invoices`, { contact_id: ids.brooklyn, currency: 'USD', exchange_rate: 4500, issue_date: '2026-02-01', finalize: true, items: [{ description: 'Vanilla', quantity: 1, unit_price: 100000, tax_rate: 0 }] })).id;
    const d = await admin.get(`${T()}/invoices/${ids.usdInv}`);
    assert.equal(d.currency, 'USD'); assert.equal(d.exchange_rate, 4500); assert.equal(d.total_base, 100000 * 4500);
    await admin.fails('POST', `${T()}/invoices`, { contact_id: ids.brooklyn, currency: 'JPY', issue_date: '2026-02-01', items: [{ description: 'x', quantity: 1, unit_price: 1 }] }, 400, /not enabled/);
  });
  await t.test('EUR invoice paid in three parts at different rates: AR clears exactly, FX difference booked', async () => {
    ids.eurInv = (await admin.post(`${T()}/invoices`, { contact_id: ids.paris, currency: 'EUR', issue_date: '2026-02-10', finalize: true, items: [{ description: 'Vanilla 10kg', quantity: 10, unit_price: 10000, tax_rate: 0 }] })).id;
    let d = await admin.get(`${T()}/invoices/${ids.eurInv}`);
    assert.equal(d.exchange_rate, 5000); assert.equal(d.total_base, 500000000);
    const fx0 = (await accounts(admin, T())).key('fx').balance;
    await admin.post(`${T()}/invoices/${ids.eurInv}/payments`, { amount: 30000, account_id: mgaBank, date: '2026-03-05', exchange_rate: 5100 });
    await admin.post(`${T()}/invoices/${ids.eurInv}/payments`, { amount: 30000, account_id: mgaBank, date: '2026-03-06', exchange_rate: 4900 });
    const last = await admin.post(`${T()}/invoices/${ids.eurInv}/payments`, { amount: 40000, account_id: mgaBank, date: '2026-03-07', exchange_rate: 5200 });
    assert.equal(last.diff, 40000 * 5200 - 200000000);
    d = await admin.get(`${T()}/invoices/${ids.eurInv}`);
    assert.equal(d.status, 'paid'); assert.equal(d.paid_base, d.total_base);
    acc = await accounts(admin, T());
    assert.equal(acc.key('fx').balance - fx0, (153000000 - 150000000) + (147000000 - 150000000) + (208000000 - 200000000));
    const line = (await admin.get(`${T()}/journal?type=payment`)).entries.flatMap((e) => e.lines).find((l) => l.fx_currency === 'EUR');
    assert.ok(line && line.fx_amount > 0, 'foreign amount kept on journal lines');
    await assertBooks(admin, ids.tsara, 'after FX payments');
  });
  await t.test('foreign-currency bank account: currency rules', async () => {
    ids.eurBank = (await admin.post(`${T()}/accounts`, { code: '1030', name: 'BNI EUR', type: 'asset', is_bank: true, currency: 'EUR', fee_fixed: 200, fee_percent: 0.5 })).id;
    ids.usdBank = (await admin.post(`${T()}/accounts`, { code: '1031', name: 'BFV USD', type: 'asset', is_bank: true, currency: 'USD' })).id;
    await admin.fails('POST', `${T()}/invoices/${ids.usdInv}/payments`, { amount: 100, account_id: ids.eurBank }, 400, /account in USD/);
    await admin.fails('POST', `${T()}/bank/transfer`, { from_id: mgaBank, to_id: ids.eurBank, amount: Ar(1000000), date: '2026-03-02' }, 400, /amount received in EUR/);
    await admin.post(`${T()}/bank/transfer`, { from_id: mgaBank, to_id: ids.eurBank, amount: Ar(10200000), to_amount: 200000, fee: Ar(10000), date: '2026-03-02' });
    acc = await accounts(admin, T());
    assert.equal(acc.byId(ids.eurBank).fx_balance, 200000);
    assert.equal(acc.byId(ids.eurBank).balance, Ar(10200000));
    await admin.fails('PUT', `${T()}/accounts/${ids.eurBank}`, { currency: 'USD' }, 400, /cannot change/);
  });
  await t.test('EUR bill paid from the EUR account with a fee', async () => {
    const vendor = (await admin.post(`${T()}/contacts`, { name: 'Rotterdam Freight', kind: 'vendor' })).id;
    const id = (await admin.post(`${T()}/bills`, { contact_id: vendor, currency: 'EUR', issue_date: '2026-03-01', finalize: true, items: [{ description: 'Freight', quantity: 1, unit_price: 50000, tax_rate: 0, account_id: acc.code('6990').id }] })).id;
    const f0 = acc.key('bank_fees').balance;
    await admin.post(`${T()}/bills/${id}/payments`, { amount: 50000, fee: 450, account_id: ids.eurBank, date: '2026-03-10', exchange_rate: 5000 });
    acc = await accounts(admin, T());
    assert.equal(acc.byId(ids.eurBank).fx_balance, 200000 - 50450);
    assert.equal(acc.key('bank_fees').balance - f0, 450 * 5000);
    assert.equal(acc.key('ap').balance, 0);
  });
  await t.test('money in on a foreign account converts at the saved rate', async () => {
    const b0 = acc.byId(ids.eurBank).balance;
    await admin.post(`${T()}/bank/transactions`, { account_id: ids.eurBank, category_id: acc.code('4900').id, direction: 'in', amount: 10000, date: '2026-03-15', description: 'EU grant' });
    acc = await accounts(admin, T());
    assert.equal(acc.byId(ids.eurBank).balance - b0, 10000 * 5100);
    assert.equal(acc.byId(ids.eurBank).fx_balance, 200000 - 50450 + 10000);
  });
  await t.test('revaluation of the foreign account', async () => {
    await admin.fails('POST', `${T()}/bank/${mgaBank}/revalue`, { exchange_rate: 1 }, 400, /foreign-currency/);
    const r = await admin.post(`${T()}/bank/${ids.eurBank}/revalue`, { date: '2026-03-31', exchange_rate: 5300 });
    acc = await accounts(admin, T());
    assert.equal(acc.byId(ids.eurBank).balance, Math.round(acc.byId(ids.eurBank).fx_balance * 5300));
    assert.notEqual(r.diff, 0);
    assert.equal((await admin.post(`${T()}/bank/${ids.eurBank}/revalue`, { date: '2026-03-31', exchange_rate: 5300 })).diff, 0);
    const gl = await admin.get(`${T()}/reports/ledger?account_id=${ids.eurBank}`);
    assert.equal(gl.fxClosing, acc.byId(ids.eurBank).fx_balance);
  });
  await t.test('base currency is locked once transactions exist', async () => {
    await admin.fails('PUT', T(), { currency: 'EUR' }, 400, /cannot change/);
  });
  await t.test('aging and contacts are expressed in the base currency', async () => {
    const aging = await admin.get(`${T()}/reports/aging?kind=invoice&asOf=2026-12-31`);
    const usd = aging.rows.find((r) => r.id === ids.usdInv);
    assert.equal(usd.due, 100000); assert.equal(usd.due_base, 450000000);
    assert.equal((await admin.get(`${T()}/contacts`)).find((c) => c.id === ids.brooklyn).receivable, 450000000);
  });
  await assertBooks(admin, ids.tsara, 'multi-currency');
});

// ======================================================================
test('10. inventory & cost of goods sold', async (t) => {
  let acc = await accounts(admin, T());
  const growers = (await admin.post(`${T()}/contacts`, { name: 'Sava Growers', kind: 'vendor' })).id;
  const product = (id) => admin.get(`${T()}/products/${id}`);
  await t.test('products: validation, opening stock, services', async () => {
    await admin.fails('POST', `${T()}/products`, { name: '' }, 400, /name is required/);
    ids.vanilla = (await admin.post(`${T()}/products`, { name: 'Vanilla 1kg', sku: 'VAN', kind: 'inventory', unit: 'kg', sale_price: Ar(900000), purchase_price: Ar(400000), reorder_level: 20, opening_qty: 10, opening_date: '2026-01-05' })).id;
    ids.logistics = (await admin.post(`${T()}/products`, { name: 'Export logistics', kind: 'service', sale_price: Ar(1000000), income_account_id: acc.code('4100').id })).id;
    const v = await product(ids.vanilla);
    assert.equal(v.qty, 10); assert.equal(v.value, Ar(4000000)); assert.equal(v.avg_cost, Ar(400000));
    assert.equal(v.moves.length, 1); assert.equal(v.moves[0].ref_type, 'adjustment');
    assert.ok(v.low, 'below reorder level');
    assert.equal((await accounts(admin, T())).key('inventory').balance, Ar(4000000));
  });
  await t.test('purchases update weighted average cost', async () => {
    ids.purchase = (await admin.post(`${T()}/bills`, { contact_id: growers, issue_date: '2026-04-01', finalize: true, items: [{ description: 'Vanilla', product_id: ids.vanilla, quantity: 30, unit_price: Ar(480000), tax_rate: 0 }] })).id;
    const v = await product(ids.vanilla);
    assert.equal(v.qty, 40); assert.equal(v.value, Ar(4000000 + 14400000)); assert.equal(v.avg_cost, Ar(460000));
    assert.equal(v.low, false);
    acc = await accounts(admin, T());
    assert.equal(acc.key('inventory').balance, Ar(18400000));
  });
  await t.test('foreign-currency purchase is valued in base currency', async () => {
    const eurBill = (await admin.post(`${T()}/bills`, { contact_id: growers, currency: 'EUR', issue_date: '2026-04-02', finalize: true, items: [{ description: 'Vanilla EU', product_id: ids.vanilla, quantity: 10, unit_price: 9000, tax_rate: 0 }] })).id;
    const v = await product(ids.vanilla);
    assert.equal(v.qty, 50); assert.equal(v.value, Ar(18400000) + 10 * 9000 * 5100);
    ids.eurPurchase = eurBill;
  });
  await t.test('sales post COGS at average cost; services do not touch stock', async () => {
    const before = await product(ids.vanilla);
    const avg = before.value / before.qty;
    ids.sale = (await admin.post(`${T()}/invoices`, { contact_id: ids.paris, issue_date: '2026-04-05', finalize: true, items: [
      { description: 'Vanilla', product_id: ids.vanilla, quantity: 15, unit_price: Ar(900000), tax_rate: 20 },
      { description: 'Logistics', product_id: ids.logistics, quantity: 1, unit_price: Ar(1000000), tax_rate: 20 },
    ] })).id;
    const v = await product(ids.vanilla);
    const cogs = Math.round(avg * 15);
    assert.equal(v.qty, 35); assert.equal(v.value, before.value - cogs);
    acc = await accounts(admin, T());
    assert.equal(acc.key('cogs').balance, cogs);
    assert.equal(acc.code('4100').balance, Ar(1000000), 'service revenue goes to the product account');
    assert.equal((await product(ids.logistics)).moves.length, 0);
    const pnl = await admin.get(`${T()}/reports/pnl?from=2026-04-01&to=2026-04-30`);
    assert.equal(pnl.totalCogs, cogs); assert.equal(pnl.grossProfit, pnl.totalIncome - cogs);
  });
  await t.test('stock adjustments', async () => {
    const b = await product(ids.vanilla);
    await admin.post(`${T()}/products/${ids.vanilla}/adjust`, { qty: -2, note: 'Mould', date: '2026-04-06' });
    let v = await product(ids.vanilla);
    assert.equal(v.qty, 33); assert.equal(v.value, b.value - Math.round((b.value / b.qty) * 2));
    await admin.post(`${T()}/products/${ids.vanilla}/adjust`, { qty: 5, unit_cost: Ar(500000), note: 'Found in warehouse', date: '2026-04-07' });
    v = await product(ids.vanilla);
    assert.equal(v.qty, 38);
    await admin.fails('POST', `${T()}/products/${ids.vanilla}/adjust`, { qty: 0 }, 400, /non-zero/);
    await admin.fails('POST', `${T()}/products/${ids.logistics}/adjust`, { qty: 1 }, 400, /stock items/);
    assert.ok((await admin.get(`${T()}/journal?type=stock`)).total >= 3);
  });
  await t.test('voiding sales and purchases restores stock exactly', async () => {
    const b = await product(ids.vanilla);
    await admin.post(`${T()}/invoices/${ids.sale}/void`);
    let v = await product(ids.vanilla);
    assert.equal(v.qty, b.qty + 15);
    assert.equal((await accounts(admin, T())).key('cogs').balance, 0);
    await admin.post(`${T()}/bills/${ids.eurPurchase}/void`);
    v = await product(ids.vanilla);
    assert.equal(v.qty, b.qty + 5);
    assert.ok(v.moves.some((m) => m.ref_type === 'invoice_reversal') && v.moves.some((m) => m.ref_type === 'bill_reversal'));
  });
  await t.test('products with history are protected', async () => {
    await admin.fails('DELETE', `${T()}/products/${ids.vanilla}`, undefined, 400, /inactive/);
    await admin.fails('PUT', `${T()}/products/${ids.vanilla}`, { kind: 'service' }, 400, /stock item/);
    const tmp = (await admin.post(`${T()}/products`, { name: 'Temp', kind: 'non_inventory' })).id;
    await admin.put(`${T()}/products/${tmp}`, { active: false, sale_price: 5 });
    assert.equal((await product(tmp)).active, 0);
    await admin.del(`${T()}/products/${tmp}`);
  });
  await t.test('cross-organisation product references are rejected', async () => {
    await admin.fails('POST', `${A()}/invoices`, { contact_id: ids.globex, issue_date: '2026-04-01', items: [{ description: 'x', product_id: ids.vanilla, quantity: 1, unit_price: 1 }] }, 404, /Product not found/);
  });
  await t.test('valuation report and low-stock dashboard', async () => {
    await admin.put(`${T()}/products/${ids.vanilla}`, { reorder_level: 100 });
    const val = await admin.get(`${T()}/reports/inventory`);
    assert.equal(val.difference, 0);
    assert.ok(val.products.find((p) => p.id === ids.vanilla).low);
    assert.ok((await admin.get(`${T()}/dashboard`)).lowStock.some((p) => p.id === ids.vanilla));
    assert.equal((await admin.get(`${T()}/products`)).find((p) => p.id === ids.vanilla).low, true);
  });
  await assertBooks(admin, ids.tsara, 'inventory');
});

// ======================================================================
test('11. emailing invoices over SMTP', async (t) => {
  const sent = () => smtp.messages.length;
  await t.test('SMTP settings are stored but the password never leaves the server', async () => {
    assert.equal((await admin.get(T())).email_ready, false);
    await admin.put(T(), { smtp_host: '127.0.0.1', smtp_port: smtp.port, smtp_secure: 'none', smtp_user: 'mailer', smtp_pass: 's3cret!', smtp_from: 'billing@tsara.test', legal_name: 'Tsara Vanille SARL' });
    const o = await admin.get(T());
    assert.equal(o.smtp_pass, undefined); assert.equal(o.smtp_pass_set, true); assert.equal(o.email_ready, true);
  });
  await t.test('test email authenticates with AUTH PLAIN', async () => {
    const n = sent();
    await admin.post(`${T()}/email/test`, { to: 'ada@ledgerly.test' });
    assert.equal(sent(), n + 1);
    const m = smtp.messages.at(-1);
    assert.equal(m.auth, 'AUTH PLAIN ' + Buffer.from('\0mailer\0s3cret!').toString('base64'));
    assert.match(parseMail(m.data).subject, /Ledgerly test email/);
  });
  await t.test('draft uses templates and contact email', async () => {
    const draft = await admin.get(`${T()}/invoices/${ids.eurInv}/email`);
    assert.equal(draft.to, 'compta@paris-import.test');
    assert.match(draft.subject, /Invoice INV-\d+ from Tsara Vanille SARL/);
    assert.match(draft.message, /Paris Import SA/);
    await admin.put(T(), { email_subject: '{company} — facture {number} ({total})' });
    assert.match((await admin.get(`${T()}/invoices/${ids.eurInv}/email`)).subject, /^Tsara Vanille SARL — facture INV-\d+ \(/);
  });
  await t.test('invoice email: UTF-8 subject, cc, HTML body and PDF attachment', async () => {
    const n = sent();
    await admin.post(`${T()}/invoices/${ids.eurInv}/email`, { cc: 'Boss <boss@tsara.test>', subject: 'Facture n° spéciale', message: 'Bonjour,\nVoici la facture.' });
    assert.equal(sent(), n + 1);
    const raw = smtp.messages.at(-1), mail = parseMail(raw.data);
    assert.equal(mail.subject, 'Facture n° spéciale');
    assert.match(mail.cc, /boss@tsara\.test/);
    assert.equal(raw.rcpt.length, 2);
    assert.match(mail.text, /Voici la facture/);
    assert.match(mail.html, /INV-\d+/);
    assert.equal(mail.attachments.length, 1);
    assert.match(mail.attachments[0].filename, /^INV-\d+\.pdf$/);
    assert.equal(mail.attachments[0].content.subarray(0, 5).toString(), '%PDF-');
    const d = await admin.get(`${T()}/invoices/${ids.eurInv}`);
    assert.ok(d.last_emailed_at);
    assert.equal(d.emails[0].status, 'sent');
  });
  await t.test('emailing a draft finalises it first; void invoices cannot be emailed', async () => {
    const id = (await admin.post(`${T()}/invoices`, { contact_id: ids.paris, issue_date: daysFromToday(0), items: [{ description: 'Sample', quantity: 1, unit_price: Ar(10000), tax_rate: 0 }] })).id;
    await admin.post(`${T()}/invoices/${id}/email`, { attach_pdf: false });
    assert.equal((await admin.get(`${T()}/invoices/${id}`)).status, 'sent');
    assert.equal(parseMail(smtp.messages.at(-1).data).attachments.length, 0);
    await admin.fails('POST', `${T()}/invoices/${ids.sale}/email`, {}, 400, /Void/);
  });
  await t.test('delivery failures are reported and logged', async () => {
    const noEmail = (await admin.post(`${T()}/contacts`, { name: 'No Email Ltd', kind: 'customer' })).id;
    const id = (await admin.post(`${T()}/invoices`, { contact_id: noEmail, issue_date: daysFromToday(0), finalize: true, items: [{ description: 'x', quantity: 1, unit_price: Ar(1000) }] })).id;
    await admin.fails('POST', `${T()}/invoices/${id}/email`, {}, 400, /no email address/);
    await admin.fails('POST', `${T()}/invoices/${id}/email`, { to: 'not-an-email' }, 400, /Invalid email/);
    const bad = await fakeSmtp({ rejectAuth: true });
    await admin.put(T(), { smtp_port: bad.port });
    await admin.fails('POST', `${T()}/invoices/${id}/email`, { to: 'x@y.test' }, 502, /AUTH failed: 535/);
    await bad.close();
    await admin.put(T(), { smtp_port: bad.port }); // now nothing listens there
    await admin.fails('POST', `${T()}/invoices/${id}/email`, { to: 'x@y.test' }, 502, /Could not send email/);
    await admin.put(T(), { smtp_port: smtp.port });
    const log = (await admin.get(`${T()}/invoices/${id}`)).emails;
    assert.ok(log.filter((e) => e.status === 'failed').length >= 3);
  });
  await t.test('STARTTLS is required when chosen', async () => {
    await admin.put(T(), { smtp_secure: 'starttls' });
    await admin.fails('POST', `${T()}/email/test`, { to: 'x@y.test' }, 502, /STARTTLS/);
    await admin.put(T(), { smtp_secure: 'none' });
  });
});

// ======================================================================
test('12. recurring invoices & scheduler', async (t) => {
  const D = app.src('documents'), scheduler = app.src('scheduler');
  await t.test('date maths: month-end clamping, leap years, intervals', () => {
    assert.equal(D.nextDate('2026-01-31', 'monthly', 1, 31), '2026-02-28');
    assert.equal(D.nextDate('2026-02-28', 'monthly', 1, 31), '2026-03-31');
    assert.equal(D.nextDate('2024-01-31', 'monthly', 1, 31), '2024-02-29');
    assert.equal(D.nextDate('2026-01-10', 'monthly', 2, 10), '2026-03-10');
    assert.equal(D.nextDate('2026-11-15', 'quarterly', 1, 15), '2027-02-15');
    assert.equal(D.nextDate('2028-02-29', 'yearly', 1, 29), '2029-02-28');
    assert.equal(D.nextDate('2026-12-29', 'weekly', 1), '2027-01-05');
  });
  const now = new Date(), day = Math.min(now.getUTCDate(), 28);
  const monthsAgo = (n) => iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, day)));
  const item = [{ description: 'Warehouse rental', quantity: 1, unit_price: Ar(2500000), tax_rate: 20 }];
  await t.test('validation', async () => {
    await admin.fails('POST', `${T()}/recurring`, { start_date: monthsAgo(0), items: item }, 400, /customer/);
    await admin.fails('POST', `${T()}/recurring`, { contact_id: ids.paris, start_date: monthsAgo(0), items: [] }, 400, /line item/);
    await admin.fails('POST', `${T()}/recurring`, { contact_id: ids.paris, start_date: monthsAgo(0), end_date: monthsAgo(1), items: item }, 400, /End date/);
    await admin.fails('POST', `${T()}/recurring`, { contact_id: ids.paris, currency: 'GBP', start_date: monthsAgo(0), items: item }, 400, /not enabled/);
  });
  await t.test('scheduler catches up missed months, posts and emails each invoice', async () => {
    const n = smtp.messages.length;
    ids.tpl = (await admin.post(`${T()}/recurring`, { name: 'Rental', contact_id: ids.paris, currency: 'MGA', frequency: 'monthly', start_date: monthsAgo(3), items: item, auto_finalize: true, auto_email: true })).id;
    await scheduler.tick();
    const r = await admin.get(`${T()}/recurring/${ids.tpl}`);
    assert.equal(r.invoices.length, 4);
    assert.equal(r.generated, 4);
    assert.ok(r.next_date > iso(now));
    assert.ok(r.invoices.every((i) => i.status === 'sent'));
    assert.equal(smtp.messages.length, n + 4);
    assert.deepEqual(r.invoices.map((i) => i.issue_date).sort(), [3, 2, 1, 0].map(monthsAgo));
    await scheduler.tick();
    assert.equal((await admin.get(`${T()}/recurring/${ids.tpl}`)).invoices.length, 4, 'scheduler is idempotent');
  });
  await t.test('generate now', async () => {
    const r = await admin.post(`${T()}/recurring/${ids.tpl}/run`);
    assert.equal(r.ids.length, 1);
    const inv = await admin.get(`${T()}/invoices/${r.ids[0]}`);
    assert.equal(inv.recurring_id, ids.tpl);
    assert.equal(inv.total, Ar(3000000));
  });
  await t.test('paused templates, draft mode and end dates', async () => {
    const paused = (await admin.post(`${T()}/recurring`, { contact_id: ids.paris, frequency: 'weekly', start_date: monthsAgo(1), items: item, active: false })).id;
    const draft = (await admin.post(`${T()}/recurring`, { contact_id: ids.paris, frequency: 'yearly', start_date: monthsAgo(0), items: item, auto_finalize: false })).id;
    const start = monthsAgo(2), end = iso(new Date(Date.parse(start) + 40 * 86400000));
    const ending = (await admin.post(`${T()}/recurring`, { contact_id: ids.paris, frequency: 'monthly', start_date: start, end_date: end, items: item })).id;
    await scheduler.tick();
    assert.equal((await admin.get(`${T()}/recurring/${paused}`)).invoices.length, 0);
    const dr = await admin.get(`${T()}/recurring/${draft}`);
    assert.equal(dr.invoices.length, 1); assert.equal(dr.invoices[0].status, 'draft');
    const en = await admin.get(`${T()}/recurring/${ending}`);
    assert.equal(en.invoices.length, 2); assert.equal(en.active, 0, 'deactivated after end date');
  });
  await t.test('foreign-currency template waits for a rate', async () => {
    const usd = (await admin.post(`${T()}/recurring`, { contact_id: ids.brooklyn, currency: 'USD', frequency: 'monthly', start_date: monthsAgo(0), items: [{ description: 'Subscription', quantity: 1, unit_price: 50000, tax_rate: 0 }] })).id;
    await scheduler.tick();
    let r = await admin.get(`${T()}/recurring/${usd}`);
    assert.equal(r.invoices.length, 0); assert.match(r.last_error, /No exchange rate for USD/);
    await admin.post(`${T()}/rates`, { currency: 'USD', date: monthsAgo(1), rate: 4600 });
    await scheduler.tick();
    r = await admin.get(`${T()}/recurring/${usd}`);
    assert.equal(r.invoices.length, 1); assert.equal(r.last_error, null);
    assert.equal((await admin.get(`${T()}/invoices/${r.invoices[0].id}`)).exchange_rate, 4600);
  });
  await t.test('edit and delete keep generated invoices', async () => {
    await admin.put(`${T()}/recurring/${ids.tpl}`, { interval_count: 2, notes: 'Updated' });
    const r = await admin.get(`${T()}/recurring/${ids.tpl}`);
    assert.equal(r.interval_count, 2);
    const invId = r.invoices[0].id;
    await admin.del(`${T()}/recurring/${ids.tpl}`);
    assert.equal((await admin.get(`${T()}/invoices/${invId}`)).recurring_id, null);
    assert.ok((await admin.get(`${T()}/dashboard`)).recurring.length >= 1);
  });
  await assertBooks(admin, ids.tsara, 'recurring');
});

// ======================================================================
test('13. payroll — flat-rate scheme', async (t) => {
  await t.test('needs active employees and valid periods', async () => {
    await admin.fails('POST', `${A()}/payroll`, { period_start: '2026-09-01', period_end: '2026-09-30', pay_date: '2026-09-30' }, 400, /active employee/);
    await admin.fails('POST', `${A()}/employees`, { pay_rate: 1 }, 400, /name is required/);
  });
  ids.jane = (await admin.post(`${A()}/employees`, { name: 'Jane', pay_type: 'salary', pay_rate: 400000, income_tax_rate: 10, social_rate: 5, employer_rate: 12, fixed_deduction: 5000, email: 'jane@acme.test' })).id;
  ids.joe = (await admin.post(`${A()}/employees`, { name: 'Joe', pay_type: 'hourly', pay_rate: 2500, income_tax_rate: 150, social_rate: -3 })).id;
  await t.test('rates are clamped and updatable', async () => {
    const joe = (await admin.get(`${A()}/employees`)).find((e) => e.id === ids.joe);
    assert.equal(joe.income_tax_rate, 100); assert.equal(joe.social_rate, 0);
    await admin.put(`${A()}/employees/${ids.joe}`, { income_tax_rate: 0 });
    await admin.fails('POST', `${A()}/payroll`, { period_start: '2026-09-30', period_end: '2026-09-01', pay_date: '2026-09-30' }, 400, /before period start/);
  });
  await t.test('pay run computation, edits and posting', async () => {
    const acc0 = await accounts(admin, A());
    const id = (await admin.post(`${A()}/payroll`, { period_start: '2026-09-01', period_end: '2026-09-30', pay_date: '2026-09-30' })).id;
    let run = await admin.get(`${A()}/payroll/${id}`);
    const jane = run.payslips.find((s) => s.name === 'Jane'), joe = run.payslips.find((s) => s.name === 'Joe');
    assert.deepEqual([jane.gross, jane.income_tax, jane.social, jane.other_deductions, jane.net, jane.employer_cost], [400000, 40000, 20000, 5000, 335000, 48000]);
    assert.equal(joe.hours, 160); assert.equal(joe.gross, 400000);
    const s = await admin.put(`${A()}/payroll/${id}/payslips/${joe.id}`, { hours: 100, bonus: 10000, other_deductions: 0 });
    assert.equal(s.base, 250000); assert.equal(s.gross, 260000); assert.equal(s.net, 260000);
    await admin.post(`${A()}/payroll/${id}/post`);
    const acc1 = await accounts(admin, A());
    const delta = (k) => acc1.key(k).balance - acc0.key(k).balance;
    assert.equal(delta('wages'), 660000); assert.equal(delta('payroll_tax'), 48000);
    assert.equal(delta('payroll_liab'), 40000 + 20000 + 5000 + 48000);
    assert.equal(delta('bank'), -(335000 + 260000));
    run = await admin.get(`${A()}/payroll/${id}`);
    assert.equal(run.status, 'posted'); assert.equal(run.totals.net, 595000);
    await admin.fails('PUT', `${A()}/payroll/${id}/payslips/${joe.id}`, { bonus: 1 }, 400, /already posted/);
    await admin.fails('POST', `${A()}/payroll/${id}/post`, {}, 400, /already posted/);
    await admin.fails('DELETE', `${A()}/payroll/${id}`, undefined, 400, /Void/);
    await admin.fails('DELETE', `${A()}/employees/${ids.jane}`, undefined, 400, /inactive/);
    await admin.post(`${A()}/payroll/${id}/void`);
    assert.equal((await accounts(admin, A())).key('wages').balance, acc0.key('wages').balance);
    await admin.del(`${A()}/payroll/${id}`);
  });
  await t.test('removing payslips from a draft run', async () => {
    const id = (await admin.post(`${A()}/payroll`, { period_start: '2026-10-01', period_end: '2026-10-31', pay_date: '2026-10-31' })).id;
    const run = await admin.get(`${A()}/payroll/${id}`);
    await admin.del(`${A()}/payroll/${id}/payslips/${run.payslips[0].id}`);
    assert.equal((await admin.get(`${A()}/payroll/${id}`)).payslips.length, 1);
    await admin.post(`${A()}/payroll/${id}/post`);
  });
  await assertBooks(admin, ids.acme, 'flat payroll');
});

// ======================================================================
test('14. payroll — Madagascar (CNaPS, OSTIE, FMFP, IRSA)', async (t) => {
  // Independent reference implementation of the published rules (amounts in cents of Ariary).
  const ref = (grossAr, deps, sme, cfg = {}) => {
    const c = { cnaps: [1, 13], health: [1, 5], fmfp: 1, min: 3000, perDep: 2000, ...cfg };
    const gross = Ar(grossAr), capped = Math.min(gross, Ar(sme * 8));
    const pct = (v, r) => Math.round((v * r) / 100);
    const ee = pct(capped, c.cnaps[0]) + pct(capped, c.health[0]);
    const taxable = Math.floor((gross - ee) / 100 / 100) * 100;
    let tax = 0, lo = 0;
    for (const [hi, r] of [[350000, 0], [400000, 5], [500000, 10], [600000, 15], [4000000, 20], [Infinity, 25]]) { if (taxable > lo) tax += ((Math.min(taxable, hi) - lo) * r) / 100; lo = hi; }
    const irsa = Ar(Math.max(c.min, Math.round(tax) - deps * c.perDep));
    const er = pct(capped, c.cnaps[1]) + pct(capped, c.health[1]) + pct(gross, c.fmfp);
    return { social: ee, income_tax: irsa, net: gross - ee - irsa, employer_cost: er, gross };
  };
  const staff = [['Rakoto', 800000, 3], ['Rabe', 5000000, 0], ['Rasoa', 300000, 0], ['Mid', 2450000, 1]];
  await t.test('defaults reflect the October 2026 rules', async () => {
    const d = await admin.get(`${T()}/payroll/defaults`);
    assert.deepEqual(d.sme_history.map((s) => s.amount), [262680, 300000, 315000]);
    assert.equal(d.irsa_brackets.at(-1).rate, 25); assert.equal(d.irsa_minimum, 3000); assert.equal(d.cnaps_employer, 13);
  });
  for (const [name, salary, deps] of staff) await admin.post(`${T()}/employees`, { name, pay_type: 'salary', pay_rate: Ar(salary), dependents: deps, cnaps_number: 'CN-' + name, tax_number: 'NIF-' + name });
  await admin.post(`${T()}/employees`, { name: 'Hourly', pay_type: 'hourly', pay_rate: Ar(2000), dependents: 0 });
  const runFor = async (start, end) => (await admin.post(`${T()}/payroll`, { period_start: start, period_end: end, pay_date: end })).id;
  await t.test('September 2026 (SME 300,000 → ceiling 2,400,000 Ar)', async () => {
    ids.sepRun = await runFor('2026-09-01', '2026-09-30');
    const run = await admin.get(`${T()}/payroll/${ids.sepRun}`);
    for (const [name, salary, deps] of staff) {
      const s = run.payslips.find((p) => p.name === name), e = ref(salary, deps, 300000);
      assert.deepEqual([s.social, s.income_tax, s.net, s.employer_cost], [e.social, e.income_tax, e.net, e.employer_cost], name);
    }
    assert.equal(run.payslips.find((p) => p.name === 'Mid').social, Ar(48000), 'capped at the September ceiling');
  });
  await t.test('October 2026 (SME 315,000 → ceiling 2,520,000 Ar) with published anchors', async () => {
    ids.octRun = await runFor('2026-10-01', '2026-10-31');
    const run = await admin.get(`${T()}/payroll/${ids.octRun}`);
    const slip = (n) => run.payslips.find((p) => p.name === n);
    for (const [name, salary, deps] of staff) {
      const e = ref(salary, deps, 315000), s = slip(name);
      assert.deepEqual([s.social, s.income_tax, s.net, s.employer_cost], [e.social, e.income_tax, e.net, e.employer_cost], name);
    }
    assert.equal(slip('Rakoto').income_tax, Ar(58300)); assert.equal(slip('Rakoto').net, Ar(725700)); assert.equal(slip('Rakoto').employer_cost, Ar(152000));
    assert.equal(slip('Rabe').social, Ar(50400)); assert.equal(slip('Rabe').income_tax, Ar(944900)); assert.equal(slip('Rabe').employer_cost, Ar(503600));
    assert.equal(slip('Rasoa').income_tax, Ar(3000), 'minimum IRSA applies');
    assert.equal(slip('Mid').social, Ar(49000), 'not capped under the October ceiling');
    assert.equal(slip('Hourly').hours, 173.33); assert.equal(slip('Hourly').gross, Math.round(173.33 * Ar(2000)));
    const rak = slip('Rakoto').details;
    assert.deepEqual(rak.map((d) => d.code), ['CNAPS', 'HEALTH', 'FMFP', 'IRSA']);
    assert.equal(rak.find((d) => d.code === 'HEALTH').label, 'OSTIE');
  });
  await t.test('posting splits liabilities by organism; foreign accounts refused', async () => {
    const run = await admin.get(`${T()}/payroll/${ids.octRun}`);
    const sum = (code, side) => run.payslips.reduce((s, p) => s + (p.details.find((d) => d.code === code)[side] || 0), 0);
    const bad = await runFor('2026-08-01', '2026-08-31');
    await admin.put(`${T()}/payroll/${bad}/payslips/${(await admin.get(`${T()}/payroll/${bad}`)).payslips[0].id}`, { bonus: 0 });
    const { run: dbRun } = app.src('db');
    dbRun('UPDATE payroll_runs SET bank_account_id = ? WHERE id = ?', ids.eurBank, bad);
    await admin.fails('POST', `${T()}/payroll/${bad}/post`, {}, 400, /Pay wages from an account in MGA/);
    await admin.del(`${T()}/payroll/${bad}`);
    await admin.post(`${T()}/payroll/${ids.octRun}/post`);
    const acc = await accounts(admin, T());
    assert.equal(acc.key('mg_cnaps').balance, sum('CNAPS', 'employee') + sum('CNAPS', 'employer'));
    assert.equal(acc.key('mg_health').balance, sum('HEALTH', 'employee') + sum('HEALTH', 'employer'));
    assert.equal(acc.key('mg_irsa').balance, sum('IRSA', 'employee'));
    assert.equal(acc.key('mg_fmfp').balance, sum('FMFP', 'employer'));
    assert.equal(acc.key('mg_cnaps').code, '2210');
  });
  await t.test('payroll tax report (declarations)', async () => {
    const r = await admin.get(`${T()}/reports/payroll-taxes?from=2026-10-01&to=2026-10-31`);
    const run = await admin.get(`${T()}/payroll/${ids.octRun}`);
    assert.equal(r.gross, run.totals.gross, 'only the posted October run is included');
    assert.equal(r.lines.find((l) => l.code === 'IRSA').employee, run.payslips.reduce((s, p) => s + p.income_tax, 0));
    assert.equal(r.total, r.lines.reduce((s, l) => s + l.total, 0));
    const rak = r.employees.find((e) => e.name === 'Rakoto');
    assert.equal(rak.cnaps_number, 'CN-Rakoto'); assert.equal(rak.lines.IRSA.employee, Ar(58300));
  });
  await t.test('settings: validation, custom rates, recalculation, reset', async () => {
    const cfg = (await admin.get(T())).payroll;
    await admin.fails('PUT', T(), { payroll_config: { ...cfg, irsa_brackets: [{ upto: 500000, rate: 5 }, { upto: 400000, rate: 10 }] } }, 400, /increasing/);
    await admin.fails('PUT', T(), { payroll_config: { ...cfg, sme_history: [] } }, 400, /SME/);
    await admin.fails('PUT', T(), { payroll_config: { ...cfg, cnaps_employer: -1 } }, 400, /positive/);
    await admin.put(T(), { payroll_config: { ...cfg, irsa_minimum: 2000, health_name: 'AMIT' } });
    await admin.post(`${T()}/payroll/${ids.sepRun}/recalculate`);
    const sep = await admin.get(`${T()}/payroll/${ids.sepRun}`);
    assert.equal(sep.payslips.find((p) => p.name === 'Rasoa').income_tax, Ar(2000));
    assert.equal(sep.payslips[0].details.find((d) => d.code === 'HEALTH').label, 'AMIT');
    const oct = await admin.get(`${T()}/payroll/${ids.octRun}`);
    assert.equal(oct.payslips.find((p) => p.name === 'Rasoa').income_tax, Ar(3000), 'posted runs never change');
    await admin.fails('POST', `${T()}/payroll/${ids.octRun}/recalculate`, {}, 400, /already posted/);
    await admin.put(T(), { payroll_config: await admin.get(`${T()}/payroll/defaults`) });
    assert.equal((await admin.get(T())).payroll.irsa_minimum, 3000);
  });
  await t.test('switching scheme to flat rates', async () => {
    await admin.put(T(), { payroll_scheme: 'flat' });
    await admin.post(`${T()}/payroll/${ids.sepRun}/recalculate`);
    assert.equal((await admin.get(`${T()}/payroll/${ids.sepRun}`)).payslips[0].details, null);
    await admin.put(T(), { payroll_scheme: 'madagascar' });
    await admin.fails('PUT', T(), { payroll_scheme: 'martian' }, 400, /Invalid payroll scheme/);
    await admin.del(`${T()}/payroll/${ids.sepRun}`);
  });
  await assertBooks(admin, ids.tsara, 'madagascar payroll');
});

// ======================================================================
test('15. budgets, reports & dashboard', async (t) => {
  const acc = await accounts(admin, A());
  const year = new Date().getUTCFullYear();
  await t.test('budgets vs actual', async () => {
    await admin.fails('PUT', `${A()}/budgets`, { year: 12, items: [] }, 400, /Invalid year/);
    await admin.put(`${A()}/budgets`, { year, items: [{ account_id: acc.code('6300').id, amount: 50000 }, { account_id: acc.key('sales').id, amount: 1000000 }] });
    const b = await admin.get(`${A()}/budgets?year=${year}`);
    const supplies = b.rows.find((r) => r.code === '6300');
    assert.equal(supplies.budget, 50000);
    assert.equal(supplies.variance, supplies.actual - supplies.budget);
  });
  await t.test('profit & loss, balance sheet, trial balance agree', async () => {
    const pnl = await admin.get(`${A()}/reports/pnl?from=2000-01-01&to=2099-12-31`);
    assert.equal(pnl.netIncome, pnl.totalIncome - pnl.totalCogs - pnl.totalExpenses);
    const bs = await admin.get(`${A()}/reports/balance-sheet?asOf=2099-12-31`);
    assert.equal(bs.earnings, pnl.netIncome);
    const narrow = await admin.get(`${A()}/reports/pnl?from=2026-03-01&to=2026-03-31`);
    assert.equal(narrow.expenses.find((e) => e.code === '6100').balance, 200000, 'March rent only');
  });
  await t.test('general ledger opening/closing balances', async () => {
    const bank = acc.key('bank').id;
    const full = await admin.get(`${A()}/reports/ledger?account_id=${bank}`);
    const part = await admin.get(`${A()}/reports/ledger?account_id=${bank}&from=2026-03-06`);
    assert.equal(full.closing, (await accounts(admin, A())).byId(bank).balance);
    assert.equal(part.closing, full.closing);
    assert.equal(part.opening, full.lines.filter((l) => l.date < '2026-03-06').reduce((s, l) => s + l.debit - l.credit, 0));
    assert.equal(full.lines.at(-1).balance, full.closing);
    await admin.fails('GET', `${A()}/reports/ledger?account_id=999999`, undefined, 404);
  });
  await t.test('aging buckets, cash-flow series, sales tax', async () => {
    for (const kind of ['invoice', 'bill']) {
      const a = await admin.get(`${A()}/reports/aging?kind=${kind}`);
      assert.equal(Object.values(a.totals).reduce((s, v) => s + v, 0), a.total);
    }
    assert.equal((await admin.get(`${A()}/reports/cashflow?months=24`)).length, 24);
    assert.equal((await admin.get(`${A()}/reports/cashflow?months=99`)).length, 36);
    const tax = await admin.get(`${A()}/reports/tax?from=2000-01-01&to=2099-12-31`);
    assert.equal(tax.net, tax.collected - tax.paid);
  });
  await t.test('dashboard & portfolio summaries', async () => {
    const d = await admin.get(`${A()}/dashboard`);
    assert.equal(d.series.length, 12);
    for (const k of ['cash', 'ar', 'ap', 'ytdNet', 'mtdNet', 'employees', 'stockValue', 'lowStock']) assert.ok(k in d.summary, k);
    const today = daysFromToday(0);
    let cash = 0; // as of today: the October pay run is dated later in the month
    for (const a of (await accounts(admin, A())).list.filter((x) => x.is_bank && x.type === 'asset')) cash += (await admin.get(`${A()}/reports/ledger?account_id=${a.id}&to=${today}`)).closing;
    assert.equal(d.summary.cash, cash);
    assert.equal(d.summary.employees, 2);
  });
  await assertBooks(admin, ids.acme, 'final Acme');
  await assertBooks(admin, ids.tsara, 'final Tsara');
});

// ======================================================================
test('16. lifecycle: sole owners & organisation deletion', async (t) => {
  await t.test('an admin cannot delete the only owner of an organisation', async () => {
    const carol = await new Client(app.base, { ip: '10.0.3.1' }).login('carol@ledgerly.test', PW);
    const own = (await carol.post('/api/orgs', { name: 'Carol Co', currency: 'EUR' })).id;
    await admin.fails('DELETE', `/api/admin/users/${ids.carol}`, undefined, 400, /only owner of Carol Co/);
    await carol.post(`/api/orgs/${own}/members`, { email: 'ada@ledgerly.test', role: 'owner' });
    await admin.del(`/api/admin/users/${ids.carol}`);
    assert.ok(!(await admin.get(`${A()}/members`)).some((m) => m.email === 'carol@ledgerly.test'));
  });
  await t.test('deleting an organisation removes every related row', async () => {
    const dave = await new Client(app.base, { ip: '10.0.3.2' }).login('dave@ledgerly.test', PW);
    await dave.fails('DELETE', A(), { confirm: 'Acme Corp' }, 403);
    await admin.fails('DELETE', T(), { confirm: 'tsara' }, 400, /Type the organisation name/);
    await admin.del(T(), { confirm: 'Tsara Vanille' });
    await admin.fails('GET', T(), undefined, 404);
    const { get, all } = app.src('db');
    for (const table of ['accounts', 'journal_entries', 'documents', 'contacts', 'products', 'stock_moves', 'payments', 'employees', 'payroll_runs', 'recurring_invoices', 'exchange_rates', 'email_log', 'budgets', 'memberships'])
      assert.equal(get(`SELECT COUNT(*) n FROM ${table} WHERE org_id = ?`, ids.tsara).n, 0, `${table} rows left behind`);
    assert.equal(all('PRAGMA foreign_key_check').length, 0);
    await assertBooks(admin, ids.acme, 'Acme unaffected');
  });
});
