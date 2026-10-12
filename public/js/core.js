'use strict';
/* Ledgerly frontend core — dependency-free SPA. Strict CSP: no inline handlers, all events delegated.
   Page modules (sales.js, banking.js, …) register routes with r(); main.js starts the router. */

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
const locale = () => (S.org && S.org.locale) || undefined;
const baseCur = () => (S.org && S.org.currency) || 'USD';
function money(c, cur) {
  cur = cur || baseCur();
  const k = cur + (locale() || '');
  try { fmts[k] = fmts[k] || new Intl.NumberFormat(locale(), { style: 'currency', currency: cur }); return fmts[k].format((c || 0) / 100); }
  catch { return ((c || 0) / 100).toFixed(2) + ' ' + cur; }
}
function moneyShort(c, cur) {
  cur = cur || baseCur();
  try { return new Intl.NumberFormat(locale(), { style: 'currency', currency: cur, notation: 'compact', maximumFractionDigits: 1 }).format((c || 0) / 100); }
  catch { return Math.round((c || 0) / 100).toString(); }
}
const num = (n, digits = 2) => new Intl.NumberFormat(locale(), { maximumFractionDigits: digits }).format(n || 0);
const mcell = (c, cur) => html`<td class="num ${c < 0 ? 'neg' : ''}">${money(c, cur)}</td>`;
const toCents = (v) => Math.round((parseFloat(String(v).replace(/\s/g, '').replace(',', '.')) || 0) * 100);
const fromCents = (c) => (c == null ? '' : String(Math.round(c) / 100));
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);
function fmtDate(d) {
  if (!d) return '';
  const x = new Date(d.length === 10 ? d + 'T00:00:00' : d.replace(' ', 'T') + 'Z');
  return isNaN(x) ? d : x.toLocaleDateString(locale(), { year: 'numeric', month: 'short', day: 'numeric' });
}
const initials = (n) => String(n || '?').split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
const TYPE_LABEL = { asset: 'Assets', liability: 'Liabilities', equity: 'Equity', income: 'Income', expense: 'Expenses' };
const STATUS_COLOR = { draft: '', sent: 'blue', open: 'blue', partial: 'amber', paid: 'green', void: '', overdue: 'red', posted: 'green', sent_ok: 'green', failed: 'red' };
const badge = (s, label) => html`<span class="badge ${STATUS_COLOR[s] ?? ''}">${label || s}</span>`;
const docStatus = (d) => (d.overdue ? badge('overdue', d.status === 'partial' ? 'Partial · overdue' : 'Overdue') : badge(d.status));
const curBadge = (cur) => (cur && cur !== baseCur() ? html` <span class="badge blue">${cur}</span>` : '');
const currencies = () => (S.org && S.org.enabled_currencies) || [baseCur()];
const curOptions = (sel) => currencies().map((c) => html`<option value="${c}" ${c === (sel || baseCur()) ? 'selected' : ''}>${c}${c === baseCur() ? ' (base)' : ''}</option>`);
const rateLabel = (cur) => `1 ${cur} = ? ${baseCur()}`;
async function lookupRate(cur, date) {
  if (!cur || cur === baseCur()) return 1;
  const r = await GET(O(`/rates/lookup?currency=${cur}&date=${date || today()}`));
  return r.found ? r.rate : null;
}

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
  box: 'M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8M12 13v8',
  repeat: 'M17 1l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3',
  mail: 'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM22 6l-10 7L2 6',
  refresh: 'M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M12 18v-6M9 15l3 3 3-3',
};
const icon = (n) => raw(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[n]}"/></svg>`);

// ============ toasts & modals ============
function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type; el.textContent = msg;
  $('#toast-root').appendChild(el);
  setTimeout(() => el.remove(), type === 'error' ? 6000 : 2800);
}
function formData(form) {
  const o = {};
  for (const el of form.elements) {
    if (!el.name || el.type === 'file' || el.disabled) continue;
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
      const b = $('[type=submit]', form); if (b) b.disabled = true;
      err.classList.add('hidden');
      try { const r = onSubmit ? await onSubmit(formData(form), form) : true; close(r === undefined ? true : r); }
      catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); if (b) b.disabled = false; }
    });
    if (onMount) onMount(form, close);
    const f = $('input:not([type=hidden]):not([readonly]):not([disabled]),select,textarea', $('.modal-b', root)); if (f) f.focus();
  });
}
const showErr = (form, msg) => { const e = $('.err', form); e.textContent = msg; e.classList.remove('hidden'); };
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
    ${navLink(oh('/recurring'), 'repeat', 'Recurring invoices', is('/recurring'))}
    ${navLink(oh('/bills'), 'bill', 'Bills & expenses', is('/bills'))}
    ${navLink(oh('/contacts'), 'users', 'Contacts', is('/contacts'))}
    ${navLink(oh('/banking'), 'bank', 'Banking', is('/banking'))}
    <div class="nav-label">Operations</div>
    ${navLink(oh('/products'), 'box', 'Products & stock', is('/products'))}
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
const field = (label, input, { full, hint, cls = '' } = {}) => html`<label class="field ${full ? 'full' : ''} ${cls}"><span class="field-label">${label}</span>${input}${hint ? html`<span class="hint">${hint}</span>` : ''}</label>`;
const empty = (title, text, action) => html`<div class="empty"><h3>${title}</h3><div>${text}</div>${action || ''}</div>`;
const tabs = (items, active) => html`<div class="tabs">${items.map(([k, label, href]) => html`<a href="${href}" class="${k === active ? 'active' : ''}">${label}</a>`)}</div>`;
const kpi = (label, value, sub, cls = '') => html`<div class="card kpi"><div class="label">${label}</div><div class="value ${cls}">${value}</div>${sub ? html`<div class="sub">${sub}</div>` : ''}</div>`;

// ============ data caches ============
async function accounts(force) {
  if (!S.accounts || force) S.accounts = await GET(O('/accounts'));
  return S.accounts;
}
const accLabel = (a) => `${a.code} · ${a.name}${a.currency ? ` (${a.currency})` : ''}`;
function accountOptions(list, sel, blank) {
  const groups = {};
  for (const a of list) (groups[a.type] = groups[a.type] || []).push(a);
  return html`${blank ? html`<option value="">${blank}</option>` : ''}${Object.entries(groups).map(([t, xs]) =>
    html`<optgroup label="${TYPE_LABEL[t]}">${xs.map((a) => html`<option value="${a.id}" ${String(a.id) === String(sel) ? 'selected' : ''}>${accLabel(a)}</option>`)}</optgroup>`)}`;
}
const live = (list) => list.filter((a) => !a.archived);
const banks = (list) => live(list).filter((a) => a.is_bank);
const accCur = (a) => (a && a.currency) || baseCur();
const sysAcc = (list, key) => list.find((a) => a.system_key === key) || {};
const contactOptions = (list, sel, blank = '— none —') => html`<option value="">${blank}</option>${list.map((c) => html`<option value="${c.id}" ${String(c.id) === String(sel) ? 'selected' : ''}>${c.name}</option>`)}`;
const suggestFee = (acc, amountCents) => (acc ? Math.round((acc.fee_fixed || 0) + (amountCents * (acc.fee_percent || 0)) / 100) : 0);

// ============ charts ============
function niceMax(v) { const p = Math.pow(10, Math.floor(Math.log10(v))); for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p; return v; }
function barChart(series) {
  const W = 720, H = 250, l = 64, r = 8, t = 12, b = 28, iw = W - l - r, ih = H - t - b;
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
    const lab = new Date(s.month + '-01T00:00:00').toLocaleDateString(locale(), { month: 'short' });
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
async function reloadOrg() { S.org = await GET(`/api/orgs/${S.org.id}`); }

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
  if (!a || a.closest('#modal-root form')) return;
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
