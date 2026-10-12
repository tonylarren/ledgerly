'use strict';
// Multi-currency support. The ledger is always kept in the organisation's base currency;
// documents, payments and bank accounts may be in another currency and are converted with
// a rate expressed as "base units per 1 unit of foreign currency".
const { all, get, run } = require('./db');

const KNOWN = {
  USD: { name: 'US Dollar', symbol: '$' },
  EUR: { name: 'Euro', symbol: '€' },
  MGA: { name: 'Malagasy Ariary', symbol: 'Ar' },
};

class RateError extends Error { constructor(msg) { super(msg); this.status = 400; } }

function orgCurrencies(org) {
  const extra = String(org.currencies || '').split(',').map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z]{3}$/.test(c));
  return [...new Set([org.currency, ...extra])];
}

function normalize(org, currency) {
  const c = String(currency || org.currency).toUpperCase();
  if (!orgCurrencies(org).includes(c)) throw new RateError(`Currency ${c} is not enabled for this organisation`);
  return c;
}

// Latest rate on or before `date`; falls back to the earliest later rate so back-dated entries still work.
function findRate(orgId, currency, date) {
  return get('SELECT rate, date FROM exchange_rates WHERE org_id = ? AND currency = ? AND date <= ? ORDER BY date DESC LIMIT 1', orgId, currency, date)
    || get('SELECT rate, date FROM exchange_rates WHERE org_id = ? AND currency = ? ORDER BY date ASC LIMIT 1', orgId, currency);
}

function rateFor(org, currency, date, override) {
  const c = normalize(org, currency);
  if (c === org.currency) return 1;
  if (override !== undefined && override !== null && override !== '') {
    const r = Number(override);
    if (!(r > 0) || !Number.isFinite(r)) throw new RateError('Exchange rate must be a positive number');
    return r;
  }
  const row = findRate(org.id, c, date);
  if (!row) throw new RateError(`No exchange rate for ${c}. Add one in Settings → Currencies.`);
  return row.rate;
}

const toBase = (amount, rate) => Math.round(amount * rate);

function setRate(orgId, currency, date, rate, source = 'manual') {
  run(`INSERT INTO exchange_rates (org_id, currency, date, rate, source) VALUES (?,?,?,?,?)
    ON CONFLICT(org_id, currency, date) DO UPDATE SET rate = excluded.rate, source = excluded.source`, orgId, currency, date, rate, source);
}

// Optional online refresh from a free, key-less API. Only called when a user presses the button.
async function fetchLatestRates(org) {
  const targets = orgCurrencies(org).filter((c) => c !== org.currency);
  if (!targets.length) return [];
  const res = await fetch(`https://open.er-api.com/v6/latest/${encodeURIComponent(org.currency)}`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new RateError(`Rate service responded ${res.status}`);
  const j = await res.json();
  if (j.result !== 'success' || !j.rates) throw new RateError('Rate service returned no data');
  const date = new Date().toISOString().slice(0, 10);
  const out = [];
  for (const c of targets) {
    const perBase = j.rates[c];
    if (!(perBase > 0)) continue;
    const rate = 1 / perBase;
    setRate(org.id, c, date, rate, 'open.er-api.com');
    out.push({ currency: c, date, rate });
  }
  return out;
}

function listRates(orgId) {
  return all('SELECT * FROM exchange_rates WHERE org_id = ? ORDER BY currency, date DESC', orgId);
}

module.exports = { KNOWN, orgCurrencies, normalize, rateFor, toBase, setRate, findRate, fetchLatestRates, listRates };
