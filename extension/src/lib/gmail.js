// Send-only Gmail for the extension (the Job Bank agent emails applications from the user's own
// Gmail). Google sign-in through chrome.identity.launchWebAuthFlow with the "Job-AI Chrome
// extension" client (Job-AI Gmail project). Scope gmail.send only: Job-AI can send, it can't read
// the inbox. The short-lived access token is renewed silently (prompt=none); nothing else is kept.
const CLIENT_ID = '256221197082-lkukt3ma7rlmkpaf0g754tk1n2gil3cr.apps.googleusercontent.com';
const SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const KEY = 'gmail';

const redirectUri = () => chrome.identity.getRedirectURL();
async function saved() { return (await chrome.storage.local.get(KEY))[KEY] || null; }

async function authorize({ interactive, hint }) {
  const q = new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: redirectUri(), response_type: 'token',
    scope: `openid email ${SEND_SCOPE}`, include_granted_scopes: 'true',
    prompt: interactive ? 'select_account' : 'none',
  });
  if (hint) q.set('login_hint', hint);
  const back = await chrome.identity.launchWebAuthFlow({ url: `https://accounts.google.com/o/oauth2/v2/auth?${q}`, interactive });
  const p = new URLSearchParams(String(back || '').split('#')[1] || '');
  if (p.get('error')) throw new Error(p.get('error') === 'access_denied' ? 'Gmail was not connected.' : p.get('error'));
  const token = p.get('access_token');
  if (!token) throw new Error('Gmail was not connected.');
  if (!String(p.get('scope') || '').includes(SEND_SCOPE)) throw new Error('Tick "Send email on your behalf" on the Google screen, then try again.');
  return { token, exp: Date.now() + (Number(p.get('expires_in')) || 3600) * 1000 };
}

// Connect (or reconnect) from a button click. Returns { email }.
export async function connectGmail() {
  const t = await authorize({ interactive: true });
  const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${t.token}` } });
  const email = String(((await r.json().catch(() => ({}))).email) || '').toLowerCase();
  if (!email) throw new Error('Could not read which Gmail you picked.');
  await chrome.storage.local.set({ [KEY]: { email, token: t.token, exp: t.exp } });
  return { email };
}

export async function gmailStatus() { const g = await saved(); return g && g.email ? { connected: true, email: g.email } : { connected: false }; }

export async function disconnectGmail() {
  const g = await saved();
  if (g && g.token) fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(g.token)}`, { method: 'POST' }).catch(() => {});
  await chrome.storage.local.remove(KEY);
}

// A valid access token, renewed without a window while Google still has the user's consent.
async function accessToken() {
  const g = await saved();
  if (!g || !g.email) throw new Error('Connect Gmail on the Job Bank card first.');
  if (g.token && g.exp - Date.now() > 120000) return { token: g.token, email: g.email };
  let t;
  try { t = await authorize({ interactive: false, hint: g.email }); }
  catch (_) { throw new Error('Gmail needs reconnecting. Press Connect Gmail on the Job Bank card.'); }
  await chrome.storage.local.set({ [KEY]: { ...g, token: t.token, exp: t.exp } });
  return { token: t.token, email: g.email };
}

// ── MIME ─────────────────────────────────────────────────────────────────────
const utf8b64 = (s) => bytesB64(new TextEncoder().encode(s));
function bytesB64(bytes) { let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(bin); }
const lines76 = (b64) => b64.replace(/.{76}/g, '$&\r\n');
const hdr = (s) => /[^\x20-\x7e]/.test(s) ? `=?UTF-8?B?${utf8b64(s)}?=` : s;

export function buildMime({ from, fromName, to, subject, text, attachments = [] }) {
  const boundary = 'jobai_' + Math.random().toString(36).slice(2);
  const parts = [
    `From: ${fromName ? `${hdr(fromName)} <${from}>` : from}`, `To: ${to}`, `Subject: ${hdr(subject)}`, 'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', lines76(utf8b64(text)),
  ];
  for (const a of attachments) {
    parts.push(`--${boundary}`, `Content-Type: ${a.contentType || 'application/pdf'}; name="${hdr(a.filename)}"`, 'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${hdr(a.filename)}"`, '', lines76(bytesB64(a.bytes)));
  }
  parts.push(`--${boundary}--`, '');
  return parts.join('\r\n');
}

// Send one email from the connected Gmail. Returns { id, from }.
export async function sendGmail(opts) {
  const { token, email } = await accessToken();
  const raw = utf8b64(buildMime({ ...opts, from: email })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ raw }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Gmail did not send it (${(j.error && j.error.message) || r.status})`);
  return { id: j.id, from: email };
}
