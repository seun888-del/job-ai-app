// Read a CV's text in the browser (PDF or Word). The file never leaves the device.
import * as pdfjs from 'pdfjs-dist/build/pdf.min.mjs';
import mammoth from 'mammoth/mammoth.browser.js';

pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.min.mjs');

export async function extractText(file) {
  const buf = await file.arrayBuffer();
  const name = (file.name || '').toLowerCase();
  if (/\.docx?$/.test(name)) {
    const r = await mammoth.extractRawText({ arrayBuffer: buf });
    return clean(r.value || '');
  }
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const p = await pdf.getPage(i);
    const c = await p.getTextContent();
    // Keep line breaks where the PDF moves down a line, so sections stay readable.
    let last = null, line = '';
    const lines = [];
    for (const it of c.items) {
      const y = it.transform ? Math.round(it.transform[5]) : null;
      if (last !== null && y !== null && Math.abs(y - last) > 2) { lines.push(line); line = ''; }
      line += (line && !line.endsWith(' ') ? ' ' : '') + it.str;
      if (y !== null) last = y;
    }
    if (line) lines.push(line);
    pages.push(lines.join('\n'));
  }
  return clean(pages.join('\n\n'));
}

// Drop the odd symbols some PDFs produce and tidy spacing.
function clean(t) {
  return String(t).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f�]/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

export function toBase64(buf) {
  let s = ''; const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}
