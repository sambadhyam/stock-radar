/**
 * Stock Radar — Data.gs
 * Settings, sheet storage, keys, TOTP, market data providers with failover,
 * the NSE trading calendar and the stock lists.
 *
 * This file holds no keys. Keys are saved privately with  Stock Radar → 2. Set up keys.
 */

var SR_VERSION = '0.3.0';
var IST = 'Asia/Kolkata';

/* =============================== Settings =============================== */

/** Every setting, its default and what it does. Each becomes an editable row in the Config sheet. */
var CONFIG_DEFAULTS = [
  ['engineEnabled', true, 'Master switch for the scheduled engine (TRUE or FALSE)'],
  ['realCapital', 100000, 'Real capital in rupees, used to size real trades shown in alerts'],
  ['paperCapital', 100000, 'Virtual capital in rupees for paper trading'],
  ['riskPct', 1, 'Percent of capital you accept losing when a stop-loss is hit'],
  ['maxPerStockPct', 10, 'Most of your capital that may go into one stock, in percent'],
  ['watchlist', 'RELIANCE,TCS,HDFCBANK,INFY,TITAN', 'Extra NSE symbols for the intraday scan, comma separated, up to 10'],
  ['telegram', true, 'Send alerts and reports to Telegram'],
  ['emailDigest', true, 'Email the closing summary every trading day'],
  ['paperAlerts', true, 'Also send alerts from strategies that are still paper testing'],
  ['strategiesOff', '', 'Strategy ids switched off, comma separated'],
  ['intradayUniverse', 'NIFTY50', 'Index whose stocks the intraday engine watches, plus the watchlist'],
  ['swingUniverse', 'NIFTY200', 'Index scanned for swing setups'],
  ['mediumUniverse', 'NIFTY200', 'Index scanned for medium-term setups'],
  ['longUniverse', 'NIFTY500', 'Index scanned for long-term ideas'],
  ['noEntriesAfter', '14:30', 'No new intraday entries after this time (24-hour clock)'],
  ['squareOffAt', '15:10', 'Time of the intraday square-off reminder'],
  ['intradayExpiry', '15:15', 'Intraday signals and paper trades close at this time'],
  ['staleQuoteSeconds', 180, 'In market hours, a live quote older than this many seconds is stale'],
  ['crossCheckPct', 2, 'Flag when two data sources disagree on a price by more than this percent'],
  ['alertCooldownMinutes', 60, 'Shortest gap between alerts for the same stock and strategy'],
  ['graduationMinTrades', 30, 'Closed paper trades needed before a strategy can become Live-ready'],
  ['graduationMinPF', 1.3, 'Profit factor needed for Live-ready'],
  ['graduationMaxDrawdownPct', 15, 'Largest paper drawdown allowed for Live-ready, in percent'],
  ['useInstrumentMaster', false, 'Use Angel One\'s big instrument file for stock tokens (slow; symbol search is used when FALSE)'],
  ['intradayMaxSymbols', 60, 'Most stocks the intraday engine checks every 5 minutes'],
  ['maxTelegramAlertsPerRun', 5, 'Most alert messages sent from one scan; the rest are listed in one extra message'],
  ['maxTelegramAlertsPerDay', 40, 'Most alert messages sent in one day; everything is still logged in the Alerts sheet'],
  ['historyDays', 660, 'Calendar days of daily candles loaded per stock (about 450 trading days)'],
  ['heartbeatMinutes', 5, 'How often the engine records a market snapshot during the session'],
  ['muhuratTrading', false, 'Run the engine in special weekend Muhurat sessions'],
  ['chargeBrokerageIntradayPct', 0.03, 'Zerodha intraday brokerage, percent per executed order'],
  ['chargeBrokerageIntradayMax', 20, 'Zerodha intraday brokerage cap per executed order, rupees'],
  ['chargeSttDeliveryPct', 0.1, 'STT on delivery, percent of buy value and of sell value'],
  ['chargeSttIntradaySellPct', 0.025, 'STT on intraday, percent of sell value'],
  ['chargeTxnPct', 0.00307, 'NSE transaction charge, percent of turnover'],
  ['chargeSebiPerCrore', 10, 'SEBI fee, rupees per crore of turnover'],
  ['chargeStampDeliveryPct', 0.015, 'Stamp duty on delivery buys, percent'],
  ['chargeStampIntradayPct', 0.003, 'Stamp duty on intraday buys, percent'],
  ['chargeGstPct', 18, 'GST on brokerage and exchange fees, percent'],
  ['chargeDpPerSell', 15.34, 'Zerodha DP charge per stock on a delivery sell day, rupees including GST'],
  ['angelLocalIp', '127.0.0.1', 'Header value Angel One expects; any valid IP works for market data'],
  ['angelPublicIp', '106.193.147.98', 'Header value Angel One expects; this is what the official Angel One SDK sends'],
  ['angelMac', 'fe:80:2b:1c:3d:4e', 'Header value Angel One expects; any MAC address format works'],
];

var Config = {
  _cache: null,

  /** Every setting row: the engine's own plus the strategy parameters from Core.gs. */
  defaultRows: function () {
    var rows = CONFIG_DEFAULTS.slice();
    if (typeof SRCore !== 'undefined') rows = rows.concat(SRCore.PARAMS);
    return rows;
  },

  /** All settings: defaults overlaid with the Config sheet. Read once per run. */
  all: function () {
    if (this._cache) return this._cache;
    var out = {};
    this.defaultRows().forEach(function (r) { out[r[0]] = r[1]; });
    var sh = Store.sheet('Config');
    if (sh && sh.getLastRow() > 1) {
      sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(function (r) {
        var key = String(r[0]).trim();
        if (key && Object.prototype.hasOwnProperty.call(out, key)) out[key] = Config.coerce(r[1], out[key]);
      });
    }
    this._cache = out;
    return out;
  },

  get: function (key) { return this.all()[key]; },

  /** A comma-separated setting as a clean list. */
  list: function (key) {
    return String(this.get(key) || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  },

  /** A comma-separated list of NSE symbols, upper-cased, valid ones only. */
  symbols: function (key) {
    return this.list(key).map(function (s) { return s.toUpperCase(); }).filter(function (s) { return /^[A-Z0-9&-]{1,20}$/.test(s); });
  },

  /** Minutes after midnight for an HH:mm setting. */
  minutesOf: function (key) {
    var p = String(this.get(key)).split(':');
    return Number(p[0]) * 60 + Number(p[1] || 0);
  },

  /** Turn a sheet cell into the same type as the default value. */
  coerce: function (value, fallback) {
    if (value === '' || value === null || value === undefined) return fallback;
    if (typeof fallback === 'boolean') {
      if (typeof value === 'boolean') return value;
      var b = String(value).trim().toLowerCase();
      if (b === 'true' || b === 'yes' || b === '1') return true;
      if (b === 'false' || b === 'no' || b === '0') return false;
      return fallback;
    }
    if (typeof fallback === 'number') {
      var n = Number(value);
      return isFinite(n) ? n : fallback;
    }
    if (value instanceof Date) return Utilities.formatDate(value, IST, 'HH:mm');
    return String(value).trim();
  },
};

/* =============================== Storage =============================== */

var Store = {
  ss: function () { return SpreadsheetApp.getActiveSpreadsheet(); },
  sheet: function (name) { return this.ss().getSheetByName(name); },

  require: function (name) {
    var sh = this.sheet(name);
    if (!sh) throw new Error('The "' + name + '" sheet is missing. Run Stock Radar → 1. Create sheets.');
    return sh;
  },

  headers: function (sh) {
    var cols = sh.getLastColumn();
    return cols ? sh.getRange(1, 1, 1, cols).getValues()[0].map(function (h) { return String(h); }) : [];
  },

  ensureRows: function (sh, lastRowNeeded) {
    var max = sh.getMaxRows();
    if (lastRowNeeded > max) sh.insertRowsAfter(max, lastRowNeeded - max);
  },

  ensureCols: function (sh, lastColNeeded) {
    var max = sh.getMaxColumns();
    if (lastColNeeded > max) sh.insertColumnsAfter(max, lastColNeeded - max);
  },

  /** Append rows given as arrays (header order) or objects keyed by header. */
  append: function (name, rows) {
    if (!rows || !rows.length) return;
    var sh = this.require(name);
    var hdr = this.headers(sh);
    var data = rows.map(function (r) { return Store._row(r, hdr); });
    var start = sh.getLastRow() + 1;
    this.ensureRows(sh, start + data.length - 1);
    sh.getRange(start, 1, data.length, hdr.length).setValues(data);
  },

  /** Replace everything under the header row. */
  replaceAll: function (name, rows) {
    var sh = this.require(name);
    var hdr = this.headers(sh);
    var last = sh.getLastRow();
    if (last > 1) sh.getRange(2, 1, last - 1, hdr.length).clearContent();
    if (!rows.length) return;
    var data = rows.map(function (r) { return Store._row(r, hdr); });
    this.ensureRows(sh, data.length + 1);
    sh.getRange(2, 1, data.length, hdr.length).setValues(data);
  },

  /** Rows as objects keyed by header. */
  readObjects: function (name) {
    var sh = this.sheet(name);
    if (!sh || sh.getLastRow() < 2) return [];
    var hdr = this.headers(sh);
    return sh.getRange(2, 1, sh.getLastRow() - 1, hdr.length).getValues().map(function (r) {
      var o = {};
      hdr.forEach(function (h, i) { o[h] = r[i]; });
      return o;
    });
  },

  /** Keep only the newest rows of a log sheet. */
  trim: function (name, keep) {
    var sh = this.sheet(name);
    if (!sh) return;
    var body = sh.getLastRow() - 1;
    if (body > keep) sh.deleteRows(2, body - keep);
  },

  _row: function (r, hdr) {
    if (Array.isArray(r)) {
      var a = r.slice(0, hdr.length);
      while (a.length < hdr.length) a.push('');
      return a.map(function (v) { return v === null || v === undefined ? '' : v; });
    }
    return hdr.map(function (h) { return r[h] === null || r[h] === undefined ? '' : r[h]; });
  },
};

/* ================================ Keys ================================ */

/** The keys this engine needs. Values live only in Script Properties. */
var SECRET_FIELDS = [
  { key: 'ANGEL_CLIENT_CODE', label: 'Angel One client ID', pattern: /^[A-Z0-9]{3,20}$/, hint: 'The ID you log in to Angel One with, like S1234567', required: true, secret: false },
  { key: 'ANGEL_PIN', label: 'Angel One PIN', pattern: /^\d{4,6}$/, hint: 'Your 4-digit login PIN', required: true, secret: true },
  { key: 'ANGEL_API_KEY', label: 'SmartAPI API key', pattern: /^[A-Za-z0-9_-]{4,64}$/, hint: 'From your app on the SmartAPI portal', required: true, secret: true },
  { key: 'ANGEL_TOTP_SECRET', label: 'TOTP secret key', pattern: /^[A-Z2-7]{16,}$/, hint: 'The text key shown with the QR code when you enabled TOTP', required: true, secret: true },
  { key: 'TG_BOT_TOKEN', label: 'Telegram bot token', pattern: /^\d{5,}:[A-Za-z0-9_-]{30,}$/, hint: 'From @BotFather, like 123456789:AAE…', required: true, secret: true },
  { key: 'TG_CHAT_ID', label: 'Telegram chat ID', pattern: /^-?\d{4,}$/, hint: 'Numbers only, from the getUpdates page', required: true, secret: false },
  { key: 'GEMINI_API_KEY', label: 'Gemini API key (optional)', pattern: /^[A-Za-z0-9_-]{20,}$/, hint: 'Only needed for AI news summaries later', required: false, secret: true },
];

var Secrets = {
  props: function () { return PropertiesService.getScriptProperties(); },
  get: function (key) { return this.props().getProperty(key) || ''; },
  has: function (key) { return !!this.get(key); },

  missing: function () {
    return SECRET_FIELDS.filter(function (f) { return f.required && !Secrets.has(f.key); }).map(function (f) { return f.label; });
  },

  normalize: function (field, value) {
    var v = String(value === null || value === undefined ? '' : value).trim();
    if (field.key === 'ANGEL_TOTP_SECRET') v = v.toUpperCase().replace(/[\s=-]/g, '');
    if (field.key === 'ANGEL_CLIENT_CODE') v = v.toUpperCase();
    return v;
  },

  /** Save every non-empty value. If any value is invalid, nothing is saved. */
  save: function (values) {
    values = values || {};
    var toSave = {}, saved = [], errors = [];
    SECRET_FIELDS.forEach(function (f) {
      var v = Secrets.normalize(f, values[f.key]);
      if (!v) return;
      if (!f.pattern.test(v)) { errors.push(f.label + ' does not look right. ' + f.hint + '.'); return; }
      toSave[f.key] = v;
      saved.push(f.label);
    });
    if (errors.length) return { saved: [], errors: errors };
    if (saved.length) {
      this.props().setProperties(toSave);
      if (toSave.ANGEL_CLIENT_CODE || toSave.ANGEL_PIN || toSave.ANGEL_API_KEY || toSave.ANGEL_TOTP_SECRET) Angel.clearSession();
    }
    this.appToken();
    return { saved: saved, errors: [] };
  },

  /** Which keys are saved (never their values). */
  status: function () {
    return SECRET_FIELDS.map(function (f) {
      return { key: f.key, label: f.label, hint: f.hint, required: f.required, secret: f.secret, set: Secrets.has(f.key) };
    });
  },

  /** Token the phone app will use to talk to this engine (Phase 4). Created once. */
  appToken: function () {
    var t = this.get('APP_TOKEN');
    if (!t) {
      t = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
      this.props().setProperty('APP_TOKEN', t);
    }
    return t;
  },

  /** Remove any saved key or session token from a piece of text before it is logged or shown. */
  mask: function (text) {
    var out = String(text === null || text === undefined ? '' : text);
    var all = this.props().getProperties();
    var keys = SECRET_FIELDS.map(function (f) { return f.key; }).concat(['APP_TOKEN', 'ANGEL_JWT', 'ANGEL_REFRESH', 'ANGEL_FEED']);
    keys.forEach(function (k) {
      var v = all[k];
      if (v && v.length >= 4 && k !== 'TG_CHAT_ID' && k !== 'ANGEL_CLIENT_CODE') out = out.split(v).join('••••');
    });
    return out;
  },
};

/* ================================ TOTP ================================ */

/** RFC 6238 time-based one-time passwords (6 digits, 30 seconds, HMAC-SHA1), as Angel One uses. */
var Totp = {
  ALPHABET: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',

  base32ToBytes: function (secret) {
    var clean = String(secret).toUpperCase().replace(/[\s=-]/g, '');
    var bits = 0, value = 0, out = [];
    for (var i = 0; i < clean.length; i++) {
      var idx = this.ALPHABET.indexOf(clean.charAt(i));
      if (idx < 0) throw new Error('The TOTP secret contains a character that is not allowed: ' + clean.charAt(i));
      value = (value << 5) | idx;
      bits += 5;
      if (bits >= 8) {
        out.push((value >>> (bits - 8)) & 0xff);
        bits -= 8;
        value &= (1 << bits) - 1;
      }
    }
    return out;
  },

  /** The code for a moment in time (default now). */
  code: function (secret, timeMs) {
    var counter = Math.floor((timeMs === undefined ? Date.now() : timeMs) / 30000);
    var msg = [];
    for (var i = 7; i >= 0; i--) {
      msg[i] = counter % 256;
      counter = Math.floor(counter / 256);
    }
    var key = this.base32ToBytes(secret);
    var toSigned = function (b) { return b > 127 ? b - 256 : b; };
    var mac = Utilities.computeHmacSignature(Utilities.MacAlgorithm.HMAC_SHA_1, msg.map(toSigned), key.map(toSigned));
    var h = mac.map(function (b) { return b & 0xff; });
    var off = h[h.length - 1] & 0x0f;
    var bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
    return ('000000' + (bin % 1000000)).slice(-6);
  },

  /** Seconds until the current code changes. */
  secondsLeft: function (timeMs) {
    var t = timeMs === undefined ? Date.now() : timeMs;
    return 30 - Math.floor((t / 1000) % 30);
  },
};

/* ================================ HTTP ================================ */

var Http = {
  /** Fetch with retries on network errors, rate limits and server errors. Returns {code, text, json, ms}. */
  request: function (url, options, retry) {
    var opts = { muteHttpExceptions: true, followRedirects: true };
    Object.keys(options || {}).forEach(function (k) { opts[k] = options[k]; });
    var tries = (retry && retry.retries !== undefined ? retry.retries : 2) + 1;
    var last = null;
    for (var i = 0; i < tries; i++) {
      var t0 = Date.now();
      try {
        var res = UrlFetchApp.fetch(url, opts);
        var out = { code: res.getResponseCode(), text: res.getContentText(), json: null, ms: Date.now() - t0 };
        try { out.json = JSON.parse(out.text); } catch (e) { out.json = null; }
        if (!this.retryable(out) || i === tries - 1) return out;
        last = out;
      } catch (err) {
        last = { code: 0, text: String((err && err.message) || err), json: null, ms: Date.now() - t0 };
        if (i === tries - 1) return last;
      }
      Utilities.sleep(Math.min(8000, 700 * Math.pow(2, i)) + Math.floor(Math.random() * 300));
    }
    return last;
  },

  retryable: function (r) {
    if (r.code === 429 || r.code >= 500) return true;
    var msg = (r.json && (r.json.message || r.json.description)) || String(r.text || '').slice(0, 300);
    return /exceeding access rate|too many requests|rate limit/i.test(msg);
  },
};

/* ============================ Number formats ============================ */

var Fmt = {
  /** 1,03,420.50 — Indian digit grouping, real minus sign. */
  num: function (n, d) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    var neg = n < 0;
    var parts = Math.abs(n).toFixed(d === undefined ? 2 : d).split('.');
    var whole = parts[0], last3 = whole.slice(-3), rest = whole.slice(0, -3);
    var grouped = rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3 : last3;
    return (neg ? '−' : '') + grouped + (parts[1] ? '.' + parts[1] : '');
  },
  money: function (n, d) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    return (n < 0 ? '−' : '') + '₹' + this.num(Math.abs(n), d);
  },
  pct: function (n, d) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    return (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(d === undefined ? 2 : d) + '%';
  },
  /** Mon 26 Oct */
  day: function (ymd) { return Utilities.formatDate(new Date(ymd + 'T12:00:00+05:30'), IST, 'EEE d MMM'); },
  time: function (ms) { return Utilities.formatDate(new Date(ms), IST, 'HH:mm'); },
};

/* ============================ Trading calendar ============================ */

/** NSE equity holidays for 2026 (weekdays). Checked against Upstox and ClearTax on 25 Oct 2026. */
var NSE_HOLIDAYS_2026 = [
  ['2026-01-15', 'Maharashtra municipal elections'], ['2026-01-26', 'Republic Day'], ['2026-03-03', 'Holi'],
  ['2026-03-26', 'Shri Ram Navami'], ['2026-03-31', 'Shri Mahavir Jayanti'], ['2026-04-03', 'Good Friday'],
  ['2026-04-14', 'Dr. Baba Saheb Ambedkar Jayanti'], ['2026-05-01', 'Maharashtra Day'], ['2026-05-28', 'Bakri Id'],
  ['2026-06-26', 'Muharram'], ['2026-09-14', 'Ganesh Chaturthi'], ['2026-10-02', 'Mahatma Gandhi Jayanti'],
  ['2026-10-20', 'Dussehra'], ['2026-11-10', 'Diwali Balipratipada'], ['2026-11-24', 'Prakash Gurpurb Sri Guru Nanak Dev'],
  ['2026-12-25', 'Christmas'],
];

var MarketCal = {
  _now: null,       // tests can pin the clock
  _holidays: null,

  now: function () { return this._now ? new Date(this._now) : new Date(); },
  ymd: function (d) { return Utilities.formatDate(d || this.now(), IST, 'yyyy-MM-dd'); },
  minutes: function (d) {
    var p = Utilities.formatDate(d || this.now(), IST, 'HH:mm').split(':');
    return Number(p[0]) * 60 + Number(p[1]);
  },
  /** 0 = Sunday … 6 = Saturday */
  weekday: function (ymd) { return new Date(ymd + 'T12:00:00+05:30').getUTCDay(); },
  at: function (ymd, hhmm) { return new Date(ymd + 'T' + hhmm + ':00+05:30'); },
  addDays: function (ymd, n) {
    var d = new Date(ymd + 'T12:00:00+05:30');
    d.setUTCDate(d.getUTCDate() + n);
    return this.ymd(d);
  },

  /** Holidays from the Holidays sheet (falls back to the built-in 2026 list). Map of ymd → name. */
  holidays: function () {
    if (this._holidays) return this._holidays;
    var map = {};
    var sh = Store.sheet('Holidays');
    var rows = sh && sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues() : NSE_HOLIDAYS_2026;
    rows.forEach(function (r) {
      var d = r[0] instanceof Date ? Utilities.formatDate(r[0], IST, 'yyyy-MM-dd') : String(r[0]).trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(d)) map[d] = String(r[1] || 'Holiday');
    });
    this._holidays = map;
    return map;
  },

  isHoliday: function (ymd) { return Object.prototype.hasOwnProperty.call(this.holidays(), ymd); },

  isTradingDay: function (ymd) {
    var wd = this.weekday(ymd);
    return wd !== 0 && wd !== 6 && !this.isHoliday(ymd);
  },

  /** 'open' | 'pre' | 'closed' | 'holiday' | 'weekend' (normal session 09:15–15:30). */
  marketState: function (d) {
    var date = d || this.now(), ymd = this.ymd(date), wd = this.weekday(ymd), m = this.minutes(date);
    if (wd === 0 || wd === 6) return 'weekend';
    if (this.isHoliday(ymd)) return 'holiday';
    if (m >= 555 && m < 930) return 'open';
    if (m >= 540 && m < 555) return 'pre';
    return 'closed';
  },

  prevTradingDay: function (ymd) {
    var d = this.addDays(ymd, -1);
    for (var i = 0; i < 20 && !this.isTradingDay(d); i++) d = this.addDays(d, -1);
    return d;
  },

  nextTradingDay: function (ymd) {
    var d = this.addDays(ymd, 1);
    for (var i = 0; i < 20 && !this.isTradingDay(d); i++) d = this.addDays(d, 1);
    return d;
  },

  /** The latest session that has finished (today counts after 15:30). */
  lastCompletedSession: function () {
    var today = this.ymd();
    if (this.isTradingDay(today) && this.minutes() >= 930) return today;
    return this.prevTradingDay(today);
  },

  /** Holidays in the next N days: [{ymd, name}] */
  upcomingHolidays: function (days) {
    var out = [], h = this.holidays(), today = this.ymd();
    for (var i = 1; i <= days; i++) {
      var d = this.addDays(today, i);
      if (h[d] && this.weekday(d) !== 0 && this.weekday(d) !== 6) out.push({ ymd: d, name: h[d] });
    }
    return out;
  },

  hasYear: function (year) {
    return Object.keys(this.holidays()).some(function (d) { return d.indexOf(String(year)) === 0; });
  },
};

/* ============================ Health and errors ============================ */

var Health = {
  /** Record a data or job event. Successes can be throttled to one row per N minutes. */
  log: function (job, source, ok, ms, items, detail, throttleMinutes) {
    try {
      if (ok && throttleMinutes) {
        var cache = CacheService.getScriptCache(), key = 'hl_' + job + '_' + source;
        if (cache.get(key)) return;
        cache.put(key, '1', throttleMinutes * 60);
      }
      Store.append('HealthLog', [[new Date(), job, source, ok ? 'OK' : 'FAIL', ms || 0, items || 0, Secrets.mask(detail || '').slice(0, 500)]]);
    } catch (e) {
      console.log('Could not write to HealthLog: ' + e.message);
    }
  },
};

var ErrorLog = {
  add: function (job, err) {
    try {
      Store.append('ErrorLog', [[new Date(), job, Secrets.mask((err && err.message) || err).slice(0, 1000), Secrets.mask((err && err.stack) || '').slice(0, 2000)]]);
    } catch (e) {
      console.log('Could not write to ErrorLog: ' + e.message);
    }
  },

  countToday: function () {
    var sh = Store.sheet('ErrorLog');
    if (!sh || sh.getLastRow() < 2) return 0;
    var today = MarketCal.ymd(), n = Math.min(200, sh.getLastRow() - 1);
    return sh.getRange(sh.getLastRow() - n + 1, 1, n, 1).getValues().filter(function (r) {
      return r[0] instanceof Date && MarketCal.ymd(r[0]) === today;
    }).length;
  },
};

/* ============================ Angel One SmartAPI ============================ */

var Angel = {
  BASE: 'https://apiconnect.angelone.in',
  ROUTES: {
    login: '/rest/auth/angelbroking/user/v1/loginByPassword',
    profile: '/rest/secure/angelbroking/user/v1/getProfile',
    quote: '/rest/secure/angelbroking/market/v1/quote/',
    candles: '/rest/secure/angelbroking/historical/v1/getCandleData',
    search: '/rest/secure/angelbroking/order/v1/searchScrip',
  },
  /** Bars per trading day and the documented maximum days per request. */
  INTERVALS: {
    ONE_MINUTE: { perDay: 375, maxDays: 30 },
    THREE_MINUTE: { perDay: 125, maxDays: 60 },
    FIVE_MINUTE: { perDay: 75, maxDays: 90 },
    TEN_MINUTE: { perDay: 38, maxDays: 90 },
    FIFTEEN_MINUTE: { perDay: 25, maxDays: 180 },
    THIRTY_MINUTE: { perDay: 13, maxDays: 180 },
    ONE_HOUR: { perDay: 7, maxDays: 365 },
    ONE_DAY: { perDay: 1, maxDays: 2000 },
  },
  MAX_ROWS: 480, // users report about 500 rows per request, so stay under it

  configured: function () {
    return ['ANGEL_CLIENT_CODE', 'ANGEL_PIN', 'ANGEL_API_KEY', 'ANGEL_TOTP_SECRET'].every(function (k) { return Secrets.has(k); });
  },

  headers: function (jwt) {
    var h = {
      'Accept': 'application/json',
      'X-UserType': 'USER',
      'X-SourceID': 'WEB',
      'X-ClientLocalIP': String(Config.get('angelLocalIp')),
      'X-ClientPublicIP': String(Config.get('angelPublicIp')),
      'X-MACAddress': String(Config.get('angelMac')),
      'X-PrivateKey': Secrets.get('ANGEL_API_KEY'),
    };
    if (jwt) h.Authorization = 'Bearer ' + jwt;
    return h;
  },

  session: function () {
    var p = Secrets.props();
    return { jwt: p.getProperty('ANGEL_JWT'), day: p.getProperty('ANGEL_JWT_DAY'), at: p.getProperty('ANGEL_LOGIN_AT') };
  },

  clearSession: function () {
    var p = Secrets.props();
    ['ANGEL_JWT', 'ANGEL_REFRESH', 'ANGEL_FEED', 'ANGEL_JWT_DAY', 'ANGEL_LOGIN_AT'].forEach(function (k) { p.deleteProperty(k); });
  },

  /** Log in, or reuse today's session. Angel One ends every session at midnight. */
  login: function (force) {
    if (!this.configured()) throw new Error('Angel One keys are not saved. Use Stock Radar → 2. Set up keys.');
    var s = this.session();
    if (!force && s.jwt && s.day === MarketCal.ymd()) return s.jwt;
    var self = this;
    var attempt = function () {
      if (Totp.secondsLeft() < 4) Utilities.sleep((Totp.secondsLeft() + 1) * 1000); // avoid a code that is about to expire
      var body = { clientcode: Secrets.get('ANGEL_CLIENT_CODE'), password: Secrets.get('ANGEL_PIN'), totp: Totp.code(Secrets.get('ANGEL_TOTP_SECRET')) };
      return Http.request(self.BASE + self.ROUTES.login, {
        method: 'post', contentType: 'application/json', headers: self.headers(null), payload: JSON.stringify(body),
      }, { retries: 1 });
    };
    var res = attempt();
    if (!this.ok(res) && /totp|otp/i.test(this.message(res))) {
      Utilities.sleep((Totp.secondsLeft() + 1) * 1000); // wait for a fresh code and try once more
      res = attempt();
    }
    if (!(this.ok(res) && res.json.data && res.json.data.jwtToken)) throw new Error('Angel One login failed: ' + this.message(res));
    var d = res.json.data;
    Secrets.props().setProperties({
      ANGEL_JWT: d.jwtToken, ANGEL_REFRESH: d.refreshToken || '', ANGEL_FEED: d.feedToken || '',
      ANGEL_JWT_DAY: MarketCal.ymd(), ANGEL_LOGIN_AT: new Date().toISOString(),
    });
    return d.jwtToken;
  },

  ok: function (res) { return !!(res && res.json && res.json.status === true); },

  message: function (res) {
    if (!res) return 'no response';
    if (res.json) {
      return (res.json.message || 'error') + (res.json.errorcode ? ' (' + res.json.errorcode + ')' : '') + (res.code && res.code !== 200 ? ' [HTTP ' + res.code + ']' : '');
    }
    return (res.code ? 'HTTP ' + res.code + ': ' : '') + Secrets.mask(String(res.text || '').slice(0, 200));
  },

  isAuthError: function (res) {
    if (res.code === 401 || res.code === 403) return true;
    var j = res.json || {};
    return /^(AG8001|AG8002|AG8003|AB1010|AB8050|AB8051)$/.test(j.errorcode || '') || /invalid token|token expired|session expired/i.test(j.message || '');
  },

  /** Authorised request with one automatic re-login. Returns the data field. */
  call: function (route, body, method) {
    var self = this, verb = method || 'post';
    var send = function (jwt) {
      var opts = { method: verb, headers: self.headers(jwt) };
      if (verb === 'post') { opts.contentType = 'application/json'; opts.payload = JSON.stringify(body || {}); }
      return Http.request(self.BASE + route, opts, { retries: 2 });
    };
    var res = send(this.login(false));
    if (this.isAuthError(res)) res = send(this.login(true));
    if (!this.ok(res)) {
      var err = new Error('Angel One ' + route.replace(/\/$/, '').split('/').pop() + ' failed: ' + this.message(res));
      err.noData = /no data/i.test(this.message(res));
      throw err;
    }
    return res.json.data;
  },

  profile: function () { return this.call(this.ROUTES.profile, null, 'get'); },

  /** Find NSE instruments by name, e.g. 'RELIANCE' → [{tradingsymbol:'RELIANCE-EQ', symboltoken:'2885'}]. */
  search: function (text) { return this.call(this.ROUTES.search, { exchange: 'NSE', searchscrip: text }) || []; },

  /** Token for an NSE stock's EQ series, found by search. */
  findToken: function (symbol) {
    var list = this.search(symbol);
    var hit = list.filter(function (r) { return r.tradingsymbol === symbol + '-EQ'; })[0] || list.filter(function (r) { return r.tradingsymbol === symbol + '-BE'; })[0];
    return hit ? { token: String(hit.symboltoken), angelSymbol: hit.tradingsymbol } : null;
  },

  /** Raw quotes for NSE tokens: 50 per request, one request per second. */
  quotes: function (tokens, mode) {
    var fetched = [], unfetched = [];
    for (var i = 0; i < tokens.length; i += 50) {
      if (i > 0) Utilities.sleep(1050);
      var data = this.call(this.ROUTES.quote, { mode: mode || 'FULL', exchangeTokens: { NSE: tokens.slice(i, i + 50) } });
      if (data && data.fetched) fetched = fetched.concat(data.fetched);
      if (data && data.unfetched) unfetched = unfetched.concat(data.unfetched);
    }
    return { fetched: fetched, unfetched: unfetched };
  },

  /** One quote in the engine's standard shape. */
  normQuote: function (q, symbol) {
    var n = function (v) { var x = Number(v); return v === '' || v === null || v === undefined || !isFinite(x) ? null : x; };
    var out = {
      symbol: symbol || String(q.tradingSymbol || '').replace(/-EQ$/, ''),
      token: String(q.symbolToken),
      ltp: n(q.ltp), open: n(q.open), high: n(q.high), low: n(q.low), prevClose: n(q.close),
      changePct: n(q.percentChange), volume: n(q.tradeVolume), avgPrice: n(q.avgPrice),
      high52: n(q['52WeekHigh']), low52: n(q['52WeekLow']),
      time: this.parseTime(q.exchFeedTime || q.exchTradeTime), source: 'angel',
    };
    if (out.changePct === null && out.ltp && out.prevClose) out.changePct = ((out.ltp - out.prevClose) / out.prevClose) * 100;
    return out;
  },

  /** '21-Feb-2024 10:41:02' (IST) → milliseconds */
  parseTime: function (s) {
    var m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(s || '').trim());
    if (!m) return null;
    var mon = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[2].toLowerCase()) + 1;
    if (!mon) return null;
    var pad = function (x) { return ('0' + x).slice(-2); };
    return new Date(m[3] + '-' + pad(mon) + '-' + pad(m[1]) + 'T' + m[4] + ':' + m[5] + ':' + m[6] + '+05:30').getTime();
  },

  /** Angel One candle rows [time, open, high, low, close, volume] → sorted candle objects. */
  parseCandles: function (data) {
    var rows = {};
    (data || []).forEach(function (r) {
      var t = new Date(r[0]).getTime();
      if (isFinite(t)) rows[t] = { t: t, o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[5]) || 0 };
    });
    return Object.keys(rows).map(Number).sort(function (a, b) { return a - b; }).map(function (t) { return rows[t]; });
  },

  /**
   * Candles for many instruments at once: three requests in parallel each second (Angel One allows 3 a second),
   * retrying any that are rate-limited. Each item is {key, token, from, to} and must fit in one request.
   * opts: {deadline (ms), batch, pause, onBatch}. Returns {data: {key: candles}, nodata: [keys], failed: {key: why}, left: [keys]}.
   */
  candlesMany: function (items, interval, opts) {
    opts = opts || {};
    var self = this, out = { data: {}, nodata: [], failed: {}, left: [] };
    if (!items.length) return out;
    var jwt = this.login(false), relogged = false, tries = {}, queue = items.slice(), batch = opts.batch || 3;
    var fmt = function (d) { return Utilities.formatDate(new Date(d), IST, 'yyyy-MM-dd HH:mm'); };
    while (queue.length) {
      if (opts.deadline && Date.now() > opts.deadline) { out.left = queue.map(function (it) { return it.key; }); break; }
      var group = queue.splice(0, batch), authFail = false;
      var reqs = group.map(function (it) {
        return {
          url: self.BASE + self.ROUTES.candles, method: 'post', contentType: 'application/json', headers: self.headers(jwt), muteHttpExceptions: true,
          payload: JSON.stringify({ exchange: 'NSE', symboltoken: String(it.token), interval: interval, fromdate: fmt(it.from), todate: fmt(it.to) }),
        };
      });
      var resps = [];
      try { resps = UrlFetchApp.fetchAll(reqs); } catch (e) { resps = []; }
      group.forEach(function (it, k) {
        var r = resps[k], res = { code: 0, text: '', json: null };
        if (r) {
          res.code = r.getResponseCode(); res.text = r.getContentText();
          try { res.json = JSON.parse(res.text); } catch (e) { res.json = null; }
        }
        if (self.ok(res)) { out.data[it.key] = self.parseCandles(res.json.data); return; }
        var msg = self.message(res);
        if (/no data/i.test(msg)) { out.nodata.push(it.key); return; }
        var limited = Http.retryable(res) || !r;
        if (!limited && self.isAuthError(res) && !relogged) { authFail = true; queue.push(it); return; }
        tries[it.key] = (tries[it.key] || 0) + 1;
        if (tries[it.key] < 4) queue.push(it); else out.failed[it.key] = msg;
      });
      if (authFail) { jwt = this.login(true); relogged = true; }
      if (opts.onBatch) opts.onBatch();
      if (queue.length) Utilities.sleep(opts.pause || 1100);
    }
    return out;
  },

  /** Candles between two dates, requested in chunks Angel One accepts, merged and sorted. */
  candles: function (token, interval, from, to) {
    var spec = this.INTERVALS[interval];
    if (!spec) throw new Error('Unknown candle interval: ' + interval);
    var chunkDays = Math.max(1, Math.min(spec.maxDays, Math.floor(this.MAX_ROWS / spec.perDay)));
    var rows = {}, start = new Date(from), end = new Date(to), calls = 0;
    while (start.getTime() <= end.getTime()) {
      var stop = new Date(Math.min(end.getTime(), start.getTime() + chunkDays * 86400000 - 60000));
      if (calls++ > 0) Utilities.sleep(360); // stay under 3 requests per second
      var data = [];
      try {
        data = this.call(this.ROUTES.candles, {
          exchange: 'NSE', symboltoken: String(token), interval: interval,
          fromdate: Utilities.formatDate(start, IST, 'yyyy-MM-dd HH:mm'), todate: Utilities.formatDate(stop, IST, 'yyyy-MM-dd HH:mm'),
        }) || [];
      } catch (e) {
        if (!e.noData) throw e; // a window with no trading days is fine
      }
      data.forEach(function (r) {
        var t = new Date(r[0]).getTime();
        if (isFinite(t)) rows[t] = { t: t, o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[5]) || 0 };
      });
      start = new Date(stop.getTime() + 60000);
    }
    return Object.keys(rows).map(Number).sort(function (a, b) { return a - b; }).map(function (t) { return rows[t]; });
  },
};

/* ======================== Google Finance (backup quotes) ======================== */

var GFinance = {
  ATTRS: ['price', 'priceopen', 'high', 'low', 'volume', 'closeyest', 'high52', 'low52', 'tradetime'],
  SHEET: '_gf',

  /** Current quotes through GOOGLEFINANCE formulas (about 15–20 minutes delayed). items: [{symbol, google}] */
  quotes: function (items) {
    items = items.filter(function (it) { return it.google; });
    if (!items.length) return [];
    var sh = Store.sheet(this.SHEET);
    if (!sh) { sh = Store.ss().insertSheet(this.SHEET); sh.hideSheet(); }
    sh.clearContents();
    var attrs = this.ATTRS;
    Store.ensureRows(sh, items.length);
    Store.ensureCols(sh, attrs.length);
    var formulas = items.map(function (it) {
      return attrs.map(function (a) { return '=GOOGLEFINANCE("' + String(it.google).replace(/"/g, '') + '","' + a + '")'; });
    });
    var range = sh.getRange(1, 1, items.length, attrs.length);
    range.setFormulas(formulas);
    SpreadsheetApp.flush();
    var values = range.getValues();
    var num = function (x) { return typeof x === 'number' && isFinite(x) ? x : null; };
    // Fresh formulas can show "Loading..." or #N/A for a moment; wait while any price is still missing.
    var waiting = function () {
      return values.some(function (r) { return /loading/i.test(String(r[0])) || num(r[0]) === null; });
    };
    for (var tryNo = 0; tryNo < 4 && waiting(); tryNo++) {
      Utilities.sleep(1500);
      SpreadsheetApp.flush();
      values = range.getValues();
    }
    return items.map(function (it, i) {
      var v = values[i];
      if (num(v[0]) === null) return null;
      var q = {
        symbol: it.symbol, ltp: num(v[0]), open: num(v[1]), high: num(v[2]), low: num(v[3]), volume: num(v[4]),
        prevClose: num(v[5]), high52: num(v[6]), low52: num(v[7]), time: v[8] instanceof Date ? v[8].getTime() : null,
        source: 'google', delayed: true, changePct: null,
      };
      if (q.ltp && q.prevClose) q.changePct = ((q.ltp - q.prevClose) / q.prevClose) * 100;
      return q;
    }).filter(Boolean);
  },
};

/* ======================== Yahoo Finance (last resort) ======================== */

var Yahoo = {
  BASE: 'https://query1.finance.yahoo.com/v8/finance/chart/',

  chart: function (ticker, range, interval) {
    var res = Http.request(this.BASE + encodeURIComponent(ticker) + '?range=' + range + '&interval=' + interval, { method: 'get', headers: { Accept: 'application/json' } }, { retries: 1 });
    var r = res.json && res.json.chart && res.json.chart.result && res.json.chart.result[0];
    if (!r) throw new Error('Yahoo Finance ' + ticker + ': ' + (res.code ? 'HTTP ' + res.code : String(res.text).slice(0, 120)));
    return r;
  },

  /** Quotes for up to 15 symbols (Yahoo throttles shared servers heavily). items: [{symbol, yahoo}] */
  quotes: function (items) {
    var out = [];
    items.filter(function (it) { return it.yahoo; }).slice(0, 15).forEach(function (it, i) {
      if (i) Utilities.sleep(300);
      try {
        var r = Yahoo.chart(it.yahoo, '5d', '1d'), m = r.meta || {}, q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
        var closes = (q.close || []).filter(function (c) { return c !== null; });
        var last = (q.close || []).length - 1;
        var ltp = Number(m.regularMarketPrice) || closes[closes.length - 1];
        var prev = closes.length > 1 ? closes[closes.length - 2] : null;
        out.push({
          symbol: it.symbol, ltp: ltp, open: q.open ? q.open[last] : null, high: q.high ? q.high[last] : null, low: q.low ? q.low[last] : null,
          volume: q.volume ? q.volume[last] : null, prevClose: prev, changePct: prev ? ((ltp - prev) / prev) * 100 : null,
          high52: m.fiftyTwoWeekHigh || null, low52: m.fiftyTwoWeekLow || null,
          time: m.regularMarketTime ? m.regularMarketTime * 1000 : null, source: 'yahoo', delayed: true,
        });
      } catch (e) { /* skip this symbol */ }
    });
    return out;
  },

  /** Daily candles for N years. */
  daily: function (ticker, years) {
    var r = this.chart(ticker, (years || 5) + 'y', '1d'), q = r.indicators.quote[0];
    return (r.timestamp || []).map(function (ts, i) {
      return { t: ts * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] || 0 };
    }).filter(function (c) { return c.c !== null && c.o !== null; });
  },
};

/* ============================ Kite Connect (future) ============================ */

/** Placeholder for the paid Zerodha data plan. Fill in when upgrading; the rest of the engine will not change. */
var Kite = {
  configured: function () { return false; },
  quotes: function () { throw new Error('Kite Connect is not set up. It is kept for a future paid upgrade.'); },
  candles: function () { throw new Error('Kite Connect is not set up. It is kept for a future paid upgrade.'); },
};

/* ============================ Data with failover ============================ */

var Data = {
  /** Latest quotes, trying Angel One, then Google Finance, then Yahoo for anything still missing. */
  quotes: function (symbols, job, throttleMinutes) {
    var meta = SymbolsDb.lookup(symbols);
    var want = symbols.filter(function (s) { return meta[s]; });
    var result = {}, used = [], problems = [];
    var missing = want.slice();
    var steps = [
      { name: 'angel', ready: Angel.configured(), run: function (list) { return Data.angelQuotes(list, meta); } },
      { name: 'google', ready: true, run: function (list) { return GFinance.quotes(list.map(function (s) { return { symbol: s, google: meta[s].google }; })); } },
      { name: 'yahoo', ready: true, run: function (list) { return Yahoo.quotes(list.map(function (s) { return { symbol: s, yahoo: meta[s].yahoo }; })); } },
    ];
    for (var i = 0; i < steps.length && missing.length; i++) {
      var step = steps[i];
      if (!step.ready) continue;
      var t0 = Date.now();
      try {
        var got = step.run(missing) || [];
        var added = 0;
        got.forEach(function (q) {
          if (q && q.ltp > 0 && !result[q.symbol] && missing.indexOf(q.symbol) >= 0) { result[q.symbol] = q; added++; }
        });
        if (added) used.push(step.name);
        Health.log(job || 'quotes', step.name, added > 0, Date.now() - t0, added, added ? '' : 'no prices returned', throttleMinutes);
      } catch (e) {
        problems.push(step.name + ': ' + e.message);
        Health.log(job || 'quotes', step.name, false, Date.now() - t0, 0, e.message);
      }
      missing = want.filter(function (s) { return !result[s]; });
    }
    // Mark prices that are too old to act on during market hours.
    var open = MarketCal.marketState() === 'open', maxAge = Number(Config.get('staleQuoteSeconds')) * 1000, now = Date.now();
    Object.keys(result).forEach(function (s) {
      var q = result[s];
      q.stale = open && (q.delayed || (q.time && now - q.time > maxAge)) ? true : false;
    });
    return { quotes: result, missing: missing.concat(symbols.filter(function (s) { return !meta[s]; })), sources: used, problems: problems };
  },

  angelQuotes: function (list, meta) {
    var bySymbolToken = {};
    var tokens = [];
    list.forEach(function (s) {
      var tk = meta[s] && meta[s].angelToken;
      if (tk) { bySymbolToken[String(tk)] = s; tokens.push(String(tk)); }
    });
    if (!tokens.length) return [];
    return Angel.quotes(tokens, 'FULL').fetched.map(function (q) { return Angel.normQuote(q, bySymbolToken[String(q.symbolToken)]); });
  },

  /** Compare Angel One with Google Finance and flag gaps larger than the crossCheckPct setting. */
  crossCheck: function (symbols) {
    var meta = SymbolsDb.lookup(symbols);
    var list = symbols.filter(function (s) { return meta[s]; });
    var a = Angel.configured() ? this.angelQuotes(list, meta) : [];
    var g = GFinance.quotes(list.map(function (s) { return { symbol: s, google: meta[s].google }; }));
    var gm = {};
    g.forEach(function (q) { gm[q.symbol] = q; });
    var limit = Number(Config.get('crossCheckPct'));
    return a.map(function (q) {
      var o = gm[q.symbol];
      if (!o || !o.ltp || !q.ltp) return null;
      var diff = ((q.ltp - o.ltp) / o.ltp) * 100;
      return { symbol: q.symbol, angel: q.ltp, google: o.ltp, diffPct: diff, flag: Math.abs(diff) > limit };
    }).filter(Boolean);
  },
};

/* ============================== Stock lists ============================== */

var SYMBOL_HEADERS = ['symbol', 'name', 'type', 'angelToken', 'angelSymbol', 'google', 'yahoo', 'sector', 'nifty50', 'nifty200', 'nifty500', 'updatedAt'];

/** Indices with their Angel One tokens (from the SmartAPI forum) and backup tickers. */
var INDEX_LIST = [
  ['NIFTY 50', 'Nifty 50', '99926000', 'INDEXNSE:NIFTY_50', '^NSEI'],
  ['INDIA VIX', 'India VIX', '99926017', 'INDEXNSE:INDIA_VIX', '^INDIAVIX'],
  ['NIFTY BANK', 'Nifty Bank', '99926009', 'INDEXNSE:NIFTY_BANK', '^NSEBANK'],
  ['NIFTY 200', 'Nifty 200', '99926033', '', ''],
  ['NIFTY 500', 'Nifty 500', '99926004', '', ''],
  ['NIFTY NEXT 50', 'Nifty Next 50', '99926013', '', ''],
  ['NIFTY MIDCAP 100', 'Nifty Midcap 100', '99926011', '', ''],
  ['NIFTY IT', 'Nifty IT', '99926008', '', ''],
  ['NIFTY PHARMA', 'Nifty Pharma', '99926023', '', ''],
  ['NIFTY FMCG', 'Nifty FMCG', '99926021', '', ''],
  ['NIFTY AUTO', 'Nifty Auto', '99926029', '', ''],
  ['NIFTY METAL', 'Nifty Metal', '99926030', '', ''],
  ['NIFTY REALTY', 'Nifty Realty', '99926018', '', ''],
  ['NIFTY ENERGY', 'Nifty Energy', '99926020', '', ''],
  ['NIFTY PSU BANK', 'Nifty PSU Bank', '99926025', '', ''],
  ['NIFTY FIN SERVICE', 'Nifty Financial Services', '99926037', '', ''],
];

var CORE_ETFS = [
  ['NIFTYBEES', 'Nippon India ETF Nifty 50 BeES', 'Index ETF'],
  ['JUNIORBEES', 'Nippon India ETF Nifty Next 50 Junior BeES', 'Index ETF'],
  ['GOLDBEES', 'Nippon India ETF Gold BeES', 'Gold ETF'],
];

var SymbolsDb = {
  _map: null,

  /** Every known symbol: the Symbols sheet plus the built-in index list. */
  load: function () {
    if (this._map) return this._map;
    var map = {};
    INDEX_LIST.forEach(function (r) {
      map[r[0]] = { symbol: r[0], name: r[1], type: 'INDEX', angelToken: r[2], angelSymbol: r[1], google: r[3], yahoo: r[4], sector: 'Index', nifty50: false, nifty200: false, nifty500: false };
    });
    Store.readObjects('Symbols').forEach(function (o) {
      var sym = String(o.symbol || '').trim().toUpperCase();
      if (!sym) return;
      o.symbol = sym;
      o.angelToken = o.angelToken === '' ? '' : String(o.angelToken);
      ['nifty50', 'nifty200', 'nifty500'].forEach(function (k) { o[k] = o[k] === true || String(o[k]).toUpperCase() === 'TRUE'; });
      map[sym] = o;
    });
    this._map = map;
    return map;
  },

  count: function () {
    var all = this.load();
    return Object.keys(all).filter(function (k) { return all[k].type !== 'INDEX'; }).length;
  },

  /** Rows for the given symbols. Unknown stocks are looked up on Angel One and added to the sheet. */
  lookup: function (symbols) {
    var map = this.load(), out = {}, added = [];
    var self = this;
    symbols.forEach(function (raw) {
      var s = String(raw).trim().toUpperCase();
      if (map[s]) { out[raw] = map[s]; return; }
      if (!/^[A-Z0-9&-]{1,20}$/.test(s)) return;
      var row = self.newRow(s, '', 'EQ', '');
      if (Angel.configured()) {
        try { var hit = Angel.findToken(s); if (hit) { row.angelToken = hit.token; row.angelSymbol = hit.angelSymbol; } } catch (e) { /* use backups */ }
      }
      map[s] = row;
      out[raw] = row;
      added.push(row);
    });
    if (added.length && Store.sheet('Symbols')) Store.append('Symbols', added);
    return out;
  },

  newRow: function (symbol, name, type, sector) {
    return {
      symbol: symbol, name: name || symbol, type: type, angelToken: '', angelSymbol: '',
      google: 'NSE:' + symbol, yahoo: symbol + '.NS', sector: sector || '',
      nifty50: false, nifty200: false, nifty500: false, updatedAt: new Date(),
    };
  },

  /** Symbols that belong to an index list such as NIFTY50, NIFTY200 or NIFTY500. */
  universe: function (name) {
    var key = String(name || '').toLowerCase().replace(/\s/g, '');
    var all = this.load();
    return Object.keys(all).filter(function (s) { return all[s][key] === true; });
  },

  /**
   * Rebuild the Symbols sheet: Nifty 50/200/500 lists, core ETFs, indices, watchlist,
   * with Angel One tokens from the instrument list (or symbol search as a fallback).
   */
  rebuild: function () {
    var t0 = Date.now();
    var report = { lists: {}, tokenSource: '', tokensFound: 0, tokensMissing: [], stocks: 0, etfs: CORE_ETFS.length, indices: INDEX_LIST.length };
    var existing = {};
    Store.readObjects('Symbols').forEach(function (o) { if (o.symbol) existing[String(o.symbol).toUpperCase()] = o; });

    var all = {};
    ['NIFTY500', 'NIFTY200', 'NIFTY50'].forEach(function (ix) {
      var got = Constituents.get(ix);
      report.lists[ix] = { count: got.rows.length, source: got.source, error: got.error || '' };
      var flag = 'nifty' + ix.slice(5);
      if (got.rows.length) {
        got.rows.forEach(function (r) {
          var row = all[r.symbol] || (all[r.symbol] = SymbolsDb.newRow(r.symbol, r.name, 'EQ', r.industry));
          row[flag] = true;
          if (!row.sector && r.industry) row.sector = r.industry;
        });
      } else {
        // List unavailable today: keep the memberships saved last time.
        Object.keys(existing).forEach(function (s) {
          var e = existing[s];
          if (e[flag] === true || String(e[flag]).toUpperCase() === 'TRUE') {
            var row = all[s] || (all[s] = SymbolsDb.newRow(s, e.name, e.type || 'EQ', e.sector));
            row[flag] = true;
          }
        });
      }
    });
    CORE_ETFS.forEach(function (e) { all[e[0]] = all[e[0]] || SymbolsDb.newRow(e[0], e[1], 'ETF', e[2]); all[e[0]].type = 'ETF'; });
    Config.symbols('watchlist').forEach(function (s) { if (!all[s]) all[s] = SymbolsDb.newRow(s, existing[s] ? existing[s].name : s, 'EQ', existing[s] ? existing[s].sector : ''); });
    report.stocks = Object.keys(all).filter(function (s) { return all[s].type === 'EQ'; }).length;

    // Tokens: keep the ones found before, then look up the rest with fast parallel searches.
    // The big instrument file is only used when useInstrumentMaster is TRUE in Config (it can be too slow).
    var master = null;
    if (Config.get('useInstrumentMaster')) {
      try { master = InstrumentMaster.nseEquity(); report.tokenSource = 'Angel One instrument list'; }
      catch (e) { report.tokenSource = 'symbol search (instrument list unavailable: ' + e.message + ')'; }
    } else {
      report.tokenSource = 'symbol search';
    }
    var needSearch = [];
    Object.keys(all).forEach(function (s) {
      var row = all[s];
      var m = master && master.map[s];
      if (m) { row.angelToken = m.token; row.angelSymbol = m.angelSymbol; }
      else if (existing[s] && existing[s].angelToken) { row.angelToken = String(existing[s].angelToken); row.angelSymbol = existing[s].angelSymbol; }
      else needSearch.push(s);
    });

    var order = { ETF: 0, EQ: 1 };
    var indexRows = INDEX_LIST.map(function (r) {
      return { symbol: r[0], name: r[1], type: 'INDEX', angelToken: r[2], angelSymbol: r[1], google: r[3], yahoo: r[4], sector: 'Index', nifty50: false, nifty200: false, nifty500: false, updatedAt: new Date() };
    });
    var save = function () {
      var list = Object.keys(all).map(function (s) { return all[s]; }).sort(function (a, b) {
        return (order[a.type] - order[b.type]) || (a.symbol < b.symbol ? -1 : 1);
      });
      Store.replaceAll('Symbols', indexRows.concat(list));
      return list;
    };
    save(); // the lists are saved even if the token search is cut short

    if (needSearch.length && Angel.configured()) {
      var jwt = Angel.login(false);
      var queue = needSearch.slice(), tries = {}, batch = 4, rounds = 0; // gentle: Angel One rejects bursts
      while (queue.length) {
        if (Date.now() - t0 > 200000) { report.tokensMissing = report.tokensMissing.concat(queue); break; } // stay inside the 6-minute limit
        var group = queue.splice(0, batch);
        var reqs = group.map(function (sym) {
          return { url: Angel.BASE + Angel.ROUTES.search, method: 'post', contentType: 'application/json', headers: Angel.headers(jwt), payload: JSON.stringify({ exchange: 'NSE', searchscrip: sym }), muteHttpExceptions: true };
        });
        var resps = [];
        try { resps = UrlFetchApp.fetchAll(reqs); } catch (e) { resps = []; }
        group.forEach(function (sym, k) {
          var j = null;
          try { j = JSON.parse(resps[k].getContentText()); } catch (e) { j = null; }
          if (j && j.status === true) {
            var list = j.data || [];
            var hit = list.filter(function (r) { return r.tradingsymbol === sym + '-EQ'; })[0] || list.filter(function (r) { return r.tradingsymbol === sym + '-BE'; })[0];
            if (hit) { all[sym].angelToken = String(hit.symboltoken); all[sym].angelSymbol = hit.tradingsymbol; }
            else report.tokensMissing.push(sym); // Angel One really has no such NSE stock
          } else {
            tries[sym] = (tries[sym] || 0) + 1; // rate limit or a hiccup: try again later
            if (tries[sym] < 4) queue.push(sym); else report.tokensMissing.push(sym);
          }
        });
        if (++rounds % 15 === 0) save(); // save progress now and then
        Utilities.sleep(1100);
      }
    } else if (needSearch.length) {
      report.tokensMissing = needSearch;
    }
    var rows = save();
    this._map = null;
    report.tokensFound = rows.filter(function (r) { return r.angelToken; }).length;
    report.seconds = Math.round((Date.now() - t0) / 1000);
    return report;
  },
};

/** Index member lists published by NSE. */
var Constituents = {
  FILES: { NIFTY50: 'ind_nifty50list.csv', NIFTY200: 'ind_nifty200list.csv', NIFTY500: 'ind_nifty500list.csv' },
  HOSTS: ['https://niftyindices.com/IndexConstituent/', 'https://archives.nseindia.com/content/indices/', 'https://nsearchives.nseindia.com/content/indices/'],
  MIN: { NIFTY50: 45, NIFTY200: 180, NIFTY500: 450 },

  _blocked: false, // set once NSE's servers stop answering, so later lists don't wait again

  /** {rows:[{symbol, name, industry}], source, error} — an imported sheet first, then NSE online. */
  get: function (ix) {
    var imported = this.fromSheet(ix);
    if (imported.rows.length >= this.MIN[ix]) return { rows: imported.rows, source: 'sheet "' + imported.name + '"' };
    if (this._blocked) return { rows: [], source: '', error: 'NSE did not answer Google\'s servers earlier in this run' };
    var errors = [];
    for (var i = 0; i < this.HOSTS.length; i++) {
      var url = this.HOSTS[i] + this.FILES[ix], host = url.split('/')[2], t0 = Date.now();
      var res = Http.request(url, { method: 'get', headers: { Accept: 'text/csv,*/*' } }, { retries: 0 });
      if (res.code === 200) {
        var rows = this.parse(Utilities.parseCsv(String(res.text).replace(/^\uFEFF/, '')));
        if (rows.length >= this.MIN[ix]) return { rows: rows, source: host };
        errors.push(host + ' sent only ' + rows.length + ' rows');
      } else {
        errors.push(host + (res.code ? ' HTTP ' + res.code : ' unreachable'));
      }
      if (Date.now() - t0 > 15000) { this._blocked = true; break; } // a slow host means NSE is blocking us; stop waiting
    }
    if (errors.length === this.HOSTS.length || this._blocked) this._blocked = true;
    return { rows: [], source: '', error: errors.join('; ') };
  },

  parse: function (grid) {
    if (!grid || !grid.length) return [];
    var head = grid[0].map(function (h) { return String(h).trim().toLowerCase(); });
    var iSym = head.indexOf('symbol'), iName = head.indexOf('company name'), iInd = head.indexOf('industry'), iSer = head.indexOf('series');
    if (iSym < 0) return [];
    return grid.slice(1).filter(function (r) {
      return r[iSym] && (iSer < 0 || String(r[iSer]).trim().toUpperCase() === 'EQ');
    }).map(function (r) {
      return { symbol: String(r[iSym]).trim().toUpperCase(), name: iName >= 0 ? String(r[iName]).trim() : '', industry: iInd >= 0 ? String(r[iInd]).trim() : '' };
    });
  },

  /** A list imported by hand: File → Import → Upload the CSV → Insert new sheet. */
  fromSheet: function (ix) {
    var names = ['Import ' + ix, this.FILES[ix].replace('.csv', '')];
    for (var i = 0; i < names.length; i++) {
      var sh = Store.sheet(names[i]);
      if (sh && sh.getLastRow() > 1) return { name: names[i], rows: this.parse(sh.getDataRange().getValues()) };
    }
    return { name: '', rows: [] };
  },
};

/** Angel One's full instrument list, filtered to NSE stocks. */
var InstrumentMaster = {
  URL: 'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json',

  nseEquity: function () {
    var t0 = Date.now();
    var res = UrlFetchApp.fetch(this.URL, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw new Error('HTTP ' + res.getResponseCode());
    var text = res.getContentText();
    var map = {}, count = 0, re = /\{[^{}]*\}/g, m;
    var seg = /"exch_seg"\s*:\s*"NSE"/;
    while ((m = re.exec(text)) !== null) {
      var s = m[0];
      if (s.indexOf('-EQ"') < 0 || !seg.test(s)) continue;
      try {
        var o = JSON.parse(s);
        if (o.exch_seg === 'NSE' && /-EQ$/.test(o.symbol)) {
          map[String(o.symbol).replace(/-EQ$/, '')] = { token: String(o.token), angelSymbol: o.symbol, name: o.name };
          count++;
        }
      } catch (e) { /* skip a malformed entry */ }
    }
    if (count < 1000) throw new Error('only ' + count + ' NSE stocks found');
    return { map: map, count: count, bytes: text.length, ms: Date.now() - t0 };
  },
};
