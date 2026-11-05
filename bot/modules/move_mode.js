/**
 * move_mode.js
 * "Only move for more money": for people happy where they are. Job-AI only applies to jobs
 * whose advert SHOWS a salary at least `uplift`% above theirs, never to their own employer,
 * and only a few a month. Same rules as the Chrome extension (extension/src/shims/config.js).
 */

// Stored settings ({ on, current, uplift, monthly, employer }, or its JSON) -> the rule.
function fromSettings(raw) {
  let mv = raw;
  if (typeof raw === 'string') { try { mv = JSON.parse(raw); } catch (_) { mv = null; } }
  mv = mv || {};
  const now = parseInt(String(mv.current || '').replace(/[^0-9]/g, ''), 10) || 0;
  if (!mv.on || now < 10000) return { on: false };
  const uplift = Math.min(100, Math.max(5, Number(mv.uplift) || 15));
  return {
    on: true, current: now, uplift,
    min: Math.round(now * (1 + uplift / 100)),
    monthly: Math.min(30, Math.max(1, Number(mv.monthly) || 8)),
    employer: String(mv.employer || '').trim(),
  };
}

const bare = (s) => String(s || '').toLowerCase().replace(/\b(ltd|limited|plc|llc|inc|group)\b\.?/g, '').replace(/\s+/g, ' ').trim();

// Highest yearly salary the advert shows (top of a range), or 0.
function topPay(job, { us = false } = {}) {
  const text = `${job.title || ''} ${job.description || ''} ${job.salary || ''}`;
  const re = us ? /\$\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?(k)?\b/gi : /£\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?(k)?\b/gi;
  const pays = [...text.matchAll(re)].map((x) => { const n = parseFloat(x[1].replace(/,/g, '')); return x[2] ? n * 1000 : n; })
    .filter((n) => n >= 10000 && n <= 500000);
  return pays.length ? Math.max(...pays) : 0;
}

// '' when the job may go ahead, otherwise the reason it is skipped.
function check(move, job, { us = false } = {}) {
  if (!move || !move.on) return '';
  const co = bare(job.company), emp = bare(move.employer);
  if (emp.length >= 3 && co.length >= 3 && (co.includes(emp) || emp.includes(co))) return 'Your current employer';
  const top = topPay(job, { us });
  if (!top) return 'No salary shown (you only move for more money)';
  if (top < move.min) return `Pays under ${us ? '$' : '£'}${move.min.toLocaleString('en-GB')} (${move.uplift}% more than you)`;
  return '';
}

// What an application pays and how much more than the user earns now: { pay, pay_pct, currency }
// for the receipt email, phone notification and Earn more tab. null when the mode is off.
function payRise(move, job, { us = false } = {}) {
  if (!move || !move.on || !move.current) return null;
  const pay = topPay(job, { us });
  if (!pay || pay <= move.current) return null;
  return { pay, pay_pct: Math.round((pay / move.current - 1) * 100), currency: us ? 'USD' : 'GBP' };
}

module.exports = { fromSettings, check, topPay, payRise };
