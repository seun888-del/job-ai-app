// Injected into job pages (isolated world). Finds elements with the selectors the desktop app
// uses (CSS plus Playwright's ":visible", ':has-text("…")', getByRole/getByText) and performs
// actions on them, including the page functions the build collected from the shared code.
const { OPS } = require('../../../bot/modules/dom_ops');
const REG = require('../generated/ops');

const isVisible = (el) => !!el && (el.offsetParent !== null || (el.getClientRects && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'));
const textOf = (e) => (e.innerText || e.textContent || e.value || '').replace(/\s+/g, ' ').trim();

function splitTop(sel) {
  const parts = []; let depth = 0, quote = '', cur = '';
  for (const ch of sel) {
    if (quote) { cur += ch; if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}
const toRe = (s) => { const m = /^re:(.*)\|([a-z]*)$/.exec(s); return m ? new RegExp(m[1], m[2]) : null; };
const matchText = (have, want, exact) => { const re = toRe(want); if (re) return re.test(have); return exact ? have === want : have.toLowerCase().includes(want.toLowerCase()); };

const ROLE_SEL = {
  button: 'button, [role=button], input[type=button], input[type=submit], input[type=reset]',
  link: 'a[href], [role=link]', textbox: 'input:not([type]), input[type=text], input[type=email], input[type=tel], input[type=url], input[type=search], textarea, [role=textbox]',
  checkbox: 'input[type=checkbox], [role=checkbox]', radio: 'input[type=radio], [role=radio]', combobox: 'select, [role=combobox]',
  option: 'option, [role=option]', dialog: 'dialog, [role=dialog]', heading: 'h1,h2,h3,h4,h5,h6,[role=heading]', listitem: 'li, [role=listitem]',
};
const accName = (e) => (e.getAttribute('aria-label') || (e.getAttribute('aria-labelledby') && (document.getElementById(e.getAttribute('aria-labelledby')) || {}).innerText) || textOf(e) || e.getAttribute('title') || e.value || '').replace(/\s+/g, ' ').trim();

function findOne(part, root) {
  if (part.startsWith('@role=')) {
    const [role, name, exact] = part.slice(6).split('|');
    const re = name.startsWith('re:') ? part.slice(6).split('|').slice(1, 3).join('|') : name;
    return Array.from(root.querySelectorAll(ROLE_SEL[role] || `[role=${role}]`)).filter((e) => !name || matchText(accName(e), re, exact === '1'));
  }
  if (part.startsWith('@text=')) {
    const body = part.slice(6); const exact = body.endsWith('|1'); const want = body.replace(/\|[01]$/, '');
    const all = Array.from(root.querySelectorAll('body *')).filter((e) => e.children.length === 0 || /^(BUTTON|A|LABEL|SPAN)$/.test(e.tagName));
    return all.filter((e) => matchText(textOf(e), want, exact));
  }
  if (part.startsWith('@label=')) {
    const want = part.slice(7).toLowerCase();
    return Array.from(root.querySelectorAll('label')).filter((l) => textOf(l).toLowerCase().includes(want)).map((l) => (l.htmlFor && document.getElementById(l.htmlFor)) || l.querySelector('input,select,textarea')).filter(Boolean);
  }
  let css = part, visible = false; const texts = [];
  css = css.replace(/:has-text\((["'])(.*?)\1\)/g, (m, q, t) => { texts.push(t.toLowerCase()); return ''; });
  css = css.replace(/:text\((["'])(.*?)\1\)/g, (m, q, t) => { texts.push(t.toLowerCase()); return ''; });
  css = css.replace(/:visible\b/g, () => { visible = true; return ''; });
  css = css.replace(/^text=(["']?)(.*)\1$/, (m, q, t) => { texts.push(t.toLowerCase()); return '*'; });
  css = css.trim() || '*';
  let els;
  try { els = Array.from(root.querySelectorAll(css)); } catch (_) { return []; }
  if (visible) els = els.filter(isVisible);
  if (texts.length) els = els.filter((e) => { const t = textOf(e).toLowerCase(); return texts.every((x) => t.includes(x)); });
  return els;
}

function resolveScope(scope) {
  if (!scope) return document;
  const all = find(scope.sel, scope.scope ? resolveScope(scope.scope) : document);
  const el = scope.idx < 0 ? all[all.length + scope.idx] : all[scope.idx || 0];
  if (!el) throw new Error('no parent element for ' + scope.sel);
  return el;
}
function find(sel, root = document) {
  const seen = new Set(); const out = [];
  for (const p of splitTop(sel)) for (const e of findOne(p, root)) if (!seen.has(e)) { seen.add(e); out.push(e); }
  out.sort((a, b) => (a === b ? 0 : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  return out;
}

const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
const setValue = (el, v) => {
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const d = Object.getOwnPropertyDescriptor(proto, 'value');
  if (d && d.set) d.set.call(el, v); else el.value = v;
};
let markN = 0;
const mark = (e) => { if (!e.dataset.jobaiH) e.dataset.jobaiH = String(Date.now() % 1e7) + '_' + (++markN); return e.dataset.jobaiH; };

function key(el, k) {
  const target = el || document.activeElement || document.body;
  const parts = String(k).split('+'); const main = parts.pop();
  const mods = { ctrlKey: parts.some((p) => /control|ctrl|controlormeta/i.test(p)), metaKey: false, shiftKey: parts.some((p) => /shift/i.test(p)), altKey: parts.some((p) => /alt/i.test(p)) };
  const keyName = main === 'Space' ? ' ' : main;
  const init = { key: keyName, code: main.length === 1 ? 'Key' + main.toUpperCase() : main, bubbles: true, cancelable: true, ...mods };
  const ok = target.dispatchEvent(new KeyboardEvent('keydown', init));
  if (ok && /^(a)$/i.test(main) && mods.ctrlKey && target.select) target.select();
  else if (ok && /^(Delete|Backspace)$/.test(main) && 'value' in target) { setValue(target, ''); fire(target, 'input'); }
  else if (ok && main === 'Enter') {
    if (target.form && target.tagName === 'INPUT') { if (target.form.requestSubmit) target.form.requestSubmit(); else target.form.submit(); }
    else if (/^(BUTTON|A)$/.test(target.tagName)) target.click();
  } else if (ok && main === 'Space' && /checkbox|radio|button/.test(target.type || target.getAttribute('role') || target.tagName.toLowerCase())) target.click();
  target.dispatchEvent(new KeyboardEvent('keyup', init));
}

function act(sel, idx, action, arg, scope) {
  if (action === 'keyActive') { key(null, arg); return true; }
  if (action === 'typeActive') { const t = document.activeElement; if (t && 'value' in t) { setValue(t, (t.value || '') + arg); fire(t, 'input'); } return true; }
  const root = resolveScope(scope);
  if (action === 'count') return find(sel, root).length;
  const all = find(sel, root);
  if (action === 'markAll') return all.map(mark);
  if (action === 'allTexts') return all.map(textOf);
  if (action === 'regAll') return REG[arg.id](all, arg.arg);
  const el = idx < 0 ? all[all.length + idx] : all[idx];
  if (action === 'mark') return el ? mark(el) : null;
  if (!el) throw new Error('no element for ' + sel);
  switch (action) {
    case 'click': el.scrollIntoView({ block: 'center' }); if (el.focus) el.focus(); el.click(); return true;
    case 'check':
    case 'uncheck': {
      const want = action === 'check';
      if (el.getAttribute('role') && !('checked' in el)) { if ((el.getAttribute('aria-checked') === 'true') !== want) el.click(); return (el.getAttribute('aria-checked') === 'true') === want; }
      if (!!el.checked !== want) { el.scrollIntoView({ block: 'center' }); el.click(); }
      if (!!el.checked !== want) { el.checked = want; fire(el, 'input'); fire(el, 'change'); }
      return !!el.checked === want;
    }
    case 'isChecked': return 'checked' in el ? !!el.checked : el.getAttribute('aria-checked') === 'true';
    case 'isVisible': return isVisible(el);
    case 'isEnabled': return !el.disabled && el.getAttribute('aria-disabled') !== 'true';
    case 'scroll': el.scrollIntoView({ block: 'center' }); return true;
    case 'focus': el.focus(); return true;
    case 'blur': el.blur(); return true;
    case 'getAttribute': return el.getAttribute(arg);
    case 'innerText': return el.innerText || '';
    case 'textContent': return el.textContent || '';
    case 'inputValue': return el.value || '';
    case 'box': { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }
    case 'fill': if (el.focus) el.focus(); if (el.isContentEditable) el.textContent = String(arg ?? ''); else setValue(el, String(arg == null ? '' : arg)); fire(el, 'input'); fire(el, 'change'); return true;
    case 'type': if (el.focus) el.focus(); setValue(el, (el.value || '') + arg); fire(el, 'input'); fire(el, 'change'); return true;
    case 'press': if (el.focus) el.focus(); key(el, arg); return true;
    case 'dispatch': el.dispatchEvent(arg === 'click' ? new MouseEvent('click', { bubbles: true, cancelable: true }) : new Event(arg, { bubbles: true })); return true;
    case 'selectOption': {
      const o = arg || {}; let i = -1;
      if (typeof o === 'object' && !Array.isArray(o) && o.index != null) i = o.index;
      else { const want = Array.isArray(o) ? o[0] : typeof o === 'object' ? (o.value ?? o.label) : o; i = Array.from(el.options).findIndex((x) => x.value === want || x.text.trim() === want); }
      if (i < 0 || i >= el.options.length) throw new Error('no option');
      el.selectedIndex = i; fire(el, 'input'); fire(el, 'change');
      return [el.options[i].value];
    }
    case 'setFiles': {
      const input = el.tagName === 'INPUT' && el.type === 'file' ? el : el.querySelector('input[type=file]');
      if (!input) throw new Error('no file input');
      const dt = new DataTransfer();
      for (const f of arg) { const bin = atob(f.b64); const bytes = new Uint8Array(bin.length); for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k); dt.items.add(new File([bytes], f.name, { type: f.type })); }
      input.files = dt.files; fire(input, 'input'); fire(input, 'change');
      return input.files.length;
    }
    case 'op': return OPS[arg.name](el, arg.arg);
    case 'reg': return REG[arg.id](el, arg.arg);
    default: throw new Error('unknown action ' + action);
  }
}

globalThis.__jobai = { act, version: 2 };
