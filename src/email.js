'use strict';
// Invoice emailing: SMTP settings resolution, templates, HTML body, PDF attachment, delivery log.
const { run } = require('./db');
const { sendMail } = require('./mailer');
const { invoicePdf, fmtMoney, fmtDate } = require('./pdf');

const DEFAULT_SUBJECT = 'Invoice {number} from {company}';
const DEFAULT_BODY = 'Hello {customer},\n\nPlease find attached invoice {number} for {total}, due on {due_date}.\n\nThank you for your business.\n\n{company}';

// Per-organisation SMTP settings, falling back to instance-wide SMTP_* environment variables.
function smtpConfig(org) {
  const env = process.env;
  const host = org.smtp_host || env.SMTP_HOST;
  return {
    host, port: org.smtp_host ? org.smtp_port : env.SMTP_PORT,
    secure: (org.smtp_host ? org.smtp_secure : env.SMTP_SECURE) || 'starttls',
    user: org.smtp_host ? org.smtp_user : env.SMTP_USER, pass: org.smtp_host ? org.smtp_pass : env.SMTP_PASS,
    from: org.smtp_from || env.SMTP_FROM || org.email,
    allowSelfSigned: env.SMTP_ALLOW_SELF_SIGNED === 'true',
  };
}
const configured = (org) => { const c = smtpConfig(org); return !!(c.host && c.from); };

function fill(template, doc, org) {
  const cur = doc.currency || org.currency;
  const vars = {
    number: doc.number, company: org.legal_name || org.name, customer: doc.contact_name || '',
    total: fmtMoney(doc.total, cur, org.locale), due: fmtMoney(doc.total - doc.amount_paid, cur, org.locale),
    due_date: fmtDate(doc.due_date, org.locale), issue_date: fmtDate(doc.issue_date, org.locale), reference: doc.reference || '',
  };
  return String(template || '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function invoiceHtml(doc, org, message) {
  const cur = doc.currency || org.currency, m = (c) => esc(fmtMoney(c, cur, org.locale));
  const td = 'padding:8px 10px;border-bottom:1px solid #e5e7eb;';
  return `<!doctype html><html><body style="margin:0;background:#f6f7f9;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#161a20">
<div style="max-width:640px;margin:0 auto;padding:24px">
  <div style="white-space:pre-line;font-size:14px;line-height:1.55;margin-bottom:20px">${esc(message)}</div>
  <div style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:24px">
    <table width="100%" style="border-collapse:collapse"><tr>
      <td><div style="font-size:22px;font-weight:700;color:#0f766e">INVOICE</div><div style="font-weight:600;margin-top:6px">${esc(org.legal_name || org.name)}</div></td>
      <td align="right" style="font-size:13px;color:#4b5563">No. <b style="color:#161a20">${esc(doc.number)}</b><br>Issued ${esc(fmtDate(doc.issue_date, org.locale))}<br>Due ${esc(fmtDate(doc.due_date, org.locale))}</td>
    </tr></table>
    <table width="100%" style="border-collapse:collapse;margin-top:20px;font-size:13px">
      <tr style="color:#6b7280;font-size:11px;text-transform:uppercase"><td style="${td}">Description</td><td style="${td}" align="right">Qty</td><td style="${td}" align="right">Price</td><td style="${td}" align="right">Amount</td></tr>
      ${doc.items.map((i) => `<tr><td style="${td}">${esc(i.description)}</td><td style="${td}" align="right">${+i.quantity}</td><td style="${td}" align="right">${m(i.unit_price)}</td><td style="${td}" align="right">${m(Math.round(i.quantity * i.unit_price))}</td></tr>`).join('')}
    </table>
    <table style="margin-left:auto;margin-top:12px;font-size:13px">
      <tr><td style="padding:3px 12px;color:#6b7280">Subtotal</td><td align="right">${m(doc.subtotal)}</td></tr>
      <tr><td style="padding:3px 12px;color:#6b7280">Tax</td><td align="right">${m(doc.tax)}</td></tr>
      <tr><td style="padding:6px 12px;font-weight:700;font-size:15px">Total</td><td align="right" style="font-weight:700;font-size:15px">${m(doc.total)}</td></tr>
      ${doc.amount_paid ? `<tr><td style="padding:3px 12px;font-weight:600">Balance due</td><td align="right" style="font-weight:600">${m(doc.total - doc.amount_paid)}</td></tr>` : ''}
    </table>
    ${org.invoice_footer ? `<div style="margin-top:20px;font-size:12px;color:#6b7280;white-space:pre-line">${esc(org.invoice_footer)}</div>` : ''}
  </div>
</div></body></html>`;
}

async function sendInvoice(org, doc, { to, cc, subject, message, attach_pdf = true }, userId) {
  const cfg = smtpConfig(org);
  subject = subject || fill(org.email_subject || DEFAULT_SUBJECT, doc, org);
  message = message || fill(org.email_body || DEFAULT_BODY, doc, org);
  to = to || doc.contact_email;
  try {
    if (!to) throw Object.assign(new Error(`${doc.contact_name || 'This customer'} has no email address`), { status: 400 });
    await sendMail(cfg, {
      from: cfg.from, fromName: org.legal_name || org.name, to, cc, subject, text: message, html: invoiceHtml(doc, org, message),
      attachments: attach_pdf ? [{ filename: `${doc.number}.pdf`, contentType: 'application/pdf', content: invoicePdf(doc, org) }] : [],
    });
    run('INSERT INTO email_log (org_id, document_id, user_id, to_addr, cc, subject, status) VALUES (?,?,?,?,?,?,?)', org.id, doc.id, userId, String(to), cc ? String(cc) : null, subject, 'sent');
    run(`UPDATE documents SET last_emailed_at = datetime('now') WHERE id = ?`, doc.id);
  } catch (e) {
    run('INSERT INTO email_log (org_id, document_id, user_id, to_addr, cc, subject, status, error) VALUES (?,?,?,?,?,?,?,?)', org.id, doc.id, userId, String(to || '—'), cc ? String(cc) : null, subject, 'failed', e.message);
    throw e;
  }
}

async function sendTest(org, to) {
  const cfg = smtpConfig(org);
  await sendMail(cfg, { from: cfg.from, fromName: org.legal_name || org.name, to, subject: `Ledgerly test email — ${org.name}`, text: 'Your SMTP settings work. Invoices can now be emailed from Ledgerly.' });
}

const draftFor = (org, doc) => ({ to: doc.contact_email || '', subject: fill(org.email_subject || DEFAULT_SUBJECT, doc, org), message: fill(org.email_body || DEFAULT_BODY, doc, org) });

module.exports = { smtpConfig, configured, sendInvoice, sendTest, draftFor, DEFAULT_SUBJECT, DEFAULT_BODY, invoiceHtml };
