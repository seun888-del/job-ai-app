// Named element actions shared by the desktop app (Playwright) and the Chrome extension.
// Each one takes the element and one argument. They must be self-contained (no outside
// variables) because they are sent to the page on their own. The extension can't run
// arbitrary code in pages, so every element-level action lives here by name.
const OPS = {
  info: (n) => ({ tag: n.tagName.toLowerCase(), type: (n.getAttribute('type') || '').toLowerCase() }),
  checked: (e) => !!e.checked,
  click: (e) => { e.click(); },
  setChecked: (e, v) => { e.checked = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); },
  removeTarget: (el) => { try { el.removeAttribute('target'); } catch (_) {} },
  selectedIs: (s, i) => s.selectedIndex === i,
  fireChangeBlur: (s) => { s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); s.blur(); },
  setSelected: (s, i) => { s.selectedIndex = i; s.dispatchEvent(new Event('change', { bubbles: true })); },
  selectedText: (s) => (s.options[s.selectedIndex] || {}).text || '',
  radioLabel: (r) => {
    if (r.id) { const l = document.querySelector('label[for="' + CSS.escape(r.id) + '"]'); if (l) return l.innerText; }
    return (r.closest('label') && r.closest('label').innerText) || r.getAttribute('aria-label') || r.value || '';
  },
  valueEquals: (e, v) => String(e.value || '').trim() === String(v).trim(),
  // Which option (by index) of a <select> best matches the wanted answer; null if none.
  pickOption: (sel, val) => {
        const n = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
        const opts = Array.from(sel.options);
        // Ignore the placeholder ("Please select...") so it never counts as a match.
        // Real options = everything except the placeholder. Judged by TEXT and position, not by
        // o.value: some Trac dropdowns give their only real option an empty value, and the old
        // value-based filter threw that option away (it also dropped any option saying "choose").
        const real = opts.filter((o, i) => { const t = (o.textContent || '').trim(); if (!t) return false; if (/^(please select|select\.\.\.|--)/i.test(t)) return false; return !(i === 0 && !o.value && /select/i.test(t)); });
        const MN = ['january','february','march','april','may','june','july','august','september','october','november','december'];
        const asNum = (t) => { const x = n(t); if (/^\d{1,4}$/.test(x)) return +x; const i = MN.findIndex((m) => x === m || (x.length >= 3 && m.startsWith(x))); return i >= 0 ? i + 1 : null; };
        const vn = asNum(val);
        let o = (vn != null && real.find((o) => asNum(o.textContent) === vn && (/^\d+$/.test(n(o.textContent)) || /^\d+$/.test(n(val)) || MN.some((m) => n(o.textContent).startsWith(m.slice(0, 3)))))) || null;
        o = o || real.find((o) => n(o.textContent) === n(val))
          || real.find((o) => n(o.textContent).includes(n(val)) && n(val).length > 1)
          || real.find((o) => n(val).includes(n(o.textContent)) && n(o.textContent).length > 2);
        // Answers saved as alternatives ("Heterosexual / Straight", "Gay or Lesbian"): match
        // on each part, so "Persons of the opposite sex (Heterosexual)" is found.
        if (!o) for (const alt of String(val).split(/\s*[\/|,]\s*|\s+or\s+/i).map(n).filter((a) => a.length > 3)) {
          o = real.find((x) => n(x.textContent).split(' ').includes(alt) || n(x.textContent).includes(alt)); if (o) break;
        }
        // A "where did you hear about this?" dropdown (required, no disclose option) whose
        // stored value doesn't match: pick a sensible option that's almost always present,
        // so the required field is never left blank.
        const isSource = /how did you (hear|learn)|where.*(saw|see|hear).*(post|vacanc|job)|first saw this post/i.test(sel.getAttribute('aria-label') || '')
          || real.some((o) => /vacancy bulletin|work colleague told me|word of mouth/i.test(o.textContent || ''));
        if (!o && isSource) {
          for (const pref of ['healthjobsuk', 'trac', 'nhs jobs', 'google', 'employer', 'word of mouth', 'friend or work colleague', 'other', 'internet']) {
            o = real.find((x) => n(x.textContent).includes(pref)); if (o) break;
          }
          if (!o) o = real[0];
        }
        // Confirmation dropdowns ("Please confirm you have read and understood...") often
        // offer ONE option worded as agreement ("I have read and understood"), so a plain
        // "Yes" never matched. For an agreeing answer, pick the agreeing option, or the only one.
        if (!o && /^(y|yes|true|agree|i agree|confirm|i confirm|accept)/i.test(String(val).trim())) {
          o = real.find((x) => /\byes\b|confirm|agree|understood|have read|accept|\bi do\b|\bi am\b/i.test(x.textContent || '') && !/\bno\b|not|don.t|disagree/i.test(x.textContent || ''))
            || (real.length === 1 ? real[0] : null);
        }
        // Monitoring dropdowns (ethnicity, sexual orientation, religion, etc.) always carry a
        // "do not wish to disclose / prefer not to say" option. If nothing matched, use it so
        // the REQUIRED question is satisfied with a valid (non-fabricated) monitoring answer.
        if (!o) o = real.find((x) => /do not wish|prefer not|not to say|rather not|decline to|not disclos|not stated|withheld|undisclosed/i.test(x.textContent || ''));
        // A required dropdown with ONE real option has only one valid answer: take it.
        if (!o && real.length === 1) o = real[0];
        return o ? String(o.index) : null;
      },
};

// Run a named action on a Playwright locator, or on the extension's locator (which
// implements __op itself).
function elOp(loc, name, arg) {
  if (loc && typeof loc.__op === 'function') return loc.__op(name, arg);
  return loc.evaluate(OPS[name], arg);
}

module.exports = { OPS, elOp };
