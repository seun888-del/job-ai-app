/**
 * userGmail.js (main process): "Connect Gmail" for Job Bank email applications.
 * Google's installed-app flow: PKCE + a one-time local loopback server, the browser opens the
 * Google consent page, Google redirects back to 127.0.0.1 with a code, which is exchanged for a
 * refresh token. Scopes: gmail.send (send only, cannot read mail) + email (to show the address).
 * The refresh token is stored with the OS's own encryption (safeStorage) as credential 'gmail'.
 */
const http = require('http');
const crypto = require('crypto');
const { shell, safeStorage } = require('electron');
const db = require('../db/database');
const { getClient } = require('../../bot/modules/gmail_send');

const SCOPES = 'openid email https://www.googleapis.com/auth/gmail.send';
const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function status() {
  const row = db.getCredential('gmail');
  return row && row.secret_enc ? { connected: true, email: row.username } : { connected: false };
}

function disconnect() {
  try { db.deleteCredential ? db.deleteCredential('gmail') : db.saveCredential({ site: 'gmail', username: '', secret_enc: '' }); } catch (_) {}
  return status();
}

// For the Job Bank agent's process only.
function envForBot() {
  const row = db.getCredential('gmail');
  if (!row || !row.secret_enc || !safeStorage.isEncryptionAvailable()) return {};
  try { return { JOBBOT_GMAIL_REFRESH: safeStorage.decryptString(Buffer.from(row.secret_enc, 'base64')), JOBBOT_GMAIL_USER: row.username }; }
  catch (_) { return {}; }
}

async function connect() {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('This computer cannot store the Gmail connection securely.');
  const client = await getClient();
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));

  const { code, redirectUri } = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/oauth2callback') { res.writeHead(404); res.end(); return; }
      const ok = u.searchParams.get('state') === state && u.searchParams.get('code');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<html><body style="font-family:sans-serif;padding:40px"><h2>${ok ? 'Gmail connected' : 'Gmail was not connected'}</h2><p>You can close this tab and go back to Job-AI.</p></body></html>`);
      clearTimeout(timer); server.close();
      if (ok) resolve({ code: u.searchParams.get('code'), redirectUri: `http://127.0.0.1:${server.address() ? server.address().port : port}/oauth2callback` });
      else reject(new Error(u.searchParams.get('error') === 'access_denied' ? 'You did not allow Job-AI to send from Gmail.' : 'Gmail sign-in did not finish.'));
    });
    let port = 0;
    const timer = setTimeout(() => { server.close(); reject(new Error('Gmail sign-in timed out. Try again.')); }, 5 * 60 * 1000);
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      const redirect = `http://127.0.0.1:${port}/oauth2callback`;
      const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
        client_id: client.client_id, redirect_uri: redirect, response_type: 'code', scope: SCOPES, access_type: 'offline', prompt: 'consent',
        code_challenge: challenge, code_challenge_method: 'S256', state,
      }).toString();
      shell.openExternal(url);
    });
  });

  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: client.client_id, client_secret: client.client_secret, code, code_verifier: verifier, redirect_uri: redirectUri, grant_type: 'authorization_code' }).toString() });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.refresh_token) throw new Error(`Gmail sign-in failed (${j.error || r.status})`);
  if (!String(j.scope || '').includes('gmail.send')) throw new Error('Please tick "Send email on your behalf" on the Google page, then try again.');
  // The address it will send from (the id token carries it; scope "email").
  let email = '';
  try { email = JSON.parse(Buffer.from(String(j.id_token || '').split('.')[1] || '', 'base64').toString()).email || ''; } catch (_) {}
  if (!email) throw new Error('Could not read your Gmail address. Try again.');
  db.saveCredential({ site: 'gmail', username: email, secret_enc: safeStorage.encryptString(j.refresh_token).toString('base64') });
  return status();
}

module.exports = { connect, disconnect, status, envForBot };
