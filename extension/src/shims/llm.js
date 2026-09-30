// Browser stand-in for the desktop app's src/services/llm.js: every AI request goes to the
// licensed Job-AI backend with the user's licence key, exactly like the app. The key and this
// install's device id are set by the dashboard (globalThis.__jobaiLicense / __jobaiDevice).
const BACKEND = 'https://api.tryjobai.com';
const key = () => globalThis.__jobaiLicense || '';

// Same headers as the app: the device id lets the backend apply its one-trial-per-device rule.
function headers(k = key()) {
  const h = { Authorization: `Bearer ${k}`, 'X-Client': 'extension' };
  if (globalThis.__jobaiDevice) h['X-Machine-Id'] = globalThis.__jobaiDevice;
  return h;
}

async function hostedChat(prompt, timeoutMs) {
  const res = await fetch(`${BACKEND}/v1/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers() },
    body: JSON.stringify({ prompt }),
    signal: AbortSignal.timeout(Math.min(timeoutMs || 60000, 60000)),
  });
  if (res.ok) { const data = await res.json(); return String(data.content || '').trim(); }
  throw new Error(`JobBot backend HTTP ${res.status}`);
}

// One AI request at a time across every agent: the AI account has a per-minute limit, and
// several agents firing at once is what trips it.
let chain = Promise.resolve();
function llmChat(prompt, timeoutMs = 60000) {
  const run = chain.then(() => llmChatNow(prompt, timeoutMs));
  chain = run.catch(() => {});
  return run;
}

async function llmChatNow(prompt, timeoutMs = 60000) {
  if (!key()) throw new Error('AI requires an active licence.');
  // The AI account has a per-minute limit: when busy, wait for it to roll over and retry.
  const waits = [20000, 40000];
  for (let attempt = 0; ; attempt++) {
    try { return await hostedChat(prompt, timeoutMs); } catch (err) {
      const retryable = /HTTP (429|500|502|503|504)|timeout|aborted|Failed to fetch|network/i.test(String(err && err.message));
      if (!retryable || attempt >= waits.length) throw err;
      await new Promise((r) => setTimeout(r, waits[attempt]));
    }
  }
}

async function llmAvailable() {
  if (!key()) return false;
  try { const r = await fetch(`${BACKEND}/health`, { signal: AbortSignal.timeout(8000) }); return r.ok; } catch (_) { return true; }
}

// Licence check (Setup and before every agent start): GET /v1/license with the key.
async function checkLicense(k) {
  const r = await fetch(`${BACKEND}/v1/license`, { headers: headers(k), signal: AbortSignal.timeout(15000) });
  let body = {}; try { body = await r.json(); } catch (_) {}
  // Only the fields the extension needs (the email and key the server echoes are not kept).
  return { ok: r.ok, http: r.status, error: body.error || '', licenseStatus: body.status || '', expires_at: body.expires_at || null };
}

// "Ask Job-AI" support chat: same endpoint and payload as the app (question + a PII-free
// snapshot of the agents' state).
async function askAssistant(question, state) {
  if (!key()) return { ok: false, error: 'no_license' };
  let res;
  try {
    res = await fetch(`${BACKEND}/v1/assistant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers() },
      body: JSON.stringify({ question: String(question).slice(0, 2000), state }),
      signal: AbortSignal.timeout(30000),
    });
  } catch (_) { return { ok: false, error: 'network_error' }; }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: body.error || `http_${res.status}` };
  return { ok: true, reply: body.reply, remaining_today: body.remaining_today };
}

module.exports = { llmChat, llmAvailable, checkLicense, askAssistant, headers, mode: 'hosted', isHosted: true };
