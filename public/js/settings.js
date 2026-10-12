'use strict';
/* Organisation settings (general, currencies, email, payroll, members, audit), profile, instance admin. */

const LOCALES = [['en-US', 'English (US) — 1,234.56'], ['en-GB', 'English (UK) — 1,234.56'], ['fr-FR', 'Français — 1 234,56'], ['fr-MG', 'Français (Madagascar) — 1 234,56']];

function rateModal(cur) {
  const base = baseCur();
  const others = currencies().filter((c) => c !== base);
  return modal({
    title: 'Add exchange rate',
    body: html`<div class="form-grid">
      ${field('Currency', html`<select name="currency">${others.map((c) => html`<option ${c === cur ? 'selected' : ''}>${c}</option>`)}</select>`)}
      ${field('Effective date', html`<input name="date" type="date" required value="${today()}">`, { hint: 'Used for transactions on or after this date' })}
      ${field(html`1 <span class="rc">${cur || others[0]}</span> = ? ${base}`, html`<input name="rate" type="number" step="any" min="0" required>`)}
      ${field(html`1 ${base} = ? <span class="rc">${cur || others[0]}</span>`, html`<input name="inverse" type="number" step="any" min="0">`, { hint: 'Fill either field — the other updates' })}
    </div>`,
    submit: 'Save rate',
    onMount: (form) => {
      const rate = $('[name=rate]', form), inv = $('[name=inverse]', form);
      const fmt = (x) => (x ? String(+x.toPrecision(10)) : '');
      rate.addEventListener('input', () => { inv.value = +rate.value ? fmt(1 / +rate.value) : ''; });
      inv.addEventListener('input', () => { rate.value = +inv.value ? fmt(1 / +inv.value) : ''; });
      $('[name=currency]', form).addEventListener('change', (e) => $$('.rc', form).forEach((s) => { s.textContent = e.target.value; }));
    },
    onSubmit: (d) => api('POST', O('/rates'), { currency: d.currency, date: d.date, rate: +d.rate }),
  });
}

const smeRow = (s = {}) => html`<tr><td><input name="sme_from" type="date" value="${s.from || ''}" required></td><td><input name="sme_amount" type="number" step="any" min="0" class="num" value="${s.amount ?? ''}" required></td><td class="num muted">${s.amount ? num(s.amount * 8) : ''}</td><td><button type="button" class="icon-btn" data-act="rmRow" aria-label="Remove">${icon('x')}</button></td></tr>`;
const bracketRow = (b = {}) => html`<tr><td><input name="br_upto" type="number" step="any" min="0" class="num" value="${b.upto ?? ''}" placeholder="and above"></td><td><input name="br_rate" type="number" step="any" min="0" max="100" class="num" value="${b.rate ?? ''}" required></td><td><button type="button" class="icon-btn" data-act="rmRow" aria-label="Remove">${icon('x')}</button></td></tr>`;

r('/o/:org/settings', () => go(oh('/settings/general')));
r('/o/:org/settings/:tab', async ({ tab }) => {
  await reloadOrg();
  const own = isOwner();
  const o = S.org;
  const T = tabs([['general', 'General', oh('/settings/general')], ['currencies', 'Currencies', oh('/settings/currencies')], ['email', 'Email', oh('/settings/email')],
    ['payroll', 'Payroll', oh('/settings/payroll')], ['members', 'Members & access', oh('/settings/members')], ['audit', 'Audit log', oh('/settings/audit')],
    ...(own ? [['danger', 'Danger zone', oh('/settings/danger')]] : [])], tab);
  const saveOrg = async (d, msg = 'Settings saved') => { await api('PUT', O(''), d); await reloadOrg(); await refreshMe(); toast(msg); router(); };
  const ownerOnly = own ? '' : html`<div class="notice">Only owners can change these settings.</div>`;
  let body = '';

  if (tab === 'general') {
    ACT.save = (d) => saveOrg(d);
    const curChoices = [...new Set(['USD', 'EUR', 'MGA', o.currency])];
    body = html`${ownerOnly}<form data-submit="save" class="card"><fieldset ${own ? '' : 'disabled'} style="border:0;margin:0;padding:0"><div class="card-b form-grid">
      <h3 class="full">Organisation</h3>
      ${field('Display name', html`<input name="name" required value="${o.name}">`)}${field('Legal name', html`<input name="legal_name" value="${o.legal_name || ''}">`)}
      ${field('Tax ID (NIF / STAT / VAT)', html`<input name="tax_id" value="${o.tax_id || ''}">`)}
      ${field('Base currency', html`<select name="currency">${curChoices.map((c) => html`<option ${c === o.currency ? 'selected' : ''}>${c}</option>`)}</select>`, { hint: 'The currency your books are kept in. Locked once transactions exist.' })}
      ${field('Number & date format', html`<select name="locale">${LOCALES.map(([k, v]) => html`<option value="${k}" ${o.locale === k ? 'selected' : ''}>${v}</option>`)}</select>`)}
      ${field('Email', html`<input name="email" type="email" value="${o.email || ''}">`)}${field('Phone', html`<input name="phone" value="${o.phone || ''}">`)}
      ${field('Address', html`<textarea name="address" rows="3">${o.address || ''}</textarea>`, { full: true })}
      <h3 class="full" style="margin-top:10px">Invoicing</h3>
      ${field('Default sales tax %', html`<input name="default_tax_rate" type="number" step="any" min="0" value="${o.default_tax_rate}">`)}${field('Payment terms (days)', html`<input name="payment_terms" type="number" min="0" value="${o.payment_terms}">`)}
      ${field('Invoice prefix', html`<input name="invoice_prefix" value="${o.invoice_prefix}">`)}${field('Next invoice number', html`<input name="next_invoice_no" type="number" min="1" value="${o.next_invoice_no}">`)}
      ${field('Bill prefix', html`<input name="bill_prefix" value="${o.bill_prefix}">`)}${field('Next bill number', html`<input name="next_bill_no" type="number" min="1" value="${o.next_bill_no}">`)}
      ${field('Invoice footer', html`<textarea name="invoice_footer" rows="3" placeholder="Bank details (RIB), mobile money number, thank-you note…">${o.invoice_footer || ''}</textarea>`, { full: true })}
    </div></fieldset>${own ? html`<div class="modal-f"><button class="btn primary">Save settings</button></div>` : ''}</form>`;
  } else if (tab === 'currencies') {
    const data = await GET(O('/rates'));
    const others = data.currencies.filter((c) => c !== data.base);
    ACT.saveCur = (d) => {
      const list = ['USD', 'EUR', 'MGA'].filter((c) => d['c_' + c]).concat(String(d.other || '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean));
      return saveOrg({ currencies: [data.base, ...list] }, 'Currencies updated');
    };
    ACT.addRate = async (el) => { if (await rateModal(el.dataset.cur)) { toast('Rate saved'); router(); } };
    ACT.delRate = async (el) => { await api('DELETE', O(`/rates/${el.dataset.id}`)); router(); };
    ACT.fetch = async () => { const r = await api('POST', O('/rates/fetch')); toast(`Fetched ${r.rates.length} rate${r.rates.length === 1 ? '' : 's'}`); router(); };
    const byCur = (c) => data.rates.filter((x) => x.currency === c);
    body = html`<div class="grid g-side">
      <div class="stack">
        ${others.length ? others.map((c) => {
          const rows = byCur(c);
          return html`<div class="card"><div class="card-h"><div><h3>${c} <span class="muted small">${(data.known[c] || {}).name || ''}</span></h3>
            <div class="muted small">${rows.length ? html`Latest: 1 ${c} = <b>${num(rows[0].rate, 6)}</b> ${data.base} · 1 ${data.base} = ${num(1 / rows[0].rate, 6)} ${c} (${fmtDate(rows[0].date)})` : 'No rate yet — add one before using this currency'}</div></div>
            ${canWrite() ? html`<button class="btn sm" data-act="addRate" data-cur="${c}">${icon('plus')}Add rate</button>` : ''}</div>
            ${rows.length ? html`<table class="compact"><thead><tr><th>Date</th><th class="num">1 ${c} =</th><th class="num">1 ${data.base} =</th><th>Source</th><th></th></tr></thead><tbody>
              ${rows.slice(0, 12).map((x) => html`<tr><td>${fmtDate(x.date)}</td><td class="num">${num(x.rate, 6)} ${data.base}</td><td class="num muted">${num(1 / x.rate, 8)} ${c}</td><td class="muted small">${x.source || ''}</td>
                <td>${canWrite() ? html`<button class="icon-btn" data-act="delRate" data-id="${x.id}" aria-label="Delete rate">${icon('x')}</button>` : ''}</td></tr>`)}</tbody></table>` : ''}</div>`;
        }) : html`<div class="card">${empty('Only the base currency is enabled', 'Enable USD, EUR or MGA on the right to invoice and bank in other currencies.')}</div>`}
      </div>
      <div class="stack">
        <form class="card" data-submit="saveCur"><div class="card-h"><h3>Enabled currencies</h3></div><fieldset ${own ? '' : 'disabled'} style="border:0;margin:0;padding:0"><div class="card-b stack">
          ${['USD', 'EUR', 'MGA'].map((c) => html`<label class="check"><input type="checkbox" name="c_${c}" ${data.currencies.includes(c) ? 'checked' : ''} ${c === data.base ? 'disabled checked' : ''}> ${c} — ${data.known[c].name}${c === data.base ? ' (base)' : ''}</label>`)}
          ${field('Other ISO codes', html`<input name="other" value="${data.currencies.filter((c) => !['USD', 'EUR', 'MGA'].includes(c) && c !== data.base).join(', ')}" placeholder="e.g. GBP, ZAR, MUR">`)}
        </div></fieldset>${own ? html`<div class="modal-f"><button class="btn primary">Save</button></div>` : ''}</form>
        <div class="card card-b stack"><h3>Automatic rates</h3>
          <p class="muted small" style="margin:0">Fetch today's market rates from open.er-api.com (free, no key). This is the only feature that contacts an outside service, and only when you press the button.</p>
          ${canWrite() && others.length ? btn('Fetch latest rates', 'fetch', { ic: 'refresh' }) : ''}
        </div>
        <p class="muted small">Your books stay in ${data.base}. Foreign invoices, bills and bank accounts are converted at the rate on the transaction date; differences when they're paid are posted to <i>Foreign Exchange Gains/Losses</i>.</p>
      </div></div>`;
  } else if (tab === 'email') {
    ACT.saveEmail = (d) => saveOrg({ ...d, smtp_port: d.smtp_port || null }, 'Email settings saved');
    ACT.test = async () => { await api('POST', O('/email/test'), { to: S.me.email }); toast(`Test email sent to ${S.me.email}`); };
    ACT.clearPass = async () => { await saveOrg({ smtp_pass_clear: true }, 'Password removed'); };
    body = html`${ownerOnly}${o.smtp_env && !o.smtp_host ? html`<div class="notice">This server has instance-wide SMTP configured, so email already works. Fill in the form only to send from this organisation's own mailbox.</div>` : ''}
      <div class="grid g-side"><form class="card" data-submit="saveEmail"><fieldset ${own ? '' : 'disabled'} style="border:0;margin:0;padding:0"><div class="card-b form-grid">
        <h3 class="full">SMTP server</h3>
        ${field('Host', html`<input name="smtp_host" value="${o.smtp_host || ''}" placeholder="smtp.gmail.com">`)}
        ${field('Security', html`<select name="smtp_secure">${[['starttls', 'STARTTLS (port 587)'], ['tls', 'SSL/TLS (port 465)'], ['none', 'None (port 25 — local relays only)']].map(([k, v]) => html`<option value="${k}" ${o.smtp_secure === k ? 'selected' : ''}>${v}</option>`)}</select>`)}
        ${field('Port', html`<input name="smtp_port" type="number" value="${o.smtp_port || ''}" placeholder="auto">`)}
        ${field('Username', html`<input name="smtp_user" value="${o.smtp_user || ''}" autocomplete="off">`)}
        ${field('Password', html`<input name="smtp_pass" type="password" autocomplete="new-password" placeholder="${o.smtp_pass_set ? '•••••••• (saved — leave blank to keep)' : ''}">`, { hint: o.smtp_pass_set ? html`Stored on this server. <a href="#" data-act="clearPass">Remove</a>` : 'For Gmail, use an app password' })}
        ${field('From address', html`<input name="smtp_from" type="email" value="${o.smtp_from || ''}" placeholder="${o.email || 'billing@yourcompany.mg'}">`)}
        <h3 class="full" style="margin-top:10px">Invoice email template</h3>
        ${field('Subject', html`<input name="email_subject" value="${o.email_subject || ''}" placeholder="${o.email_defaults.subject}">`, { full: true })}
        ${field('Message', html`<textarea name="email_body" rows="8" placeholder="${o.email_defaults.body}">${o.email_body || ''}</textarea>`, { full: true, hint: 'Placeholders: {number} {customer} {company} {total} {due} {due_date} {issue_date} {reference}' })}
      </div></fieldset>${own ? html`<div class="modal-f">${o.email_ready ? html`<button type="button" class="btn" data-act="test">${icon('mail')}Send test to ${S.me.email}</button>` : ''}<button class="btn primary">Save</button></div>` : ''}</form>
      <div class="stack"><div class="card card-b stack"><h3>Status</h3>${o.email_ready ? badge('paid', '✓ Ready to send') : badge('overdue', 'Not configured')}
        <p class="muted small" style="margin:0">Invoices are sent as a formatted email with the PDF attached. Every send is logged on the invoice. Recurring invoices can be emailed automatically.</p></div>
        <div class="card card-b small stack"><b>Common settings</b>
          <div>Gmail / Google Workspace: <span class="mono">smtp.gmail.com</span>, STARTTLS, 587, app password</div>
          <div>Microsoft 365: <span class="mono">smtp.office365.com</span>, STARTTLS, 587</div>
          <div>Brevo: <span class="mono">smtp-relay.brevo.com</span>, STARTTLS, 587</div></div></div></div>`;
  } else if (tab === 'payroll') {
    const c = o.payroll;
    const smeNow = c.sme_history.reduce((v, s) => (s.from <= today() ? s.amount : v), c.sme_history[0] ? c.sme_history[0].amount : 0);
    ACT.rmRow = (el) => { const tb = el.closest('tbody'); if ($$('tr', tb).length > 1) el.closest('tr').remove(); };
    ACT.addSme = () => $('#sme-rows').insertAdjacentHTML('beforeend', smeRow().s);
    ACT.addBracket = () => $('#br-rows').insertAdjacentHTML('beforeend', bracketRow().s);
    ACT.reset = async () => {
      if (!(await confirmBox('Reset to 2026 defaults?', 'Restores the Madagascar rates, SME history and IRSA brackets shipped with Ledgerly (October 2026).', { label: 'Reset', danger: false }))) return;
      await saveOrg({ payroll_config: await GET(O('/payroll/defaults')) }, 'Defaults restored');
    };
    ACT.savePayroll = async (d, form) => {
      const rows = (sel, map) => $$(sel + ' tr', form).map(map);
      const cfg = {
        health_name: d.health_name, cnaps_employee: d.cnaps_employee, cnaps_employer: d.cnaps_employer, health_employee: d.health_employee, health_employer: d.health_employer,
        fmfp_employer: d.fmfp_employer, ceiling_multiplier: d.ceiling_multiplier, irsa_minimum: d.irsa_minimum, irsa_dependent_reduction: d.irsa_dependent_reduction,
        irsa_base_rounding: d.irsa_base_rounding, standard_hours: d.standard_hours,
        sme_history: rows('#sme-rows', (tr) => ({ from: $('[name=sme_from]', tr).value, amount: $('[name=sme_amount]', tr).value })),
        irsa_brackets: rows('#br-rows', (tr) => ({ upto: $('[name=br_upto]', tr).value === '' ? null : $('[name=br_upto]', tr).value, rate: $('[name=br_rate]', tr).value })),
      };
      await saveOrg(d.payroll_scheme === 'madagascar' ? { payroll_scheme: d.payroll_scheme, payroll_config: cfg } : { payroll_scheme: d.payroll_scheme }, 'Payroll settings saved');
    };
    ACT.scheme = (el) => $('#mg-config').classList.toggle('hidden', el.value !== 'madagascar');
    const pct = (name, label) => field(label, html`<input name="${name}" type="number" step="any" min="0" class="num" value="${c[name]}">`);
    body = html`${ownerOnly}<form data-submit="savePayroll"><fieldset ${own ? '' : 'disabled'} style="border:0;margin:0;padding:0">
      <div class="card card-b stack"><h3>Payroll scheme</h3>
        <label class="check"><input type="radio" name="payroll_scheme" value="flat" data-change="scheme" ${o.payroll_scheme !== 'madagascar' ? 'checked' : ''}> Flat rates per employee — any country</label>
        <label class="check"><input type="radio" name="payroll_scheme" value="madagascar" data-change="scheme" ${o.payroll_scheme === 'madagascar' ? 'checked' : ''}> Madagascar — CNaPS, ${c.health_name}, FMFP and progressive IRSA</label>
        ${o.payroll_scheme === 'madagascar' && o.currency !== 'MGA' ? html`<div class="notice warn" style="margin:0">This organisation's base currency is ${o.currency}. The Madagascar scheme expects salaries in Ariary (MGA) — ceilings and IRSA brackets are in Ariary.</div>` : ''}
      </div>
      <div id="mg-config" class="${o.payroll_scheme === 'madagascar' ? '' : 'hidden'}">
        <div class="notice">Defaults verified October 2026: CNaPS 13% / 1%, OSTIE 5% / 1% (both capped at ${c.ceiling_multiplier} × SME), FMFP 1%, IRSA per the 2026 finance law (25% band above 4,000,000 Ar), minimum ${num(c.irsa_minimum)} Ar, ${num(c.irsa_dependent_reduction)} Ar per dependant. Rates change by decree — check with your accountant or the DGI/CNaPS and update here.</div>
        <div class="grid g2">
          <div class="card"><div class="card-h"><h3>Social contributions (%)</h3></div><div class="card-b form-grid">
            ${pct('cnaps_employee', 'CNaPS — employee')}${pct('cnaps_employer', 'CNaPS — employer')}
            ${field('Health organisation', html`<input name="health_name" value="${c.health_name}">`, { hint: 'OSTIE, AMIT, ESIA, FUNHECE, SMIE…' })}<div></div>
            ${pct('health_employee', 'Health — employee')}${pct('health_employer', 'Health — employer')}
            ${pct('fmfp_employer', 'FMFP — employer (uncapped)')}${pct('ceiling_multiplier', 'Ceiling = SME ×')}
          </div></div>
          <div class="card"><div class="card-h"><h3>IRSA</h3></div><div class="card-b form-grid">
            ${field('Minimum IRSA (Ar)', html`<input name="irsa_minimum" type="number" step="any" min="0" class="num" value="${c.irsa_minimum}">`)}
            ${field('Reduction per dependant (Ar)', html`<input name="irsa_dependent_reduction" type="number" step="any" min="0" class="num" value="${c.irsa_dependent_reduction}">`)}
            ${field('Round taxable base down to (Ar)', html`<input name="irsa_base_rounding" type="number" step="any" min="1" class="num" value="${c.irsa_base_rounding}">`)}
            ${field('Standard monthly hours', html`<input name="standard_hours" type="number" step="any" min="0" class="num" value="${c.standard_hours}">`, { hint: 'Default for hourly staff' })}
            <div class="full"><table class="compact lines-table"><thead><tr><th class="num">Taxable income up to (Ar)</th><th class="num">Rate %</th><th></th></tr></thead><tbody id="br-rows">${c.irsa_brackets.map(bracketRow)}</tbody></table>
              ${own ? html`<button type="button" class="btn sm" data-act="addBracket" style="margin-top:8px">${icon('plus')}Add bracket</button>` : ''}<p class="hint" style="margin:6px 0 0">Leave the last limit empty for “and above”.</p></div>
          </div></div>
        </div>
        <div class="card" style="margin-top:18px"><div class="card-h"><div><h3>Minimum wage (SME) history</h3><div class="muted small">Current SME ${num(smeNow)} Ar → contribution ceiling ${num(smeNow * c.ceiling_multiplier)} Ar. The SME in force on each pay period's end date is used.</div></div></div>
          <div class="card-b"><table class="compact lines-table"><thead><tr><th>Effective from</th><th class="num">SME (Ar / month)</th><th class="num">Ceiling (× 8)</th><th></th></tr></thead><tbody id="sme-rows">${c.sme_history.map(smeRow)}</tbody></table>
          ${own ? html`<button type="button" class="btn sm" data-act="addSme" style="margin-top:8px">${icon('plus')}Add SME change</button>` : ''}</div></div>
      </div>
      </fieldset>${own ? html`<div class="row" style="justify-content:flex-end;margin-top:14px">${btn('Reset to 2026 defaults', 'reset')}<button class="btn primary">Save payroll settings</button></div>` : ''}</form>
      <p class="muted small">Changes apply to new pay runs. Use “Recalculate” on a draft run to refresh it; posted runs are never changed.</p>`;
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
      ${log.map((a) => html`<tr><td class="small" style="white-space:nowrap">${new Date(a.at.replace(' ', 'T') + 'Z').toLocaleString(locale())}</td><td>${a.user_name || html`<span class="muted">system</span>`}</td><td><span class="badge">${a.action}</span>${a.entity_id ? html` <span class="muted small">#${a.entity_id}</span>` : ''}</td><td class="mono muted" style="max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${a.details || ''}</td></tr>`)}
    </tbody></table></div>`;
  } else if (tab === 'danger' && own) {
    ACT.delete = async () => {
      const res = await modal({ title: `Delete ${S.org.name}?`, danger: true, submit: 'Delete forever',
        body: html`<p style="margin-top:0">This permanently deletes the organisation and <b>all</b> its invoices, bills, stock, payroll and ledger data. Download a backup first if unsure.</p>${field('Type the organisation name to confirm', html`<input name="confirm" required autocomplete="off">`)}`,
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
