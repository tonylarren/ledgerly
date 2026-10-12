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
    await seedMadagascar(api, d, rnd);
    console.log(`\nDemo ready. Sign in as ${EMAIL} / ${PASSWORD}`);
  } catch (e) { console.error(e.message); process.exitCode = 1; }
  srv.close(); setTimeout(() => process.exit(), 50);
});

// A Malagasy vanilla exporter: MGA books, EUR/USD sales, stock, bank fees, Madagascar payroll, recurring invoice.
async function seedMadagascar(api, d, rnd) {
  const Ar = (n) => Math.round(n * 100);
  const { id } = await api('POST', '/api/orgs', { name: 'Tsara Vanille SARL', currency: 'MGA', default_tax_rate: 20 });
  const o = `/api/orgs/${id}`;
  await api('PUT', o, { legal_name: 'Tsara Vanille SARL', address: 'Lot IVG 204 Antanimena\n101 Antananarivo\nMadagascar', email: 'contact@tsara-vanille.example',
    phone: '+261 34 00 000 00', tax_id: 'NIF 4001234567 · STAT 46101 11 2019 0 00123', locale: 'fr-MG',
    invoice_footer: 'BOA Madagascar — RIB 00009 05000 12345678901 23\nMVola: 034 00 000 00\nMerci pour votre confiance.' });
  // Monthly exchange rates (base MGA per 1 unit)
  for (let m = 13; m >= 0; m--) {
    const date = d(m, 1);
    await api('POST', `${o}/rates`, { currency: 'EUR', date, rate: 4950 + (13 - m) * 18 + rnd(-40, 40) });
    await api('POST', `${o}/rates`, { currency: 'USD', date, rate: 4480 + (13 - m) * 12 + rnd(-30, 30) });
  }
  let accts = await api('GET', `${o}/accounts`);
  const A = (code) => accts.find((a) => a.code === code).id;
  const boa = A('1010');
  await api('PUT', `${o}/accounts/${boa}`, { name: 'BOA Madagascar (MGA)', fee_fixed: Ar(2000), monthly_fee: Ar(15000), monthly_fee_day: 1 });
  const eurAcc = (await api('POST', `${o}/accounts`, { code: '1030', name: 'BNI Madagascar (EUR)', type: 'asset', subtype: 'current', is_bank: true, currency: 'EUR', fee_fixed: 1500, fee_percent: 0.2 })).id;
  const mvola = (await api('POST', `${o}/accounts`, { code: '1040', name: 'MVola', type: 'asset', subtype: 'current', is_bank: true, fee_percent: 1 })).id;
  accts = await api('GET', `${o}/accounts`);
  await api('POST', `${o}/bank/transactions`, { account_id: boa, category_id: A('3000'), direction: 'in', amount: Ar(250000000), date: d(13, 2), description: 'Apport en capital' });
  await api('POST', `${o}/bank/transfer`, { from_id: boa, to_id: mvola, amount: Ar(2000000), date: d(13, 3), description: 'Approvisionnement MVola' });

  const product = async (p) => (await api('POST', `${o}/products`, p)).id;
  const vanilla = await product({ name: 'Vanille Bourbon gousses noires 1kg', sku: 'VAN-BLK', kind: 'inventory', unit: 'kg', sale_price: Ar(950000), purchase_price: Ar(420000), reorder_level: 40 });
  const cloves = await product({ name: 'Clous de girofle 1kg', sku: 'GIR-01', kind: 'inventory', unit: 'kg', sale_price: Ar(42000), purchase_price: Ar(18000), reorder_level: 200 });
  const pepper = await product({ name: 'Poivre sauvage voatsiperifery 1kg', sku: 'POI-VS', kind: 'inventory', unit: 'kg', sale_price: Ar(180000), purchase_price: Ar(85000), reorder_level: 20 });
  const logistics = await product({ name: 'Logistique export & phytosanitaire', sku: 'SRV-LOG', kind: 'service', sale_price: Ar(1200000) });

  const contact = async (c) => (await api('POST', `${o}/contacts`, c)).id;
  const eu = [await contact({ name: 'Épices de Provence SAS', kind: 'customer', email: 'compta@epices-provence.example', address: '12 rue des Arômes\n13001 Marseille, France' }),
    await contact({ name: 'Hamburg Gewürz GmbH', kind: 'customer', email: 'ap@hamburg-gewuerz.example', address: 'Speicherstadt 4\n20457 Hamburg' })];
  const us = await contact({ name: 'Brooklyn Pastry Supply', kind: 'customer', email: 'billing@bkpastry.example', address: '220 Kent Ave\nBrooklyn, NY' });
  const local = await contact({ name: 'Hôtel Colbert Antananarivo', kind: 'customer', email: 'achats@colbert.example' });
  const growers = await contact({ name: 'Coopérative Sava Vanille', kind: 'vendor', address: 'Sambava, SAVA' });
  const spices = await contact({ name: 'Collecteurs Analanjirofo', kind: 'vendor' });
  const jirama = await contact({ name: 'JIRAMA', kind: 'vendor' });
  const telma = await contact({ name: 'Telma', kind: 'vendor' });

  for (const [name, position, salary, deps] of [['Rakotomalala Hery', 'Directeur', 4800000, 2], ['Randrianarisoa Fara', 'Comptable', 1600000, 1],
    ['Rasolofonirina Tiana', 'Responsable qualité', 1200000, 3], ['Andriamanana Lova', 'Magasinier', 450000, 2], ['Razafindrabe Noro', 'Trieuse', 320000, 1]]) {
    await api('POST', `${o}/employees`, { name, position, department: name.includes('Hery') ? 'Direction' : 'Opérations', pay_type: 'salary', pay_rate: Ar(salary), dependents: deps,
      cnaps_number: `${rnd(100000, 999999)}${rnd(10, 99)}`, start_date: d(30, 1), bank_details: `MVola 034 ${rnd(10, 99)} ${rnd(100, 999)} ${rnd(10, 99)}` });
  }

  for (let m = 11; m >= 0; m--) {
    // Purchases from growers (MGA) — stock comes in
    await api('POST', `${o}/bank/transfer`, { from_id: boa, to_id: mvola, amount: Ar(3000000), fee: Ar(2000), date: d(m, 3), description: 'Approvisionnement MVola' });
    for (const [vendor, prod, qty, price, viaMvola] of [[growers, vanilla, rnd(60, 110), rnd(400000, 450000)], [spices, cloves, rnd(300, 600), rnd(16000, 20000)], [spices, pepper, rnd(20, 30), rnd(80000, 90000), true]]) {
      const b = await api('POST', `${o}/bills`, { contact_id: vendor, issue_date: d(m, 4), items: [{ description: 'Achat collecte', product_id: prod, quantity: qty, unit_price: Ar(price), tax_rate: 0 }], finalize: true });
      const doc = await api('GET', `${o}/bills/${b.id}`);
      await api('POST', `${o}/bills/${b.id}/payments`, { amount: doc.total, account_id: viaMvola ? mvola : boa, date: d(m, 8), fee: viaMvola ? Math.round(doc.total * 0.01) : Ar(2000), method: viaMvola ? 'Mobile money (MVola / Orange Money / Airtel)' : 'Bank transfer' });
    }
    // Export sales in EUR, paid into the EUR account with bank fees
    const eurInv = await api('POST', `${o}/invoices`, { contact_id: eu[m % 2], currency: 'EUR', issue_date: d(m, 12), finalize: true, items: [
      { description: 'Vanille Bourbon gousses noires 1kg', product_id: vanilla, quantity: rnd(40, 70), unit_price: rnd(17500, 19500), tax_rate: 0 },
      { description: 'Clous de girofle 1kg', product_id: cloves, quantity: rnd(200, 400), unit_price: rnd(700, 850), tax_rate: 0 },
      { description: 'Logistique export & phytosanitaire', product_id: logistics, quantity: 1, unit_price: 25000, tax_rate: 0 }] });
    if (m >= 1) {
      const doc = await api('GET', `${o}/invoices/${eurInv.id}`);
      await api('POST', `${o}/invoices/${eurInv.id}/payments`, { amount: doc.total, account_id: eurAcc, date: d(m - 1, 2), fee: 1500 + Math.round(doc.total * 0.002), method: 'Bank transfer' });
    }
    // Quarterly USD order
    if (m % 3 === 0) {
      const usInv = await api('POST', `${o}/invoices`, { contact_id: us, currency: 'USD', issue_date: d(m, 18), finalize: true, items: [
        { description: 'Vanille Bourbon gousses noires 1kg', product_id: vanilla, quantity: rnd(15, 30), unit_price: rnd(20000, 23000), tax_rate: 0 },
        { description: 'Poivre sauvage voatsiperifery 1kg', product_id: pepper, quantity: rnd(10, 20), unit_price: rnd(4500, 5200), tax_rate: 0 }] });
      if (m >= 3) {
        const doc = await api('GET', `${o}/invoices/${usInv.id}`);
        await api('POST', `${o}/invoices/${usInv.id}/payments`, { amount: doc.total, account_id: boa, date: d(m - 1, 20), fee: Ar(35000), method: 'Bank transfer' });
      }
    }
    // Convert some EUR to Ariary for local costs
    if (m >= 1 && m % 2 === 0) await api('POST', `${o}/bank/transfer`, { from_id: eurAcc, to_id: boa, amount: 1500000, to_amount: Ar(15000 * (5000 + rnd(0, 150))), fee: 2500, date: d(m, 25), description: 'Conversion EUR → MGA' });
    // Utilities & telecom (local bills with 20% VAT)
    for (const [vendor, code, lo, hi] of [[jirama, '6200', 350000, 600000], [telma, '6400', 150000, 250000]]) {
      const b = await api('POST', `${o}/bills`, { contact_id: vendor, issue_date: d(m, 6), items: [{ description: 'Facture mensuelle', quantity: 1, unit_price: Ar(rnd(lo, hi)), tax_rate: 20, account_id: A(code) }], finalize: true });
      if (m > 0) { const doc = await api('GET', `${o}/bills/${b.id}`); await api('POST', `${o}/bills/${b.id}/payments`, { amount: doc.total, account_id: boa, date: d(m, 20), fee: Ar(2000) }); }
    }
    if (m > 0) await api('POST', `${o}/bank/transactions`, { account_id: boa, category_id: A('6700'), direction: 'out', amount: Ar(15000), date: d(m, 1), description: 'Frais de tenue de compte' });
    // Madagascar payroll
    const end = new Date(d(m, 1) + 'T00:00:00Z'); end.setUTCMonth(end.getUTCMonth() + 1); end.setUTCDate(0);
    const endIso = end.toISOString().slice(0, 10), now = new Date().toISOString().slice(0, 10);
    const run = await api('POST', `${o}/payroll`, { period_start: d(m, 1), period_end: endIso, pay_date: endIso > now ? now : endIso, bank_account_id: boa });
    if (m > 0) await api('POST', `${o}/payroll/${run.id}/post`);
  }
  // Recurring warehouse rental to a local customer, monthly in MGA
  await api('POST', `${o}/recurring`, { name: 'Location entrepôt Ivato', contact_id: local, currency: 'MGA', frequency: 'monthly', start_date: d(1, 1),
    items: [{ description: 'Location entrepôt sec 200 m² — Ivato', quantity: 1, unit_price: Ar(2500000), tax_rate: 20 }], auto_finalize: true, auto_email: false });
  await api('POST', `${o}/recurring`, { name: 'Abonnement épices — Hamburg', contact_id: eu[1], currency: 'EUR', frequency: 'quarterly', start_date: d(-1, 15),
    items: [{ description: 'Coffret dégustation épices (x50)', product_id: pepper, quantity: 5, unit_price: 5000, tax_rate: 0 }], auto_finalize: true, auto_email: false });
  // Budget
  const year = new Date().getFullYear();
  await api('PUT', `${o}/budgets`, { year, items: [['4000', 900000000], ['6000', 120000000], ['6200', 6000000], ['6700', 1500000]].map(([c, amount]) => ({ account_id: A(c), amount: Ar(amount) })) });
  console.log('Seeded Tsara Vanille SARL (MGA)');
}
