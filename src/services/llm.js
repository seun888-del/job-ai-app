// Unified LLM client for CV tailoring / scoring.
//
// Priority (first available wins):
//   1. Groq  — primary backend, free, fast (hardcoded key — no user setup needed)
//   2. Ollama — local fallback if Groq unreachable
//   3. Claude API  — ANTHROPIC_API_KEY fallback
//   4. Hosted mode — JOBBOT_LICENSE_KEY fallback (JobBot backend proxy)

const { JOBBOT_BACKEND_URL } = require('../config');

const GROQ_KEY   = process.env.GROQ_API_KEY  || '__GROQ_KEY__';
const GROQ_MODEL = process.env.GROQ_MODEL    || 'llama-3.1-8b-instant';

const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL   = 'claude-haiku-4-5-20251001';
const CLAUDE_TIMEOUT = 60000;

const OLLAMA_URL   = process.env.OLLAMA_URL   || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2';
const BACKEND_URL  = process.env.JOBBOT_BACKEND_URL || JOBBOT_BACKEND_URL;
const LICENSE_KEY  = process.env.JOBBOT_LICENSE_KEY;

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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`${BACKEND_URL}/health`, { method: 'GET', signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function hostedChat(prompt, timeoutMs) {
  const res = await fetch(`${BACKEND_URL}/v1/chat`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${LICENSE_KEY}`,
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
  // Licensed users: AI is gated by the license — only the backend counts.
  if (LICENSE_KEY) return await hostedAvailable();
  // No license (local dev): any direct provider will do.
  if (await groqAvailable())                       return true;
  if (await ollamaAvailable())                     return true;
  if (ANTHROPIC_KEY && await claudeAvailable())    return true;
  return false;
}

async function llmChat(prompt, timeoutMs = 300000) {
  // ── Licensed / production ────────────────────────────────────────────────
  // When a license key is present, route AI through the backend ONLY. We do
  // NOT fall back to Groq/Ollama/Claude here — that is deliberate: a revoked,
  // expired, or over-limit license must lose AI access, not silently bypass the
  // gate with the bundled key. The backend validates the license, meters usage,
  // and returns the model output (or 401/403/429 which surfaces as an error).
  if (LICENSE_KEY) {
    console.log('[LLM] Using licensed backend');
    return hostedChat(prompt, timeoutMs);
  }

  // ── No license key (local development only) ──────────────────────────────
  if (await ollamaAvailable()) {
    console.log(`[LLM] Using Ollama (${OLLAMA_MODEL})`);
    return ollamaChat(prompt, timeoutMs);
  }
  try {
    if (await groqAvailable()) {
      console.log(`[LLM] Using Groq (${GROQ_MODEL})`);
      return await groqChat(prompt, timeoutMs);
    }
  } catch (err) {
    console.warn(`[LLM] Groq failed: ${err.message} — trying fallback`);
  }
  if (ANTHROPIC_KEY) {
    console.log('[LLM] Falling back to Claude API');
    return claudeChat(prompt, timeoutMs);
  }
  throw new Error('No AI backend available (no license key set).');
}

module.exports = { llmAvailable, llmChat, isHosted, mode };
