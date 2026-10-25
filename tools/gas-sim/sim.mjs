// sim.mjs — a small Google Apps Script simulator for testing apps-script/*.gs in Node.
// It mimics the services the engine uses, including Sheets quirks that cause real bugs:
// fixed sheet sizes, strings turning into dates/numbers/booleans unless the cell is plain text,
// Java-byte HMAC arguments, and UI calls failing when run outside the sheet.
// Given the project manifest, it also enforces its oauthScopes like Apps Script does, and serves
// a fake Google Drive web API with the drive.file rule (the script sees only files it created).
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
const AUTH = 'https://www.googleapis.com/auth/';
const FOLDER_TYPE = 'application/vnd.google-apps.folder';

export function createSim({ files, order, manifest }) {
  // Explicit oauthScopes switch off automatic detection: anything not listed is refused.
  const scopes = manifest && manifest.oauthScopes ? manifest.oauthScopes.map((x) => x.replace(AUTH, '')) : null;
  const need = (what, ...alts) => {
    if (!scopes || alts.some((a) => scopes.includes(a))) return;
    throw new Error(`Exception: You do not have permission to call ${what}. Required permissions: ${alts.map((a) => AUTH + a).join(' or ')}`);
  };
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
      fetchAll: (reqs) => { need('UrlFetchApp.fetchAll', 'script.external_request'); return reqs.map((r) => sandbox.UrlFetchApp.fetch(r.url, r)); },
      fetch: (url, opts = {}) => {
        need('UrlFetchApp.fetch', 'script.external_request');
        state.requests.push({ url, opts });
        const r = /^https:\/\/www\.googleapis\.com\/(upload\/)?drive\//.test(url) ? driveApi(url, opts) : state.fetch(url, opts);
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
      getActiveSpreadsheet: () => { need('SpreadsheetApp.getActiveSpreadsheet', 'spreadsheets', 'spreadsheets.currentonly'); return ss; },
      flush: () => { need('SpreadsheetApp.flush', 'spreadsheets', 'spreadsheets.currentonly'); state.gfFlushes++; },
      getUi: () => {
        if (!state.uiAvailable) throw new Error('Cannot call SpreadsheetApp.getUi() from this context.');
        need('SpreadsheetApp.getUi', 'script.container.ui');
        return ui;
      },
    },
    HtmlService: { createHtmlOutput: (html) => { const o = { getContent: () => html, setWidth: () => o, setHeight: () => o }; return o; } },
    ScriptApp: {
      newTrigger: (h) => { need('ScriptApp.newTrigger', 'script.scriptapp'); return builder(h); },
      getProjectTriggers: () => { need('ScriptApp.getProjectTriggers', 'script.scriptapp'); return [...state.triggers]; },
      deleteTrigger: (t) => { need('ScriptApp.deleteTrigger', 'script.scriptapp'); state.triggers = state.triggers.filter((x) => x.id !== t.id); },
      getOAuthToken: () => state.oauthToken,
      WeekDay: { MONDAY: 'MONDAY', SATURDAY: 'SATURDAY', SUNDAY: 'SUNDAY' },
      EventType: { CLOCK: 'CLOCK' },
    },
    MailApp: {
      sendEmail: (o) => { need('MailApp.sendEmail', 'script.send_mail'); if (!o.to) throw new Error('to is required'); state.emails.push(o); },
      getRemainingDailyQuota: () => { need('MailApp.getRemainingDailyQuota', 'script.send_mail'); return 100 - state.emails.length; },
    },
    Session: { getEffectiveUser: () => ({ getEmail: () => { need('Session.getEffectiveUser', 'userinfo.email'); return 'owner@example.com'; } }) },
  };
  // ---------------- Google Drive (kept in memory) ----------------
  // items: {id, name, mimeType, parents, content, trashed, byApp}. byApp marks files this script created:
  // with the drive.file permission only those are visible to it.
  state.drive = { items: [], reads: 0, writes: 0, apiOff: false, failReads: 0 };
  const driveFull = () => !scopes || scopes.includes('drive');
  const visible = (it) => !it.trashed && (it.byApp || driveFull());
  const driveError = (code, message, reason) => ({ code, body: { error: { code, message, errors: [{ reason: reason || 'error', message }] } } });
  const matchQuery = (q) => {
    const tests = q.split(' and ').map((c) => {
      let m;
      if ((m = /^name = '(.*)'$/.exec(c))) return (it) => it.name === m[1];
      if ((m = /^mimeType = '(.*)'$/.exec(c))) return (it) => it.mimeType === m[1];
      if ((m = /^'(.+)' in parents$/.exec(c))) return (it) => it.parents.includes(m[1]);
      if ((m = /^trashed = (true|false)$/.exec(c))) return (it) => it.trashed === (m[1] === 'true');
      throw new Error('sim: unsupported Drive query clause: ' + c);
    });
    return (it) => tests.every((t) => t(it));
  };
  const driveApi = (url, opts) => {
    const u = new URL(url), method = String(opts.method || 'get').toLowerCase();
    const auth = (opts.headers || {}).Authorization || (opts.headers || {}).authorization;
    if (auth !== 'Bearer ' + state.oauthToken) return driveError(401, 'Request had invalid authentication credentials.', 'authError');
    if (state.drive.apiOff) return driveError(403, 'Google Drive API has not been used in project 123456 before or it is disabled.', 'accessNotConfigured');
    if (scopes && !scopes.includes('drive') && !scopes.includes('drive.file')) return driveError(403, 'Request had insufficient authentication scopes.', 'insufficientPermissions');
    if (method === 'get' && u.pathname === '/drive/v3/files') {
      const pick = matchQuery(u.searchParams.get('q') || 'trashed = false');
      return { code: 200, body: { files: state.drive.items.filter((it) => visible(it) && pick(it)).map((it) => ({ id: it.id, name: it.name })) } };
    }
    if (method === 'post' && u.pathname === '/drive/v3/files') {
      const meta = JSON.parse(opts.payload || '{}');
      const it = { id: 'd' + (++state.uid), name: meta.name, mimeType: meta.mimeType || 'application/octet-stream', parents: meta.parents || [], content: '', trashed: false, byApp: true };
      state.drive.items.push(it); state.drive.writes++;
      return { code: 200, body: { id: it.id } };
    }
    const m = /^\/(upload\/)?drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
    if (m) {
      const it = state.drive.items.find((x) => x.id === decodeURIComponent(m[2]) && (x.byApp || driveFull()));
      if (!it) return driveError(404, 'File not found: ' + m[2] + '.', 'notFound');
      if (method === 'get' && u.searchParams.get('alt') === 'media') {
        if (state.drive.failReads > 0) { state.drive.failReads--; return driveError(500, 'Internal Error', 'internalError'); }
        state.drive.reads++;
        return { code: 200, body: it.content };
      }
      if (method === 'get') return { code: 200, body: { id: it.id, trashed: it.trashed } };
      if (method === 'patch' && m[1] && u.searchParams.get('uploadType') === 'media') {
        if (String(opts.payload).length > 50 * 1024 * 1024) return driveError(413, 'Request too large', 'uploadTooLarge');
        it.content = String(opts.payload); state.drive.writes++;
        return { code: 200, body: { id: it.id } };
      }
    }
    return driveError(400, 'sim: unsupported Drive call ' + method + ' ' + url, 'badRequest');
  };
  state.oauthToken = 'sim-oauth-token';
  // DriveApp always needs the full Drive permission in real Apps Script.
  sandbox.DriveApp = new Proxy({}, { get: (_, name) => () => need('DriveApp.' + String(name), 'drive') });

  const ctx = vm.createContext(sandbox);
  app.Date = vm.runInContext('Date', ctx);
  // Load files the way Apps Script does: each file is its own script in one shared global scope.
  for (const f of order) {
    vm.runInContext(fs.readFileSync(path.join(files, f), 'utf8'), ctx, { filename: f });
  }
  return { ctx, state, ss, sandbox, run: (code) => vm.runInContext(code, ctx) };
}

export { IST_OFFSET_MIN, formatDate };
