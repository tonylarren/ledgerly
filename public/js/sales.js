'use strict';
/* Portfolio, dashboard, invoices & bills, payments, email, recurring invoices, contacts. */

// ============ portfolio (all orgs) ============
async function newOrgModal() {
  const res = await modal({
    title: 'New organisation',
    body: html`<div class="form-grid">
      ${field('Name', html`<input name="name" required placeholder="Acme Ltd">`, { full: true })}
      ${field('Base currency', html`<select name="currency">${['USD', 'EUR', 'MGA'].map((c) => html`<option value="${c}">${c}</option>`)}</select>`, { hint: 'Your books are kept in this currency. USD, EUR and MGA are all enabled for invoicing.' })}
      ${field('Default sales tax %', html`<input name="default_tax_rate" type="number" step="any" min="0" value="0">`, { hint: 'Madagascar standard VAT (TVA) is 20%' })}
    </div><p class="hint" style="margin:14px 0 0">A standard chart of accounts is created automatically. Organisations in MGA use Madagascar payroll (CNaPS, OSTIE, FMFP, IRSA) by default.</p>`,
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
    <tr class="click" data-href="${oh(`/${kind}s/${x.id}`)}"><td><div style="font-weight:550">${x.contact_name || '—'}</div><div class="muted small">${x.number} · due ${fmtDate(x.due_date)}</div></td>${mcell(x.due, x.currency)}</tr>`)}</tbody></table>`
    : html`<div class="empty" style="padding:24px">Nothing here 🎉</div>`;
  page({
    title: S.org.name, crumbs: 'Dashboard',
    actions: canWrite() ? html`${linkBtn('New invoice', oh('/invoices/new'), { ic: 'plus', cls: 'primary' })}${linkBtn('New bill', oh('/bills/new'), { ic: 'plus' })}` : '',
    body: html`
      <div class="grid g4">
        ${kpi('Cash & bank', money(s.cash), 'All bank accounts, in ' + baseCur())}
        ${kpi('Receivables', money(s.ar), html`${s.arCount} open · ${s.overdue ? html`<span class="neg">${money(s.overdue)} overdue</span>` : 'none overdue'}`)}
        ${kpi('Payables', money(s.ap), `${s.apCount} unpaid bill${s.apCount === 1 ? '' : 's'}`)}
        ${kpi('Net income (YTD)', money(s.ytdNet), `This month ${money(s.mtdNet)}`, s.ytdNet < 0 ? 'neg' : 'pos')}
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
      ${d.lowStock.length || d.recurring.length ? html`<div class="grid g2">
        <div class="card"><div class="card-h"><h3>Low stock</h3><a class="small" href="${oh('/products')}">Products →</a></div>
          ${d.lowStock.length ? html`<table class="compact"><tbody>${d.lowStock.map((p) => html`<tr class="click" data-href="${oh('/products/' + p.id)}"><td><div style="font-weight:550">${p.name}</div><div class="muted small">${p.sku || ''}</div></td>
            <td class="num neg">${num(p.qty)} ${p.unit || ''}</td><td class="num muted small">reorder at ${num(p.reorder_level)}</td></tr>`)}</tbody></table>` : html`<div class="empty" style="padding:24px">Stock levels are fine.</div>`}</div>
        <div class="card"><div class="card-h"><h3>Upcoming recurring invoices</h3><a class="small" href="${oh('/recurring')}">All →</a></div>
          ${d.recurring.length ? html`<table class="compact"><tbody>${d.recurring.map((x) => html`<tr class="click" data-href="${oh('/recurring/' + x.id)}"><td><div style="font-weight:550">${x.name || x.contact_name}</div><div class="muted small">${x.contact_name}</div></td><td class="num">${fmtDate(x.next_date)}</td></tr>`)}</tbody></table>` : html`<div class="empty" style="padding:24px">None scheduled.</div>`}</div>
      </div>` : ''}
      <p class="muted small" style="margin-top:18px">${s.employees} active employee${s.employees === 1 ? '' : 's'} · stock value ${money(s.stockValue)} · YTD income ${money(s.ytdIncome)} · YTD expenses ${money(s.ytdExpenses)}</p>`,
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
  const sum = (xs) => xs.reduce((s, d) => s + d.due_base, 0);
  const overdue = all.filter((d) => d.overdue);
  const T = (k, label) => [k, label, oh(`/${D.path}${k ? '?status=' + k : ''}`)];
  page({
    title: D.plural,
    actions: html`${kind === 'invoice' ? linkBtn('Recurring', oh('/recurring'), { ic: 'repeat' }) : ''}${canWrite() ? linkBtn(`New ${D.label.toLowerCase()}`, oh(`/${D.path}/new`), { ic: 'plus', cls: 'primary' }) : ''}`,
    body: html`
      <div class="grid g3">
        ${kpi('Outstanding', money(sum(open)), `${open.length} open · in ${baseCur()}`)}
        ${kpi('Overdue', money(sum(overdue)), `${overdue.length} ${D.plural.toLowerCase().split(' ')[0]}`, sum(overdue) ? 'neg' : '')}
        ${kpi('Drafts', all.filter((d) => d.status === 'draft').length, `Not yet ${kind === 'invoice' ? 'sent' : 'approved'}`)}
      </div>
      <div class="card" style="margin-top:18px"><div style="padding:0 14px">${tabs([T('', 'All'), T('draft', 'Draft'), T(D.open, kind === 'invoice' ? 'Sent' : 'Open'), T('partial', 'Partially paid'), T('overdue', 'Overdue'), T('paid', 'Paid'), T('void', 'Void')], status)}</div>
      ${rows.length ? html`<div class="table-wrap" style="margin-top:-18px"><table><thead><tr><th>Number</th><th>${D.party}</th><th>Issued</th><th>Due</th><th class="num">Total</th><th class="num">Balance due</th><th>Status</th></tr></thead><tbody>
        ${rows.map((d) => html`<tr class="click" data-href="${oh(`/${D.path}/${d.id}`)}"><td class="mono">${d.number}${d.recurring_id ? html` <span title="From a recurring invoice">${icon('repeat')}</span>` : ''}</td><td>${d.contact_name || '—'}${curBadge(d.currency)}</td><td>${fmtDate(d.issue_date)}</td><td>${fmtDate(d.due_date)}</td>
          ${mcell(d.total, d.currency)}${mcell(d.status === 'void' ? 0 : d.total - d.amount_paid, d.currency)}<td>${docStatus(d)}${d.last_emailed_at ? html` <span class="badge teal" title="Emailed ${fmtDate(d.last_emailed_at)}">emailed</span>` : ''}</td></tr>`)}
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
      ${field('Tax ID (NIF / STAT)', html`<input name="tax_id" value="${c.tax_id || ''}">`)}
      ${field('Email', html`<input name="email" type="email" value="${c.email || ''}">`, { hint: 'Invoices are emailed here' })}
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
        catch (e) { showErr(form, e.message); }
      });
    },
  });
  return deleted ? { deleted } : res;
}

// ---- shared line-item editor (invoices, bills, recurring invoices) ----
const productOptions = (products, sel) => html`<option value="">— no product —</option>${products.filter((p) => p.active || String(p.id) === String(sel))
  .map((p) => html`<option value="${p.id}" ${String(p.id) === String(sel) ? 'selected' : ''}>${p.sku ? p.sku + ' · ' : ''}${p.name}</option>`)}`;
function itemRow(kind, accs, products, it = {}) {
  return html`<tr>
    <td style="width:170px"><select name="product_id" aria-label="Product">${productOptions(products, it.product_id)}</select></td>
    <td><input name="description" value="${it.description || ''}" placeholder="Description" aria-label="Description"><div class="hint stock-hint"></div></td>
    <td style="width:200px"><select name="account_id" aria-label="Account">${accountOptions(live(accs).filter((a) => a.type === DOC[kind].accType), it.account_id, 'Default account')}</select></td>
    <td style="width:78px"><input name="quantity" type="number" step="any" class="num" value="${it.quantity ?? 1}" aria-label="Quantity"></td>
    <td style="width:120px"><input name="unit_price" type="number" step="any" class="num" value="${it.unit_price != null ? fromCents(it.unit_price) : ''}" placeholder="0" aria-label="Unit price"></td>
    <td style="width:72px"><input name="tax_rate" type="number" step="any" min="0" class="num" value="${it.tax_rate ?? S.org.default_tax_rate}" aria-label="Tax %"></td>
    <td class="num amt" style="width:120px"></td>
    <td style="width:34px"><button type="button" class="icon-btn" data-rm aria-label="Remove line">${icon('x')}</button></td>
  </tr>`;
}
const itemsTable = (kind, accs, products, items) => html`<div class="table-wrap"><table class="lines-table"><thead><tr><th>Product</th><th>Item</th><th>Account</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Tax %</th><th class="num">Amount</th><th></th></tr></thead>
  <tbody class="items-body">${(items.length ? items : [{}]).map((it) => itemRow(kind, accs, products, it))}</tbody></table></div>
  <button type="button" class="btn sm add-line" style="margin-top:10px">${icon('plus')}Add line</button>`;
const totalsBlock = () => html`<div class="stack" style="font-variant-numeric:tabular-nums">
  <div class="split"><span class="muted">Subtotal</span><b class="t-sub"></b></div>
  <div class="split"><span class="muted">Tax</span><b class="t-tax"></b></div>
  <div class="split" style="font-size:18px;border-top:1px solid var(--border);padding-top:10px"><span>Total</span><b class="t-total"></b></div>
  <div class="split muted small t-base-row hidden"><span>In base currency</span><span class="t-base"></span></div></div>`;

// Wires up an items table inside `root`. getCur() → document currency, getRate() → base per 1 doc unit.
function mountItems(root, kind, accs, products, { getCur, getRate }) {
  const body = $('.items-body', root);
  const recalc = () => {
    let sub = 0, tax = 0;
    const cur = getCur();
    for (const tr of $$('tr', body)) {
      const line = Math.round((+$('[name=quantity]', tr).value || 0) * toCents($('[name=unit_price]', tr).value));
      sub += line; tax += Math.round((line * (+$('[name=tax_rate]', tr).value || 0)) / 100);
      $('.amt', tr).textContent = money(line, cur);
      const p = products.find((x) => String(x.id) === $('[name=product_id]', tr).value);
      const hint = $('.stock-hint', tr);
      if (p && p.kind === 'inventory') {
        const want = +$('[name=quantity]', tr).value || 0;
        hint.textContent = `${num(p.qty)} ${p.unit || ''} in stock` + (kind === 'invoice' && want > p.qty ? ' — not enough' : '');
        hint.className = 'hint stock-hint ' + (kind === 'invoice' && want > p.qty ? 'neg' : '');
      } else hint.textContent = '';
      $('[name=account_id]', tr).disabled = kind === 'bill' && p && p.kind === 'inventory';
    }
    $('.t-sub', root).textContent = money(sub, cur); $('.t-tax', root).textContent = money(tax, cur); $('.t-total', root).textContent = money(sub + tax, cur);
    const rate = getRate(), foreign = cur !== baseCur();
    $('.t-base-row', root).classList.toggle('hidden', !foreign);
    if (foreign) $('.t-base', root).textContent = rate ? `≈ ${money(Math.round((sub + tax) * rate))}` : 'no rate';
  };
  body.addEventListener('input', recalc);
  body.addEventListener('change', (e) => {
    if (e.target.name !== 'product_id') return recalc();
    const tr = e.target.closest('tr');
    const p = products.find((x) => String(x.id) === e.target.value);
    if (p) {
      const desc = $('[name=description]', tr);
      if (!desc.value || desc.dataset.auto === '1') { desc.value = p.name; desc.dataset.auto = '1'; }
      const basePrice = kind === 'invoice' ? p.sale_price : p.purchase_price;
      const rate = getRate() || 1;
      $('[name=unit_price]', tr).value = fromCents(Math.round(basePrice / rate));
      if (p.tax_rate != null) $('[name=tax_rate]', tr).value = p.tax_rate;
      const acc = kind === 'invoice' ? p.income_account_id : p.expense_account_id;
      if (acc) $('[name=account_id]', tr).value = acc;
    }
    recalc();
  });
  body.addEventListener('click', (e) => { if (e.target.closest('[data-rm]')) { if ($$('tr', body).length > 1) e.target.closest('tr').remove(); recalc(); } });
  $('.add-line', root).addEventListener('click', () => { body.insertAdjacentHTML('beforeend', itemRow(kind, accs, products).s); recalc(); $('tr:last-child [name=description]', body).focus(); });
  recalc();
  return {
    recalc,
    read: () => $$('tr', body).map((tr) => ({
      product_id: $('[name=product_id]', tr).value || null, description: $('[name=description]', tr).value,
      account_id: $('[name=account_id]', tr).disabled ? null : $('[name=account_id]', tr).value || null,
      quantity: +$('[name=quantity]', tr).value || 0, unit_price: toCents($('[name=unit_price]', tr).value), tax_rate: +$('[name=tax_rate]', tr).value || 0,
    })).filter((i) => i.description.trim()),
  };
}

// Currency + exchange-rate fields; keeps the rate in sync with the chosen currency and date.
function currencyFields(cur, rate) {
  return html`${field('Currency', html`<select name="currency">${curOptions(cur)}</select>`)}
    ${field(html`<span class="rate-label">${rateLabel(cur && cur !== baseCur() ? cur : 'EUR')}</span>`, html`<input name="exchange_rate" type="number" step="any" min="0" value="${rate && cur !== baseCur() ? rate : ''}">`, { cls: 'rate-field' + (cur && cur !== baseCur() ? '' : ' hidden'), hint: html`<span class="rate-hint"></span>` })}`;
}
function mountCurrency(form, dateField, onChange) {
  const sel = $('[name=currency]', form), rate = $('[name=exchange_rate]', form), wrap = $('.rate-field', form), hint = $('.rate-hint', form);
  const refresh = async (force) => {
    const cur = sel.value, foreign = cur !== baseCur();
    wrap.classList.toggle('hidden', !foreign);
    $('.rate-label', form).textContent = rateLabel(cur);
    if (foreign && (force || !rate.value)) {
      const r = await lookupRate(cur, dateField ? $(`[name=${dateField}]`, form).value : today());
      rate.value = r || '';
      hint.textContent = r ? 'From your saved rates — edit if needed' : 'No saved rate — enter one (Settings → Currencies)';
    }
    onChange && onChange();
  };
  sel.addEventListener('change', () => refresh(true));
  if (dateField) $(`[name=${dateField}]`, form).addEventListener('change', () => sel.value !== baseCur() && refresh(true));
  rate.addEventListener('input', () => onChange && onChange());
  refresh(false);
  return { cur: () => sel.value, rate: () => (sel.value === baseCur() ? 1 : +rate.value || 0) };
}

async function pageDocEdit(kind, id, q = {}) {
  const D = DOC[kind];
  const [accs, contacts, products, doc] = await Promise.all([accounts(), GET(O(`/contacts?kind=${D.kind}`)), GET(O('/products')), id ? GET(O(`/${D.path}/${id}`)) : null]);
  if (doc && doc.status !== 'draft') return go(oh(`/${D.path}/${id}`));
  const d = doc || { issue_date: today(), due_date: addDays(today(), S.org.payment_terms), items: [], contact_id: q.contact_id, currency: q.currency || baseCur() };
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
        ${currencyFields(d.currency, d.exchange_rate)}
      </div>
      <div style="margin-top:22px" id="items-root">${itemsTable(kind, accs, products, d.items)}
      <div class="grid g2" style="margin-top:20px;align-items:start">
        ${field('Notes / payment instructions', html`<textarea name="notes" rows="4">${d.notes || ''}</textarea>`)}
        ${totalsBlock()}
      </div></div>
    </div>
    <div class="modal-f"><div class="err hidden" id="doc-err" style="margin:0 auto 0 0"></div>
      <a class="btn" href="${doc ? oh(`/${D.path}/${doc.id}`) : oh('/' + D.path)}">Cancel</a>
      <button class="btn" type="submit" name="mode" value="draft">Save draft</button>
      <button class="btn primary" type="submit" name="mode" value="final">Save & ${D.finalize.toLowerCase()}</button></div>
    </form>`,
  });
  const form = $('#doc-form');
  let items;
  const curCtl = mountCurrency(form, 'issue_date', () => items && items.recalc());
  items = mountItems($('#items-root'), kind, accs, products, { getCur: curCtl.cur, getRate: curCtl.rate });
  $('[name=issue_date]', form).addEventListener('change', (e) => { if (!doc) $('[name=due_date]', form).value = addDays(e.target.value, S.org.payment_terms); });
  $('#new-contact').addEventListener('click', async () => {
    const res = await contactModal({}, D.kind);
    if (res && res.id) { const list = await GET(O(`/contacts?kind=${D.kind}`)); $('[name=contact_id]', form).innerHTML = contactOptions(list, res.id, `Select ${D.party.toLowerCase()}…`).s; }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = formData(form);
    const payload = { contact_id: fd.contact_id, number: fd.number, reference: fd.reference, issue_date: fd.issue_date, due_date: fd.due_date, notes: fd.notes,
      currency: fd.currency, exchange_rate: fd.currency !== baseCur() ? fd.exchange_rate : undefined, items: items.read() };
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
  const D = DOC[kind], cur = d.currency || org.currency;
  const due = d.total - d.amount_paid;
  return html`<div class="doc">
    <div class="doc-head">
      <div><div class="doc-title">${kind === 'invoice' ? 'INVOICE' : 'BILL'}</div>
        <div style="margin-top:10px;font-weight:600">${kind === 'invoice' ? org.legal_name || org.name : d.contact_name}</div>
        <div style="font-size:13px;color:#4b5563;white-space:pre-line">${kind === 'invoice' ? [org.address, org.email, org.phone, org.tax_id && 'Tax ID: ' + org.tax_id].filter(Boolean).join('\n') : ''}</div></div>
      <div class="meta"><span>Number</span><b>${d.number}</b><span>Issue date</span><span>${fmtDate(d.issue_date)}</span><span>Due date</span><span>${fmtDate(d.due_date)}</span>${d.reference ? html`<span>Reference</span><span>${d.reference}</span>` : ''}${cur !== org.currency ? html`<span>Currency</span><span>${cur}</span>` : ''}</div>
    </div>
    <div class="parties">
      <div><h4>${D.partyHead}</h4><b>${kind === 'invoice' ? d.contact_name : org.legal_name || org.name}</b>
${kind === 'invoice' ? [d.contact_address, d.contact_email, d.contact_tax_id && 'Tax ID: ' + d.contact_tax_id].filter(Boolean).join('\n') : ''}</div>
      <div style="text-align:right"><h4>Amount due</h4><div style="font-size:24px;font-weight:700">${money(d.status === 'void' ? 0 : due, cur)}</div></div>
    </div>
    <table><thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Tax</th><th class="num">Amount</th></tr></thead><tbody>
      ${d.items.map((i) => html`<tr><td>${i.description}${i.product_sku ? html` <span style="color:#9ca3af;font-size:12px">${i.product_sku}</span>` : ''}</td><td class="num">${i.quantity}</td><td class="num">${money(i.unit_price, cur)}</td><td class="num">${i.tax_rate}%</td><td class="num">${money(Math.round(i.quantity * i.unit_price), cur)}</td></tr>`)}
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
  const accs = await accounts(true);
  const base = baseCur(), docCur = d.currency, foreign = docCur !== base;
  const allowed = banks(accs).filter((a) => [base, docCur].includes(accCur(a)));
  const def = allowed.find((a) => accCur(a) === docCur && foreign) || allowed.find((a) => a.system_key === 'bank') || allowed[0];
  const due = d.total - d.amount_paid;
  return modal({
    title: kind === 'invoice' ? 'Record payment received' : 'Record payment made',
    body: html`<div class="form-grid">
      ${field(`Amount (${docCur})`, html`<input name="amount" type="number" step="any" min="0" required value="${fromCents(due)}">`, { hint: `Balance due ${money(due, docCur)}` })}
      ${field('Date', html`<input name="date" type="date" required value="${today()}">`)}
      ${field(kind === 'invoice' ? 'Deposit to' : 'Paid from', html`<select name="account_id" required>${accountOptions(allowed, def && def.id)}</select>`, { hint: foreign ? `Accounts in ${docCur} or ${base}` : '' })}
      ${field(html`Bank fee (<span class="fee-cur">${accCur(def)}</span>)`, html`<input name="fee" type="number" step="any" min="0" value="${fromCents(suggestFee(def, due))}">`, { hint: kind === 'invoice' ? 'Deducted by the bank from the amount received' : 'Charged on top of the payment' })}
      ${foreign ? field(rateLabel(docCur), html`<input name="exchange_rate" type="number" step="any" min="0" required>`, { hint: html`Invoice was booked at ${num(d.exchange_rate, 6)}` }) : ''}
      ${field('Method', html`<select name="method">${['Bank transfer', 'Card', 'Cash', 'Cheque', 'Mobile money (MVola / Orange Money / Airtel)', 'Other'].map((m) => html`<option>${m}</option>`)}</select>`)}
      ${field('Reference', html`<input name="reference">`, { full: !foreign })}
    </div><div class="notice" id="pay-preview" style="margin:14px 0 0" hidden></div>`,
    submit: 'Record payment',
    onMount: (form) => {
      const $f = (n) => $(`[name=${n}]`, form);
      let feeTouched = false;
      $f('fee').addEventListener('input', () => { feeTouched = true; preview(); });
      const preview = () => {
        const acc = accs.find((a) => String(a.id) === $f('account_id').value);
        $('.fee-cur', form).textContent = accCur(acc);
        if (!feeTouched) $f('fee').value = fromCents(suggestFee(acc, toCents($f('amount').value)));
        const pv = $('#pay-preview', form);
        if (!foreign) { pv.hidden = true; return; }
        const amt = toCents($f('amount').value), rate = +$f('exchange_rate').value || 0;
        const now = Math.round(amt * rate), then = Math.round(amt * d.exchange_rate), diff = kind === 'invoice' ? now - then : then - now;
        pv.hidden = !rate;
        pv.textContent = `≈ ${money(now)} today vs ${money(then)} when booked → exchange ${diff >= 0 ? 'gain' : 'loss'} of ${money(Math.abs(diff))}`;
      };
      ['amount', 'account_id'].forEach((n) => $f(n).addEventListener('input', preview));
      $f('account_id').addEventListener('change', () => { feeTouched = false; preview(); });
      if (foreign) {
        const load = async () => { $f('exchange_rate').value = (await lookupRate(docCur, $f('date').value)) || ''; preview(); };
        $f('date').addEventListener('change', load);
        $f('exchange_rate').addEventListener('input', preview);
        load();
      }
      preview();
    },
    onSubmit: (f) => api('POST', O(`/${DOC[kind].path}/${d.id}/payments`), { ...f, amount: toCents(f.amount), fee: toCents(f.fee) }),
  });
}

async function emailModal(d) {
  const draft = await GET(O(`/invoices/${d.id}/email`));
  return modal({
    title: `Email ${d.number}`, wide: true, submit: draft.ready ? 'Send email' : null,
    body: html`${draft.ready ? '' : html`<div class="notice warn">Email isn't set up yet. ${isOwner() ? html`<a href="${oh('/settings/email')}">Configure SMTP in Settings → Email</a>.` : 'Ask an owner to configure SMTP in Settings → Email.'}</div>`}
      ${d.status === 'draft' ? html`<div class="notice">Sending will mark this draft as sent and post it to the ledger.</div>` : ''}
      <div class="form-grid">
        ${field('To', html`<input name="to" required value="${draft.to}" placeholder="customer@example.com">`, { hint: 'Separate several addresses with commas' })}
        ${field('Cc', html`<input name="cc" placeholder="optional">`)}
        ${field('Subject', html`<input name="subject" required value="${draft.subject}">`, { full: true })}
        ${field('Message', html`<textarea name="message" rows="9">${draft.message}</textarea>`, { full: true })}
        <label class="check full"><input type="checkbox" name="attach_pdf" checked> Attach invoice as PDF (${d.number}.pdf)</label>
      </div>`,
    onSubmit: (f) => api('POST', O(`/invoices/${d.id}/email`), f),
  });
}

async function pageDocView(kind, id) {
  const D = DOC[kind];
  const d = await GET(O(`/${D.path}/${id}`));
  const w = canWrite();
  const reload = () => router();
  const foreign = d.currency !== baseCur();
  ACT.finalize = async () => { await api('POST', O(`/${D.path}/${id}/finalize`)); toast(`${D.label} posted to the ledger`); reload(); };
  ACT.del = async () => { if (await confirmBox(`Delete ${d.number}?`, 'This draft will be permanently removed.', { label: 'Delete' })) { await api('DELETE', O(`/${D.path}/${id}`)); toast('Deleted'); go(oh('/' + D.path)); } };
  ACT.void = async () => { if (await confirmBox(`Void ${d.number}?`, 'A reversing journal entry will be posted (and any stock movements undone). This cannot be undone.', { label: 'Void' })) { await api('POST', O(`/${D.path}/${id}/void`)); toast('Voided'); reload(); } };
  ACT.pay = async () => { if (await paymentModal(kind, d)) { toast('Payment recorded'); reload(); } };
  ACT.email = async () => { if (await emailModal(d)) { toast('Email sent'); reload(); } };
  ACT.delPay = async (el) => { if (await confirmBox('Remove payment?', 'The payment will be reversed in the ledger.', { label: 'Remove' })) { await api('DELETE', O(`/${D.path}/${id}/payments/${el.dataset.id}`)); reload(); } };
  ACT.dup = () => go(oh(`/${D.path}/new?contact_id=${d.contact_id}&currency=${d.currency}`));
  const open = ['sent', 'open', 'partial'].includes(d.status);
  page({
    title: `${D.label} ${d.number}`, crumbs: html`<a href="${oh('/' + D.path)}">${D.plural}</a>`,
    actions: html`
      ${linkBtn('Print', `#/print/${S.org.id}/${kind}/${d.id}?auto=1`, { ic: 'print', blank: true })}
      <a class="btn" href="${O(`/${D.path}/${d.id}/pdf?download=1`)}" download>${icon('file')}PDF</a>
      ${w && kind === 'invoice' && d.status !== 'void' ? btn('Email', 'email', { ic: 'mail' }) : ''}
      ${w && d.status === 'draft' ? html`${btn('Delete', 'del', { cls: 'danger' })}${linkBtn('Edit', oh(`/${D.path}/${d.id}/edit`))}${btn(D.finalize, 'finalize', { cls: 'primary' })}` : ''}
      ${w && open && !d.amount_paid ? btn('Void', 'void', { cls: 'danger' }) : ''}
      ${w && open ? btn('Record payment', 'pay', { cls: 'primary' }) : ''}`,
    body: html`<div class="grid g-side">
      <div>${docHtml(kind, d, d.org)}</div>
      <div class="stack">
        <div class="card card-b stack">
          <div class="split"><span class="muted">Status</span>${docStatus({ ...d, overdue: open && d.due_date < today() })}</div>
          <div class="split"><span class="muted">${D.party}</span><b>${d.contact_name}</b></div>
          <div class="split"><span class="muted">Total</span><b>${money(d.total, d.currency)}</b></div>
          <div class="split"><span class="muted">Paid</span><b>${money(d.amount_paid, d.currency)}</b></div>
          <div class="split"><span class="muted">Balance</span><b>${money(d.status === 'void' ? 0 : d.total - d.amount_paid, d.currency)}</b></div>
          ${foreign ? html`<div class="split small"><span class="muted">Rate</span><span>1 ${d.currency} = ${num(d.exchange_rate, 6)} ${baseCur()}</span></div>
            <div class="split small"><span class="muted">Booked value</span><span>${money(d.total_base)}</span></div>` : ''}
          ${d.recurring_id ? html`<a class="small" href="${oh('/recurring/' + d.recurring_id)}">${icon('repeat')} Generated by a recurring invoice</a>` : ''}
        </div>
        <div class="card"><div class="card-h"><h3>Payments</h3></div>
          ${d.payments.length ? html`<table class="compact"><tbody>${d.payments.map((p) => html`<tr><td><div>${fmtDate(p.date)}</div><div class="muted small">${p.method || ''} · ${p.account_name}${p.fee ? ` · fee ${money(p.fee, p.account_currency || baseCur())}` : ''}</div></td>${mcell(p.amount, d.currency)}<td style="width:30px">${w ? html`<button class="icon-btn" data-act="delPay" data-id="${p.id}" aria-label="Remove payment">${icon('x')}</button>` : ''}</td></tr>`)}</tbody></table>`
            : html`<div class="card-b muted small">No payments yet.</div>`}
        </div>
        ${kind === 'invoice' ? html`<div class="card"><div class="card-h"><h3>Emails</h3></div>
          ${d.emails.length ? html`<table class="compact"><tbody>${d.emails.map((e) => html`<tr><td><div>${e.to_addr}</div><div class="muted small">${fmtDate(e.sent_at)}${e.user_name ? ' · ' + e.user_name : ' · automatic'}</div>${e.error ? html`<div class="small neg">${e.error}</div>` : ''}</td><td>${badge(e.status === 'sent' ? 'sent_ok' : 'failed', e.status)}</td></tr>`)}</tbody></table>`
            : html`<div class="card-b muted small">Not emailed yet.</div>`}</div>` : ''}
        ${w ? html`<button class="btn" data-act="dup" style="justify-content:center">New ${D.label.toLowerCase()} for ${d.contact_name}</button>` : ''}
        ${w && kind === 'invoice' ? linkBtn('Make this recurring', oh(`/recurring/new?from=${d.id}`), { ic: 'repeat' }) : ''}
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

// ============ recurring invoices ============
const FREQ = { weekly: ['week', 'weeks'], monthly: ['month', 'months'], quarterly: ['quarter', 'quarters'], yearly: ['year', 'years'] };
const freqText = (t) => { const [one, many] = FREQ[t.frequency]; return t.interval_count > 1 ? `Every ${t.interval_count} ${many}` : `Every ${one}`; };

r('/o/:org/recurring', async () => {
  const list = await GET(O('/recurring'));
  page({
    title: 'Recurring invoices', crumbs: html`<a href="${oh('/invoices')}">Invoices</a>`,
    actions: canWrite() ? linkBtn('New recurring invoice', oh('/recurring/new'), { ic: 'plus', cls: 'primary' }) : '',
    body: html`${S.org.email_ready ? '' : html`<div class="notice">Tip: set up email in <a href="${oh('/settings/email')}">Settings → Email</a> so recurring invoices can be emailed automatically.</div>`}
      <div class="card table-wrap">${list.length ? html`<table><thead><tr><th>Name</th><th>Customer</th><th>Schedule</th><th>Next invoice</th><th class="num">Amount</th><th>Automation</th><th class="num">Generated</th><th>Status</th></tr></thead><tbody>
      ${list.map((t) => html`<tr class="click" data-href="${oh('/recurring/' + t.id)}"><td style="font-weight:550">${t.name || '—'}</td><td>${t.contact_name}</td><td>${freqText(t)}</td>
        <td>${t.active ? fmtDate(t.next_date) : '—'}</td>${mcell(t.total, t.currency)}
        <td>${t.auto_finalize ? badge('sent', 'auto-send') : badge('draft', 'draft only')} ${t.auto_email ? badge('paid', 'auto-email') : ''}</td>
        <td class="num">${t.generated}</td><td>${t.last_error ? badge('overdue', 'error') : t.active ? badge('paid', 'active') : badge('void', 'paused')}</td></tr>`)}
    </tbody></table>` : empty('No recurring invoices', 'Bill retainers, rent or subscriptions automatically — weekly, monthly, quarterly or yearly.', canWrite() ? linkBtn('New recurring invoice', oh('/recurring/new'), { ic: 'plus', cls: 'primary' }) : '')}</div>`,
  });
});

async function pageRecurringEdit(id, q = {}) {
  const [accs, contacts, products] = await Promise.all([accounts(), GET(O('/contacts?kind=customer')), GET(O('/products'))]);
  let t = { frequency: 'monthly', interval_count: 1, start_date: today(), auto_finalize: 1, auto_email: S.org.email_ready ? 1 : 0, active: 1, items: [], currency: baseCur() };
  if (id) t = await GET(O(`/recurring/${id}`));
  else if (q.from) {
    const inv = await GET(O(`/invoices/${q.from}`));
    t = { ...t, name: `${inv.contact_name} — ${inv.items[0] ? inv.items[0].description : 'recurring'}`, contact_id: inv.contact_id, currency: inv.currency, items: inv.items, notes: inv.notes, reference: inv.reference,
      start_date: addDays(inv.issue_date, 30) < today() ? today() : addDays(inv.issue_date, 30) };
  }
  page({
    title: id ? `Edit ${t.name || 'recurring invoice'}` : 'New recurring invoice', crumbs: html`<a href="${oh('/recurring')}">Recurring invoices</a>`,
    body: html`<form id="rec-form" class="card"><div class="card-b">
      <div class="form-grid cols4">
        ${field('Name', html`<input name="name" value="${t.name || ''}" placeholder="e.g. Monthly maintenance">`, { cls: 'span2' })}
        <label class="field span2">Customer<select name="contact_id" required>${contactOptions(contacts, t.contact_id, 'Select customer…')}</select></label>
        ${field('Repeat', html`<select name="frequency">${Object.keys(FREQ).map((f) => html`<option value="${f}" ${t.frequency === f ? 'selected' : ''}>${f[0].toUpperCase() + f.slice(1)}</option>`)}</select>`)}
        ${field('Every', html`<input name="interval_count" type="number" min="1" max="36" value="${t.interval_count}">`, { hint: 'e.g. 2 = every second period' })}
        ${field('First invoice date', html`<input name="start_date" type="date" required value="${t.start_date}">`, { hint: t.generated ? `Next: ${fmtDate(t.next_date)}` : 'Past dates are caught up automatically' })}
        ${field('End date (optional)', html`<input name="end_date" type="date" value="${t.end_date || ''}">`)}
        ${field('Payment terms (days)', html`<input name="due_days" type="number" min="0" value="${t.due_days ?? ''}" placeholder="${S.org.payment_terms}">`)}
        ${field('Reference', html`<input name="reference" value="${t.reference || ''}">`)}
        ${field('Currency', html`<select name="currency">${curOptions(t.currency)}</select>`, { hint: 'Foreign currencies use the saved rate on each invoice date' })}
        <div class="stack span4" style="padding-top:4px">
          <label class="check"><input type="checkbox" name="auto_finalize" ${t.auto_finalize ? 'checked' : ''}> Post each invoice to the ledger automatically (otherwise it's created as a draft)</label>
          <label class="check"><input type="checkbox" name="auto_email" ${t.auto_email ? 'checked' : ''}> Email each invoice to the customer automatically ${S.org.email_ready ? '' : html`<span class="hint">— needs SMTP in Settings → Email</span>`}</label>
          ${id ? html`<label class="check"><input type="checkbox" name="active" ${t.active ? 'checked' : ''}> Active</label>` : ''}
        </div>
      </div>
      <div style="margin-top:22px" id="items-root">${itemsTable('invoice', accs, products, t.items)}
        <div class="grid g2" style="margin-top:20px;align-items:start">${field('Notes on each invoice', html`<textarea name="notes" rows="4">${t.notes || ''}</textarea>`)}${totalsBlock()}</div>
      </div>
    </div>
    <div class="modal-f"><div class="err hidden" id="rec-err" style="margin:0 auto 0 0"></div>
      <a class="btn" href="${id ? oh('/recurring/' + id) : oh('/recurring')}">Cancel</a><button class="btn primary" type="submit">Save</button></div></form>`,
  });
  const form = $('#rec-form');
  // Preview only: each generated invoice uses the saved rate on its own date.
  let rate = await lookupRate(t.currency || baseCur(), today());
  const items = mountItems($('#items-root'), 'invoice', accs, products, { getCur: () => $('[name=currency]', form).value, getRate: () => rate });
  $('[name=currency]', form).addEventListener('change', async (e) => { rate = await lookupRate(e.target.value, today()); items.recalc(); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = formData(form);
    try {
      const payload = { ...fd, items: items.read(), auto_finalize: fd.auto_finalize, auto_email: fd.auto_email && fd.auto_finalize };
      const rid = id ? (await api('PUT', O(`/recurring/${id}`), payload), id) : (await api('POST', O('/recurring'), payload)).id;
      toast('Recurring invoice saved'); go(oh('/recurring/' + rid));
    } catch (ex) { const er = $('#rec-err'); er.textContent = ex.message; er.classList.remove('hidden'); }
  });
}
r('/o/:org/recurring/new', (p) => pageRecurringEdit(null, p.query));
r('/o/:org/recurring/:id/edit', (p) => pageRecurringEdit(p.id));
r('/o/:org/recurring/:id', async ({ id }) => {
  const t = await GET(O(`/recurring/${id}`));
  const calc = t.items.reduce((s, i) => { const l = Math.round(i.quantity * i.unit_price); return s + l + Math.round((l * i.tax_rate) / 100); }, 0);
  ACT.run = async () => { const res = await api('POST', O(`/recurring/${id}/run`)); toast(res.warning || 'Invoice generated'); go(oh('/invoices/' + res.ids[0])); };
  ACT.toggle = async () => { await api('PUT', O(`/recurring/${id}`), { active: !t.active }); router(); };
  ACT.del = async () => { if (await confirmBox('Delete recurring invoice?', 'Invoices already generated are kept.', { label: 'Delete' })) { await api('DELETE', O(`/recurring/${id}`)); go(oh('/recurring')); } };
  page({
    title: t.name || 'Recurring invoice', crumbs: html`<a href="${oh('/recurring')}">Recurring invoices</a>`,
    actions: canWrite() ? html`${btn('Delete', 'del', { cls: 'danger' })}${btn(t.active ? 'Pause' : 'Resume', 'toggle')}${linkBtn('Edit', oh(`/recurring/${id}/edit`))}${btn('Generate now', 'run', { cls: 'primary', ic: 'refresh' })}` : '',
    body: html`${t.last_error ? html`<div class="notice warn">Last run problem: ${t.last_error}</div>` : ''}
      <div class="grid g4">
        ${kpi('Amount', money(calc, t.currency), `${t.items.length} line${t.items.length === 1 ? '' : 's'}`)}
        ${kpi('Schedule', freqText(t), `From ${fmtDate(t.start_date)}${t.end_date ? ' to ' + fmtDate(t.end_date) : ''}`)}
        ${kpi('Next invoice', t.active ? fmtDate(t.next_date) : 'Paused', t.auto_finalize ? (t.auto_email ? 'Posted & emailed automatically' : 'Posted automatically') : 'Created as draft')}
        ${kpi('Generated', t.generated, t.last_run_at ? 'Last run ' + fmtDate(t.last_run_at) : 'Not run yet')}
      </div>
      <div class="card" style="margin-top:18px"><div class="card-h"><h3>Invoices generated</h3></div>
        ${t.invoices.length ? html`<table><tbody>${t.invoices.map((i) => html`<tr class="click" data-href="${oh('/invoices/' + i.id)}"><td class="mono">${i.number}</td><td>${fmtDate(i.issue_date)}</td>${mcell(i.total, i.currency || baseCur())}<td>${badge(i.status)}</td></tr>`)}</tbody></table>`
          : html`<div class="card-b muted">No invoices yet. The scheduler checks every hour; use “Generate now” to create one immediately.</div>`}</div>`,
  });
});

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
