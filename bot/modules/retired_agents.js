// retired_agents.js
// Agents that need the user to sign in to a job site are OFF unless the user turns them on
// under "Extra job sites" in Search Preferences (they need their own account on that site).
// Indeed stays off for everyone: its Cloudflare check loops even when a person passes it.
// The renderer keeps the same rule (app.js) and so does the extension (dashboard.js).
const RETIRED_AGENTS = ['reed', 'linkedin', 'indeed', 'dice', 'wellfound'];
const ALWAYS_OFF = ['indeed'];
// Which region each optional site is offered in.
const EXTRA_SITES = { reed: 'uk', linkedin: 'both', dice: 'us', wellfound: 'us' };

// The user's ticked sites, as a list. Main passes them in; bot processes get them from
// JOBBOT_EXTRA_SITES, which botManager sets from search_preferences.extra_sites.
const parseExtra = (v) => String(v || '').split(',').map((s) => s.trim()).filter((s) => s in EXTRA_SITES);
const extraFromEnv = () => parseExtra(process.env.JOBBOT_EXTRA_SITES);

function isRetired(name, extra = extraFromEnv()) {
  const n = String(name || '');
  if (ALWAYS_OFF.includes(n)) return true;
  if (n in EXTRA_SITES) return !extra.includes(n);
  return false;
}
module.exports = { RETIRED_AGENTS, ALWAYS_OFF, EXTRA_SITES, parseExtra, isRetired };
