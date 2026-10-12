'use strict';
// End-to-end UI suite: drives a real headless Chrome/Edge through Ledgerly's screens using the
// DevTools protocol (no Playwright/Puppeteer — Node's built-in WebSocket). Skipped if no browser is found.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { startApp, Client, fakeSmtp, parseMail, assertBooks } = require('./helpers');

const BROWSERS = [
  process.env.CHROME_PATH,
  // Chrome first: a running desktop Edge can absorb a new msedge.exe launch, which then exits immediately.
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
].filter(Boolean);
const FOUND = BROWSERS.filter((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
const skip = FOUND.length ? false : 'no Chrome/Edge/Chromium found — set CHROME_PATH to run the UI suite';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').replace(/[\s\u00a0\u202f]/g, '');
const PW = 'ui-test-pass-1';

// ---------- minimal DevTools protocol client ----------
class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = {};
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? p.reject(new Error(`${p.method}: ${m.error.message}`)) : p.resolve(m.result);
      } else if (m.method && this.handlers[m.method]) this.handlers[m.method].forEach((fn) => fn(m.params));
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }
  on(method, fn) { (this.handlers[method] = this.handlers[method] || []).push(fn); }
}

// Try each installed browser until one exposes a DevTools endpoint.
async function launchBrowser() {
  const problems = [];
  for (const exe of FOUND) {
    try { return await launch(exe); } catch (e) { problems.push(`${path.basename(exe)}: ${e.message}`); }
  }
  throw new Error('Could not start a headless browser — ' + problems.join('; '));
}

async function launch(exe) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-ui-'));
  const proc = spawn(exe, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--disable-extensions', '--disable-sync', '--window-size=1440,900', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('Browser did not start within 30 s')), 30000);
    proc.stderr.on('data', (d) => { buf += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf); if (m) { clearTimeout(timer); resolve(m[1]); } });
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`exited early (code ${code})`)); });
  });
  const { port } = new URL(wsUrl);
  let target;
  for (let i = 0; i < 50 && !target; i++) { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page'); if (!target) await sleep(100); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('Could not connect to the browser')); });
  return {
    cdp: new Cdp(ws),
    close: async () => { try { ws.close(); } catch { /* closed */ } proc.kill(); await sleep(300); try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 }); } catch { /* locked on Windows */ } },
  };
}

// ---------- page driver ----------
class Page {
  constructor(cdp, base) {
    this.cdp = cdp; this.base = base; this.errors = [];
    cdp.on('Runtime.exceptionThrown', (p) => this.errors.push(p.exceptionDetails.exception?.description || p.exceptionDetails.text));
    cdp.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error') this.errors.push(p.args.map((a) => a.value ?? a.description).join(' ')); });
  }
  async init() { await this.cdp.send('Runtime.enable'); await this.cdp.send('Page.enable'); }
  async eval(expr) {
    const r = await this.cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`In page: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result.value;
  }
  async waitFor(expr, what = expr, timeout = 10000) {
    const end = Date.now() + timeout; let last = '';
    while (Date.now() < end) {
      try { const v = await this.eval(expr); if (v) return v; } catch (e) { last = e.message; }
      await sleep(40);
    }
    const toast = await this.eval(`[...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | ')`).catch(() => '');
    throw new Error(`Timed out waiting for: ${what}${last ? ` (${last})` : ''}${toast ? ` — toasts: ${toast}` : ''}`);
  }
  // Run an action that re-renders the page, then wait for the fresh render.
  async rendered(action, expectH1) {
    await this.eval(`document.querySelectorAll('.content, .auth, .print-page').forEach((e) => e.setAttribute('data-stale', '1')); true`);
    await action();
    await this.waitFor(`!!document.querySelector('.content:not([data-stale]), .auth:not([data-stale]), .print-page:not([data-stale])')`, `render after action (expecting ${expectH1})`);
    const h1 = await this.eval(`(document.querySelector('h1') || {}).textContent || ''`);
    if (/Something went wrong|Page not found/.test(h1)) throw new Error(`Error page: ${await this.eval(`document.querySelector('.content').innerText`)}`);
    if (expectH1) assert.match(h1, expectH1);
    return h1;
  }
  async open(url) { await this.cdp.send('Page.navigate', { url: this.base + url }); await this.waitFor(`document.readyState === 'complete' && typeof router === 'function' && !document.querySelector('.boot')`, 'app boot'); }
  go(hash, expectH1) {
    return this.rendered(() => this.eval(`location.hash === ${JSON.stringify(hash)} ? router() : (location.hash = ${JSON.stringify(hash)}); true`), expectH1);
  }
  hash() { return this.eval('location.hash'); }
  click(sel) { return this.eval(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error('No element ${sel.replace(/'/g, '')}'); el.click(); return true; })()`); }
  exists(sel) { return this.eval(`!!document.querySelector(${JSON.stringify(sel)})`); }
  text(sel = '.content') { return this.eval(`(document.querySelector(${JSON.stringify(sel)}) || {}).innerText || ''`); }
  fill(sel, value) {
    return this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) throw new Error('No field ' + ${JSON.stringify(sel)});
      if (el.type === 'checkbox' || el.type === 'radio') el.checked = ${JSON.stringify(!!value)};
      else {
        const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(String(value))});
        if (el.tagName === 'SELECT' && el.value !== ${JSON.stringify(String(value))}) throw new Error('No option ' + ${JSON.stringify(String(value))} + ' in ' + ${JSON.stringify(sel)});
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
  }
  async selectText(sel, label) {
    const v = await this.eval(`(() => { const o = [...document.querySelectorAll(${JSON.stringify(sel + ' option')})].find((o) => o.textContent.includes(${JSON.stringify(label)})); return o ? o.value : null; })()`);
    if (v == null) throw new Error(`No option containing "${label}" in ${sel}`);
    await this.fill(sel, v);
  }
  // Open a modal with a click, fill named fields, submit, and wait for it to close.
  async modal(openSel, fields = {}, { before } = {}) {
    await this.click(openSel);
    await this.waitFor(`!!document.querySelector('#modal-root form')`, `modal from ${openSel}`);
    if (before) await before();
    for (const [name, value] of Object.entries(fields)) await this.fill(`#modal-root [name="${name}"]`, value);
    await this.submitModal();
  }
  async submitModal() {
    await this.eval(`document.querySelector('#modal-root form').requestSubmit(); true`);
    await this.waitFor(`!document.querySelector('#modal-root form') || !!document.querySelector('#modal-root .err:not(.hidden)')`, 'modal to close');
    const err = await this.eval(`(document.querySelector('#modal-root .err:not(.hidden)') || {}).textContent || ''`);
    if (err) throw new Error(`Modal error: ${err}`);
  }
  // Every visible button must actually be visible: icons collapsing to 0×0 once hid sign-out and dialog close buttons.
  async assertControlsVisible(label) {
    const bad = await this.eval(`[...document.querySelectorAll('.icon-btn, .btn')].filter((e) => e.checkVisibility())
      .filter((e) => { const r = (e.querySelector('svg') || e).getBoundingClientRect(); return r.width < 8 || r.height < 8; })
      .map((e) => e.outerHTML.slice(0, 90))`);
    assert.deepEqual(bad, [], `${label}: controls rendered without a visible size`);
  }
  // Click like a person: a real mouse event at the element's centre, which fails if it is hidden or covered.
  async mouseClick(sel) {
    const p = await this.eval(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2; const hit = document.elementFromPoint(x, y);
      return { x, y, w: r.width, h: r.height, ok: !!hit && (hit === el || el.contains(hit)), inView: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth }; })()`);
    assert.ok(p, `${sel} not found`);
    assert.ok(p.w >= 12 && p.h >= 12, `${sel} is too small to see (${p.w}×${p.h})`);
    assert.ok(p.inView, `${sel} is outside the visible window`);
    assert.ok(p.ok, `${sel} is covered by another element`);
    for (const type of ['mousePressed', 'mouseReleased']) await this.cdp.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
  }
  async errorToast() { return this.eval(`[...document.querySelectorAll('.toast.error')].map((t) => t.textContent).join(' | ')`); }
  async assertClean(label) {
    const errs = this.errors.splice(0);
    const toast = await this.errorToast();
    assert.deepEqual(errs, [], `${label}: JavaScript errors in the page`);
    assert.equal(toast, '', `${label}: error toast shown`);
  }
}

// ---------- suite ----------
let app, smtp, browser, page, api;
const ids = {};
before(async () => {
  if (skip) return;
  smtp = await fakeSmtp();
  app = await startApp();
  browser = await launchBrowser();
  page = new Page(browser.cdp, app.base);
  await page.init();
  await browser.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
});
after(async () => {
  await browser?.close(); await app?.close(); await smtp?.close();
});
const O = () => `/api/orgs/${ids.org}`;
const oh = (p) => `#/o/${ids.org}${p}`;

test('UI 1. first-run setup and organisation creation', { skip }, async () => {
  await page.open('/');
  await page.waitFor(`!!document.querySelector('#auth-form')`, 'setup form');
  assert.match(await page.text('#auth-form'), /Create the administrator account/);
  await page.fill('#auth-form [name=name]', 'Ui Admin');
  await page.fill('#auth-form [name=email]', 'admin@ui.test');
  await page.fill('#auth-form [name=password]', PW);
  await page.rendered(() => page.eval(`document.querySelector('#auth-form').requestSubmit(); true`), /All organisations/);
  assert.match(await page.text(), /No organisations yet/);
  await page.rendered(() => page.modal('[data-act=newOrg]', { name: 'UI Vanille SARL', currency: 'MGA', default_tax_rate: 20 }), /UI Vanille SARL/);
  ids.org = +/#\/o\/(\d+)\//.exec(await page.hash())[1];
  api = await new Client(app.base).login('admin@ui.test', PW);
  const org = await api.get(O());
  assert.equal(org.currency, 'MGA'); assert.equal(org.payroll_scheme, 'madagascar'); assert.equal(org.locale, 'fr-MG');
  await page.assertClean('setup');
});

test('UI 2. contacts, exchange rates and products', { skip }, async () => {
  await page.go(oh('/contacts'), /Contacts/);
  await page.rendered(() => page.modal('[data-act=add]', { name: 'Paris Import SA', kind: 'customer', email: 'compta@paris.test', address: '12 rue des Arômes' }), /Contacts/);
  await page.rendered(() => page.modal('[data-act=add]', { name: 'Sava Growers', kind: 'vendor' }), /Contacts/);
  assert.match(await page.text(), /Paris Import SA[\s\S]*Sava Growers/);

  await page.go(oh('/settings/currencies'), /Settings/);
  assert.match(await page.text(), /No rate yet/);
  await page.rendered(() => page.modal('[data-act=addRate][data-cur=EUR]', { date: '2026-01-01', rate: 5000 }), /Settings/);
  await page.rendered(() => page.modal('[data-act=addRate][data-cur=USD]', { date: '2026-01-01', inverse: 0.0002 }), /Settings/);
  const rates = (await api.get(`${O()}/rates`)).rates;
  assert.equal(rates.find((r) => r.currency === 'EUR').rate, 5000);
  assert.equal(rates.find((r) => r.currency === 'USD').rate, 5000, 'inverse field converts 1 MGA = 0.0002 USD into 5000');

  await page.go(oh('/products'), /Products & stock/);
  await page.rendered(() => page.modal('[data-act=add]', { name: 'Vanille 1kg', sku: 'VAN', kind: 'inventory', unit: 'kg', sale_price: 900000, purchase_price: 400000, reorder_level: 5, opening_qty: 50 }), /Vanille 1kg/);
  ids.product = +/products\/(\d+)/.exec(await page.hash())[1];
  assert.match(norm(await page.text()), /50kg/);
  await page.rendered(() => page.modal('[data-act=adjust]', { qty: -2, note: 'Damaged' }), /Vanille 1kg/);
  assert.equal((await api.get(`${O()}/products/${ids.product}`)).qty, 48);
  await page.assertClean('contacts/rates/products');
});

test('UI 3. bill and EUR invoice through the document editor', { skip }, async () => {
  await page.go(oh('/bills/new'), /New bill/);
  await page.selectText('#doc-form [name=contact_id]', 'Sava Growers');
  await page.fill('#items-root tbody tr:nth-child(1) [name=product_id]', ids.product);
  assert.equal(await page.eval(`document.querySelector('#items-root [name=unit_price]').value`), '400000', 'purchase cost prefilled');
  assert.equal(await page.eval(`document.querySelector('#items-root [name=account_id]').disabled`), true, 'stock lines post to Inventory');
  await page.fill('#items-root tbody tr:nth-child(1) [name=quantity]', 20);
  await page.fill('#items-root tbody tr:nth-child(1) [name=tax_rate]', 0);
  await page.rendered(() => page.click('#doc-form button[value=final]'), /^Bill BILL-0001/);
  assert.equal((await api.get(`${O()}/products/${ids.product}`)).qty, 68);

  await page.go(oh('/invoices/new'), /New invoice/);
  await page.selectText('#doc-form [name=contact_id]', 'Paris Import');
  await page.fill('#doc-form [name=currency]', 'EUR');
  await page.waitFor(`document.querySelector('#doc-form [name=exchange_rate]').value === '5000'`, 'EUR rate lookup');
  await page.fill('#items-root tbody tr:nth-child(1) [name=product_id]', ids.product);
  assert.equal(await page.eval(`document.querySelector('#items-root [name=unit_price]').value`), '180', 'sale price converted to EUR');
  assert.match(await page.text('#items-root .stock-hint'), /68\s*kg in stock/);
  await page.fill('#items-root tbody tr:nth-child(1) [name=quantity]', 10);
  await page.fill('#items-root tbody tr:nth-child(1) [name=tax_rate]', 0);
  await page.click('#items-root .add-line');
  await page.fill('#items-root tbody tr:nth-child(2) [name=description]', 'Phytosanitary certificate');
  await page.fill('#items-root tbody tr:nth-child(2) [name=unit_price]', 50);
  await page.fill('#items-root tbody tr:nth-child(2) [name=tax_rate]', 0);
  assert.match(norm(await page.text('#items-root .t-total')), /1850,00€/);
  assert.match(norm(await page.text('#items-root .t-base')), /9250000Ar/);
  await page.rendered(() => page.click('#doc-form button[value=final]'), /^Invoice INV-0001/);
  ids.invoice = +/invoices\/(\d+)/.exec(await page.hash())[1];
  const inv = await api.get(`${O()}/invoices/${ids.invoice}`);
  assert.equal(inv.status, 'sent'); assert.equal(inv.currency, 'EUR'); assert.equal(inv.total, 185000);
  assert.equal((await api.get(`${O()}/products/${ids.product}`)).qty, 58);
  await page.assertClean('documents');
});

test('UI 4. payment with exchange gain, PDF and email', { skip }, async () => {
  await page.rendered(() => page.modal('[data-act=pay]', {}, {
    before: async () => {
      await page.waitFor(`document.querySelector('#modal-root [name=exchange_rate]').value === '5000'`, 'payment rate');
      await page.fill('#modal-root [name=exchange_rate]', 5200);
      await page.fill('#modal-root [name=fee]', 0);
      await page.waitFor(`/gain/.test(document.querySelector('#pay-preview').textContent)`, 'FX preview');
    },
  }), /^Invoice INV-0001/);
  const inv = await api.get(`${O()}/invoices/${ids.invoice}`);
  assert.equal(inv.status, 'paid');
  assert.equal((await api.get(`${O()}/accounts`)).find((a) => a.system_key === 'fx').balance, 185000 * 200);
  assert.ok(await page.exists('[data-act=delPay]'));

  // Headless Chrome's PDF viewer swallows application/pdf fetches (204), so download the button's URL from Node instead.
  const href = await page.eval(`document.querySelector('a[download][href$="pdf?download=1"]').getAttribute('href')`);
  assert.equal(href, `${O()}/invoices/${ids.invoice}/pdf?download=1`);
  const pdf = await api.req('GET', href);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(pdf.data.subarray(0, 5).toString(), '%PDF-');

  await page.go(oh('/settings/email'), /Settings/);
  for (const [k, v] of Object.entries({ smtp_host: '127.0.0.1', smtp_secure: 'none', smtp_port: smtp.port, smtp_user: 'u', smtp_pass: 'p', smtp_from: 'billing@ui.test' })) await page.fill(`form[data-submit=saveEmail] [name=${k}]`, v);
  await page.rendered(() => page.eval(`document.querySelector('form[data-submit=saveEmail]').requestSubmit(); true`), /Settings/);
  assert.match(await page.text(), /Ready to send/i);
  const before = smtp.messages.length;
  await page.click('[data-act=test]');
  await page.waitFor(`/Test email sent to admin@ui.test/.test(document.querySelector('#toast-root').textContent)`, 'test email toast');
  assert.equal(smtp.messages.length, before + 1);
  await page.go(oh(`/invoices/${ids.invoice}`), /^Invoice INV-0001/);
  await page.rendered(() => page.modal('[data-act=email]', { cc: 'boss@ui.test' }, {
    before: () => page.waitFor(`document.querySelector('#modal-root [name=to]').value === 'compta@paris.test'`, 'prefilled recipient'),
  }), /^Invoice INV-0001/);
  await page.waitFor(`/sent/i.test(document.querySelector('.content').innerText) && /compta@paris.test/.test(document.querySelector('.content').innerText)`, 'email log on invoice');
  assert.equal(smtp.messages.length, before + 2);
  const mail = parseMail(smtp.messages.at(-1).data);
  assert.match(mail.subject, /Invoice INV-0001/);
  assert.equal(mail.attachments[0].filename, 'INV-0001.pdf');
  await page.assertClean('payment/email');
});

test('UI 5. recurring invoice editor and "generate now"', { skip }, async () => {
  await page.go(oh('/recurring/new'), /New recurring invoice/);
  await page.fill('#rec-form [name=name]', 'Location entrepôt');
  await page.selectText('#rec-form [name=contact_id]', 'Paris Import');
  await page.fill('#rec-form [name=frequency]', 'quarterly');
  await page.fill('#rec-form [name=auto_email]', false);
  await page.fill('#items-root tbody tr:nth-child(1) [name=description]', 'Warehouse 200 m²');
  await page.fill('#items-root tbody tr:nth-child(1) [name=unit_price]', 2500000);
  await page.rendered(() => page.click('#rec-form button[type=submit]'), /Location entrepôt/);
  assert.match(await page.text(), /Every quarter/);
  await page.rendered(() => page.click('[data-act=run]'), /^Invoice INV-0002/);
  const inv = await api.get(`${O()}/invoices/${+/invoices\/(\d+)/.exec(await page.hash())[1]}`);
  assert.equal(inv.status, 'sent'); assert.ok(inv.recurring_id);
  await page.assertClean('recurring');
});

test('UI 6. accounts, banking with fees and cross-currency transfer', { skip }, async () => {
  await page.go(oh('/accounts'), /Chart of accounts/);
  await page.rendered(() => page.modal('[data-act=add]', { code: '1030', name: 'BNI EUR', type: 'asset', is_bank: true, currency: 'EUR', fee_percent: 0.5 }), /Chart of accounts/);
  assert.match(await page.text(), /BNI EUR/);
  await page.go(oh('/banking'), /Banking/);
  await page.rendered(() => page.modal('[data-act=moneyIn]', {}, {
    before: async () => {
      await page.selectText('#modal-root [name=category_id]', "Owner's Capital");
      await page.fill('#modal-root [name=amount]', 20000000);
      await page.fill('#modal-root [name=description]', 'Apport en capital');
    },
  }), /Banking/);
  assert.match(await page.text(), /Apport en capital/);
  await page.rendered(() => page.modal('[data-act=transfer]', {}, {
    before: async () => {
      await page.selectText('#modal-root [name=to_id]', 'BNI EUR');
      await page.waitFor(`!document.querySelector('#modal-root .to-amount').classList.contains('hidden')`, 'received-amount field');
      await page.fill('#modal-root [name=amount]', 5200000);
      await page.fill('#modal-root [name=to_amount]', 1000);
      await page.fill('#modal-root [name=fee]', 5000);
    },
  }), /Banking/);
  const accts = await api.get(`${O()}/accounts`);
  assert.equal(accts.find((a) => a.code === '1030').fx_balance, 100000);
  assert.match(norm(await page.text()), /1000,00€/);
  await page.go(oh(`/banking?account_id=${accts.find((a) => a.code === '1030').id}`), /Banking/);
  assert.ok(await page.exists('[data-act=revalue]'), 'foreign accounts can be revalued');
  await page.assertClean('banking');
});

test('UI 7. Madagascar payroll: employee, pay run, posting, payslips, settings', { skip }, async () => {
  await page.go(oh('/payroll/employees'), /Payroll/);
  await page.rendered(() => page.modal('[data-act=add]', { name: 'Rakoto Hery', position: 'Comptable', pay_rate: 800000, dependents: 3, cnaps_number: '123456' }), /Payroll/);
  await page.go(oh('/payroll'), /Payroll/);
  await page.rendered(() => page.modal('[data-act=newRun]', { period_start: '2026-10-01', period_end: '2026-10-31', pay_date: '2026-10-31' }), /Pay run/);
  ids.run = +/payroll\/(\d+)/.exec(await page.hash())[1];
  const head = await page.text('thead');
  assert.match(head, /CNaPS/i); assert.match(head, /OSTIE/i); assert.match(head, /IRSA/i);
  assert.equal(norm(await page.text('[data-f=IRSA]')), '58300Ar');
  assert.equal(norm(await page.text('[data-f=net]')), '725700Ar');
  await page.fill('[name=bonus]', 100000);
  await page.waitFor(`document.querySelector('[data-f=gross]').textContent.replace(/\\D/g, '') === '900000'`, 'payslip recalculated after bonus');
  await page.rendered(() => page.click('[data-act=post]').then(() => page.waitFor(`!!document.querySelector('#modal-root form')`)).then(() => page.submitModal()), /Pay run/);
  assert.equal((await api.get(`${O()}/payroll/${ids.run}`)).status, 'posted');
  await page.go(`#/print/${ids.org}/payroll/${ids.run}`);
  const slip = await page.text('.print-page');
  assert.match(slip, /PAYSLIP/); assert.match(slip, /CNaPS: 123456/); assert.match(slip, /IRSA/); assert.match(slip, /FMFP/);
  await page.go(oh('/settings/payroll'), /Settings/);
  assert.equal(await page.eval(`document.querySelectorAll('#br-rows tr').length`), 6);
  await page.click('[data-act=addSme]');
  assert.equal(await page.eval(`document.querySelectorAll('#sme-rows tr').length`), 4);
  await page.fill('#sme-rows tr:last-child [name=sme_from]', '2027-03-01');
  await page.fill('#sme-rows tr:last-child [name=sme_amount]', 330000);
  await page.rendered(() => page.eval(`document.querySelector('form[data-submit=savePayroll]').requestSubmit(); true`), /Settings/);
  assert.equal((await api.get(O())).payroll.sme_history.at(-1).amount, 330000);
  await page.assertClean('payroll');
});

test('UI 8. every screen renders without errors', { skip }, async () => {
  const bill = (await api.get(`${O()}/bills`))[0].id;
  const rec = (await api.get(`${O()}/recurring`))[0].id;
  const eur = (await api.get(`${O()}/accounts`)).find((a) => a.code === '1030').id;
  const screens = [
    ['#/', /All organisations/], [oh('/dashboard'), /UI Vanille SARL/],
    [oh('/invoices'), /Invoices/], [oh('/invoices?status=paid'), /Invoices/], [oh('/invoices/new'), /New invoice/], [oh(`/invoices/${ids.invoice}`), /Invoice INV-0001/],
    [oh('/recurring'), /Recurring invoices/], [oh('/recurring/new'), /New recurring/], [oh(`/recurring/${rec}`), /Location/], [oh(`/recurring/${rec}/edit`), /Edit/],
    [oh(`/recurring/new?from=${ids.invoice}`), /New recurring/],
    [oh('/bills'), /Bills/], [oh('/bills/new'), /New bill/], [oh(`/bills/${bill}`), /Bill BILL-0001/],
    [oh('/contacts'), /Contacts/], [oh('/contacts?kind=vendor'), /Contacts/],
    [oh('/banking'), /Banking/], [oh(`/banking?account_id=${eur}`), /Banking/],
    [oh('/products'), /Products/], [oh('/products?kind=low'), /Products/], [oh(`/products/${ids.product}`), /Vanille/],
    [oh('/payroll'), /Payroll/], [oh('/payroll/employees'), /Payroll/], [oh(`/payroll/${ids.run}`), /Pay run/],
    ...['pnl', 'balance-sheet', 'cashflow', 'trial-balance', 'ledger', 'ar', 'ap', 'tax', 'inventory', 'payroll-taxes'].map((r) => [oh(`/reports/${r}`), /Reports/]),
    [oh('/budgets'), /Budgets/], [oh('/accounts'), /Chart of accounts/], [oh('/accounts?archived=1'), /Chart of accounts/], [oh('/journal'), /Journal/],
    ...['general', 'currencies', 'email', 'payroll', 'members', 'audit', 'danger'].map((s) => [oh(`/settings/${s}`), /Settings/]),
    ['#/profile', /Your profile/], ['#/admin', /Administration/],
  ];
  for (const [hash, h1] of screens) {
    await page.go(hash, h1);
    await page.assertControlsVisible(hash);
    await page.assertClean(hash);
  }
  for (const hash of [`#/print/${ids.org}/invoice/${ids.invoice}`, `#/print/${ids.org}/bill/${bill}`, `#/print/${ids.org}/payroll/${ids.run}`]) {
    await page.go(hash);
    assert.ok(await page.exists('.print-page .doc'), `${hash} renders a document`);
    await page.assertClean(hash);
  }
  await page.go(oh('/reports/payroll-taxes?from=2026-10-01&to=2026-10-31'), /Reports/);
  assert.match(await page.text(), /Rakoto Hery/);
  await assertBooks(api, ids.org, 'after UI flows');
});

test('UI 9. read-only viewers see no editing controls', { skip }, async () => {
  await api.post(`${O()}/members`, { email: 'viewer@ui.test', name: 'Vera Viewer', password: PW, role: 'viewer' });
  await page.rendered(() => page.click('[data-act=logout]'));
  await page.waitFor(`!!document.querySelector('#auth-form')`, 'login form');
  await page.fill('#auth-form [name=email]', 'viewer@ui.test');
  await page.fill('#auth-form [name=password]', PW);
  await page.rendered(() => page.eval(`document.querySelector('#auth-form').requestSubmit(); true`), /All organisations/);
  await page.go(oh('/dashboard'), /UI Vanille SARL/);
  assert.match(await page.text(), /read-only/);
  assert.equal(await page.exists('a[href$="/invoices/new"]'), false);
  await page.go(oh(`/invoices/${ids.invoice}`), /Invoice INV-0001/);
  for (const sel of ['[data-act=pay]', '[data-act=email]', '[data-act=void]', '[data-act=delPay]']) assert.equal(await page.exists(sel), false, sel);
  await page.go(oh('/products'), /Products/);
  assert.equal(await page.exists('[data-act=add]'), false);
  await page.go(oh('/settings/general'), /Settings/);
  assert.equal(await page.eval(`document.querySelector('fieldset').disabled`), true);
  assert.equal(await page.exists('a[href="#/admin"]'), false, 'no admin link for non-admins');
  await page.assertClean('viewer');
});

test('UI 10. phone layout', { skip }, async () => {
  await browser.cdp.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
  for (const hash of [oh('/dashboard'), oh('/invoices'), oh(`/invoices/${ids.invoice}`), oh('/banking'), oh(`/payroll/${ids.run}`), oh('/reports/pnl'), oh('/products')]) {
    await page.go(hash);
    const overflow = await page.eval('document.documentElement.scrollWidth - window.innerWidth');
    assert.ok(overflow <= 1, `${hash} overflows horizontally by ${overflow}px`);
  }
  assert.notEqual(await page.eval(`getComputedStyle(document.querySelector('.menu-btn')).display`), 'none', 'menu button visible on phones');
  await page.click('[data-act=toggleNav]');
  assert.equal(await page.eval(`document.querySelector('#shell').classList.contains('nav-open')`), true);
  await page.assertClean('mobile');
});

test('UI 11. icon buttons are visible and clickable: dialog close and sign out on a short screen', { skip }, async () => {
  await browser.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 640, deviceScaleFactor: 1, mobile: false });
  await page.go(oh('/dashboard'), /UI Vanille SARL/);
  assert.ok(await page.eval(`document.querySelector('.nav').scrollHeight > document.querySelector('.nav').clientHeight`), 'menu is taller than this screen, so it must scroll');
  await page.go('#/', /All organisations/);
  await page.click('[data-act=newOrg]');
  await page.waitFor(`!!document.querySelector('#modal-root form')`, 'new organisation dialog');
  await page.assertControlsVisible('dialog');
  await page.mouseClick('#modal-root .icon-btn[data-close]');
  await page.waitFor(`!document.querySelector('#modal-root form')`, 'dialog closed by its ✕ button');
  await page.go(oh('/dashboard'), /UI Vanille SARL/);
  await page.rendered(() => page.mouseClick('[data-act=logout]'));
  assert.ok(await page.exists('#auth-form'), 'signed out to the login screen');
  await page.assertClean('sign out');
});
