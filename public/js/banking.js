'use strict';
/* Banking (multi-currency accounts, fees, transfers, revaluation, CSV import), chart of accounts, journal. */

// ============ account edit modal (shared with banking "Account settings") ============
async function accountModal(a = {}) {
  let deleted = false;
  const isBank = !!a.is_bank;
  const cur = a.currency || '';
  const res = await modal({
    title: a.id ? `${a.code} · ${a.name}` : 'New account', wide: true,
    body: html`<div class="form-grid cols3">
      ${field('Code', html`<input name="code" required value="${a.code || ''}">`)}
      ${field('Type', html`<select name="type" ${a.system_key ? 'disabled' : ''}>${Object.entries(TYPE_LABEL).map(([k, v]) => html`<option value="${k}" ${a.type === k ? 'selected' : ''}>${v.replace(/s$/, '').replace('Liabilitie', 'Liability')}</option>`)}</select>`)}
      ${field('Subtype', html`<select name="subtype">${[['', '—'], ['current', 'Current'], ['fixed', 'Fixed / non-current'], ['long_term', 'Long-term'], ['cogs', 'Cost of goods sold']].map(([k, v]) => html`<option value="${k}" ${(a.subtype || '') === k ? 'selected' : ''}>${v}</option>`)}</select>`)}
      ${field('Name', html`<input name="name" required value="${a.name || ''}">`, { cls: 'span2' })}
      <div class="stack" style="padding-top:20px">
        <label class="check"><input type="checkbox" name="is_bank" ${isBank ? 'checked' : ''}> Bank / cash / card / mobile money</label>
        ${a.id ? html`<label class="check"><input type="checkbox" name="archived" ${a.archived ? 'checked' : ''} ${a.system_key ? 'disabled' : ''}> Archived</label>` : ''}
      </div>
      ${field('Description', html`<input name="description" value="${a.description || ''}">`, { full: true })}
      <div class="full bank-only stack ${isBank ? '' : 'hidden'}" style="border-top:1px solid var(--border);padding-top:14px">
        <h3>Bank account settings</h3>
        <div class="form-grid cols4">
          ${field('Account currency', html`<select name="currency"><option value="">${baseCur()} (base)</option>${currencies().filter((c) => c !== baseCur()).map((c) => html`<option value="${c}" ${cur === c ? 'selected' : ''}>${c}</option>`)}</select>`, { hint: 'Fixed once the account has transactions' })}
          ${field('Fee per transaction (fixed)', html`<input name="fee_fixed" type="number" step="any" min="0" value="${fromCents(a.fee_fixed || 0)}">`, { hint: 'In the account currency' })}
          ${field('Fee per transaction (%)', html`<input name="fee_percent" type="number" step="any" min="0" max="100" value="${a.fee_percent || 0}">`, { hint: 'e.g. mobile money or card %' })}
          ${field('Monthly account fee', html`<input name="monthly_fee" type="number" step="any" min="0" value="${fromCents(a.monthly_fee || 0)}">`, { hint: 'Posted automatically each month' })}
          ${field('Charged on day', html`<input name="monthly_fee_day" type="number" min="1" max="28" value="${a.monthly_fee_day || 1}">`)}
        </div>
        <p class="hint" style="margin:0">Per-transaction fees are suggested automatically when you record payments and transfers through this account — you can always change them.</p>
      </div>
    </div>${a.system_key ? html`<p class="hint" style="margin:12px 0 0">System account used for automatic postings — type cannot change.</p>` : ''}`,
    extra: a.id && canWrite() && !a.system_key ? html`<button type="button" class="btn danger" id="del-acc">Delete</button>` : '',
    submit: canWrite() ? 'Save' : null,
    onMount: (form, close) => {
      $('[name=is_bank]', form).addEventListener('change', (e) => $('.bank-only', form).classList.toggle('hidden', !e.target.checked));
      const del = $('#del-acc', form);
      if (del) del.addEventListener('click', async () => {
        try { await api('DELETE', O(`/accounts/${a.id}`)); deleted = true; close(true); }
        catch (e) { showErr(form, e.message); }
      });
    },
    onSubmit: (d) => {
      if (a.system_key) d.type = a.type;
      d.fee_fixed = toCents(d.fee_fixed); d.monthly_fee = toCents(d.monthly_fee);
      return a.id ? api('PUT', O(`/accounts/${a.id}`), d) : api('POST', O('/accounts'), d);
    },
  });
  if (res || deleted) S.accounts = null;
  return res || deleted;
}

// ============ banking ============
r('/o/:org/banking', async ({ query }) => {
  const q = new URLSearchParams(query).toString();
  const [data, accs, contacts] = await Promise.all([GET(O(`/bank?${q}`)), accounts(true), GET(O('/contacts'))]);
  const L = data.ledger;
  const cur = L && L.account;
  const curCode = accCur(cur);
  const foreign = cur && curCode !== baseCur();
  const nonBank = live(accs).filter((a) => !cur || a.id !== cur.id);
  const rateField = (c) => field(rateLabel(c), html`<input name="exchange_rate" type="number" step="any" min="0">`, { cls: 'rate-field', hint: html`<span class="rate-hint"></span>` });
  // Keeps fee suggestion, currency labels and the exchange-rate field in step with the selected account.
  const wireTx = (form, accField = 'account_id') => {
    const $f = (n) => $(`[name=${n}]`, form);
    let feeTouched = false;
    $f('fee').addEventListener('input', () => { feeTouched = true; });
    const update = async (lookup) => {
      const acc = accs.find((a) => String(a.id) === $f(accField).value);
      const c = accCur(acc);
      $$('.acc-cur', form).forEach((el) => { el.textContent = c; });
      if (!feeTouched) $f('fee').value = fromCents(suggestFee(acc, toCents($f('amount').value)));
      const rf = $('.rate-field', form);
      if (rf) {
        rf.classList.toggle('hidden', c === baseCur());
        $('.field-label', rf).textContent = rateLabel(c);
        if (c !== baseCur() && lookup) {
          const r = await lookupRate(c, $f('date').value);
          $f('exchange_rate').value = r || '';
          $('.rate-hint', form).textContent = r ? 'Saved rate for this date' : 'No saved rate — enter one';
        }
      }
    };
    $f(accField).addEventListener('change', () => { feeTouched = false; update(true); });
    $f('amount').addEventListener('input', () => update(false));
    $f('date').addEventListener('change', () => update(true));
    update(true);
  };
  const txModal = async (dir) => {
    const res = await modal({
      title: dir === 'in' ? 'Money in' : 'Money out',
      body: html`<div class="form-grid">
        ${field('Bank account', html`<select name="account_id" required>${accountOptions(banks(accs), cur && cur.id)}</select>`)}
        ${field('Date', html`<input name="date" type="date" required value="${today()}">`)}
        ${field(html`Amount (<span class="acc-cur">${curCode}</span>)`, html`<input name="amount" type="number" step="any" min="0" required>`)}
        ${field(html`Bank fee (<span class="acc-cur">${curCode}</span>)`, html`<input name="fee" type="number" step="any" min="0" value="0">`, { hint: dir === 'in' ? 'Deducted from the amount received' : 'Charged on top' })}
        ${field('Category', html`<select name="category_id" required>${accountOptions(nonBank.filter((a) => (dir === 'in' ? a.type !== 'expense' : a.type !== 'income')), null, 'Choose account…')}</select>`, { hint: dir === 'in' ? 'e.g. Sales, Other income, Owner\'s capital, Loans' : 'e.g. Rent, Software, Owner\'s drawings, tax payments' })}
        ${rateField(curCode)}
        ${field('Description', html`<input name="description" placeholder="${dir === 'in' ? 'Cash sale' : 'Office rent October'}">`, { full: true })}
        ${field('Contact (optional)', html`<select name="contact_id">${contactOptions(contacts)}</select>`, { full: true })}
      </div>`,
      submit: 'Record',
      onMount: (form) => wireTx(form),
      onSubmit: (d) => api('POST', O('/bank/transactions'), { ...d, direction: dir, amount: toCents(d.amount), fee: toCents(d.fee) }),
    });
    if (res) { toast('Transaction recorded'); router(); }
  };
  ACT.moneyIn = () => txModal('in');
  ACT.moneyOut = () => txModal('out');
  ACT.transfer = async () => {
    const res = await modal({
      title: 'Transfer between accounts',
      body: html`<div class="form-grid">
        ${field('From', html`<select name="from_id" required>${accountOptions(banks(accs), cur && cur.id)}</select>`)}
        ${field('To', html`<select name="to_id" required>${accountOptions(banks(accs), null, 'Choose…')}</select>`)}
        ${field(html`Amount sent (<span class="acc-cur">${curCode}</span>)`, html`<input name="amount" type="number" step="any" min="0" required>`)}
        ${field(html`Amount received (<span class="to-cur"></span>)`, html`<input name="to_amount" type="number" step="any" min="0">`, { cls: 'to-amount hidden', hint: 'Different currencies — enter what arrived' })}
        ${field(html`Transfer fee (<span class="acc-cur">${curCode}</span>)`, html`<input name="fee" type="number" step="any" min="0" value="0">`)}
        ${field('Date', html`<input name="date" type="date" required value="${today()}">`)}
        ${rateField(curCode)}
        ${field('Memo', html`<input name="description" value="Transfer">`, { full: true })}
      </div>`,
      submit: 'Transfer',
      onMount: (form) => {
        wireTx(form, 'from_id');
        const sync = () => {
          const from = accs.find((a) => String(a.id) === $('[name=from_id]', form).value), to = accs.find((a) => String(a.id) === $('[name=to_id]', form).value);
          const differ = to && accCur(from) !== accCur(to);
          $('.to-amount', form).classList.toggle('hidden', !differ);
          $('.to-cur', form).textContent = accCur(to);
        };
        $('[name=from_id]', form).addEventListener('change', sync);
        $('[name=to_id]', form).addEventListener('change', sync);
        sync();
      },
      onSubmit: (d) => api('POST', O('/bank/transfer'), { ...d, amount: toCents(d.amount), to_amount: toCents(d.to_amount), fee: toCents(d.fee) }),
    });
    if (res) { toast('Transfer recorded'); router(); }
  };
  ACT.revalue = async () => {
    const rate = await lookupRate(curCode, today());
    const res = await modal({
      title: `Revalue ${cur.name}`,
      body: html`<p style="margin-top:0">Restates the ${baseCur()} value of the ${money(cur.fx_balance, curCode)} held in this account at today's rate. The difference is posted to Foreign Exchange Gains/Losses.</p>
        <div class="form-grid">${field('Date', html`<input name="date" type="date" required value="${today()}">`)}${field(rateLabel(curCode), html`<input name="exchange_rate" type="number" step="any" min="0" required value="${rate || ''}">`)}</div>`,
      submit: 'Revalue',
      onSubmit: (d) => api('POST', O(`/bank/${cur.id}/revalue`), d),
    });
    if (res) { toast(res.diff ? `Posted ${res.diff > 0 ? 'gain' : 'loss'} of ${money(Math.abs(res.diff))}` : 'Already up to date'); router(); }
  };
  ACT.settings = async () => { if (await accountModal(cur)) router(); };
  ACT.import = async () => {
    let parsed = [];
    const res = await modal({
      title: 'Import bank statement (CSV)', wide: true,
      body: html`<div class="form-grid">
        ${field('Bank account', html`<select name="account_id" required>${accountOptions(banks(accs), cur && cur.id)}</select>`, { hint: 'Amounts are read in the account\'s currency' })}
        ${field('Date format in file', html`<select name="fmt"><option value="dmy">DD/MM/YYYY</option><option value="mdy">MM/DD/YYYY</option></select>`, { hint: 'ISO dates (YYYY-MM-DD) are detected automatically' })}
        ${field('Category for money in', html`<select name="income_category_id" required>${accountOptions(live(accs).filter((a) => a.type === 'income'), sysAcc(accs, 'sales').id)}</select>`)}
        ${field('Category for money out', html`<select name="expense_category_id" required>${accountOptions(live(accs).filter((a) => a.type === 'expense'), sysAcc(accs, 'other_exp').id)}</select>`)}
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
          pv.innerHTML = html`<b>${parsed.length} transactions detected.</b><table class="compact" style="margin-top:8px"><tbody>${parsed.slice(0, 5).map((x) => html`<tr><td>${x.date}</td><td>${x.description}</td><td class="num">${num(x.amount / 100)}</td></tr>`)}</tbody></table>${parsed.length > 5 ? html`<div class="muted">…and ${parsed.length - 5} more</div>` : ''}`.s;
        });
      },
      onSubmit: (d) => { if (!parsed.length) throw new Error('Choose a CSV file with transactions'); return api('POST', O('/bank/import'), { ...d, rows: parsed }); },
    });
    if (res) { toast(`Imported ${res.imported} transactions`); router(); }
  };
  ACT.reverse = async (el) => { if (await confirmBox('Reverse transaction?', 'A reversing entry dated today will be posted.', { label: 'Reverse' })) { await api('POST', O(`/journal/${el.dataset.id}/reverse`)); router(); } };
  ACT.filter = (d) => go(oh('/banking?' + new URLSearchParams(Object.entries(d).filter(([, v]) => v)).toString()));
  const lineAmt = (l, side) => {
    if (!l[side]) return '';
    if (foreign && l.fx_currency === curCode) return html`${money(l.fx_amount, curCode)}<div class="muted small">${money(l[side])}</div>`;
    return foreign ? html`<span class="muted">${money(l[side])}</span>` : money(l[side]);
  };
  page({
    title: 'Banking',
    actions: canWrite() ? html`${btn('Import CSV', 'import', { ic: 'upload' })}${btn('Transfer', 'transfer', { ic: 'swap' })}${btn('Money out', 'moneyOut', { ic: 'arrowOut' })}${btn('Money in', 'moneyIn', { ic: 'arrowIn', cls: 'primary' })}` : '',
    body: html`
      <div class="grid g4">${data.accounts.map((a) => {
        const f = a.currency && a.currency !== baseCur();
        return html`<a class="card kpi" href="${oh('/banking?account_id=' + a.id)}" style="color:inherit;text-decoration:none;${cur && cur.id === a.id ? 'border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)' : ''}">
          <div class="label">${a.code} · ${a.name}${curBadge(a.currency)}</div>
          <div class="value ${(f ? a.fx_balance : a.balance) < 0 ? 'neg' : ''}">${f ? money(a.fx_balance, a.currency) : money(a.balance)}</div>
          <div class="sub">${f ? html`Booked at ${money(a.balance)}` : a.type === 'liability' ? 'Credit account' : 'Available'}${a.monthly_fee ? html` · ${money(a.monthly_fee, accCur(a))}/month fee` : ''}</div></a>`;
      })}
      <div class="card kpi"><div class="label">Bank fees this year</div><div class="value">${money(data.feesYtd)}</div><div class="sub">Posted to Bank Fees</div></div></div>
      ${L ? html`<div class="card" style="margin-top:18px"><div class="card-h"><div><h3>${L.account.name}${curBadge(L.account.currency)}</h3>
          ${foreign ? html`<div class="muted small">Balance ${money(L.fxClosing, curCode)} · booked at ${money(L.closing)}</div>` : ''}</div>
        <div class="row">
          ${canWrite() ? html`${foreign ? btn('Revalue', 'revalue', { cls: 'sm', ic: 'refresh' }) : ''}${btn('Account settings', 'settings', { cls: 'sm', ic: 'gear' })}` : ''}
          <form class="row" data-submit="filter"><input type="hidden" name="account_id" value="${L.account.id}"><input type="date" name="from" value="${query.from || ''}" style="width:150px" aria-label="From"><input type="date" name="to" value="${query.to || ''}" style="width:150px" aria-label="To"><button class="btn sm">Filter</button></form>
        </div></div>
        ${L.lines.length ? html`<div class="table-wrap"><table><thead><tr><th>Date</th><th>Description</th><th>Contact</th><th class="num">In</th><th class="num">Out</th><th class="num">Balance</th><th></th></tr></thead><tbody>
          ${[...L.lines].reverse().map((l) => html`<tr><td>${fmtDate(l.date)}</td><td>${l.memo || l.description || ''} ${l.ref_type !== 'bank' && l.ref_type !== 'manual' ? html`<span class="badge">${l.ref_type.replace('_', ' ')}</span>` : ''}</td><td>${l.contact_name || ''}</td>
            <td class="num pos">${lineAmt(l, 'debit')}</td><td class="num">${lineAmt(l, 'credit')}</td>
            <td class="num ${(foreign ? l.fx_balance : l.balance) < 0 ? 'neg' : ''}">${foreign ? money(l.fx_balance, curCode) : money(l.balance)}</td>
            <td>${canWrite() && l.ref_type === 'bank' ? html`<button class="btn sm ghost" data-act="reverse" data-id="${l.entry_id}">Reverse</button>` : ''}</td></tr>`)}
          ${query.from ? html`<tr><td colspan="5" class="muted">Opening balance</td><td class="num">${foreign ? money(L.fxOpening, curCode) : money(L.opening)}</td><td></td></tr>` : ''}
        </tbody></table></div>` : empty('No transactions', 'Record money in or out, or import a CSV statement from your bank.')}
      </div>` : html`<div class="card">${empty('No bank accounts', 'Mark an asset account as a bank account in the chart of accounts.')}</div>`}`,
  });
});

// ============ chart of accounts ============
r('/o/:org/accounts', async ({ query }) => {
  const accs = await accounts(true);
  const showArchived = query.archived === '1';
  const shown = accs.filter((a) => showArchived || !a.archived);
  ACT.add = async () => { if (await accountModal()) router(); };
  ACT.edit = async (el) => { if (await accountModal(accs.find((a) => a.id === +el.dataset.id))) router(); };
  page({
    title: 'Chart of accounts',
    actions: html`<a class="btn" href="${oh('/accounts' + (showArchived ? '' : '?archived=1'))}">${showArchived ? 'Hide' : 'Show'} archived</a>${canWrite() ? btn('New account', 'add', { ic: 'plus', cls: 'primary' }) : ''}`,
    body: html`<div class="card table-wrap"><table><thead><tr><th style="width:90px">Code</th><th>Name</th><th>Subtype</th><th></th><th class="num">Balance (${baseCur()})</th></tr></thead><tbody>
      ${Object.keys(TYPE_LABEL).map((t) => html`<tr class="section"><td colspan="5">${TYPE_LABEL[t]}</td></tr>
        ${shown.filter((a) => a.type === t).map((a) => html`<tr class="click" data-act="edit" data-id="${a.id}" style="${a.archived ? 'opacity:.55' : ''}">
          <td class="mono">${a.code}</td><td>${a.name} ${a.is_bank ? html`<span class="badge teal">bank</span>` : ''}${curBadge(a.currency)} ${a.system_key ? html`<span class="badge" title="Used for automatic postings">system</span>` : ''} ${a.archived ? html`<span class="badge">archived</span>` : ''}</td>
          <td class="muted">${(a.subtype || '').replace('_', ' ')}</td>
          <td><a class="small" href="${oh(`/reports/ledger?account_id=${a.id}`)}">Ledger →</a></td>
          <td class="num ${a.balance < 0 ? 'neg' : ''}">${money(a.balance)}${a.currency && a.currency !== baseCur() ? html`<div class="muted small">${money(a.fx_balance, a.currency)}</div>` : ''}</td></tr>`)}`)}
    </tbody></table></div>`,
  });
});

// ============ journal ============
function journalLineRow(accs, l = {}) {
  return html`<tr>
    <td><select name="account_id" aria-label="Account">${accountOptions(live(accs), l.account_id, 'Account…')}</select></td>
    <td><input name="description" value="${l.description || ''}" aria-label="Line description"></td>
    <td style="width:130px"><input name="debit" type="number" step="any" min="0" class="num" aria-label="Debit"></td>
    <td style="width:130px"><input name="credit" type="number" step="any" min="0" class="num" aria-label="Credit"></td>
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
        <p class="hint" style="margin:10px 0 0">Amounts in ${baseCur()} (base currency).</p>
        <table class="lines-table" style="margin-top:12px"><thead><tr><th>Account</th><th>Description</th><th class="num">Debit</th><th class="num">Credit</th><th></th></tr></thead>
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
        ${field('Source', html`<select name="type"><option value="">All</option>${['manual', 'bank', 'invoice', 'bill', 'payment', 'payroll', 'stock'].map((t) => html`<option ${query.type === t ? 'selected' : ''}>${t}</option>`)}</select>`)}
        <button class="btn">Filter</button></form>
      <div class="card table-wrap">${data.entries.length ? html`<table><thead><tr><th style="width:130px">Date</th><th>Account / memo</th><th class="num">Debit</th><th class="num">Credit</th><th></th></tr></thead><tbody>
        ${data.entries.map((e) => html`<tr class="entry"><td>${fmtDate(e.date)}</td><td>${e.memo || 'Journal entry'} ${refLink(e)} ${e.reversed_by && !e.ref_type.endsWith('reversal') ? html`<span class="badge">reversed</span>` : ''}</td><td></td><td></td>
          <td class="num">${canWrite() && !e.reversed_by && ['manual', 'bank'].includes(e.ref_type) ? html`<button class="btn sm ghost" data-act="reverse" data-id="${e.id}">Reverse</button>` : ''}</td></tr>
          ${e.lines.map((l) => html`<tr><td></td><td class="${l.credit ? 'indent' : ''}"><span class="mono muted">${l.code}</span> ${l.account_name}${l.description ? html` <span class="muted small">— ${l.description}</span>` : ''}${l.fx_currency ? html` <span class="muted small">(${money(l.fx_amount, l.fx_currency)})</span>` : ''}</td><td class="num">${l.debit ? money(l.debit) : ''}</td><td class="num">${l.credit ? money(l.credit) : ''}</td><td></td></tr>`)}`)}
      </tbody></table>` : empty('No journal entries', 'Entries are created automatically from invoices, bills, banking, stock and payroll — or post one manually.')}</div>
      ${data.total > data.entries.length ? html`<div style="text-align:center;margin-top:14px">${btn('Load more', 'more')}</div>` : ''}`,
  });
});
