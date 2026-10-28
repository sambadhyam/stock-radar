/**
 * Stock Radar — Signals.gs
 * Price history in your Google Drive, the market regime, the end-of-day and intraday scans,
 * and the Alerts log with its Telegram messages. The trading rules themselves live in Core.gs.
 *
 * Price history: one folder "Stock Radar Data" in your Drive with 12 small JSON files
 * (daily-00.json … daily-11.json). Each holds the daily candles of about 45 stocks.
 * Drive is used through its web API with the "drive.file" permission, so this script can only
 * see the files it created itself, never the rest of your Drive.
 */

/* ============================== Google Drive (own files only) ============================== */

var DriveFiles = {
  API: 'https://www.googleapis.com/drive/v3/files',
  UPLOAD: 'https://www.googleapis.com/upload/drive/v3/files',
  FOLDER_TYPE: 'application/vnd.google-apps.folder',

  /** One Drive API request with retries. Returns {code, text, json}; throws a plain-English error on failure. */
  call: function (method, url, payload) {
    var opts = { method: method, headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } };
    if (payload !== undefined) { opts.payload = payload; opts.contentType = 'application/json'; }
    // Creating is not retried, so a slow answer can never make two folders or files.
    var res = Http.request(url, opts, { retries: method === 'post' ? 0 : 2 });
    if (res.code >= 200 && res.code < 300) return res;
    throw new Error('Google Drive: ' + this.why(res));
  },

  why: function (res) {
    var e = res.json && res.json.error, msg = e && e.message ? e.message : String(res.text || '').slice(0, 200);
    var all = msg + ' ' + JSON.stringify(e || {});
    if (/has not been used|is disabled|accessNotConfigured|SERVICE_DISABLED/i.test(all)) {
      return 'the Drive API is not switched on for this script. In Apps Script, click + next to Services, choose Drive API, then Add. (' + msg + ')';
    }
    if (res.code === 403 && /insufficient|scope|permission/i.test(all)) {
      return 'Drive permission is missing. Paste the latest appsscript.json, then run Stock Radar → 6. Load price history and allow access. (' + msg + ')';
    }
    return (res.code ? 'HTTP ' + res.code + ': ' : '') + msg;
  },

  /** Files or folders this script created that match a Drive search, as [{id, name}]. */
  find: function (query) {
    var url = this.API + '?q=' + encodeURIComponent(query) + '&fields=' + encodeURIComponent('files(id,name)') + '&pageSize=100&spaces=drive';
    return this.call('get', url).json.files || [];
  },

  exists: function (id) {
    try { var r = this.call('get', this.API + '/' + encodeURIComponent(id) + '?fields=id,trashed'); return !!(r.json && r.json.id && !r.json.trashed); }
    catch (e) { if (/HTTP 404/.test(e.message)) return false; throw e; }
  },

  createFolder: function (name) {
    return this.call('post', this.API + '?fields=id', JSON.stringify({ name: name, mimeType: this.FOLDER_TYPE })).json.id;
  },

  createFile: function (folderId, name, text) {
    var id = this.call('post', this.API + '?fields=id', JSON.stringify({ name: name, parents: [folderId], mimeType: 'application/json' })).json.id;
    this.write(id, text);
    return id;
  },

  /** A JSON file's content, parsed. Throws if it cannot be read, so a failed read never looks like an empty file. */
  readJson: function (id) {
    var r = this.call('get', this.API + '/' + encodeURIComponent(id) + '?alt=media');
    if (!r.json) throw new Error('Google Drive: file ' + id + ' is not valid JSON (' + String(r.text || '').slice(0, 60) + ')');
    return r.json;
  },

  write: function (id, text) {
    this.call('patch', this.UPLOAD + '/' + encodeURIComponent(id) + '?uploadType=media', text);
  },
};

/* ============================== Price history ============================== */

var History = {
  FOLDER: 'Stock Radar Data',
  PACKS: 12,
  KEEP: 2600,                // up to about 10 years of daily candles per stock
  INDICES: ['NIFTY 50', 'INDIA VIX', 'NIFTY BANK'],
  _folderId: null,
  _ids: null,
  _packs: {},
  _dirty: {},

  /** The "Stock Radar Data" folder this script made (created on first use). */
  folderId: function () {
    if (this._folderId) return this._folderId;
    var p = Secrets.props(), id = p.getProperty('HIST_FOLDER_ID');
    if (!(id && DriveFiles.exists(id))) {
      var found = DriveFiles.find("name = '" + this.FOLDER + "' and mimeType = '" + DriveFiles.FOLDER_TYPE + "' and trashed = false");
      id = found.length ? found[0].id : DriveFiles.createFolder(this.FOLDER);
      p.setProperty('HIST_FOLDER_ID', id);
      this._ids = null;
    }
    this._folderId = id;
    return id;
  },

  /** File name → id for the files in the folder (one request per run). */
  fileIds: function () {
    if (this._ids) return this._ids;
    var ids = {};
    DriveFiles.find("'" + this.folderId() + "' in parents and trashed = false").forEach(function (f) { ids[f.name] = f.id; });
    this._ids = ids;
    return ids;
  },

  /** Which of the 12 files a symbol lives in (a fixed hash, so no index file is needed). */
  packOf: function (symbol) {
    var h = 5381, s = String(symbol);
    for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h % this.PACKS;
  },

  fileName: function (p) { return 'daily-' + (p < 10 ? '0' : '') + p + '.json'; },

  pack: function (p) {
    if (this._packs[p]) return this._packs[p];
    var id = this.fileIds()[this.fileName(p)];
    var data = id ? DriveFiles.readJson(id) : { v: 1, s: {} };
    if (!data.s) throw new Error('Google Drive: ' + this.fileName(p) + ' is not a Stock Radar price file');
    this._packs[p] = data;
    return data;
  },

  flush: function () {
    var self = this, written = 0, ids = this.fileIds();
    Object.keys(this._dirty).forEach(function (k) {
      var p = Number(k), name = self.fileName(p), json = JSON.stringify(self._packs[p]);
      if (ids[name]) DriveFiles.write(ids[name], json);
      else ids[name] = DriveFiles.createFile(self.folderId(), name, json);
      written++;
    });
    this._dirty = {};
    return written;
  },

  /** Forget what was read in this run (tests use this; the next read comes from Drive again). */
  reset: function () { this._packs = {}; this._dirty = {}; this._folderId = null; this._ids = null; },

  rec: function (symbol) { return this.pack(this.packOf(symbol)).s[symbol] || null; },
  has: function (symbol) { return !!this.rec(symbol); },

  /** Daily candles, oldest first, as {t, o, h, l, c, v}. */
  get: function (symbol) {
    var r = this.rec(symbol);
    if (!r || !r.d || !r.d.length) return [];
    var out = new Array(r.d.length);
    for (var i = 0; i < r.d.length; i++) out[i] = { t: History.dayToMs(r.d[i]), o: r.o[i], h: r.h[i], l: r.l[i], c: r.c[i], v: r.v[i] };
    return out;
  },

  /** yyyymmdd of the newest candle, or 0. */
  lastDay: function (symbol) {
    var r = this.rec(symbol);
    return r && r.d && r.d.length ? r.d[r.d.length - 1] : 0;
  },

  /** Merge candles in (same day replaces), keep the newest KEEP. */
  put: function (symbol, candles) {
    var p = this.packOf(symbol), pk = this.pack(p), old = pk.s[symbol], map = {};
    if (old && old.d) for (var i = 0; i < old.d.length; i++) map[old.d[i]] = [old.o[i], old.h[i], old.l[i], old.c[i], old.v[i]];
    (candles || []).forEach(function (c) {
      if (!(c.c > 0)) return;
      var r2 = function (x) { return Math.round(x * 100) / 100; };
      map[History.msToDay(c.t)] = [r2(c.o), r2(c.h), r2(c.l), r2(c.c), Math.round(c.v || 0)];
    });
    var days = Object.keys(map).map(Number).sort(function (a, b) { return a - b; }).slice(-this.KEEP);
    var rec = { d: days, o: [], h: [], l: [], c: [], v: [] };
    days.forEach(function (d) { var x = map[d]; rec.o.push(x[0]); rec.h.push(x[1]); rec.l.push(x[2]); rec.c.push(x[3]); rec.v.push(x[4]); });
    if (!days.length) rec.none = 1; // looked up, but Angel One has no daily candles for it
    pk.s[symbol] = rec;
    this._dirty[p] = true;
  },

  /** Read every file once and return how many symbols have candles and the newest day. */
  summary: function () {
    var n = 0, last = 0;
    for (var p = 0; p < this.PACKS; p++) {
      var s = this.pack(p).s;
      Object.keys(s).forEach(function (k) { if (s[k].d && s[k].d.length) { n++; last = Math.max(last, s[k].d[s[k].d.length - 1]); } });
    }
    return { symbols: n, last: last };
  },

  saveMeta: function () {
    var s = this.summary();
    Secrets.props().setProperty('HIST_META', JSON.stringify({ symbols: s.symbols, last: s.last, at: new Date().toISOString() }));
    return s;
  },
  meta: function () { try { return JSON.parse(Secrets.props().getProperty('HIST_META') || 'null'); } catch (e) { return null; } },

  /** yyyymmdd for the IST calendar day of a timestamp (plain arithmetic: thousands of calls must stay fast). */
  msToDay: function (t) {
    var d = new Date(Math.floor((t + 330 * 60000) / 86400000) * 86400000);
    return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
  },
  /** Midnight IST of a yyyymmdd day, in milliseconds. */
  dayToMs: function (d) {
    return Date.UTC(Math.floor(d / 10000), Math.floor(d / 100) % 100 - 1, d % 100) - 330 * 60000;
  },
  ymdToDay: function (ymd) { return Number(String(ymd).replace(/-/g, '')); },
  dayToYmd: function (d) { var s = String(d); return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8); },
};

/* ============================== Loading history ============================== */

var Backfill = {
  /** Everything with an Angel One token: the indices used by the regime first, then stocks and ETFs. */
  targets: function () {
    var all = SymbolsDb.load(), out = [];
    History.INDICES.forEach(function (s) { if (all[s] && all[s].angelToken) out.push({ key: s, token: String(all[s].angelToken) }); });
    Object.keys(all).sort().forEach(function (s) {
      var r = all[s];
      if (r.type !== 'INDEX' && r.angelToken) out.push({ key: s, token: String(r.angelToken) });
    });
    return out;
  },

  fromDate: function (days) {
    var d = MarketCal.at(MarketCal.ymd(), '09:15');
    return new Date(d.getTime() - days * 86400000);
  },

  /** Load full history for symbols that have none yet, until the deadline. */
  step: function (deadline) {
    var missing = this.targets().filter(function (it) { return !History.has(it.key); });
    if (!missing.length) return { loaded: 0, noData: 0, failed: 0, remaining: 0 };
    var from = this.fromDate(Number(Config.get('historyDays')) || 660), to = MarketCal.now();
    missing.forEach(function (it) { it.from = from; it.to = to; });
    var res = Angel.candlesMany(missing, 'ONE_DAY', { deadline: deadline, onBatch: function () { History.saveNowAndThen(); } });
    var loaded = 0;
    Object.keys(res.data).forEach(function (k) { History.put(k, res.data[k]); loaded++; });
    res.nodata.forEach(function (k) { History.put(k, []); });
    History.flush();
    var meta = History.saveMeta();
    var failed = Object.keys(res.failed);
    if (failed.length) Health.log('history', 'angel', false, 0, failed.length, 'No candles for ' + failed.slice(0, 10).join(', ') + (failed.length > 10 ? '…' : '') + ': ' + res.failed[failed[0]]);
    return { loaded: loaded, noData: res.nodata.length, failed: failed.length, remaining: res.left.length + failed.length, symbols: meta.symbols, last: meta.last };
  },
};

/** During a long load, write to Drive at most every 90 seconds (each file is about 1 MB, so writing after every request would be slow). */
History.saveNowAndThen = function () {
  if (!this._lastSave) this._lastSave = Date.now();
  if (Date.now() - this._lastSave < 90000) return;
  this.flush();
  this._lastSave = Date.now();
};

/* ============================== Market regime ============================== */

var Market = {
  /** Work out the regime from the history in Drive and save it. */
  computeRegime: function (P) {
    P = P || Scans.params();
    var nifty = History.get('NIFTY 50'), vix = History.get('INDIA VIX');
    var universe = SymbolsDb.universe(Config.get('swingUniverse') || 'NIFTY200');
    var series = universe.map(function (s) { return History.get(s); });
    var reg = SRCore.regime(nifty, vix, SRCore.breadth(series), P);
    reg.asOfDay = nifty.length ? History.msToDay(nifty[nifty.length - 1].t) : 0;
    reg.at = new Date().toISOString();
    Secrets.props().setProperty('REGIME', JSON.stringify(reg));
    return reg;
  },

  saved: function () { try { return JSON.parse(Secrets.props().getProperty('REGIME') || 'null'); } catch (e) { return null; } },

  /** One line for messages, e.g. "Bull (Nifty above its 200-day average …)". */
  line: function (reg) {
    if (!reg) return '❔ Market regime: not worked out yet.';
    return this.icon(reg.state) + ' Market regime: <b>' + SRCore.regimeName(reg.state) + '</b>. ' + Notify.esc(reg.reasons.join(' '));
  },
  /** 🐂 Bull, 🐻 Bear, ⚖️ Neutral, 🌪️ High volatility, ❔ not known yet. */
  icon: function (state) { return { BULL: '🐂', BEAR: '🐻', NEUTRAL: '⚖️', HIGH_VOL: '🌪️' }[state] || '❔'; },

  /** Stocks watched intraday: the intraday index plus the watchlist, up to the configured limit. */
  intradaySymbols: function () {
    var list = SymbolsDb.universe(Config.get('intradayUniverse') || 'NIFTY50');
    Config.symbols('watchlist').forEach(function (s) { if (list.indexOf(s) < 0) list.push(s); });
    return list.slice(0, Math.max(1, Number(Config.get('intradayMaxSymbols')) || 60));
  },

  /** Yesterday's close and average traded value for each intraday stock, saved for the day's scans. */
  prepareIntraday: function (today) {
    var ctx = { day: today, s: {} }, prev = History.ymdToDay(MarketCal.prevTradingDay(today)), stale = 0;
    this.intradaySymbols().forEach(function (sym) {
      var k = History.get(sym);
      if (!k.length) return;
      if (History.msToDay(k[k.length - 1].t) < prev) stale++;
      ctx.s[sym] = [k[k.length - 1].c, Math.round((SRCore.liquidityCr(k) || 0) * 10) / 10];
    });
    ctx.stale = stale;
    var json = JSON.stringify(ctx);
    if (json.length < 8500) Secrets.props().setProperty('INTRA_CTX', json);
    return ctx;
  },

  intraCtx: function (today) {
    var c = null;
    try { c = JSON.parse(Secrets.props().getProperty('INTRA_CTX') || 'null'); } catch (e) { c = null; }
    return c && c.day === today ? c : null;
  },
};

/* ============================== Strategy settings ============================== */

var StrategyBook = {
  _map: null,
  STATUSES: ['PAPER', 'LIVE_READY', 'REJECTED'],

  /** Add a row to the Strategies sheet for any strategy it does not list yet. Returns how many were added. */
  seed: function () {
    var sh = Store.sheet('Strategies');
    if (!sh) return 0;
    var have = {};
    Store.readObjects('Strategies').forEach(function (r) { if (r.id) have[String(r.id)] = true; });
    var add = SRCore.STRATEGIES.filter(function (s) { return !have[s.id]; }).map(function (s) {
      return { id: s.id, name: s.name, horizon: s.horizon, enabled: true, status: 'PAPER', override: '', trades: 0, wins: 0, losses: 0, flats: 0, updatedAt: new Date(), statusSince: new Date() };
    });
    if (add.length) Store.append('Strategies', add);
    this._map = null;
    return add.length;
  },

  load: function () {
    if (this._map) return this._map;
    var map = {}, rows = {}, off = Config.list('strategiesOff');
    try { this.seed(); } catch (e) { /* sheet missing: defaults below */ }
    Store.readObjects('Strategies').forEach(function (r) { if (r.id) rows[String(r.id)] = r; });
    var bool = function (v) { return !(v === false || /^(false|no|0|off)$/i.test(String(v).trim())); };
    var self = this;
    SRCore.STRATEGIES.forEach(function (s) {
      var r = rows[s.id] || {};
      var override = String(r.override || '').trim().toUpperCase().replace(/[\s-]/g, '_');
      var status = self.STATUSES.indexOf(override) >= 0 ? override : (self.STATUSES.indexOf(String(r.status || '').toUpperCase()) >= 0 ? String(r.status).toUpperCase() : 'PAPER');
      var trades = Number(r.trades) || 0;
      map[s.id] = {
        id: s.id, name: s.name, horizon: s.horizon, enabled: (r.enabled === undefined || r.enabled === '' ? true : bool(r.enabled)) && off.indexOf(s.id) < 0,
        status: status, overridden: self.STATUSES.indexOf(override) >= 0,
        track: trades > 0 ? { trades: trades, winRatePct: Number(r.winRatePct) || 0, profitFactor: Number(r.profitFactor) || 0 } : null,
      };
    });
    this._map = map;
    return map;
  },

  enabled: function (horizons) {
    var m = this.load();
    return Object.keys(m).filter(function (id) { return m[id].enabled && horizons.indexOf(m[id].horizon) >= 0; });
  },

  tracks: function () {
    var m = this.load(), out = {};
    Object.keys(m).forEach(function (id) { if (m[id].track) out[id] = m[id].track; });
    return out;
  },
};

/* ============================== Scans ============================== */

var Scans = {
  /** Strategy parameters from the Config sheet. */
  params: function () { return SRCore.params(Config.all()); },

  /**
   * During the session, after each 5-minute bar closes: fetch 5-minute candles for the
   * intraday stocks and run the intraday strategies on the bar that just finished.
   */
  intraday: function (today, deadline) {
    var t0 = Date.now(), now = MarketCal.now(), nowMs = now.getTime();
    var reg = Market.saved();
    if (!reg || reg.state === 'UNKNOWN') return { skipped: 'Market regime unknown (price history missing). Run Stock Radar → 6. Load price history.' };
    var ids = StrategyBook.enabled(['INTRADAY']);
    if (!ids.length) return { skipped: 'All intraday strategies are switched off' };
    var ctx = Market.intraCtx(today) || Market.prepareIntraday(today);
    var P = this.params(), meta = SymbolsDb.load();
    var items = [], from = MarketCal.at(MarketCal.prevTradingDay(today), '09:15');
    Object.keys(ctx.s).forEach(function (sym) {
      var m = meta[sym], tv = ctx.s[sym][1];
      if (m && m.angelToken && tv >= P.minTradedValueCr) items.push({ key: sym, token: String(m.angelToken), from: from, to: now });
    });
    if (!items.length) return { skipped: 'No intraday stocks pass the liquidity filter' };
    // Nifty 50's own 5-minute bars give the day's direction (up or down since the open).
    var NIFTY = 'NIFTY 50', niftyMeta = meta[NIFTY];
    if (niftyMeta && niftyMeta.angelToken) items.unshift({ key: NIFTY, token: String(niftyMeta.angelToken), from: from, to: now });
    var res = Angel.candlesMany(items, 'FIVE_MINUTE', { deadline: deadline });
    var done = function (b) { return b.t + 300000 <= nowMs - 15000; }; // completed bars only
    var niftyBars = (res.data[NIFTY] || []).filter(done);
    delete res.data[NIFTY];
    var follow = Config.get('intradayFollowNifty') !== false;
    var block = { BUY: Config.get('intradayBlockBuysInBear') === true ? ['BEAR'] : [], SHORT: Config.get('intradayBlockShortsInBull') === true ? ['BULL'] : [] };
    var dayNote = follow && !SRCore.dayDirection(niftyBars, nowMs - 300000) ? '; no Nifty 50 bars for today, so the day-direction check was skipped' : '';
    var signals = [], shadows = [], stale = 0, scanned = 0, lastEntry = Config.minutesOf('noEntriesAfter'), tracks = StrategyBook.tracks();
    Object.keys(res.data).forEach(function (sym) {
      var bars = res.data[sym].filter(done);
      if (!bars.length) { stale++; return; }
      var lastEnd = bars[bars.length - 1].t + 300000;
      if (SRCore.util.istDay(bars[bars.length - 1].t) !== SRCore.util.istDay(nowMs) || nowMs - lastEnd > 7 * 60000) { stale++; return; }
      scanned++;
      var r = SRCore.scanIntraday(sym, bars, {
        params: P, regime: reg, strategies: ids, prevClose: ctx.s[sym][0], tradedValueCr: ctx.s[sym][1],
        nowMs: nowMs, lastEntryMinute: lastEntry, tracks: tracks,
        niftyBars: niftyBars.length ? niftyBars : null, followNifty: follow, block: block,
      });
      signals = signals.concat(r.signals);
      shadows = shadows.concat(r.shadow || []);
    });
    var fresh = IntraSeen.filter(today, signals, nowMs, '');
    var out = AlertBook.publish(fresh, { nowMs: nowMs, source: 'Angel One 5-minute candles' });
    if (Config.get('shadowTracking') !== false) AlertBook.publish(IntraSeen.filter(today, shadows, nowMs, 'S|'), { nowMs: nowMs, source: 'Angel One 5-minute candles', shadow: true });
    Health.log('intradayScan', 'angel', scanned > 0, Date.now() - t0, scanned,
      scanned + ' scanned, ' + stale + ' without fresh bars, ' + Object.keys(res.failed).filter(function (k) { return k !== NIFTY; }).length + ' failed, ' + res.left.length + ' left for time; ' + fresh.length + ' new signals' + dayNote, 30);
    if (!scanned && items.length) throw new Error('No fresh 5-minute candles for any intraday stock (' + Object.keys(res.failed).length + ' failed, ' + stale + ' stale)');
    return { scanned: scanned, stale: stale, signals: fresh.length, logged: out.logged, sent: out.sent };
  },

  /**
   * After the close: add today's candle to the daily history of every stock. Returns 'done', 'more' or 'wait'.
   * Each run asks only for the stocks that still lack today's candle and were not asked yet today, so a run that
   * stops for time (or a request Angel One refuses for a moment) never makes the next run fetch everything again.
   */
  updateHistory: function (today, day, deadline) {
    var t0 = Date.now(), list = Backfill.targets(), todayN = History.ymdToDay(today);
    var recentFrom = new Date(MarketCal.at(today, '09:15').getTime() - 12 * 86400000);
    var fullFrom = Backfill.fromDate(Number(Config.get('historyDays')) || 660), to = MarketCal.now();
    if (!day.histProbed) {
      // Has Angel One published today's daily candle yet? Check Nifty 50 first.
      var probe = list.filter(function (it) { return it.key === 'NIFTY 50'; })[0];
      if (probe) {
        probe.from = recentFrom; probe.to = to;
        var pr = Angel.candlesMany([probe], 'ONE_DAY', {});
        var k = pr.data['NIFTY 50'] || [];
        if (!k.length || History.msToDay(k[k.length - 1].t) < todayN) {
          if (MarketCal.minutes() < 16 * 60 + 45) return 'wait';
          day.histNote = 'Angel One had not published today\'s daily candles by 16:45, so the end-of-day scan was skipped.';
        }
        if (k.length) History.put('NIFTY 50', k);
      }
      day.histProbed = 1;
    }
    var tried = this.histTried(todayN);
    var todo = list.filter(function (it) { return !tried[it.key] && !(History.lastDay(it.key) >= todayN); });
    // Never let a slow evening eat the day's trigger time: after 20 minutes of work, scan with what has arrived.
    if ((day.histMs || 0) >= this.HIST_BUDGET_MS && todo.length) {
      var many = todo.length !== 1, req = day.histReq || 0, ref = day.histRefused || 0;
      day.histNote = (req && ref * 5 >= req
        ? 'Angel One turned away ' + Fmt.num(ref, 0) + ' of ' + Fmt.num(req, 0) + ' requests today ("exceeding access rate", which it also sends at low rates)'
        : 'Angel One answered slowly today') + ': after 20 minutes ' + todo.length + ' stock' + (many ? 's were' : ' was') +
        ' still without today\'s candle, so the end-of-day scan skipped ' + (many ? 'them' : 'it') + '. Tomorrow\'s update fills in the gap.';
      History.saveMeta();
      return 'done';
    }
    todo.forEach(function (it) { it.from = History.lastDay(it.key) ? recentFrom : fullFrom; it.to = to; });
    // Candles go into the history as they arrive, so the regular saves keep them even if this run is cut short.
    var stored = {};
    var store = function (out) { Object.keys(out.data).forEach(function (key) { if (!stored[key]) { stored[key] = 1; History.put(key, out.data[key]); } }); };
    var res = todo.length ? Angel.candlesMany(todo, 'ONE_DAY', { deadline: deadline - 45000, onBatch: function (out) { store(out); History.saveNowAndThen(); } })
      : { data: {}, nodata: [], failed: {}, left: [], retries: 0 };
    store(res);
    res.nodata.forEach(function (key) { if (!History.has(key)) History.put(key, []); });
    History.flush();
    var left = {}, later = {}, again = (res.later || []).length;
    res.left.forEach(function (key) { left[key] = true; });
    // Turned away on every try is Angel One's busy answer, not a problem with the stock: the next run asks again.
    (res.later || []).forEach(function (key) { later[key] = true; });
    todo.forEach(function (it) { if (!left[it.key] && !later[it.key]) tried[it.key] = 1; });
    this.saveHistTried(todayN, tried);
    var failed = Object.keys(res.failed).filter(function (key) { return !later[key]; });
    day.histFailed = (day.histFailed || 0) + failed.length;
    day.histRuns = (day.histRuns || 0) + 1;
    day.histLeft = res.left.length + again;
    day.histReq = (day.histReq || 0) + (res.requests || 0);
    day.histRefused = (day.histRefused || 0) + (res.refused || 0);
    day.histMs = (day.histMs || 0) + (Date.now() - t0);
    Health.log('endOfDay', 'history', true, Date.now() - t0, Object.keys(res.data).length, 'Daily candles: ' + Object.keys(res.data).length + ' updated, ' +
      res.nodata.length + ' without data, ' + failed.length + ' failed, ' + day.histLeft + ' left for the next run; Angel One turned away ' +
      (res.refused || 0) + ' of ' + (res.requests || 0) + ' requests (run ' + day.histRuns + ')');
    if (failed.length) Health.log('endOfDay', 'angel', false, 0, failed.length, 'Daily candles missing for ' + failed.slice(0, 8).join(', ') + ': ' + res.failed[failed[0]]);
    if (day.histLeft) return 'more';
    History.saveMeta();
    return 'done';
  },

  /** Trigger time the price-history update may use in one evening (the whole end of day normally needs under 10 minutes). */
  HIST_BUDGET_MS: 20 * 60000,

  /** Stocks already asked for today (kept in the cache: losing it only means asking a few of them again). */
  histTried: function (todayN) {
    var out = {};
    try { (JSON.parse(CacheService.getScriptCache().get('HIST_TRIED_' + todayN) || '[]') || []).forEach(function (k) { out[k] = 1; }); } catch (e) { /* start afresh */ }
    return out;
  },
  saveHistTried: function (todayN, tried) {
    try { CacheService.getScriptCache().put('HIST_TRIED_' + todayN, JSON.stringify(Object.keys(tried)), 21600); } catch (e) { /* optional */ }
  },

  /** After the history update: swing, medium, long and holding checks on the day's closing data. */
  endOfDay: function (today, day) {
    var t0 = Date.now(), P = this.params();
    var reg = Market.computeRegime(P);
    day.regime = reg.state;
    if (reg.state === 'UNKNOWN') return { signals: 0, note: 'Market regime unknown: ' + reg.reasons.join(' ') };
    var tracks = StrategyBook.tracks();
    var on = function (h) { return StrategyBook.enabled([h]); };
    var swingIds = on('SWING'), mediumIds = on('MEDIUM'), longIds = on('LONG');
    var swingU = SymbolsDb.universe(Config.get('swingUniverse')), mediumU = SymbolsDb.universe(Config.get('mediumUniverse'));
    var all = SymbolsDb.load();
    var longU = SymbolsDb.universe(Config.get('longUniverse')).concat(Object.keys(all).filter(function (s) { return all[s].type === 'ETF'; }));
    var fund = {}, hold = {};
    Store.readObjects('Fundamentals').forEach(function (r) { if (r.symbol) fund[String(r.symbol).toUpperCase()] = r; });
    Store.readObjects('Holdings').forEach(function (r) { if (r.symbol && Number(r.qty) > 0) hold[String(r.symbol).toUpperCase()] = r; });

    var todayN = History.ymdToDay(today), series = {}, nifty = History.get('NIFTY 50');
    var syms = {};
    [swingU, mediumU, longU, Object.keys(hold)].forEach(function (u) { u.forEach(function (s) { syms[s] = true; }); });
    Object.keys(syms).forEach(function (s) { series[s] = History.get(s); });
    var mediumSeries = {};
    mediumU.forEach(function (s) { if (series[s] && series[s].length) mediumSeries[s] = series[s]; });
    var rs = SRCore.rsRanks(mediumSeries, nifty);

    var signals = [], shadows = [], stale = 0, scanned = 0;
    Object.keys(syms).forEach(function (s) {
      var k = series[s];
      if (!k || !k.length) return;
      if (History.msToDay(k[k.length - 1].t) !== todayN) { stale++; return; }
      var ids = [];
      if (swingU.indexOf(s) >= 0) ids = ids.concat(swingIds);
      if (mediumU.indexOf(s) >= 0) ids = ids.concat(mediumIds);
      if (longU.indexOf(s) >= 0 && fund[s] && longIds.indexOf('quality-value') >= 0) ids.push('quality-value');
      if (hold[s] && longIds.indexOf('holding-guard') >= 0) ids.push('holding-guard');
      if (!ids.length) return;
      scanned++;
      var r = SRCore.scanDaily(s, k, {
        params: P, regime: reg, strategies: ids, rsPct: rs.now[s], rsPrevPct: rs.prev[s],
        fundamentals: fund[s] ? Scans.fundamentals(fund[s]) : null, holding: hold[s] || null, tracks: tracks,
      });
      r.signals.forEach(function (sig) { if (sig.direction === 'EXIT') sig.holdingQty = Number(hold[s].qty) || 0; });
      signals = signals.concat(r.signals);
      shadows = shadows.concat(r.shadow || []);
    });
    var fresh = AlertBook.withoutRepeats(signals, P);
    var out = AlertBook.publish(fresh, { nowMs: MarketCal.now().getTime(), source: 'Angel One daily candles', day: day });
    if (Config.get('shadowTracking') !== false) AlertBook.publish(AlertBook.withoutRepeats(shadows, P), { nowMs: MarketCal.now().getTime(), source: 'Angel One daily candles', shadow: true });
    try { Scans.buildLists(series, rs, swingU, mediumU, fund, todayN); } catch (e) { ErrorLog.add('scanLists', e); }
    Health.log('endOfDay', 'scan', true, Date.now() - t0, scanned, scanned + ' stocks scanned, ' + stale + ' without today\'s candle, ' + signals.length + ' signals, ' + fresh.length + ' new');
    return { scanned: scanned, stale: stale, signals: fresh.length, logged: out.logged, sent: out.sent, regime: reg };
  },

  /**
   * Ranked lists for the app's Scan screen, saved after each close:
   *   medium: Nifty 200 stocks in an uptrend (price > 50-day > 200-day), by relative strength
   *   swing:  stocks closest to a swing setup (base breakout, 20-EMA pullback, RSI(2) dip)
   *   long:   stocks with fundamentals in the Fundamentals sheet, by quality-value score
   */
  buildLists: function (series, rs, swingU, mediumU, fund, todayN) {
    var I = SRCore.ind, sectors = SymbolsDb.load(), round1 = function (x) { return Math.round(x * 10) / 10; };
    var fresh = function (k) { return k && k.length >= 210 && History.msToDay(k[k.length - 1].t) === todayN; };
    var sec = function (s) { return String((sectors[s] && sectors[s].sector) || ''); };
    var medium = [];
    mediumU.forEach(function (s) {
      var k = series[s];
      if (!fresh(k) || !(rs.now[s] >= 0)) return;
      var c = SRCore.util.pluck(k, 'c'), i = c.length - 1, s50 = I.sma(c, 50)[i], s200 = I.sma(c, 200)[i];
      if (!(c[i] > s50 && s50 > s200)) return;
      var hi = SRCore.util.maxOf(SRCore.util.pluck(k, 'h'), i - 251, i), below = (1 - c[i] / hi) * 100;
      medium.push({ symbol: s, sector: sec(s), score: Math.round(rs.now[s]), line: 'Strength rank ' + Math.round(rs.now[s]) + ' of 100 · ' + (below < 0.5 ? 'at its 52-week high' : round1(below) + '% below its 52-week high') });
    });
    medium.sort(function (a, b) { return b.score - a.score; });
    var swing = [];
    swingU.forEach(function (s) {
      var k = series[s];
      if (!fresh(k)) return;
      var c = SRCore.util.pluck(k, 'c'), h = SRCore.util.pluck(k, 'h'), l = SRCore.util.pluck(k, 'l'), i = c.length - 1;
      var s200 = I.sma(c, 200)[i];
      if (!(c[i] > s200)) return;
      var best = null, consider = function (score, line) { if (!best || score > best.score) best = { score: Math.round(score), line: line }; };
      var H = SRCore.util.maxOf(h, i - 20, i - 1), L = SRCore.util.minOf(l, i - 20, i - 1), width = (H - L) / L * 100, gap = (H - c[i]) / c[i] * 100;
      if (width <= 12 && gap >= 0 && gap <= 3) consider(90 - gap * 8 - width, round1(width) + '% base over 20 days, ' + round1(gap) + '% below the breakout level');
      var e20 = I.ema(c, 20)[i], e50 = I.ema(c, 50)[i], near = Math.abs(c[i] - e20) / c[i] * 100;
      if (e20 > e50 && near <= 1.5) consider(80 - near * 10, 'Uptrend, ' + round1(near) + '% from its rising 20-day EMA');
      var r2 = I.rsi(c, 2)[i];
      if (r2 < 20) consider(75 - r2, 'RSI(2) at ' + round1(r2) + ' while above its 200-day average');
      if (best) swing.push({ symbol: s, sector: sec(s), score: Math.max(1, Math.min(99, best.score)), line: best.line });
    });
    swing.sort(function (a, b) { return b.score - a.score; });
    var long = [];
    Object.keys(fund).forEach(function (s) {
      var q = SRCore.qualityValue(Scans.fundamentals(fund[s]));
      if (q.score === null) return;
      var f = fund[s], bits = [];
      if (f.roePct !== '' && f.roePct !== undefined) bits.push('ROE ' + f.roePct + '%');
      if (f.debtToEquity !== '' && f.debtToEquity !== undefined) bits.push('debt/equity ' + f.debtToEquity);
      if (f.pe !== '' && f.pe5yMedian !== '' && f.pe !== undefined) bits.push('PE ' + f.pe + ' vs 5-year median ' + f.pe5yMedian);
      long.push({ symbol: s, sector: sec(s), score: q.score, complete: q.completenessPct, line: bits.join(', ') || 'Scored on ' + q.completenessPct + '% of the fundamentals' });
    });
    long.sort(function (a, b) { return b.score - a.score; });
    var trim = function (x) { x.line = String(x.line).slice(0, 90); x.sector = x.sector.slice(0, 40); return x; };
    var out = { at: Date.now(), medium: medium.slice(0, 15).map(trim), swing: swing.slice(0, 15).map(trim), long: long.slice(0, 15).map(trim) };
    var json = JSON.stringify(out);
    while (json.length > 8800 && (out.long.length || out.swing.length || out.medium.length)) {
      [out.long, out.swing, out.medium].forEach(function (a) { if (a.length > 5) a.pop(); });
      json = JSON.stringify(out);
      if (out.long.length <= 5 && out.swing.length <= 5 && out.medium.length <= 5) break;
    }
    Secrets.props().setProperty('SCAN_LISTS', json);
    return out;
  },

  /** Fundamentals sheet row → the fields Core expects. */
  fundamentals: function (r) {
    return { roePct: r.roePct, rocePct: r.rocePct, debtToEquity: r.debtToEquity, sales3yPct: r.sales3yPct, profit3yPct: r.profit3yPct, promoterPct: r.promoterPct, pledgePct: r.pledgePct, pe: r.pe, pe5yMedian: r.pe5yMedian, fcf: r.fcf };
  },
};

/* ============================== Same-day repeats ============================== */

/**
 * Intraday repeats. With intradayOneAlertPerStock (the default): one alert per stock per day, the strongest
 * signal winning when several strategies fire on the same bar. Otherwise: one per stock, strategy and direction
 * per day, with a cooldown between any two from the same strategy. Shadows (prefix 'S|') follow the same rule
 * separately. Times are kept as minutes after midnight so the record stays small.
 */
var IntraSeen = {
  KEY: 'INTRA_SEEN',
  load: function (today) {
    var s = null;
    try { s = JSON.parse(Secrets.props().getProperty(this.KEY) || 'null'); } catch (e) { s = null; }
    return s && s.day === today && s.v === 2 ? s : { v: 2, day: today, k: {} };
  },
  filter: function (today, signals, nowMs, prefix) {
    var s = this.load(today), coolMin = Number(Config.get('alertCooldownMinutes')) || 60, out = [];
    var onePer = Config.get('intradayOneAlertPerStock') !== false, nowMin = SRCore.util.istMinute(nowMs);
    prefix = prefix || '';
    signals.slice().sort(function (a, b) { return (b.confidence || 0) - (a.confidence || 0); }).forEach(function (sig) {
      var stock = prefix + sig.symbol, pair = stock + '|' + sig.strategy, full = pair + '|' + sig.direction;
      if (onePer) {
        if (s.k[stock] !== undefined) return;
        s.k[stock] = nowMin;
      } else {
        if (s.k[full] !== undefined) return;
        if (s.k[pair] !== undefined && nowMin - s.k[pair] < coolMin) return;
        s.k[full] = nowMin; s.k[pair] = nowMin;
      }
      out.push(sig);
    });
    var json = JSON.stringify(s);
    if (json.length > 8500) {
      // Keep the per-stock marks (they matter most) and drop the rest.
      var keep = {};
      Object.keys(s.k).forEach(function (k) { if (k.indexOf('|') < 0 || (k.indexOf('S|') === 0 && k.split('|').length === 2)) keep[k] = s.k[k]; });
      s.k = keep;
      json = JSON.stringify(s);
    }
    Secrets.props().setProperty(this.KEY, json);
    return out;
  },
};

/* ============================== Alerts log and messages ============================== */

var AlertBook = {
  EXTRA_HEADERS: ['qty', 'window', 'telegram', 'track', 'fillPrice', 'exitPrice', 'paperQty', 'grossPnl', 'charges', 'netPnl', 'niftyPct', 'alphaPct', 'holdDays', 'evaluatedAt'],
  HORIZON_NAMES: { INTRADAY: 'Intraday', SWING: 'Swing', MEDIUM: 'Medium term', LONG: 'Long term' },
  HORIZON_ICONS: { INTRADAY: '⚡', SWING: '📈', MEDIUM: '🗓️', LONG: '🌱' },

  ensureHeaders: function () {
    var sh = Store.require('Alerts'), have = Store.headers(sh).filter(function (h) { return h !== ''; });
    var missing = this.EXTRA_HEADERS.filter(function (h) { return have.indexOf(h) < 0; });
    if (!missing.length) return;
    Store.ensureCols(sh, have.length + missing.length);
    sh.getRange(1, have.length + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
  },

  /** The latest rows of the Alerts sheet (newest last), only the columns needed for repeat checks. */
  recent: function (maxRows) {
    var sh = Store.sheet('Alerts');
    if (!sh || sh.getLastRow() < 2) return [];
    var hdr = Store.headers(sh), n = Math.min(maxRows || 3000, sh.getLastRow() - 1), start = sh.getLastRow() - n + 1;
    var col = function (h) { return hdr.indexOf(h); };
    var iC = col('createdAt'), iS = col('symbol'), iSt = col('strategy'), iD = col('direction'), iH = col('horizon'), iT = col('track');
    return sh.getRange(start, 1, n, hdr.length).getValues().map(function (r) {
      return { createdAt: r[iC] instanceof Date ? r[iC].getTime() : Date.parse(r[iC]) || 0, symbol: String(r[iS]), strategy: String(r[iSt]), direction: String(r[iD]), horizon: String(r[iH]), track: iT >= 0 && r[iT] ? String(r[iT]) : 'main' };
    });
  },

  /**
   * True when this strategy's alerts stay off Telegram because it lost money after charges in the Backtest Baseline
   * (switch alertsOnlyTested, on by default). A strategy made Live-ready by its own paper record, or given a status by
   * hand in the Strategies sheet, still sends. A signal score never decides this: in tests it did not predict results.
   */
  quietByBacktest: function (id, st) {
    if (Config.get('alertsOnlyTested') === false || (st && (st.status === 'LIVE_READY' || st.overridden))) return false;
    return Backtest.verdictOf(id) === 'loses';
  },

  /** Drop daily-strategy signals that repeat an alert still inside its cooldown. */
  withoutRepeats: function (signals, P) {
    if (!signals.length) return [];
    var last = {}, now = MarketCal.now().getTime();
    this.recent(3000).forEach(function (a) { var k = a.symbol + '|' + a.strategy + '|' + a.track; if (!last[k] || a.createdAt > last[k]) last[k] = a.createdAt; });
    return signals.filter(function (sig) {
      var days = SRCore.cooldownDays(sig.strategy, sig.horizon, P);
      var prev = last[sig.symbol + '|' + sig.strategy + '|' + (sig.shadow ? 'shadow' : 'main')];
      return !(prev && now - prev < days * 86400000);
    });
  },

  /** Valid-till moment and a plain description of the holding window. */
  window: function (sig, nowMs) {
    var today = MarketCal.ymd(new Date(nowMs));
    if (sig.horizon === 'INTRADAY') return { till: MarketCal.at(today, Config.get('intradayExpiry') || '15:15'), text: 'Today until ' + (Config.get('intradayExpiry') || '15:15') };
    var P = Scans.params(), key = sig.horizon === 'SWING' ? 'swing' : sig.horizon === 'MEDIUM' ? 'medium' : 'long';
    if (sig.direction === 'EXIT') return { till: MarketCal.at(MarketCal.nextTradingDay(today), '15:30'), text: 'Review before the next close' };
    var n = Math.round(P[key + '.holdDays']), d = today;
    for (var i = 0; i < n; i++) d = MarketCal.nextTradingDay(d);
    return { till: MarketCal.at(d, '15:30'), text: n + ' trading days (till ' + Fmt.day(d) + ')' };
  },

  /** Log every signal in the Alerts sheet and send the strongest ones to Telegram. */
  publish: function (signals, info) {
    if (!signals.length) return { logged: 0, sent: 0 };
    this.ensureHeaders();
    var book = StrategyBook.load(), nowMs = info.nowMs, regime = Market.saved();
    var cap = Number(Config.get('realCapital')), risk = Number(Config.get('riskPct')), maxPer = Number(Config.get('maxPerStockPct'));
    var perRun = Math.max(0, Number(Config.get('maxTelegramAlertsPerRun')) || 0), perDay = Math.max(0, Number(Config.get('maxTelegramAlertsPerDay')) || 0);
    var dayYmd = MarketCal.ymd(new Date(nowMs)), counter = null;
    try { counter = JSON.parse(Secrets.props().getProperty('TG_ALERTS') || 'null'); } catch (e) { counter = null; }
    var sentToday = counter && counter.day === dayYmd ? Number(counter.n) || 0 : 0;
    var paperOk = Config.get('paperAlerts') !== false, tgOn = Config.get('telegram') !== false;
    var self = this, rows = [], sent = 0, held = [];
    signals.sort(function (a, b) { return b.confidence - a.confidence; });
    var stamp = Utilities.formatDate(new Date(nowMs), IST, 'yyyyMMdd-HHmm');
    signals.forEach(function (sig) {
      var st = book[sig.strategy] || { status: 'PAPER', track: null };
      var size = sig.direction === 'EXIT' ? { qty: sig.holdingQty || 0 } : SRCore.positionSize(cap, risk, sig.entry, sig.stop, maxPer);
      var win = self.window(sig, nowMs);
      var isShadow = !!(info.shadow || sig.shadow);
      var row = {
        id: 'A' + stamp + '-' + sig.symbol + '-' + sig.strategy + (sig.direction === 'SHORT' ? '-S' : sig.direction === 'EXIT' ? '-X' : '') + (isShadow ? '-H' : ''),
        createdAt: new Date(nowMs), symbol: sig.symbol, horizon: sig.horizon, strategy: sig.strategy, strategyStatus: st.status,
        direction: sig.direction, entryLow: sig.entryLow, entryHigh: sig.entryHigh, stop: sig.stop, target1: sig.target1, target2: sig.target2,
        rr: sig.rr, confidence: sig.confidence, reasons: sig.reasons.join(' | '), regime: regime ? regime.state : '',
        source: info.source + (sig.barEnd ? ' to ' + sig.barEnd : '') + ', ' + Utilities.formatDate(new Date(sig.barTime), IST, 'd MMM'),
        validTill: win.till, status: 'OPEN', notes: (sig.riskPct ? 'Stop ' + sig.riskPct + '% away. ' : '') + (sig.tradedValueCr ? 'Avg traded value ₹' + sig.tradedValueCr + ' cr.' : ''),
        qty: size.qty, window: win.text, telegram: '', track: isShadow ? 'shadow' : 'main',
      };
      var why = '';
      if (isShadow) why = (sig.blocked || 'blocked by the ' + SRCore.regimeName(regime ? regime.state : 'UNKNOWN') + ' regime') + ', tracked silently';
      else if (!tgOn) why = 'Telegram off';
      else if (st.status === 'REJECTED') why = 'strategy rejected (kept as paper only)';
      else if (sig.direction !== 'EXIT' && AlertBook.quietByBacktest(sig.strategy, st)) why = 'lost money after charges in the backtest (kept as paper only)';
      else if (st.status === 'PAPER' && !paperOk) why = 'paper alerts off';
      else if (sent >= perRun || sentToday >= perDay) why = 'over the message limit';
      if (!why) {
        if (sent) Utilities.sleep(700); // Telegram allows about one message a second per chat
        var n = Notify.safeTelegram(self.format(sig, st, size, win, regime, row.source));
        if (n > 0) { sent++; sentToday++; row.telegram = 'sent'; } else row.telegram = 'failed';
      } else {
        row.telegram = 'not sent: ' + why;
        if (why === 'over the message limit') held.push(sig);
      }
      rows.push(row);
    });
    Store.append('Alerts', rows);
    if (held.length && tgOn && sentToday < perDay + 1) {
      var names = held.slice(0, 15).map(function (s) { return Notify.esc(s.symbol) + ' (' + Notify.esc(s.strategyName) + ')'; });
      Notify.safeTelegram('➕ <b>' + held.length + ' more signal' + (held.length > 1 ? 's' : '') + '</b> logged in the Alerts sheet: ' + names.join(', ') + (held.length > 15 ? ' …' : '') + '.');
    }
    Secrets.props().setProperty('TG_ALERTS', JSON.stringify({ day: dayYmd, n: sentToday }));
    return { logged: rows.length, sent: sent };
  },

  /** One alert as a Telegram message: what to do and at which prices first, then why, then the context. */
  format: function (sig, st, size, win, regime, source) {
    var e = Notify.esc, L = [];
    var trades = st.track ? st.track.trades : 0;
    var hz = this.HORIZON_NAMES[sig.horizon] || sig.horizon, icon = this.HORIZON_ICONS[sig.horizon] || '📈';
    var badge = st.status === 'LIVE_READY'
      ? '✅ Live-ready (' + Math.round(st.track ? st.track.winRatePct : 0) + '% wins over ' + trades + ' paper trades)'
      : '🧪 Paper' + (trades ? ' (' + trades + ' paper trade' + (trades === 1 ? '' : 's') + ' so far)' : '');
    if (sig.direction === 'EXIT') {
      L.push('⚠️ <b>EXIT CHECK · ' + e(sig.symbol) + '</b>');
      L.push('🛡️ ' + e(sig.strategyName) + ' · a stock you hold');
      L.push('');
      L.push('💵 <b>Close:</b> ' + Fmt.money(sig.entry) + (size.qty ? ' · you hold ' + size.qty + ' shares' : ''));
      L.push('👉 Look at it before the next close. This is a warning, not an order.');
    } else {
      var short = sig.direction === 'SHORT', ref = (sig.entryLow + sig.entryHigh) / 2;
      var move = function (p) { return Fmt.pct((p / ref - 1) * 100, 1); };
      L.push((short ? '🔴 <b>SHORT ' : '🟢 <b>BUY ') + e(sig.symbol) + '</b> · ' + icon + ' ' + hz);
      L.push(e(sig.strategyName) + ' · ' + badge);
      L.push('');
      L.push('💰 <b>Entry:</b> ' + Fmt.money(sig.entryLow) + ' – ' + Fmt.money(sig.entryHigh) +
        (short ? ' (sell first, intraday MIS only)' : sig.horizon === 'INTRADAY' ? '' : ' (from the next session, only while the price is in this range)'));
      L.push('🛑 <b>Stop-loss:</b> ' + Fmt.money(sig.stop) + ' (' + move(sig.stop) + ')');
      L.push('🎯 <b>Target:</b> ' + Fmt.money(sig.target1) + ' (' + move(sig.target1) + ')' + (sig.target2 ? ' · then ' + Fmt.money(sig.target2) + ' (' + move(sig.target2) + ')' : ''));
      L.push('⚖️ <b>Reward:risk</b> ' + sig.rr.toFixed(1) + ' · 📊 <b>Signal score</b> ' + sig.confidence + '/100');
      if (size.qty > 0) L.push('📦 <b>Size:</b> ' + size.qty + ' shares (' + Fmt.money(size.value, 0) + (size.capped ? ', the most your per-stock limit allows' : '') + ') · loss at the stop ' + Fmt.money(size.riskAmount, 0));
      else L.push('📦 <b>Size:</b> the stop is too far for your risk setting, so no position fits.');
      L.push('⏰ <b>Valid:</b> ' + e(win.text) + (sig.horizon === 'INTRADAY' ? ', square off by then' : ''));
    }
    L.push('', '📝 <b>Why</b>');
    sig.reasons.forEach(function (r) { L.push('• ' + e(r)); });
    L.push('', Market.icon(regime ? regime.state : 'UNKNOWN') + ' Market: ' + SRCore.regimeName(regime ? regime.state : 'UNKNOWN') + ' · ' + e(source));
    if (st.status !== 'LIVE_READY' && sig.direction !== 'EXIT') L.push('<i>Paper signal: the strategy is still being tested, so this is not for real money yet.</i>');
    return L.join('\n');
  },

  /** Today's alerts from the sheet, for the square-off reminder and the closing summary. */
  today: function (today) {
    var sh = Store.sheet('Alerts');
    if (!sh || sh.getLastRow() < 2) return [];
    var hdr = Store.headers(sh), n = Math.min(600, sh.getLastRow() - 1), start = sh.getLastRow() - n + 1;
    return sh.getRange(start, 1, n, hdr.length).getValues().map(function (r) {
      var o = {};
      hdr.forEach(function (h, i) { o[h] = r[i]; });
      return o;
    }).filter(function (o) { return o.createdAt instanceof Date && MarketCal.ymd(o.createdAt) === today; });
  },
};

/* ============================== Menu: load price history ============================== */

/** Stock Radar → 6. Load price history. Loads about two years of daily candles, then keeps going by itself. */
function loadHistory() {
  var t0 = Date.now();
  var r = Jobs.run('history', function () { return Backfill.step(t0 + 240000); }, { lock: true, wait: 10000 });
  if (r === null) {
    Ui.alert('Price history', 'Could not load price history right now. See the ErrorLog sheet, or try again in a minute.');
    return null;
  }
  if (r.remaining > 0) {
    History.scheduleContinue();
    Ui.alert('Loading price history',
      'Loaded ' + r.loaded + ' stocks so far (' + r.symbols + ' in total). ' + r.remaining + ' are left.\n\n' +
      'The rest load by themselves in the background over the next few minutes. You will get a Telegram message when it is done. You can close this sheet.');
  } else {
    var done = History.finishNote(r);
    Ui.alert('Price history ready', done.replace(/<[^>]+>/g, ''));
    Notify.safeTelegram(done);
  }
  return r;
}

/** Runs by itself a minute after the previous batch until all history is loaded. */
function continueHistory() {
  History.clearContinue();
  var t0 = Date.now();
  var r = Jobs.run('history', function () { return Backfill.step(t0 + 240000); }, { lock: true, wait: 20000 });
  if (r === null) { History.scheduleContinue(); return; } // busy or failed: try again shortly (Jobs warns after two failures)
  if (r.remaining > 0 && r.loaded + r.noData > 0) { History.scheduleContinue(); return; }
  if (r.remaining > 0) Notify.safeTelegram('⚠️ <b>Price history</b>: ' + r.remaining + ' stocks could not be loaded from Angel One. Run Stock Radar → 6. Load price history again later.');
  else Notify.safeTelegram(History.finishNote(r));
}

History.scheduleContinue = function () {
  this.clearContinue();
  ScriptApp.newTrigger('continueHistory').timeBased().after(60 * 1000).create();
};
History.clearContinue = function () {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'continueHistory') ScriptApp.deleteTrigger(t); });
};
History.finishNote = function (r) {
  var reg = null;
  try { reg = Market.computeRegime(); } catch (e) { reg = null; }
  return '📈 <b>Price history ready</b>\n' + r.symbols + ' stocks and indices, up to ' + (r.last ? Fmt.day(History.dayToYmd(r.last)) : '—') + '.' +
    (r.noData ? '\n' + r.noData + ' had no daily candles on Angel One and are skipped.' : '') +
    '\n' + Market.line(reg) + '\nScans start on the next trading day.';
};
