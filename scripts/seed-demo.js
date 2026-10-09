'use strict';
// Seeds a demo user with two organisations full of realistic data.
// Usage: npm run demo   (then sign in as demo@ledgerly.local / demo12345)
const http = require('node:http');
const { handle } = require('../src/server');
const { get } = require('../src/db');

const EMAIL = 'demo@ledgerly.local', PASSWORD = 'demo12345';
const srv = http.createServer(handle).listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${srv.address().port}`;
  let cookie = '';
  const api = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ledgerly', cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const j = await r.json();
    if (!r.ok) throw new Error(`${method} ${url}: ${j.error}`);
    return j;
  };
  try {
    if (get('SELECT 1 FROM users WHERE email = ?', EMAIL)) await api('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });
    else if (get('SELECT COUNT(*) n FROM users').n === 0) await api('POST', '/api/auth/register', { name: 'Demo Admin', email: EMAIL, password: PASSWORD });
    else throw new Error('Instance already has users. Run the demo against an empty DATA_DIR, e.g. DATA_DIR=./demo-data npm run demo');

    const d = (monthsAgo, day) => { const t = new Date(); t.setUTCDate(1); t.setUTCMonth(t.getUTCMonth() - monthsAgo); t.setUTCDate(day); const iso = t.toISOString().slice(0, 10); const now = new Date().toISOString().slice(0, 10); return iso > now ? now : iso; };
    const rnd = (a, b) => Math.round(a + Math.random() * (b - a));

    const configs = [
      { name: 'Northwind Studio', currency: 'USD', tax: 8, staff: [['Ava Chen', 'Lead Designer', 620000], ['Leo Martins', 'Developer', 540000], ['Mia Okafor', 'Project Manager', 480000]], hourly: [['Sam Patel', 'Intern', 2200]], service: 'Design sprint', qty: [3, 7], price: [150000, 300000] },
      { name: 'Bluefin Café', currency: 'EUR', tax: 20, staff: [['Chloé Durand', 'Manager', 310000]], hourly: [['Hugo Bernard', 'Barista', 1450], ['Inès Moreau', 'Barista', 1450]], service: 'Catering service', qty: [1, 5], price: [80000, 260000] },
    ];
    for (const cfg of configs) {
      const { id } = await api('POST', '/api/orgs', { name: cfg.name, currency: cfg.currency, default_tax_rate: cfg.tax });
      const o = `/api/orgs/${id}`;
      const slug = cfg.name.toLowerCase().replace(/\W/g, '');
      await api('PUT', o, { legal_name: cfg.name + ' LLC', address: '42 Harbour Street\nSpringfield', email: `hello@${slug}.example`, invoice_footer: 'Thank you for your business!\nPayment by bank transfer within 30 days.' });
      const accts = await api('GET', `${o}/accounts`);
      const A = (code) => accts.find((a) => a.code === code).id;
      const bank = A('1010');
      await api('POST', `${o}/bank/transactions`, { account_id: bank, category_id: A('3000'), direction: 'in', amount: 5000000, date: d(12, 1), description: 'Opening capital' });

      const customers = [];
      for (const n of ['Globex Corp', 'Initech', 'Umbrella Health', 'Stark Retail', 'Wayne Foundation'])
        customers.push((await api('POST', `${o}/contacts`, { name: n, kind: 'customer', email: `ap@${n.toLowerCase().replace(/\W/g, '')}.example` })).id);
      const vendors = {};
      for (const [n, code] of [['City Properties', '6100'], ['PowerGrid Utilities', '6200'], ['CloudSoft', '6400'], ['AdReach Media', '6500'], ['Office Depot', '6300']])
        vendors[code] = (await api('POST', `${o}/contacts`, { name: n, kind: 'vendor' })).id;

      for (const [name, position, rate] of cfg.staff)
        await api('POST', `${o}/employees`, { name, position, department: 'Operations', pay_type: 'salary', pay_rate: rate, income_tax_rate: 18, social_rate: 7.5, employer_rate: 12, start_date: d(14, 1) });
      for (const [name, position, rate] of cfg.hourly)
        await api('POST', `${o}/employees`, { name, position, department: 'Operations', pay_type: 'hourly', pay_rate: rate, income_tax_rate: 10, social_rate: 7.5, employer_rate: 12, start_date: d(10, 1) });

      for (let m = 11; m >= 0; m--) {
        // Sales
        const n = rnd(2, 4);
        for (let k = 0; k < n; k++) {
          const issue = d(m, rnd(1, 25));
          const inv = await api('POST', `${o}/invoices`, {
            contact_id: customers[rnd(0, customers.length - 1)], issue_date: issue, finalize: true,
            items: [
              { description: cfg.service, quantity: rnd(...cfg.qty), unit_price: rnd(...cfg.price), tax_rate: cfg.tax, account_id: A('4100') },
              { description: 'Materials', quantity: 1, unit_price: rnd(5000, 40000), tax_rate: cfg.tax, account_id: A('4000') },
            ],
          });
          const doc = await api('GET', `${o}/invoices/${inv.id}`);
          if (m >= 2 || Math.random() < 0.4) await api('POST', `${o}/invoices/${inv.id}/payments`, { amount: doc.total, account_id: bank, date: m > 0 ? d(m - 1, rnd(1, 20)) : issue, method: 'Bank transfer' });
          else if (Math.random() < 0.5) await api('POST', `${o}/invoices/${inv.id}/payments`, { amount: Math.round(doc.total / 2), account_id: bank, date: issue, method: 'Card' });
        }
        // Recurring bills
        for (const [code, lo, hi] of [['6100', 300000, 300000], ['6200', 25000, 60000], ['6400', 12000, 30000], ['6500', 20000, 120000], ['6300', 5000, 25000]]) {
          const bill = await api('POST', `${o}/bills`, { contact_id: vendors[code], issue_date: d(m, 3), reference: 'Monthly', finalize: true,
            items: [{ description: 'Monthly charge', quantity: 1, unit_price: rnd(lo, hi), tax_rate: cfg.tax, account_id: A(code) }] });
          const doc = await api('GET', `${o}/bills/${bill.id}`);
          if (m > 0) await api('POST', `${o}/bills/${bill.id}/payments`, { amount: doc.total, account_id: bank, date: d(m, 15), method: 'Bank transfer' });
        }
        await api('POST', `${o}/bank/transactions`, { account_id: bank, category_id: A('6700'), direction: 'out', amount: rnd(1500, 4000), date: d(m, 28), description: 'Bank fees' });
        // Payroll: post every past month, leave the current month as a draft
        const end = new Date(d(m, 1) + 'T00:00:00Z'); end.setUTCMonth(end.getUTCMonth() + 1); end.setUTCDate(0);
        const endIso = end.toISOString().slice(0, 10);
        const run = await api('POST', `${o}/payroll`, { period_start: d(m, 1), period_end: endIso, pay_date: endIso, bank_account_id: bank });
        if (m > 0) await api('POST', `${o}/payroll/${run.id}/post`);
      }
      await api('POST', `${o}/invoices`, { contact_id: customers[0], issue_date: d(0, 2), items: [{ description: 'Retainer — next month', quantity: 1, unit_price: 450000, tax_rate: cfg.tax, account_id: A('4100') }] });
      const year = new Date().getFullYear();
      await api('PUT', `${o}/budgets`, { year, items: [['4100', 9000000], ['4000', 600000], ['6100', 3600000], ['6200', 500000], ['6400', 300000], ['6500', 700000], ['6000', 7000000]].map(([c, amount]) => ({ account_id: A(c), amount })) });
      console.log(`Seeded ${cfg.name}`);
    }
    console.log(`\nDemo ready. Sign in as ${EMAIL} / ${PASSWORD}`);
  } catch (e) { console.error(e.message); process.exitCode = 1; }
  srv.close(); setTimeout(() => process.exit(), 50);
});
