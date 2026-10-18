// Wellfound agent for the extension (USA startup jobs): the SAME search, job page and apply code
// as the desktop app (bot/modules/wellfound.js), run in the user's own Chrome where they're signed in.
import cfg from '../shims/config.js';
import * as store from '../lib/store.js';
import { SiteAgent } from './base.js';

const wellfound = require('../../../bot/modules/wellfound');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class WellfoundAgent extends SiteAgent {
  constructor(opts) { super({ ...opts, source: 'wellfound', label: 'Wellfound' }); }

  async signIn() {
    try { await wellfound.ensureLoggedIn(this.page); return true; } catch (_) { return false; }
  }

  async search() {
    const terms = cfg.JOB_SEARCHES || [];
    if (!terms.length) { this.log('Add search terms on the Setup page to find jobs.'); return; }
    for (const term of terms) {
      if (!this.running) return;
      let jobs = [];
      try { jobs = await wellfound.searchJobs(this.page, term, cfg.MAX_JOBS_PER_SEARCH); }
      catch (e) { this.log(`Search failed for "${term}": ${e.message}`); continue; }
      this.log(`"${term}": ${jobs.length} job(s) found.`);
      for (const job of jobs) {
        if (!this.running) return;
        if (await store.hasJob(job.jobId)) continue;
        // Company-website jobs say so on the search card; no need to open them.
        if (job.external) { await this.queueIfWanted(job, { description: 'x', hasEasyApply: false, isExternalOnly: true }); continue; }
        let details = null;
        try { details = await wellfound.getJobDescription(this.page, job); } catch (_) { continue; }
        if (details && details.alreadyApplied) continue;
        await this.queueIfWanted(job, { description: details.description, workType: job.workType });
        await sleep(2000 + Math.random() * 2000);
      }
      await this.scorePending();
      await this.applyReady();
    }
  }

  async apply(job) {
    try { return await wellfound.applyToJob(this.page, job, job.cvPath, job.coverLetter || ''); }
    catch (e) {
      if (/external apply/i.test(e.message)) return 'external';
      if (/cannot apply here/i.test(e.message)) return e.message.replace(/^Wellfound: /, '').slice(0, 140);
      throw e;
    }
  }
}
