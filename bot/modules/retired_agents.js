// retired_agents.js
// Agents that need the user to sign in to a job site are retired for now: Job-AI applies
// through Company Sites (and NHS Trac in the UK) only. Their code stays so they can come
// back; empty this list to bring them back. The renderer keeps the same list (app.js
// RETIRED_AGENTS) and so does the extension (dashboard.js).
const RETIRED_AGENTS = ['reed', 'linkedin', 'indeed', 'dice', 'wellfound'];
const isRetired = (name) => RETIRED_AGENTS.includes(String(name || ''));
module.exports = { RETIRED_AGENTS, isRetired };
