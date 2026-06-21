// Unified LLM client for CV tailoring / scoring.
//
// Priority (first available wins):
//   1. Claude API  — ANTHROPIC_API_KEY in env (passed through from Electron main)
//   2. Hosted mode — JOBBOT_LICENSE_KEY set (JobBot backend proxy)
//   3. Local Ollama — fallback, requires Ollama running at OLLAMA_URL

const { JOBBOT_BACKEND_URL } = require('../config');

const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL   = 'claude-haiku-4-5-20251001'; // fast + cost-efficient for CV tasks
const CLAUDE_TIMEOUT = 60000; // 60s — Claude is fast, this is generous

const OLLAMA_URL   = process.env.OLLAMA_URL   || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2';
const BACKEND_URL  = process.env.JOBBOT_BACKEND_URL || JOBBOT_BACKEND_URL;
const LICENSE_KEY  = process.env.JOBBOT_LICENSE_KEY;

const mode = ANTHROPIC_KEY ? 'claude' : LICENSE_KEY ? 'hosted' : 'ollama';
const isHosted = mode !== 'ollama'; // used by scorer for logging

// ── Claude (Anthropic API) ────────────────────────────────────────────────

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
      'Content-Type':    'application/json',
      'x-api-key':       ANTHROPIC_KEY,
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

// ── Hosted (JobBot backend proxy) ─────────────────────────────────────────

async function hostedAvailable() {
  try {
    const res = await fetch(`${BACKEND_URL}/health`, { method: 'GET', signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
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
    signal: AbortSignal.timeout(Math.min(timeoutMs, 30000)),
  });
  if (res.ok) {
    const data = await res.json();
    return (data.content || '').trim();
  }
  throw new Error(`JobBot backend HTTP ${res.status}`);
}

// ── Local Ollama ───────────────────────────────────────────────────────────

async function ollamaAvailable() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { method: 'GET', signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ollamaChat(prompt, timeoutMs) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      model:    OLLAMA_MODEL,
      stream:   false,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const data = await res.json();
  return data.message?.content?.trim() || '';
}

// ── Public API ────────────────────────────────────────────────────────────

async function llmAvailable() {
  if (mode === 'claude')  return claudeAvailable();
  if (mode === 'hosted')  return hostedAvailable();
  return ollamaAvailable();
}

async function llmChat(prompt, timeoutMs = 90000) {
  if (mode === 'claude')  return claudeChat(prompt, timeoutMs);
  if (mode === 'hosted')  return hostedChat(prompt, timeoutMs);
  return ollamaChat(prompt, timeoutMs);
}

module.exports = { llmAvailable, llmChat, isHosted, mode };
