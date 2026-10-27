// xlsx.js — reads tables from .xlsx and .csv files on the phone, with no library and nothing uploaded.
// An .xlsx file is a ZIP archive of XML files: we find the sheets, unpack them with the browser's own
// DecompressionStream and read the cells. Returns {kind, sheets: [{name, rows: [[cell, …], …]}]} where each
// cell is a string or a number.

/** Read a File chosen in an <input type="file">. */
export async function readTableFile(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  if (buf.length > 15 * 1048576) throw new Error('The file is too big (over 15 MB).');
  if (isZip(buf)) return { kind: 'xlsx', sheets: await readXlsx(buf) };
  return { kind: 'csv', sheets: [{ name: file.name || 'CSV', rows: parseCsv(decodeText(buf)) }] };
}

function isZip(b) { return b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04; }

function decodeText(buf) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) { text = new TextDecoder('windows-1252').decode(buf); }
  return text.replace(/^﻿/, '');
}

/** CSV with quotes, commas inside quotes and Windows line ends. The separator (comma, semicolon or tab) is guessed. */
export function parseCsv(text) {
  const sample = text.split(/\r?\n/).slice(0, 15).join('\n');
  const count = (d) => sample.split(d).length - 1;
  const delim = [',', ';', '\t'].sort((a, b) => count(b) - count(a))[0];
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ''));
}

// ---------- ZIP ----------

function u16(b, i) { return b[i] | (b[i + 1] << 8); }
function u32(b, i) { return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0; }

/** Name → {method, start, size} from the ZIP's central directory. */
function zipEntries(b) {
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (u32(b, i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('This .xlsx file looks damaged.');
  const count = u16(b, eocd + 10), out = {};
  let p = u32(b, eocd + 16);
  const dec = new TextDecoder('utf-8');
  for (let k = 0; k < count && p + 46 <= b.length; k++) {
    if (u32(b, p) !== 0x02014b50) break;
    const method = u16(b, p + 10), csize = u32(b, p + 20), nlen = u16(b, p + 28), xlen = u16(b, p + 30), clen = u16(b, p + 32), local = u32(b, p + 42);
    const name = dec.decode(b.subarray(p + 46, p + 46 + nlen));
    const start = local + 30 + u16(b, local + 26) + u16(b, local + 28);
    out[name] = { method, start, size: csize };
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

async function unpack(b, e) {
  const data = b.subarray(e.start, e.start + e.size);
  if (e.method === 0) return data;
  if (e.method !== 8) throw new Error('This .xlsx file uses a compression the app cannot read. Save it as CSV and import that.');
  if (typeof DecompressionStream !== 'function') throw new Error('This browser cannot open .xlsx files. Save the file as CSV and import that.');
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ---------- Workbook ----------

async function readXlsx(b) {
  const files = zipEntries(b), dec = new TextDecoder('utf-8');
  const text = async (name) => (files[name] ? dec.decode(await unpack(b, files[name])) : null);
  const xml = (s) => new DOMParser().parseFromString(s, 'application/xml');
  const wb = await text('xl/workbook.xml');
  if (!wb) throw new Error('No workbook in this file. Is it an Excel file?');
  const rels = {};
  const relXml = await text('xl/_rels/workbook.xml.rels');
  if (relXml) for (const r of xml(relXml).getElementsByTagName('Relationship')) rels[r.getAttribute('Id')] = r.getAttribute('Target');
  const strings = [];
  const ss = await text('xl/sharedStrings.xml');
  if (ss) for (const si of xml(ss).getElementsByTagName('si')) strings.push([...si.getElementsByTagName('t')].map((t) => t.textContent).join(''));
  const sheets = [];
  for (const sh of xml(wb).getElementsByTagName('sheet')) {
    const rid = sh.getAttribute('r:id') || sh.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
    let target = rels[rid] || '';
    target = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
    const body = await text(target);
    if (body) sheets.push({ name: sh.getAttribute('name') || target, rows: sheetRows(xml(body), strings) });
  }
  return sheets;
}

/** Column letters (A, B, …, AA) → index from 0. */
function colIndex(ref) {
  let n = 0;
  for (const ch of String(ref).replace(/[0-9]/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function sheetRows(doc, strings) {
  const rows = [];
  for (const r of doc.getElementsByTagName('row')) {
    const row = [];
    let next = 0;
    for (const c of r.getElementsByTagName('c')) {
      const ref = c.getAttribute('r'), i = ref ? colIndex(ref) : next, t = c.getAttribute('t');
      const v = c.getElementsByTagName('v')[0];
      let val = '';
      if (t === 's') val = v ? strings[Number(v.textContent)] ?? '' : '';
      else if (t === 'inlineStr') val = [...c.getElementsByTagName('t')].map((x) => x.textContent).join('');
      else if (t === 'str' || t === 'd') val = v ? v.textContent : '';
      else if (t === 'b') val = v ? v.textContent === '1' : '';
      else if (t === 'e') val = '';
      else if (v) { const n = Number(v.textContent); val = Number.isFinite(n) ? n : v.textContent; }
      while (row.length < i) row.push('');
      row[i] = typeof val === 'string' ? val.trim() : val;
      next = i + 1;
    }
    if (row.some((x) => x !== '' && x != null)) rows.push(row);
  }
  return rows;
}

/** An Excel date number (days since 30 Dec 1899) or a date-looking string → 'yyyy-mm-dd', else ''. */
export function toYmd(v) {
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  const s = String(v == null ? '' : v).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s); // Indian day-first dates
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return '';
}
