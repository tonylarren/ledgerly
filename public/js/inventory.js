'use strict';
/* Products, stock levels, movements and adjustments (weighted-average cost). */

const KIND_LABEL = { inventory: 'Stock item', service: 'Service', non_inventory: 'Non-stock item' };
const MOVE_LABEL = { bill: 'Purchase', invoice: 'Sale', adjustment: 'Adjustment', bill_reversal: 'Purchase voided', invoice_reversal: 'Sale voided' };

async function productModal(p = {}) {
  const accs = await accounts();
  const isNew = !p.id;
  let deleted = false;
  const res = await modal({
    title: isNew ? 'New product' : p.name, wide: true,
    body: html`<div class="form-grid cols3">
      ${field('Name', html`<input name="name" required value="${p.name || ''}">`, { cls: 'span2' })}
      ${field('SKU / code', html`<input name="sku" value="${p.sku || ''}">`)}
      ${field('Type', html`<select name="kind">${Object.entries(KIND_LABEL).map(([k, v]) => html`<option value="${k}" ${(p.kind || 'inventory') === k ? 'selected' : ''}>${v}</option>`)}</select>`, { hint: 'Stock items track quantity and cost' })}
      ${field('Unit', html`<input name="unit" value="${p.unit || ''}" placeholder="kg, pcs, box…">`)}
      ${field('Reorder level', html`<input name="reorder_level" type="number" step="any" min="0" value="${p.reorder_level || 0}">`, { hint: 'Warn when stock falls to this level', cls: 'stock-only' })}
      ${field(`Sale price (${baseCur()})`, html`<input name="sale_price" type="number" step="any" min="0" value="${fromCents(p.sale_price || 0)}">`)}
      ${field(`Purchase cost (${baseCur()})`, html`<input name="purchase_price" type="number" step="any" min="0" value="${fromCents(p.purchase_price || 0)}">`, { hint: 'Default price on bills' })}
      ${field('Tax %', html`<input name="tax_rate" type="number" step="any" min="0" value="${p.tax_rate ?? ''}" placeholder="${S.org.default_tax_rate}">`, { hint: 'Blank = organisation default' })}
      ${field('Revenue account', html`<select name="income_account_id">${accountOptions(live(accs).filter((a) => a.type === 'income'), p.income_account_id, 'Default (Sales Revenue)')}</select>`)}
      ${field('Expense account', html`<select name="expense_account_id">${accountOptions(live(accs).filter((a) => a.type === 'expense'), p.expense_account_id, 'Default')}</select>`, { hint: 'Non-stock items only; stock goes to Inventory', cls: 'nonstock-only' })}
      ${isNew ? html`${field('Opening quantity', html`<input name="opening_qty" type="number" step="any" min="0" value="0">`, { cls: 'stock-only', hint: 'Valued at the purchase cost, against Owner\'s Capital' })}
        ${field('Opening date', html`<input name="opening_date" type="date" value="${today()}">`, { cls: 'stock-only' })}` : html`<label class="check" style="padding-top:22px"><input type="checkbox" name="active" ${p.active ? 'checked' : ''}> Active</label>`}
      ${field('Description', html`<textarea name="description" rows="2">${p.description || ''}</textarea>`, { full: true })}
    </div>`,
    submit: canWrite() ? 'Save' : null,
    extra: !isNew && canWrite() ? html`<button type="button" class="btn danger" id="del-prod">Delete</button>` : '',
    onMount: (form, close) => {
      const sync = () => {
        const k = $('[name=kind]', form).value;
        $$('.stock-only', form).forEach((el) => el.classList.toggle('hidden', k !== 'inventory'));
        $$('.nonstock-only', form).forEach((el) => el.classList.toggle('hidden', k === 'inventory'));
      };
      $('[name=kind]', form).addEventListener('change', sync); sync();
      const del = $('#del-prod', form);
      if (del) del.addEventListener('click', async () => {
        try { await api('DELETE', O(`/products/${p.id}`)); deleted = true; close(true); }
        catch (e) { showErr(form, e.message); }
      });
    },
    onSubmit: (d) => {
      const body = { ...d, sale_price: toCents(d.sale_price), purchase_price: toCents(d.purchase_price) };
      return isNew ? api('POST', O('/products'), body) : api('PUT', O(`/products/${p.id}`), body);
    },
  });
  return deleted ? { deleted } : res;
}

r('/o/:org/products', async ({ query }) => {
  const kind = query.kind || '';
  const list = await GET(O('/products'));
  const rows = list.filter((p) => !kind || (kind === 'low' ? p.low : p.kind === kind));
  const stock = list.filter((p) => p.kind === 'inventory');
  ACT.add = async () => { const res = await productModal(); if (res && res.id) go(oh('/products/' + res.id)); };
  page({
    title: 'Products & stock',
    actions: canWrite() ? btn('New product', 'add', { ic: 'plus', cls: 'primary' }) : '',
    body: html`<div class="grid g3">
        ${kpi('Stock value', money(stock.reduce((s, p) => s + p.value, 0)), `${stock.length} stock item${stock.length === 1 ? '' : 's'} · weighted average cost`)}
        ${kpi('Low on stock', list.filter((p) => p.low).length, 'At or below reorder level', list.some((p) => p.low) ? 'neg' : '')}
        ${kpi('Catalogue', list.filter((p) => p.active).length, 'Active products & services')}
      </div>
      <div class="card" style="margin-top:18px"><div style="padding:0 14px">${tabs([['', 'All', oh('/products')], ['inventory', 'Stock items', oh('/products?kind=inventory')], ['service', 'Services', oh('/products?kind=service')], ['low', 'Low stock', oh('/products?kind=low')]], kind)}</div>
      ${rows.length ? html`<div class="table-wrap" style="margin-top:-18px"><table><thead><tr><th>SKU</th><th>Name</th><th>Type</th><th class="num">On hand</th><th class="num">Avg cost</th><th class="num">Stock value</th><th class="num">Sale price</th><th></th></tr></thead><tbody>
        ${rows.map((p) => html`<tr class="click" data-href="${oh('/products/' + p.id)}" style="${p.active ? '' : 'opacity:.55'}"><td class="mono">${p.sku || ''}</td><td style="font-weight:550">${p.name}</td><td><span class="badge">${KIND_LABEL[p.kind]}</span></td>
          <td class="num ${p.qty < 0 ? 'neg' : ''}">${p.kind === 'inventory' ? `${num(p.qty)} ${p.unit || ''}` : '—'}</td>
          <td class="num">${p.kind === 'inventory' ? money(p.avg_cost) : ''}</td><td class="num">${p.kind === 'inventory' ? money(p.value) : ''}</td>${mcell(p.sale_price)}
          <td>${p.low ? badge('overdue', 'low stock') : ''}${p.active ? '' : badge('void', 'inactive')}</td></tr>`)}
      </tbody></table></div>` : empty('No products', 'Add the goods you buy and sell to track stock, or services to speed up invoicing.', canWrite() ? btn('New product', 'add', { ic: 'plus', cls: 'primary' }) : '')}</div>`,
  });
});

r('/o/:org/products/:id', async ({ id }) => {
  const [p, accs] = await Promise.all([GET(O(`/products/${id}`)), accounts()]);
  ACT.edit = async () => { const res = await productModal(p); if (res && res.deleted) go(oh('/products')); else if (res) router(); };
  ACT.adjust = async () => {
    const res = await modal({
      title: `Adjust stock — ${p.name}`,
      body: html`<div class="form-grid">
        ${field('Quantity change', html`<input name="qty" type="number" step="any" required placeholder="e.g. -2 or 10">`, { hint: `Currently ${num(p.qty)} ${p.unit || ''}. Negative to remove.` })}
        ${field(`Unit cost (${baseCur()})`, html`<input name="unit_cost" type="number" step="any" min="0" value="${fromCents(p.avg_cost)}">`, { hint: 'Used when adding stock; removals use average cost' })}
        ${field('Date', html`<input name="date" type="date" required value="${today()}">`)}
        ${field('Offset account', html`<select name="account_id">${accountOptions(live(accs).filter((a) => !a.is_bank), sysAcc(accs, 'inv_adjust').id)}</select>`, { hint: 'Inventory Adjustments for counts & damage; Owner\'s Capital for opening stock' })}
        ${field('Reason', html`<input name="note" placeholder="Stock count, damaged, sample…">`, { full: true })}
      </div>`,
      submit: 'Post adjustment',
      onSubmit: (d) => api('POST', O(`/products/${id}/adjust`), { ...d, unit_cost: toCents(d.unit_cost) }),
    });
    if (res) { toast('Stock adjusted'); router(); }
  };
  const docLink = (m) => (m.doc_number ? html`<a href="${oh(`/${m.doc_kind}s/${m.ref_id}`)}">${m.doc_number}</a>` : '');
  page({
    title: p.name, crumbs: html`<a href="${oh('/products')}">Products & stock</a>`,
    actions: canWrite() ? html`${p.kind === 'inventory' ? btn('Adjust stock', 'adjust', { ic: 'refresh' }) : ''}${btn('Edit', 'edit', { cls: 'primary' })}` : '',
    body: html`<div class="grid g4">
        ${p.kind === 'inventory' ? html`${kpi('On hand', `${num(p.qty)} ${p.unit || ''}`, p.reorder_level ? `Reorder at ${num(p.reorder_level)}` : 'No reorder level', p.qty <= p.reorder_level && p.reorder_level ? 'neg' : '')}
          ${kpi('Average cost', money(p.avg_cost), 'Weighted average')}${kpi('Stock value', money(p.value), 'In the Inventory account')}` : kpi('Type', KIND_LABEL[p.kind], 'Not stock-tracked')}
        ${kpi('Sale price', money(p.sale_price), p.sku ? `SKU ${p.sku}` : '')}
      </div>
      ${p.description ? html`<p class="muted">${p.description}</p>` : ''}
      ${p.kind === 'inventory' ? html`<div class="card" style="margin-top:18px"><div class="card-h"><h3>Stock movements</h3></div>
        ${p.moves.length ? html`<div class="table-wrap"><table><thead><tr><th>Date</th><th>Movement</th><th>Document</th><th class="num">Quantity</th><th class="num">Value</th><th>Note</th></tr></thead><tbody>
          ${p.moves.map((m) => html`<tr style="${m.reversed ? 'opacity:.55' : ''}"><td>${fmtDate(m.date)}</td><td>${MOVE_LABEL[m.ref_type] || m.ref_type}</td><td>${docLink(m)}</td>
            <td class="num ${m.qty < 0 ? 'neg' : 'pos'}">${m.qty > 0 ? '+' : ''}${num(m.qty)}</td>${mcell(m.value)}<td class="muted small">${m.note || ''}</td></tr>`)}
        </tbody></table></div>` : html`<div class="card-b muted">No movements yet. Stock goes up when you approve a bill for this product and down when you send an invoice.</div>`}</div>` : ''}`,
  });
});
