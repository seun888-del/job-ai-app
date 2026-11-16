// The email a recruiter or employer receives when an agent applies by email (UK Recruiter Agent,
// Canada Job Bank). A recruiter skims dozens a day, so it is short: which role, why you fit in a
// few lines, CV attached, contact details. The full cover letter is the source; the AI cuts it to
// an email using only what the letter already says. If that fails, the letter is used as it is.
const { llmChat } = require('../../src/services/llm');

const SIGNOFF = /\n+\s*(kind regards|best regards|warm regards|regards|best wishes|many thanks|thanks|sincerely|yours sincerely|yours faithfully),?[\s\S]*$/i;
const GREETING = /^\s*(dear|hello|hi)\b[^\n]*\n+/i;

// US spellings the AI slips into, for UK applicants.
const UK = [['prioritiz', 'prioritis'], ['organiz', 'organis'], ['optimiz', 'optimis'], ['recogniz', 'recognis'], ['speciali', 'speciali'],
  ['analyz', 'analys'], ['utiliz', 'utilis'], ['standardiz', 'standardis'], ['minimiz', 'minimis'], ['maximiz', 'maximis'],
  ['customiz', 'customis'], ['centraliz', 'centralis'], ['streamlin', 'streamlin'], ['behavior', 'behaviour'], ['color', 'colour'],
  ['favorite', 'favourite'], ['center', 'centre'], ['program manag', 'programme manag'], ['enroll', 'enrol'], ['licens', 'licenc']];
function ukSpelling(text) {
  let t = String(text || '');
  for (const [us, uk] of UK) {
    if (us === uk) continue;
    t = t.replace(new RegExp(us, 'g'), uk).replace(new RegExp(us[0].toUpperCase() + us.slice(1), 'g'), uk[0].toUpperCase() + uk.slice(1));
  }
  return t.replace(/\blicenc(e[sd]?|ing)\b/g, (m) => (/ing|ed$/.test(m) ? m.replace('licenc', 'licens') : m)); // licensed/licensing keep the s
}

// 07359817080 -> 07359 817080, +447359817080 -> +44 7359 817080. Anything else is left alone.
function formatPhone(p, region) {
  const raw = String(p || '').trim();
  const d = raw.replace(/[^\d+]/g, '');
  if (region === 'uk') {
    if (/^07\d{9}$/.test(d)) return `${d.slice(0, 5)} ${d.slice(5)}`;
    if (/^\+447\d{9}$/.test(d)) return `+44 ${d.slice(3, 7)} ${d.slice(7)}`;
  } else if (/^\+?1?\d{10}$/.test(d)) {
    const n = d.replace(/^\+?1/, '').slice(-10);
    return `(${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}`;
  }
  return raw;
}

const noDashes = (s) => String(s || '').replace(/\s*[–—]\s*/g, ', ').replace(/,\s*,/g, ',');
const strip = (s) => String(s || '').trim().replace(GREETING, '').replace(SIGNOFF, '').trim();

async function shorten(letter, { title, company, cvWord, region }) {
  const prompt = `Rewrite this cover letter as a short job application email to a recruiter.

Rules:
- Two short paragraphs, 70 to 110 words in total.
- Start with: I'd like to apply for the ${title} role${company ? ` with ${company}` : ''}. Then one or two sentences on the most relevant experience.
- Second paragraph: one concrete result from the letter, if it has one.
- Use ONLY facts in the letter. Do not add skills, numbers, employers or claims.
- Plain, direct, first person. No flattery about the company, no "I am excited", no "passionate".
- ${region === 'uk' ? 'British English spelling.' : 'Canadian English spelling.'} No dashes of any kind between words.
- No greeting, no sign-off, no name, and do not mention the ${cvWord} or any attachment.
- Reply with the email body only.

Cover letter:
${letter}`;
  const out = strip(await llmChat(prompt, 45000));
  const words = out.split(/\s+/).filter(Boolean).length;
  if (words < 40 || words > 160) throw new Error('bad length');
  if (/\b(attached|attachment|regards|dear)\b/i.test(out)) throw new Error('extra parts');
  return out;
}

// region: 'uk' | 'ca'. Returns the full plain-text email.
async function applyEmail({ title, company, coverLetter, name, phone, from, region = 'uk', board = '' }) {
  const cvWord = region === 'uk' ? 'CV' : 'resume';
  const letter = strip(coverLetter);
  let body = '';
  if (letter) {
    try { body = await shorten(letter, { title, company, cvWord, region }); } catch (_) { body = letter; }
  }
  if (!body) body = `I'd like to apply for the ${title} role${company ? ` with ${company}` : ''}${board ? `, advertised on ${board}` : ''}.`;
  body = noDashes(body);
  if (region === 'uk') body = ukSpelling(body);
  const contact = [formatPhone(phone, region), from].filter(Boolean).join('\n');
  return `Dear Hiring Manager,\n\n${body}\n\nI've attached my ${cvWord} and would be glad to talk about the role.\n\nKind regards,\n${name}${contact ? `\n${contact}` : ''}`;
}

module.exports = { applyEmail, formatPhone, ukSpelling };
