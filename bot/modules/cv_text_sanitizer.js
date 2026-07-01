/**
 * cv_text_sanitizer.js
 * ─────────────────────────────────────────────────────────────────────────
 * Removes undecodable glyph garbage from CV text extracted by pdf-parse /
 * mammoth BEFORE it enters the tailoring pipeline.
 *
 * Why this exists:
 *   Some CVs put certain runs (very commonly the employment DATES) in a
 *   subsetted font whose ToUnicode CMap is missing. pdf-parse cannot map those
 *   glyphs back to real characters, so it emits raw glyph indices - a run of
 *   C0 control characters (U+0001..U+001F) mixed with random symbols, e.g.:
 *
 *       Refuge UK + [ " # \x03 # \x12 \x02 D \x05 \x07 & W 6 V c ]
 *
 *   That garbage used to flow straight through parse -> structured object ->
 *   the regenerated PDF, so the tailored CV showed random letters where a date
 *   should be.
 *
 * What this does:
 *   The date text is genuinely unrecoverable (the source font threw the
 *   mapping away), so the best outcome is to drop the garbage cleanly while
 *   preserving the real words fused in front of it. Any whitespace-delimited
 *   token that contains an undecodable marker is truncated to its leading run
 *   of ordinary word characters:  "Refuge UK<garbage>"  ->  "Refuge UK".
 *
 * The undecodable markers (control chars, U+FFFD, private-use area) never
 * appear in legitimate CV text, so this is a zero-false-positive cleanup.
 */

// Characters that only appear when a glyph could not be decoded:
//   C0 controls, DEL/C1 controls, the Unicode replacement char, and the
//   private-use area (where subset/symbol fonts stash unmapped glyphs).
const UNDECODABLE_CLASS = '\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\uFFFD\\uE000-\\uF8FF';
const UNDECODABLE_G = new RegExp('[' + UNDECODABLE_CLASS + ']', 'g');
const UNDECODABLE   = new RegExp('[' + UNDECODABLE_CLASS + ']');

// Ordinary characters allowed to lead a real word/company/title, ending on an
// alphanumeric or ')'. Deliberately excludes the smart double-quotes
// (U+201C / U+201D) that the broken date font emits as its first garbage
// glyph, so truncation stops exactly where the real word ends.
const SAFE_LEAD = /^[A-Za-z0-9.,&/()'’+\- ]*[A-Za-z0-9)]/;

function sanitizeCVText(text) {
  if (!text || typeof text !== 'string') return text || '';

  const cleaned = text
    .normalize('NFC')
    .split('\n')
    .map((line) =>
      line
        // Split on whitespace but KEEP the separators so legitimate spacing
        // (including the double-space date separator the parser relies on) is
        // preserved untouched for clean CVs.
        .split(/(\s+)/)
        .map((tok) => {
          if (tok === '' || /^\s+$/.test(tok)) return tok;   // whitespace run
          if (!UNDECODABLE.test(tok)) return tok;            // clean token
          const m = SAFE_LEAD.exec(tok);                     // corrupt: keep real prefix
          return m ? m[0] : '';
        })
        .join('')
        .replace(/[ \t]+$/, '')                              // tidy trailing space
    )
    .join('\n')
    // Belt-and-braces: nuke any undecodable char that survived (e.g. a token
    // that was pure garbage collapsed to '' but left a stray marker).
    .replace(UNDECODABLE_G, '');

  return cleaned;
}

module.exports = { sanitizeCVText };
