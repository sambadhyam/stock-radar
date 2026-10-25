/**
 * Stock Radar — Signals.gs
 * Price history in your Google Drive, the market regime, the end-of-day and intraday scans,
 * and the Alerts log with its Telegram messages. The trading rules themselves live in Core.gs.
 *
 * Price history: one folder "Stock Radar Data" in your Drive with 12 small JSON files
 * (daily-00.json … daily-11.json). Each holds the daily candles of about 45 stocks.
 */

/* ============================== Price history ============================== */

var History = {
  FOLDER: 'Stock Radar Data',
  PACKS: 12,
  KEEP: 2600,                // up to about 10 years of daily candles per stock
  INDICES: ['NIFTY 50', 'INDIA VIX', 'NIFTY BANK'],
  _folder: null,
  _packs: {},
  _dirty: {},

  folder: function () {
    if (this._folder) return this._folder;
    var p = Secrets.props(), id = p.getProperty('HIST_FOLDER_ID'), f = null;
    if (id) { try { f = DriveApp.getFolderById(id); if (f.isTrashed && f.isTrashed()) f = null; } catch (e) { f = null; } }
    if (!f) {
      var it = DriveApp.getFoldersByName(this.FOLDER);
      f = it.hasNext() ? it.next() : DriveApp.createFolder(this.FOLDER);
      p.setProperty('HIST_FOLDER_ID', f.getId());
    }
    this._folder = f;
    return f;
  },

  /** Which of the 12 files a symbol lives in (a fixed hash, so no index file is needed). */
  packOf: function (symbol) {
    var h = 5381, s = String(symbol);
    for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h % this.PACKS;
  },

  fileName: function (p) { return 'daily-' + (p < 10 ? '0' : '') + p + '.json'; },

  file: function (p) {
    var it = this.folder().getFilesByName(this.fileName(p));
    return it.hasNext() ? it.next() : null;
  },

  pack: function (p) {
    if (this._packs[p]) return this._packs[p];
    var f = this.file(p), data = null;
    if (f) { try { data = JSON.parse(f.getBlob().getDataAsString()); } catch (e) { data = null; } }
    if (!data || !data.s) data = { v: 1, s: {} };
    this._packs[p] = data;
    return data;
  },

  flush: function () {
    var self = this, written = 0;
    Object.keys(this._dirty).forEach(function (k) {
      var p = Number(k), json = JSON.stringify(self._packs[p]), f = self.file(p);
      if (f) f.setContent(json); else self.folder().createFile(self.fileName(p), json, 'application/json');
      written++;
    });
    this._dirty = {};
    return written;
  },

  /** Forget what was read in this run (tests use this; the next read comes from Drive again). */
  reset: function () { this._packs = {}; this._dirty = {}; this._folder = null; },

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
    if (!reg) return 'Market regime: not worked out yet.';
    return 'Market regime: <b>' + SRCore.regimeName(reg.state) + '</b>. ' + Notify.esc(reg.reasons.join(' '));
  },

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
        status: status, track: trades > 0 ? { trades: trades, winRatePct: Number(r.winRatePct) || 0, profitFactor: Number(r.profitFactor) || 0 } : null,
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
    var res = Angel.candlesMany(items, 'FIVE_MINUTE', { deadline: deadline });
    var signals = [], stale = 0, scanned = 0, lastEntry = Config.minutesOf('noEntriesAfter'), tracks = StrategyBook.tracks();
    Object.keys(res.data).forEach(function (sym) {
      var bars = res.data[sym].filter(function (b) { return b.t + 300000 <= nowMs - 15000; }); // completed bars only
      if (!bars.length) { stale++; return; }
      var lastEnd = bars[bars.length - 1].t + 300000;
      if (SRCore.util.istDay(bars[bars.length - 1].t) !== SRCore.util.istDay(nowMs) || nowMs - lastEnd > 7 * 60000) { stale++; return; }
      scanned++;
      var r = SRCore.scanIntraday(sym, bars, {
        params: P, regime: reg, strategies: ids, prevClose: ctx.s[sym][0], tradedValueCr: ctx.s[sym][1],
        nowMs: nowMs, lastEntryMinute: lastEntry, tracks: tracks,
      });
      signals = signals.concat(r.signals);
    });
    var fresh = IntraSeen.filter(today, signals, nowMs);
    var out = AlertBook.publish(fresh, { nowMs: nowMs, source: 'Angel One 5-minute candles' });
    Health.log('intradayScan', 'angel', scanned > 0, Date.now() - t0, scanned,
      scanned + ' scanned, ' + stale + ' without fresh bars, ' + Object.keys(res.failed).length + ' failed, ' + res.left.length + ' left for time; ' + fresh.length + ' new signals', 30);
    if (!scanned && items.length) throw new Error('No fresh 5-minute candles for any intraday stock (' + Object.keys(res.failed).length + ' failed, ' + stale + ' stale)');
    return { scanned: scanned, stale: stale, signals: fresh.length, logged: out.logged, sent: out.sent };
  },

  /** After the close: update the daily history of every stock. Returns 'done', 'more' or 'wait'. */
  updateHistory: function (today, day, deadline) {
    var list = Backfill.targets(), cursor = day.hc || 0, todayN = History.ymdToDay(today);
    var recentFrom = new Date(MarketCal.at(today, '09:15').getTime() - 12 * 86400000);
    var fullFrom = Backfill.fromDate(Number(Config.get('historyDays')) || 660), to = MarketCal.now();
    if (cursor === 0) {
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
    }
    var batch = [];
    for (var i = cursor; i < list.length; i++) {
      var it = list[i];
      if (it.key === 'NIFTY 50' && cursor === 0) continue;
      it.from = History.has(it.key) && History.lastDay(it.key) ? recentFrom : fullFrom;
      it.to = to;
      batch.push(it);
    }
    var res = Angel.candlesMany(batch, 'ONE_DAY', { deadline: deadline, onBatch: function () { History.saveNowAndThen(); } });
    Object.keys(res.data).forEach(function (key) { History.put(key, res.data[key]); });
    res.nodata.forEach(function (key) { if (!History.has(key)) History.put(key, []); });
    History.flush();
    var doneKeys = {};
    batch.forEach(function (it) { doneKeys[it.key] = true; });
    res.left.forEach(function (key) { delete doneKeys[key]; });
    // Move the cursor past everything handled, in list order.
    var c = cursor;
    while (c < list.length && (doneKeys[list[c].key] || (cursor === 0 && list[c].key === 'NIFTY 50'))) c++;
    day.hc = c;
    var failed = Object.keys(res.failed);
    day.histFailed = (day.histFailed || 0) + failed.length;
    if (failed.length) Health.log('endOfDay', 'angel', false, 0, failed.length, 'Daily candles missing for ' + failed.slice(0, 8).join(', ') + ': ' + res.failed[failed[0]]);
    if (c < list.length) return 'more';
    History.saveMeta();
    return 'done';
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

    var signals = [], stale = 0, scanned = 0;
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
    });
    var fresh = AlertBook.withoutRepeats(signals, P);
    var out = AlertBook.publish(fresh, { nowMs: MarketCal.now().getTime(), source: 'Angel One daily candles', day: day });
    Health.log('endOfDay', 'scan', true, Date.now() - t0, scanned, scanned + ' stocks scanned, ' + stale + ' without today\'s candle, ' + signals.length + ' signals, ' + fresh.length + ' new');
    return { scanned: scanned, stale: stale, signals: fresh.length, logged: out.logged, sent: out.sent, regime: reg };
  },

  /** Fundamentals sheet row → the fields Core expects. */
  fundamentals: function (r) {
    return { roePct: r.roePct, rocePct: r.rocePct, debtToEquity: r.debtToEquity, sales3yPct: r.sales3yPct, profit3yPct: r.profit3yPct, promoterPct: r.promoterPct, pledgePct: r.pledgePct, pe: r.pe, pe5yMedian: r.pe5yMedian, fcf: r.fcf };
  },
};

/* ============================== Same-day repeats ============================== */

/** Intraday: one alert per stock, strategy and direction per day, and a cooldown between any two. */
var IntraSeen = {
  KEY: 'INTRA_SEEN',
  load: function (today) {
    var s = null;
    try { s = JSON.parse(Secrets.props().getProperty(this.KEY) || 'null'); } catch (e) { s = null; }
    return s && s.day === today ? s : { day: today, k: {} };
  },
  filter: function (today, signals, nowMs) {
    var s = this.load(today), cool = (Number(Config.get('alertCooldownMinutes')) || 60) * 60000, out = [];
    signals.forEach(function (sig) {
      var full = sig.symbol + '|' + sig.strategy + '|' + sig.direction, pair = sig.symbol + '|' + sig.strategy;
      if (s.k[full]) return;
      if (s.k[pair] && nowMs - s.k[pair] < cool) return;
      s.k[full] = nowMs; s.k[pair] = nowMs;
      out.push(sig);
    });
    var json = JSON.stringify(s);
    if (json.length > 8500) { s.k = {}; out.forEach(function (sig) { s.k[sig.symbol + '|' + sig.strategy + '|' + sig.direction] = nowMs; }); json = JSON.stringify(s); }
    Secrets.props().setProperty(this.KEY, json);
    return out;
  },
};

/* ============================== Alerts log and messages ============================== */

var AlertBook = {
  EXTRA_HEADERS: ['qty', 'window', 'telegram'],
  HORIZON_NAMES: { INTRADAY: 'Intraday', SWING: 'Swing', MEDIUM: 'Medium term', LONG: 'Long term' },

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
    var iC = col('createdAt'), iS = col('symbol'), iSt = col('strategy'), iD = col('direction'), iH = col('horizon');
    return sh.getRange(start, 1, n, hdr.length).getValues().map(function (r) {
      return { createdAt: r[iC] instanceof Date ? r[iC].getTime() : Date.parse(r[iC]) || 0, symbol: String(r[iS]), strategy: String(r[iSt]), direction: String(r[iD]), horizon: String(r[iH]) };
    });
  },

  /** Drop daily-strategy signals that repeat an alert still inside its cooldown. */
  withoutRepeats: function (signals, P) {
    if (!signals.length) return [];
    var last = {}, now = MarketCal.now().getTime();
    this.recent(3000).forEach(function (a) { var k = a.symbol + '|' + a.strategy; if (!last[k] || a.createdAt > last[k]) last[k] = a.createdAt; });
    return signals.filter(function (sig) {
      var days = sig.strategy === 'holding-guard' ? P['guard.cooldownDays'] : sig.horizon === 'SWING' ? P['swing.cooldownDays'] : sig.horizon === 'MEDIUM' ? P['medium.cooldownDays'] : P['long.cooldownDays'];
      var prev = last[sig.symbol + '|' + sig.strategy];
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
      var row = {
        id: 'A' + stamp + '-' + sig.symbol + '-' + sig.strategy + (sig.direction === 'SHORT' ? '-S' : sig.direction === 'EXIT' ? '-X' : ''),
        createdAt: new Date(nowMs), symbol: sig.symbol, horizon: sig.horizon, strategy: sig.strategy, strategyStatus: st.status,
        direction: sig.direction, entryLow: sig.entryLow, entryHigh: sig.entryHigh, stop: sig.stop, target1: sig.target1, target2: sig.target2,
        rr: sig.rr, confidence: sig.confidence, reasons: sig.reasons.join(' | '), regime: regime ? regime.state : '',
        source: info.source + (sig.barEnd ? ' to ' + sig.barEnd : '') + ', ' + Utilities.formatDate(new Date(sig.barTime), IST, 'd MMM'),
        validTill: win.till, status: 'OPEN', notes: (sig.riskPct ? 'Stop ' + sig.riskPct + '% away. ' : '') + (sig.tradedValueCr ? 'Avg traded value ₹' + sig.tradedValueCr + ' cr.' : ''),
        qty: size.qty, window: win.text, telegram: '',
      };
      var why = '';
      if (!tgOn) why = 'Telegram off';
      else if (st.status === 'REJECTED') why = 'strategy rejected (kept as paper only)';
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

  /** One alert as a Telegram message. */
  format: function (sig, st, size, win, regime, source) {
    var e = Notify.esc, L = [];
    var trades = st.track ? st.track.trades : 0;
    if (st.status === 'LIVE_READY') L.push('✅ <b>LIVE-READY</b> · ' + Math.round(st.track ? st.track.winRatePct : 0) + '% win, ' + trades + ' trades');
    else L.push('🧪 <b>PAPER — not for real money</b>' + (trades ? ' · ' + trades + ' paper trades so far' : ''));
    var hz = this.HORIZON_NAMES[sig.horizon] || sig.horizon;
    if (sig.direction === 'EXIT') {
      L.push('⚠️ <b>EXIT CHECK: ' + e(sig.symbol) + '</b> · ' + e(sig.strategyName));
      L.push('Close ' + Fmt.money(sig.entry) + (size.qty ? ' · Your holding: ' + size.qty + ' shares' : ''));
    } else {
      L.push('<b>' + (sig.direction === 'SHORT' ? 'SHORT ' : 'BUY ') + e(sig.symbol) + '</b> · ' + hz + ' · ' + e(sig.strategyName));
      if (sig.direction === 'SHORT') L.push('Sell first, intraday only (MIS).');
      L.push('Entry ' + Fmt.money(sig.entryLow) + ' – ' + Fmt.money(sig.entryHigh));
      L.push('Stop ' + Fmt.money(sig.stop) + ' · Target ' + Fmt.money(sig.target1) + (sig.target2 ? ' / ' + Fmt.money(sig.target2) : ''));
      L.push('Reward:risk ' + sig.rr.toFixed(1) + ' · Confidence ' + sig.confidence + '/100');
      if (size.qty > 0) L.push('Size: ' + size.qty + ' shares (' + Fmt.money(size.value, 0) + '), risking ' + Fmt.money(size.riskAmount, 0) + (size.capped ? ', capped by the per-stock limit' : ''));
      else L.push('Size: the stop is too wide for your risk setting, so no position fits.');
      L.push('Valid: ' + e(win.text));
    }
    L.push('', '<b>Why</b>');
    sig.reasons.forEach(function (r) { L.push('• ' + e(r)); });
    L.push('', 'Regime: ' + SRCore.regimeName(regime ? regime.state : 'UNKNOWN') + ' · Data: ' + e(source));
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
