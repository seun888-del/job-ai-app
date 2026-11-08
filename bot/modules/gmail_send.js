/**
 * gmail_send.js: send an email from the USER's own Gmail (Job Bank email applications).
 * The user connected Gmail once ("Connect Gmail", scope gmail.send). The app keeps their refresh
 * token encrypted and passes it to the Job Bank agent only (JOBBOT_GMAIL_REFRESH / _USER).
 * The OAuth client (Desktop type) comes from the licensed backend.
 */
const fs = require('fs');
const path = require('path');

const backendUrl = () => process.env.JOBBOT_BACKEND_URL || 'https://api.tryjobai.com';

async function getClient() {
  const r = await fetch(`${backendUrl()}/v1/gmail/client`, { headers: { Authorization: `Bearer ${process.env.JOBBOT_LICENSE_KEY || ''}` } });
  if (!r.ok) throw new Error(r.status === 503 ? 'Gmail sending is not set up yet on Job-AI' : `Could not reach Job-AI (${r.status})`);
  return r.json();
}

let _tok = null;
async function accessToken(refreshToken) {
  if (_tok && _tok.exp > Date.now() + 60000) return _tok.value;
  const c = await getClient();
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.client_id, client_secret: c.client_secret, refresh_token: refreshToken, grant_type: 'refresh_token' }).toString() });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    const e = new Error(j.error === 'invalid_grant' ? 'Gmail is no longer connected. Connect Gmail again in Job-AI.' : `Gmail sign-in failed (${j.error || r.status})`);
    e.gmailDisconnected = j.error === 'invalid_grant'; throw e;
  }
  _tok = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return _tok.value;
}

// Header values with non-ASCII text (names, accents) are RFC 2047 encoded.
const hdr = (s) => /[^\x20-\x7e]/.test(s) ? `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=` : s;
const b64lines = (buf) => buf.toString('base64').replace(/.{76}/g, '$&\r\n');

function buildMime({ from, fromName, to, subject, text, attachments = [] }) {
  const boundary = 'jobai_' + Math.random().toString(36).slice(2);
  const fromH = fromName ? `${hdr(fromName)} <${from}>` : from;
  const parts = [
    `From: ${fromH}`, `To: ${to}`, `Subject: ${hdr(subject)}`, 'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', b64lines(Buffer.from(text, 'utf8')),
  ];
  for (const a of attachments) {
    const name = a.filename || path.basename(a.path);
    parts.push(`--${boundary}`, `Content-Type: ${a.contentType || 'application/pdf'}; name="${hdr(name)}"`, 'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${hdr(name)}"`, '', b64lines(a.content || fs.readFileSync(a.path)));
  }
  parts.push(`--${boundary}--`, '');
  return parts.join('\r\n');
}

/** Send. Returns the Gmail message id. */
async function sendMail(opts) {
  const refresh = opts.refreshToken || process.env.JOBBOT_GMAIL_REFRESH;
  const from = opts.from || process.env.JOBBOT_GMAIL_USER;
  if (!refresh || !from) throw new Error('Gmail is not connected. Connect Gmail in Job-AI first.');
  const raw = Buffer.from(buildMime({ ...opts, from })).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken(refresh)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ raw }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Gmail did not send it (${(j.error && j.error.message) || r.status})`);
  return j.id;
}

module.exports = { sendMail, buildMime, getClient, accessToken };
