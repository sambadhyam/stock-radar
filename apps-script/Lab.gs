/**
 * Stock Radar — Lab.gs (Phase 5)
 * The backtester and its Backtest Baseline report, the long price history it needs, your holdings and
 * fundamentals sent from the app, and optional AI news summaries. Every trading and evaluation rule comes from
 * Core.gs, so a backtest follows exactly the rules of the live paper record.
 *
 * Extra files in your "Stock Radar Data" Drive folder (this script sees only its own files):
 *   long-00…11.json   daily candles older than the everyday files, back to backtestYears
 *   intra-00…11.json  5-minute candles of the intraday stocks and Nifty 50, last intradayHistoryDays sessions
 *   bt-context.json   the market on each day (regime, relative strength), worked out without hindsight
 *   btd-00…11.json, bti-00…11.json   backtest trades of the daily and the intraday strategies
 *   bt-result.json    the summaries and equity curves the app shows
 *
 * The backtest runs in steps outside market hours (after 18:15 on trading days, any time on other days),
 * about four minutes each, one minute apart, and sends the Backtest Baseline report when it is done.
 */

/* ============================== Drive files ============================== */

/** Twelve JSON files with the same symbol hash as the everyday price files: one per prefix ('long-', 'intra-'). */
function PackStore_(prefix) { this.prefix = prefix; this.packs = {}; this.dirty = {}; }
PackStore_.prototype.name = function (p) { return this.prefix + (p < 10 ? '0' : '') + p + '.json'; };
PackStore_.prototype.pack = function (p) {
  if (this.packs[p]) return this.packs[p];
  var id = History.fileIds()[this.name(p)];
  var data = id ? DriveFiles.readJson(id) : { v: 1, s: {} };
  if (!data.s) throw new Error('Google Drive: ' + this.name(p) + ' is not a Stock Radar file');
  this.packs[p] = data;
  return data;
};
PackStore_.prototype.rec = function (symbol) { return this.pack(History.packOf(symbol)).s[symbol] || null; };
PackStore_.prototype.put = function (symbol, rec) { var p = History.packOf(symbol); this.pack(p).s[symbol] = rec; this.dirty[p] = true; };
PackStore_.prototype.flush = function () {
  var self = this, n = 0;
  Object.keys(this.dirty).forEach(function (k) { DataFile.write(self.name(Number(k)), self.packs[Number(k)]); n++; });
  this.dirty = {};
  return n;
};
/** Forget a file read in this run (after its data is used), to keep memory low. */
PackStore_.prototype.release = function (p) { if (!this.dirty[p]) delete this.packs[p]; };

/** Single JSON files in the data folder. */
var DataFile = {
  read: function (name) { var id = History.fileIds()[name]; return id ? DriveFiles.readJson(id) : null; },
  write: function (name, obj) {
    var ids = History.fileIds(), json = JSON.stringify(obj);
    if (ids[name]) DriveFiles.write(ids[name], json);
    else ids[name] = DriveFiles.createFile(History.folderId(), name, json);
  },
  pad: function (p) { return (p < 10 ? '0' : '') + p; },
  /** Forget an everyday price file read in this run (never one with unsaved changes). */
  releaseDaily: function (p) { if (History._packs && !(History._dirty && History._dirty[p])) delete History._packs[p]; },
};

/* ============================== Long daily history ============================== */

var LongHistory = {
  _st: null,
  WINDOW_DAYS: 680,   // calendar days per request: about 470 daily candles, under Angel One's ~500 rows
  KEY: 'LONG_PROGRESS',

  store: function () { return this._st || (this._st = new PackStore_('long-')); },
  reset: function () { this._st = null; },
  years: function () { return Math.max(3, Math.min(15, Number(Config.get('backtestYears')) || 10)); },
  startDay: function () { return History.msToDay(MarketCal.now().getTime() - this.years() * 365.25 * 86400000); },

  /** Indices for the regime, the backtest stocks (Nifty 200 by default) and the watchlist, with Angel One codes. */
  targets: function () {
    var all = SymbolsDb.load(), seen = {}, out = [];
    var add = function (s) { if (!seen[s] && all[s] && all[s].angelToken) { seen[s] = true; out.push({ key: s, token: String(all[s].angelToken) }); } };
    History.INDICES.forEach(add);
    Backtest.universe().forEach(add);
    Config.symbols('watchlist').forEach(add);
    return out;
  },

  /** A symbol's whole daily history: the long file joined to the everyday file (the everyday file wins on a shared day). */
  get: function (symbol) {
    var recent = History.get(symbol), r = this.store().rec(symbol), out = [];
    var first = recent.length ? History.msToDay(recent[0].t) : 99999999;
    if (r && r.d) for (var i = 0; i < r.d.length; i++) if (r.d[i] < first) out.push({ t: History.dayToMs(r.d[i]), o: r.o[i], h: r.h[i], l: r.l[i], c: r.c[i], v: r.v[i] });
    return out.concat(recent);
  },

  /** Times and closes only (much lighter than candles), for the market context. */
  closes: function (symbol) {
    var recent = History.rec(symbol), r = this.store().rec(symbol), t = [], c = [], i;
    var first = recent && recent.d && recent.d.length ? recent.d[0] : 99999999;
    if (r && r.d) for (i = 0; i < r.d.length; i++) if (r.d[i] < first) { t.push(History.dayToMs(r.d[i])); c.push(r.c[i]); }
    if (recent && recent.d) for (i = 0; i < recent.d.length; i++) { t.push(History.dayToMs(recent.d[i])); c.push(recent.c[i]); }
    return { t: t, c: c };
  },

  progress: function () { try { return JSON.parse(Secrets.props().getProperty(this.KEY) || 'null') || { pack: 0 }; } catch (e) { return { pack: 0 }; } },
  saveProgress: function (pr) { Secrets.props().setProperty(this.KEY, JSON.stringify(pr)); },

  /**
   * Load missing history, one data file at a time, until the deadline. A symbol is done when every window
   * back to backtestYears has been asked for (Angel One answers "no data" before a stock was listed).
   * Returns {done, have, total}.
   */
  step: function (deadline) {
    var self = this, st = this.store(), start = this.startDay(), pr = this.progress();
    var targets = this.targets(), byPack = {};
    targets.forEach(function (it) { var p = History.packOf(it.key); (byPack[p] || (byPack[p] = [])).push(it); });
    while (pr.pack < History.PACKS && Date.now() < deadline - 40000) {
      var p = pr.pack, list = byPack[p] || [];
      var todo = list.filter(function (it) { var r = st.rec(it.key); return !(r && r.done && r.from <= start + 45); });
      var items = [], wins = {};
      todo.forEach(function (it) {
        var recent = History.rec(it.key);
        var end = recent && recent.d && recent.d.length ? History.dayToMs(recent.d[0]) - 86400000 : MarketCal.now().getTime();
        var stop = History.dayToMs(start), k = 0;
        wins[it.key] = [];
        for (var to = end; to >= stop && k < 12; k++) {
          var from = Math.max(stop, to - (self.WINDOW_DAYS - 1) * 86400000);
          var key = it.key + '#' + k;
          wins[it.key].push(key);
          items.push({ key: key, token: it.token, from: new Date(from), to: new Date(Math.min(to + 86399000, MarketCal.now().getTime())) });
          to = from - 86400000;
        }
      });
      var res = items.length ? Angel.candlesMany(items, 'ONE_DAY', { deadline: deadline - 30000 }) : { data: {}, nodata: [], failed: {}, left: [] };
      var left = {};
      res.left.forEach(function (k) { left[k] = true; });
      todo.forEach(function (it) {
        var keys = wins[it.key], candles = [], missing = 0, failed = 0;
        keys.forEach(function (k) {
          if (left[k]) missing++;
          else if (res.failed[k]) failed++;
          else if (res.data[k]) candles = candles.concat(res.data[k]);
        });
        if (missing) return; // out of time: next run
        var old = st.rec(it.key), tries = (old && old.tries || 0) + (failed ? 1 : 0);
        if (failed && tries < 3) { var o2 = old || { d: [], o: [], h: [], l: [], c: [], v: [] }; o2.tries = tries; st.put(it.key, o2); return; }
        st.put(it.key, self.record(candles, start, tries));
      });
      var finished = todo.every(function (it) { var r = st.rec(it.key); return r && r.done; });
      st.flush();
      if (!finished) break;
      st.release(p);
      DataFile.releaseDaily(p);
      pr.pack = p + 1;
      self.saveProgress(pr);
    }
    var have = 0;
    if (pr.pack >= History.PACKS) have = targets.length;
    else targets.forEach(function (it) { if (History.packOf(it.key) < pr.pack) have++; });
    return { done: pr.pack >= History.PACKS, have: have, total: targets.length };
  },

  /** Columnar record (like the everyday files) from candles, oldest first, one per day. */
  record: function (candles, start, tries) {
    var map = {};
    candles.forEach(function (c) {
      if (!(c.c > 0)) return;
      var r2 = function (x) { return Math.round(x * 100) / 100; };
      map[History.msToDay(c.t)] = [r2(c.o), r2(c.h), r2(c.l), r2(c.c), Math.round(c.v || 0)];
    });
    var days = Object.keys(map).map(Number).sort(function (a, b) { return a - b; });
    var rec = { d: days, o: [], h: [], l: [], c: [], v: [], done: 1, from: start, tries: tries || 0 };
    days.forEach(function (d) { var x = map[d]; rec.o.push(x[0]); rec.h.push(x[1]); rec.l.push(x[2]); rec.c.push(x[3]); rec.v.push(x[4]); });
    return rec;
  },
};

/* ============================== 5-minute history ============================== */

var IntraHistory = {
  _st: null,
  WINDOW_DAYS: 6,     // calendar days per request: at most 450 five-minute candles
  KEY: 'INTRA_PROGRESS',
  NIFTY: 'NIFTY 50',

  store: function () { return this._st || (this._st = new PackStore_('intra-')); },
  reset: function () { this._st = null; },
  days: function () { return Math.max(20, Math.min(120, Number(Config.get('intradayHistoryDays')) || 60)); },

  /** First session of the window that ends with the last completed session. */
  windowStart: function () {
    var d = MarketCal.lastCompletedSession();
    for (var i = 1; i < this.days(); i++) d = MarketCal.prevTradingDay(d);
    return d;
  },

  /** Nifty 50 (for the day's direction) and the intraday stocks. */
  targets: function () {
    var all = SymbolsDb.load(), seen = {}, out = [];
    var add = function (s) { if (!seen[s] && all[s] && all[s].angelToken) { seen[s] = true; out.push({ key: s, token: String(all[s].angelToken) }); } };
    add(this.NIFTY);
    Market.intradaySymbols().forEach(add);
    return out;
  },

  /** 5-minute candles, oldest first. Times are stored as minutes to keep the files small. */
  get: function (symbol) {
    var r = this.store().rec(symbol);
    if (!r || !r.t) return [];
    var out = new Array(r.t.length);
    for (var i = 0; i < r.t.length; i++) out[i] = { t: r.t[i] * 60000, o: r.o[i], h: r.h[i], l: r.l[i], c: r.c[i], v: r.v[i] };
    return out;
  },

  progress: function () { try { return JSON.parse(Secrets.props().getProperty(this.KEY) || 'null') || { pack: 0 }; } catch (e) { return { pack: 0 }; } },
  saveProgress: function (pr) { Secrets.props().setProperty(this.KEY, JSON.stringify(pr)); },

  /** Bring every target up to the last completed session and drop sessions older than the window. Returns {done, have, total}. */
  step: function (deadline) {
    var self = this, st = this.store(), pr = this.progress(), start = this.windowStart(), lastSession = MarketCal.lastCompletedSession();
    var startMs = MarketCal.at(start, '09:15').getTime(), endMs = MarketCal.at(lastSession, '15:30').getTime();
    var targets = this.targets(), byPack = {};
    targets.forEach(function (it) { var p = History.packOf(it.key); (byPack[p] || (byPack[p] = [])).push(it); });
    while (pr.pack < History.PACKS && Date.now() < deadline - 40000) {
      var p = pr.pack, list = byPack[p] || [], items = [], wins = {};
      list.forEach(function (it) {
        var r = st.rec(it.key), lastT = r && r.t && r.t.length ? r.t[r.t.length - 1] * 60000 : 0;
        var from = lastT && r.from && r.from <= start ? MarketCal.at(MarketCal.nextTradingDay(MarketCal.ymd(new Date(lastT))), '09:15').getTime() : startMs;
        if (from > endMs) return;
        wins[it.key] = [];
        for (var f = from, k = 0; f <= endMs && k < 40; k++) {
          var to = Math.min(endMs, f + self.WINDOW_DAYS * 86400000 - 60000), key = it.key + '#' + k;
          wins[it.key].push(key);
          items.push({ key: key, token: it.token, from: new Date(f), to: new Date(to) });
          f = to + 60000;
        }
      });
      var res = items.length ? Angel.candlesMany(items, 'FIVE_MINUTE', { deadline: deadline - 30000 }) : { data: {}, nodata: [], failed: {}, left: [] };
      var left = {}, complete = true;
      res.left.forEach(function (k) { left[k] = true; });
      list.forEach(function (it) {
        var keys = wins[it.key] || [], bars = [], missing = false;
        keys.forEach(function (k) { if (left[k]) missing = true; else if (res.data[k]) bars = bars.concat(res.data[k]); });
        if (missing) { complete = false; return; }
        st.put(it.key, self.merge(st.rec(it.key), bars, startMs, start));
      });
      st.flush();
      if (!complete) break;
      st.release(p);
      pr.pack = p + 1;
      self.saveProgress(pr);
    }
    var have = 0;
    if (pr.pack >= History.PACKS) have = targets.length;
    else targets.forEach(function (it) { if (History.packOf(it.key) < pr.pack) have++; });
    return { done: pr.pack >= History.PACKS, have: have, total: targets.length };
  },

  merge: function (old, bars, startMs, startYmd) {
    var map = {}, i;
    var keep = function (t, o, h, l, c, v) { if (t * 60000 >= startMs && c > 0) map[t] = [o, h, l, c, v]; };
    if (old && old.t) for (i = 0; i < old.t.length; i++) keep(old.t[i], old.o[i], old.h[i], old.l[i], old.c[i], old.v[i]);
    bars.forEach(function (b) {
      var r2 = function (x) { return Math.round(x * 100) / 100; };
      keep(Math.round(b.t / 60000), r2(b.o), r2(b.h), r2(b.l), r2(b.c), Math.round(b.v || 0));
    });
    var ts = Object.keys(map).map(Number).sort(function (a, b) { return a - b; });
    var rec = { t: ts, o: [], h: [], l: [], c: [], v: [], from: startYmd };
    ts.forEach(function (t) { var x = map[t]; rec.o.push(x[0]); rec.h.push(x[1]); rec.l.push(x[2]); rec.c.push(x[3]); rec.v.push(x[4]); });
    return rec;
  },
};

/* ============================== The backtest job ============================== */

var Backtest = {
  JOB: 'BT_JOB',
  SUMMARY: 'BT_SUMMARY',
  REG: { UNKNOWN: 'U', BULL: 'B', NEUTRAL: 'N', BEAR: 'R', HIGH_VOL: 'H' },
  REG_BACK: { U: 'UNKNOWN', B: 'BULL', N: 'NEUTRAL', R: 'BEAR', H: 'HIGH_VOL' },
  OUT: { TARGET_HIT: 'T', STOP_HIT: 'S', EXPIRED: 'E' },
  OUT_BACK: { T: 'TARGET_HIT', S: 'STOP_HIT', E: 'EXPIRED' },
  _ctx: null,

  universe: function () { return SymbolsDb.universe(Config.get('backtestUniverse') || 'NIFTY200'); },
  universeName: function () { var u = String(Config.get('backtestUniverse') || 'NIFTY200').toUpperCase(); return u.replace(/^NIFTY(\d+)$/, 'Nifty $1'); },

  job: function () { try { return JSON.parse(Secrets.props().getProperty(this.JOB) || 'null'); } catch (e) { return null; } },
  saveJob: function (j) { Secrets.props().setProperty(this.JOB, JSON.stringify(j)); },
  summary: function () { try { return JSON.parse(Secrets.props().getProperty(this.SUMMARY) || 'null'); } catch (e) { return null; } },
  running: function () { var j = this.job(); return !!(j && j.stage !== 'done' && j.stage !== 'failed'); },

  /** Outside market hours and the end-of-day work: after 18:15 or before 08:30 on trading days, any time on other days. */
  quiet: function () {
    var today = MarketCal.ymd(), m = MarketCal.minutes();
    return !MarketCal.isTradingDay(today) || m < 8 * 60 + 30 || m >= 18 * 60 + 15;
  },

  /** Start a run (or keep the one already running). reason: 'menu', 'app', 'auto' or 'monthly'. */
  start: function (reason) {
    var j = this.job();
    if (j && j.stage !== 'done' && j.stage !== 'failed' && Date.now() - (j.at || 0) < 6 * 3600000) return j;
    j = { stage: 'long', cursor: 0, runId: Utilities.formatDate(MarketCal.now(), IST, 'yyyyMMdd-HHmm'), started: Date.now(), at: Date.now(), reason: reason || '', note: 'Waiting to start', fails: 0, first: !this.summary() };
    LongHistory.saveProgress({ pack: 0 });
    IntraHistory.saveProgress({ pack: 0 });
    this.saveJob(j);
    return j;
  },

  /** Run the next step soon: in a minute when quiet, else at 18:15 (or 08:30 is too close to the open, so evening). */
  schedule: function (delayMs) {
    this.unschedule();
    var at;
    if (this.quiet()) at = new Date(Date.now() + (delayMs || 60000));
    else at = MarketCal.at(MarketCal.ymd(), '18:16');
    ScriptApp.newTrigger('continueBacktest').timeBased().at(at).create();
    return at;
  },

  /* ---------- Google's 90 trigger minutes a day ---------- */

  USAGE: 'BT_USAGE',
  /** Trigger minutes the backtest may use in any 24 hours (the live engine needs about 45 of the 90). */
  budgetMs: function () { return Math.max(10, Math.min(40, Number(Config.get('backtestMinutesPerDay')) || 30)) * 60000; },
  /** Backtest runs in the last 24 hours: [[start ms, length ms], …]. */
  runs: function () {
    var list = [];
    try { list = JSON.parse(Secrets.props().getProperty(this.USAGE) || '[]') || []; } catch (e) { list = []; }
    var since = MarketCal.now().getTime() - 86400000;
    return list.filter(function (r) { return r && r[0] > since; });
  },
  usedMs: function () { return this.runs().reduce(function (a, r) { return a + r[1]; }, 0); },
  addRun: function (start, ms) { var list = this.runs(); list.push([start, Math.max(0, Math.round(ms))]); Secrets.props().setProperty(this.USAGE, JSON.stringify(list.slice(-80))); },
  /** The first quiet moment after enough of the budget is free again for a step (old runs leave the 24-hour window). */
  resumeAt: function (needMs) {
    var list = this.runs().sort(function (a, b) { return a[0] - b[0]; }), used = this.usedMs(), budget = this.budgetMs();
    var at = new Date(MarketCal.now().getTime() + 3600000);
    for (var i = 0; i < list.length; i++) { used -= list[i][1]; if (used + needMs <= budget) { at = new Date(list[i][0] + 86400000 + 60000); break; } }
    var d = MarketCal.ymd(at), m = MarketCal.minutes(at);
    if (MarketCal.isTradingDay(d) && m >= 8 * 60 + 30 && m < 18 * 60 + 15) at = MarketCal.at(d, '18:16');
    return at;
  },
  unschedule: function () {
    ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'continueBacktest') ScriptApp.deleteTrigger(t); });
  },

  /** Do as much as fits before the deadline. Returns the job. */
  step: function (deadline) {
    var j = this.job();
    if (!j || j.stage === 'done' || j.stage === 'failed') return j;
    var guard = 0;
    while (Date.now() < deadline - 30000 && j.stage !== 'done' && guard++ < 40) {
      var before = j.stage + ':' + j.cursor + ':' + j.note;
      this.stages[j.stage].call(this, j, deadline);
      j.at = Date.now();
      j.fails = 0;
      this.saveJob(j);
      if (j.stage + ':' + j.cursor + ':' + j.note === before) break; // no progress this time
    }
    return j;
  },

  stages: {
    long: function (j, deadline) {
      var r = LongHistory.step(deadline);
      j.note = 'Loading long price history: ' + r.have + ' of ' + r.total + ' stocks and indices';
      if (r.done) { j.stage = 'intra'; j.note = 'Long price history loaded'; }
    },
    intra: function (j, deadline) {
      var r = IntraHistory.step(deadline);
      j.note = 'Loading 5-minute history: ' + r.have + ' of ' + r.total;
      if (r.done) { j.stage = 'ctx'; j.note = '5-minute history loaded'; }
    },
    ctx: function (j) {
      var c = Backtest.buildContext(j.runId);
      j.stage = 'daily'; j.cursor = 0;
      j.note = 'Market history worked out for ' + c.days + ' sessions';
    },
    daily: function (j, deadline) {
      while (j.cursor < History.PACKS && Date.now() < deadline - 60000) { Backtest.runDaily(j.cursor, j.runId); j.cursor++; }
      j.note = 'Daily strategies: ' + Math.min(j.cursor, History.PACKS) + ' of ' + History.PACKS + ' parts done';
      if (j.cursor >= History.PACKS) { j.stage = 'intraday'; j.cursor = 0; }
    },
    intraday: function (j, deadline) {
      while (j.cursor < History.PACKS && Date.now() < deadline - 60000) { Backtest.runIntraday(j.cursor, j.runId); j.cursor++; }
      j.note = 'Intraday strategies: ' + Math.min(j.cursor, History.PACKS) + ' of ' + History.PACKS + ' parts done';
      if (j.cursor >= History.PACKS) { j.stage = 'report'; j.cursor = 0; }
    },
    report: function (j) {
      Backtest.report(j);
      j.stage = 'done'; j.done = Date.now(); j.note = 'Finished';
    },
  },

  /* ---------- Step 1: the market, day by day ---------- */

  buildContext: function (runId) {
    var P = Scans.params(), series = {};
    var uni = this.universe(), byPack = {};
    uni.forEach(function (s) { var p = History.packOf(s); (byPack[p] || (byPack[p] = [])).push(s); });
    var nifty = LongHistory.get('NIFTY 50'), vix = LongHistory.get('INDIA VIX');
    for (var p = 0; p < History.PACKS; p++) {
      (byPack[p] || []).forEach(function (s) { var x = LongHistory.closes(s); if (x.t.length >= 50) series[s] = x; });
      LongHistory.store().release(p);
      DataFile.releaseDaily(p);
    }
    if (nifty.length < 260) throw new Error('Not enough Nifty 50 history for a backtest (' + nifty.length + ' days)');
    var ctx = SRCore.btContext({ nifty: nifty, vix: vix, series: series, params: P });
    var self = this;
    DataFile.write('bt-context.json', {
      v: 1, runId: runId, days: ctx.days, regime: ctx.regime.map(function (r) { return self.REG[r] || 'U'; }).join(''),
      breadth: ctx.breadth, niftyClose: ctx.niftyClose, rs: ctx.rs, symbols: Object.keys(series).length,
    });
    this._ctx = null;
    return { days: ctx.days.length, symbols: Object.keys(series).length };
  },

  context: function () {
    if (this._ctx) return this._ctx;
    var raw = DataFile.read('bt-context.json');
    if (!raw) throw new Error('The backtest market history is missing. Start the backtest again.');
    var self = this;
    raw.regime = String(raw.regime).split('').map(function (ch) { return self.REG_BACK[ch] || 'UNKNOWN'; });
    this._ctx = raw;
    return raw;
  },

  /** Paper sizing and charges, with fractional shares so expensive stocks still get a rupee result. */
  sizing: function () { var s = Review.sizing(); s.fractional = true; return s; },

  /* ---------- Step 2: the daily strategies, one data file at a time ---------- */

  runDaily: function (p, runId) {
    var ctx = this.context(), P = Scans.params(), sizing = this.sizing(), rates = Review.rates(), self = this;
    var ids = SRCore.STRATEGIES.filter(function (s) { return s.kind === 'daily'; }).map(function (s) { return s.id; });
    var trades = [], open = 0, notTriggered = 0, n = 0;
    this.universe().filter(function (s) { return History.packOf(s) === p; }).forEach(function (s) {
      var k = LongHistory.get(s);
      if (k.length < 260) return;
      n++;
      var r = SRCore.backtestDaily(s, k, { params: P, strategies: ids, ctx: ctx, sizing: sizing, rates: rates });
      r.trades.forEach(function (t) { trades.push(self.pack(t)); });
      open += r.open; notTriggered += r.notTriggered;
    });
    LongHistory.store().release(p);
    DataFile.releaseDaily(p);
    DataFile.write('btd-' + DataFile.pad(p) + '.json', { runId: runId, p: p, symbols: n, open: open, notTriggered: notTriggered, trades: trades });
  },

  /* ---------- Step 3: the intraday strategies on 5-minute history ---------- */

  runIntraday: function (p, runId) {
    var ctx = this.context(), P = Scans.params(), sizing = this.sizing(), rates = Review.rates(), self = this;
    if (!this._nifty5) this._nifty5 = IntraHistory.get(IntraHistory.NIFTY);
    var regimeByDay = {};
    for (var j = 1; j < ctx.days.length; j++) regimeByDay[ctx.days[j]] = ctx.regime[j - 1]; // the regime known that morning
    var opts = {
      params: P, strategies: SRCore.STRATEGIES.filter(function (s) { return s.kind === 'intraday'; }).map(function (s) { return s.id; }),
      niftyBars: this._nifty5, regimeByDay: regimeByDay, followNifty: Config.get('intradayFollowNifty') !== false,
      block: { BUY: Config.get('intradayBlockBuysInBear') === true ? ['BEAR'] : [], SHORT: Config.get('intradayBlockShortsInBull') === true ? ['BULL'] : [] },
      onePerStock: Config.get('intradayOneAlertPerStock') !== false, cooldownMinutes: Number(Config.get('alertCooldownMinutes')) || 60,
      lastEntryMinute: Config.minutesOf('noEntriesAfter'), expiryMinute: Config.minutesOf('intradayExpiry'), sizing: sizing, rates: rates,
    };
    var trades = [], open = 0, notTriggered = 0, n = 0;
    IntraHistory.targets().filter(function (it) { return it.key !== IntraHistory.NIFTY && History.packOf(it.key) === p; }).forEach(function (it) {
      var bars = IntraHistory.get(it.key);
      if (bars.length < 300) return;
      n++;
      var r = SRCore.backtestIntraday(it.key, bars, opts);
      r.trades.forEach(function (t) { trades.push(self.pack(t)); });
      open += r.open; notTriggered += r.notTriggered;
    });
    if (History.packOf(IntraHistory.NIFTY) !== p) IntraHistory.store().release(p);
    DataFile.write('bti-' + DataFile.pad(p) + '.json', { runId: runId, p: p, symbols: n, open: open, notTriggered: notTriggered, trades: trades });
  },

  /** A trade in a compact row: [symbol, strategy, shadow, regime, alert minute, fill minute, exit minute, outcome, net %, net ₹, hold, alpha, short, blocked by]. */
  pack: function (t) {
    var m = function (x) { return typeof x === 'number' ? Math.round(x / 60000) : 0; };
    return [t.symbol, t.strategy, t.track === 'shadow' ? 1 : 0, this.REG[t.regime] || 'U', m(t.dayT), m(t.fillT), m(t.exitT), this.OUT[t.outcome] || 'E',
      t.netPct, t.netPnl === null ? null : Math.round(t.netPnl * 100) / 100, t.holdDays, t.alphaPct, t.direction === 'SHORT' ? 1 : 0, t.blocked ? Review.blockKind(t.blocked) : ''];
  },
  unpack: function (a) {
    return {
      symbol: a[0], strategy: a[1], track: a[2] ? 'shadow' : 'main', regime: this.REG_BACK[a[3]] || 'UNKNOWN', dayT: a[4] * 60000, fillT: a[5] * 60000, exitT: a[6] * 60000,
      outcome: this.OUT_BACK[a[7]] || 'EXPIRED', netPct: a[8], netPnl: a[9], holdDays: a[10], alphaPct: a[11], direction: a[12] ? 'SHORT' : 'BUY', blockedBy: a[13] || '',
    };
  },

  /* ---------- Step 4: the report ---------- */

  report: function (j) {
    var self = this, cap = Review.sizing().capital, rules = Review.rules(), all = [], parts = { daily: { symbols: 0, open: 0, nt: 0 }, intraday: { symbols: 0, open: 0, nt: 0 } };
    for (var p = 0; p < History.PACKS; p++) {
      [['btd-', 'daily'], ['bti-', 'intraday']].forEach(function (f) {
        var d = DataFile.read(f[0] + DataFile.pad(p) + '.json');
        if (!d || d.runId !== j.runId) return;
        parts[f[1]].symbols += d.symbols || 0; parts[f[1]].open += d.open || 0; parts[f[1]].nt += d.notTriggered || 0;
        d.trades.forEach(function (a) { all.push(self.unpack(a)); });
      });
    }
    var ctx = this.context(), intraDays = this.intraDays();
    var result = {
      runId: j.runId, at: Date.now(), capital: cap, riskPct: Review.sizing().riskPct, universe: this.universeName(),
      daily: { from: this.ymdOfDay(ctx.days[199] || ctx.days[0]), to: this.ymdOfDay(ctx.days[ctx.days.length - 1]), symbols: parts.daily.symbols, open: parts.daily.open, notTriggered: parts.daily.nt },
      intraday: { from: intraDays.from, to: intraDays.to, sessions: intraDays.n, symbols: parts.intraday.symbols, open: parts.intraday.open, notTriggered: parts.intraday.nt,
        rules: { followNifty: Config.get('intradayFollowNifty') !== false, blockBuysInBear: Config.get('intradayBlockBuysInBear') === true, blockShortsInBull: Config.get('intradayBlockShortsInBull') === true, onePerStock: Config.get('intradayOneAlertPerStock') !== false } },
      strategies: {}, filter: [],
    };
    var compact = {};
    SRCore.STRATEGIES.forEach(function (st) {
      if (st.kind !== 'daily' && st.kind !== 'intraday') return;
      var mine = all.filter(function (x) { return x.strategy === st.id; });
      var main = mine.filter(function (x) { return x.track === 'main'; }), shadow = mine.filter(function (x) { return x.track === 'shadow'; });
      var s = SRCore.btSummary(main, { capital: cap }), sh = SRCore.metrics(shadow, { capital: cap });
      var verdict = self.verdict(s.metrics, rules);
      // The trades arrive one data file at a time: sort by exit time so "latest trades" really are the latest.
      var latest = main.slice().sort(function (a, b) { return (a.exitT - b.exitT) || (a.dayT - b.dayT); }).slice(-20).reverse();
      result.strategies[st.id] = {
        name: st.name, horizon: st.horizon, verdict: verdict, metrics: s.metrics, regimes: s.regimes, years: s.years, curve: s.curve, maxOpen: s.maxOpen, cagrPct: s.cagrPct,
        from: s.from, to: s.to, shadow: { trades: sh.trades, winRatePct: sh.winRatePct, expectancyPct: sh.expectancyPct, profitFactor: sh.profitFactor },
        sample: latest.map(function (x) { return [x.symbol, x.dayT, x.direction === 'SHORT' ? 'S' : 'B', x.outcome.charAt(0), x.netPct, x.exitT]; }),
      };
      var m = s.metrics;
      compact[st.id] = [m.trades, m.days, m.winRatePct, m.expectancyPct, m.profitFactor, m.maxDrawdownPct, m.avgAlphaPct, s.cagrPct, verdict];
    });
    result.filter = this.filterCheck(all, cap);
    DataFile.write('bt-result.json', result);
    var sum = { runId: j.runId, at: result.at, universe: result.universe, daily: result.daily, intraday: { from: result.intraday.from, to: result.intraday.to, sessions: result.intraday.sessions, symbols: result.intraday.symbols }, s: compact };
    Secrets.props().setProperty(this.SUMMARY, JSON.stringify(sum));
    this.writeSheet(result);
    var first = !!j.first;
    var text = this.message(result, first, rules);
    Notify.safeTelegram(text);
    if (Config.get('emailDigest')) { try { Notify.email(first ? 'Backtest Baseline' : 'Backtest refreshed', Notify.htmlFromTelegram(text)); } catch (e) { ErrorLog.add('backtestEmail', e); } }
    var n = Object.keys(compact).reduce(function (a, k) { return a + compact[k][0]; }, 0);
    Review.saveReport('backtest', (first ? 'Backtest Baseline ' : 'Backtest refreshed ') + MarketCal.ymd(), n + ' trades on ' + result.daily.symbols + ' stocks, ' + result.daily.from + ' to ' + result.daily.to, { runId: j.runId });
    return result;
  },

  ymdOfDay: function (dayN) { return dayN ? Utilities.formatDate(new Date(dayN * 86400000), 'UTC', 'yyyy-MM-dd') : ''; },

  intraDays: function () {
    var k = this._nifty5 || IntraHistory.get(IntraHistory.NIFTY), seen = {}, n = 0;
    k.forEach(function (b) { var d = SRCore.util.istDay(b.t); if (!seen[d]) { seen[d] = true; n++; } });
    return { n: n, from: k.length ? MarketCal.ymd(new Date(k[0].t)) : '', to: k.length ? MarketCal.ymd(new Date(k[k.length - 1].t)) : '' };
  },

  /** ✅ positive after charges with a strong profit factor, ⚠️ positive but thin, ⛔ loses after charges, · too few trades. */
  verdict: function (m, rules) {
    if (!m || m.trades < 30) return 'few';
    if (!(m.expectancyPct > 0)) return 'loses';
    return m.profitFactor === null || m.profitFactor >= rules.minPF ? 'good' : 'thin';
  },

  /** Signals the market filters held back, against those taken, per horizon and filter. */
  filterCheck: function (all, cap) {
    var out = [], names = { regime: 'the regime', switch: 'your Bear/Bull switch', day: 'the day\'s direction' };
    ['INTRADAY', 'SWING', 'MEDIUM'].forEach(function (h) {
      var sh = all.filter(function (x) { return x.track === 'shadow' && SRCore.strategy(x.strategy) && SRCore.strategy(x.strategy).horizon === h; });
      if (!sh.length) return;
      var mn = all.filter(function (x) { return x.track === 'main' && SRCore.strategy(x.strategy) && SRCore.strategy(x.strategy).horizon === h; });
      var b = SRCore.metrics(mn, { capital: cap }), kinds = {};
      sh.forEach(function (x) { kinds[x.blockedBy || 'regime'] = true; });
      Object.keys(kinds).forEach(function (k) {
        var a = SRCore.metrics(sh.filter(function (x) { return (x.blockedBy || 'regime') === k; }), { capital: cap });
        out.push({ horizon: h, filter: k, by: names[k], blocked: a.trades, blockedAvg: a.expectancyPct, blockedWin: a.winRatePct, taken: b.trades, takenAvg: b.expectancyPct, takenWin: b.winRatePct });
      });
    });
    return out;
  },

  writeSheet: function (r) {
    var rows = [], now = new Date();
    Tables.ensure('Backtests', ['runId', 'strategy', 'horizon', 'from', 'to', 'symbols', 'trades', 'winRatePct', 'avgNetPct', 'profitFactor', 'maxDrawdownPct', 'cagrPct', 'createdAt', 'days', 'alphaPct', 'verdict', 'blockedTrades', 'blockedAvgPct']);
    Object.keys(r.strategies).forEach(function (id) {
      var s = r.strategies[id], m = s.metrics, intra = s.horizon === 'INTRADAY';
      rows.push({
        runId: r.runId, strategy: id, horizon: s.horizon, from: intra ? r.intraday.from : r.daily.from, to: intra ? r.intraday.to : r.daily.to,
        symbols: intra ? r.intraday.symbols : r.daily.symbols, trades: m.trades, winRatePct: m.winRatePct, avgNetPct: m.expectancyPct, profitFactor: m.profitFactor,
        maxDrawdownPct: m.maxDrawdownPct, cagrPct: s.cagrPct, createdAt: now, days: m.days, alphaPct: m.avgAlphaPct, verdict: s.verdict,
        blockedTrades: s.shadow.trades, blockedAvgPct: s.shadow.expectancyPct,
      });
    });
    Store.append('Backtests', rows);
  },

  /** The Backtest Baseline (or refresh) message for Telegram and email. */
  message: function (r, first, rules) {
    var e = Notify.esc, L = [], icons = { good: '✅', thin: '⚠️', loses: '⛔', few: '·' };
    var mon = function (ymd) { return ymd ? Utilities.formatDate(new Date(ymd + 'T12:00:00+05:30'), IST, 'MMM yyyy') : '—'; };
    L.push((first ? '🧪 <b>Backtest Baseline</b>' : '🧪 <b>Backtest refreshed</b>'));
    L.push('How each strategy would have done on past prices, with the same rules, fills and Zerodha charges as your paper trades.');
    var line = function (id) {
      var s = r.strategies[id], m = s.metrics;
      if (!m.trades) return icons.few + ' ' + e(s.name) + ': no trades';
      return icons[s.verdict] + ' ' + e(s.name) + ': ' + Fmt.num(m.trades, 0) + ' trades · win ' + m.winRatePct + '% · avg ' + Fmt.pct(m.expectancyPct) +
        (m.profitFactor !== null ? ' · PF ' + m.profitFactor.toFixed(2) : ' · no losses') + ' · worst drop ' + (m.maxDrawdownPct || 0).toFixed(1) + '%';
    };
    var groups = [['SWING', 'Swing'], ['MEDIUM', 'Medium term'], ['INTRADAY', 'Intraday']];
    groups.forEach(function (g) {
      var ids = Object.keys(r.strategies).filter(function (id) { return r.strategies[id].horizon === g[0]; });
      if (!ids.length) return;
      L.push('');
      if (g[0] === 'INTRADAY') L.push('<b>' + g[1] + '</b> · ' + r.intraday.symbols + ' stocks · last ' + r.intraday.sessions + ' sessions on 5-minute bars · your current intraday rules');
      else L.push('<b>' + g[1] + '</b> · ' + r.daily.symbols + ' ' + e(r.universe) + ' stocks · ' + mon(r.daily.from) + ' – ' + mon(r.daily.to));
      ids.forEach(function (id) { L.push(line(id)); });
    });
    L.push('', '✅ positive after charges, profit factor ≥ ' + rules.minPF + ' · ⚠️ positive but thin · ⛔ loses after charges · · fewer than 30 trades');
    if (r.filter.length) {
      L.push('', '<b>Filter check</b> (signals a filter held back vs those taken)');
      var hz = { INTRADAY: 'Intraday', SWING: 'Swing', MEDIUM: 'Medium' };
      r.filter.forEach(function (f) {
        L.push(hz[f.horizon] + ', ' + f.by + ': blocked ' + Fmt.num(f.blocked, 0) + ' averaged ' + Fmt.pct(f.blockedAvg) + (f.taken ? ' vs ' + Fmt.pct(f.takenAvg) + ' for the ' + Fmt.num(f.taken, 0) + ' taken' : ''));
      });
    }
    L.push('', 'Read with care: today\'s ' + e(r.universe) + ' list is used for the whole period, so stocks that dropped out (often the losers) are missing, which flatters the results. Each trade is sized like the paper account, as if it were the only position. Intraday uses 5-minute bars, a little coarser than the live 1-minute check. Past results do not promise future ones.');
    L.push('Details: app → More → Backtest lab.');
    return L.join('\n');
  },

  /* ---------- Scheduling around the engine ---------- */

  /** After a close: the first time Phase 5 runs, start the baseline in the evening. */
  autoStart: function () {
    if (this.summary() || this.running()) return false;
    if (Secrets.props().getProperty('BT_AUTO_TRIED')) return false;
    Secrets.props().setProperty('BT_AUTO_TRIED', MarketCal.ymd());
    this.start('auto');
    this.schedule();
    return true;
  },

  /** Saturday: refresh the baseline when it is older than backtestRefreshDays. */
  weeklyCheck: function () {
    var s = this.summary(), days = Math.max(7, Number(Config.get('backtestRefreshDays')) || 30);
    if (this.running() || !s || Date.now() - s.at < days * 86400000) return false;
    this.start('monthly');
    this.schedule();
    return true;
  },

  /** What the app shows about the backtest. */
  info: function () {
    var j = this.job(), s = this.summary();
    var state = j && j.stage !== 'done' && j.stage !== 'failed' ? 'running' : j && j.stage === 'failed' ? 'failed' : s ? 'done' : 'none';
    return { state: state, note: j ? j.note : '', at: j ? j.at : null, error: j && j.stage === 'failed' ? j.error || '' : '', summary: s };
  },
};

/**
 * Trigger handler: one step of the backtest, then the next one a minute later until it is done. A step is about
 * four minutes; when the backtest has used its share of today's trigger time it waits until that share frees up.
 */
function continueBacktest() {
  Backtest.unschedule();
  if (!Backtest.quiet()) { Backtest.schedule(); return; }
  var left = Backtest.budgetMs() - Backtest.usedMs();
  if (left < 90000) {
    var at = Backtest.resumeAt(270000), jw = Backtest.job();
    if (jw && jw.stage !== 'done' && jw.stage !== 'failed') {
      jw.note = String(jw.note || '').replace(/ · paused.*$/, '') + ' · paused for today\'s time limit, continues ' + Fmt.day(MarketCal.ymd(at)) + ' ' + Fmt.time(at.getTime());
      Backtest.saveJob(jw);
    }
    ScriptApp.newTrigger('continueBacktest').timeBased().at(at).create();
    return;
  }
  var t0 = Date.now(), started = MarketCal.now().getTime();
  var r = Jobs.run('backtest', function () { return Backtest.step(t0 + Math.min(270000, left)); }, { lock: true, wait: 20000 });
  Backtest.addRun(started, Date.now() - t0);
  var j = Backtest.job();
  if (!j) return;
  if (r === null) {
    j.fails = (j.fails || 0) + 1;
    if (j.fails >= 4) {
      j.stage = 'failed'; j.error = (Jobs.status().backtest || {}).lastError || 'unknown error';
      Backtest.saveJob(j);
      Notify.safeTelegram('⚠️ <b>Backtest stopped</b> after four failed tries at the step "' + Notify.esc(j.note) + '": ' + Notify.esc(j.error) + '\nStart it again from the sheet: Stock Radar → 7. Backtest.');
      return;
    }
    Backtest.saveJob(j);
    Backtest.schedule(5 * 60000);
    return;
  }
  if (j.stage !== 'done' && j.stage !== 'failed') Backtest.schedule();
}

/** Stock Radar → 7. Backtest. Loads long history if needed and runs the Backtest Baseline in the background. */
function menuBacktest() {
  var j = Backtest.start('menu');
  var at = Backtest.schedule(30000);
  var when = Backtest.quiet() ? 'in about a minute' : 'at ' + Fmt.time(at.getTime()) + ' today (it runs outside market hours so it never slows the live engine)';
  Ui.alert('Backtest', (j.stage === 'long' && j.note === 'Waiting to start' ? 'The backtest starts ' : 'The backtest continues ') + when + '.\n\n' +
    'The first run loads up to ' + LongHistory.years() + ' years of daily prices for about ' + (Backtest.universe().length + 3) + ' stocks and indices, and ' + IntraHistory.days() +
    ' sessions of 5-minute prices for the intraday stocks, then tests every strategy. It works in the background a few minutes at a time and sends the ' +
    (j.first ? 'Backtest Baseline report' : 'refreshed results') + ' to Telegram when it is done, usually within an hour. You can close this sheet.');
  return j;
}

/* ============================== Data for the app's Backtest lab ============================== */

var LabData = {
  MAX_DAILY: 25,
  MAX_INTRA: 8,

  /** Stock lists the lab can test, with the backtest result. */
  overview: function () {
    var result = null;
    try { result = DataFile.read('bt-result.json'); } catch (e) { result = null; }
    var daily = Backtest.universe().slice().sort(), all = SymbolsDb.load();
    return {
      result: result, info: Backtest.info(), paramInfo: SRCore.PARAMS,
      lists: {
        nifty50: daily.filter(function (s) { return all[s] && all[s].nifty50; }), universe: daily, universeName: Backtest.universeName(),
        watchlist: Config.symbols('watchlist'), intraday: IntraHistory.targets().map(function (it) { return it.key; }).filter(function (s) { return s !== IntraHistory.NIFTY; }),
      },
    };
  },

  /** Daily history for some stocks, with the market context (regime, relative strength) on each day. */
  daily: function (symbols, withMarket) {
    symbols = this.clean(symbols, this.MAX_DAILY);
    var ctx = Backtest.context(), out = { series: {}, rs: {} };
    symbols.forEach(function (s) {
      var k = LongHistory.get(s);
      if (!k.length) return;
      var col = { d: [], o: [], h: [], l: [], c: [], v: [] };
      k.forEach(function (c) { col.d.push(History.msToDay(c.t)); col.o.push(c.o); col.h.push(c.h); col.l.push(c.l); col.c.push(c.c); col.v.push(c.v); });
      out.series[s] = col;
      out.rs[s] = ctx.rs[s] || null;
    });
    if (withMarket) out.market = { days: ctx.days, regime: ctx.regime.map(function (r) { return Backtest.REG[r] || 'U'; }).join(''), niftyClose: ctx.niftyClose };
    return out;
  },

  /** 5-minute history for some stocks, with Nifty 50 and the regime known each morning. */
  intraday: function (symbols, withMarket) {
    symbols = this.clean(symbols, this.MAX_INTRA);
    var st = IntraHistory.store(), out = { series: {} };
    symbols.forEach(function (s) { var r = st.rec(s); if (r && r.t && r.t.length) out.series[s] = { t: r.t, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v }; });
    if (withMarket) {
      var n = st.rec(IntraHistory.NIFTY), ctx = Backtest.context(), reg = {};
      for (var j = 1; j < ctx.days.length; j++) reg[ctx.days[j]] = Backtest.REG[ctx.regime[j - 1]] || 'U';
      out.market = { nifty: n ? { t: n.t, o: n.o, h: n.h, l: n.l, c: n.c, v: n.v } : null, regimeByDay: reg };
    }
    return out;
  },

  clean: function (symbols, max) {
    return (symbols || []).map(function (x) { return String(x).trim().toUpperCase(); }).filter(function (x) { return /^[A-Z0-9&-]{1,20}$/.test(x); }).slice(0, max);
  },
};

/* ============================== Holdings (Portfolio) ============================== */

var Portfolio = {
  COLS: ['symbol', 'qty', 'avgPrice', 'lastPrice', 'sector', 'importedAt', 'isin', 'longTermQty', 'buyDate', 'stop', 'target', 'prevClose', 'dma200', 'trailStop', 'valuedAt', 'source', 'name'],
  MAX: 300,

  ensure: function () { return Tables.ensure('Holdings', this.COLS); },
  rows: function () { return Store.readObjects('Holdings').filter(function (r) { return r.symbol && Number(r.qty) > 0; }); },
  /** NSE symbol from what brokers write: RELIANCE, RELIANCE-EQ, RELIANCE.NS, NSE:RELIANCE. */
  clean: function (s) { return String(s || '').trim().toUpperCase().replace(/^(NSE|BSE):/, '').replace(/\.(NS|BO)$/, '').replace(/-(EQ|BE|BZ|BL|SM|ST|IV|RR)$/, ''); },
  pos: function (v) { var n = Number(v); return isFinite(n) && n > 0 ? n : null; },
  count: function (v) { var n = Number(v); return v === '' || v === null || v === undefined || !isFinite(n) || n < 0 ? '' : n; },
  dateOrBlank: function (v) {
    if (v instanceof Date) return MarketCal.ymd(v);
    var s = String(v || '').trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
  },

  /** Replace the holdings with a list from the app. Your stop, target and buy date stay for stocks you still hold. */
  replace: function (list, source) {
    if (!Array.isArray(list) || !list.length) throw new Error('No holdings in the file');
    if (list.length > this.MAX) throw new Error('Too many rows (' + list.length + '); the limit is ' + this.MAX);
    this.ensure();
    var keep = {}, self = this, now = new Date(), meta = SymbolsDb.load(), out = [], bad = [];
    this.rows().forEach(function (r) { keep[String(r.symbol).toUpperCase()] = r; });
    var merged = {};
    list.forEach(function (h) {
      var sym = self.clean(h.symbol), qty = Number(h.qty), avg = Number(h.avgPrice);
      if (!/^[A-Z0-9&-]{1,20}$/.test(sym) || !(qty > 0) || !(avg >= 0) || qty > 1e9) { bad.push(String(h.symbol || '?')); return; }
      var m = merged[sym];
      if (m) { m.avgPrice = (m.avgPrice * m.qty + avg * qty) / (m.qty + qty); m.qty += qty; if (self.count(h.longTermQty) !== '') m.longTermQty = (Number(m.longTermQty) || 0) + Number(h.longTermQty); return; }
      var old = keep[sym] || {};
      merged[sym] = {
        symbol: sym, qty: qty, avgPrice: avg, lastPrice: self.pos(h.lastPrice) || old.lastPrice || '', sector: String(h.sector || old.sector || (meta[sym] && meta[sym].sector) || '').slice(0, 60),
        importedAt: now, isin: String(h.isin || old.isin || '').slice(0, 12), longTermQty: self.count(h.longTermQty),
        buyDate: self.dateOrBlank(h.buyDate) || self.dateOrBlank(old.buyDate), stop: old.stop || '', target: old.target || '', prevClose: old.prevClose || '',
        dma200: old.dma200 || '', trailStop: old.trailStop || '', valuedAt: old.valuedAt || '', source: String(source || '').slice(0, 60), name: String((meta[sym] && meta[sym].name) || h.name || '').slice(0, 80),
      };
    });
    Object.keys(merged).sort().forEach(function (s) { out.push(merged[s]); });
    if (!out.length) throw new Error('None of the rows had a symbol, a quantity and an average price');
    Store.replaceAll('Holdings', out);
    var unknown = out.filter(function (h) { return !meta[h.symbol]; }).map(function (h) { return h.symbol; });
    if (unknown.length) { try { SymbolsDb.lookup(unknown.slice(0, 30)); } catch (e) { ErrorLog.add('holdingsLookup', e); } }
    this.scheduleValue();
    return { saved: out.length, skipped: bad.slice(0, 20), unknown: unknown.slice(0, 20) };
  },

  /** Change your stop-loss, target or buy date for one holding (blank clears it). */
  edit: function (symbol, patch) {
    this.ensure();
    var t = Tables.read('Holdings'), sym = this.clean(symbol), self = this, hit = null;
    t.rows.forEach(function (r) { if (String(r.symbol).toUpperCase() === sym) hit = r; });
    if (!hit) throw new Error(sym + ' is not in your holdings');
    if (patch.stop !== undefined) hit.stop = patch.stop === '' || patch.stop === null ? '' : self.check(patch.stop, 'Stop-loss');
    if (patch.target !== undefined) hit.target = patch.target === '' || patch.target === null ? '' : self.check(patch.target, 'Target');
    if (patch.buyDate !== undefined) {
      var d = this.dateOrBlank(patch.buyDate);
      if (patch.buyDate && !d) throw new Error('Buy date must look like 2025-12-31');
      if (d && d > MarketCal.ymd()) throw new Error('The buy date is in the future');
      hit.buyDate = d;
    }
    Tables.writeCols(t, ['stop', 'target', 'buyDate'], 0);
    return hit;
  },
  check: function (v, what) { var n = Number(v); if (!(isFinite(n) && n > 0 && n < 1e7)) throw new Error(what + ' must be a price in rupees'); return n; },

  clear: function () { this.ensure(); Store.replaceAll('Holdings', []); return { saved: 0 }; },

  /** A minute after an import: work out each holding's close, 200-day average and trailing stop. */
  scheduleValue: function () {
    ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'valueHoldings') ScriptApp.deleteTrigger(t); });
    ScriptApp.newTrigger('valueHoldings').timeBased().after(60000).create();
  },

  /** Each holding's latest close, previous close, 200-day average and trailing stop (the holding guard's rule). */
  value: function () {
    this.ensure();
    var t = Tables.read('Holdings'), P = Scans.params(), L = Math.round(P['guard.lookback']), now = new Date();
    if (!t.rows.length) return 0;
    var n = 0;
    t.rows.forEach(function (r) {
      var k = History.get(String(r.symbol).toUpperCase());
      if (k.length < 2) return;
      var c = SRCore.util.pluck(k, 'c'), i = c.length - 1, s200 = SRCore.ind.sma(c, 200)[i], a = SRCore.ind.atr(k, L)[i];
      r.lastPrice = c[i]; r.prevClose = c[i - 1];
      r.dma200 = s200 === null ? '' : Math.round(s200 * 100) / 100;
      r.trailStop = a === null || i < L ? '' : Math.round((SRCore.util.maxOf(c, i - L + 1, i) - P['guard.atrMult'] * a) * 100) / 100;
      r.valuedAt = now;
      n++;
    });
    Tables.writeCols(t, ['lastPrice', 'prevClose', 'dma200', 'trailStop', 'valuedAt'], 0);
    return n;
  },

  /** The holdings as the app shows them: values, P&L, weights, sectors, warnings and per-stock flags. */
  view: function () {
    var rows = this.rows();
    if (!rows.length) return null;
    var meta = SymbolsDb.load(), num = function (v) { var n = Number(v); return v !== '' && v !== null && isFinite(n) ? n : null; };
    var maxStock = Number(Config.get('portfolioMaxStockPct')) || 20, maxSector = Number(Config.get('portfolioMaxSectorPct')) || 35;
    var today = MarketCal.ymd(), list = [], tot = { invested: 0, value: 0, day: 0, dayBase: 0 }, sectors = {}, last = null, imported = null, source = '';
    rows.forEach(function (r) {
      var sym = String(r.symbol).toUpperCase(), qty = Number(r.qty), avg = Number(r.avgPrice), px = num(r.lastPrice), prev = num(r.prevClose);
      var m = meta[sym] || {}, sector = String(r.sector || m.sector || '').trim() || 'Other';
      var value = qty * (px || avg), invested = qty * avg;
      tot.invested += invested; tot.value += value;
      if (px && prev) { tot.day += qty * (px - prev); tot.dayBase += qty * prev; }
      sectors[sector] = (sectors[sector] || 0) + value;
      var buy = Portfolio.dateOrBlank(r.buyDate), lt = null;
      if (buy) {
        var held = Math.round((Date.parse(today + 'T12:00:00+05:30') - Date.parse(buy + 'T12:00:00+05:30')) / 86400000);
        var ltDay = Review.addMonths(buy, 12);
        lt = { held: held, longTermFrom: ltDay, soon: held >= 335 && held <= 365 };
      }
      var flags = [];
      if (px && num(r.dma200) && px < num(r.dma200)) flags.push('below200');
      if (px && num(r.trailStop) && px < num(r.trailStop)) flags.push('trail');
      if (px && num(r.stop) && px <= num(r.stop)) flags.push('stop');
      if (px && num(r.target) && px >= num(r.target)) flags.push('target');
      if (lt && lt.soon) flags.push('ltSoon');
      if (!last || (r.valuedAt instanceof Date && r.valuedAt > last)) last = r.valuedAt instanceof Date ? r.valuedAt : last;
      if (r.importedAt instanceof Date && (!imported || r.importedAt > imported)) imported = r.importedAt;
      source = source || String(r.source || '');
      list.push({
        symbol: sym, name: String(r.name || m.name || ''), sector: sector, qty: qty, avg: avg, last: px, prev: prev, value: Math.round(value * 100) / 100,
        pnl: px ? Math.round((px - avg) * qty * 100) / 100 : null, pnlPct: px && avg > 0 ? Math.round((px / avg - 1) * 10000) / 100 : null,
        dma200: num(r.dma200), trailStop: num(r.trailStop), stop: num(r.stop), target: num(r.target), buyDate: buy, longTermQty: num(r.longTermQty), lt: lt, flags: flags,
      });
    });
    list.forEach(function (h) { h.weightPct = tot.value > 0 ? Math.round(h.value / tot.value * 1000) / 10 : null; });
    list.sort(function (a, b) { return b.value - a.value; });
    var sec = Object.keys(sectors).map(function (s) { return { sector: s, value: Math.round(sectors[s]), pct: tot.value > 0 ? Math.round(sectors[s] / tot.value * 1000) / 10 : 0 }; }).sort(function (a, b) { return b.value - a.value; });
    var warnings = [];
    list.forEach(function (h) { if (h.weightPct > maxStock) warnings.push({ kind: 'stock', symbol: h.symbol, pct: h.weightPct, limit: maxStock }); });
    sec.forEach(function (s) { if (s.pct > maxSector && s.sector !== 'Other') warnings.push({ kind: 'sector', sector: s.sector, pct: s.pct, limit: maxSector }); });
    return {
      holdings: list, sectors: sec, warnings: warnings, limits: { stock: maxStock, sector: maxSector },
      totals: { invested: Math.round(tot.invested), value: Math.round(tot.value), pnl: Math.round(tot.value - tot.invested), pnlPct: tot.invested > 0 ? Math.round((tot.value / tot.invested - 1) * 10000) / 100 : null,
        dayPnl: Math.round(tot.day), dayPct: tot.dayBase > 0 ? Math.round(tot.day / tot.dayBase * 10000) / 100 : null },
      valuedAt: last ? last.getTime() : null, importedAt: imported ? imported.getTime() : null, source: source,
    };
  },

  /** A Telegram note once per holding when it is about to complete 12 months (from your buy date). */
  taxNotes: function () {
    var p = Secrets.props(), done = (p.getProperty('LT_NOTES') || '').split(',').filter(Boolean), sent = 0, v = this.view();
    if (!v) return 0;
    v.holdings.forEach(function (h) {
      if (!h.lt || !h.lt.soon) return;
      var key = h.symbol + ':' + h.buyDate;
      if (done.indexOf(key) >= 0) return;
      Notify.safeTelegram('📅 <b>' + Notify.esc(h.symbol) + ' completes 12 months on ' + Fmt.day(h.lt.longTermFrom) + '</b>\nYou bought on ' + Fmt.day(h.buyDate) + '. Listed shares held for more than 12 months are taxed as long-term capital gains, usually at a lower rate than short-term. If you plan to sell, check the dates and current tax rates first. Not tax advice.');
      done.push(key); sent++;
    });
    if (sent) p.setProperty('LT_NOTES', done.slice(-200).join(','));
    return sent;
  },
};

/** Trigger handler: value the holdings a minute after an import. */
function valueHoldings() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'valueHoldings') ScriptApp.deleteTrigger(t); });
  Jobs.run('valueHoldings', function () { return Portfolio.value(); }, { lock: true, wait: 30000 });
}

/* ============================== Fundamentals import ============================== */

var FundImport = {
  FIELDS: ['roePct', 'rocePct', 'debtToEquity', 'sales3yPct', 'profit3yPct', 'promoterPct', 'pledgePct', 'pe', 'pe5yMedian', 'fcf'],
  MAX: 2500,

  /** Company names compared loosely: "Reliance Industries Ltd." and "RELIANCE INDUSTRIES" match. */
  norm: function (name) {
    return String(name || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\b(limited|ltd|the)\b/g, ' ').replace(/\s+/g, ' ').trim();
  },

  /**
   * Save fundamentals mapped by the app (one object per company with the FIELDS it found, plus symbol and/or name).
   * Matches each row to an NSE symbol, then replaces those symbols' rows in the Fundamentals sheet.
   */
  save: function (rows, source) {
    if (!Array.isArray(rows) || !rows.length) throw new Error('No rows to import');
    if (rows.length > this.MAX) throw new Error('Too many rows (' + rows.length + '); the limit is ' + this.MAX);
    var meta = SymbolsDb.load(), byName = {}, names = [], self = this;
    Object.keys(meta).forEach(function (s) {
      if (meta[s].type === 'INDEX') return;
      var n = self.norm(meta[s].name);
      if (n) { byName[n] = s; names.push([n, s]); }
    });
    var found = {}, unmatched = [], fieldCount = {}, now = new Date();
    this.FIELDS.forEach(function (f) { fieldCount[f] = 0; });
    rows.forEach(function (r) {
      var sym = Portfolio.clean(r.symbol);
      if (!(sym && meta[sym] && meta[sym].type !== 'INDEX')) sym = self.match(r.name, byName, names);
      if (!sym) { if (r.name || r.symbol) unmatched.push(String(r.name || r.symbol).slice(0, 60)); return; }
      var o = { symbol: sym, source: String(source || 'Import').slice(0, 60), updatedAt: now };
      self.FIELDS.forEach(function (f) {
        var v = Number(r[f]);
        if (r[f] !== '' && r[f] !== null && r[f] !== undefined && isFinite(v)) { o[f] = Math.round(v * 1000) / 1000; fieldCount[f]++; } else o[f] = '';
      });
      found[sym] = o;
    });
    var syms = Object.keys(found);
    if (!syms.length) throw new Error('No row could be matched to an NSE stock. Add an "NSE Code" column to the export, or check the company names.');
    Tables.ensure('Fundamentals', ['symbol'].concat(this.FIELDS, ['source', 'updatedAt']));
    var keep = Store.readObjects('Fundamentals').filter(function (r) { return r.symbol && !found[String(r.symbol).toUpperCase()]; });
    Store.replaceAll('Fundamentals', keep.concat(syms.sort().map(function (s) { return found[s]; })));
    var complete = syms.reduce(function (a, s) { return a + SRCore.qualityValue(Scans.fundamentals(found[s])).completenessPct; }, 0) / syms.length;
    return { matched: syms.length, unmatched: unmatched.slice(0, 40), unmatchedCount: unmatched.length, fields: fieldCount, completenessPct: Math.round(complete), total: keep.length + syms.length };
  },

  /** Exact name first, then a unique name that starts with the other one. */
  match: function (name, byName, names) {
    var n = this.norm(name);
    if (!n) return '';
    if (byName[n]) return byName[n];
    var hits = names.filter(function (x) { return x[0].indexOf(n) === 0 || n.indexOf(x[0]) === 0; });
    return hits.length === 1 && Math.min(n.length, hits[0][0].length) >= 6 ? hits[0][1] : '';
  },
};

/* ============================== AI summaries (optional) ============================== */

var AiSummary = {
  URL: 'https://generativelanguage.googleapis.com/v1beta/models/',

  status: function () { return { enabled: Config.get('aiSummaries') === true, key: Secrets.has('GEMINI_API_KEY'), model: this.model() }; },
  model: function () { return String(Config.get('aiModel') || 'gemini-3.5-flash-lite').replace(/[^A-Za-z0-9._-]/g, ''); },

  /** Three short bullets on a stock's recent headlines, from Gemini. Labelled in the app as "AI summary — not a signal". */
  summarise: function (symbol) {
    symbol = String(symbol || '').toUpperCase();
    if (!/^[A-Z0-9&-]{1,20}$/.test(symbol)) throw new Error('Unknown symbol');
    if (Config.get('aiSummaries') !== true) throw new Error('AI summaries are off. Turn them on in the app: Settings → AI summaries.');
    var key = Secrets.get('GEMINI_API_KEY');
    if (!key) throw new Error('No Gemini API key yet. In the sheet: Stock Radar → 2. Set up keys, and paste the key from aistudio.google.com.');
    var cache = CacheService.getScriptCache(), ck = 'ai_' + symbol, hit = cache.get(ck);
    if (hit) { try { return JSON.parse(hit); } catch (e) { /* ask again */ } }
    var news = AppApi.news(symbol), items = (news.items || []).slice(0, 8);
    var base = { symbol: symbol, model: this.model(), at: Date.now(), headlines: items.length };
    if (!items.length) { base.bullets = ['No recent headlines were found for this stock, so there is nothing to summarise.']; return base; }
    var meta = SymbolsDb.load()[symbol] || {}, name = String(meta.name || symbol).replace(/\s+(Ltd|Limited)\.?$/i, '');
    var lines = items.map(function (it, i) { return (i + 1) + '. ' + (it.at ? Utilities.formatDate(new Date(it.at), IST, 'd MMM yyyy') + ' — ' : '') + it.title + (it.source ? ' (' + it.source + ')' : ''); });
    var prompt = 'You summarise stock news for a retail investor in India. Using ONLY the headlines below about ' + name + ' (NSE: ' + symbol + '), ' +
      'write exactly 3 short bullet points, each under 25 words, on what happened recently (results, orders, management, regulation, sector news). ' +
      'Do not give buy, sell or price advice, and do not add facts that are not in the headlines. If the headlines say little, say so in one bullet. ' +
      'Start each bullet with "- ".\n\nHeadlines, newest first:\n' + lines.join('\n');
    var res = Http.request(this.URL + this.model() + ':generateContent', {
      method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': key },
      payload: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 1024 } }),
    }, { retries: 1 });
    if (res.code !== 200 || !res.json) throw new Error('Gemini: ' + Secrets.mask(this.why(res)));
    var text = '';
    var cand = res.json.candidates && res.json.candidates[0];
    ((cand && cand.content && cand.content.parts) || []).forEach(function (p) { if (p.text && !p.thought) text += p.text + '\n'; });
    var bullets = text.split('\n').map(function (l) { return l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').replace(/\*\*/g, '').trim(); }).filter(function (l) { return l.length > 3; }).slice(0, 3)
      .map(function (l) { return l.length > 300 ? l.slice(0, 297) + '…' : l; });
    if (!bullets.length) throw new Error('Gemini sent an empty answer' + (cand && cand.finishReason ? ' (' + cand.finishReason + ')' : '') + '. Try again later.');
    base.bullets = bullets;
    try { cache.put(ck, JSON.stringify(base), 21600); } catch (e) { /* optional */ }
    return base;
  },

  why: function (res) {
    var msg = res.json && res.json.error && res.json.error.message ? res.json.error.message : String(res.text || '').slice(0, 160);
    if (res.code === 400 && /api key/i.test(msg)) return 'the API key was refused. Check it in Stock Radar → 2. Set up keys.';
    if (res.code === 403) return 'this key is not allowed to use the Gemini API (' + msg + ')';
    if (res.code === 404) return 'the model "' + this.model() + '" was not found. Change aiModel in the Config sheet.';
    if (res.code === 429) return 'the free quota is used up for now. Try again in a while.';
    return (res.code ? 'HTTP ' + res.code + ': ' : '') + msg;
  },
};
