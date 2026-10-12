'use strict';
// Dependency-free SMTP client (implicit TLS, STARTTLS or plain) with AUTH PLAIN/LOGIN and MIME building.
const net = require('node:net');
const tls = require('node:tls');
const os = require('node:os');
const crypto = require('node:crypto');

class MailError extends Error { constructor(msg) { super(msg); this.status = 502; } }

const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;
function parseAddresses(input) {
  const list = (Array.isArray(input) ? input : String(input || '').split(/[,;]/)).map((s) => String(s).trim()).filter(Boolean);
  return list.map((s) => {
    if (/[\r\n]/.test(s)) throw new MailError('Invalid email address');
    const m = /^(.*)<([^>]+)>$/.exec(s);
    const email = (m ? m[2] : s).trim(), name = m ? m[1].trim().replace(/^"|"$/g, '') : '';
    if (!EMAIL_RE.test(email)) { const e = new MailError(`Invalid email address: ${email}`); e.status = 400; throw e; }
    return { name, email };
  });
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const wrap76 = (s) => s.replace(/.{1,76}/g, '$&\r\n');
const encodeWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const fmtAddr = ({ name, email }) => (name ? `${/^[\w .-]*$/.test(name) ? `"${name}"` : encodeWord(name)} <${email}>` : email);
const clean = (s) => String(s || '').replace(/[\r\n]+/g, ' ');

function buildMessage({ from, to, cc = [], subject, text, html, attachments = [] }) {
  const mixed = 'ldg_m_' + crypto.randomBytes(8).toString('hex'), alt = 'ldg_a_' + crypto.randomBytes(8).toString('hex');
  const domain = (from.email.split('@')[1] || 'localhost').replace(/[^\w.-]/g, '');
  const headers = [
    `From: ${fmtAddr(from)}`, `To: ${to.map(fmtAddr).join(', ')}`, ...(cc.length ? [`Cc: ${cc.map(fmtAddr).join(', ')}`] : []),
    `Subject: ${encodeWord(clean(subject))}`, `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`, 'MIME-Version: 1.0', 'X-Mailer: Ledgerly',
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
  ];
  const parts = [
    `--${mixed}`, `Content-Type: multipart/alternative; boundary="${alt}"`, '',
    `--${alt}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', wrap76(b64(text || '')),
    ...(html ? [`--${alt}`, 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', wrap76(b64(html))] : []),
    `--${alt}--`,
  ];
  for (const a of attachments) {
    const fname = clean(a.filename).replace(/"/g, '');
    parts.push(`--${mixed}`, `Content-Type: ${a.contentType || 'application/octet-stream'}; name="${fname}"`,
      `Content-Disposition: attachment; filename="${fname}"`, 'Content-Transfer-Encoding: base64', '', wrap76(Buffer.from(a.content).toString('base64')));
  }
  parts.push(`--${mixed}--`, '');
  return headers.join('\r\n') + '\r\n\r\n' + parts.join('\r\n');
}

// Line-oriented SMTP response reader.
function reader(socket) {
  let buf = '';
  const waiting = [], ready = [];
  let failure = null;
  const flush = () => {
    for (;;) {
      const lines = buf.split('\r\n');
      let end = -1;
      for (let i = 0; i < lines.length - 1; i++) if (/^\d{3} /.test(lines[i]) || /^\d{3}$/.test(lines[i])) { end = i; break; }
      if (end < 0) return;
      const resp = lines.slice(0, end + 1);
      buf = lines.slice(end + 1).join('\r\n');
      const r = { code: +resp[end].slice(0, 3), text: resp.map((l) => l.slice(4)).join('\n') };
      if (waiting.length) waiting.shift().resolve(r); else ready.push(r);
    }
  };
  const onData = (d) => { buf += d.toString('utf8'); flush(); };
  const onErr = (e) => { failure = e; while (waiting.length) waiting.shift().reject(e); };
  socket.on('data', onData);
  socket.on('error', onErr);
  socket.on('close', () => onErr(new MailError('SMTP connection closed unexpectedly')));
  return {
    next: () => (ready.length ? Promise.resolve(ready.shift()) : failure ? Promise.reject(failure) : new Promise((resolve, reject) => waiting.push({ resolve, reject }))),
    detach: () => { socket.off('data', onData); socket.removeAllListeners('error'); socket.removeAllListeners('close'); socket.on('error', () => {}); },
  };
}

async function sendMail(cfg, msg) {
  try {
    return await deliver(cfg, msg);
  } catch (e) {
    if (e.status) throw e;
    throw new MailError(`Could not send email: ${e.message}`); // network / TLS failures
  }
}

async function deliver(cfg, msg) {
  const host = cfg.host, secure = cfg.secure || 'starttls';
  if (!host) throw new MailError('SMTP is not configured. Set it up in Settings → Email.');
  const port = +cfg.port || (secure === 'tls' ? 465 : secure === 'starttls' ? 587 : 25);
  const from = parseAddresses(msg.from)[0];
  const to = parseAddresses(msg.to), cc = parseAddresses(msg.cc || []);
  if (!to.length) { const e = new MailError('Add at least one recipient'); e.status = 400; throw e; }
  const data = buildMessage({ ...msg, from: { ...from, name: msg.fromName || from.name }, to, cc });

  const connect = () => new Promise((resolve, reject) => {
    const s = secure === 'tls' ? tls.connect({ host, port, servername: host, rejectUnauthorized: !cfg.allowSelfSigned }) : net.connect({ host, port });
    s.setTimeout(cfg.timeout || 20000, () => s.destroy(new MailError('SMTP connection timed out')));
    s.once(secure === 'tls' ? 'secureConnect' : 'connect', () => resolve(s));
    s.once('error', reject);
  });
  let socket = await connect();
  let rd = reader(socket);
  const expect = async (codes, what) => {
    const r = await rd.next();
    if (!codes.includes(r.code)) throw new MailError(`SMTP ${what} failed: ${r.code} ${r.text}`);
    return r;
  };
  const cmd = (line, codes, what = line.split(' ')[0]) => { socket.write(line + '\r\n'); return expect(codes, what); };
  try {
    await expect([220], 'greeting');
    const helo = os.hostname().replace(/[^\w.-]/g, '') || 'localhost';
    let ehlo = await cmd(`EHLO ${helo}`, [250]);
    if (secure === 'starttls') {
      if (!/STARTTLS/i.test(ehlo.text)) throw new MailError('Server does not support STARTTLS — choose another security mode');
      await cmd('STARTTLS', [220]);
      rd.detach();
      socket = await new Promise((resolve, reject) => {
        const t = tls.connect({ socket, servername: host, rejectUnauthorized: !cfg.allowSelfSigned }, () => resolve(t));
        t.once('error', reject);
      });
      rd = reader(socket);
      ehlo = await cmd(`EHLO ${helo}`, [250]);
    }
    if (cfg.user) {
      if (/AUTH[ =][^\n]*PLAIN/i.test(ehlo.text) || !/AUTH[ =][^\n]*LOGIN/i.test(ehlo.text)) {
        await cmd(`AUTH PLAIN ${b64(`\0${cfg.user}\0${cfg.pass || ''}`)}`, [235], 'AUTH');
      } else {
        await cmd('AUTH LOGIN', [334], 'AUTH');
        await cmd(b64(cfg.user), [334], 'AUTH');
        await cmd(b64(cfg.pass || ''), [235], 'AUTH');
      }
    }
    await cmd(`MAIL FROM:<${from.email}>`, [250], 'MAIL FROM');
    for (const r of [...to, ...cc]) await cmd(`RCPT TO:<${r.email}>`, [250, 251], 'RCPT TO');
    await cmd('DATA', [354]);
    socket.write(data.replace(/\r\n\./g, '\r\n..') + '\r\n.\r\n');
    const done = await expect([250], 'message delivery');
    socket.write('QUIT\r\n');
    return { accepted: [...to, ...cc].map((r) => r.email), response: done.text };
  } finally {
    rd.detach();
    socket.end();
    socket.destroy();
  }
}

module.exports = { sendMail, buildMessage, parseAddresses, MailError };
