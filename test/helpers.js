'use strict';
// Shared harness for the end-to-end suites: boots Ledgerly on a throwaway database,
// provides a cookie-aware API client, a fake SMTP server and accounting invariants.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const http = require('node:http');
const assert = require('node:assert/strict');

// Boot the app in-process. Must run before anything else requires ../src (the DB opens on require).
async function startApp(env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-e2e-'));
  Object.assign(process.env, { DATA_DIR: dataDir, TRUST_PROXY: 'true', DISABLE_SCHEDULER: 'true' }, env);
  const { handle } = require('../src/server');
  const server = http.createServer(handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, dataDir,
    src: (m) => require('../src/' + m),
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}

class Client {
  constructor(base, { ip } = {}) { this.base = base; this.cookie = ''; this.ip = ip; }
  async raw(method, url, body, { headers = {}, csrf = true } = {}) {
    const h = { 'Content-Type': 'application/json', ...headers };
    if (csrf) h['X-Requested-With'] = 'ledgerly';
    if (this.cookie) h.cookie = this.cookie;
    if (this.ip) h['X-Forwarded-For'] = this.ip;
    const r = await fetch(this.base + url, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body), redirect: 'manual' });
    const sc = r.headers.get('set-cookie');
    if (sc) { const c = sc.split(';')[0]; this.cookie = c.endsWith('=') ? '' : c; }
    return r;
  }
  async req(method, url, body, opts) {
    const r = await this.raw(method, url, body, opts);
    const buf = Buffer.from(await r.arrayBuffer());
    let data = buf;
    if ((r.headers.get('content-type') || '').includes('json')) data = JSON.parse(buf.toString('utf8'));
    return { status: r.status, data, headers: r.headers };
  }
  async ok(method, url, body) {
    const r = await this.req(method, url, body);
    if (r.status !== 200) throw new Error(`${method} ${url} → ${r.status}: ${JSON.stringify(r.data && r.data.error ? r.data.error : String(r.data).slice(0, 200))}`);
    return r.data;
  }
  async fails(method, url, body, status, pattern) {
    const r = await this.req(method, url, body);
    assert.equal(r.status, status, `${method} ${url} expected ${status}, got ${r.status}: ${JSON.stringify(r.data && r.data.error)}`);
    if (pattern) assert.match(r.data.error, pattern);
    return r.data;
  }
  get(url) { return this.ok('GET', url); }
  post(url, body = {}) { return this.ok('POST', url, body); }
  put(url, body = {}) { return this.ok('PUT', url, body); }
  del(url, body) { return this.ok('DELETE', url, body); }
  async login(email, password) { await this.post('/api/auth/login', { email, password }); return this; }
}

// Minimal SMTP server that records every message. Options let tests simulate failures.
function fakeSmtp({ rejectAuth = false, rejectRcpt = null } = {}) {
  const messages = [];
  const server = net.createServer((s) => {
    let buf = '', inData = false, cur = { rcpt: [] };
    s.write('220 fake.smtp ESMTP\r\n');
    s.on('data', (d) => {
      buf += d.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          cur.data = buf.slice(0, end); buf = buf.slice(end + 5); inData = false;
          messages.push(cur); cur = { rcpt: [] };
          s.write('250 2.0.0 queued\r\n');
          continue;
        }
        const i = buf.indexOf('\r\n');
        if (i < 0) return;
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        const verb = line.split(' ')[0].toUpperCase();
        if (verb === 'EHLO') s.write('250-fake.smtp\r\n250-SIZE 10000000\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n');
        else if (verb === 'AUTH') { cur.auth = line; s.write(rejectAuth ? '535 5.7.8 Authentication failed\r\n' : '235 2.7.0 ok\r\n'); }
        else if (verb === 'MAIL') { cur.from = line; s.write('250 ok\r\n'); }
        else if (verb === 'RCPT') { if (rejectRcpt && line.includes(rejectRcpt)) s.write('550 no such user\r\n'); else { cur.rcpt.push(line); s.write('250 ok\r\n'); } }
        else if (verb === 'DATA') { inData = true; s.write('354 go ahead\r\n'); }
        else if (verb === 'QUIT') s.end('221 bye\r\n');
        else s.write('250 ok\r\n');
      }
    });
    s.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port, messages,
    close: () => new Promise((r) => server.close(r)),
  })));
}

// Decode a captured MIME message: headers, text body and attachments.
function parseMail(raw) {
  const [head] = raw.split('\r\n\r\n');
  const header = (name) => { const m = new RegExp(`^${name}: (.*)$`, 'mi').exec(head); return m ? m[1] : null; };
  const decodeWord = (s) => String(s || '').replace(/=\?UTF-8\?B\?([^?]+)\?=/g, (_, b) => Buffer.from(b, 'base64').toString('utf8'));
  const parts = [...raw.matchAll(/Content-Type: ([^;\r\n]+)[^\r\n]*\r\n(?:Content-Disposition: [^\r\n]*filename="([^"]+)"\r\n)?Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)/g)]
    .map(([, type, filename, b64]) => ({ type, filename, content: Buffer.from(b64.replace(/\r\n/g, ''), 'base64') }));
  return { subject: decodeWord(header('Subject')), from: header('From'), to: header('To'), cc: header('Cc'), parts,
    text: (parts.find((p) => p.type === 'text/plain') || {}).content?.toString('utf8'),
    html: (parts.find((p) => p.type === 'text/html') || {}).content?.toString('utf8'),
    attachments: parts.filter((p) => p.filename) };
}

// Accounting invariants that must hold after every operation.
async function assertBooks(c, orgId, label = '') {
  const o = `/api/orgs/${orgId}`, far = '2099-12-31';
  const tb = await c.get(`${o}/reports/trial-balance?asOf=${far}`);
  assert.equal(tb.totalDebit, tb.totalCredit, `${label}: trial balance must balance`);
  const bs = await c.get(`${o}/reports/balance-sheet?asOf=${far}`);
  assert.ok(bs.balanced, `${label}: balance sheet must balance (A ${bs.totalAssets} vs L+E ${bs.totalLiabilities + bs.totalEquity})`);
  const inv = await c.get(`${o}/reports/inventory`);
  assert.equal(inv.difference, 0, `${label}: inventory sub-ledger must match the Inventory account`);
  const accts = await c.get(`${o}/accounts`);
  const bal = (k) => accts.find((a) => a.system_key === k).balance;
  const openDue = (docs, statuses) => docs.filter((d) => statuses.includes(d.status)).reduce((s, d) => s + d.due_base, 0);
  assert.equal(bal('ar'), openDue(await c.get(`${o}/invoices`), ['sent', 'partial']), `${label}: AR must equal open invoices`);
  assert.equal(bal('ap'), openDue(await c.get(`${o}/bills`), ['open', 'partial']), `${label}: AP must equal open bills`);
  return { accts, bal };
}

const iso = (d) => d.toISOString().slice(0, 10);
const daysFromToday = (n) => iso(new Date(Date.now() + n * 86400000));
const Ar = (n) => Math.round(n * 100);

module.exports = { startApp, Client, fakeSmtp, parseMail, assertBooks, iso, daysFromToday, Ar };
