'use strict';
// Ledgerly — self-hosted finance suite. Zero npm dependencies: node:http + node:sqlite.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { db, DATA_DIR, tx, all, get, run, seedAccounts } = require('./db');
const L = require('./ledger');
const { HttpError, bad } = L;

const PORT = +process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const ALLOW_SIGNUP = process.env.ALLOW_SIGNUP === 'true';
const SECURE_COOKIES = process.env.SECURE_COOKIES === 'true';
const SESSION_DAYS = 14;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// ---------- helpers ----------
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const str = (v, max = 500) => (v == null ? null : String(v).trim().slice(0, max) || null);
const cents = (v) => { const n = Math.round(Number(v)); if (!Number.isFinite(n)) throw bad('Invalid amount'); return n; };
const notFound = (what = 'Not found') => new HttpError(404, what);

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [, salt, key] = String(stored).split('$');
  if (!salt || !key) return false;
  const k = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(k, Buffer.from(key, 'hex'));
}
function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw bad('Password must be at least 8 characters');
}
function audit(ctx, action, entity, entityId, details) {
  run('INSERT INTO audit_log (org_id, user_id, action, entity, entity_id, details) VALUES (?,?,?,?,?,?)',
    ctx.org ? ctx.org.id : null, ctx.user ? ctx.user.id : null, action, entity || null, entityId == null ? null : Number(entityId),
    details == null ? null : typeof details === 'string' ? details : JSON.stringify(details));
}

// ---------- tiny router ----------
const routes = [];
// access: 'public' | 'user' | 'admin' | 'read' | 'write' | 'owner' (last three are org-scoped)
function route(method, pattern, access, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  routes.push({ method, re, keys, access, handler });
}
const ROLE_RANK = { viewer: 1, accountant: 2, owner: 3 };
const NEEDS = { read: 1, write: 2, owner: 3 };

function parseCookies(h = '') {
  return Object.fromEntries(h.split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}
function setSession(res, token, maxAge) {
  res.setHeader('Set-Cookie', `ledgerly_sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${SECURE_COOKIES ? '; Secure' : ''}`);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 5e6) { reject(new HttpError(413, 'Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(bad('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}
function send(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

// Simple in-memory login throttle: 10 attempts / 15 min per IP.
const attempts = new Map();
function throttle(ip) {
  const now = Date.now(), win = 15 * 60e3;
  const a = (attempts.get(ip) || []).filter((t) => now - t < win);
  if (a.length >= 10) throw new HttpError(429, 'Too many login attempts, try again later');
  a.push(now); attempts.set(ip, a);
}

// ---------- auth ----------
route('GET', '/api/setup', 'public', () => ({ needsSetup: get('SELECT COUNT(*) n FROM users').n === 0, allowSignup: ALLOW_SIGNUP }));

route('POST', '/api/auth/register', 'public', ({ body, res }) => {
  const first = get('SELECT COUNT(*) n FROM users').n === 0;
  if (!first && !ALLOW_SIGNUP) throw new HttpError(403, 'Registration is disabled. Ask an administrator for an account.');
  const email = str(body.email, 200), name = str(body.name, 100);
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) throw bad('A valid email is required');
  if (!name) throw bad('Name is required');
  checkPassword(body.password);
  if (get('SELECT 1 FROM users WHERE email = ?', email)) throw bad('An account with that email already exists');
  const { lastInsertRowid: id } = run('INSERT INTO users (email, name, password_hash, is_admin) VALUES (?,?,?,?)', email, name, hashPassword(body.password), first ? 1 : 0);
  startSession(res, Number(id));
  return { ok: true };
});

function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)', token, userId, Date.now() + SESSION_DAYS * 86400e3);
  setSession(res, token, SESSION_DAYS * 86400);
}

route('POST', '/api/auth/login', 'public', ({ body, res, ip }) => {
  throttle(ip);
  const u = get('SELECT * FROM users WHERE email = ?', str(body.email, 200) || '');
  if (!u || !verifyPassword(String(body.password || ''), u.password_hash)) throw new HttpError(401, 'Invalid email or password');
  attempts.delete(ip);
  startSession(res, u.id);
  return { ok: true };
});

route('POST', '/api/auth/logout', 'user', ({ res, token }) => {
  run('DELETE FROM sessions WHERE token = ?', token);
  setSession(res, '', 0);
  return { ok: true };
});

route('GET', '/api/me', 'user', ({ user }) => ({
  user: { id: user.id, name: user.name, email: user.email, is_admin: !!user.is_admin },
  orgs: all(`SELECT o.id, o.name, o.currency, m.role FROM orgs o JOIN memberships m ON m.org_id = o.id WHERE m.user_id = ? ORDER BY o.name`, user.id),
}));

route('PUT', '/api/me', 'user', ({ user, body }) => {
  const name = str(body.name, 100);
  if (name) run('UPDATE users SET name = ? WHERE id = ?', name, user.id);
  if (body.new_password) {
    if (!verifyPassword(String(body.current_password || ''), user.password_hash)) throw bad('Current password is incorrect');
    checkPassword(body.new_password);
    run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(body.new_password), user.id);
  }
  return { ok: true };
});

// ---------- admin ----------
route('GET', '/api/admin/users', 'admin', () => all(`SELECT u.id, u.email, u.name, u.is_admin, u.created_at,
  (SELECT COUNT(*) FROM memberships m WHERE m.user_id = u.id) orgs FROM users u ORDER BY u.id`));
route('POST', '/api/admin/users', 'admin', (ctx) => {
  const { body } = ctx;
  const email = str(body.email, 200), name = str(body.name, 100);
  if (!email || !name) throw bad('Name and email are required');
  checkPassword(body.password);
  if (get('SELECT 1 FROM users WHERE email = ?', email)) throw bad('Email already in use');
  const { lastInsertRowid: id } = run('INSERT INTO users (email, name, password_hash, is_admin) VALUES (?,?,?,?)', email, name, hashPassword(body.password), body.is_admin ? 1 : 0);
  audit(ctx, 'user.create', 'user', id, { email });
  return { id: Number(id) };
});
route('PUT', '/api/admin/users/:id', 'admin', (ctx) => {
  const { params, body, user } = ctx;
  const u = get('SELECT * FROM users WHERE id = ?', params.id);
  if (!u) throw notFound();
  if (body.is_admin !== undefined) {
    if (u.id === user.id && !body.is_admin) throw bad('You cannot remove your own admin rights');
    run('UPDATE users SET is_admin = ? WHERE id = ?', body.is_admin ? 1 : 0, u.id);
  }
  if (body.password) { checkPassword(body.password); run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(body.password), u.id); run('DELETE FROM sessions WHERE user_id = ?', u.id); }
  audit(ctx, 'user.update', 'user', u.id);
  return { ok: true };
});
route('DELETE', '/api/admin/users/:id', 'admin', (ctx) => {
  if (+ctx.params.id === ctx.user.id) throw bad('You cannot delete yourself');
  run('DELETE FROM users WHERE id = ?', ctx.params.id);
  audit(ctx, 'user.delete', 'user', ctx.params.id);
  return { ok: true };
});
route('GET', '/api/admin/backup', 'admin', ({ res }) => {
  const file = path.join(os.tmpdir(), `ledgerly-backup-${Date.now()}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="ledgerly-${stamp}.db"` });
  fs.createReadStream(file).on('close', () => fs.rm(file, () => {})).pipe(res);
  return undefined; // streamed
});

// ---------- organisations ----------
const ORG_FIELDS = ['name', 'legal_name', 'currency', 'address', 'tax_id', 'email', 'phone', 'invoice_prefix', 'bill_prefix', 'invoice_footer'];
route('GET', '/api/orgs', 'user', ({ user }) => all(`SELECT o.*, m.role FROM orgs o JOIN memberships m ON m.org_id = o.id WHERE m.user_id = ? ORDER BY o.name`, user.id));

route('POST', '/api/orgs', 'user', (ctx) => {
  const { body, user } = ctx;
  const name = str(body.name, 120);
  if (!name) throw bad('Organisation name is required');
  const currency = (str(body.currency, 3) || 'USD').toUpperCase();
  const id = tx(() => {
    const { lastInsertRowid } = run('INSERT INTO orgs (name, currency, default_tax_rate) VALUES (?,?,?)', name, currency, +body.default_tax_rate || 0);
    const oid = Number(lastInsertRowid);
    run('INSERT INTO memberships (user_id, org_id, role) VALUES (?,?,?)', user.id, oid, 'owner');
    seedAccounts(oid);
    return oid;
  });
  ctx.org = { id };
  audit(ctx, 'org.create', 'org', id, { name });
  return { id };
});

route('GET', '/api/portfolio', 'user', ({ user }) => {
  const orgs = all(`SELECT o.id, o.name, o.currency, m.role FROM orgs o JOIN memberships m ON m.org_id = o.id WHERE m.user_id = ? ORDER BY o.name`, user.id);
  return orgs.map((o) => ({ ...o, summary: L.summary(o.id), series: L.monthlySeries(o.id, 6) }));
});

route('GET', '/api/orgs/:orgId', 'read', ({ org, role }) => ({ ...org, role }));
route('PUT', '/api/orgs/:orgId', 'owner', (ctx) => {
  const { body, org } = ctx;
  const sets = [], vals = [];
  for (const f of ORG_FIELDS) if (body[f] !== undefined) { sets.push(`${f} = ?`); vals.push(f === 'currency' ? String(body[f]).toUpperCase().slice(0, 3) : str(body[f], 2000)); }
  for (const f of ['default_tax_rate', 'payment_terms', 'next_invoice_no', 'next_bill_no', 'fiscal_year_start']) if (body[f] !== undefined) { sets.push(`${f} = ?`); vals.push(+body[f] || 0); }
  if (body.name !== undefined && !str(body.name)) throw bad('Name is required');
  if (sets.length) run(`UPDATE orgs SET ${sets.join(', ')} WHERE id = ?`, ...vals, org.id);
  audit(ctx, 'org.update', 'org', org.id);
  return { ok: true };
});
route('DELETE', '/api/orgs/:orgId', 'owner', (ctx) => {
  if (ctx.body.confirm !== ctx.org.name) throw bad('Type the organisation name to confirm deletion');
  run('DELETE FROM orgs WHERE id = ?', ctx.org.id);
  ctx.org = null;
  audit(ctx, 'org.delete', 'org', ctx.params.orgId);
  return { ok: true };
});

// Members
route('GET', '/api/orgs/:orgId/members', 'read', ({ org }) =>
  all('SELECT u.id, u.name, u.email, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY u.name', org.id));
route('POST', '/api/orgs/:orgId/members', 'owner', (ctx) => {
  const { body, org } = ctx;
  const role = ROLE_RANK[body.role] ? body.role : 'viewer';
  const email = str(body.email, 200);
  let u = get('SELECT * FROM users WHERE email = ?', email || '');
  if (!u) {
    if (!body.name || !body.password) throw bad('No user with that email. Provide a name and a temporary password to create one.');
    checkPassword(body.password);
    const { lastInsertRowid } = run('INSERT INTO users (email, name, password_hash) VALUES (?,?,?)', email, str(body.name, 100), hashPassword(body.password));
    u = { id: Number(lastInsertRowid) };
  }
  run('INSERT INTO memberships (user_id, org_id, role) VALUES (?,?,?) ON CONFLICT(user_id, org_id) DO UPDATE SET role = excluded.role', u.id, org.id, role);
  audit(ctx, 'member.add', 'user', u.id, { email, role });
  return { ok: true };
});
function ownersLeft(orgId, excludingUser) {
  return get(`SELECT COUNT(*) n FROM memberships WHERE org_id = ? AND role = 'owner' AND user_id != ?`, orgId, excludingUser).n;
}
route('PUT', '/api/orgs/:orgId/members/:uid', 'owner', (ctx) => {
  const role = ctx.body.role;
  if (!ROLE_RANK[role]) throw bad('Invalid role');
  if (role !== 'owner' && !ownersLeft(ctx.org.id, +ctx.params.uid)) throw bad('An organisation needs at least one owner');
  run('UPDATE memberships SET role = ? WHERE org_id = ? AND user_id = ?', role, ctx.org.id, ctx.params.uid);
  audit(ctx, 'member.role', 'user', ctx.params.uid, { role });
  return { ok: true };
});
route('DELETE', '/api/orgs/:orgId/members/:uid', 'owner', (ctx) => {
  if (!ownersLeft(ctx.org.id, +ctx.params.uid)) throw bad('An organisation needs at least one owner');
  run('DELETE FROM memberships WHERE org_id = ? AND user_id = ?', ctx.org.id, ctx.params.uid);
  audit(ctx, 'member.remove', 'user', ctx.params.uid);
  return { ok: true };
});

route('GET', '/api/orgs/:orgId/audit', 'read', ({ org, query }) =>
  all(`SELECT a.*, u.name user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id WHERE a.org_id = ? ORDER BY a.id DESC LIMIT ?`, org.id, Math.min(+query.limit || 200, 1000)));

// ---------- chart of accounts ----------
const ACC_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'];
route('GET', '/api/orgs/:orgId/accounts', 'read', ({ org }) => L.accountBalances(org.id));
route('POST', '/api/orgs/:orgId/accounts', 'write', (ctx) => {
  const { body, org } = ctx;
  const code = str(body.code, 20), name = str(body.name, 120);
  if (!code || !name) throw bad('Code and name are required');
  if (!ACC_TYPES.includes(body.type)) throw bad('Invalid account type');
  if (get('SELECT 1 FROM accounts WHERE org_id = ? AND code = ?', org.id, code)) throw bad('That account code is already used');
  const { lastInsertRowid: id } = run('INSERT INTO accounts (org_id, code, name, type, subtype, is_bank, description) VALUES (?,?,?,?,?,?,?)',
    org.id, code, name, body.type, str(body.subtype, 30), body.is_bank ? 1 : 0, str(body.description));
  audit(ctx, 'account.create', 'account', id, { code, name });
  return { id: Number(id) };
});
route('PUT', '/api/orgs/:orgId/accounts/:id', 'write', (ctx) => {
  const { body, org, params } = ctx;
  const a = get('SELECT * FROM accounts WHERE id = ? AND org_id = ?', params.id, org.id);
  if (!a) throw notFound();
  const code = str(body.code, 20) || a.code, name = str(body.name, 120) || a.name;
  if (code !== a.code && get('SELECT 1 FROM accounts WHERE org_id = ? AND code = ?', org.id, code)) throw bad('That account code is already used');
  const used = get('SELECT 1 FROM journal_lines WHERE account_id = ? LIMIT 1', a.id);
  const type = body.type && ACC_TYPES.includes(body.type) ? body.type : a.type;
  if (type !== a.type && (used || a.system_key)) throw bad('Cannot change the type of an account that is in use');
  if (body.archived && a.system_key) throw bad('System accounts cannot be archived');
  run('UPDATE accounts SET code=?, name=?, type=?, subtype=?, is_bank=?, archived=?, description=? WHERE id = ?',
    code, name, type, body.subtype !== undefined ? str(body.subtype, 30) : a.subtype, body.is_bank !== undefined ? (body.is_bank ? 1 : 0) : a.is_bank,
    body.archived !== undefined ? (body.archived ? 1 : 0) : a.archived, body.description !== undefined ? str(body.description) : a.description, a.id);
  audit(ctx, 'account.update', 'account', a.id);
  return { ok: true };
});
route('DELETE', '/api/orgs/:orgId/accounts/:id', 'write', (ctx) => {
  const a = get('SELECT * FROM accounts WHERE id = ? AND org_id = ?', ctx.params.id, ctx.org.id);
  if (!a) throw notFound();
  if (a.system_key) throw bad('System accounts cannot be deleted');
  if (get('SELECT 1 FROM journal_lines WHERE account_id = ? LIMIT 1', a.id) || get('SELECT 1 FROM document_items WHERE account_id = ? LIMIT 1', a.id))
    throw bad('Account has transactions — archive it instead');
  run('DELETE FROM accounts WHERE id = ?', a.id);
  audit(ctx, 'account.delete', 'account', a.id, { code: a.code });
  return { ok: true };
});

// ---------- journal ----------
function entriesWithLines(entries) {
  if (!entries.length) return [];
  const ids = entries.map((e) => e.id);
  const lines = all(`SELECT l.*, a.code, a.name account_name FROM journal_lines l JOIN accounts a ON a.id = l.account_id
    WHERE l.entry_id IN (${ids.map(() => '?').join(',')}) ORDER BY l.id`, ...ids);
  const by = new Map(ids.map((i) => [i, []]));
  for (const l of lines) by.get(l.entry_id).push(l);
  return entries.map((e) => ({ ...e, lines: by.get(e.id), total: by.get(e.id).reduce((s, l) => s + l.debit, 0) }));
}
route('GET', '/api/orgs/:orgId/journal', 'read', ({ org, query }) => {
  const limit = Math.min(+query.limit || 100, 500), offset = +query.offset || 0;
  const q = query.q ? `%${query.q}%` : null;
  const where = `org_id = ?1 AND (?2 IS NULL OR date >= ?2) AND (?3 IS NULL OR date <= ?3) AND (?4 IS NULL OR memo LIKE ?4) AND (?5 IS NULL OR ref_type = ?5)`;
  const args = [org.id, query.from || null, query.to || null, q, query.type || null];
  const entries = all(`SELECT * FROM journal_entries WHERE ${where} ORDER BY date DESC, id DESC LIMIT ${limit} OFFSET ${offset}`, ...args);
  return { total: get(`SELECT COUNT(*) n FROM journal_entries WHERE ${where}`, ...args).n, entries: entriesWithLines(entries) };
});
route('POST', '/api/orgs/:orgId/journal', 'write', (ctx) => {
  const { body, org, user } = ctx;
  const id = L.postEntry(org.id, { date: body.date, memo: str(body.memo), lines: body.lines, userId: user.id });
  audit(ctx, 'journal.create', 'journal', id, { memo: body.memo });
  return { id };
});
route('POST', '/api/orgs/:orgId/journal/:id/reverse', 'write', (ctx) => {
  const e = get('SELECT * FROM journal_entries WHERE id = ? AND org_id = ?', ctx.params.id, ctx.org.id);
  if (!e) throw notFound();
  if (e.ref_type !== 'manual' && e.ref_type !== 'bank') throw bad('This entry was created by an invoice, bill, payment or payroll run — void it from there');
  if (e.reversed_by) throw bad('Entry is already reversed');
  tx(() => {
    const lines = all('SELECT * FROM journal_lines WHERE entry_id = ?', e.id);
    const rid = L.postEntry(ctx.org.id, { date: str(ctx.body.date) || today(), memo: `Reversal: ${e.memo || '#' + e.id}`, ref_type: e.ref_type + '_reversal', ref_id: e.id, userId: ctx.user.id,
      lines: lines.map((l) => ({ account_id: l.account_id, debit: l.credit, credit: l.debit, description: l.description, contact_id: l.contact_id })) });
    run('UPDATE journal_entries SET reversed_by = ? WHERE id = ?', rid, e.id);
    run('UPDATE journal_entries SET reversed_by = ? WHERE id = ?', e.id, rid);
  });
  audit(ctx, 'journal.reverse', 'journal', e.id);
  return { ok: true };
});

// ---------- banking ----------
route('GET', '/api/orgs/:orgId/bank', 'read', ({ org, query }) => {
  const banks = L.accountBalances(org.id).filter((a) => a.is_bank && !a.archived);
  const accountId = +query.account_id || (banks[0] && banks[0].id);
  const tx = accountId ? L.generalLedger(org.id, accountId, query.from || null, query.to || null) : null;
  return { accounts: banks, ledger: tx };
});
// Simple money in / money out against a category account, or a transfer between bank accounts.
function bankTransaction(ctx, t) {
  const { org, user } = ctx;
  const bank = L.assertAccount(org.id, t.account_id);
  if (!bank.is_bank) throw bad('Choose a bank / cash account');
  const amount = cents(t.amount);
  if (amount <= 0) throw bad('Amount must be positive');
  const other = L.assertAccount(org.id, t.category_id);
  const contact = t.contact_id ? +t.contact_id : null;
  const lines = t.direction === 'in'
    ? [{ account_id: bank.id, debit: amount }, { account_id: other.id, credit: amount, contact_id: contact }]
    : [{ account_id: other.id, debit: amount, contact_id: contact }, { account_id: bank.id, credit: amount }];
  return L.postEntry(org.id, { date: t.date, memo: str(t.description) || (t.direction === 'in' ? 'Money in' : 'Money out'), ref_type: 'bank', lines, userId: user.id });
}
route('POST', '/api/orgs/:orgId/bank/transactions', 'write', (ctx) => {
  const id = bankTransaction(ctx, ctx.body);
  audit(ctx, 'bank.transaction', 'journal', id, { amount: ctx.body.amount, direction: ctx.body.direction });
  return { id };
});
route('POST', '/api/orgs/:orgId/bank/import', 'write', (ctx) => {
  const rows = Array.isArray(ctx.body.rows) ? ctx.body.rows : [];
  if (!rows.length) throw bad('Nothing to import');
  if (rows.length > 5000) throw bad('Import at most 5000 rows at once');
  const n = tx(() => {
    let i = 0;
    for (const r of rows) {
      const amt = cents(r.amount);
      if (!amt) continue;
      try {
        bankTransaction(ctx, { account_id: ctx.body.account_id, category_id: r.category_id || (amt > 0 ? ctx.body.income_category_id : ctx.body.expense_category_id),
          date: r.date, description: r.description, amount: Math.abs(amt), direction: amt > 0 ? 'in' : 'out' });
      } catch (e) { throw bad(`Row ${i + 1}: ${e.message}`); }
      i++;
    }
    return i;
  });
  audit(ctx, 'bank.import', 'account', ctx.body.account_id, { rows: n });
  return { imported: n };
});

// ---------- contacts ----------
const CONTACT_FIELDS = ['name', 'email', 'phone', 'address', 'tax_id', 'notes'];
route('GET', '/api/orgs/:orgId/contacts', 'read', ({ org, query }) => all(`
  SELECT c.*,
    (SELECT COALESCE(SUM(total - amount_paid),0) FROM documents d WHERE d.contact_id = c.id AND d.kind='invoice' AND d.status IN ('sent','partial')) receivable,
    (SELECT COALESCE(SUM(total - amount_paid),0) FROM documents d WHERE d.contact_id = c.id AND d.kind='bill' AND d.status IN ('open','partial')) payable
  FROM contacts c WHERE c.org_id = ? AND (? IS NULL OR c.kind = ? OR c.kind = 'both') ORDER BY c.name`, org.id, query.kind || null, query.kind || null));
route('POST', '/api/orgs/:orgId/contacts', 'write', (ctx) => {
  const b = ctx.body;
  if (!str(b.name)) throw bad('Name is required');
  const kind = ['customer', 'vendor', 'both'].includes(b.kind) ? b.kind : 'customer';
  const { lastInsertRowid: id } = run(`INSERT INTO contacts (org_id, kind, ${CONTACT_FIELDS.join(',')}) VALUES (?,?,?,?,?,?,?,?)`,
    ctx.org.id, kind, ...CONTACT_FIELDS.map((f) => str(b[f], 2000)));
  audit(ctx, 'contact.create', 'contact', id, { name: b.name });
  return { id: Number(id) };
});
route('PUT', '/api/orgs/:orgId/contacts/:id', 'write', (ctx) => {
  const c = get('SELECT * FROM contacts WHERE id = ? AND org_id = ?', ctx.params.id, ctx.org.id);
  if (!c) throw notFound();
  const b = ctx.body;
  const kind = ['customer', 'vendor', 'both'].includes(b.kind) ? b.kind : c.kind;
  run(`UPDATE contacts SET kind = ?, ${CONTACT_FIELDS.map((f) => f + ' = ?').join(', ')} WHERE id = ?`,
    kind, ...CONTACT_FIELDS.map((f) => (b[f] !== undefined ? str(b[f], 2000) : c[f])), c.id);
  audit(ctx, 'contact.update', 'contact', c.id);
  return { ok: true };
});
route('DELETE', '/api/orgs/:orgId/contacts/:id', 'write', (ctx) => {
  if (get('SELECT 1 FROM documents WHERE contact_id = ? LIMIT 1', ctx.params.id)) throw bad('Contact has invoices or bills and cannot be deleted');
  run('DELETE FROM contacts WHERE id = ? AND org_id = ?', ctx.params.id, ctx.org.id);
  audit(ctx, 'contact.delete', 'contact', ctx.params.id);
  return { ok: true };
});

// ---------- invoices & bills ----------
for (const kind of ['invoice', 'bill']) {
  const base = `/api/orgs/:orgId/${kind}s`;
  const openStatus = kind === 'invoice' ? 'sent' : 'open';

  const load = (org, id) => {
    const d = get(`SELECT d.*, c.name contact_name, c.email contact_email, c.address contact_address, c.tax_id contact_tax_id
      FROM documents d LEFT JOIN contacts c ON c.id = d.contact_id WHERE d.id = ? AND d.org_id = ? AND d.kind = ?`, id, org.id, kind);
    if (!d) throw notFound(`${kind} not found`);
    return d;
  };

  route('GET', base, 'read', ({ org, query }) => {
    const rows = all(`SELECT d.*, c.name contact_name FROM documents d LEFT JOIN contacts c ON c.id = d.contact_id
      WHERE d.org_id = ? AND d.kind = ? AND (? IS NULL OR d.contact_id = ?) ORDER BY d.issue_date DESC, d.id DESC`,
      org.id, kind, query.contact_id || null, query.contact_id || null);
    const t = today();
    const out = rows.map((d) => ({ ...d, overdue: ['sent', 'open', 'partial'].includes(d.status) && d.due_date < t }));
    if (query.status === 'overdue') return out.filter((d) => d.overdue);
    return query.status ? out.filter((d) => d.status === query.status) : out;
  });

  route('GET', base + '/:id', 'read', ({ org, params }) => {
    const d = load(org, params.id);
    return { ...d,
      items: all('SELECT i.*, a.code account_code, a.name account_name FROM document_items i LEFT JOIN accounts a ON a.id = i.account_id WHERE document_id = ? ORDER BY position', d.id),
      payments: all('SELECT p.*, a.name account_name FROM payments p JOIN accounts a ON a.id = p.account_id WHERE document_id = ? ORDER BY date', d.id),
      org: { ...org } };
  });

  const save = (ctx, existing) => {
    const { body, org } = ctx;
    if (!isDate(body.issue_date)) throw bad('Issue date is required');
    const due = isDate(body.due_date) ? body.due_date : addDays(body.issue_date, org.payment_terms);
    if (due < body.issue_date) throw bad('Due date cannot be before the issue date');
    const contact = body.contact_id ? get('SELECT id FROM contacts WHERE id = ? AND org_id = ?', body.contact_id, org.id) : null;
    if (!contact) throw bad(`Choose a ${kind === 'invoice' ? 'customer' : 'vendor'}`);
    const items = (Array.isArray(body.items) ? body.items : []).filter((i) => str(i.description));
    if (!items.length) throw bad('Add at least one line item');
    for (const i of items) if (i.account_id) L.assertAccount(org.id, i.account_id);
    const c = L.computeItems(items);
    return tx(() => {
      let id;
      if (existing) {
        id = existing.id;
        run('UPDATE documents SET contact_id=?, issue_date=?, due_date=?, reference=?, notes=?, subtotal=?, tax=?, total=?, number=? WHERE id = ?',
          contact.id, body.issue_date, due, str(body.reference), str(body.notes, 5000), c.subtotal, c.tax, c.total, str(body.number, 40) || existing.number, id);
        run('DELETE FROM document_items WHERE document_id = ?', id);
      } else {
        const prefix = kind === 'invoice' ? 'invoice' : 'bill';
        const o = get(`SELECT ${prefix}_prefix p, next_${prefix}_no n FROM orgs WHERE id = ?`, org.id);
        const number = str(body.number, 40) || `${o.p}${String(o.n).padStart(4, '0')}`;
        if (!str(body.number, 40)) run(`UPDATE orgs SET next_${prefix}_no = next_${prefix}_no + 1 WHERE id = ?`, org.id);
        if (get('SELECT 1 FROM documents WHERE org_id = ? AND kind = ? AND number = ?', org.id, kind, number)) throw bad(`Number ${number} is already used`);
        id = Number(run('INSERT INTO documents (org_id, kind, number, contact_id, issue_date, due_date, reference, notes, subtotal, tax, total) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
          org.id, kind, number, contact.id, body.issue_date, due, str(body.reference), str(body.notes, 5000), c.subtotal, c.tax, c.total).lastInsertRowid);
      }
      for (const it of c.items) run('INSERT INTO document_items (document_id, description, quantity, unit_price, tax_rate, account_id, position) VALUES (?,?,?,?,?,?,?)',
        id, str(it.description, 1000), it.quantity, it.unit_price, it.tax_rate, it.account_id || null, it.position);
      return id;
    });
  };

  route('POST', base, 'write', (ctx) => {
    const id = save(ctx, null);
    audit(ctx, `${kind}.create`, kind, id);
    if (ctx.body.finalize) finalize(ctx, id);
    return { id };
  });
  route('PUT', base + '/:id', 'write', (ctx) => {
    const d = load(ctx.org, ctx.params.id);
    if (d.status !== 'draft') throw bad(`Only draft ${kind}s can be edited. Void it and create a new one instead.`);
    save(ctx, d);
    audit(ctx, `${kind}.update`, kind, d.id);
    return { id: d.id };
  });
  route('DELETE', base + '/:id', 'write', (ctx) => {
    const d = load(ctx.org, ctx.params.id);
    if (d.status !== 'draft') throw bad(`Only drafts can be deleted — void this ${kind} instead`);
    run('DELETE FROM documents WHERE id = ?', d.id);
    audit(ctx, `${kind}.delete`, kind, d.id, { number: d.number });
    return { ok: true };
  });

  const finalize = (ctx, id) => tx(() => {
    const d = load(ctx.org, id);
    if (d.status !== 'draft') throw bad('Already finalised');
    L.postDocument(ctx.org.id, d, ctx.user.id);
    run('UPDATE documents SET status = ? WHERE id = ?', openStatus, d.id);
    audit(ctx, kind === 'invoice' ? 'invoice.send' : 'bill.approve', kind, d.id, { number: d.number, total: d.total });
  });
  route('POST', base + '/:id/finalize', 'write', (ctx) => { finalize(ctx, ctx.params.id); return { ok: true }; });

  route('POST', base + '/:id/void', 'write', (ctx) => {
    const d = load(ctx.org, ctx.params.id);
    if (d.status === 'draft' || d.status === 'void') throw bad('Only finalised documents can be voided');
    if (d.amount_paid > 0) throw bad('Remove payments before voiding');
    tx(() => {
      L.reverseRef(ctx.org.id, kind, d.id, today(), ctx.user.id);
      run(`UPDATE documents SET status = 'void' WHERE id = ?`, d.id);
    });
    audit(ctx, `${kind}.void`, kind, d.id, { number: d.number });
    return { ok: true };
  });

  route('POST', base + '/:id/payments', 'write', (ctx) => {
    const d = load(ctx.org, ctx.params.id);
    if (!['sent', 'open', 'partial'].includes(d.status)) throw bad(`Payments can only be recorded on unpaid ${kind}s`);
    const amount = cents(ctx.body.amount);
    if (amount <= 0) throw bad('Amount must be positive');
    if (amount > d.total - d.amount_paid) throw bad('Payment is larger than the amount due');
    const date = isDate(ctx.body.date) ? ctx.body.date : today();
    tx(() => {
      const { lastInsertRowid } = run('INSERT INTO payments (org_id, document_id, date, amount, account_id, method, reference) VALUES (?,?,?,?,?,?,?)',
        ctx.org.id, d.id, date, amount, ctx.body.account_id, str(ctx.body.method, 40), str(ctx.body.reference, 100));
      L.postPayment(ctx.org.id, d, { id: Number(lastInsertRowid), date, amount, account_id: ctx.body.account_id }, ctx.user.id);
      L.refreshDocStatus(d.id);
    });
    audit(ctx, 'payment.create', kind, d.id, { amount });
    return { ok: true };
  });
  route('DELETE', base + '/:id/payments/:pid', 'write', (ctx) => {
    const d = load(ctx.org, ctx.params.id);
    const p = get('SELECT * FROM payments WHERE id = ? AND document_id = ?', ctx.params.pid, d.id);
    if (!p) throw notFound('Payment not found');
    tx(() => {
      L.reverseRef(ctx.org.id, 'payment', p.id, today(), ctx.user.id);
      run('DELETE FROM payments WHERE id = ?', p.id);
      L.refreshDocStatus(d.id);
    });
    audit(ctx, 'payment.delete', kind, d.id, { amount: p.amount });
    return { ok: true };
  });
}

// ---------- payroll ----------
const EMP_TEXT = ['name', 'email', 'position', 'department', 'start_date', 'bank_details'];
const EMP_NUM = ['income_tax_rate', 'social_rate', 'employer_rate'];
const EMP_CENTS = ['pay_rate', 'fixed_deduction'];
route('GET', '/api/orgs/:orgId/employees', 'read', ({ org }) => all('SELECT * FROM employees WHERE org_id = ? ORDER BY active DESC, name', org.id));
function empValues(b, prev = {}) {
  const v = {};
  for (const f of EMP_TEXT) v[f] = b[f] !== undefined ? str(b[f], 1000) : prev[f] ?? null;
  for (const f of EMP_NUM) v[f] = b[f] !== undefined ? Math.max(0, Math.min(100, +b[f] || 0)) : prev[f] ?? 0;
  for (const f of EMP_CENTS) v[f] = b[f] !== undefined ? Math.max(0, cents(b[f] || 0)) : prev[f] ?? 0;
  v.pay_type = ['salary', 'hourly'].includes(b.pay_type) ? b.pay_type : prev.pay_type || 'salary';
  v.active = b.active !== undefined ? (b.active ? 1 : 0) : prev.active ?? 1;
  if (!v.name) throw bad('Employee name is required');
  return v;
}
route('POST', '/api/orgs/:orgId/employees', 'write', (ctx) => {
  const v = empValues(ctx.body);
  const keys = Object.keys(v);
  const { lastInsertRowid: id } = run(`INSERT INTO employees (org_id, ${keys.join(',')}) VALUES (?, ${keys.map(() => '?').join(',')})`, ctx.org.id, ...Object.values(v));
  audit(ctx, 'employee.create', 'employee', id, { name: v.name });
  return { id: Number(id) };
});
route('PUT', '/api/orgs/:orgId/employees/:id', 'write', (ctx) => {
  const e = get('SELECT * FROM employees WHERE id = ? AND org_id = ?', ctx.params.id, ctx.org.id);
  if (!e) throw notFound();
  const v = empValues(ctx.body, e);
  run(`UPDATE employees SET ${Object.keys(v).map((k) => k + ' = ?').join(', ')} WHERE id = ?`, ...Object.values(v), e.id);
  audit(ctx, 'employee.update', 'employee', e.id);
  return { ok: true };
});
route('DELETE', '/api/orgs/:orgId/employees/:id', 'write', (ctx) => {
  if (get('SELECT 1 FROM payslips WHERE employee_id = ? LIMIT 1', ctx.params.id)) throw bad('Employee has payslips — mark them inactive instead');
  run('DELETE FROM employees WHERE id = ? AND org_id = ?', ctx.params.id, ctx.org.id);
  audit(ctx, 'employee.delete', 'employee', ctx.params.id);
  return { ok: true };
});

const runTotals = (runId) => get(`SELECT COUNT(*) count, COALESCE(SUM(gross),0) gross, COALESCE(SUM(income_tax+social+other_deductions),0) deductions,
  COALESCE(SUM(net),0) net, COALESCE(SUM(employer_cost),0) employer_cost FROM payslips WHERE run_id = ?`, runId);
const loadRun = (org, id) => { const r = get('SELECT * FROM payroll_runs WHERE id = ? AND org_id = ?', id, org.id); if (!r) throw notFound('Payroll run not found'); return r; };

route('GET', '/api/orgs/:orgId/payroll', 'read', ({ org }) =>
  all('SELECT * FROM payroll_runs WHERE org_id = ? ORDER BY pay_date DESC, id DESC', org.id).map((r) => ({ ...r, totals: runTotals(r.id) })));
route('GET', '/api/orgs/:orgId/payroll/:id', 'read', ({ org, params }) => {
  const r = loadRun(org, params.id);
  return { ...r, totals: runTotals(r.id), org: { ...org },
    payslips: all(`SELECT p.*, e.name, e.position, e.department, e.pay_type, e.pay_rate, e.email, e.bank_details FROM payslips p JOIN employees e ON e.id = p.employee_id WHERE run_id = ? ORDER BY e.name`, r.id) };
});
route('POST', '/api/orgs/:orgId/payroll', 'write', (ctx) => {
  const b = ctx.body;
  if (!isDate(b.period_start) || !isDate(b.period_end) || !isDate(b.pay_date)) throw bad('Period start, end and pay date are required');
  if (b.period_end < b.period_start) throw bad('Period end is before period start');
  const bank = b.bank_account_id ? L.assertAccount(ctx.org.id, b.bank_account_id) : L.sysAccount(ctx.org.id, 'bank');
  const emps = all('SELECT * FROM employees WHERE org_id = ? AND active = 1', ctx.org.id);
  if (!emps.length) throw bad('Add at least one active employee first');
  const id = tx(() => {
    const rid = Number(run('INSERT INTO payroll_runs (org_id, period_start, period_end, pay_date, bank_account_id, notes) VALUES (?,?,?,?,?,?)',
      ctx.org.id, b.period_start, b.period_end, b.pay_date, bank.id, str(b.notes)).lastInsertRowid);
    for (const e of emps) {
      const s = L.computePayslip(e, { hours: e.pay_type === 'hourly' ? 160 : 0 });
      run(`INSERT INTO payslips (run_id, employee_id, hours, base, bonus, gross, income_tax, social, other_deductions, net, employer_cost) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        rid, e.id, s.hours, s.base, s.bonus, s.gross, s.income_tax, s.social, s.other_deductions, s.net, s.employer_cost);
    }
    return rid;
  });
  audit(ctx, 'payroll.create', 'payroll', id);
  return { id };
});
route('PUT', '/api/orgs/:orgId/payroll/:id/payslips/:pid', 'write', (ctx) => {
  const r = loadRun(ctx.org, ctx.params.id);
  if (r.status !== 'draft') throw bad('Payroll run is already posted');
  const p = get('SELECT * FROM payslips WHERE id = ? AND run_id = ?', ctx.params.pid, r.id);
  if (!p) throw notFound();
  const e = get('SELECT * FROM employees WHERE id = ?', p.employee_id);
  const s = L.computePayslip(e, { hours: ctx.body.hours ?? p.hours, bonus: ctx.body.bonus ?? p.bonus, other_deductions: ctx.body.other_deductions ?? p.other_deductions });
  run(`UPDATE payslips SET hours=?, base=?, bonus=?, gross=?, income_tax=?, social=?, other_deductions=?, net=?, employer_cost=? WHERE id = ?`,
    s.hours, s.base, s.bonus, s.gross, s.income_tax, s.social, s.other_deductions, s.net, s.employer_cost, p.id);
  return s;
});
route('DELETE', '/api/orgs/:orgId/payroll/:id/payslips/:pid', 'write', (ctx) => {
  const r = loadRun(ctx.org, ctx.params.id);
  if (r.status !== 'draft') throw bad('Payroll run is already posted');
  run('DELETE FROM payslips WHERE id = ? AND run_id = ?', ctx.params.pid, r.id);
  return { ok: true };
});
route('POST', '/api/orgs/:orgId/payroll/:id/post', 'write', (ctx) => {
  const r = loadRun(ctx.org, ctx.params.id);
  if (r.status !== 'draft') throw bad('Payroll run is already posted');
  tx(() => { L.postPayroll(ctx.org.id, r, ctx.user.id); run(`UPDATE payroll_runs SET status = 'posted' WHERE id = ?`, r.id); });
  audit(ctx, 'payroll.post', 'payroll', r.id, runTotals(r.id));
  return { ok: true };
});
route('POST', '/api/orgs/:orgId/payroll/:id/void', 'write', (ctx) => {
  const r = loadRun(ctx.org, ctx.params.id);
  if (r.status !== 'posted') throw bad('Only posted runs can be voided');
  tx(() => { L.reverseRef(ctx.org.id, 'payroll', r.id, today(), ctx.user.id); run(`UPDATE payroll_runs SET status = 'void' WHERE id = ?`, r.id); });
  audit(ctx, 'payroll.void', 'payroll', r.id);
  return { ok: true };
});
route('DELETE', '/api/orgs/:orgId/payroll/:id', 'write', (ctx) => {
  const r = loadRun(ctx.org, ctx.params.id);
  if (r.status === 'posted') throw bad('Void the run before deleting it');
  run('DELETE FROM payroll_runs WHERE id = ?', r.id);
  audit(ctx, 'payroll.delete', 'payroll', r.id);
  return { ok: true };
});

// ---------- budgets ----------
route('GET', '/api/orgs/:orgId/budgets', 'read', ({ org, query }) => L.budgetVsActual(org.id, +query.year || new Date().getFullYear()));
route('PUT', '/api/orgs/:orgId/budgets', 'write', (ctx) => {
  const year = +ctx.body.year;
  if (!(year > 1900 && year < 3000)) throw bad('Invalid year');
  tx(() => {
    for (const b of ctx.body.items || []) {
      L.assertAccount(ctx.org.id, b.account_id);
      run(`INSERT INTO budgets (org_id, account_id, year, amount) VALUES (?,?,?,?) ON CONFLICT(org_id, account_id, year) DO UPDATE SET amount = excluded.amount`,
        ctx.org.id, b.account_id, year, Math.max(0, cents(b.amount || 0)));
    }
  });
  audit(ctx, 'budget.update', 'budget', year);
  return { ok: true };
});

// ---------- reports ----------
const yearStart = () => today().slice(0, 4) + '-01-01';
route('GET', '/api/orgs/:orgId/dashboard', 'read', ({ org }) => {
  const t = today();
  return {
    summary: L.summary(org.id),
    series: L.monthlySeries(org.id, 12),
    overdue: all(`SELECT d.id, d.number, d.due_date, d.total - d.amount_paid due, c.name contact_name FROM documents d LEFT JOIN contacts c ON c.id = d.contact_id
      WHERE d.org_id = ? AND d.kind = 'invoice' AND d.status IN ('sent','partial') AND d.due_date < ? ORDER BY d.due_date LIMIT 8`, org.id, t),
    upcomingBills: all(`SELECT d.id, d.number, d.due_date, d.total - d.amount_paid due, c.name contact_name FROM documents d LEFT JOIN contacts c ON c.id = d.contact_id
      WHERE d.org_id = ? AND d.kind = 'bill' AND d.status IN ('open','partial') ORDER BY d.due_date LIMIT 8`, org.id),
    topExpenses: L.profitAndLoss(org.id, yearStart(), t).expenses.sort((a, b) => b.balance - a.balance).slice(0, 6),
    recent: entriesWithLines(all('SELECT * FROM journal_entries WHERE org_id = ? ORDER BY id DESC LIMIT 8', org.id)),
  };
});
route('GET', '/api/orgs/:orgId/reports/pnl', 'read', ({ org, query }) => L.profitAndLoss(org.id, query.from || yearStart(), query.to || today()));
route('GET', '/api/orgs/:orgId/reports/balance-sheet', 'read', ({ org, query }) => L.balanceSheet(org.id, query.asOf || today()));
route('GET', '/api/orgs/:orgId/reports/trial-balance', 'read', ({ org, query }) => L.trialBalance(org.id, query.asOf || today()));
route('GET', '/api/orgs/:orgId/reports/ledger', 'read', ({ org, query }) => L.generalLedger(org.id, +query.account_id, query.from || null, query.to || null));
route('GET', '/api/orgs/:orgId/reports/aging', 'read', ({ org, query }) => L.aging(org.id, query.kind === 'bill' ? 'bill' : 'invoice', query.asOf || today()));
route('GET', '/api/orgs/:orgId/reports/cashflow', 'read', ({ org, query }) => L.monthlySeries(org.id, Math.min(+query.months || 12, 36)));
route('GET', '/api/orgs/:orgId/reports/tax', 'read', ({ org, query }) => {
  const from = query.from || yearStart(), to = query.to || today();
  const b = L.accountBalances(org.id, { from, to });
  const collected = (b.find((a) => a.system_key === 'tax_out') || {}).balance || 0;
  const paid = (b.find((a) => a.system_key === 'tax_in') || {}).balance || 0;
  return { from, to, collected, paid, net: collected - paid };
});

// ---------- static files ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
function serveStatic(req, res, pathname) {
  let file = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC_DIR, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

// ---------- request handling ----------
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self'",
};

async function handle(req, res) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  const url = new URL(req.url, 'http://x');
  const pathname = decodeURIComponent(url.pathname);
  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

  try {
    const r = routes.find((x) => x.method === req.method && x.re.test(pathname));
    if (!r) throw notFound('Unknown endpoint');
    // CSRF defence: state-changing requests must be JSON sent by our own frontend.
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'ledgerly') throw new HttpError(403, 'Missing request header');
    const m = pathname.match(r.re);
    const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
    const ctx = { req, res, params, query: Object.fromEntries(url.searchParams), body: req.method === 'GET' ? {} : await readBody(req),
      ip: req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress };

    if (r.access !== 'public') {
      const token = parseCookies(req.headers.cookie).ledgerly_sid;
      const s = token && get('SELECT * FROM sessions WHERE token = ? AND expires_at > ?', token, Date.now());
      if (!s) throw new HttpError(401, 'Please sign in');
      ctx.user = get('SELECT * FROM users WHERE id = ?', s.user_id);
      ctx.token = token;
      if (!ctx.user) throw new HttpError(401, 'Please sign in');
      if (r.access === 'admin' && !ctx.user.is_admin) throw new HttpError(403, 'Administrators only');
      if (NEEDS[r.access]) {
        const mem = get('SELECT role FROM memberships WHERE user_id = ? AND org_id = ?', ctx.user.id, params.orgId);
        if (!mem) throw notFound('Organisation not found');
        if (ROLE_RANK[mem.role] < NEEDS[r.access]) throw new HttpError(403, mem.role === 'viewer' ? 'You have read-only access to this organisation' : 'Only owners can do this');
        ctx.role = mem.role;
        ctx.org = get('SELECT * FROM orgs WHERE id = ?', params.orgId);
      }
    }
    const out = await r.handler(ctx);
    if (out !== undefined && !res.headersSent) send(res, 200, out);
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: status === 500 ? 'Internal server error' : e.message });
  }
}

// Housekeeping: clear expired sessions hourly.
setInterval(() => run('DELETE FROM sessions WHERE expires_at < ?', Date.now()), 3600e3).unref();

if (require.main === module) {
  http.createServer(handle).listen(PORT, HOST, () => {
    console.log(`Ledgerly running on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}  (data: ${DATA_DIR})`);
  });
}
module.exports = { handle };
