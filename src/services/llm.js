// Unified LLM client for CV tailoring / scoring.
//
// Shipped builds ALWAYS use the licensed backend (inbuilt Groq) — never a local
// Ollama or a user's own API key. This keeps every user on the same model and
// output quality, keeps the backend as the single point of usage metering, and
// means the license gate can't be bypassed by a locally-installed model.
//
// The local providers (Ollama / Claude / direct Groq) are DEV-ONLY and reachable
// only when JOBBOT_ALLOW_LOCAL_LLM=1 is set (never in a packaged app).

const { JOBBOT_BACKEND_URL } = require('../config');

const GROQ_KEY   = process.env.GROQ_API_KEY  || '__GROQ_KEY__';
const GROQ_MODEL = process.env.GROQ_MODEL    || 'llama-3.1-8b-instant';

const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL   = 'claude-haiku-4-5-20251001';
const CLAUDE_TIMEOUT = 60000;

const OLLAMA_URL   = process.env.OLLAMA_URL   || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2';

// Read dynamically (not captured at load): the main process sets the license key
// after the DB loads / on activation, and each bot child gets it via spawn env.
function backendUrl() { return process.env.JOBBOT_BACKEND_URL || JOBBOT_BACKEND_URL; }
function licenseKey() { return process.env.JOBBOT_LICENSE_KEY; }

// Local providers (Ollama / Claude / direct Groq) are dev-only and disabled
// unless this is explicitly set. Never set in a packaged/shipped app.
const ALLOW_LOCAL = !!process.env.JOBBOT_ALLOW_LOCAL_LLM;

const isHosted = false;
const mode = 'groq';

// ── Groq (primary backend) ────────────────────────────────────────────────

async function groqAvailable() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { 'Authorization': `Bearer ${GROQ_KEY}` },
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function groqChat(prompt, timeoutMs = 60000) {
  const MAX_RETRIES = 4;
  let delay = 15000;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${GROQ_KEY}`,
        },
        body: JSON.stringify({
          model:      GROQ_MODEL,
          max_tokens: 4096,
          messages:   [{ role: 'user', content: prompt }],
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 429) {
      if (attempt === MAX_RETRIES) throw new Error(`Groq rate limited after ${MAX_RETRIES} retries`);
      const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10);
      const wait = retryAfter > 0 ? retryAfter * 1000 : delay;
      console.warn(`[LLM] Groq rate limited — waiting ${Math.round(wait / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await new Promise(r => setTimeout(r, wait));
      delay = Math.min(delay * 2, 120000);
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Groq API HTTP ${res.status}: ${body.substring(0, 200)}`);
    }
    const data = await res.json();
    return (data.choices?.[0]?.message?.content || '').trim();
  }
}

// ── Ollama (local fallback) ────────────────────────────────────────────────

async function ollamaAvailable() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { method: 'GET', signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function ollamaChat(prompt, timeoutMs) {
  const controller = new AbortController();
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        model:      OLLAMA_MODEL,
        stream:     false,
        keep_alive: -1,
        messages:   [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
    const data = await res.json();
    return data.message?.content?.trim() || '';
  } catch (err) {
    if (controller.signal.aborted) throw new Error('Ollama timeout');
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── Claude (fallback) ─────────────────────────────────────────────────────

async function claudeAvailable() {
  if (!ANTHROPIC_KEY) return false;
  try {
    const res = await fetch('https://api.anthropic.com/v1/models', {
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function claudeChat(prompt, timeoutMs = CLAUDE_TIMEOUT) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      CLAUDE_MODEL,
      max_tokens: 4096,
      messages:   [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Anthropic API HTTP ${res.status}: ${body.substring(0, 200)}`);
  }
  const data = await res.json();
  return (data.content?.[0]?.text || '').trim();
}

// ── Hosted (JobBot backend proxy — fallback) ──────────────────────────────

async function hostedAvailable() {
  if (!licenseKey()) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`${backendUrl()}/health`, { method: 'GET', signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function hostedChat(prompt, timeoutMs) {
  const res = await fetch(`${backendUrl()}/v1/chat`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${licenseKey()}`,
      ...(process.env.JOBBOT_MACHINE_ID ? { 'X-Machine-Id': process.env.JOBBOT_MACHINE_ID } : {}),
    },
    body:   JSON.stringify({ prompt }),
    signal: AbortSignal.timeout(Math.min(timeoutMs, 60000)),
  });
  if (res.ok) {
    const data = await res.json();
    return (data.content || '').trim();
  }
  throw new Error(`JobBot backend HTTP ${res.status}`);
}

// ── Public API ────────────────────────────────────────────────────────────

async function llmAvailable() {
  // Production: AI is available ONLY through the licensed backend (inbuilt Groq),
  // regardless of any local Ollama or user API key on the machine.
  if (licenseKey()) return await hostedAvailable();
  // Dev-only opt-in: allow local providers when explicitly enabled.
  if (ALLOW_LOCAL) {
    if (await ollamaAvailable())                  return true;
    if (await groqAvailable())                    return true;
    if (ANTHROPIC_KEY && await claudeAvailable()) return true;
  }
  return false;
}

async function llmChat(prompt, timeoutMs = 300000) {
  // ── Always route through the licensed backend when a license is present ────
  // Never fall back to Ollama / a user's own key: every user must get the same
  // inbuilt-Groq output, and a revoked/expired/over-limit license must lose AI
  // access (the backend surfaces 401/403/429 as an error) rather than silently
  // bypassing the gate with a local model.
  if (licenseKey()) {
    console.log('[LLM] Using licensed backend (Groq)');
    return hostedChat(prompt, timeoutMs);
  }

  // ── Local providers — DEV ONLY (JOBBOT_ALLOW_LOCAL_LLM=1), never in builds ──
  if (ALLOW_LOCAL) {
    if (await ollamaAvailable()) {
      console.log(`[LLM] (dev) Ollama (${OLLAMA_MODEL})`);
      return ollamaChat(prompt, timeoutMs);
    }
    try {
      if (await groqAvailable()) {
        console.log(`[LLM] (dev) Groq (${GROQ_MODEL})`);
        return await groqChat(prompt, timeoutMs);
      }
    } catch (err) {
      console.warn(`[LLM] (dev) Groq failed: ${err.message}`);
    }
    if (ANTHROPIC_KEY) {
      console.log('[LLM] (dev) Claude API');
      return claudeChat(prompt, timeoutMs);
    }
  }
  throw new Error('AI requires an active licence — no JOBBOT_LICENSE_KEY set.');
}

module.exports = { llmAvailable, llmChat, isHosted, mode };
