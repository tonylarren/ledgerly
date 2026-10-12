'use strict';
// Minimal PDF writer (no dependencies) using the built-in Helvetica fonts with WinAnsi encoding,
// plus the invoice layout used for downloads and email attachments.

// Helvetica / Helvetica-Bold advance widths (1/1000 em) for ASCII 32..126 from the standard AFM metrics.
const W_REG = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const W_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

// Unicode → WinAnsi (cp1252) byte. Unsupported characters become '?'.
const CP1252 = { 0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e,
  0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
  0x202f: 0x20, 0x2009: 0x20, 0x2007: 0x20, 0x00a0: 0x20, 0x2212: 0x2d, 0x2192: 0x3e };
function encode(str) {
  const out = [];
  for (const ch of String(str ?? '')) {
    const c = ch.codePointAt(0);
    if (CP1252[c] !== undefined) out.push(CP1252[c]);
    else if (c >= 32 && c < 127) out.push(c);
    else if (c >= 0xa0 && c <= 0xff) out.push(c);
    else if (c === 9) out.push(32);
    else out.push(63);
  }
  return Buffer.from(out);
}
function widthOf(str, size, bold) {
  const table = bold ? W_BOLD : W_REG;
  let w = 0;
  for (const b of encode(str)) w += b >= 32 && b <= 126 ? table[b - 32] : 556;
  return (w * size) / 1000;
}
const esc = (buf) => buf.toString('latin1').replace(/[\\()]/g, (m) => '\\' + m).replace(/\r|\n/g, ' ');
const hex = (c) => { const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c || '#000000'); return m ? m.slice(1).map((x) => (parseInt(x, 16) / 255).toFixed(3)).join(' ') : '0 0 0'; };

class Pdf {
  constructor({ width = 595.28, height = 841.89 } = {}) { this.w = width; this.h = height; this.pages = []; this.addPage(); }
  addPage() { this.ops = []; this.pages.push(this.ops); return this; }
  text(x, y, s, { size = 10, bold = false, color = '#161a20', align = 'left' } = {}) {
    const w = widthOf(s, size, bold);
    const tx = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    this.ops.push(`BT ${hex(color)} rg /${bold ? 'F2' : 'F1'} ${size} Tf ${tx.toFixed(2)} ${(this.h - y).toFixed(2)} Td (${esc(encode(s))}) Tj ET`);
    return w;
  }
  line(x1, y1, x2, y2, { width = 0.5, color = '#e5e7eb' } = {}) {
    this.ops.push(`${hex(color)} RG ${width} w ${x1.toFixed(2)} ${(this.h - y1).toFixed(2)} m ${x2.toFixed(2)} ${(this.h - y2).toFixed(2)} l S`);
  }
  rect(x, y, w, h, { fill = '#f3f4f6' } = {}) { this.ops.push(`${hex(fill)} rg ${x.toFixed(2)} ${(this.h - y - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`); }
  wrap(s, maxWidth, size, bold) {
    const lines = [];
    for (const para of String(s ?? '').split(/\r?\n/)) {
      let cur = '';
      for (const word of para.split(/\s+/)) {
        const next = cur ? cur + ' ' + word : word;
        if (widthOf(next, size, bold) <= maxWidth || !cur) cur = next; else { lines.push(cur); cur = word; }
      }
      lines.push(cur);
    }
    return lines;
  }
  toBuffer() {
    const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
    const offsets = [];
    let size = chunks[0].length;
    const obj = (n, body) => { offsets[n] = size; const b = Buffer.concat([Buffer.from(`${n} 0 obj\n`), Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'), Buffer.from('\nendobj\n')]); chunks.push(b); size += b.length; };
    const n = this.pages.length;
    const pageIds = this.pages.map((_, i) => 5 + i * 2);
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, `<< /Type /Pages /Kids [${pageIds.map((id) => id + ' 0 R').join(' ')}] /Count ${n} >>`);
    obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    obj(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    this.pages.forEach((ops, i) => {
      const content = Buffer.from(ops.join('\n'), 'latin1');
      obj(pageIds[i], `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${this.w} ${this.h}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageIds[i] + 1} 0 R >>`);
      obj(pageIds[i] + 1, Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from('\nendstream')]));
    });
    const total = 5 + n * 2;
    const xrefAt = size;
    let xref = `xref\n0 ${total}\n0000000000 65535 f \n`;
    for (let i = 1; i < total; i++) xref += `${String(offsets[i] || 0).padStart(10, '0')} 00000 n \n`;
    xref += `trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
    chunks.push(Buffer.from(xref, 'latin1'));
    return Buffer.concat(chunks);
  }
}

// ---------- invoice layout ----------
function fmtMoney(c, cur, locale) {
  try { return new Intl.NumberFormat(locale || 'en-US', { style: 'currency', currency: cur }).format((c || 0) / 100); }
  catch { return `${((c || 0) / 100).toFixed(2)} ${cur}`; }
}
function fmtDate(d, locale) {
  try { return new Date(d + 'T00:00:00Z').toLocaleDateString(locale || 'en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }); }
  catch { return d; }
}

function invoicePdf(doc, org) {
  const pdf = new Pdf();
  const cur = doc.currency || org.currency, loc = org.locale;
  const m = (c) => fmtMoney(c, cur, loc);
  const M = 48, R = pdf.w - M, ACCENT = '#0f766e', MUTED = '#6b7280';
  const isInv = doc.kind === 'invoice';
  let y = 64;
  pdf.text(M, y, isInv ? 'INVOICE' : 'BILL', { size: 24, bold: true, color: ACCENT });
  const meta = [['Number', doc.number], ['Issue date', fmtDate(doc.issue_date, loc)], ['Due date', fmtDate(doc.due_date, loc)], ...(doc.reference ? [['Reference', doc.reference]] : []), ...(cur !== org.currency ? [['Currency', cur]] : [])];
  meta.forEach(([k, v], i) => { pdf.text(R - 120, 52 + i * 14, k, { size: 9, color: MUTED, align: 'right' }); pdf.text(R, 52 + i * 14, v, { size: 9, bold: k === 'Number', align: 'right' }); });
  y = 96;
  const issuer = [org.legal_name || org.name, ...String(org.address || '').split(/\r?\n/), org.email, org.phone, org.tax_id && `Tax ID: ${org.tax_id}`].filter(Boolean);
  const party = [doc.contact_name, ...String(doc.contact_address || '').split(/\r?\n/), doc.contact_email, doc.contact_tax_id && `Tax ID: ${doc.contact_tax_id}`].filter(Boolean);
  const [left, right] = isInv ? [issuer, party] : [party, issuer];
  left.forEach((l, i) => pdf.text(M, y + i * 13, l, { size: i ? 9 : 11, bold: !i, color: i ? '#374151' : '#161a20' }));
  y = Math.max(y + left.length * 13, 96 + Math.max(meta.length * 14 - 30, 0)) + 22;
  pdf.text(M, y, isInv ? 'BILL TO' : 'BILLED BY', { size: 8, bold: true, color: MUTED });
  pdf.text(R, y, 'AMOUNT DUE', { size: 8, bold: true, color: MUTED, align: 'right' });
  right.forEach((l, i) => pdf.text(M, y + 15 + i * 13, l, { size: i ? 9 : 11, bold: !i, color: i ? '#374151' : '#161a20' }));
  pdf.text(R, y + 22, m(doc.status === 'void' ? 0 : doc.total - doc.amount_paid), { size: 18, bold: true, align: 'right' });
  y += 22 + right.length * 13 + 20;

  const cols = { desc: M, qty: R - 250, price: R - 170, tax: R - 95, amt: R };
  const header = () => {
    pdf.rect(M, y - 12, R - M, 20, { fill: '#f3f4f6' });
    pdf.text(cols.desc + 6, y + 1, 'DESCRIPTION', { size: 8, bold: true, color: MUTED });
    pdf.text(cols.qty, y + 1, 'QTY', { size: 8, bold: true, color: MUTED, align: 'right' });
    pdf.text(cols.price, y + 1, 'UNIT PRICE', { size: 8, bold: true, color: MUTED, align: 'right' });
    pdf.text(cols.tax, y + 1, 'TAX', { size: 8, bold: true, color: MUTED, align: 'right' });
    pdf.text(cols.amt - 6, y + 1, 'AMOUNT', { size: 8, bold: true, color: MUTED, align: 'right' });
    y += 24;
  };
  header();
  for (const it of doc.items) {
    const desc = pdf.wrap(it.description, cols.qty - 50 - cols.desc, 9.5, false);
    const h = desc.length * 12 + 8;
    if (y + h > pdf.h - 140) { pdf.addPage(); y = 60; header(); }
    desc.forEach((l, i) => pdf.text(cols.desc + 6, y + i * 12, l, { size: 9.5 }));
    pdf.text(cols.qty, y, String(+it.quantity), { size: 9.5, align: 'right' });
    pdf.text(cols.price, y, m(it.unit_price), { size: 9.5, align: 'right' });
    pdf.text(cols.tax, y, `${+it.tax_rate}%`, { size: 9.5, align: 'right' });
    pdf.text(cols.amt - 6, y, m(Math.round(it.quantity * it.unit_price)), { size: 9.5, align: 'right' });
    y += h;
    pdf.line(M, y - 9, R, y - 9);
  }
  if (y > pdf.h - 160) { pdf.addPage(); y = 60; }
  y += 8;
  const tot = [['Subtotal', m(doc.subtotal)], ['Tax', m(doc.tax)]];
  for (const [k, v] of tot) { pdf.text(R - 200, y, k, { size: 10, color: MUTED }); pdf.text(R - 6, y, v, { size: 10, align: 'right' }); y += 16; }
  pdf.line(R - 200, y - 8, R, y - 8, { width: 1.2, color: '#161a20' });
  y += 6;
  pdf.text(R - 200, y, 'Total', { size: 12, bold: true }); pdf.text(R - 6, y, m(doc.total), { size: 12, bold: true, align: 'right' });
  y += 18;
  if (doc.amount_paid) {
    pdf.text(R - 200, y, 'Paid', { size: 10, color: MUTED }); pdf.text(R - 6, y, '- ' + m(doc.amount_paid), { size: 10, align: 'right' }); y += 16;
    pdf.text(R - 200, y, 'Balance due', { size: 10, bold: true }); pdf.text(R - 6, y, m(doc.total - doc.amount_paid), { size: 10, bold: true, align: 'right' }); y += 16;
  }
  const foot = [doc.notes, isInv ? org.invoice_footer : null].filter(Boolean).join('\n\n');
  if (foot) {
    y += 24;
    for (const l of pdf.wrap(foot, R - M, 9, false)) { if (y > pdf.h - 50) { pdf.addPage(); y = 60; } pdf.text(M, y, l, { size: 9, color: MUTED }); y += 12; }
  }
  pdf.pages.forEach((ops, i) => { pdf.ops = ops; pdf.text(pdf.w / 2, pdf.h - 28, `${org.name} · ${doc.number} · page ${i + 1} of ${pdf.pages.length}`, { size: 7.5, color: '#9ca3af', align: 'center' }); });
  return pdf.toBuffer();
}

module.exports = { Pdf, encode, widthOf, invoicePdf, fmtMoney, fmtDate };
