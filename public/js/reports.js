'use strict';
/* Financial reports (all in base currency), inventory valuation, payroll tax declarations, budgets. */

const REPORTS = [['pnl', 'Profit & loss'], ['balance-sheet', 'Balance sheet'], ['cashflow', 'Income vs expenses'], ['trial-balance', 'Trial balance'], ['ledger', 'General ledger'],
  ['ar', 'Receivables aging'], ['ap', 'Payables aging'], ['tax', 'Sales tax'], ['inventory', 'Inventory valuation'], ['payroll-taxes', 'Payroll taxes']];
function presets() {
  const d = new Date(), y = d.getFullYear(), m = d.getMonth(), iso = (x) => x.toISOString().slice(0, 10), U = (a, b, c) => new Date(Date.UTC(a, b, c));
  const q = Math.floor(m / 3) * 3;
  return [['This month', iso(U(y, m, 1)), iso(U(y, m + 1, 0))], ['Last month', iso(U(y, m - 1, 1)), iso(U(y, m, 0))], ['This quarter', iso(U(y, q, 1)), iso(U(y, q + 3, 0))],
    ['This year', `${y}-01-01`, `${y}-12-31`], ['Last year', `${y - 1}-01-01`, `${y - 1}-12-31`]];
}
const c2 = (c) => (c / 100).toFixed(2);

r('/o/:org/reports/:report', async ({ report, query }) => {
  const yStart = today().slice(0, 4) + '-01-01';
  let from = query.from || yStart, to = query.to || today();
  if (report === 'payroll-taxes' && !query.from) { const p = presets()[1]; from = p[1]; to = p[2]; }
  const asOf = query.asOf || today();
  let body = '', csv = [], toolbar = '', subtitle = `${fmtDate(from)} – ${fmtDate(to)}`;
  const rangeBar = html`<form class="toolbar no-print" data-submit="apply">
    ${field('Period', html`<select data-change="preset"><option value="">Custom</option>${presets().map(([l, f, t]) => html`<option value="${f}|${t}" ${f === from && t === to ? 'selected' : ''}>${l}</option>`)}</select>`)}
    ${field('From', html`<input type="date" name="from" value="${from}">`)}${field('To', html`<input type="date" name="to" value="${to}">`)}<button class="btn">Apply</button></form>`;
  const asOfBar = html`<form class="toolbar no-print" data-submit="apply">${field('As of', html`<input type="date" name="asOf" value="${asOf}">`)}<button class="btn">Apply</button></form>`;
  ACT.apply = (d) => go(oh(`/reports/${report}?` + new URLSearchParams({ ...query, ...d }).toString()));
  ACT.preset = (el) => { if (el.value) { const [f, t] = el.value.split('|'); ACT.apply({ from: f, to: t }); } };
  const ledgerLink = (a, label) => html`<a href="${oh(`/reports/ledger?account_id=${a.id}&from=${from}&to=${to}`)}" style="color:inherit">${label}</a>`;
  const sectionRows = (title, rows, totalLabel, total) => {
    csv.push([title]); rows.forEach((a) => csv.push(['', a.code, a.name, c2(a.balance)])); csv.push(['', '', totalLabel, c2(total)]);
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
    csv.push(['', '', 'Net income', c2(p.netIncome)]);
  } else if (report === 'balance-sheet') {
    const b = await GET(O(`/reports/balance-sheet?asOf=${asOf}`));
    toolbar = asOfBar; subtitle = 'As of ' + fmtDate(asOf);
    const eq = [...b.equity, { id: 0, code: '', name: 'Current & retained earnings (unclosed)', balance: b.earnings }];
    body = html`<table>${sectionRows('Assets', b.assets, 'Total assets', b.totalAssets)}${sectionRows('Liabilities', b.liabilities, 'Total liabilities', b.totalLiabilities)}
      ${sectionRows('Equity', eq, 'Total equity', b.totalEquity)}
      <tr class="total" style="font-size:15px"><td></td><td>Liabilities + equity</td>${mcell(b.totalLiabilities + b.totalEquity)}</tr></table>
      <div class="card-b">${b.balanced ? badge('paid', '✓ Balanced') : badge('overdue', 'Out of balance — check opening balances')}</div>`;
  } else if (report === 'trial-balance') {
    const t = await GET(O(`/reports/trial-balance?asOf=${asOf}`));
    toolbar = asOfBar; subtitle = 'As of ' + fmtDate(asOf);
    csv = [['Code', 'Account', 'Debit', 'Credit'], ...t.rows.map((a) => [a.code, a.name, c2(a.tb_debit), c2(a.tb_credit)]), ['', 'Total', c2(t.totalDebit), c2(t.totalCredit)]];
    body = html`<table><thead><tr><th>Code</th><th>Account</th><th class="num">Debit</th><th class="num">Credit</th></tr></thead><tbody>
      ${t.rows.map((a) => html`<tr><td class="mono">${a.code}</td><td>${a.name}</td><td class="num">${a.tb_debit ? money(a.tb_debit) : ''}</td><td class="num">${a.tb_credit ? money(a.tb_credit) : ''}</td></tr>`)}
      <tr class="total"><td></td><td>Total ${t.totalDebit === t.totalCredit ? '✓' : '⚠'}</td>${mcell(t.totalDebit)}${mcell(t.totalCredit)}</tr></tbody></table>`;
  } else if (report === 'ledger') {
    const accs = await accounts();
    const accId = query.account_id || sysAcc(accs, 'bank').id || accs[0].id;
    const g = await GET(O(`/reports/ledger?account_id=${accId}&from=${from}&to=${to}`));
    const fc = g.account.currency && g.account.currency !== baseCur() ? g.account.currency : null;
    toolbar = html`<form class="toolbar no-print" data-submit="apply">${field('Account', html`<select name="account_id" style="min-width:260px">${accountOptions(accs, accId)}</select>`)}
      ${field('From', html`<input type="date" name="from" value="${from}">`)}${field('To', html`<input type="date" name="to" value="${to}">`)}<button class="btn">Apply</button></form>`;
    csv = [['Date', 'Memo', 'Contact', 'Debit', 'Credit', 'Balance', ...(fc ? [`${fc} amount`, `${fc} balance`] : [])], ['', 'Opening balance', '', '', '', c2(g.opening)],
      ...g.lines.map((l) => [l.date, l.memo || l.description || '', l.contact_name || '', c2(l.debit), c2(l.credit), c2(l.balance), ...(fc ? [l.fx_amount ? c2(l.fx_amount) : '', c2(l.fx_balance)] : [])])];
    body = html`<table><thead><tr><th>Date</th><th>Memo</th><th>Contact</th><th class="num">Debit</th><th class="num">Credit</th><th class="num">Balance</th>${fc ? html`<th class="num">${fc} balance</th>` : ''}</tr></thead><tbody>
      <tr class="section"><td colspan="5" style="text-transform:none">Opening balance · ${g.account.code} ${g.account.name}</td>${mcell(g.opening)}${fc ? mcell(g.fxOpening, fc) : ''}</tr>
      ${g.lines.map((l) => html`<tr><td>${fmtDate(l.date)}</td><td>${l.memo || ''}${l.description && l.description !== l.memo ? html` <span class="muted small">— ${l.description}</span>` : ''}${l.fx_currency ? html` <span class="muted small">(${money(l.fx_amount, l.fx_currency)})</span>` : ''}</td><td>${l.contact_name || ''}</td><td class="num">${l.debit ? money(l.debit) : ''}</td><td class="num">${l.credit ? money(l.credit) : ''}</td>${mcell(l.balance)}${fc ? mcell(l.fx_balance, fc) : ''}</tr>`)}
      <tr class="total"><td colspan="5">Closing balance</td>${mcell(g.closing)}${fc ? mcell(g.fxClosing, fc) : ''}</tr></tbody></table>`;
  } else if (report === 'ar' || report === 'ap') {
    const a = await GET(O(`/reports/aging?kind=${report === 'ar' ? 'invoice' : 'bill'}&asOf=${asOf}`));
    toolbar = asOfBar; subtitle = `As of ${fmtDate(asOf)} · totals in ${baseCur()}`;
    const path = report === 'ar' ? 'invoices' : 'bills';
    csv = [['Number', 'Contact', 'Due date', 'Days overdue', 'Bucket', 'Currency', 'Amount due', `Amount due (${baseCur()})`], ...a.rows.map((x) => [x.number, x.contact_name, x.due_date, x.days_overdue, x.bucket, x.currency || baseCur(), c2(x.due), c2(x.due_base)])];
    body = html`<div class="grid g6" style="padding:18px;gap:12px">${a.buckets.map((b) => html`<div><div class="muted small">${b === 'current' ? 'Not yet due' : b + ' days'}</div><div style="font-weight:650;font-size:17px" class="${b !== 'current' && a.totals[b] ? 'neg' : ''}">${money(a.totals[b])}</div></div>`)}<div><div class="muted small">Total</div><div style="font-weight:650;font-size:17px">${money(a.total)}</div></div></div>
      <table><thead><tr><th>Number</th><th>${report === 'ar' ? 'Customer' : 'Vendor'}</th><th>Due date</th><th class="num">Days overdue</th><th>Bucket</th><th class="num">Amount due</th><th class="num">${baseCur()}</th></tr></thead><tbody>
      ${a.rows.length ? a.rows.map((x) => html`<tr class="click" data-href="${oh(`/${path}/${x.id}`)}"><td class="mono">${x.number}</td><td>${x.contact_name}</td><td>${fmtDate(x.due_date)}</td><td class="num">${x.days_overdue || ''}</td><td>${x.bucket === 'current' ? badge('sent', 'current') : badge('overdue', x.bucket)}</td>${mcell(x.due, x.currency || baseCur())}${mcell(x.due_base)}</tr>`) : html`<tr><td colspan="7" class="muted" style="text-align:center;padding:30px">Nothing outstanding.</td></tr>`}
      </tbody></table>`;
  } else if (report === 'cashflow') {
    const months = +query.months || 12;
    const s = await GET(O(`/reports/cashflow?months=${months}`));
    toolbar = html`<form class="toolbar no-print" data-submit="apply">${field('Months', html`<select name="months">${[6, 12, 24, 36].map((n) => html`<option ${n === months ? 'selected' : ''}>${n}</option>`)}</select>`)}<button class="btn">Apply</button></form>`;
    subtitle = 'Monthly';
    csv = [['Month', 'Income', 'Expenses', 'Net'], ...s.map((x) => [x.month, c2(x.income), c2(x.expense), c2(x.net)])];
    const tot = s.reduce((a, x) => ({ income: a.income + x.income, expense: a.expense + x.expense }), { income: 0, expense: 0 });
    body = html`<div class="card-b"><div class="split" style="margin-bottom:10px"><span></span>${legend()}</div>${barChart(s)}</div>
      <table><thead><tr><th>Month</th><th class="num">Income</th><th class="num">Expenses</th><th class="num">Net</th><th class="num">Margin</th></tr></thead><tbody>
      ${s.map((x) => html`<tr><td>${new Date(x.month + '-01T00:00:00').toLocaleDateString(locale(), { month: 'long', year: 'numeric' })}</td>${mcell(x.income)}${mcell(x.expense)}<td class="num ${x.net < 0 ? 'neg' : 'pos'}">${money(x.net)}</td><td class="num muted">${x.income ? Math.round((x.net / x.income) * 100) + '%' : '—'}</td></tr>`)}
      <tr class="total"><td>Total</td>${mcell(tot.income)}${mcell(tot.expense)}${mcell(tot.income - tot.expense)}<td></td></tr></tbody></table>`;
  } else if (report === 'tax') {
    const t = await GET(O(`/reports/tax?from=${from}&to=${to}`));
    toolbar = rangeBar;
    csv = [['Sales tax collected', c2(t.collected)], ['Tax paid on purchases (recoverable)', c2(t.paid)], ['Net tax payable', c2(t.net)]];
    body = html`<table><tbody><tr><td>Sales tax (TVA) collected on invoices</td>${mcell(t.collected)}</tr><tr><td>Tax paid on bills (recoverable)</td>${mcell(-t.paid)}</tr>
      <tr class="total" style="font-size:16px"><td>${t.net >= 0 ? 'Net tax payable' : 'Net tax refundable'}</td>${mcell(Math.abs(t.net))}</tr></tbody></table>
      <p class="card-b muted small" style="margin:0">Movement on the Sales Tax Payable and Tax Recoverable accounts for the period. Record your tax payment as “Money out” categorised to Sales Tax Payable.</p>`;
  } else if (report === 'inventory') {
    const v = await GET(O('/reports/inventory'));
    subtitle = 'Current stock at weighted average cost';
    csv = [['SKU', 'Product', 'Quantity', 'Unit', 'Average cost', 'Value'], ...v.products.map((p) => [p.sku || '', p.name, p.qty, p.unit || '', c2(p.avg_cost), c2(p.value)]), ['', 'Total', '', '', '', c2(v.total)]];
    body = html`<table><thead><tr><th>SKU</th><th>Product</th><th class="num">Quantity</th><th class="num">Average cost</th><th class="num">Value</th><th></th></tr></thead><tbody>
      ${v.products.length ? v.products.map((p) => html`<tr class="click" data-href="${oh('/products/' + p.id)}"><td class="mono">${p.sku || ''}</td><td>${p.name}</td><td class="num">${num(p.qty)} ${p.unit || ''}</td>${mcell(p.avg_cost)}${mcell(p.value)}<td>${p.low ? badge('overdue', 'low') : ''}</td></tr>`)
        : html`<tr><td colspan="6" class="muted" style="text-align:center;padding:30px">No stock items yet.</td></tr>`}
      <tr class="total"><td></td><td>Total stock value</td><td></td><td></td>${mcell(v.total)}<td></td></tr></tbody></table>
      <div class="card-b">${v.difference === 0 ? badge('paid', '✓ Matches the Inventory account in the ledger') : badge('overdue', `Inventory account differs by ${money(v.difference)} — check manual journal entries to the Inventory account`)}</div>`;
  } else if (report === 'payroll-taxes') {
    const t = await GET(O(`/reports/payroll-taxes?from=${from}&to=${to}`));
    toolbar = rangeBar;
    subtitle += ` · posted pay runs by pay date`;
    const codes = t.lines.map((l) => l.code);
    csv = [['Contribution', 'Base', 'Employee', 'Employer', 'Total'], ...t.lines.map((l) => [l.label, c2(l.base), c2(l.employee), c2(l.employer), c2(l.total)]), ['Total', '', '', '', c2(t.total)], [],
      ['Employee', 'CNaPS no.', 'NIF', 'Gross', ...codes.flatMap((c) => [`${c} employee`, `${c} employer`]), 'Net'],
      ...t.employees.map((e) => [e.name, e.cnaps_number || '', e.tax_number || '', c2(e.gross), ...codes.flatMap((c) => [c2((e.lines[c] || {}).employee || 0), c2((e.lines[c] || {}).employer || 0)]), c2(e.net)])];
    body = html`<table><thead><tr><th>Contribution / tax</th><th class="num">Base</th><th class="num">Employee share</th><th class="num">Employer share</th><th class="num">To pay</th></tr></thead><tbody>
      ${t.lines.length ? t.lines.map((l) => html`<tr><td style="font-weight:550">${l.label}</td>${mcell(l.base)}${mcell(l.employee)}${mcell(l.employer)}<td class="num" style="font-weight:650">${money(l.total)}</td></tr>`)
        : html`<tr><td colspan="5" class="muted" style="text-align:center;padding:30px">No posted pay runs in this period.</td></tr>`}
      <tr class="total"><td>Total to remit</td><td class="num muted">gross ${money(t.gross)}</td><td></td><td></td>${mcell(t.total)}</tr></tbody></table>
      ${t.employees.length ? html`<div class="card-h" style="border-top:1px solid var(--border)"><h3>Per employee (for CNaPS DNS / IRSA statements)</h3></div>
        <table class="compact"><thead><tr><th>Employee</th><th>CNaPS no.</th><th class="num">Gross</th>${t.lines.map((l) => html`<th class="num">${l.label}</th>`)}<th class="num">Net</th></tr></thead><tbody>
        ${t.employees.map((e) => html`<tr><td>${e.name}</td><td class="mono">${e.cnaps_number || ''}</td>${mcell(e.gross)}${t.lines.map((l) => { const x = e.lines[l.code] || {}; return html`<td class="num">${money((x.employee || 0) + (x.employer || 0))}</td>`; })}${mcell(e.net)}</tr>`)}
        </tbody></table>` : ''}
      <p class="card-b muted small" style="margin:0">Each line is credited to its own payable account when a run is posted. When you pay CNaPS, the health organisation, the tax office (IRSA) or FMFP, record a “Money out” against the matching payable account.</p>`;
  } else return go(oh('/reports/pnl'));

  const title = REPORTS.find((x) => x[0] === report)[1];
  ACT.csv = () => downloadCsv(`${S.org.name}-${report}-${query.asOf || to}.csv`.replace(/\s+/g, '_'), csv);
  page({
    title: 'Reports', actions: html`${btn('Export CSV', 'csv', { ic: 'download' })}${btn('Print', 'print', { ic: 'print' })}`,
    body: html`<div class="no-print">${tabs(REPORTS.map(([k, l]) => [k, l, oh('/reports/' + k)]), report)}</div>${toolbar}
      <div class="card"><div class="card-h"><div><h2>${title}</h2><div class="muted small">${S.org.name} · ${subtitle} · ${baseCur()}</div></div></div>
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
          <td class="num" style="width:160px">${w ? html`<input name="b_${x.id}" type="number" step="any" min="0" class="num" value="${x.budget ? fromCents(x.budget) : ''}" placeholder="0" aria-label="Budget for ${x.name}">` : money(x.budget)}</td>
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
