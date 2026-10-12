'use strict';
/* Payroll: employees, pay runs, payslips. Supports the flat-rate scheme and Madagascar (CNaPS/OSTIE/FMFP/IRSA). */

const isMG = () => S.org && S.org.payroll_scheme === 'madagascar';
const detail = (s, code) => (s.details || []).find((d) => d.code === code) || { employee: 0, employer: 0, base: 0 };

function employeeModal(e = {}) {
  const mg = isMG();
  return modal({
    title: e.id ? e.name : 'New employee', wide: true,
    body: html`<div class="form-grid cols3">
      ${field('Full name', html`<input name="name" required value="${e.name || ''}">`)}
      ${field('Email', html`<input name="email" type="email" value="${e.email || ''}">`)}
      ${field('Start date', html`<input name="start_date" type="date" value="${e.start_date || ''}">`)}
      ${field('Position', html`<input name="position" value="${e.position || ''}">`)}
      ${field('Department', html`<input name="department" value="${e.department || ''}">`)}
      <label class="check" style="padding-top:22px"><input type="checkbox" name="active" ${e.active === 0 ? '' : 'checked'}> Active</label>
      ${field('Pay type', html`<select name="pay_type"><option value="salary" ${e.pay_type !== 'hourly' ? 'selected' : ''}>Monthly salary</option><option value="hourly" ${e.pay_type === 'hourly' ? 'selected' : ''}>Hourly</option></select>`)}
      ${field(`Pay rate (${baseCur()})`, html`<input name="pay_rate" type="number" step="any" min="0" required value="${fromCents(e.pay_rate)}">`, { hint: 'Gross salary per run, or rate per hour' })}
      ${field('Fixed deduction per run', html`<input name="fixed_deduction" type="number" step="any" min="0" value="${fromCents(e.fixed_deduction || 0)}">`, { hint: 'e.g. advance (avance), loan, canteen' })}
      ${mg ? html`
        ${field('Dependants (personnes à charge)', html`<input name="dependents" type="number" min="0" max="20" value="${e.dependents || 0}">`, { hint: `Reduces IRSA by ${num(S.org.payroll.irsa_dependent_reduction)} Ar each` })}
        ${field('CNaPS number', html`<input name="cnaps_number" value="${e.cnaps_number || ''}">`)}
        ${field('NIF / tax number', html`<input name="tax_number" value="${e.tax_number || ''}">`)}`
      : html`
        ${field('Income tax withheld %', html`<input name="income_tax_rate" type="number" step="any" min="0" max="100" value="${e.income_tax_rate ?? 0}">`)}
        ${field('Employee social contrib. %', html`<input name="social_rate" type="number" step="any" min="0" max="100" value="${e.social_rate ?? 0}">`)}
        ${field('Employer contrib. %', html`<input name="employer_rate" type="number" step="any" min="0" max="100" value="${e.employer_rate ?? 0}">`)}`}
      ${field('Bank / mobile money details', html`<input name="bank_details" value="${e.bank_details || ''}" placeholder="RIB, IBAN or MVola number">`, { full: true })}
    </div><p class="hint" style="margin:12px 0 0">${mg
      ? html`Madagascar scheme: CNaPS, ${S.org.payroll.health_name}, FMFP and IRSA are calculated automatically from the rates in <a href="${oh('/settings/payroll')}">Settings → Payroll</a>.`
      : 'Flat percentages per employee — works for any country. Switch to the Madagascar scheme in Settings → Payroll.'}</p>`,
    submit: canWrite() ? 'Save' : null,
    onSubmit: (d) => {
      const body = { ...d, pay_rate: toCents(d.pay_rate), fixed_deduction: toCents(d.fixed_deduction) };
      return e.id ? api('PUT', O(`/employees/${e.id}`), body) : api('POST', O('/employees'), body);
    },
  });
}
const schemeNote = () => html`<div class="notice">${isMG()
  ? html`Payroll scheme: <b>Madagascar</b> — CNaPS ${S.org.payroll.cnaps_employee}% / ${S.org.payroll.cnaps_employer}%, ${S.org.payroll.health_name} ${S.org.payroll.health_employee}% / ${S.org.payroll.health_employer}%, FMFP ${S.org.payroll.fmfp_employer}%, progressive IRSA. <a href="${oh('/settings/payroll')}">Rates & ceilings →</a>`
  : html`Payroll scheme: <b>flat rates per employee</b>. <a href="${oh('/settings/payroll')}">Change →</a>`}</div>`;

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
        ${field('Pay date', html`<input name="pay_date" type="date" required value="${last}">`)}${field('Pay from', html`<select name="bank_account_id">${accountOptions(banks(accs).filter((a) => !a.currency), sysAcc(accs, 'bank').id)}</select>`)}
        ${field('Notes', html`<input name="notes">`, { full: true })}</div>
        <p class="hint" style="margin:12px 0 0">Payslips are generated for every active employee. Hourly staff default to ${isMG() ? S.org.payroll.standard_hours : 160} hours — edit them before posting.</p>`,
      submit: 'Create pay run', onSubmit: (d) => api('POST', O('/payroll'), d),
    });
    if (res && res.id) go(oh(`/payroll/${res.id}`));
  };
  page({
    title: 'Payroll', actions: canWrite() ? btn('New pay run', 'newRun', { ic: 'plus', cls: 'primary' }) : '',
    body: html`${schemeNote()}${tabs([['runs', 'Pay runs', oh('/payroll')], ['emp', 'Employees', oh('/payroll/employees')]], 'runs')}
      <div class="card table-wrap">${runs.length ? html`<table><thead><tr><th>Period</th><th>Pay date</th><th class="num">Employees</th><th class="num">Gross</th><th class="num">Deductions</th><th class="num">Net pay</th><th class="num">Employer cost</th><th>Status</th></tr></thead><tbody>
        ${runs.map((x) => html`<tr class="click" data-href="${oh('/payroll/' + x.id)}"><td>${fmtDate(x.period_start)} – ${fmtDate(x.period_end)}</td><td>${fmtDate(x.pay_date)}</td><td class="num">${x.totals.count}</td>${mcell(x.totals.gross)}${mcell(x.totals.deductions)}${mcell(x.totals.net)}${mcell(x.totals.employer_cost)}<td>${badge(x.status)}</td></tr>`)}
      </tbody></table>` : empty('No pay runs yet', 'Add your employees, then create a pay run each period.', html`<a class="btn" href="${oh('/payroll/employees')}">Manage employees</a>`)}</div>
      <p class="muted small">Contributions for declarations (CNaPS DNS, health organisation, IRSA, FMFP) are summarised in <a href="${oh('/reports/payroll-taxes')}">Reports → Payroll taxes</a>.</p>`,
  });
});
r('/o/:org/payroll/employees', async () => {
  const emps = await GET(O('/employees'));
  const mg = isMG();
  ACT.add = async () => { if (await employeeModal()) router(); };
  ACT.edit = async (el) => { if (await employeeModal(emps.find((e) => e.id === +el.dataset.id))) router(); };
  ACT.del = async (el) => { if (await confirmBox('Delete employee?', 'Only employees without payslips can be deleted.', { label: 'Delete' })) { await api('DELETE', O(`/employees/${el.dataset.id}`)); router(); } };
  page({
    title: 'Payroll', actions: canWrite() ? btn('New employee', 'add', { ic: 'plus', cls: 'primary' }) : '',
    body: html`${schemeNote()}${tabs([['runs', 'Pay runs', oh('/payroll')], ['emp', 'Employees', oh('/payroll/employees')]], 'emp')}
      <div class="card table-wrap">${emps.length ? html`<table><thead><tr><th>Name</th><th>Position</th><th>Pay</th>${mg ? html`<th class="num">Dependants</th><th>CNaPS no.</th><th>NIF</th>` : html`<th class="num">Tax %</th><th class="num">Social %</th><th class="num">Employer %</th>`}<th>Status</th><th></th></tr></thead><tbody>
        ${emps.map((e) => html`<tr class="click" data-act="edit" data-id="${e.id}"><td style="font-weight:550">${e.name}<div class="muted small">${e.email || ''}</div></td><td>${e.position || ''}<div class="muted small">${e.department || ''}</div></td>
          <td class="num">${money(e.pay_rate)}<span class="muted small"> / ${e.pay_type === 'hourly' ? 'hr' : 'month'}</span></td>
          ${mg ? html`<td class="num">${e.dependents}</td><td class="mono">${e.cnaps_number || ''}</td><td class="mono">${e.tax_number || ''}</td>` : html`<td class="num">${e.income_tax_rate}</td><td class="num">${e.social_rate}</td><td class="num">${e.employer_rate}</td>`}
          <td>${e.active ? badge('paid', 'active') : badge('void', 'inactive')}</td><td>${canWrite() ? html`<button class="icon-btn" data-act="del" data-id="${e.id}" aria-label="Delete">${icon('x')}</button>` : ''}</td></tr>`)}
      </tbody></table>` : empty('No employees yet', 'Add the people you pay.', canWrite() ? btn('New employee', 'add', { ic: 'plus', cls: 'primary' }) : '')}</div>`,
  });
});
r('/o/:org/payroll/:id', async ({ id }) => {
  const run = await GET(O(`/payroll/${id}`));
  const draft = run.status === 'draft' && canWrite();
  const mg = run.payslips.some((s) => s.details) || isMG();
  const kpis = () => {
    const t = run.payslips.reduce((a, s) => { a.gross += s.gross; a.ded += s.income_tax + s.social + s.other_deductions; a.net += s.net; a.emp += s.employer_cost; return a; }, { gross: 0, ded: 0, net: 0, emp: 0 });
    return html`${kpi('Gross pay', money(t.gross))}${kpi('Deductions withheld', money(t.ded), mg ? 'CNaPS, health, IRSA, other' : '')}${kpi('Net pay to employees', money(t.net))}
      ${kpi('Total employer cost', money(t.gross + t.emp), `incl. ${money(t.emp)} contributions`)}`.s;
  };
  ACT.post = async () => { if (await confirmBox('Post pay run?', 'Wages, withholdings and net pay will be posted to the ledger and the run will be locked.', { label: 'Post to ledger', danger: false })) { await api('POST', O(`/payroll/${id}/post`)); toast('Payroll posted'); router(); } };
  ACT.void = async () => { if (await confirmBox('Void pay run?', 'A reversing entry will be posted.', { label: 'Void' })) { await api('POST', O(`/payroll/${id}/void`)); router(); } };
  ACT.del = async () => { if (await confirmBox('Delete pay run?', 'This removes the run and its payslips.', { label: 'Delete' })) { await api('DELETE', O(`/payroll/${id}`)); go(oh('/payroll')); } };
  ACT.recalc = async () => { await api('POST', O(`/payroll/${id}/recalculate`)); toast('Payslips recalculated with current settings'); router(); };
  ACT.rmSlip = async (el) => { await api('DELETE', O(`/payroll/${id}/payslips/${el.dataset.id}`)); router(); };
  const cells = (s) => (mg
    ? { CNAPS: detail(s, 'CNAPS').employee, HEALTH: detail(s, 'HEALTH').employee, IRSA: s.income_tax }
    : { income_tax: s.income_tax, social: s.social });
  ACT.slip = async (el) => {
    const tr = el.closest('tr'), sid = +tr.dataset.id;
    const body = { hours: $('[name=hours]', tr) ? $('[name=hours]', tr).value : undefined, bonus: toCents($('[name=bonus]', tr).value), other_deductions: toCents($('[name=other]', tr).value) };
    const s = await api('PUT', O(`/payroll/${id}/payslips/${sid}`), body);
    const slip = Object.assign(run.payslips.find((p) => p.id === sid), s);
    for (const k of ['base', 'gross', 'net', 'employer_cost']) $(`[data-f=${k}]`, tr).textContent = money(s[k]);
    for (const [k, v] of Object.entries(cells(slip))) $(`[data-f=${k}]`, tr).textContent = money(v);
    $('#kpis').innerHTML = kpis();
  };
  const inp = (name, v, attrs = '') => html`<input name="${name}" type="number" step="any" min="0" class="num" value="${v}" data-change="slip" style="width:100px" ${raw(attrs)}>`;
  const health = (S.org.payroll && S.org.payroll.health_name) || 'Health';
  page({
    title: `Pay run · ${fmtDate(run.period_start)} – ${fmtDate(run.period_end)}`, crumbs: html`<a href="${oh('/payroll')}">Payroll</a>`,
    actions: html`${linkBtn('Print payslips', `#/print/${S.org.id}/payroll/${id}?auto=1`, { ic: 'print', blank: true })}
      ${draft ? html`${btn('Recalculate', 'recalc', { ic: 'refresh' })}${btn('Delete', 'del', { cls: 'danger' })}${btn('Post to ledger', 'post', { cls: 'primary' })}` : ''}
      ${run.status === 'posted' && canWrite() ? btn('Void', 'void', { cls: 'danger' }) : ''}`,
    body: html`<div class="row" style="margin-bottom:14px">${badge(run.status)}<span class="muted">Pay date ${fmtDate(run.pay_date)}${run.notes ? ' · ' + run.notes : ''}</span></div>
      <div class="grid g4" id="kpis">${raw(kpis())}</div>
      <div class="card table-wrap" style="margin-top:18px"><table><thead><tr><th>Employee</th><th class="num">Hours</th><th class="num">Base</th><th class="num">Bonus</th><th class="num">Gross</th>
        ${mg ? html`<th class="num">CNaPS</th><th class="num">${health}</th><th class="num">IRSA</th>` : html`<th class="num">Income tax</th><th class="num">Social</th>`}
        <th class="num">Other ded.</th><th class="num">Net pay</th><th class="num">Employer</th>${draft ? html`<th></th>` : ''}</tr></thead><tbody>
        ${run.payslips.map((s) => html`<tr data-id="${s.id}"><td style="font-weight:550">${s.name}<div class="muted small">${s.position || ''}${mg ? ` · ${s.dependents} dependant${s.dependents === 1 ? '' : 's'}` : ''}</div></td>
          <td class="num">${s.pay_type === 'hourly' ? (draft ? inp('hours', s.hours, 'step="0.25"') : s.hours) : html`<span class="muted">—</span>`}</td>
          <td class="num" data-f="base">${money(s.base)}</td>
          <td class="num">${draft ? inp('bonus', fromCents(s.bonus)) : money(s.bonus)}</td>
          <td class="num" data-f="gross" style="font-weight:600">${money(s.gross)}</td>
          ${Object.entries(cells(s)).map(([k, v]) => html`<td class="num" data-f="${k}">${money(v)}</td>`)}
          <td class="num">${draft ? inp('other', fromCents(s.other_deductions)) : money(s.other_deductions)}</td>
          <td class="num pos" data-f="net" style="font-weight:600">${money(s.net)}</td><td class="num muted" data-f="employer_cost">${money(s.employer_cost)}</td>
          ${draft ? html`<td><button class="icon-btn" data-act="rmSlip" data-id="${s.id}" aria-label="Remove from run">${icon('x')}</button></td>` : ''}</tr>`)}
      </tbody></table></div>
      <p class="muted small">${mg
        ? `CNaPS and ${health} are capped at ${num(S.org.payroll.ceiling_multiplier)} × the minimum wage (SME). IRSA is computed on gross minus employee contributions, rounded down to ${num(S.org.payroll.irsa_base_rounding)} Ar, less ${num(S.org.payroll.irsa_dependent_reduction)} Ar per dependant, minimum ${num(S.org.payroll.irsa_minimum)} Ar. Posting credits CNaPS, ${health}, IRSA and FMFP payable accounts separately.`
        : 'Posting debits Salaries & Wages (gross) and Employer Payroll Taxes, credits Payroll Liabilities (withholdings + employer contributions) and pays net wages from the bank account.'}</p>`,
  });
});
r('/print/:org/payroll/:id', async ({ id, query }) => {
  const run = await GET(O(`/payroll/${id}`));
  const cur = run.org.currency;
  const row = (l, v, b, extra = '') => html`<tr><td>${b ? html`<b>${l}</b>` : l}${extra ? html` <span style="color:#9ca3af;font-size:12px">${extra}</span>` : ''}</td><td class="num">${b ? html`<b>${money(v, cur)}</b>` : money(v, cur)}</td></tr>`;
  const base = (d) => (d.base ? `${d.employee_rate ?? ''}${d.employee_rate != null ? '% of ' : ''}${money(d.base, cur)}` : '');
  $('#app').innerHTML = html`<div class="print-page"><div class="print-bar no-print"><button class="btn" data-act="back">Back</button><button class="btn primary" data-act="print">${icon('print')}Print / Save as PDF</button></div>
    ${run.payslips.map((s) => {
      const ded = s.details ? s.details.filter((d) => d.employee) : null;
      const er = s.details ? s.details.filter((d) => d.employer) : null;
      return html`<div class="doc" style="margin:0 auto 24px;page-break-after:always">
      <div class="doc-head"><div><div class="doc-title">PAYSLIP</div><div style="margin-top:8px;font-weight:600">${run.org.legal_name || run.org.name}</div><div style="font-size:13px;color:#4b5563;white-space:pre-line">${[run.org.address, run.org.tax_id && 'NIF/STAT: ' + run.org.tax_id].filter(Boolean).join('\n')}</div></div>
        <div class="meta"><span>Period</span><span>${fmtDate(run.period_start)} – ${fmtDate(run.period_end)}</span><span>Pay date</span><span>${fmtDate(run.pay_date)}</span></div></div>
      <div class="parties"><div><h4>Employee</h4><b>${s.name}</b>
${[s.position, s.department, s.cnaps_number && 'CNaPS: ' + s.cnaps_number, s.tax_number && 'NIF: ' + s.tax_number, s.details ? `Dependants: ${s.dependents}` : ''].filter(Boolean).join('\n')}</div>
        <div style="text-align:right"><h4>Net pay</h4><div style="font-size:24px;font-weight:700">${money(s.net, cur)}</div>${s.bank_details ? html`<div style="font-size:12px;color:#6b7280">Paid to ${s.bank_details}</div>` : ''}</div></div>
      <div class="grid g2"><table><thead><tr><th>Earnings</th><th class="num">Amount</th></tr></thead><tbody>
        ${row(s.pay_type === 'hourly' ? `Hours (${s.hours} × ${money(s.pay_rate, cur)})` : 'Base salary', s.base)}${s.bonus ? row('Bonus', s.bonus) : ''}${row('Gross pay', s.gross, true)}</tbody></table>
      <table><thead><tr><th>Deductions</th><th class="num">Amount</th></tr></thead><tbody>
        ${ded ? ded.map((d) => row(d.label, d.employee, false, d.code === 'IRSA' ? `taxable ${money(d.base, cur)}` : base(d))) : html`${row('Income tax', s.income_tax)}${row('Social contributions', s.social)}`}
        ${s.other_deductions ? row('Other deductions', s.other_deductions) : ''}${row('Total deductions', s.income_tax + s.social + s.other_deductions, true)}</tbody></table></div>
      <div class="totals"><div class="grand"><span>Net pay</span><span>${money(s.net, cur)}</span></div></div>
      ${er ? html`<table style="margin-top:20px"><thead><tr><th>Employer contributions (not deducted)</th><th class="num">Amount</th></tr></thead><tbody>
        ${er.map((d) => row(d.label, d.employer, false, `${d.employer_rate}% of ${money(d.base, cur)}`))}${row('Total employer cost', s.gross + s.employer_cost, true)}</tbody></table>`
        : html`<div class="foot">Employer contributions (not deducted from pay): ${money(s.employer_cost, cur)}</div>`}
    </div>`;
    })}</div>`.s;
  if (query.auto) setTimeout(() => window.print(), 300);
});
