'use strict';
// Background jobs: recurring invoices and monthly bank-account fees. Runs at start-up and hourly.
const { all, get, run } = require('./db');
const D = require('./documents');
const B = require('./banking');
const E = require('./email');

const MAX_CATCH_UP = 24; // never generate more than this many missed occurrences per template per run
const today = () => new Date().toISOString().slice(0, 10);
const log = (orgId, action, entityId, details) => run('INSERT INTO audit_log (org_id, action, entity, entity_id, details) VALUES (?,?,?,?,?)', orgId, action, 'recurring', entityId, JSON.stringify(details));

// Generate due invoices for one template. Returns the ids created.
async function runTemplate(org, tpl, { force = false, userId = null } = {}) {
  const created = [];
  let next = tpl.next_date;
  const anchor = +tpl.start_date.slice(8, 10);
  for (let i = 0; i < MAX_CATCH_UP; i++) {
    if (!force && next > today()) break;
    if (tpl.end_date && next > tpl.end_date) { run('UPDATE recurring_invoices SET active = 0 WHERE id = ?', tpl.id); break; }
    let id;
    try {
      id = D.generateFromTemplate(org, tpl, force ? (next > today() ? today() : next) : next, userId);
    } catch (e) {
      run(`UPDATE recurring_invoices SET last_error = ?, last_run_at = datetime('now') WHERE id = ?`, e.message, tpl.id);
      log(org.id, 'recurring.error', tpl.id, { error: e.message });
      break;
    }
    created.push(id);
    next = D.nextDate(next, tpl.frequency, tpl.interval_count || 1, anchor);
    run(`UPDATE recurring_invoices SET next_date = ?, generated = generated + 1, last_run_at = datetime('now'), last_error = NULL WHERE id = ?`, next, tpl.id);
    log(org.id, 'recurring.generate', tpl.id, { invoice_id: id });
    if (tpl.auto_finalize && tpl.auto_email && E.configured(org)) {
      try { await E.sendInvoice(org, D.full(org, 'invoice', id), {}, userId); }
      catch (e) { run('UPDATE recurring_invoices SET last_error = ? WHERE id = ?', `Invoice created but email failed: ${e.message}`, tpl.id); }
    }
    if (force) break;
  }
  return created;
}

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    for (const org of all('SELECT * FROM orgs')) {
      for (const tpl of all('SELECT * FROM recurring_invoices WHERE org_id = ? AND active = 1 AND next_date <= ?', org.id, today())) {
        await runTemplate(get('SELECT * FROM orgs WHERE id = ?', org.id), tpl);
      }
      try { B.postMonthlyFees(org); } catch (e) { console.error(`Monthly fees for org ${org.id}:`, e.message); }
    }
  } catch (e) {
    console.error('Scheduler error:', e);
  } finally {
    running = false;
  }
}

function start() {
  setTimeout(tick, 2000).unref();
  setInterval(tick, 3600e3).unref();
}

module.exports = { start, tick, runTemplate };
