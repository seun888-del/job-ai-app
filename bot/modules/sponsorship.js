// Decides whether a job posting actually OFFERS UK visa sponsorship — the check
// behind the "Only apply to jobs that offer visa sponsorship" (seek_sponsorship)
// preference.
//
// This replaces the old inline check that every bot carried:
//   /visa sponsor|sponsorship|skilled worker|tier 2|work permit/i.test(desc)
// That matched the WORD "sponsorship", not its meaning — so a posting that said
// "we do NOT offer visa sponsorship" passed the filter and the bot applied
// anyway, the exact opposite of what the user asked for. It also skipped nothing
// intelligently: any stray mention (e.g. a negation) let the job through.
//
// Two layers:
//   A. Negation-aware keyword scan (offline, free). A sponsorship mention counts
//      as positive only when the sentence it sits in carries no negation cue. No
//      mention at all → not offered (a role that never claims to sponsor can't be
//      assumed to).
//   B. Licensed-backend LLM confirmation (when a licence is present). For the
//      postings that DO mention sponsorship, the model confirms the employer is
//      offering it, rather than denying it or merely referencing it — catching
//      phrasings the regex can't. Because layer A gates on a keyword first, the
//      LLM is only ever asked about the minority of jobs that mention sponsorship
//      at all, never about every job (keeps usage/cost bounded).
//
// Fails safe: any LLM/network error falls back to the regex verdict. With no
// licence (dev, no JOBBOT_ALLOW_LOCAL_LLM), the regex verdict stands alone.

// Reuse the app's single LLM client (routes through the licensed backend). Held
// as the module object so the swap in tests / the dynamic license key still work.
let llm = null;
try { llm = require('../../src/services/llm'); } catch (_) { llm = null; }

function aiEnabled() {
  return !!(llm && typeof llm.llmChat === 'function') &&
    (!!process.env.JOBBOT_LICENSE_KEY || !!process.env.JOBBOT_ALLOW_LOCAL_LLM);
}

// Core sponsorship references. "tier 2" is the old name for the Skilled Worker
// visa; "certificate of sponsorship" (CoS) is the document an employer issues.
// Non-global so `.test()` is stateless.
const ANCHOR = /(?:visa\s+)?sponsor(?:ship|ing|s|ed)?|skilled worker|tier\s*2|work permit|certificate of sponsorship/i;

// Negation cues that, in the SAME sentence as a sponsorship mention, turn it into
// a denial. Bare "can"/"able" are deliberately absent ("we can offer sponsorship"
// is positive); only "cannot"/"unable" negate.
const NEG = /\b(?:no|not|non|never|without|unable|cannot|can'?t|won'?t|do(?:es)?\s*not|is\s*not|are\s*not|isn'?t|aren'?t|don'?t|doesn'?t|ineligible|unfortunately|excluded?)\b/i;

// Split into rough sentences/clauses so a negation only affects its own clause
// ("No parking on site. Visa sponsorship available." must not read as negated).
function _clauses(text) {
  return String(text || '').split(/[.\n!?;•]+/);
}

// Layer A verdict: true if at least one clause mentions sponsorship with no
// negation; false if there is no mention, or every mention is negated.
function regexOffers(description) {
  for (const s of _clauses(description)) {
    if (!s || !ANCHOR.test(s)) continue;
    // Trailing denial: "sponsorship is not available/offered", "no ... sponsor".
    const trailingDenial =
      /\bsponsor(?:ship)?\b[^.\n]{0,30}\b(?:not|never|no longer)\b/i.test(s) ||
      /\bnot\b[^.\n]{0,30}\bsponsor/i.test(s);
    if (!NEG.test(s) && !trailingDenial) return true; // a clean, positive mention
  }
  return false;
}

// Does the posting reference sponsorship at all? Gates the (paid) LLM call.
function mentionsSponsorship(description) {
  return ANCHOR.test(String(description || ''));
}

// 35s, not 20s: the licensed backend retries Groq with a ~15s backoff on a rate
// limit, so a too-tight client timeout fires mid-retry and needlessly drops to the
// regex fallback. Bots space these calls out (a page-load per job), so the longer
// ceiling rarely bites in practice.
const LLM_TIMEOUT_MS = 35000;
const _cache = new Map(); // per-run: description hash → boolean verdict

function _hash(s) {
  s = String(s || '');
  return s.length + ':' + s.slice(0, 120) + '|' + s.slice(-60);
}

async function _llmConfirms(description) {
  const text = String(description || '').slice(0, 6000);
  const prompt =
`Decide ONE thing about this job posting: does the employer clearly state they OFFER or are WILLING to provide UK visa / work sponsorship (for example a Skilled Worker visa or Certificate of Sponsorship) to candidates who need it?

Answer true ONLY if the posting positively offers sponsorship.
Answer false if it says sponsorship is NOT available, if it requires the candidate to already hold the right to work, or if it does not clearly offer sponsorship.

JOB POSTING:
"""
${text}
"""

Respond with ONLY JSON: {"offers_sponsorship": true} or {"offers_sponsorship": false}.`;

  const reply = await llm.llmChat(prompt, LLM_TIMEOUT_MS);
  const m = String(reply || '').match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      if (typeof j.offers_sponsorship === 'boolean') return j.offers_sponsorship;
    } catch (_) { /* fall through to text read */ }
  }
  const yes = /\b(true|yes)\b/i.test(reply);
  const no = /\b(false|no)\b/i.test(reply);
  if (yes && !no) return true;
  if (no && !yes) return false;
  return null; // undecided → caller uses the regex verdict
}

// Main entry. Returns true if the posting offers visa sponsorship, false if not.
async function offersSponsorship(description) {
  const text = String(description || '');
  // No sponsorship signal at all → can't assume it's offered. Skip, no LLM call.
  if (!mentionsSponsorship(text)) return false;

  const key = _hash(text);
  if (_cache.has(key)) return _cache.get(key);

  let verdict = regexOffers(text);

  // The posting mentions sponsorship — let the model confirm intent when we can.
  if (aiEnabled()) {
    try {
      const ai = await _llmConfirms(text);
      if (ai !== null) verdict = ai;
    } catch (err) {
      console.log(`  [Sponsorship] AI check failed, using keyword verdict: ${(err && err.message) || err}`);
    }
  }

  _cache.set(key, verdict);
  return verdict;
}

module.exports = { offersSponsorship, regexOffers, mentionsSponsorship, aiEnabled };
