// Builds the compact snapshot of the user's LOCAL agent state that rides along
// with an in-app assistant question. Operational only, by design:
//   • NO personal data — no name, email, address, or license key;
//   • NO file paths — CVs are named by their label only;
//   • just the state the assistant needs to explain what the agents are doing
//     (why jobs are/aren't applying): licence status, which agents are running,
//     which accounts are connected, queue counts, the top skip reasons, the
//     active search terms/excludes and CV labels.
// The backend quotes this as data, never instructions, so a small, boring
// payload keeps the blast radius of any prompt-injection to nothing useful.

const db = require('../db/database');
const queueReader = require('../db/queueReader');

function safe(fn, fallback) {
  try { return fn(); } catch (_) { return fallback; }
}

// queueReader methods are async (they re-open queue.db each call), so these must
// be awaited — a sync call would hand back a Promise and throw downstream.
async function safeAsync(fn, fallback) {
  try { return await fn(); } catch (_) { return fallback; }
}

// extra: { botStatus, connected } — supplied by main.js (they need Electron
// app paths / botManager, which live in the main process).
// Async because the queueReader reads (queue counts, analytics, applied-today)
// return Promises; main.js must `await` this.
async function build(extra = {}) {
  const license = safe(() => db.getLicense(), null) || {};

  const summaryRows = await safeAsync(() => queueReader.getQueueSummary(), []);
  const queue = {};
  for (const r of summaryRows) queue[r.status] = r.count;

  const analytics = (await safeAsync(() => queueReader.getAnalytics(), null)) || {};
  const topSkipReasons = (analytics.skipReasons || [])
    .slice(0, 8)
    .map(r => ({ reason: String(r.reason || '').slice(0, 120), count: r.count }));

  const appliedToday = await safeAsync(() => queueReader.getTodayAppliedCount(), 0);

  const searchTerms = safe(() => db.getSearchTerms(true), []).map(t => t.term).slice(0, 40);
  const excludeKeywords = safe(() => db.getExcludeKeywords(true), []).map(k => k.keyword).slice(0, 40);
  const cvs = safe(() => db.getCVs(false), []).map(c => ({ label: c.label, active: !!c.is_active }));

  return {
    license: {
      status: license.status || 'unknown',          // trial | active | expired
      plan: license.status === 'active' ? 'paid' : 'trial',
      expires_at: license.expires_at || null,
    },
    agents: extra.botStatus || {},                   // { reed:'running', scorer:'stopped', ... }
    connected_accounts: extra.connected || {},       // { reed:true, linkedin:false, ... }
    applied_today: appliedToday,
    queue,                                            // counts keyed by status (incl. 'tailored')
    top_skip_reasons: topSkipReasons,                // the "why nothing applied" signal
    search_terms: searchTerms,
    exclude_keywords: excludeKeywords,
    cvs,
  };
}

module.exports = { build };
