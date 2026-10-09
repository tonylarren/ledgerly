'use strict';
/* Ledgerly frontend — dependency-free SPA. Strict CSP: no inline handlers, all events delegated. */

// ============ core helpers ============
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
const raw = (s) => new Raw(s);
const val = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(val).join('') : v == null || v === false ? '' : esc(v));
function html(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => { out += s; if (i < vals.length) out += val(vals[i]); });
  return raw(out);
}

const S = { me: null, orgs: [], org: null, accounts: null };
let ACT = {};
const canWrite = () => S.org && S.org.role !== 'viewer';
const isOwner = () => S.org && S.org.role === 'owner';

class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
async function api(method, url, body) {
  const r = await fetch(url, {
    method, credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ledgerly' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null;
  try { j = await r.json(); } catch { /* empty */ }
  if (!r.ok) {
    if (r.status === 401 && S.me && !url.startsWith('/api/auth')) { S.me = null; setTimeout(router); }
    throw new ApiError(r.status, (j && j.error) || r.statusText);
  }
  return j;
}
const GET = (u) => api('GET', u);
const O = (p) => `/api/orgs/${S.org.id}${p}`;
const oh = (p) => `#/o/${S.org.id}${p}`;

// ============ formatting ============
const fmts = {};
function money(c, cur) {
  cur = cur || (S.org && S.org.currency) || 'USD';
  try { fmts[cur] = fmts[cur] || new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }); return fmts[cur].format((c || 0) / 100); }
  catch { return ((c || 0) / 100).toFixed(2) + ' ' + cur; }
}
function moneyShort(c, cur) {
  cur = cur || (S.org && S.org.currency) || 'USD';
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, notation: 'compact', maximumFractionDigits: 1 }).format((c || 0) / 100); }
  catch { return Math.round((c || 0) / 100).toString(); }
}
const mcell = (c, cur) => html`<td class="num ${c < 0 ? 'neg' : ''}">${money(c, cur)}</td>`;
const toCents = (v) => Math.round((parseFloat(String(v).replace(',', '.')) || 0) * 100);
const fromCents = (c) => (c == null ? '' : (c / 100).toFixed(2));
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);
function fmtDate(d) {
  if (!d) return '';
  const x = new Date(d.length === 10 ? d + 'T00:00:00' : d.replace(' ', 'T') + 'Z');
  return isNaN(x) ? d : x.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
const initials = (n) => String(n || '?').split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
const TYPE_LABEL = { asset: 'Assets', liability: 'Liabilities', equity: 'Equity', income: 'Income', expense: 'Expenses' };
const STATUS_COLOR = { draft: '', sent: 'blue', open: 'blue', partial: 'amber', paid: 'green', void: '', overdue: 'red', posted: 'green' };
const badge = (s, label) => html`<span class="badge ${STATUS_COLOR[s] ?? ''}">${label || s}</span>`;
const docStatus = (d) => (d.overdue ? badge('overdue', d.status === 'partial' ? 'Partial · overdue' : 'Overdue') : badge(d.status));

// ============ icons ============
const ICONS = {
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z',
  home: 'M3 11l9-8 9 8M5 9.5V21h14V9.5',
  invoice: 'M6 2h9l5 5v15H6zM14 2v6h6M9 13h8M9 17h6',
  bill: 'M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2zM9 8h6M9 12h6',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  bank: 'M3 10l9-6 9 6M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 21h18',
  payroll: 'M2 6h20v13H2zM2 10h20M6 15h4',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  book: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5zM4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5',
  chart: 'M3 3v18h18M7 15l4-4 3 3 5-6',
  target: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68 1.65 1.65 0 0 0 10 3.17V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
  plus: 'M12 5v14M5 12h14', x: 'M18 6 6 18M6 6l12 12', menu: 'M3 6h18M3 12h18M3 18h18',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  print: 'M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6z',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  arrowIn: 'M12 5v14M5 12l7 7 7-7', arrowOut: 'M12 19V5M5 12l7-7 7 7', swap: 'M7 16V4M3 8l4-4 4 4M17 8v12M21 16l-4 4-4-4',
};
const icon = (n) => raw(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[n]}"/></svg>`);

// ============ toasts & modals ============
function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type; el.textContent = msg;
  $('#toast-root').appendChild(el);
  setTimeout(() => el.remove(), type === 'error' ? 5000 : 2600);
}
function formData(form) {
  const o = {};
  for (const el of form.elements) {
    if (!el.name || el.type === 'file') continue;
    if (el.type === 'checkbox') o[el.name] = el.checked;
    else if (el.type === 'radio') { if (el.checked) o[el.name] = el.value; }
    else o[el.name] = el.value;
  }
  return o;
}
function closeModal() { $('#modal-root').innerHTML = ''; }
function modal({ title, body, submit = 'Save', cancel = 'Cancel', wide, danger, onSubmit, onMount, extra }) {
  return new Promise((resolve) => {
    const root = $('#modal-root');
    root.innerHTML = html`<div class="modal-bg"><form class="modal ${wide ? 'wide' : ''}">
      <div class="modal-h"><h2>${title}</h2><button type="button" class="icon-btn" data-close aria-label="Close">${icon('x')}</button></div>
      <div class="modal-b">${body}<div class="err hidden" role="alert"></div></div>
      <div class="modal-f">${extra || ''}<span style="flex:1"></span><button type="button" class="btn" data-close>${cancel}</button>
        ${submit ? html`<button class="btn ${danger ? 'danger' : 'primary'}" type="submit">${submit}</button>` : ''}</div>
    </form></div>`.s;
    const form = $('form', root), err = $('.err', root);
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    const close = (v) => { root.innerHTML = ''; document.removeEventListener('keydown', onKey); resolve(v); };
    document.addEventListener('keydown', onKey);
    $$('[data-close]', root).forEach((b) => b.addEventListener('click', () => close(null)));
    root.firstElementChild.addEventListener('mousedown', (e) => { if (e.target === e.currentTarget) close(null); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('[type=submit]', form); if (btn) btn.disabled = true;
      err.classList.add('hidden');
      try { const r = onSubmit ? await onSubmit(formData(form), form) : true; close(r === undefined ? true : r); }
      catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); if (btn) btn.disabled = false; }
    });
    if (onMount) onMount(form, close);
    const f = $('input:not([type=hidden]):not([readonly]),select,textarea', $('.modal-b', root)); if (f) f.focus();
  });
}
const confirmBox = (title, message, { label = 'Confirm', danger = true } = {}) =>
  modal({ title, body: html`<p style="margin:0">${message}</p>`, submit: label, danger });

// ============ layout ============
function navLink(href, ic, label, active) { return html`<a href="${href}" class="${active ? 'active' : ''}">${icon(ic)}<span>${label}</span></a>`; }
function shell({ title, crumbs, actions, body }) {
  const path = parseHash().path;
  const inOrg = S.org && path.startsWith(`/o/${S.org.id}/`);
  const is = (p) => path.startsWith(`/o/${S.org && S.org.id}${p}`);
  const nav = inOrg ? html`
    <div class="nav-label">Overview</div>
    ${navLink(oh('/dashboard'), 'home', 'Dashboard', is('/dashboard'))}
    <div class="nav-label">Money in & out</div>
    ${navLink(oh('/invoices'), 'invoice', 'Invoices', is('/invoices'))}
    ${navLink(oh('/bills'), 'bill', 'Bills & expenses', is('/bills'))}
    ${navLink(oh('/contacts'), 'users', 'Contacts', is('/contacts'))}
    ${navLink(oh('/banking'), 'bank', 'Banking', is('/banking'))}
    ${navLink(oh('/payroll'), 'payroll', 'Payroll', is('/payroll'))}
    <div class="nav-label">Accounting</div>
    ${navLink(oh('/reports/pnl'), 'chart', 'Reports', is('/reports'))}
    ${navLink(oh('/budgets'), 'target', 'Budgets', is('/budgets'))}
    ${navLink(oh('/accounts'), 'list', 'Chart of accounts', is('/accounts'))}
    ${navLink(oh('/journal'), 'book', 'Journal', is('/journal'))}
    ${navLink(oh('/settings'), 'gear', 'Settings', is('/settings'))}` : '';
  return html`<div class="shell" id="shell">
    <aside class="sidebar">
      <a class="brand" href="#/"><img src="/favicon.svg" alt="">Ledgerly</a>
      <div class="org-switch"><select data-change="switchOrg" aria-label="Organisation">
        <option value="">All organisations</option>
        ${S.orgs.map((o) => html`<option value="${o.id}" ${inOrg && o.id === S.org.id ? 'selected' : ''}>${o.name}</option>`)}
      </select></div>
      <nav class="nav">
        ${navLink('#/', 'grid', 'All organisations', path === '/')}
        ${nav}
        ${S.me.is_admin ? html`<div class="nav-label">Instance</div>${navLink('#/admin', 'shield', 'Administration', path === '/admin')}` : ''}
      </nav>
      <div class="sidebar-foot">
        <div class="avatar">${initials(S.me.name)}</div>
        <a class="who" href="#/profile" style="color:inherit"><div style="font-weight:600">${S.me.name}</div><div class="muted small">${S.me.email}</div></a>
        <button class="icon-btn" data-act="logout" title="Sign out" aria-label="Sign out">${icon('logout')}</button>
      </div>
    </aside>
    <main class="main">
      <header class="topbar">
        <button class="btn ghost menu-btn" data-act="toggleNav" aria-label="Menu">${icon('menu')}</button>
        <div class="title">${crumbs ? html`<div class="crumbs">${crumbs}</div>` : ''}<h1>${title}</h1></div>
        <div class="actions">${actions || ''}</div>
      </header>
      <div class="content">
        ${inOrg && S.org.role === 'viewer' ? html`<div class="notice">You have <b>read-only</b> access to ${S.org.name}.</div>` : ''}
        ${body}
      </div>
    </main>
  </div>`;
}
function page(opts) { $('#app').innerHTML = shell(opts).s; window.scrollTo(0, 0); }
const btn = (label, act, { ic, cls = '', attrs = '' } = {}) => html`<button class="btn ${cls}" data-act="${act}" ${raw(attrs)}>${ic ? icon(ic) : ''}${label}</button>`;
const linkBtn = (label, href, { ic, cls = '', blank } = {}) => html`<a class="btn ${cls}" href="${href}" ${blank ? raw('target="_blank" rel="noopener"') : ''}>${ic ? icon(ic) : ''}${label}</a>`;
const field = (label, input, { full, hint } = {}) => html`<label class="field ${full ? 'full' : ''}">${label}${input}${hint ? html`<span class="hint">${hint}</span>` : ''}</label>`;
const empty = (title, text, action) => html`<div class="empty"><h3>${title}</h3><div>${text}</div>${action || ''}</div>`;
const tabs = (items, active) => html`<div class="tabs">${items.map(([k, label, href]) => html`<a href="${href}" class="${k === active ? 'active' : ''}">${label}</a>`)}</div>`;

// ============ data caches ============
async function accounts(force) {
  if (!S.accounts || force) S.accounts = await GET(O('/accounts'));
  return S.accounts;
}
function accountOptions(list, sel, blank) {
  const groups = {};
  for (const a of list) (groups[a.type] = groups[a.type] || []).push(a);
  return html`${blank ? html`<option value="">${blank}</option>` : ''}${Object.entries(groups).map(([t, xs]) =>
    html`<optgroup label="${TYPE_LABEL[t]}">${xs.map((a) => html`<option value="${a.id}" ${String(a.id) === String(sel) ? 'selected' : ''}>${a.code} · ${a.name}</option>`)}</optgroup>`)}`;
}
const live = (list) => list.filter((a) => !a.archived);
const banks = (list) => live(list).filter((a) => a.is_bank);
const contactOptions = (list, sel, blank = '— none —') => html`<option value="">${blank}</option>${list.map((c) => html`<option value="${c.id}" ${String(c.id) === String(sel) ? 'selected' : ''}>${c.name}</option>`)}`;

// ============ charts ============
function niceMax(v) { const p = Math.pow(10, Math.floor(Math.log10(v))); for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p; return v; }
function barChart(series) {
  const W = 720, H = 250, l = 60, r = 8, t = 12, b = 28, iw = W - l - r, ih = H - t - b;
  const max = niceMax(Math.max(100, ...series.flatMap((s) => [s.income, s.expense])));
  const gw = iw / series.length, bw = Math.max(3, Math.min(16, gw * 0.3));
  let g = '';
  for (let i = 0; i <= 4; i++) {
    const y = t + ih - (ih * i) / 4;
    g += `<line class="grid-line" x1="${l}" x2="${W - r}" y1="${y}" y2="${y}"/><text x="${l - 8}" y="${y + 4}" text-anchor="end">${esc(moneyShort((max * i) / 4))}</text>`;
  }
  series.forEach((s, i) => {
    const cx = l + i * gw + gw / 2;
    const hi = (s.income / max) * ih, he = (s.expense / max) * ih;
    const lab = new Date(s.month + '-01T00:00:00').toLocaleDateString(undefined, { month: 'short' });
    g += `<rect x="${cx - bw - 1}" y="${t + ih - Math.max(0, hi)}" width="${bw}" height="${Math.max(0, hi)}" rx="2" fill="var(--chart-a)"><title>${esc(s.month)} income ${esc(money(s.income))}</title></rect>`;
    g += `<rect x="${cx + 1}" y="${t + ih - Math.max(0, he)}" width="${bw}" height="${Math.max(0, he)}" rx="2" fill="var(--chart-b)"><title>${esc(s.month)} expenses ${esc(money(s.expense))}</title></rect>`;
    g += `<text x="${cx}" y="${H - 8}" text-anchor="middle">${esc(lab)}</text>`;
  });
  return raw(`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Income and expenses by month">${g}</svg>`);
}
function sparkline(vals) {
  const W = 120, H = 34, min = Math.min(0, ...vals), max = Math.max(1, ...vals), span = max - min || 1;
  const pts = vals.map((v, i) => `${(i / Math.max(1, vals.length - 1)) * W},${H - 3 - ((v - min) / span) * (H - 6)}`).join(' ');
  const zero = H - 3 - ((0 - min) / span) * (H - 6);
  return raw(`<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true"><line x1="0" x2="${W}" y1="${zero}" y2="${zero}" stroke="var(--border)" stroke-dasharray="2 3"/><polyline points="${pts}" fill="none" stroke="var(--chart-a)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>`);
}
const legend = () => html`<div class="legend"><span><i style="background:var(--chart-a)"></i>Income</span><span><i style="background:var(--chart-b)"></i>Expenses</span></div>`;

// ============ CSV ============
function downloadCsv(name, rows) {
  const csv = rows.map((r) => r.map((c) => { const s = String(c ?? ''); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
  a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function parseCSV(text) {
  const first = text.split('\n')[0];
  const delim = [';', '\t', ','].sort((a, b) => first.split(b).length - first.split(a).length)[0];
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}
function parseAmount(s) {
  s = String(s || '').trim();
  const neg = /^\(.*\)$/.test(s) || /^-/.test(s) || /-$/.test(s);
  s = s.replace(/[^\d.,]/g, '');
  if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (s.includes(',')) s = /,\d{1,2}$/.test(s) ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  const n = Math.round((parseFloat(s) || 0) * 100);
  return neg ? -n : n;
}
function parseDate(s, fmt) {
  s = String(s || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const p = s.split(/[\/.\-]/).map((x) => x.padStart(2, '0'));
  if (p.length !== 3) return null;
  let [a, b, c] = p; if (c.length === 2) c = '20' + c;
  return fmt === 'mdy' ? `${c}-${a}-${b}` : `${c}-${b}-${a}`;
}

// ============ router ============
function parseHash() {
  const h = location.hash.slice(1) || '/';
  const [path, q = ''] = h.split('?');
  return { path: path || '/', query: Object.fromEntries(new URLSearchParams(q)) };
}
const ROUTES = [];
function r(pattern, fn) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  ROUTES.push({ re, keys, fn });
}
const go = (h) => { location.hash = h.replace(/^#/, ''); };

async function router() {
  ACT = {};
  closeModal();
  $('#shell') && $('#shell').classList.remove('nav-open');
  if (!S.me) {
    try { const me = await GET('/api/me'); S.me = me.user; S.orgs = me.orgs; }
    catch { return pageAuth(); }
  }
  const { path, query } = parseHash();
  for (const rt of ROUTES) {
    const m = path.match(rt.re);
    if (!m) continue;
    const params = Object.fromEntries(rt.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    params.query = query;
    try {
      if (params.org) {
        if (!S.org || S.org.id !== +params.org) { S.org = await GET(`/api/orgs/${+params.org}`); S.accounts = null; }
      }
      await rt.fn(params);
    } catch (e) {
      if (e.status === 401) return;
      page({ title: 'Something went wrong', body: html`<div class="card card-b"><p>${e.message}</p><a class="btn" href="#/">Back to all organisations</a></div>` });
    }
    return;
  }
  page({ title: 'Page not found', body: html`<div class="card card-b"><a class="btn" href="#/">Go home</a></div>` });
}
async function refreshMe() { const me = await GET('/api/me'); S.me = me.user; S.orgs = me.orgs; }

// Global event delegation
const GLOBAL = {
  logout: async () => { await api('POST', '/api/auth/logout'); S.me = null; S.org = null; go('#/'); router(); },
  toggleNav: () => $('#shell').classList.toggle('nav-open'),
  print: () => window.print(),
  back: () => history.back(),
};
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-act]');
  const link = e.target.closest('a[href]');
  if (link && a && link !== a && a.contains(link)) return; // let links inside clickable rows work
  if (a && !a.closest('#modal-root form')) {
    const fn = ACT[a.dataset.act] || GLOBAL[a.dataset.act];
    if (fn) { e.preventDefault(); Promise.resolve(fn(a, e)).catch((err) => toast(err.message, 'error')); }
    return;
  }
  const row = e.target.closest('[data-href]');
  if (row && !e.target.closest('a,button,input,select,textarea')) go(row.dataset.href);
});
document.addEventListener('change', (e) => {
  const a = e.target.closest('[data-change]');
  if (!a) return;
  if (a.dataset.change === 'switchOrg') return go(a.value ? `#/o/${a.value}/dashboard` : '#/');
  const fn = ACT[a.dataset.change];
  if (fn) Promise.resolve(fn(a, e)).catch((err) => toast(err.message, 'error'));
});
document.addEventListener('submit', (e) => {
  const f = e.target.closest('form[data-submit]');
  if (!f) return;
  e.preventDefault();
  const fn = ACT[f.dataset.submit];
  if (fn) Promise.resolve(fn(formData(f), f)).catch((err) => toast(err.message, 'error'));
});
window.addEventListener('hashchange', router);

// theme
function applyTheme() {
  let t = 'system'; try { t = localStorage.getItem('ledgerly-theme') || 'system'; } catch { /* storage blocked */ }
  if (t === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
}
applyTheme();

// ============ auth ============
async function pageAuth() {
  let setup = { needsSetup: false, allowSignup: false };
  try { setup = await GET('/api/setup'); } catch { /* offline */ }
  const mode = setup.needsSetup ? 'setup' : parseHash().query.register && setup.allowSignup ? 'register' : 'login';
  const reg = mode !== 'login';
  $('#app').innerHTML = html`<div class="auth"><form class="card" id="auth-form">
    <div class="brand"><img src="/favicon.svg" alt="">Ledgerly</div>
    <h2 style="margin-bottom:4px">${mode === 'setup' ? 'Create the administrator account' : reg ? 'Create your account' : 'Sign in'}</h2>
    <p class="muted" style="margin:0 0 18px">${mode === 'setup' ? 'This is a fresh installation. The first account becomes the instance administrator.' : reg ? 'Join this Ledgerly instance.' : 'Welcome back.'}</p>
    <div class="stack">
      ${reg ? field('Full name', html`<input name="name" required autocomplete="name">`) : ''}
      ${field('Email', html`<input name="email" type="email" required autocomplete="email">`)}
      ${field('Password', html`<input name="password" type="password" required minlength="${reg ? 8 : 1}" autocomplete="${reg ? 'new-password' : 'current-password'}">`, { hint: reg ? 'At least 8 characters' : '' })}
    </div>
    <div class="err hidden" role="alert"></div>
    <button class="btn primary" style="width:100%;justify-content:center;margin-top:18px" type="submit">${reg ? 'Create account' : 'Sign in'}</button>
    ${mode === 'login' && setup.allowSignup ? html`<p class="small muted" style="text-align:center;margin:14px 0 0">No account? <a href="#/?register=1">Register</a></p>` : ''}
    ${mode === 'register' ? html`<p class="small muted" style="text-align:center;margin:14px 0 0"><a href="#/">Back to sign in</a></p>` : ''}
  </form></div>`.s;
  const f = $('#auth-form');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('.err', f);
    try {
      await api('POST', reg ? '/api/auth/register' : '/api/auth/login', formData(f));
      await refreshMe(); go('#/'); router();
    } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
  });
  $('input', f).focus();
}

// ============ portfolio (all orgs) ============
async function newOrgModal() {
  const res = await modal({
    title: 'New organisation',
    body: html`<div class="form-grid">
      ${field('Name', html`<input name="name" required placeholder="Acme Ltd">`, { full: true })}
      ${field('Currency', html`<input name="currency" value="USD" maxlength="3" required pattern="[A-Za-z]{3}">`, { hint: 'ISO code, e.g. USD, EUR, GBP, XOF' })}
      ${field('Default sales tax %', html`<input name="default_tax_rate" type="number" step="any" min="0" value="0">`)}
    </div><p class="hint" style="margin:14px 0 0">A standard chart of accounts is created automatically. You can edit it later.</p>`,
    submit: 'Create',
    onSubmit: (d) => api('POST', '/api/orgs', d),
  });
  if (res && res.id) { await refreshMe(); go(`#/o/${res.id}/dashboard`); }
}
r('/', async () => {
  S.org = null;
  const list = await GET('/api/portfolio');
  ACT.newOrg = newOrgModal;
  page({
    title: 'All organisations', crumbs: `${list.length} organisation${list.length === 1 ? '' : 's'}`,
    actions: btn('New organisation', 'newOrg', { ic: 'plus', cls: 'primary' }),
    body: list.length ? html`<div class="grid g3">${list.map((o) => html`
      <div class="card org-card" data-href="#/o/${o.id}/dashboard">
        <div class="split"><div><h2>${o.name}</h2><div class="muted small">${o.currency}</div></div><span class="badge ${o.role === 'owner' ? 'teal' : o.role === 'viewer' ? '' : 'blue'}">${o.role}</span></div>
        <div class="metrics">
          <div><div class="label">Cash</div><div class="v">${money(o.summary.cash, o.currency)}</div></div>
          <div><div class="label">Net income YTD</div><div class="v ${o.summary.ytdNet < 0 ? 'neg' : 'pos'}">${money(o.summary.ytdNet, o.currency)}</div></div>
          <div><div class="label">Receivable</div><div class="v">${money(o.summary.ar, o.currency)}</div></div>
          <div><div class="label">Payable</div><div class="v">${money(o.summary.ap, o.currency)}</div></div>
        </div>
        <div class="split"><span class="muted small">Net, last 6 months${o.summary.overdue ? html` · <span class="neg">${money(o.summary.overdue, o.currency)} overdue</span>` : ''}</span>${sparkline(o.series.map((s) => s.net))}</div>
      </div>`)}</div>`
      : html`<div class="card">${empty('No organisations yet', 'Create a company, household or project to start tracking its finances.', btn('Create organisation', 'newOrg', { ic: 'plus', cls: 'primary' }))}</div>`,
  });
});

// ============ dashboard ============
r('/o/:org', (p) => go(`#/o/${p.org}/dashboard`));
r('/o/:org/dashboard', async () => {
  const d = await GET(O('/dashboard'));
  const s = d.summary;
  const maxExp = Math.max(1, ...d.topExpenses.map((e) => e.balance));
  const listRows = (rows, kind) => rows.length ? html`<table class="compact"><tbody>${rows.map((x) => html`
    <tr class="click" data-href="${oh(`/${kind}s/${x.id}`)}"><td><div style="font-weight:550">${x.contact_name || '—'}</div><div class="muted small">${x.number} · due ${fmtDate(x.due_date)}</div></td>${mcell(x.due)}</tr>`)}</tbody></table>`
    : html`<div class="empty" style="padding:24px">Nothing here 🎉</div>`;
  page({
    title: S.org.name, crumbs: 'Dashboard',
    actions: canWrite() ? html`${linkBtn('New invoice', oh('/invoices/new'), { ic: 'plus', cls: 'primary' })}${linkBtn('New bill', oh('/bills/new'), { ic: 'plus' })}` : '',
    body: html`
      <div class="grid g4">
        <div class="card kpi"><div class="label">Cash & bank</div><div class="value">${money(s.cash)}</div><div class="sub">Across all bank accounts</div></div>
        <div class="card kpi"><div class="label">Receivables</div><div class="value">${money(s.ar)}</div><div class="sub">${s.arCount} open · ${s.overdue ? html`<span class="neg">${money(s.overdue)} overdue</span>` : 'none overdue'}</div></div>
        <div class="card kpi"><div class="label">Payables</div><div class="value">${money(s.ap)}</div><div class="sub">${s.apCount} unpaid bill${s.apCount === 1 ? '' : 's'}</div></div>
        <div class="card kpi"><div class="label">Net income (YTD)</div><div class="value ${s.ytdNet < 0 ? 'neg' : 'pos'}">${money(s.ytdNet)}</div><div class="sub">This month ${money(s.mtdNet)}</div></div>
      </div>
      <div class="grid g-main">
        <div class="card"><div class="card-h"><h3>Income vs expenses, last 12 months</h3>${legend()}</div><div class="card-b">${barChart(d.series)}</div></div>
        <div class="card"><div class="card-h"><h3>Top expenses (YTD)</h3><a class="small" href="${oh('/reports/pnl')}">P&L →</a></div><div class="card-b stack">
          ${d.topExpenses.length ? d.topExpenses.map((e) => html`<div class="bar-row"><span>${e.name}</span><span class="num">${money(e.balance)}</span><div class="bar-track"><div class="bar-fill" style="width:${(e.balance / maxExp) * 100}%"></div></div></div>`) : html`<div class="muted">No expenses recorded yet.</div>`}
        </div></div>
      </div>
      <div class="grid g3">
        <div class="card"><div class="card-h"><h3>Overdue invoices</h3><a class="small" href="${oh('/invoices?status=overdue')}">All →</a></div>${listRows(d.overdue, 'invoice')}</div>
        <div class="card"><div class="card-h"><h3>Bills to pay</h3><a class="small" href="${oh('/bills?status=open')}">All →</a></div>${listRows(d.upcomingBills, 'bill')}</div>
        <div class="card"><div class="card-h"><h3>Recent activity</h3><a class="small" href="${oh('/journal')}">Journal →</a></div>
          ${d.recent.length ? html`<table class="compact"><tbody>${d.recent.map((e) => html`<tr><td><div style="font-weight:550">${e.memo || 'Journal entry'}</div><div class="muted small">${fmtDate(e.date)}</div></td>${mcell(e.total)}</tr>`)}</tbody></table>` : html`<div class="empty" style="padding:24px">No transactions yet.</div>`}
        </div>
      </div>
      <p class="muted small" style="margin-top:18px">${s.employees} active employee${s.employees === 1 ? '' : 's'} · YTD income ${money(s.ytdIncome)} · YTD expenses ${money(s.ytdExpenses)}</p>`,
  });
});

// ============ invoices & bills ============
const DOC = {
  invoice: { label: 'Invoice', plural: 'Invoices', path: 'invoices', party: 'Customer', kind: 'customer', finalize: 'Mark as sent', open: 'sent', accType: 'income', partyHead: 'Bill to' },
  bill: { label: 'Bill', plural: 'Bills & expenses', path: 'bills', party: 'Vendor', kind: 'vendor', finalize: 'Approve', open: 'open', accType: 'expense', partyHead: 'From' },
};
for (const kind of ['invoice', 'bill']) {
  const D = DOC[kind];
  r(`/o/:org/${D.path}`, (p) => pageDocList(kind, p.query));
  r(`/o/:org/${D.path}/new`, (p) => pageDocEdit(kind, null, p.query));
  r(`/o/:org/${D.path}/:id/edit`, (p) => pageDocEdit(kind, p.id));
  r(`/o/:org/${D.path}/:id`, (p) => pageDocView(kind, p.id));
  r(`/print/:org/${kind}/:id`, (p) => pagePrintDoc(kind, p.id, p.query));
}

async function pageDocList(kind, q) {
  const D = DOC[kind];
  const status = q.status || '';
  const all = await GET(O(`/${D.path}`));
  const rows = status === 'overdue' ? all.filter((d) => d.overdue) : status ? all.filter((d) => d.status === status) : all;
  const open = all.filter((d) => ['sent', 'open', 'partial'].includes(d.status));
  const sum = (xs) => xs.reduce((s, d) => s + d.total - d.amount_paid, 0);
  const T = (k, label) => [k, label, oh(`/${D.path}${k ? '?status=' + k : ''}`)];
  page({
    title: D.plural,
    actions: canWrite() ? linkBtn(`New ${D.label.toLowerCase()}`, oh(`/${D.path}/new`), { ic: 'plus', cls: 'primary' }) : '',
    body: html`
      <div class="grid g3">
        <div class="card kpi"><div class="label">Outstanding</div><div class="value">${money(sum(open))}</div><div class="sub">${open.length} open</div></div>
        <div class="card kpi"><div class="label">Overdue</div><div class="value ${sum(all.filter((d) => d.overdue)) ? 'neg' : ''}">${money(sum(all.filter((d) => d.overdue)))}</div><div class="sub">${all.filter((d) => d.overdue).length} ${D.plural.toLowerCase().split(' ')[0]}</div></div>
        <div class="card kpi"><div class="label">Drafts</div><div class="value">${all.filter((d) => d.status === 'draft').length}</div><div class="sub">Not yet ${kind === 'invoice' ? 'sent' : 'approved'}</div></div>
      </div>
      <div class="card" style="margin-top:18px"><div style="padding:0 14px">${tabs([T('', 'All'), T('draft', 'Draft'), T(D.open, kind === 'invoice' ? 'Sent' : 'Open'), T('partial', 'Partially paid'), T('overdue', 'Overdue'), T('paid', 'Paid'), T('void', 'Void')], status)}</div>
      ${rows.length ? html`<div class="table-wrap" style="margin-top:-18px"><table><thead><tr><th>Number</th><th>${D.party}</th><th>Issued</th><th>Due</th><th class="num">Total</th><th class="num">Balance due</th><th>Status</th></tr></thead><tbody>
        ${rows.map((d) => html`<tr class="click" data-href="${oh(`/${D.path}/${d.id}`)}"><td class="mono">${d.number}</td><td>${d.contact_name || '—'}</td><td>${fmtDate(d.issue_date)}</td><td>${fmtDate(d.due_date)}</td>${mcell(d.total)}${mcell(d.status === 'void' ? 0 : d.total - d.amount_paid)}<td>${docStatus(d)}</td></tr>`)}
      </tbody></table></div>` : empty(`No ${D.plural.toLowerCase()} here`, status ? 'Try another filter.' : `Create your first ${D.label.toLowerCase()} to get started.`, canWrite() && !status ? linkBtn(`New ${D.label.toLowerCase()}`, oh(`/${D.path}/new`), { ic: 'plus', cls: 'primary' }) : '')}
      </div>`,
  });
}

async function contactModal(c = {}, kindDefault = 'customer') {
  const isNew = !c.id;
  let deleted = false;
  const res = await modal({
    title: isNew ? 'New contact' : c.name,
    body: html`<div class="form-grid">
      ${field('Name', html`<input name="name" required value="${c.name || ''}">`, { full: true })}
      ${field('Type', html`<select name="kind">${['customer', 'vendor', 'both'].map((k) => html`<option value="${k}" ${(c.kind || kindDefault) === k ? 'selected' : ''}>${k === 'both' ? 'Customer & vendor' : k[0].toUpperCase() + k.slice(1)}</option>`)}</select>`)}
      ${field('Tax ID', html`<input name="tax_id" value="${c.tax_id || ''}">`)}
      ${field('Email', html`<input name="email" type="email" value="${c.email || ''}">`)}
      ${field('Phone', html`<input name="phone" value="${c.phone || ''}">`)}
      ${field('Address', html`<textarea name="address" rows="3">${c.address || ''}</textarea>`, { full: true })}
      ${field('Notes', html`<textarea name="notes" rows="2">${c.notes || ''}</textarea>`, { full: true })}
    </div>`,
    extra: !isNew && canWrite() ? html`<button type="button" class="btn danger" id="del-contact">Delete</button>` : '',
    onSubmit: canWrite() ? (d) => (isNew ? api('POST', O('/contacts'), d) : api('PUT', O(`/contacts/${c.id}`), d)) : null,
    submit: canWrite() ? 'Save' : null,
    onMount: (form, close) => {
      const del = $('#del-contact', form);
      if (del) del.addEventListener('click', async () => {
        try { await api('DELETE', O(`/contacts/${c.id}`)); deleted = true; close(true); toast('Contact deleted'); }
        catch (e) { $('.err', form).textContent = e.message; $('.err', form).classList.remove('hidden'); }
      });
    },
  });
  return deleted ? { deleted } : res;
}

function itemRow(kind, accs, it = {}) {
  return html`<tr>
    <td><input name="description" value="${it.description || ''}" placeholder="Description" aria-label="Description"></td>
    <td style="width:210px"><select name="account_id" aria-label="Account">${accountOptions(live(accs).filter((a) => a.type === DOC[kind].accType), it.account_id, 'Default account')}</select></td>
    <td style="width:80px"><input name="quantity" type="number" step="any" class="num" value="${it.quantity ?? 1}" aria-label="Quantity"></td>
    <td style="width:120px"><input name="unit_price" type="number" step="0.01" class="num" value="${it.unit_price != null ? fromCents(it.unit_price) : ''}" placeholder="0.00" aria-label="Unit price"></td>
    <td style="width:80px"><input name="tax_rate" type="number" step="any" min="0" class="num" value="${it.tax_rate ?? S.org.default_tax_rate}" aria-label="Tax %"></td>
    <td class="num amt" style="width:120px"></td>
    <td style="width:34px"><button type="button" class="icon-btn" data-rm aria-label="Remove line">${icon('x')}</button></td>
  </tr>`;
}

async function pageDocEdit(kind, id, q = {}) {
  const D = DOC[kind];
  const [accs, contacts, doc] = await Promise.all([accounts(), GET(O(`/contacts?kind=${D.kind}`)), id ? GET(O(`/${D.path}/${id}`)) : null]);
  if (doc && doc.status !== 'draft') return go(oh(`/${D.path}/${id}`));
  const d = doc || { issue_date: today(), due_date: addDays(today(), S.org.payment_terms), items: [{}], contact_id: q.contact_id };
  page({
    title: doc ? `Edit ${doc.number}` : `New ${D.label.toLowerCase()}`,
    crumbs: html`<a href="${oh('/' + D.path)}">${D.plural}</a>`,
    body: html`<form id="doc-form" class="card"><div class="card-b">
      <div class="form-grid cols4">
        <label class="field" style="grid-column:span 2">${D.party}
          <div class="row" style="flex-wrap:nowrap"><select name="contact_id" required>${contactOptions(contacts, d.contact_id, `Select ${D.party.toLowerCase()}…`)}</select>
          <button type="button" class="btn" id="new-contact" title="New ${D.party.toLowerCase()}">${icon('plus')}</button></div></label>
        ${field('Number', html`<input name="number" value="${doc ? doc.number : ''}" placeholder="Auto">`)}
        ${field('Reference', html`<input name="reference" value="${d.reference || ''}" placeholder="PO / order #">`)}
        ${field('Issue date', html`<input name="issue_date" type="date" required value="${d.issue_date}">`)}
        ${field('Due date', html`<input name="due_date" type="date" required value="${d.due_date}">`)}
      </div>
      <div class="table-wrap" style="margin-top:22px"><table class="lines-table"><thead><tr><th>Item</th><th>Account</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Tax %</th><th class="num">Amount</th><th></th></tr></thead>
        <tbody id="items">${d.items.map((it) => itemRow(kind, accs, it))}</tbody></table></div>
      <button type="button" class="btn sm" id="add-line" style="margin-top:10px">${icon('plus')}Add line</button>
      <div class="grid g2" style="margin-top:20px;align-items:start">
        ${field('Notes / payment instructions', html`<textarea name="notes" rows="4">${d.notes || ''}</textarea>`)}
        <div class="stack" style="font-variant-numeric:tabular-nums">
          <div class="split"><span class="muted">Subtotal</span><b id="t-sub"></b></div>
          <div class="split"><span class="muted">Tax</span><b id="t-tax"></b></div>
          <div class="split" style="font-size:18px;border-top:1px solid var(--border);padding-top:10px"><span>Total</span><b id="t-total"></b></div>
        </div>
      </div>
    </div>
    <div class="modal-f"><div class="err hidden" id="doc-err" style="margin:0 auto 0 0"></div>
      <a class="btn" href="${doc ? oh(`/${D.path}/${doc.id}`) : oh('/' + D.path)}">Cancel</a>
      <button class="btn" type="submit" name="mode" value="draft">Save draft</button>
      <button class="btn primary" type="submit" name="mode" value="final">Save & ${D.finalize.toLowerCase()}</button></div>
    </form>`,
  });
  const form = $('#doc-form'), body = $('#items');
  const recalc = () => {
    let sub = 0, tax = 0;
    for (const tr of $$('tr', body)) {
      const line = Math.round((+$('[name=quantity]', tr).value || 0) * toCents($('[name=unit_price]', tr).value));
      const t = Math.round((line * (+$('[name=tax_rate]', tr).value || 0)) / 100);
      sub += line; tax += t;
      $('.amt', tr).textContent = money(line);
    }
    $('#t-sub').textContent = money(sub); $('#t-tax').textContent = money(tax); $('#t-total').textContent = money(sub + tax);
  };
  body.addEventListener('input', recalc);
  body.addEventListener('click', (e) => { if (e.target.closest('[data-rm]')) { if ($$('tr', body).length > 1) e.target.closest('tr').remove(); recalc(); } });
  $('#add-line').addEventListener('click', () => { body.insertAdjacentHTML('beforeend', itemRow(kind, accs).s); recalc(); $('tr:last-child input', body).focus(); });
  $('[name=issue_date]', form).addEventListener('change', (e) => { if (!doc) $('[name=due_date]', form).value = addDays(e.target.value, S.org.payment_terms); });
  $('#new-contact').addEventListener('click', async () => {
    const res = await contactModal({}, D.kind);
    if (res && res.id) { const list = await GET(O(`/contacts?kind=${D.kind}`)); $('[name=contact_id]', form).innerHTML = contactOptions(list, res.id, `Select ${D.party.toLowerCase()}…`).s; }
  });
  recalc();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = formData(form);
    const items = $$('tr', body).map((tr) => ({
      description: $('[name=description]', tr).value, account_id: $('[name=account_id]', tr).value || null,
      quantity: +$('[name=quantity]', tr).value || 0, unit_price: toCents($('[name=unit_price]', tr).value), tax_rate: +$('[name=tax_rate]', tr).value || 0,
    })).filter((i) => i.description.trim());
    const payload = { contact_id: fd.contact_id, number: fd.number, reference: fd.reference, issue_date: fd.issue_date, due_date: fd.due_date, notes: fd.notes, items };
    const final = e.submitter && e.submitter.value === 'final';
    try {
      let docId = doc && doc.id;
      if (doc) await api('PUT', O(`/${D.path}/${doc.id}`), payload);
      else docId = (await api('POST', O(`/${D.path}`), payload)).id;
      if (final) await api('POST', O(`/${D.path}/${docId}/finalize`));
      toast(final ? `${D.label} ${kind === 'invoice' ? 'sent' : 'approved'} and posted to the ledger` : 'Draft saved');
      go(oh(`/${D.path}/${docId}`));
    } catch (ex) { const er = $('#doc-err'); er.textContent = ex.message; er.classList.remove('hidden'); }
  });
}

function docHtml(kind, d, org) {
  const D = DOC[kind], cur = org.currency;
  const due = d.total - d.amount_paid;
  return html`<div class="doc">
    <div class="doc-head">
      <div><div class="doc-title">${kind === 'invoice' ? 'INVOICE' : 'BILL'}</div>
        <div style="margin-top:10px;font-weight:600">${kind === 'invoice' ? org.legal_name || org.name : d.contact_name}</div>
        <div style="font-size:13px;color:#4b5563;white-space:pre-line">${kind === 'invoice' ? [org.address, org.email, org.phone, org.tax_id && 'Tax ID: ' + org.tax_id].filter(Boolean).join('\n') : ''}</div></div>
      <div class="meta"><span>Number</span><b>${d.number}</b><span>Issue date</span><span>${fmtDate(d.issue_date)}</span><span>Due date</span><span>${fmtDate(d.due_date)}</span>${d.reference ? html`<span>Reference</span><span>${d.reference}</span>` : ''}</div>
    </div>
    <div class="parties">
      <div><h4>${D.partyHead}</h4><b>${kind === 'invoice' ? d.contact_name : org.legal_name || org.name}</b>
${kind === 'invoice' ? [d.contact_address, d.contact_email, d.contact_tax_id && 'Tax ID: ' + d.contact_tax_id].filter(Boolean).join('\n') : ''}</div>
      <div style="text-align:right"><h4>Amount due</h4><div style="font-size:24px;font-weight:700">${money(d.status === 'void' ? 0 : due, cur)}</div></div>
    </div>
    <table><thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Tax</th><th class="num">Amount</th></tr></thead><tbody>
      ${d.items.map((i) => html`<tr><td>${i.description}</td><td class="num">${i.quantity}</td><td class="num">${money(i.unit_price, cur)}</td><td class="num">${i.tax_rate}%</td><td class="num">${money(Math.round(i.quantity * i.unit_price), cur)}</td></tr>`)}
    </tbody></table>
    <div class="totals">
      <div><span>Subtotal</span><span>${money(d.subtotal, cur)}</span></div>
      <div><span>Tax</span><span>${money(d.tax, cur)}</span></div>
      <div class="grand"><span>Total</span><span>${money(d.total, cur)}</span></div>
      ${d.amount_paid ? html`<div><span>Paid</span><span>− ${money(d.amount_paid, cur)}</span></div><div><b>Balance due</b><b>${money(due, cur)}</b></div>` : ''}
    </div>
    ${d.notes || (kind === 'invoice' && org.invoice_footer) ? html`<div class="foot">${[d.notes, kind === 'invoice' ? org.invoice_footer : ''].filter(Boolean).join('\n\n')}</div>` : ''}
  </div>`;
}

async function paymentModal(kind, d) {
  const accs = await accounts();
  return modal({
    title: kind === 'invoice' ? 'Record payment received' : 'Record payment made',
    body: html`<div class="form-grid">
      ${field('Amount', html`<input name="amount" type="number" step="0.01" min="0.01" required value="${fromCents(d.total - d.amount_paid)}">`)}
      ${field('Date', html`<input name="date" type="date" required value="${today()}">`)}
      ${field(kind === 'invoice' ? 'Deposit to' : 'Paid from', html`<select name="account_id" required>${accountOptions(banks(accs), (accs.find((a) => a.system_key === 'bank') || {}).id)}</select>`)}
      ${field('Method', html`<select name="method">${['Bank transfer', 'Card', 'Cash', 'Cheque', 'Mobile money', 'Other'].map((m) => html`<option>${m}</option>`)}</select>`)}
      ${field('Reference', html`<input name="reference">`, { full: true })}
    </div>`,
    submit: 'Record payment',
    onSubmit: (f) => api('POST', O(`/${DOC[kind].path}/${d.id}/payments`), { ...f, amount: toCents(f.amount) }),
  });
}

async function pageDocView(kind, id) {
  const D = DOC[kind];
  const d = await GET(O(`/${D.path}/${id}`));
  const w = canWrite();
  const reload = () => router();
  ACT.finalize = async () => { await api('POST', O(`/${D.path}/${id}/finalize`)); toast(`${D.label} posted to the ledger`); reload(); };
  ACT.del = async () => { if (await confirmBox(`Delete ${d.number}?`, 'This draft will be permanently removed.', { label: 'Delete' })) { await api('DELETE', O(`/${D.path}/${id}`)); toast('Deleted'); go(oh('/' + D.path)); } };
  ACT.void = async () => { if (await confirmBox(`Void ${d.number}?`, 'A reversing journal entry will be posted. This cannot be undone.', { label: 'Void' })) { await api('POST', O(`/${D.path}/${id}/void`)); toast('Voided'); reload(); } };
  ACT.pay = async () => { if (await paymentModal(kind, d)) { toast('Payment recorded'); reload(); } };
  ACT.delPay = async (el) => { if (await confirmBox('Remove payment?', 'The payment will be reversed in the ledger.', { label: 'Remove' })) { await api('DELETE', O(`/${D.path}/${id}/payments/${el.dataset.id}`)); reload(); } };
  ACT.dup = () => go(oh(`/${D.path}/new?contact_id=${d.contact_id}`));
  const open = ['sent', 'open', 'partial'].includes(d.status);
  page({
    title: `${D.label} ${d.number}`, crumbs: html`<a href="${oh('/' + D.path)}">${D.plural}</a>`,
    actions: html`
      ${linkBtn('Print / PDF', `#/print/${S.org.id}/${kind}/${d.id}?auto=1`, { ic: 'print', blank: true })}
      ${w && d.status === 'draft' ? html`${btn('Delete', 'del', { cls: 'danger' })}${linkBtn('Edit', oh(`/${D.path}/${d.id}/edit`))}${btn(D.finalize, 'finalize', { cls: 'primary' })}` : ''}
      ${w && open && !d.amount_paid ? btn('Void', 'void', { cls: 'danger' }) : ''}
      ${w && open ? btn('Record payment', 'pay', { cls: 'primary' }) : ''}`,
    body: html`<div class="grid g-side">
      <div>${docHtml(kind, d, d.org)}</div>
      <div class="stack">
        <div class="card card-b stack">
          <div class="split"><span class="muted">Status</span>${docStatus({ ...d, overdue: open && d.due_date < today() })}</div>
          <div class="split"><span class="muted">${D.party}</span><b>${d.contact_name}</b></div>
          <div class="split"><span class="muted">Total</span><b>${money(d.total)}</b></div>
          <div class="split"><span class="muted">Paid</span><b>${money(d.amount_paid)}</b></div>
          <div class="split"><span class="muted">Balance</span><b>${money(d.status === 'void' ? 0 : d.total - d.amount_paid)}</b></div>
        </div>
        <div class="card"><div class="card-h"><h3>Payments</h3></div>
          ${d.payments.length ? html`<table class="compact"><tbody>${d.payments.map((p) => html`<tr><td><div>${fmtDate(p.date)}</div><div class="muted small">${p.method || ''} · ${p.account_name}</div></td>${mcell(p.amount)}<td style="width:30px">${w ? html`<button class="icon-btn" data-act="delPay" data-id="${p.id}" aria-label="Remove payment">${icon('x')}</button>` : ''}</td></tr>`)}</tbody></table>`
            : html`<div class="card-b muted small">No payments yet.</div>`}
        </div>
        ${w ? html`<button class="btn" data-act="dup" style="justify-content:center">New ${D.label.toLowerCase()} for ${d.contact_name}</button>` : ''}
        <p class="muted small" style="margin:0">${d.status === 'draft' ? `Drafts don't affect your books. ${D.finalize} to post it to the ledger.` : 'Posted to the ledger. Finalised documents are locked — void and recreate to change them.'}</p>
      </div></div>`,
  });
}

async function pagePrintDoc(kind, id, q) {
  const d = await GET(O(`/${DOC[kind].path}/${id}`));
  $('#app').innerHTML = html`<div class="print-page"><div class="print-bar no-print"><button class="btn" data-act="back">Back</button><button class="btn primary" data-act="print">${icon('print')}Print / Save as PDF</button></div>${docHtml(kind, d, d.org)}</div>`.s;
  document.title = `${DOC[kind].label} ${d.number}`;
  if (q.auto) setTimeout(() => window.print(), 300);
}

// ============ contacts ============
r('/o/:org/contacts', async ({ query }) => {
  const kind = query.kind || '';
  const list = await GET(O(`/contacts${kind ? '?kind=' + kind : ''}`));
  ACT.add = async () => { if (await contactModal({}, kind || 'customer')) router(); };
  ACT.edit = async (el) => { if (await contactModal(list.find((c) => c.id === +el.dataset.id))) router(); };
  page({
    title: 'Contacts', actions: canWrite() ? btn('New contact', 'add', { ic: 'plus', cls: 'primary' }) : '',
    body: html`<div class="card"><div style="padding:0 14px">${tabs([['', 'All', oh('/contacts')], ['customer', 'Customers', oh('/contacts?kind=customer')], ['vendor', 'Vendors', oh('/contacts?kind=vendor')]], kind)}</div>
      ${list.length ? html`<div class="table-wrap" style="margin-top:-18px"><table><thead><tr><th>Name</th><th>Type</th><th>Email</th><th>Phone</th><th class="num">They owe you</th><th class="num">You owe them</th><th></th></tr></thead><tbody>
        ${list.map((c) => html`<tr class="click" data-act="edit" data-id="${c.id}"><td style="font-weight:550">${c.name}</td><td><span class="badge">${c.kind === 'both' ? 'customer & vendor' : c.kind}</span></td><td>${c.email || ''}</td><td>${c.phone || ''}</td>${mcell(c.receivable)}${mcell(c.payable)}
          <td class="num"><a class="small" href="${oh(`/${c.kind === 'vendor' ? 'bills' : 'invoices'}/new?contact_id=${c.id}`)}">${canWrite() ? (c.kind === 'vendor' ? '+ Bill' : '+ Invoice') : ''}</a></td></tr>`)}
      </tbody></table></div>` : empty('No contacts yet', 'Add the customers you invoice and the vendors you pay.', canWrite() ? btn('New contact', 'add', { ic: 'plus', cls: 'primary' }) : '')}</div>`,
  });
});

// ============ banking ============
r('/o/:org/banking', async ({ query }) => {
  const q = new URLSearchParams(query).toString();
  const [data, accs, contacts] = await Promise.all([GET(O(`/bank?${q}`)), accounts(true), GET(O('/contacts'))]);
  const cur = data.ledger && data.ledger.account;
  const nonBank = live(accs).filter((a) => !cur || a.id !== cur.id);
  const txModal = async (dir) => {
    const res = await modal({
      title: dir === 'in' ? 'Money in' : 'Money out',
      body: html`<div class="form-grid">
        ${field('Bank account', html`<select name="account_id" required>${accountOptions(banks(accs), cur && cur.id)}</select>`)}
        ${field('Date', html`<input name="date" type="date" required value="${today()}">`)}
        ${field('Amount', html`<input name="amount" type="number" step="0.01" min="0.01" required>`)}
        ${field('Category', html`<select name="category_id" required>${accountOptions(nonBank.filter((a) => (dir === 'in' ? a.type !== 'expense' : a.type !== 'income')), null, 'Choose account…')}</select>`, { hint: dir === 'in' ? 'e.g. Sales, Other income, Owner\'s capital, Loans' : 'e.g. Rent, Software, Owner\'s drawings' })}
        ${field('Description', html`<input name="description" placeholder="${dir === 'in' ? 'Cash sale' : 'Office rent October'}">`, { full: true })}
        ${field('Contact (optional)', html`<select name="contact_id">${contactOptions(contacts)}</select>`, { full: true })}
      </div>`,
      submit: 'Record',
      onSubmit: (d) => api('POST', O('/bank/transactions'), { ...d, direction: dir, amount: toCents(d.amount) }),
    });
    if (res) { toast('Transaction recorded'); router(); }
  };
  ACT.moneyIn = () => txModal('in');
  ACT.moneyOut = () => txModal('out');
  ACT.transfer = async () => {
    const res = await modal({
      title: 'Transfer between accounts',
      body: html`<div class="form-grid">
        ${field('From', html`<select name="account_id" required>${accountOptions(banks(accs), cur && cur.id)}</select>`)}
        ${field('To', html`<select name="category_id" required>${accountOptions(banks(accs), null, 'Choose…')}</select>`)}
        ${field('Amount', html`<input name="amount" type="number" step="0.01" min="0.01" required>`)}
        ${field('Date', html`<input name="date" type="date" required value="${today()}">`)}
        ${field('Memo', html`<input name="description" value="Transfer">`, { full: true })}
      </div>`,
      submit: 'Transfer',
      onSubmit: (d) => { if (d.account_id === d.category_id) throw new Error('Choose two different accounts'); return api('POST', O('/bank/transactions'), { ...d, direction: 'out', amount: toCents(d.amount) }); },
    });
    if (res) { toast('Transfer recorded'); router(); }
  };
  ACT.import = async () => {
    let parsed = [];
    const res = await modal({
      title: 'Import bank statement (CSV)', wide: true,
      body: html`<div class="form-grid">
        ${field('Bank account', html`<select name="account_id" required>${accountOptions(banks(accs), cur && cur.id)}</select>`)}
        ${field('Date format in file', html`<select name="fmt"><option value="dmy">DD/MM/YYYY</option><option value="mdy">MM/DD/YYYY</option></select>`, { hint: 'ISO dates (YYYY-MM-DD) are detected automatically' })}
        ${field('Category for money in', html`<select name="income_category_id" required>${accountOptions(live(accs).filter((a) => a.type === 'income'), (accs.find((a) => a.system_key === 'sales') || {}).id)}</select>`)}
        ${field('Category for money out', html`<select name="expense_category_id" required>${accountOptions(live(accs).filter((a) => a.type === 'expense'), (accs.find((a) => a.system_key === 'other_exp') || {}).id)}</select>`)}
        ${field('CSV file', html`<input type="file" accept=".csv,text/csv" id="csv-file" required>`, { full: true, hint: 'Needs a header row with a date column, a description column, and either an amount column (negative = money out) or separate debit/credit columns.' })}
      </div><div id="csv-preview" class="small" style="margin-top:14px"></div>`,
      submit: 'Import',
      onMount: (form) => {
        $('#csv-file', form).addEventListener('change', async (e) => {
          const file = e.target.files[0]; if (!file) return;
          const rows = parseCSV(await file.text());
          const head = rows[0].map((h) => h.toLowerCase().trim());
          const find = (re) => head.findIndex((h) => re.test(h));
          const iDate = find(/date|datum|fecha/), iDesc = find(/desc|memo|payee|label|libell|narr|detail|reference|text/);
          const iAmt = find(/^amount|montant|betrag|value|amount/), iDr = find(/debit|withdraw|paid out|out/), iCr = find(/credit|deposit|paid in|\bin\b/);
          const pv = $('#csv-preview', form);
          if (iDate < 0 || (iAmt < 0 && iDr < 0 && iCr < 0)) { parsed = []; pv.innerHTML = html`<div class="err">Could not find date and amount columns. Found: ${head.join(', ')}</div>`.s; return; }
          const fmt = $('[name=fmt]', form).value;
          parsed = rows.slice(1).map((r) => ({
            date: parseDate(r[iDate], fmt), description: iDesc >= 0 ? r[iDesc] : '',
            amount: iAmt >= 0 ? parseAmount(r[iAmt]) : parseAmount(r[iCr]) - Math.abs(parseAmount(r[iDr])),
          })).filter((x) => x.date && x.amount);
          pv.innerHTML = html`<b>${parsed.length} transactions detected.</b><table class="compact" style="margin-top:8px"><tbody>${parsed.slice(0, 5).map((x) => html`<tr><td>${x.date}</td><td>${x.description}</td>${mcell(x.amount)}</tr>`)}</tbody></table>${parsed.length > 5 ? html`<div class="muted">…and ${parsed.length - 5} more</div>` : ''}`.s;
        });
      },
      onSubmit: (d) => { if (!parsed.length) throw new Error('Choose a CSV file with transactions'); return api('POST', O('/bank/import'), { ...d, rows: parsed }); },
    });
    if (res) { toast(`Imported ${res.imported} transactions`); router(); }
  };
  ACT.reverse = async (el) => { if (await confirmBox('Reverse transaction?', 'A reversing entry dated today will be posted.', { label: 'Reverse' })) { await api('POST', O(`/journal/${el.dataset.id}/reverse`)); router(); } };
  const L = data.ledger;
  page({
    title: 'Banking',
    actions: canWrite() ? html`${btn('Import CSV', 'import', { ic: 'upload' })}${btn('Transfer', 'transfer', { ic: 'swap' })}${btn('Money out', 'moneyOut', { ic: 'arrowOut' })}${btn('Money in', 'moneyIn', { ic: 'arrowIn', cls: 'primary' })}` : '',
    body: html`
      <div class="grid g4">${data.accounts.map((a) => html`<a class="card kpi" href="${oh('/banking?account_id=' + a.id)}" style="color:inherit;text-decoration:none;${cur && cur.id === a.id ? 'border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)' : ''}">
        <div class="label">${a.code} · ${a.name}</div><div class="value ${a.balance < 0 ? 'neg' : ''}">${money(a.balance)}</div><div class="sub">${a.type === 'liability' ? 'Credit account' : 'Available'}</div></a>`)}</div>
      ${L ? html`<div class="card" style="margin-top:18px"><div class="card-h"><h3>${L.account.name}</h3>
        <form class="row" data-submit="filter"><input type="hidden" name="account_id" value="${L.account.id}"><input type="date" name="from" value="${query.from || ''}" style="width:150px" aria-label="From"><input type="date" name="to" value="${query.to || ''}" style="width:150px" aria-label="To"><button class="btn sm">Filter</button></form></div>
        ${L.lines.length ? html`<div class="table-wrap"><table><thead><tr><th>Date</th><th>Description</th><th>Contact</th><th class="num">In</th><th class="num">Out</th><th class="num">Balance</th><th></th></tr></thead><tbody>
          ${[...L.lines].reverse().map((l) => html`<tr><td>${fmtDate(l.date)}</td><td>${l.memo || l.description || ''} ${l.ref_type !== 'bank' && l.ref_type !== 'manual' ? html`<span class="badge">${l.ref_type.replace('_', ' ')}</span>` : ''}</td><td>${l.contact_name || ''}</td>
            <td class="num pos">${l.debit ? money(l.debit) : ''}</td><td class="num">${l.credit ? money(l.credit) : ''}</td>${mcell(l.balance)}
            <td>${canWrite() && l.ref_type === 'bank' ? html`<button class="btn sm ghost" data-act="reverse" data-id="${l.entry_id}">Reverse</button>` : ''}</td></tr>`)}
          ${query.from ? html`<tr><td colspan="5" class="muted">Opening balance</td>${mcell(L.opening)}<td></td></tr>` : ''}
        </tbody></table></div>` : empty('No transactions', 'Record money in or out, or import a CSV statement from your bank.')}
      </div>` : html`<div class="card">${empty('No bank accounts', 'Mark an asset account as a bank account in the chart of accounts.')}</div>`}`,
  });
  ACT.filter = (d) => go(oh('/banking?' + new URLSearchParams(Object.entries(d).filter(([, v]) => v)).toString()));
});

// ============ chart of accounts ============
r('/o/:org/accounts', async ({ query }) => {
  const accs = await accounts(true);
  const showArchived = query.archived === '1';
  const shown = accs.filter((a) => showArchived || !a.archived);
  const edit = async (a = {}) => {
    let deleted = false;
    const res = await modal({
      title: a.id ? `${a.code} · ${a.name}` : 'New account',
      body: html`<div class="form-grid">
        ${field('Code', html`<input name="code" required value="${a.code || ''}">`)}
        ${field('Type', html`<select name="type" ${a.system_key ? 'disabled' : ''}>${Object.entries(TYPE_LABEL).map(([k, v]) => html`<option value="${k}" ${a.type === k ? 'selected' : ''}>${v.replace(/s$/, '').replace('Liabilitie', 'Liability')}</option>`)}</select>`)}
        ${field('Name', html`<input name="name" required value="${a.name || ''}">`, { full: true })}
        ${field('Subtype', html`<select name="subtype">${[['', '—'], ['current', 'Current'], ['fixed', 'Fixed / non-current'], ['long_term', 'Long-term'], ['cogs', 'Cost of goods sold']].map(([k, v]) => html`<option value="${k}" ${(a.subtype || '') === k ? 'selected' : ''}>${v}</option>`)}</select>`)}
        <div class="stack" style="padding-top:20px"><label class="check"><input type="checkbox" name="is_bank" ${a.is_bank ? 'checked' : ''}> Bank / cash / card account</label>
        ${a.id ? html`<label class="check"><input type="checkbox" name="archived" ${a.archived ? 'checked' : ''} ${a.system_key ? 'disabled' : ''}> Archived</label>` : ''}</div>
        ${field('Description', html`<input name="description" value="${a.description || ''}">`, { full: true })}
      </div>${a.system_key ? html`<p class="hint" style="margin:12px 0 0">System account used for automatic postings — type cannot change.</p>` : ''}`,
      extra: a.id && canWrite() && !a.system_key ? html`<button type="button" class="btn danger" id="del-acc">Delete</button>` : '',
      submit: canWrite() ? 'Save' : null,
      onSubmit: (d) => { if (a.system_key) d.type = a.type; return a.id ? api('PUT', O(`/accounts/${a.id}`), d) : api('POST', O('/accounts'), d); },
      onMount: (form, close) => {
        const del = $('#del-acc', form);
        if (del) del.addEventListener('click', async () => {
          try { await api('DELETE', O(`/accounts/${a.id}`)); deleted = true; close(true); }
          catch (e) { $('.err', form).textContent = e.message; $('.err', form).classList.remove('hidden'); }
        });
      },
    });
    if (res || deleted) router();
  };
  ACT.add = () => edit();
  ACT.edit = (el) => edit(accs.find((a) => a.id === +el.dataset.id));
  page({
    title: 'Chart of accounts',
    actions: html`<a class="btn" href="${oh('/accounts' + (showArchived ? '' : '?archived=1'))}">${showArchived ? 'Hide' : 'Show'} archived</a>${canWrite() ? btn('New account', 'add', { ic: 'plus', cls: 'primary' }) : ''}`,
    body: html`<div class="card table-wrap"><table><thead><tr><th style="width:90px">Code</th><th>Name</th><th>Subtype</th><th></th><th class="num">Balance</th></tr></thead><tbody>
      ${Object.keys(TYPE_LABEL).map((t) => html`<tr class="section"><td colspan="5">${TYPE_LABEL[t]}</td></tr>
        ${shown.filter((a) => a.type === t).map((a) => html`<tr class="click" data-act="edit" data-id="${a.id}" style="${a.archived ? 'opacity:.55' : ''}">
          <td class="mono">${a.code}</td><td>${a.name} ${a.is_bank ? html`<span class="badge teal">bank</span>` : ''} ${a.system_key ? html`<span class="badge" title="Used for automatic postings">system</span>` : ''} ${a.archived ? html`<span class="badge">archived</span>` : ''}</td>
          <td class="muted">${(a.subtype || '').replace('_', ' ')}</td>
          <td><a class="small" href="${oh(`/reports/ledger?account_id=${a.id}`)}">Ledger →</a></td>${mcell(a.balance)}</tr>`)}`)}
    </tbody></table></div>`,
  });
});

// ============ journal ============
function journalLineRow(accs, l = {}) {
  return html`<tr>
    <td><select name="account_id" aria-label="Account">${accountOptions(live(accs), l.account_id, 'Account…')}</select></td>
    <td><input name="description" value="${l.description || ''}" aria-label="Line description"></td>
    <td style="width:130px"><input name="debit" type="number" step="0.01" min="0" class="num" aria-label="Debit"></td>
    <td style="width:130px"><input name="credit" type="number" step="0.01" min="0" class="num" aria-label="Credit"></td>
    <td style="width:34px"><button type="button" class="icon-btn" data-rm aria-label="Remove line">${icon('x')}</button></td></tr>`;
}
r('/o/:org/journal', async ({ query }) => {
  const limit = +query.limit || 100;
  const qs = new URLSearchParams({ ...query, limit }).toString();
  const [data, accs] = await Promise.all([GET(O(`/journal?${qs}`)), accounts()]);
  ACT.add = async () => {
    const res = await modal({
      title: 'New journal entry', wide: true,
      body: html`<div class="form-grid">${field('Date', html`<input name="date" type="date" required value="${today()}">`)}${field('Memo', html`<input name="memo" required placeholder="e.g. Depreciation for Q3">`)}</div>
        <table class="lines-table" style="margin-top:16px"><thead><tr><th>Account</th><th>Description</th><th class="num">Debit</th><th class="num">Credit</th><th></th></tr></thead>
        <tbody id="jl">${journalLineRow(accs)}${journalLineRow(accs)}</tbody>
        <tfoot><tr><td><button type="button" class="btn sm" id="jl-add">${icon('plus')}Add line</button></td><td class="num muted" id="jl-diff"></td><td class="num" id="jl-dr"></td><td class="num" id="jl-cr"></td><td></td></tr></tfoot></table>`,
      submit: 'Post entry',
      onMount: (form) => {
        const body = $('#jl', form);
        const calc = () => {
          let dr = 0, cr = 0;
          for (const tr of $$('tr', body)) { dr += toCents($('[name=debit]', tr).value); cr += toCents($('[name=credit]', tr).value); }
          $('#jl-dr', form).textContent = money(dr); $('#jl-cr', form).textContent = money(cr);
          const diff = $('#jl-diff', form);
          diff.textContent = dr === cr ? (dr ? '✓ Balanced' : '') : `Out of balance by ${money(Math.abs(dr - cr))}`;
          diff.className = 'num ' + (dr === cr ? 'pos' : 'neg');
        };
        body.addEventListener('input', calc);
        body.addEventListener('click', (e) => { if (e.target.closest('[data-rm]') && $$('tr', body).length > 2) { e.target.closest('tr').remove(); calc(); } });
        $('#jl-add', form).addEventListener('click', () => body.insertAdjacentHTML('beforeend', journalLineRow(accs).s));
      },
      onSubmit: (d, form) => api('POST', O('/journal'), {
        date: d.date, memo: d.memo,
        lines: $$('#jl tr', form).map((tr) => ({ account_id: $('[name=account_id]', tr).value, description: $('[name=description]', tr).value, debit: toCents($('[name=debit]', tr).value), credit: toCents($('[name=credit]', tr).value) }))
          .filter((l) => l.account_id && (l.debit || l.credit)),
      }),
    });
    if (res) { toast('Entry posted'); router(); }
  };
  ACT.reverse = async (el) => { if (await confirmBox('Reverse entry?', 'A reversing entry dated today will be posted.', { label: 'Reverse' })) { await api('POST', O(`/journal/${el.dataset.id}/reverse`)); router(); } };
  ACT.filter = (d) => go(oh('/journal?' + new URLSearchParams(Object.entries(d).filter(([, v]) => v)).toString()));
  ACT.more = () => go(oh('/journal?' + new URLSearchParams({ ...query, limit: limit + 100 }).toString()));
  const refLink = (e) => {
    const t = e.ref_type.replace('_reversal', '');
    const href = t === 'invoice' ? oh(`/invoices/${e.ref_id}`) : t === 'bill' ? oh(`/bills/${e.ref_id}`) : t === 'payroll' ? oh(`/payroll/${e.ref_id}`) : null;
    const b = html`<span class="badge ${e.ref_type.endsWith('reversal') ? 'amber' : ''}">${e.ref_type.replace('_', ' ')}</span>`;
    return href ? html`<a href="${href}">${b}</a>` : b;
  };
  page({
    title: 'Journal', crumbs: `${data.total} entries`,
    actions: canWrite() ? btn('New journal entry', 'add', { ic: 'plus', cls: 'primary' }) : '',
    body: html`<form class="toolbar" data-submit="filter">
        ${field('Search memo', html`<input name="q" value="${query.q || ''}">`)}${field('From', html`<input name="from" type="date" value="${query.from || ''}">`)}${field('To', html`<input name="to" type="date" value="${query.to || ''}">`)}
        ${field('Source', html`<select name="type"><option value="">All</option>${['manual', 'bank', 'invoice', 'bill', 'payment', 'payroll'].map((t) => html`<option ${query.type === t ? 'selected' : ''}>${t}</option>`)}</select>`)}
        <button class="btn">Filter</button></form>
      <div class="card table-wrap">${data.entries.length ? html`<table><thead><tr><th style="width:130px">Date</th><th>Account / memo</th><th class="num">Debit</th><th class="num">Credit</th><th></th></tr></thead><tbody>
        ${data.entries.map((e) => html`<tr class="entry"><td>${fmtDate(e.date)}</td><td>${e.memo || 'Journal entry'} ${refLink(e)} ${e.reversed_by && !e.ref_type.endsWith('reversal') ? html`<span class="badge">reversed</span>` : ''}</td><td></td><td></td>
          <td class="num">${canWrite() && !e.reversed_by && ['manual', 'bank'].includes(e.ref_type) ? html`<button class="btn sm ghost" data-act="reverse" data-id="${e.id}">Reverse</button>` : ''}</td></tr>
          ${e.lines.map((l) => html`<tr><td></td><td class="${l.credit ? 'indent' : ''}"><span class="mono muted">${l.code}</span> ${l.account_name}${l.description ? html` <span class="muted small">— ${l.description}</span>` : ''}</td><td class="num">${l.debit ? money(l.debit) : ''}</td><td class="num">${l.credit ? money(l.credit) : ''}</td><td></td></tr>`)}`)}
      </tbody></table>` : empty('No journal entries', 'Entries are created automatically from invoices, bills, banking and payroll — or post one manually.')}</div>
      ${data.total > data.entries.length ? html`<div style="text-align:center;margin-top:14px">${btn('Load more', 'more')}</div>` : ''}`,
  });
});

// ============ payroll ============
function employeeModal(e = {}) {
  return modal({
    title: e.id ? e.name : 'New employee', wide: true,
    body: html`<div class="form-grid cols3">
      ${field('Full name', html`<input name="name" required value="${e.name || ''}">`)}
      ${field('Email', html`<input name="email" type="email" value="${e.email || ''}">`)}
      ${field('Start date', html`<input name="start_date" type="date" value="${e.start_date || ''}">`)}
      ${field('Position', html`<input name="position" value="${e.position || ''}">`)}
      ${field('Department', html`<input name="department" value="${e.department || ''}">`)}
      <label class="check" style="padding-top:22px"><input type="checkbox" name="active" ${e.active === 0 ? '' : 'checked'}> Active</label>
      ${field('Pay type', html`<select name="pay_type"><option value="salary" ${e.pay_type !== 'hourly' ? 'selected' : ''}>Salary (per pay run)</option><option value="hourly" ${e.pay_type === 'hourly' ? 'selected' : ''}>Hourly</option></select>`)}
      ${field('Pay rate', html`<input name="pay_rate" type="number" step="0.01" min="0" required value="${fromCents(e.pay_rate)}">`, { hint: 'Salary per run, or rate per hour' })}
      ${field('Fixed deduction per run', html`<input name="fixed_deduction" type="number" step="0.01" min="0" value="${fromCents(e.fixed_deduction || 0)}">`, { hint: 'e.g. pension, health plan, loan repayment' })}
      ${field('Income tax withheld %', html`<input name="income_tax_rate" type="number" step="any" min="0" max="100" value="${e.income_tax_rate ?? 0}">`)}
      ${field('Employee social contrib. %', html`<input name="social_rate" type="number" step="any" min="0" max="100" value="${e.social_rate ?? 0}">`)}
      ${field('Employer contrib. %', html`<input name="employer_rate" type="number" step="any" min="0" max="100" value="${e.employer_rate ?? 0}">`)}
      ${field('Bank details', html`<input name="bank_details" value="${e.bank_details || ''}" placeholder="IBAN / account number">`, { full: true })}
    </div><p class="hint" style="margin:12px 0 0">Rates are flat percentages so they work for any country. Adjust per employee to match your local rules.</p>`,
    submit: canWrite() ? 'Save' : null,
    onSubmit: (d) => {
      const body = { ...d, pay_rate: toCents(d.pay_rate), fixed_deduction: toCents(d.fixed_deduction) };
      return e.id ? api('PUT', O(`/employees/${e.id}`), body) : api('POST', O('/employees'), body);
    },
  });
}
r('/o/:org/payroll', async () => {
  const runs = await GET(O('/payroll'));
  const accs = await accounts();
  ACT.newRun = async () => {
    const now = new Date(), y = now.getFullYear(), m = now.getMonth();
    const first = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10), last = new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10);
    const res = await modal({
      title: 'New pay run',
      body: html`<div class="form-grid">
        ${field('Period start', html`<input name="period_start" type="date" required value="${first}">`)}${field('Period end', html`<input name="period_end" type="date" required value="${last}">`)}
        ${field('Pay date', html`<input name="pay_date" type="date" required value="${last}">`)}${field('Pay from', html`<select name="bank_account_id">${accountOptions(banks(accs), (accs.find((a) => a.system_key === 'bank') || {}).id)}</select>`)}
        ${field('Notes', html`<input name="notes">`, { full: true })}</div>
        <p class="hint" style="margin:12px 0 0">Payslips are generated for every active employee. Hourly staff default to 160 hours — edit them before posting.</p>`,
      submit: 'Create pay run', onSubmit: (d) => api('POST', O('/payroll'), d),
    });
    if (res && res.id) go(oh(`/payroll/${res.id}`));
  };
  page({
    title: 'Payroll', actions: canWrite() ? btn('New pay run', 'newRun', { ic: 'plus', cls: 'primary' }) : '',
    body: html`${tabs([['runs', 'Pay runs', oh('/payroll')], ['emp', 'Employees', oh('/payroll/employees')]], 'runs')}
      <div class="card table-wrap">${runs.length ? html`<table><thead><tr><th>Period</th><th>Pay date</th><th class="num">Employees</th><th class="num">Gross</th><th class="num">Deductions</th><th class="num">Net pay</th><th class="num">Employer cost</th><th>Status</th></tr></thead><tbody>
        ${runs.map((x) => html`<tr class="click" data-href="${oh('/payroll/' + x.id)}"><td>${fmtDate(x.period_start)} – ${fmtDate(x.period_end)}</td><td>${fmtDate(x.pay_date)}</td><td class="num">${x.totals.count}</td>${mcell(x.totals.gross)}${mcell(x.totals.deductions)}${mcell(x.totals.net)}${mcell(x.totals.employer_cost)}<td>${badge(x.status)}</td></tr>`)}
      </tbody></table>` : empty('No pay runs yet', 'Add your employees, then create a pay run each period.', html`<a class="btn" href="${oh('/payroll/employees')}">Manage employees</a>`)}</div>`,
  });
});
r('/o/:org/payroll/employees', async () => {
  const emps = await GET(O('/employees'));
  ACT.add = async () => { if (await employeeModal()) router(); };
  ACT.edit = async (el) => { if (await employeeModal(emps.find((e) => e.id === +el.dataset.id))) router(); };
  ACT.del = async (el) => { if (await confirmBox('Delete employee?', 'Only employees without payslips can be deleted.', { label: 'Delete' })) { await api('DELETE', O(`/employees/${el.dataset.id}`)); router(); } };
  page({
    title: 'Payroll', actions: canWrite() ? btn('New employee', 'add', { ic: 'plus', cls: 'primary' }) : '',
    body: html`${tabs([['runs', 'Pay runs', oh('/payroll')], ['emp', 'Employees', oh('/payroll/employees')]], 'emp')}
      <div class="card table-wrap">${emps.length ? html`<table><thead><tr><th>Name</th><th>Position</th><th>Department</th><th>Pay</th><th class="num">Tax %</th><th class="num">Social %</th><th class="num">Employer %</th><th>Status</th><th></th></tr></thead><tbody>
        ${emps.map((e) => html`<tr class="click" data-act="edit" data-id="${e.id}"><td style="font-weight:550">${e.name}<div class="muted small">${e.email || ''}</div></td><td>${e.position || ''}</td><td>${e.department || ''}</td>
          <td class="num">${money(e.pay_rate)}<span class="muted small"> / ${e.pay_type === 'hourly' ? 'hr' : 'run'}</span></td><td class="num">${e.income_tax_rate}</td><td class="num">${e.social_rate}</td><td class="num">${e.employer_rate}</td>
          <td>${e.active ? badge('paid', 'active') : badge('void', 'inactive')}</td><td>${canWrite() ? html`<button class="icon-btn" data-act="del" data-id="${e.id}" aria-label="Delete">${icon('x')}</button>` : ''}</td></tr>`)}
      </tbody></table>` : empty('No employees yet', 'Add the people you pay.', canWrite() ? btn('New employee', 'add', { ic: 'plus', cls: 'primary' }) : '')}</div>`,
  });
});
r('/o/:org/payroll/:id', async ({ id }) => {
  const run = await GET(O(`/payroll/${id}`));
  const draft = run.status === 'draft' && canWrite();
  const kpis = () => {
    const t = run.payslips.reduce((a, s) => { a.gross += s.gross; a.ded += s.income_tax + s.social + s.other_deductions; a.net += s.net; a.emp += s.employer_cost; return a; }, { gross: 0, ded: 0, net: 0, emp: 0 });
    return html`<div class="card kpi"><div class="label">Gross pay</div><div class="value">${money(t.gross)}</div></div>
      <div class="card kpi"><div class="label">Deductions withheld</div><div class="value">${money(t.ded)}</div></div>
      <div class="card kpi"><div class="label">Net pay to employees</div><div class="value">${money(t.net)}</div></div>
      <div class="card kpi"><div class="label">Total employer cost</div><div class="value">${money(t.gross + t.emp)}</div><div class="sub">incl. ${money(t.emp)} contributions</div></div>`.s;
  };
  ACT.post = async () => { if (await confirmBox('Post pay run?', 'Wages, withholdings and net pay will be posted to the ledger and the run will be locked.', { label: 'Post to ledger', danger: false })) { await api('POST', O(`/payroll/${id}/post`)); toast('Payroll posted'); router(); } };
  ACT.void = async () => { if (await confirmBox('Void pay run?', 'A reversing entry will be posted.', { label: 'Void' })) { await api('POST', O(`/payroll/${id}/void`)); router(); } };
  ACT.del = async () => { if (await confirmBox('Delete pay run?', 'This removes the run and its payslips.', { label: 'Delete' })) { await api('DELETE', O(`/payroll/${id}`)); go(oh('/payroll')); } };
  ACT.rmSlip = async (el) => { await api('DELETE', O(`/payroll/${id}/payslips/${el.dataset.id}`)); router(); };
  ACT.slip = async (el) => {
    const tr = el.closest('tr'), sid = +tr.dataset.id;
    const body = { hours: $('[name=hours]', tr) ? $('[name=hours]', tr).value : undefined, bonus: toCents($('[name=bonus]', tr).value), other_deductions: toCents($('[name=other]', tr).value) };
    const s = await api('PUT', O(`/payroll/${id}/payslips/${sid}`), body);
    Object.assign(run.payslips.find((p) => p.id === sid), s);
    for (const k of ['base', 'gross', 'income_tax', 'social', 'net', 'employer_cost']) $(`[data-f=${k}]`, tr).textContent = money(s[k]);
    $('#kpis').innerHTML = kpis();
  };
  const inp = (name, v, attrs = '') => html`<input name="${name}" type="number" step="0.01" min="0" class="num" value="${v}" data-change="slip" style="width:100px" ${raw(attrs)}>`;
  page({
    title: `Pay run · ${fmtDate(run.period_start)} – ${fmtDate(run.period_end)}`, crumbs: html`<a href="${oh('/payroll')}">Payroll</a>`,
    actions: html`${linkBtn('Print payslips', `#/print/${S.org.id}/payroll/${id}?auto=1`, { ic: 'print', blank: true })}
      ${draft ? html`${btn('Delete', 'del', { cls: 'danger' })}${btn('Post to ledger', 'post', { cls: 'primary' })}` : ''}
      ${run.status === 'posted' && canWrite() ? btn('Void', 'void', { cls: 'danger' }) : ''}`,
    body: html`<div class="row" style="margin-bottom:14px">${badge(run.status)}<span class="muted">Pay date ${fmtDate(run.pay_date)}${run.notes ? ' · ' + run.notes : ''}</span></div>
      <div class="grid g4" id="kpis">${raw(kpis())}</div>
      <div class="card table-wrap" style="margin-top:18px"><table><thead><tr><th>Employee</th><th class="num">Hours</th><th class="num">Base</th><th class="num">Bonus</th><th class="num">Gross</th><th class="num">Income tax</th><th class="num">Social</th><th class="num">Other ded.</th><th class="num">Net pay</th><th class="num">Employer</th>${draft ? html`<th></th>` : ''}</tr></thead><tbody>
        ${run.payslips.map((s) => html`<tr data-id="${s.id}"><td style="font-weight:550">${s.name}<div class="muted small">${s.position || ''}</div></td>
          <td class="num">${s.pay_type === 'hourly' ? (draft ? inp('hours', s.hours, 'step="0.25"') : s.hours) : html`<span class="muted">—</span>`}</td>
          <td class="num" data-f="base">${money(s.base)}</td>
          <td class="num">${draft ? inp('bonus', fromCents(s.bonus)) : money(s.bonus)}</td>
          <td class="num" data-f="gross" style="font-weight:600">${money(s.gross)}</td>
          <td class="num" data-f="income_tax">${money(s.income_tax)}</td><td class="num" data-f="social">${money(s.social)}</td>
          <td class="num">${draft ? inp('other', fromCents(s.other_deductions)) : money(s.other_deductions)}</td>
          <td class="num pos" data-f="net" style="font-weight:600">${money(s.net)}</td><td class="num muted" data-f="employer_cost">${money(s.employer_cost)}</td>
          ${draft ? html`<td><button class="icon-btn" data-act="rmSlip" data-id="${s.id}" aria-label="Remove from run">${icon('x')}</button></td>` : ''}</tr>`)}
      </tbody></table></div>
      <p class="muted small">Posting debits Salaries & Wages (gross) and Employer Payroll Taxes, credits Payroll Liabilities (withholdings + employer contributions) and pays net wages from the bank account.</p>`,
  });
});
r('/print/:org/payroll/:id', async ({ id, query }) => {
  const run = await GET(O(`/payroll/${id}`));
  const cur = run.org.currency;
  const row = (l, v, b) => html`<tr><td>${b ? html`<b>${l}</b>` : l}</td><td class="num">${b ? html`<b>${money(v, cur)}</b>` : money(v, cur)}</td></tr>`;
  $('#app').innerHTML = html`<div class="print-page"><div class="print-bar no-print"><button class="btn" data-act="back">Back</button><button class="btn primary" data-act="print">${icon('print')}Print / Save as PDF</button></div>
    ${run.payslips.map((s) => html`<div class="doc" style="margin:0 auto 24px;page-break-after:always">
      <div class="doc-head"><div><div class="doc-title">PAYSLIP</div><div style="margin-top:8px;font-weight:600">${run.org.legal_name || run.org.name}</div><div style="font-size:13px;color:#4b5563;white-space:pre-line">${run.org.address || ''}</div></div>
        <div class="meta"><span>Period</span><span>${fmtDate(run.period_start)} – ${fmtDate(run.period_end)}</span><span>Pay date</span><span>${fmtDate(run.pay_date)}</span></div></div>
      <div class="parties"><div><h4>Employee</h4><b>${s.name}</b>
${[s.position, s.department, s.email].filter(Boolean).join('\n')}</div><div style="text-align:right"><h4>Net pay</h4><div style="font-size:24px;font-weight:700">${money(s.net, cur)}</div>${s.bank_details ? html`<div style="font-size:12px;color:#6b7280">Paid to ${s.bank_details}</div>` : ''}</div></div>
      <div class="grid g2"><table><thead><tr><th>Earnings</th><th class="num">Amount</th></tr></thead><tbody>
        ${row(s.pay_type === 'hourly' ? `Hours (${s.hours} × ${money(s.pay_rate, cur)})` : 'Base salary', s.base)}${s.bonus ? row('Bonus', s.bonus) : ''}${row('Gross pay', s.gross, true)}</tbody></table>
      <table><thead><tr><th>Deductions</th><th class="num">Amount</th></tr></thead><tbody>
        ${row('Income tax', s.income_tax)}${row('Social contributions', s.social)}${s.other_deductions ? row('Other deductions', s.other_deductions) : ''}${row('Total deductions', s.income_tax + s.social + s.other_deductions, true)}</tbody></table></div>
      <div class="totals"><div class="grand"><span>Net pay</span><span>${money(s.net, cur)}</span></div></div>
      <div class="foot">Employer contributions (not deducted from pay): ${money(s.employer_cost, cur)}</div>
    </div>`)}</div>`.s;
  if (query.auto) setTimeout(() => window.print(), 300);
});

// ============ reports ============
const REPORTS = [['pnl', 'Profit & loss'], ['balance-sheet', 'Balance sheet'], ['cashflow', 'Income vs expenses'], ['trial-balance', 'Trial balance'], ['ledger', 'General ledger'], ['ar', 'Receivables aging'], ['ap', 'Payables aging'], ['tax', 'Sales tax']];
function presets() {
  const d = new Date(), y = d.getFullYear(), m = d.getMonth(), iso = (x) => x.toISOString().slice(0, 10), U = (a, b, c) => new Date(Date.UTC(a, b, c));
  const q = Math.floor(m / 3) * 3;
  return [['This month', iso(U(y, m, 1)), iso(U(y, m + 1, 0))], ['Last month', iso(U(y, m - 1, 1)), iso(U(y, m, 0))], ['This quarter', iso(U(y, q, 1)), iso(U(y, q + 3, 0))],
    ['This year', `${y}-01-01`, `${y}-12-31`], ['Last year', `${y - 1}-01-01`, `${y - 1}-12-31`]];
}
r('/o/:org/reports/:report', async ({ report, query }) => {
  const yStart = today().slice(0, 4) + '-01-01';
  const from = query.from || yStart, to = query.to || today(), asOf = query.asOf || today();
  let body = '', csv = [], toolbar = '';
  const rangeBar = html`<form class="toolbar no-print" data-submit="apply">
    ${field('Period', html`<select data-change="preset"><option value="">Custom</option>${presets().map(([l, f, t]) => html`<option value="${f}|${t}" ${f === from && t === to ? 'selected' : ''}>${l}</option>`)}</select>`)}
    ${field('From', html`<input type="date" name="from" value="${from}">`)}${field('To', html`<input type="date" name="to" value="${to}">`)}<button class="btn">Apply</button></form>`;
  const asOfBar = html`<form class="toolbar no-print" data-submit="apply">${field('As of', html`<input type="date" name="asOf" value="${asOf}">`)}<button class="btn">Apply</button></form>`;
  ACT.apply = (d) => go(oh(`/reports/${report}?` + new URLSearchParams({ ...query, ...d }).toString()));
  ACT.preset = (el) => { if (el.value) { const [f, t] = el.value.split('|'); ACT.apply({ from: f, to: t }); } };
  const ledgerLink = (a, label) => html`<a href="${oh(`/reports/ledger?account_id=${a.id}&from=${from}&to=${to}`)}" style="color:inherit">${label}</a>`;
  const sectionRows = (title, rows, totalLabel, total) => {
    csv.push([title]); rows.forEach((a) => csv.push(['', a.code, a.name, (a.balance / 100).toFixed(2)])); csv.push(['', '', totalLabel, (total / 100).toFixed(2)]);
    return html`<tr class="section"><td colspan="3">${title}</td></tr>${rows.length ? rows.map((a) => html`<tr><td class="indent mono muted" style="width:110px">${a.code}</td><td>${a.id ? ledgerLink(a, a.name) : a.name}</td>${mcell(a.balance)}</tr>`) : html`<tr><td></td><td class="muted">None</td><td></td></tr>`}
      <tr class="total"><td></td><td>${totalLabel}</td>${mcell(total)}</tr>`;
  };

  if (report === 'pnl') {
    const p = await GET(O(`/reports/pnl?from=${from}&to=${to}`));
    toolbar = rangeBar;
    body = html`<table>${sectionRows('Income', p.income, 'Total income', p.totalIncome)}
      ${p.cogs.length ? html`${sectionRows('Cost of goods sold', p.cogs, 'Total COGS', p.totalCogs)}<tr class="total"><td></td><td>Gross profit</td>${mcell(p.grossProfit)}</tr>` : ''}
      ${sectionRows('Operating expenses', p.expenses, 'Total expenses', p.totalExpenses)}
      <tr class="total" style="font-size:16px"><td></td><td>Net income</td><td class="num ${p.netIncome < 0 ? 'neg' : 'pos'}">${money(p.netIncome)}</td></tr></table>`;
    csv.push(['', '', 'Net income', (p.netIncome / 100).toFixed(2)]);
  } else if (report === 'balance-sheet') {
    const b = await GET(O(`/reports/balance-sheet?asOf=${asOf}`));
    toolbar = asOfBar;
    const eq = [...b.equity, { id: 0, code: '', name: 'Current & retained earnings (unclosed)', balance: b.earnings }];
    body = html`<table>${sectionRows('Assets', b.assets, 'Total assets', b.totalAssets)}${sectionRows('Liabilities', b.liabilities, 'Total liabilities', b.totalLiabilities)}
      ${sectionRows('Equity', eq, 'Total equity', b.totalEquity)}
      <tr class="total" style="font-size:15px"><td></td><td>Liabilities + equity</td>${mcell(b.totalLiabilities + b.totalEquity)}</tr></table>
      <div class="card-b">${b.balanced ? badge('paid', '✓ Balanced') : badge('overdue', 'Out of balance — check opening balances')}</div>`;
  } else if (report === 'trial-balance') {
    const t = await GET(O(`/reports/trial-balance?asOf=${asOf}`));
    toolbar = asOfBar;
    csv = [['Code', 'Account', 'Debit', 'Credit'], ...t.rows.map((a) => [a.code, a.name, (a.tb_debit / 100).toFixed(2), (a.tb_credit / 100).toFixed(2)]), ['', 'Total', (t.totalDebit / 100).toFixed(2), (t.totalCredit / 100).toFixed(2)]];
    body = html`<table><thead><tr><th>Code</th><th>Account</th><th class="num">Debit</th><th class="num">Credit</th></tr></thead><tbody>
      ${t.rows.map((a) => html`<tr><td class="mono">${a.code}</td><td>${a.name}</td><td class="num">${a.tb_debit ? money(a.tb_debit) : ''}</td><td class="num">${a.tb_credit ? money(a.tb_credit) : ''}</td></tr>`)}
      <tr class="total"><td></td><td>Total ${t.totalDebit === t.totalCredit ? '✓' : '⚠'}</td>${mcell(t.totalDebit)}${mcell(t.totalCredit)}</tr></tbody></table>`;
  } else if (report === 'ledger') {
    const accs = await accounts();
    const accId = query.account_id || (accs.find((a) => a.system_key === 'bank') || accs[0]).id;
    const g = await GET(O(`/reports/ledger?account_id=${accId}&from=${from}&to=${to}`));
    toolbar = html`<form class="toolbar no-print" data-submit="apply">${field('Account', html`<select name="account_id" style="min-width:260px">${accountOptions(accs, accId)}</select>`)}
      ${field('From', html`<input type="date" name="from" value="${from}">`)}${field('To', html`<input type="date" name="to" value="${to}">`)}<button class="btn">Apply</button></form>`;
    csv = [['Date', 'Memo', 'Contact', 'Debit', 'Credit', 'Balance'], ['', 'Opening balance', '', '', '', (g.opening / 100).toFixed(2)],
      ...g.lines.map((l) => [l.date, l.memo || l.description || '', l.contact_name || '', (l.debit / 100).toFixed(2), (l.credit / 100).toFixed(2), (l.balance / 100).toFixed(2)])];
    body = html`<table><thead><tr><th>Date</th><th>Memo</th><th>Contact</th><th class="num">Debit</th><th class="num">Credit</th><th class="num">Balance</th></tr></thead><tbody>
      <tr class="section"><td colspan="5" style="text-transform:none">Opening balance · ${g.account.code} ${g.account.name}</td>${mcell(g.opening)}</tr>
      ${g.lines.map((l) => html`<tr><td>${fmtDate(l.date)}</td><td>${l.memo || ''}${l.description && l.description !== l.memo ? html` <span class="muted small">— ${l.description}</span>` : ''}</td><td>${l.contact_name || ''}</td><td class="num">${l.debit ? money(l.debit) : ''}</td><td class="num">${l.credit ? money(l.credit) : ''}</td>${mcell(l.balance)}</tr>`)}
      <tr class="total"><td colspan="5">Closing balance</td>${mcell(g.closing)}</tr></tbody></table>`;
  } else if (report === 'ar' || report === 'ap') {
    const a = await GET(O(`/reports/aging?kind=${report === 'ar' ? 'invoice' : 'bill'}&asOf=${asOf}`));
    toolbar = asOfBar;
    const path = report === 'ar' ? 'invoices' : 'bills';
    csv = [['Number', 'Contact', 'Due date', 'Days overdue', 'Bucket', 'Amount due'], ...a.rows.map((x) => [x.number, x.contact_name, x.due_date, x.days_overdue, x.bucket, (x.due / 100).toFixed(2)])];
    body = html`<div class="grid g6" style="padding:18px;gap:12px">${a.buckets.map((b) => html`<div><div class="muted small">${b === 'current' ? 'Not yet due' : b + ' days'}</div><div style="font-weight:650;font-size:17px" class="${b !== 'current' && a.totals[b] ? 'neg' : ''}">${money(a.totals[b])}</div></div>`)}<div><div class="muted small">Total</div><div style="font-weight:650;font-size:17px">${money(a.total)}</div></div></div>
      <table><thead><tr><th>Number</th><th>${report === 'ar' ? 'Customer' : 'Vendor'}</th><th>Due date</th><th class="num">Days overdue</th><th>Bucket</th><th class="num">Amount due</th></tr></thead><tbody>
      ${a.rows.length ? a.rows.map((x) => html`<tr class="click" data-href="${oh(`/${path}/${x.id}`)}"><td class="mono">${x.number}</td><td>${x.contact_name}</td><td>${fmtDate(x.due_date)}</td><td class="num">${x.days_overdue || ''}</td><td>${x.bucket === 'current' ? badge('sent', 'current') : badge('overdue', x.bucket)}</td>${mcell(x.due)}</tr>`) : html`<tr><td colspan="6" class="muted" style="text-align:center;padding:30px">Nothing outstanding.</td></tr>`}
      </tbody></table>`;
  } else if (report === 'cashflow') {
    const months = +query.months || 12;
    const s = await GET(O(`/reports/cashflow?months=${months}`));
    toolbar = html`<form class="toolbar no-print" data-submit="apply">${field('Months', html`<select name="months">${[6, 12, 24, 36].map((n) => html`<option ${n === months ? 'selected' : ''}>${n}</option>`)}</select>`)}<button class="btn">Apply</button></form>`;
    csv = [['Month', 'Income', 'Expenses', 'Net'], ...s.map((x) => [x.month, (x.income / 100).toFixed(2), (x.expense / 100).toFixed(2), (x.net / 100).toFixed(2)])];
    const tot = s.reduce((a, x) => ({ income: a.income + x.income, expense: a.expense + x.expense }), { income: 0, expense: 0 });
    body = html`<div class="card-b"><div class="split" style="margin-bottom:10px"><span></span>${legend()}</div>${barChart(s)}</div>
      <table><thead><tr><th>Month</th><th class="num">Income</th><th class="num">Expenses</th><th class="num">Net</th><th class="num">Margin</th></tr></thead><tbody>
      ${s.map((x) => html`<tr><td>${new Date(x.month + '-01T00:00:00').toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</td>${mcell(x.income)}${mcell(x.expense)}<td class="num ${x.net < 0 ? 'neg' : 'pos'}">${money(x.net)}</td><td class="num muted">${x.income ? Math.round((x.net / x.income) * 100) + '%' : '—'}</td></tr>`)}
      <tr class="total"><td>Total</td>${mcell(tot.income)}${mcell(tot.expense)}${mcell(tot.income - tot.expense)}<td></td></tr></tbody></table>`;
  } else if (report === 'tax') {
    const t = await GET(O(`/reports/tax?from=${from}&to=${to}`));
    toolbar = rangeBar;
    csv = [['Sales tax collected', (t.collected / 100).toFixed(2)], ['Tax paid on purchases (recoverable)', (t.paid / 100).toFixed(2)], ['Net tax payable', (t.net / 100).toFixed(2)]];
    body = html`<table><tbody><tr><td>Sales tax collected on invoices</td>${mcell(t.collected)}</tr><tr><td>Tax paid on bills (recoverable)</td>${mcell(-t.paid)}</tr>
      <tr class="total" style="font-size:16px"><td>${t.net >= 0 ? 'Net tax payable' : 'Net tax refundable'}</td>${mcell(Math.abs(t.net))}</tr></tbody></table>
      <p class="card-b muted small" style="margin:0">Movement on the Sales Tax Payable and Tax Recoverable accounts for the period. Record your tax payment as “Money out” categorised to Sales Tax Payable.</p>`;
  } else return go(oh('/reports/pnl'));

  const title = REPORTS.find((x) => x[0] === report)[1];
  ACT.csv = () => downloadCsv(`${S.org.name}-${report}-${query.asOf || to}.csv`.replace(/\s+/g, '_'), csv);
  page({
    title: 'Reports', actions: html`${btn('Export CSV', 'csv', { ic: 'download' })}${btn('Print', 'print', { ic: 'print' })}`,
    body: html`<div class="no-print">${tabs(REPORTS.map(([k, l]) => [k, l, oh('/reports/' + k)]), report)}</div>${toolbar}
      <div class="card"><div class="card-h"><div><h2>${title}</h2><div class="muted small">${S.org.name} · ${['balance-sheet', 'trial-balance', 'ar', 'ap'].includes(report) ? 'As of ' + fmtDate(asOf) : report === 'cashflow' ? 'Monthly' : `${fmtDate(from)} – ${fmtDate(to)}`}</div></div></div>
      <div class="table-wrap">${body}</div></div>`,
  });
});
r('/o/:org/reports', () => go(oh('/reports/pnl')));

// ============ budgets ============
r('/o/:org/budgets', async ({ query }) => {
  const year = +query.year || new Date().getFullYear();
  const b = await GET(O(`/budgets?year=${year}`));
  const w = canWrite();
  ACT.year = (el) => go(oh('/budgets?year=' + el.value));
  ACT.save = async (d) => {
    await api('PUT', O('/budgets'), { year, items: Object.entries(d).filter(([k]) => k.startsWith('b_')).map(([k, v]) => ({ account_id: +k.slice(2), amount: toCents(v) })) });
    toast('Budget saved'); router();
  };
  const elapsed = year < new Date().getFullYear() ? 1 : year > new Date().getFullYear() ? 0 : (Date.now() - Date.UTC(year, 0, 1)) / (365 * 864e5);
  const section = (type, title) => {
    const rows = b.rows.filter((x) => x.type === type);
    const tb = rows.reduce((s, x) => s + x.budget, 0), ta = rows.reduce((s, x) => s + x.actual, 0);
    return html`<tr class="section"><td colspan="5">${title}</td></tr>
      ${rows.map((x) => {
        const pct = x.budget ? Math.round((x.actual / x.budget) * 100) : null;
        const over = type === 'expense' ? x.actual > x.budget && x.budget : x.actual < x.budget * elapsed;
        return html`<tr><td><span class="mono muted">${x.code}</span> ${x.name}</td>
          <td class="num" style="width:160px">${w ? html`<input name="b_${x.id}" type="number" step="0.01" min="0" class="num" value="${x.budget ? fromCents(x.budget) : ''}" placeholder="0.00" aria-label="Budget for ${x.name}">` : money(x.budget)}</td>
          ${mcell(x.actual)}<td class="num ${over ? 'neg' : ''}">${x.budget ? money(x.variance) : ''}</td>
          <td style="width:180px">${pct != null ? html`<div class="bar-row"><span class="small muted">${pct}%</span><span></span><div class="bar-track"><div class="bar-fill" style="width:${Math.min(100, pct)}%;${type === 'expense' && pct > 100 ? 'background:var(--neg)' : ''}"></div></div></div>` : ''}</td></tr>`;
      })}
      <tr class="total"><td>Total ${title.toLowerCase()}</td>${mcell(tb)}${mcell(ta)}${mcell(ta - tb)}<td></td></tr>`;
  };
  page({
    title: 'Budgets',
    actions: html`<select data-change="year" style="width:110px" aria-label="Year">${[year - 2, year - 1, year, year + 1].map((y) => html`<option ${y === year ? 'selected' : ''}>${y}</option>`)}</select>`,
    body: html`<form data-submit="save"><div class="card table-wrap"><table><thead><tr><th>Account</th><th class="num">Annual budget</th><th class="num">Actual ${year}</th><th class="num">Variance</th><th>Used</th></tr></thead><tbody>
      ${section('income', 'Income')}${section('expense', 'Expenses')}</tbody></table></div>
      ${w ? html`<div style="margin-top:14px;text-align:right"><button class="btn primary">Save budget</button></div>` : ''}</form>`,
  });
});

// ============ settings ============
r('/o/:org/settings', () => go(oh('/settings/general')));
r('/o/:org/settings/:tab', async ({ tab }) => {
  const own = isOwner();
  const T = tabs([['general', 'General', oh('/settings/general')], ['members', 'Members & access', oh('/settings/members')], ['audit', 'Audit log', oh('/settings/audit')], ...(own ? [['danger', 'Danger zone', oh('/settings/danger')]] : [])], tab);
  let body = '';
  if (tab === 'general') {
    const o = S.org;
    ACT.save = async (d) => { await api('PUT', O(''), d); S.org = await GET(O('')); fmts[S.org.currency] = null; await refreshMe(); toast('Settings saved'); router(); };
    body = html`<form data-submit="save" class="card"><fieldset ${own ? '' : 'disabled'} style="border:0;margin:0;padding:0"><div class="card-b form-grid">
      <h3 class="full">Organisation</h3>
      ${field('Display name', html`<input name="name" required value="${o.name}">`)}${field('Legal name', html`<input name="legal_name" value="${o.legal_name || ''}">`)}
      ${field('Tax / VAT ID', html`<input name="tax_id" value="${o.tax_id || ''}">`)}${field('Currency', html`<input name="currency" maxlength="3" value="${o.currency}">`, { hint: 'Changing currency only changes display — amounts are not converted.' })}
      ${field('Email', html`<input name="email" type="email" value="${o.email || ''}">`)}${field('Phone', html`<input name="phone" value="${o.phone || ''}">`)}
      ${field('Address', html`<textarea name="address" rows="3">${o.address || ''}</textarea>`, { full: true })}
      <h3 class="full" style="margin-top:10px">Invoicing</h3>
      ${field('Default sales tax %', html`<input name="default_tax_rate" type="number" step="any" min="0" value="${o.default_tax_rate}">`)}${field('Payment terms (days)', html`<input name="payment_terms" type="number" min="0" value="${o.payment_terms}">`)}
      ${field('Invoice prefix', html`<input name="invoice_prefix" value="${o.invoice_prefix}">`)}${field('Next invoice number', html`<input name="next_invoice_no" type="number" min="1" value="${o.next_invoice_no}">`)}
      ${field('Bill prefix', html`<input name="bill_prefix" value="${o.bill_prefix}">`)}${field('Next bill number', html`<input name="next_bill_no" type="number" min="1" value="${o.next_bill_no}">`)}
      ${field('Invoice footer', html`<textarea name="invoice_footer" rows="3" placeholder="Bank details, thank-you note…">${o.invoice_footer || ''}</textarea>`, { full: true })}
    </div></fieldset>${own ? html`<div class="modal-f"><button class="btn primary">Save settings</button></div>` : ''}</form>`;
  } else if (tab === 'members') {
    const members = await GET(O('/members'));
    ACT.add = async () => {
      const res = await modal({
        title: 'Add member',
        body: html`<div class="form-grid">${field('Email', html`<input name="email" type="email" required>`, { full: true })}
          ${field('Role', html`<select name="role"><option value="viewer">Viewer — read-only</option><option value="accountant">Accountant — can record & edit</option><option value="owner">Owner — full control</option></select>`, { full: true })}
          <p class="hint full" style="margin:0">If the person doesn't have an account on this instance yet, fill these in to create one:</p>
          ${field('Name', html`<input name="name">`)}${field('Temporary password', html`<input name="password" type="password" minlength="8" autocomplete="new-password">`)}</div>`,
        submit: 'Add', onSubmit: (d) => api('POST', O('/members'), d),
      });
      if (res) { toast('Member added'); router(); }
    };
    ACT.role = async (el) => { await api('PUT', O(`/members/${el.dataset.id}`), { role: el.value }); toast('Role updated'); };
    ACT.remove = async (el) => { if (await confirmBox('Remove member?', 'They will lose access to this organisation.', { label: 'Remove' })) { await api('DELETE', O(`/members/${el.dataset.id}`)); router(); } };
    body = html`<div class="card"><div class="card-h"><div><h3>Members</h3><div class="muted small">Owners manage everything · Accountants record transactions · Viewers can only look</div></div>${own ? btn('Add member', 'add', { ic: 'plus', cls: 'primary' }) : ''}</div>
      <table><tbody>${members.map((m) => html`<tr><td><div class="row"><div class="avatar">${initials(m.name)}</div><div><div style="font-weight:550">${m.name}${m.id === S.me.id ? ' (you)' : ''}</div><div class="muted small">${m.email}</div></div></div></td>
        <td style="width:200px">${own ? html`<select data-change="role" data-id="${m.id}">${['owner', 'accountant', 'viewer'].map((r) => html`<option value="${r}" ${m.role === r ? 'selected' : ''}>${r[0].toUpperCase() + r.slice(1)}</option>`)}</select>` : badge('', m.role)}</td>
        <td style="width:50px">${own ? html`<button class="icon-btn" data-act="remove" data-id="${m.id}" aria-label="Remove">${icon('x')}</button>` : ''}</td></tr>`)}</tbody></table></div>`;
  } else if (tab === 'audit') {
    const log = await GET(O('/audit'));
    body = html`<div class="card table-wrap"><table class="compact"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th></tr></thead><tbody>
      ${log.map((a) => html`<tr><td class="small" style="white-space:nowrap">${new Date(a.at.replace(' ', 'T') + 'Z').toLocaleString()}</td><td>${a.user_name || '—'}</td><td><span class="badge">${a.action}</span>${a.entity_id ? html` <span class="muted small">#${a.entity_id}</span>` : ''}</td><td class="mono muted" style="max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${a.details || ''}</td></tr>`)}
    </tbody></table></div>`;
  } else if (tab === 'danger' && own) {
    ACT.delete = async () => {
      const res = await modal({ title: `Delete ${S.org.name}?`, danger: true, submit: 'Delete forever',
        body: html`<p style="margin-top:0">This permanently deletes the organisation and <b>all</b> its invoices, bills, payroll and ledger data. Download a backup first if unsure.</p>${field('Type the organisation name to confirm', html`<input name="confirm" required autocomplete="off">`)}`,
        onSubmit: (d) => api('DELETE', O(''), d) });
      if (res) { S.org = null; await refreshMe(); toast('Organisation deleted'); go('#/'); }
    };
    body = html`<div class="card card-b split" style="border-color:var(--neg)"><div><h3>Delete this organisation</h3><div class="muted">Removes all data for ${S.org.name}. This cannot be undone.</div></div>${btn('Delete organisation', 'delete', { cls: 'danger' })}</div>`;
  }
  page({ title: 'Settings', crumbs: S.org.name, body: html`${T}${body}` });
});

// ============ profile ============
r('/profile', async () => {
  S.org = null;
  let theme = 'system'; try { theme = localStorage.getItem('ledgerly-theme') || 'system'; } catch { /* blocked */ }
  ACT.save = async (d, f) => { await api('PUT', '/api/me', d); await refreshMe(); f.reset(); toast('Profile updated'); router(); };
  ACT.theme = (el) => { try { localStorage.setItem('ledgerly-theme', el.value); } catch { /* blocked */ } applyTheme(); };
  page({
    title: 'Your profile',
    body: html`<div class="grid g2" style="align-items:start">
      <form class="card" data-submit="save"><div class="card-h"><h3>Account</h3></div><div class="card-b stack">
        ${field('Name', html`<input name="name" value="${S.me.name}" required>`)}${field('Email', html`<input value="${S.me.email}" disabled>`)}
        <h3 style="padding-top:8px">Change password</h3>
        ${field('Current password', html`<input name="current_password" type="password" autocomplete="current-password">`)}${field('New password', html`<input name="new_password" type="password" minlength="8" autocomplete="new-password">`)}
      </div><div class="modal-f"><button class="btn primary">Save</button></div></form>
      <div class="card"><div class="card-h"><h3>Appearance</h3></div><div class="card-b">${field('Theme', html`<select data-change="theme">${['system', 'light', 'dark'].map((t) => html`<option value="${t}" ${theme === t ? 'selected' : ''}>${t[0].toUpperCase() + t.slice(1)}</option>`)}</select>`)}</div></div>
    </div>`,
  });
});

// ============ admin ============
r('/admin', async () => {
  S.org = null;
  if (!S.me.is_admin) return go('#/');
  const users = await GET('/api/admin/users');
  ACT.add = async () => {
    const res = await modal({ title: 'New user', body: html`<div class="form-grid">${field('Name', html`<input name="name" required>`)}${field('Email', html`<input name="email" type="email" required>`)}
      ${field('Password', html`<input name="password" type="password" minlength="8" required autocomplete="new-password">`)}<label class="check" style="padding-top:22px"><input type="checkbox" name="is_admin"> Instance administrator</label></div>`,
      submit: 'Create user', onSubmit: (d) => api('POST', '/api/admin/users', d) });
    if (res) { toast('User created'); router(); }
  };
  ACT.reset = async (el) => {
    const res = await modal({ title: 'Reset password', body: field('New password', html`<input name="password" type="password" minlength="8" required autocomplete="new-password">`, { hint: 'The user will be signed out of all sessions.' }),
      submit: 'Reset', onSubmit: (d) => api('PUT', `/api/admin/users/${el.dataset.id}`, d) });
    if (res) toast('Password reset');
  };
  ACT.toggleAdmin = async (el) => { await api('PUT', `/api/admin/users/${el.dataset.id}`, { is_admin: el.checked }); toast('Updated'); };
  ACT.del = async (el) => { if (await confirmBox('Delete user?', 'They lose access to every organisation. Their recorded transactions are kept.', { label: 'Delete' })) { await api('DELETE', `/api/admin/users/${el.dataset.id}`); router(); } };
  page({
    title: 'Administration', actions: html`<a class="btn" href="/api/admin/backup" download>${icon('download')}Download backup</a>${btn('New user', 'add', { ic: 'plus', cls: 'primary' })}`,
    body: html`<div class="notice">Backups are a full, consistent copy of the SQLite database. Restore by stopping Ledgerly and replacing <span class="mono">data/ledgerly.db</span>.</div>
      <div class="card table-wrap"><table><thead><tr><th>User</th><th>Created</th><th class="num">Organisations</th><th>Admin</th><th></th></tr></thead><tbody>
      ${users.map((u) => html`<tr><td><div style="font-weight:550">${u.name}</div><div class="muted small">${u.email}</div></td><td>${fmtDate(u.created_at)}</td><td class="num">${u.orgs}</td>
        <td><input type="checkbox" data-change="toggleAdmin" data-id="${u.id}" ${u.is_admin ? 'checked' : ''} ${u.id === S.me.id ? 'disabled' : ''} aria-label="Administrator"></td>
        <td class="num"><button class="btn sm" data-act="reset" data-id="${u.id}">Reset password</button> ${u.id !== S.me.id ? html`<button class="btn sm danger" data-act="del" data-id="${u.id}">Delete</button>` : ''}</td></tr>`)}
      </tbody></table></div>`,
  });
});

router();
