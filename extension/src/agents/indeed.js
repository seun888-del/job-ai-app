// Indeed agent for the extension (USA): the SAME search, job-detail and apply code as the
// desktop app (bot/modules/indeed.js), run in the user's own Chrome where they're signed in.
import cfg from '../shims/config.js';
import * as store from '../lib/store.js';
import { SiteAgent } from './base.js';

const indeed = require('../../../bot/modules/indeed');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class IndeedAgent extends SiteAgent {
  constructor(opts) { super({ ...opts, source: 'indeed', label: 'Indeed' }); }

  async signIn() {
    try { await indeed.ensureLoggedIn(this.page); return true; } catch (_) { return false; }
  }

  async search() {
    const terms = cfg.JOB_SEARCHES || [];
    if (!terms.length) { this.log('Add search terms on the Setup page to find jobs.'); return; }
    for (const term of terms) {
      if (!this.running) return;
      let jobs = [];
      try { jobs = await indeed.searchJobs(this.page, term, cfg.MAX_JOBS_PER_SEARCH); }
      catch (e) { this.log(`Search failed for "${term}": ${e.message}`); continue; }
      this.log(`"${term}": ${jobs.length} job(s) found.`);
      for (const job of jobs) {
        if (!this.running) return;
        if (await store.hasJob(job.jobId)) continue;
        let details = null;
        try { details = await indeed.getJobDescription(this.page, job); } catch (_) { continue; }
        await this.queueIfWanted(job, details);
        await sleep(2500 + Math.random() * 2000);
      }
      await this.scorePending();
      await this.applyReady();
    }
  }

  async apply(job) { return indeed.applyToJob(this.page, job, job.cvPath); }
}
