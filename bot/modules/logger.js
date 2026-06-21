const fs   = require("fs");
const path = require("path");
const cfg  = require("../config");

const LOG_FILE = path.join(cfg.LOGS_DIR, "applications.csv");

function init() {
  if (!fs.existsSync(LOG_FILE)) {
    fs.writeFileSync(LOG_FILE, "timestamp,job_title,company,job_url,cv_used,jobscan_score,status,notes\n");
  }
}

function log(jobTitle, company, jobUrl, cvName, score, status, notes = "") {
  init();
  const ts  = new Date().toISOString();
  const row = [ts, jobTitle, company, jobUrl, cvName, score, status, notes]
    .map(v => `"${String(v).replace(/"/g, '""')}"`)
    .join(",");
  fs.appendFileSync(LOG_FILE, row + "\n");
  console.log(`[LOG] ${status} | ${jobTitle} @ ${company} | CV: ${cvName} | Score: ${score}`);
}

function printSummary() {
  if (!fs.existsSync(LOG_FILE)) { console.log("No applications logged yet."); return; }
  const lines = fs.readFileSync(LOG_FILE, "utf8").trim().split("\n").slice(1);
  const applied  = lines.filter(l => l.includes('"APPLIED"')).length;
  const skipped  = lines.filter(l => l.includes('"SKIPPED"')).length;
  const errors   = lines.filter(l => l.includes('"ERROR"')).length;
  console.log(`\n═══════════════════════════════`);
  console.log(`  RUN SUMMARY`);
  console.log(`  Applied : ${applied}`);
  console.log(`  Skipped : ${skipped}`);
  console.log(`  Errors  : ${errors}`);
  console.log(`  Log     : ${LOG_FILE}`);
  console.log(`═══════════════════════════════\n`);
}

module.exports = { log, printSummary };
