/**
 * jd_focus.js
 * Long adverts often open with pages of "About us", so cutting at the first N characters
 * drops the part that matters: what the employer needs. focusJD keeps the opening (the
 * role summary) and then jumps to the requirements / responsibilities section.
 */

// Headings that start the "what you need" part, strongest first.
const NEED_RE = /^[\s•*#-]*(essential|requirements?|person specification|what (you('|’)ll|you will) (need|bring)|what we('|’)re looking for|what we are looking for|about you|you will have|you('|’)ll have|skills,? (and|&) experience|key skills|the ideal candidate|qualifications|experience required)\b/im;
// Fallback: what the job involves.
const DUTY_RE = /^[\s•*#-]*(key )?(responsibilities|duties|main duties|the role|what you('|’)ll (do|be doing)|what you will (do|be doing)|day to day|role overview)\b/im;

function focusJD(jdText, max = 3000) {
  const jd = String(jdText || '');
  if (jd.length <= max) return jd;
  const head = 700;
  let at = -1;
  for (const re of [NEED_RE, DUTY_RE]) {
    const m = re.exec(jd);
    if (m && m.index > head) { at = m.index; break; }
  }
  // No section found past the opening: the start of the advert is the best guess.
  if (at < 0) return jd.slice(0, max);
  // If the duties come shortly before the needs, keep both.
  const duty = DUTY_RE.exec(jd);
  if (duty && duty.index > head && duty.index < at && at - duty.index < (max - head) / 2) at = duty.index;
  return jd.slice(0, head) + '\n...\n' + jd.slice(at, at + max - head);
}

module.exports = { focusJD };
