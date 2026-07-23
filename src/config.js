// Shared app-level configuration.

// JobBot hosted backend (test/commercial builds): proxies LLM calls for
// users with an active license. Overridable for local backend testing.
const JOBBOT_BACKEND_URL = process.env.JOBBOT_BACKEND_URL || 'https://api.tryjobai.com';

module.exports = { JOBBOT_BACKEND_URL };
