// Strips AI-sounding patterns from CV text before Jobscan scoring and PDF prep

const EM_DASH   = /—/g;   // —
const EN_DASH   = /–/g;   // –
const BULLET    = /•/g;   // •
const MID_DOT   = /·/g;   // ·
const MULTI_SP  = / {2,}/g;

// Phrases common in AI-generated CVs — replace with plain equivalents
const AI_PHRASES = [
  [/\bLeveraging\b/gi,          'Using'],
  [/\bUtilising\b/gi,           'Using'],
  [/\bUtilizing\b/gi,           'Using'],
  [/\bSpearheaded\b/gi,         'Led'],
  [/\bOrchestrated\b/gi,        'Managed'],
  [/\bCatalysed\b/gi,           'Drove'],
  [/\bCatalyzed\b/gi,           'Drove'],
  [/\bInstrumental in\b/gi,     'Key in'],
  [/\bDriving force\b/gi,       'Key driver'],
  [/\bSeamlessly\b/gi,          ''],
  [/\bRobust\b/gi,              'Strong'],
  [/\bDynamic\b/gi,             ''],
  [/\bProactive\b/gi,           ''],
  [/\bSynergies?\b/gi,          'collaboration'],
];

function cleanText(text) {
  let t = text;

  // Replace dashes and bullets
  t = t.replace(EM_DASH,  ' - ');
  t = t.replace(EN_DASH,  '-');
  t = t.replace(BULLET,   '-');
  t = t.replace(MID_DOT,  ',');

  // Replace AI phrases
  for (const [pattern, replacement] of AI_PHRASES) {
    t = t.replace(pattern, replacement);
  }

  // Remove German language references (not accurate for this applicant)
  t = t.replace(/,?\s*German\s*\(conversational\)/gi, '');
  t = t.replace(/[.,]?\s*Conversational German\.?/gi, '');
  t = t.replace(/\bGerman[,.]?\s*/gi, '');

  // Collapse multiple spaces and clean up orphaned separators left behind
  t = t.replace(/Languages:\s*English \(native\)\s*[,.]?\s*\n/gi, 'Languages: English (native)\n');
  t = t.replace(MULTI_SP, ' ').trim();

  return t;
}

module.exports = { cleanText };
