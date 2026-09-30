// Reed agent for the extension: the SAME search, job-detail and apply code as the desktop app
// (bot/modules/reed.js), run in the user's own Chrome where they're already signed in to Reed.
import cfg from '../shims/config.js';
import { SiteAgent } from './base.js';

const reed = require('../../../bot/modules/reed');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ReedAgent extends SiteAgent {
  constructor(opts) { super({ ...opts, source: 'reed', label: 'Reed' }); }

  async signIn() {
    try { await reed.ensureLoggedIn(this.page); return true; } catch (_) { return false; }
  }

  async search() {
    const terms = cfg.JOB_SEARCHES || [];
    if (!terms.length) { this.log('Add search terms on the Setup page to find jobs.'); return; }
    for (const term of terms) {
      if (!this.running) return;
      let jobs = [];
      try { ({ jobs, page: this.page } = await reed.searchJobs(this.page.context(), this.page, term, 25, false)); }
      catch (e) { this.log(`Search failed for "${term}": ${e.message}`); continue; }
      this.log(`"${term}": ${jobs.length} job(s) found.`);
      for (const job of jobs) {
        if (!this.running) return;
        if (await this.known(job.jobId)) continue;
        if (/with verification/i.test(job.title)) continue;
        let details = null;
        try { details = await reed.getJobDescription(this.page, job); } catch (e) { continue; }
        await this.queueIfWanted(job, details);
        await sleep(2000);
      }
      // Tailor and apply between searches so ready jobs don't wait for every term.
      await this.scorePending();
      await this.applyReady();
    }
  }

  async known(jobId) { return (await import('../lib/store.js')).hasJob(jobId); }

  async apply(job) { return reed.applyToJob(this.page, job, job.cvPath); }
}
