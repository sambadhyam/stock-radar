// sim.mjs — a small Google Apps Script simulator for testing apps-script/*.gs in Node.
// It mimics the services the engine uses, including Sheets quirks that cause real bugs:
// fixed sheet sizes, strings turning into dates/numbers/booleans unless the cell is plain text,
// Java-byte HMAC arguments, and UI calls failing when run outside the sheet.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const IST_OFFSET_MIN = 330;

/** Java SimpleDateFormat subset used by the engine. */
function formatDate(date, tz, pattern) {
  // Dates may come from the script's realm, so check the type without instanceof.
  if (Object.prototype.toString.call(date) !== '[object Date]' || isNaN(date.getTime())) throw new Error('formatDate: invalid date');
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    weekday: 'short', hour12: false,
  }).formatToParts(date);
  const g = (t) => parts.find((p) => p.type === t)?.value;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const hour = String(Number(g('hour')) % 24).padStart(2, '0');
  const map = {
    yyyy: g('year'), MMM: months[Number(g('month')) - 1], MM: g('month'), dd: g('day'), d: String(Number(g('day'))),
    HH: hour, mm: g('minute'), ss: g('second'), EEE: g('weekday'),
    u: String(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(g('weekday')) + 1),
  };
  return pattern.replace(/yyyy|MMM|MM|dd|d|HH|mm|ss|EEE|u/g, (m) => map[m]);
}

function parseCsv(text) {
  const rows = []; let row = []; let cur = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; continue; }
    if (c === '"') q = true; else if (c === ',') { row.push(cur); cur = ''; } else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; } else if (c !== '\r') cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

// ---------------- Sheets ----------------
class Range {
  constructor(sheet, r, c, nr = 1, nc = 1) {
    if (r < 1 || c < 1 || nr < 1 || nc < 1) throw new Error(`Range invalid: ${r},${c},${nr},${nc}`);
    if (r + nr - 1 > sheet.maxRows || c + nc - 1 > sheet.maxCols) {
      throw new Error(`Exception: The coordinates of the range are outside the dimensions of the sheet. (${sheet.name} r${r}+${nr} c${c}+${nc}, max ${sheet.maxRows}x${sheet.maxCols})`);
    }
    Object.assign(this, { sheet, r, c, nr, nc });
  }
  getValues() {
    const out = [];
    for (let i = 0; i < this.nr; i++) {
      const row = [];
      for (let j = 0; j < this.nc; j++) row.push(this.sheet.valueAt(this.r + i, this.c + j));
      out.push(row);
    }
    return out;
  }
  getDisplayValues() { return this.getValues().map((r) => r.map((v) => (v instanceof Date ? v.toISOString() : String(v)))); }
  setValues(values) {
    if (values.length !== this.nr || values.some((r) => r.length !== this.nc)) {
      throw new Error(`Exception: The number of rows/columns in the data does not match the range (${values.length}x${values[0]?.length} vs ${this.nr}x${this.nc})`);
    }
    values.forEach((row, i) => row.forEach((v, j) => {
      if (v === undefined || (typeof v === 'number' && !isFinite(v))) throw new Error('Exception: invalid cell value ' + v);
      this.sheet.write(this.r + i, this.c + j, v, null);
    }));
    return this;
  }
  setFormulas(f) { f.forEach((row, i) => row.forEach((v, j) => this.sheet.write(this.r + i, this.c + j, '', v))); return this; }
  clearContent() { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sheet.write(this.r + i, this.c + j, '', null); return this; }
  setNumberFormat(fmt) { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sheet.formats[`${this.r + i},${this.c + j}`] = fmt; return this; }
  setFontWeight() { return this; }
  setBackground() { return this; }
  setFontColor() { return this; }
  setWrap() { return this; }
}

class Sheet {
  constructor(ss, name) {
    Object.assign(this, { ss, name, cells: new Map(), formulas: new Map(), formats: {}, maxRows: 1000, maxCols: 26, hidden: false, frozen: 0 });
  }
  getName() { return this.name; }
  key(r, c) { return `${r},${c}`; }
  write(r, c, v, formula) {
    const k = this.key(r, c);
    if (formula) { this.formulas.set(k, formula); this.cells.delete(k); return; }
    this.formulas.delete(k);
    if (v === '' || v === null) { this.cells.delete(k); return; }
    this.cells.set(k, this.coerce(v, this.formats[k]));
  }
  /** What Google Sheets does with typed strings unless the cell is formatted as plain text. */
  coerce(v, fmt) {
    if (typeof v !== 'string' || fmt === '@') return v;
    const s = v.trim();
    if (/^(true|false)$/i.test(s)) return s.toLowerCase() === 'true';
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    const D = this.ss.app.Date; // Dates from the script's own realm, as Sheets would return them
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new D(`${s}T00:00:00+05:30`);
    if (/^\d{1,2}:\d{2}$/.test(s)) return new D(`1899-12-30T${s.padStart(5, '0')}:00+05:30`);
    return v;
  }
  valueAt(r, c) {
    const k = this.key(r, c);
    if (this.formulas.has(k)) return this.ss.app.evalFormula(this.formulas.get(k));
    return this.cells.has(k) ? this.cells.get(k) : '';
  }
  used() {
    let lr = 0, lc = 0;
    for (const k of [...this.cells.keys(), ...this.formulas.keys()]) { const [r, c] = k.split(',').map(Number); lr = Math.max(lr, r); lc = Math.max(lc, c); }
    return { lr, lc };
  }
  getLastRow() { return this.used().lr; }
  getLastColumn() { return this.used().lc; }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxCols; }
  getRange(r, c, nr, nc) { return new Range(this, r, c, nr, nc); }
  getDataRange() { const { lr, lc } = this.used(); return new Range(this, 1, 1, Math.max(lr, 1), Math.max(lc, 1)); }
  insertRowsAfter(after, n) { if (after !== this.maxRows) throw new Error('sim only supports inserting at the end'); this.maxRows += n; return this; }
  insertColumnsAfter(after, n) { if (after !== this.maxCols) throw new Error('sim only supports inserting at the end'); this.maxCols += n; return this; }
  deleteRows(start, n) {
    const moved = new Map(), movedF = new Map();
    for (const [k, v] of this.cells) { const [r, c] = k.split(',').map(Number); if (r < start) moved.set(k, v); else if (r >= start + n) moved.set(this.key(r - n, c), v); }
    for (const [k, v] of this.formulas) { const [r, c] = k.split(',').map(Number); if (r < start) movedF.set(k, v); else if (r >= start + n) movedF.set(this.key(r - n, c), v); }
    this.cells = moved; this.formulas = movedF; this.maxRows -= n;
  }
  clearContents() { this.cells.clear(); this.formulas.clear(); return this; }
  setFrozenRows(n) { this.frozen = n; }
  setColumnWidth() { return this; }
  setColumnWidths() { return this; }
  hideSheet() { this.hidden = true; return this; }
  isSheetHidden() { return this.hidden; }
  /** Test helper: the whole sheet as arrays (row 1 = header). */
  dump() { const { lr, lc } = this.used(); return lr ? this.getRange(1, 1, lr, lc).getValues() : []; }
}

class Spreadsheet {
  constructor(app) { this.app = app; this.sheets = [new Sheet(this, 'Sheet1')]; this.tz = 'America/New_York'; }
  getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
  insertSheet(name, index) {
    if (this.getSheetByName(name)) throw new Error(`A sheet with the name "${name}" already exists`);
    const sh = new Sheet(this, name);
    if (index === undefined) this.sheets.push(sh); else this.sheets.splice(index, 0, sh);
    return sh;
  }
  getSheets() { return [...this.sheets]; }
  deleteSheet(sh) { this.sheets = this.sheets.filter((s) => s !== sh); }
  setSpreadsheetTimeZone(tz) { this.tz = tz; }
}

// ---------------- The simulator ----------------
export function createSim({ files, order }) {
  const state = {
    props: new Map(), cache: new Map(), triggers: [], requests: [], emails: [], alerts: [], dialogs: [],
    telegram: [], logs: [], sleepMs: 0, uiAvailable: false, lockBusy: false, gfValues: {}, gfLoadingRounds: 0, gfFlushes: 0,
    fetch: () => ({ code: 404, body: 'no handler' }), uid: 0,
  };
  const app = {
    evalFormula(f) {
      const m = /^=GOOGLEFINANCE\("([^"]+)","([^"]+)"\)$/.exec(f);
      if (!m) return '#ERROR!';
      if (state.gfFlushes <= state.gfLoadingRounds) return state.gfLoadingValue || 'Loading...';
      const v = state.gfValues[`${m[1]}|${m[2]}`];
      return v === undefined ? '#N/A' : v;
    },
  };
  const ss = new Spreadsheet(app);

  const props = {
    getProperty: (k) => (state.props.has(k) ? state.props.get(k) : null),
    setProperty: (k, v) => {
      const s = String(v);
      if (s.length > 9 * 1024) throw new Error('Exception: Argument too large: value');
      state.props.set(k, s); return props;
    },
    setProperties: (o) => { Object.entries(o).forEach(([k, v]) => props.setProperty(k, v)); return props; },
    deleteProperty: (k) => { state.props.delete(k); return props; },
    getProperties: () => Object.fromEntries(state.props),
  };

  const makeTrigger = (handler, spec) => {
    const t = { id: String(++state.uid), handler, spec, getHandlerFunction: () => handler, getUniqueId: () => t.id, getEventType: () => 'CLOCK' };
    return t;
  };
  const builder = (handler) => {
    const spec = {};
    const tb = {
      everyMinutes(n) { if (![1, 5, 10, 15, 30].includes(n)) throw new Error('everyMinutes must be 1, 5, 10, 15 or 30'); spec.everyMinutes = n; return tb; },
      everyHours(n) { spec.everyHours = n; return tb; },
      everyDays(n) { spec.everyDays = n; return tb; },
      everyWeeks(n) { spec.everyWeeks = n; return tb; },
      atHour(h) { if (h < 0 || h > 23) throw new Error('bad hour'); spec.atHour = h; return tb; },
      nearMinute(m) { spec.nearMinute = m; return tb; },
      onWeekDay(d) { spec.onWeekDay = d; return tb; },
      inTimezone(tz) { spec.tz = tz; return tb; },
      at(date) { spec.at = date; return tb; },
      after(ms) { spec.after = ms; return tb; },
      create() {
        if (state.triggers.length >= 20) throw new Error('This script has too many triggers.');
        const t = makeTrigger(handler, { ...spec }); state.triggers.push(t); return t;
      },
    };
    return { timeBased: () => tb };
  };

  const ui = {
    ButtonSet: { OK: 'OK' },
    alert: (title, msg) => { state.alerts.push({ title, msg }); return 'OK'; },
    showModalDialog: (out, title) => { state.dialogs.push({ title, html: out.getContent() }); },
    createMenu: (name) => { const m = { items: [], addItem: (a, b) => { m.items.push([a, b]); return m; }, addSeparator: () => m, addToUi: () => { state.menu = m; } }; return m; },
  };

  const sandbox = {
    console: { log: (...a) => state.logs.push(a.join(' ')) },
    Utilities: {
      formatDate,
      sleep: (ms) => { state.sleepMs += ms; },
      getUuid: () => crypto.randomUUID(),
      parseCsv: (t) => parseCsv(t),
      MacAlgorithm: { HMAC_SHA_1: 'sha1', HMAC_SHA_256: 'sha256' },
      computeHmacSignature: (alg, value, key) => {
        const toBuf = (x) => {
          if (typeof x === 'string') return Buffer.from(x, 'utf8');
          if (!Array.isArray(x)) throw new Error('computeHmacSignature expects Byte[]');
          x.forEach((b) => { if (!Number.isInteger(b) || b < -128 || b > 127) throw new Error('Cannot convert ' + b + ' to byte'); });
          return Buffer.from(x.map((b) => b & 255));
        };
        const d = crypto.createHmac(alg, toBuf(key)).update(toBuf(value)).digest();
        return [...d].map((b) => (b > 127 ? b - 256 : b));
      },
    },
    UrlFetchApp: {
      fetchAll: (reqs) => reqs.map((r) => sandbox.UrlFetchApp.fetch(r.url, r)),
      fetch: (url, opts = {}) => {
        state.requests.push({ url, opts });
        const r = state.fetch(url, opts);
        if (r && r.throw) throw new Error(r.throw);
        const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
        if (!opts.muteHttpExceptions && r.code >= 400) throw new Error('Request failed with code ' + r.code);
        return { getResponseCode: () => r.code, getContentText: () => body, getHeaders: () => r.headers || {} };
      },
    },
    PropertiesService: { getScriptProperties: () => props },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (state.cache.has(k) ? state.cache.get(k) : null),
        put: (k, v, s) => { if (String(v).length > 100 * 1024) throw new Error('Cache value too large'); if (s > 21600) throw new Error('Cache expiry too long'); state.cache.set(k, String(v)); },
        remove: (k) => state.cache.delete(k),
      }),
    },
    LockService: { getScriptLock: () => ({ tryLock: () => !state.lockBusy, releaseLock: () => {}, waitLock: () => {} }) },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      flush: () => { state.gfFlushes++; },
      getUi: () => { if (!state.uiAvailable) throw new Error('Cannot call SpreadsheetApp.getUi() from this context.'); return ui; },
    },
    HtmlService: { createHtmlOutput: (html) => { const o = { getContent: () => html, setWidth: () => o, setHeight: () => o }; return o; } },
    ScriptApp: {
      newTrigger: builder,
      getProjectTriggers: () => [...state.triggers],
      deleteTrigger: (t) => { state.triggers = state.triggers.filter((x) => x.id !== t.id); },
      WeekDay: { MONDAY: 'MONDAY', SATURDAY: 'SATURDAY', SUNDAY: 'SUNDAY' },
      EventType: { CLOCK: 'CLOCK' },
    },
    MailApp: {
      sendEmail: (o) => { if (!o.to) throw new Error('to is required'); state.emails.push(o); },
      getRemainingDailyQuota: () => 100 - state.emails.length,
    },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' }) },
  };
  // ---------------- Drive (folders and files kept in memory) ----------------
  state.drive = { folders: [], files: [], reads: 0, writes: 0 };
  const iter = (arr) => { let i = 0; return { hasNext: () => i < arr.length, next: () => arr[i++] }; };
  const makeFile = (name, content, folder) => {
    const f = {
      id: 'file' + (++state.uid), name, content: String(content), folder,
      getId: () => f.id, getName: () => f.name, isTrashed: () => false,
      getBlob: () => ({ getDataAsString: () => { state.drive.reads++; return f.content; } }),
      setContent: (c) => { if (String(c).length > 50 * 1024 * 1024) throw new Error('File too large'); state.drive.writes++; f.content = String(c); return f; },
      getSize: () => f.content.length,
    };
    state.drive.files.push(f);
    return f;
  };
  const makeFolder = (name) => {
    const d = {
      id: 'folder' + (++state.uid), name,
      getId: () => d.id, getName: () => d.name, isTrashed: () => false,
      getFilesByName: (n) => iter(state.drive.files.filter((f) => f.folder === d && f.name === n)),
      getFiles: () => iter(state.drive.files.filter((f) => f.folder === d)),
      createFile: (n, c) => { state.drive.writes++; return makeFile(n, c, d); },
    };
    state.drive.folders.push(d);
    return d;
  };
  sandbox.DriveApp = {
    getFolderById: (id) => { const d = state.drive.folders.find((x) => x.id === id); if (!d) throw new Error('No item with the given ID could be found'); return d; },
    getFoldersByName: (n) => iter(state.drive.folders.filter((d) => d.name === n)),
    createFolder: (n) => makeFolder(n),
  };

  const ctx = vm.createContext(sandbox);
  app.Date = vm.runInContext('Date', ctx);
  // Load files the way Apps Script does: each file is its own script in one shared global scope.
  for (const f of order) {
    vm.runInContext(fs.readFileSync(path.join(files, f), 'utf8'), ctx, { filename: f });
  }
  return { ctx, state, ss, sandbox, run: (code) => vm.runInContext(code, ctx) };
}

export { IST_OFFSET_MIN, formatDate };
