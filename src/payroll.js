'use strict';
// Payroll calculation schemes and posting.
//  - "flat": per-employee flat percentages (works anywhere).
//  - "madagascar": CNaPS, health organisation (OSTIE/SMIE), FMFP and progressive IRSA.
// All money is cents of the organisation's base currency. Madagascar parameters are in Ariary.
const { all, get, run, ensureAccount } = require('./db');
const L = require('./ledger');
const { bad } = L;

// Defaults verified October 2026 — rates change by decree / finance law, so they are editable per organisation.
//  CNaPS 13% employer / 1% employee, health org (OSTIE) 5% / 1%, both capped at 8 × SME.
//  FMFP 1% employer, uncapped. IRSA LFI 2026: 0/5/10/15/20% up to 4,000,000 Ar, then 25%;
//  minimum 3,000 Ar; 2,000 Ar reduction per dependant; base rounded down to 100 Ar.
//  SME (general regime): 262,680 Ar (03/2024), 300,000 Ar (03/2026), 315,000 Ar (10/2026).
const MG_DEFAULTS = Object.freeze({
  health_name: 'OSTIE',
  cnaps_employee: 1, cnaps_employer: 13,
  health_employee: 1, health_employer: 5,
  fmfp_employer: 1,
  ceiling_multiplier: 8,
  sme_history: [{ from: '2024-03-01', amount: 262680 }, { from: '2026-03-01', amount: 300000 }, { from: '2026-10-01', amount: 315000 }],
  irsa_brackets: [{ upto: 350000, rate: 0 }, { upto: 400000, rate: 5 }, { upto: 500000, rate: 10 }, { upto: 600000, rate: 15 }, { upto: 4000000, rate: 20 }, { upto: null, rate: 25 }],
  irsa_minimum: 3000, irsa_dependent_reduction: 2000, irsa_base_rounding: 100,
  standard_hours: 173.33,
});

function mgConfig(org) {
  let c = {};
  try { c = org.payroll_config ? JSON.parse(org.payroll_config) : {}; } catch { c = {}; }
  return { ...MG_DEFAULTS, ...c };
}

function validateMgConfig(c) {
  const n = (v, name) => { const x = Number(v); if (!Number.isFinite(x) || x < 0) throw bad(`${name} must be a positive number`); return x; };
  const out = {
    health_name: String(c.health_name || 'OSTIE').slice(0, 40),
    cnaps_employee: n(c.cnaps_employee, 'CNaPS employee rate'), cnaps_employer: n(c.cnaps_employer, 'CNaPS employer rate'),
    health_employee: n(c.health_employee, 'Health employee rate'), health_employer: n(c.health_employer, 'Health employer rate'),
    fmfp_employer: n(c.fmfp_employer, 'FMFP rate'), ceiling_multiplier: n(c.ceiling_multiplier, 'Ceiling multiplier'),
    irsa_minimum: n(c.irsa_minimum, 'IRSA minimum'), irsa_dependent_reduction: n(c.irsa_dependent_reduction, 'Dependant reduction'),
    irsa_base_rounding: Math.max(1, n(c.irsa_base_rounding || 1, 'Rounding')), standard_hours: n(c.standard_hours || 173.33, 'Standard hours'),
    sme_history: (c.sme_history || []).filter((s) => s && s.from).map((s) => ({ from: String(s.from).slice(0, 10), amount: n(s.amount, 'SME') })).sort((a, b) => a.from.localeCompare(b.from)),
    irsa_brackets: (c.irsa_brackets || []).map((b) => ({ upto: b.upto === null || b.upto === '' || b.upto === undefined ? null : n(b.upto, 'Bracket limit'), rate: n(b.rate, 'Bracket rate') })),
  };
  if (!out.sme_history.length) throw bad('Add at least one minimum wage (SME) value');
  if (!out.irsa_brackets.length) throw bad('Add at least one IRSA bracket');
  const finite = out.irsa_brackets.filter((b) => b.upto !== null);
  if (finite.some((b, i) => i && b.upto <= finite[i - 1].upto)) throw bad('IRSA brackets must be in increasing order');
  out.irsa_brackets = [...finite, { upto: null, rate: (out.irsa_brackets.find((b) => b.upto === null) || finite[finite.length - 1]).rate }];
  return out;
}

const smeOn = (cfg, date) => { let v = cfg.sme_history[0].amount; for (const s of cfg.sme_history) if (s.from <= date) v = s.amount; return v; };

// Progressive tax in whole Ariary.
function irsaTax(cfg, taxableAr) {
  let tax = 0, lower = 0;
  for (const b of cfg.irsa_brackets) {
    const upper = b.upto == null ? Infinity : b.upto;
    if (taxableAr > lower) tax += ((Math.min(taxableAr, upper) - lower) * b.rate) / 100;
    lower = upper;
    if (taxableAr <= upper) break;
  }
  return Math.round(tax);
}

const pct = (v, r) => Math.round((v * r) / 100);

function computeFlat(emp, gross, other) {
  const income_tax = pct(gross, emp.income_tax_rate), social = pct(gross, emp.social_rate), employer_cost = pct(gross, emp.employer_rate);
  return { income_tax, social, other_deductions: other, employer_cost, net: gross - income_tax - social - other, details: null };
}

function computeMadagascar(cfg, emp, gross, other, periodEnd) {
  const sme = smeOn(cfg, periodEnd);
  const ceiling = Math.round(sme * cfg.ceiling_multiplier * 100); // cents
  const capped = Math.min(gross, ceiling);
  const cnapsEe = pct(capped, cfg.cnaps_employee), cnapsEr = pct(capped, cfg.cnaps_employer);
  const healthEe = pct(capped, cfg.health_employee), healthEr = pct(capped, cfg.health_employer);
  const fmfpEr = pct(gross, cfg.fmfp_employer);
  const taxable = Math.max(0, gross - cnapsEe - healthEe);
  const taxableAr = Math.floor(taxable / 100 / cfg.irsa_base_rounding) * cfg.irsa_base_rounding;
  const gross_tax = irsaTax(cfg, taxableAr);
  const deps = Math.max(0, emp.dependents | 0);
  const irsaAr = Math.max(cfg.irsa_minimum, gross_tax - deps * cfg.irsa_dependent_reduction);
  const irsa = irsaAr * 100;
  const details = [
    { code: 'CNAPS', label: 'CNaPS', base: capped, employee_rate: cfg.cnaps_employee, employee: cnapsEe, employer_rate: cfg.cnaps_employer, employer: cnapsEr, liability: 'mg_cnaps' },
    { code: 'HEALTH', label: cfg.health_name, base: capped, employee_rate: cfg.health_employee, employee: healthEe, employer_rate: cfg.health_employer, employer: healthEr, liability: 'mg_health' },
    { code: 'FMFP', label: 'FMFP', base: gross, employee_rate: 0, employee: 0, employer_rate: cfg.fmfp_employer, employer: fmfpEr, liability: 'mg_fmfp' },
    { code: 'IRSA', label: 'IRSA', base: taxableAr * 100, employee: irsa, employer: 0, liability: 'mg_irsa',
      note: `Progressive tax ${gross_tax.toLocaleString('en-US')} Ar − ${deps} dependant(s) × ${cfg.irsa_dependent_reduction} Ar, minimum ${cfg.irsa_minimum} Ar` },
  ];
  return { income_tax: irsa, social: cnapsEe + healthEe, other_deductions: other, employer_cost: cnapsEr + healthEr + fmfpEr,
    net: gross - cnapsEe - healthEe - irsa - other, details, sme, ceiling };
}

function computePayslip(org, emp, { hours = 0, bonus = 0, other_deductions = null }, periodEnd) {
  const base = emp.pay_type === 'hourly' ? Math.round((+hours || 0) * emp.pay_rate) : emp.pay_rate;
  const b = Math.round(+bonus || 0);
  const gross = base + b;
  const other = other_deductions == null ? emp.fixed_deduction : Math.round(+other_deductions || 0);
  const r = org.payroll_scheme === 'madagascar' ? computeMadagascar(mgConfig(org), emp, gross, other, periodEnd) : computeFlat(emp, gross, other);
  return { hours: +hours || 0, base, bonus: b, gross, ...r };
}

const defaultHours = (org) => (org.payroll_scheme === 'madagascar' ? mgConfig(org).standard_hours : 160);

const MG_LIABILITIES = {
  mg_cnaps: ['2210', 'CNaPS payable'], mg_health: ['2220', 'Health organisation (OSTIE/SMIE) payable'],
  mg_irsa: ['2230', 'IRSA payable'], mg_fmfp: ['2240', 'FMFP payable'],
};

function postPayroll(org, runRow, userId) {
  const slips = all('SELECT * FROM payslips WHERE run_id = ?', runRow.id);
  if (!slips.length) throw bad('This payroll run has no payslips');
  const bank = L.assertAccount(org.id, runRow.bank_account_id || L.sysAccount(org.id, 'bank').id);
  if (bank.currency && bank.currency !== org.currency) throw bad(`Pay wages from an account in ${org.currency}`);
  const liab = new Map(); // account id -> amount
  const add = (acc, amt) => liab.set(acc, (liab.get(acc) || 0) + amt);
  const generic = L.sysAccount(org.id, 'payroll_liab').id;
  let gross = 0, employer = 0, net = 0;
  for (const s of slips) {
    gross += s.gross; employer += s.employer_cost; net += s.net;
    const details = s.details ? JSON.parse(s.details) : null;
    if (details) {
      for (const d of details) {
        const [code, name] = MG_LIABILITIES[d.liability] || [];
        const acc = code ? ensureAccount(org.id, d.liability, code, name, 'liability', 'current').id : generic;
        add(acc, (d.employee || 0) + (d.employer || 0));
      }
      if (s.other_deductions) add(generic, s.other_deductions);
    } else {
      add(generic, s.income_tax + s.social + s.other_deductions + s.employer_cost);
    }
  }
  L.postEntry(org.id, {
    date: runRow.pay_date, memo: `Payroll ${runRow.period_start} → ${runRow.period_end}`, ref_type: 'payroll', ref_id: runRow.id, userId,
    lines: [
      { account_id: L.sysAccount(org.id, 'wages').id, debit: gross, description: 'Gross wages' },
      { account_id: L.sysAccount(org.id, 'payroll_tax').id, debit: employer, description: 'Employer contributions' },
      ...[...liab].map(([acc, amt]) => ({ account_id: acc, credit: amt, description: 'Withholdings & contributions' })),
      { account_id: bank.id, credit: net, description: 'Net pay' },
    ],
  });
}

function insertSlip(runId, empId, s) {
  run(`INSERT INTO payslips (run_id, employee_id, hours, base, bonus, gross, income_tax, social, other_deductions, net, employer_cost, details) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    runId, empId, s.hours, s.base, s.bonus, s.gross, s.income_tax, s.social, s.other_deductions, s.net, s.employer_cost, s.details ? JSON.stringify(s.details) : null);
}
function updateSlip(id, s) {
  run(`UPDATE payslips SET hours=?, base=?, bonus=?, gross=?, income_tax=?, social=?, other_deductions=?, net=?, employer_cost=?, details=? WHERE id = ?`,
    s.hours, s.base, s.bonus, s.gross, s.income_tax, s.social, s.other_deductions, s.net, s.employer_cost, s.details ? JSON.stringify(s.details) : null, id);
}

// Contributions report for declarations (CNaPS DNS, health org, IRSA, FMFP) over posted runs.
function taxReport(orgId, from, to) {
  const slips = all(`SELECT p.*, e.name, e.cnaps_number, e.tax_number, r.pay_date, r.period_start, r.period_end FROM payslips p
    JOIN payroll_runs r ON r.id = p.run_id JOIN employees e ON e.id = p.employee_id
    WHERE r.org_id = ? AND r.status = 'posted' AND r.pay_date BETWEEN ? AND ? ORDER BY e.name, r.pay_date`, orgId, from, to);
  const totals = new Map();
  const employees = new Map();
  for (const s of slips) {
    const details = s.details ? JSON.parse(s.details) : [
      { code: 'TAX', label: 'Income tax withheld', base: s.gross, employee: s.income_tax, employer: 0 },
      { code: 'SOCIAL', label: 'Social contributions', base: s.gross, employee: s.social, employer: s.employer_cost },
    ];
    const emp = employees.get(s.employee_id) || { name: s.name, cnaps_number: s.cnaps_number, tax_number: s.tax_number, gross: 0, net: 0, lines: {} };
    emp.gross += s.gross; emp.net += s.net;
    for (const d of details) {
      const t = totals.get(d.code) || { code: d.code, label: d.label, base: 0, employee: 0, employer: 0 };
      t.base += d.base || 0; t.employee += d.employee || 0; t.employer += d.employer || 0;
      totals.set(d.code, t);
      const l = emp.lines[d.code] || { base: 0, employee: 0, employer: 0 };
      l.base += d.base || 0; l.employee += d.employee || 0; l.employer += d.employer || 0;
      emp.lines[d.code] = l;
    }
    employees.set(s.employee_id, emp);
  }
  const lines = [...totals.values()].map((t) => ({ ...t, total: t.employee + t.employer }));
  return { from, to, lines, employees: [...employees.values()], total: lines.reduce((s, l) => s + l.total, 0), gross: slips.reduce((s, x) => s + x.gross, 0) };
}

module.exports = { MG_DEFAULTS, mgConfig, validateMgConfig, irsaTax, smeOn, computePayslip, defaultHours, postPayroll, insertSlip, updateSlip, taxReport };
