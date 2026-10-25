/**
 * Stock Radar — Engine.gs
 * The daily schedule and the jobs it runs.
 *
 * How a trading day runs:
 *   ~08:25  dailyKickoff starts a one-minute trigger (a backup kickoff runs ~09:05)
 *   08:50   pre-market: fresh Angel One login, market regime, a Telegram brief
 *   09:21–14:31  a minute after each 5-minute bar closes: intraday scan (Signals.gs)
 *   09:15–15:30  every few minutes: market snapshot
 *   15:10   square-off reminder when intraday alerts went out today
 *   16:00+  end of day in steps: update price history, regime, swing/medium/long scans,
 *           closing summary on Telegram and email; then the minute trigger removes itself
 * Weekends and NSE holidays are skipped.
 */

var ENGINE_HANDLERS = ['dailyKickoff', 'engineTick', 'weeklyReport', 'continueHistory'];

/* ============================== Schedule ============================== */

var Schedule = {
  triggers: function (handler) {
    return ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === handler; });
  },

  /** Daily kickoff (plus a backup) and the weekly report. Starts today's run if the session is not over. */
  install: function () {
    this.remove();
    ScriptApp.newTrigger('dailyKickoff').timeBased().everyDays(1).atHour(8).nearMinute(25).inTimezone(IST).create();
    ScriptApp.newTrigger('dailyKickoff').timeBased().everyDays(1).atHour(9).nearMinute(5).inTimezone(IST).create();
    ScriptApp.newTrigger('weeklyReport').timeBased().onWeekDay(ScriptApp.WeekDay.SATURDAY).atHour(10).nearMinute(30).inTimezone(IST).create();
    if (MarketCal.isTradingDay(MarketCal.ymd()) && MarketCal.minutes() < 16 * 60 + 15) this.startTick();
  },

  remove: function () {
    var self = this;
    ENGINE_HANDLERS.forEach(function (h) { self.triggers(h).forEach(function (t) { ScriptApp.deleteTrigger(t); }); });
  },

  startTick: function () {
    if (!this.triggers('engineTick').length) ScriptApp.newTrigger('engineTick').timeBased().everyMinutes(1).create();
  },

  stopTick: function () {
    this.triggers('engineTick').forEach(function (t) { ScriptApp.deleteTrigger(t); });
  },

  summary: function () {
    return {
      kickoffs: this.triggers('dailyKickoff').length,
      weekly: this.triggers('weeklyReport').length,
      tickRunning: this.triggers('engineTick').length > 0,
    };
  },
};

/* ======================== Per-day progress ======================== */

/** What has already happened today, so each step runs once. Kept in Script Properties. */
var DayState = {
  KEY: 'DAY_STATE',
  load: function (ymd) {
    var s = null;
    try { s = JSON.parse(Secrets.props().getProperty(this.KEY) || 'null'); } catch (e) { s = null; }
    return s && s.day === ymd ? s : { day: ymd };
  },
  save: function (s) { Secrets.props().setProperty(this.KEY, JSON.stringify(s)); },
};

/* ============================ Job runner ============================ */

var Jobs = {
  /**
   * Run a job with an optional lock, record how it went, and send a Telegram warning
   * when the same job fails twice in a row. Returns the job's result, or null if it failed or was skipped.
   */
  run: function (name, fn, opts) {
    opts = opts || {};
    var lock = null;
    if (opts.lock) {
      lock = LockService.getScriptLock();
      if (!lock.tryLock(opts.wait || 3000)) { console.log(name + ' skipped: another run is still working'); return null; }
    }
    var t0 = Date.now();
    try {
      var out = fn();
      this.finish(name, true, Date.now() - t0, null);
      return out === undefined ? true : out;
    } catch (err) {
      this.finish(name, false, Date.now() - t0, err);
      if (opts.rethrow) throw err;
      return null;
    } finally {
      if (lock) { try { lock.releaseLock(); } catch (e) { /* already released */ } }
    }
  },

  finish: function (name, ok, ms, err) {
    var p = Secrets.props(), key = 'JOB_' + name, prev = {};
    try { prev = JSON.parse(p.getProperty(key) || '{}'); } catch (e) { prev = {}; }
    var rec = {
      at: new Date().toISOString(), ok: ok, ms: ms,
      fails: ok ? 0 : (prev.fails || 0) + 1,
      lastError: ok ? (prev.lastError || '') : Secrets.mask((err && err.message) || err).slice(0, 300),
      lastErrorAt: ok ? (prev.lastErrorAt || '') : new Date().toISOString(),
    };
    if (!ok) {
      console.log(name + ' failed: ' + rec.lastError);
      ErrorLog.add(name, err);
      if (rec.fails === 2 || (rec.fails > 2 && rec.fails % 20 === 0)) {
        Notify.safeTelegram('⚠️ <b>' + Notify.esc(name) + ' failed ' + rec.fails + ' times in a row</b>\n' + Notify.esc(rec.lastError));
      }
    } else if (prev.fails >= 2) {
      Notify.safeTelegram('✅ <b>' + Notify.esc(name) + ' is working again</b>');
    }
    // Successful minute-by-minute runs are recorded at most once a minute to save quota.
    var stale = !prev.at || Date.now() - new Date(prev.at).getTime() > 55000;
    if (!ok || prev.fails || stale) p.setProperty(key, JSON.stringify(rec));
  },

  status: function () {
    var all = Secrets.props().getProperties(), out = {};
    Object.keys(all).forEach(function (k) {
      if (k.indexOf('JOB_') === 0) { try { out[k.slice(4)] = JSON.parse(all[k]); } catch (e) { /* ignore */ } }
    });
    return out;
  },
};

/* ======================== Trigger handlers ======================== */

/** Runs every morning: starts the minute-by-minute engine on trading days. */
function dailyKickoff() {
  Jobs.run('kickoff', function () {
    var today = MarketCal.ymd();
    if (!Config.get('engineEnabled')) return;
    if (!MarketCal.isTradingDay(today)) { Schedule.stopTick(); return; }
    if (MarketCal.minutes() >= 16 * 60 + 15) return;
    Schedule.startTick();
    Engine.yearEndCheck(today);
  }, { lock: true, wait: 20000 });
}

/** Runs every minute on trading days, from the morning kickoff until the closing summary is sent. */
function engineTick() {
  Jobs.run('tick', function () { Engine.tick(); }, { lock: true, wait: 1000 });
}

/** Runs every Saturday morning. The full weekly report arrives in Phase 3. */
function weeklyReport() {
  Jobs.run('weekly', function () { Engine.weekly(); }, { lock: true, wait: 20000 });
}

/* ============================== Engine ============================== */

var Engine = {
  MAIN_INDICES: ['NIFTY 50', 'NIFTY BANK', 'INDIA VIX'],

  tick: function () {
    var t0 = Date.now(), now = MarketCal.now(), today = MarketCal.ymd(now), m = MarketCal.minutes(now);
    if (!Config.get('engineEnabled') || !MarketCal.isTradingDay(today)) { Schedule.stopTick(); return; }
    var day = DayState.load(today), changed = false;
    var self = this;

    if (m >= 8 * 60 + 50) changed = this.once(day, 'pre', 'preMarket', function () { self.preMarket(today); }) || changed;
    if (m >= 9 * 60 + 15 && m < 15 * 60 + 30) changed = this.intraday(m, day) || changed;
    var bar = this.barToScan(m);
    if (bar && day.bar !== bar) {
      day.bar = bar;
      DayState.save(day); // claim this bar before the slow part, so a crash does not repeat it
      Jobs.run('intradayScan', function () { var r = Scans.intraday(today, t0 + 200000); day.lastScan = { at: bar, scanned: r.scanned || 0, signals: r.signals || 0, skipped: r.skipped || '' }; });
      changed = true;
    }
    if (m >= Config.minutesOf('squareOffAt')) changed = this.once(day, 'sq', 'squareOff', function () { self.squareOff(today); }) || changed;
    if (m >= 16 * 60 && !day.eod) { this.endOfDaySteps(today, day, t0 + 240000); changed = true; }

    if (changed) DayState.save(day);
    if (day.eod || m >= 18 * 60) Schedule.stopTick();
  },

  /** The 5-minute bar (its closing minute) to scan now, or 0. Runs a minute after each close, up to the no-entry time. */
  barToScan: function (m) {
    var bar = 555 + 5 * Math.floor((m - 1 - 555) / 5);
    return bar >= 560 && bar <= Config.minutesOf('noEntriesAfter') && m < 15 * 60 + 30 ? bar : 0;
  },

  /**
   * End of day in steps, as many as fit in this run; the next minute's run continues.
   * A step that fails three times is skipped so the closing summary always goes out.
   */
  endOfDaySteps: function (today, day, deadline) {
    var self = this;
    var steps = [
      { key: 'hist', job: 'historyUpdate', run: function () { return Scans.updateHistory(today, day, deadline); } },
      { key: 'scan', job: 'endOfDayScan', run: function () { var r = Scans.endOfDay(today, day); day.eodScan = { scanned: r.scanned || 0, signals: r.signals || 0 }; return 'done'; } },
      { key: 'sum', job: 'endOfDay', run: function () { self.endOfDay(today, day); return 'done'; } },
    ];
    day.eodStep = day.eodStep || 0;
    while (day.eodStep < steps.length && Date.now() < deadline - 20000) {
      var st = steps[day.eodStep];
      var r = Jobs.run(st.job, st.run);
      if (r === null) {
        day['eodTries_' + st.key] = (day['eodTries_' + st.key] || 0) + 1;
        if (day['eodTries_' + st.key] < 3) return;
        day.eodSkipped = (day.eodSkipped || []).concat([st.job]);
        day.eodStep++;
        continue;
      }
      if (r === 'wait' || r === 'more') return;
      day.eodStep++;
    }
    if (day.eodStep >= steps.length) day.eod = Date.now();
  },

  /** Run a daily step once. A failing step is retried on the next ticks, up to three attempts. */
  once: function (day, key, jobName, fn) {
    if (day[key]) return false;
    day[key + 'Tries'] = (day[key + 'Tries'] || 0) + 1;
    var ok = Jobs.run(jobName, fn) !== null;
    if (ok || day[key + 'Tries'] >= 3) day[key] = Date.now();
    return true;
  },

  /** Symbols watched during the session in Phase 1: main indices and the watchlist. */
  watchSymbols: function () {
    var list = this.MAIN_INDICES.slice();
    Config.symbols('watchlist').slice(0, 10).forEach(function (s) { if (list.indexOf(s) < 0) list.push(s); });
    return list;
  },

  /** During the session: a market snapshot every few minutes. Strategies are added here in Phase 2. */
  intraday: function (m, day) {
    var every = Math.max(1, Number(Config.get('heartbeatMinutes')) || 5);
    if (day.hb && m - day.hb < every) return false;
    day.hb = m;
    day.hbCount = (day.hbCount || 0) + 1;
    this.snapshot('tick');
    return true;
  },

  /** Fetch and store the latest quotes for the watched symbols. */
  snapshot: function (job) {
    var res = Data.quotes(this.watchSymbols(), job, 15);
    var snap = { at: Date.now(), sources: res.sources, missing: res.missing, quotes: {} };
    Object.keys(res.quotes).forEach(function (s) {
      var q = res.quotes[s];
      snap.quotes[s] = { ltp: q.ltp, changePct: q.changePct, prevClose: q.prevClose, source: q.source, stale: q.stale, time: q.time };
    });
    var json = JSON.stringify(snap);
    try { CacheService.getScriptCache().put('SNAPSHOT', json, 21600); } catch (e) { /* cache is optional */ }
    if (json.length < 8500) Secrets.props().setProperty('SNAPSHOT', json);
    if (!Object.keys(snap.quotes).length) throw new Error('No prices from any source. ' + res.problems.join(' | '));
    return snap;
  },

  preMarket: function (today) {
    if (Angel.configured()) Angel.login(true); // fresh session for the day
    var snap = this.snapshot('preMarket');
    var lines = ['<b>Good morning. Pre-market check</b>', Fmt.day(today), ''];
    lines = lines.concat(this.indexLines(snap, 'closed at'));
    lines.push('');
    var prep = this.prepareDay(today);
    lines = lines.concat(prep.lines);
    lines.push('');
    var src = snap.sources.indexOf('angel') >= 0 ? 'Angel One live data' : snap.sources.length ? 'backup data only (' + snap.sources.join(', ') + ')' : 'no data';
    lines.push('Engine ready: ' + src + '.');
    var hol = MarketCal.upcomingHolidays(10);
    if (hol.length) lines.push('Next holiday: ' + Fmt.day(hol[0].ymd) + ', ' + Notify.esc(hol[0].name) + '.');
    lines.push('Market opens at 09:15.');
    Notify.safeTelegram(lines.join('\n'));
  },

  /** Regime and intraday context for the day. Never stops the brief: problems become a line in it. */
  prepareDay: function (today) {
    var lines = [];
    try {
      var meta = History.meta();
      if (!meta || !meta.symbols) {
        lines.push('⚠️ Price history is not loaded yet, so no signals today. In the sheet: Stock Radar → 6. Load price history.');
        return { lines: lines };
      }
      var reg = Market.saved();
      var prev = History.ymdToDay(MarketCal.prevTradingDay(today));
      if (!reg || reg.asOfDay < prev) reg = Market.computeRegime();
      lines.push(Market.line(reg));
      var ctx = Market.prepareIntraday(today);
      var n = Object.keys(ctx.s).length, ids = StrategyBook.enabled(['INTRADAY']);
      lines.push('Intraday: ' + n + ' stocks, ' + ids.length + ' strategies, checked after every 5-minute bar until ' + Config.get('noEntriesAfter') + '.');
      if (ctx.stale) lines.push('⚠️ ' + ctx.stale + ' stocks have no candle for the last session in the price history.');
      if (reg.state === 'UNKNOWN') lines.push('⚠️ No signals until the regime is known.');
    } catch (e) {
      ErrorLog.add('prepareDay', e);
      lines.push('⚠️ Could not prepare today\'s scans: ' + Notify.esc(Secrets.mask(e.message)));
    }
    return { lines: lines };
  },

  /** Reminder to close intraday positions, only when intraday alerts went out today. */
  squareOff: function (today) {
    var list = AlertBook.today(today).filter(function (a) { return a.horizon === 'INTRADAY'; });
    if (!list.length) return 0;
    var e = Notify.esc, lines = ['⏰ <b>Square-off reminder</b>', list.length + ' intraday alert' + (list.length > 1 ? 's' : '') + ' went out today. If you took any, close ' + (list.length > 1 ? 'them' : 'it') + ' before ' + e(Config.get('intradayExpiry')) + '.', ''];
    list.slice(0, 12).forEach(function (a) { lines.push((a.direction === 'SHORT' ? 'SHORT ' : 'BUY ') + e(a.symbol) + ' · ' + e(SRCore.strategy(a.strategy) ? SRCore.strategy(a.strategy).name : a.strategy) + ' · ' + Fmt.time(a.createdAt.getTime())); });
    if (list.length > 12) lines.push('… and ' + (list.length - 12) + ' more in the Alerts sheet.');
    Notify.safeTelegram(lines.join('\n'));
    return list.length;
  },

  endOfDay: function (today, day) {
    var snap = this.snapshot('endOfDay');
    day = day || DayState.load(today);
    var lines = ['<b>Market closed. Daily summary</b>', Fmt.day(today), ''];
    lines = lines.concat(this.indexLines(snap, ''));
    var watch = Config.symbols('watchlist').filter(function (s) { return snap.quotes[s]; });
    if (watch.length) {
      lines.push('', '<b>Watchlist</b>');
      watch.sort(function (a, b) { return (snap.quotes[b].changePct || 0) - (snap.quotes[a].changePct || 0); }).forEach(function (s) {
        var q = snap.quotes[s];
        lines.push(Notify.esc(s) + '  ' + Fmt.money(q.ltp) + '  (' + Fmt.pct(q.changePct) + ')');
      });
    }
    lines.push('');
    lines = lines.concat(this.signalLines(today, day));
    var errors = ErrorLog.countToday();
    var source = snap.sources.indexOf('angel') >= 0 ? 'Data from Angel One.' : 'Data from backups only (' + snap.sources.join(', ') + '), Angel One did not answer.';
    lines.push('', 'Engine: ' + (day.hbCount || 0) + ' market checks today, ' + (errors ? errors + ' error' + (errors > 1 ? 's' : '') + ' logged (see the ErrorLog sheet).' : 'no errors.') + ' ' + source);
    if (day.histNote) lines.push('⚠️ ' + Notify.esc(day.histNote));
    if (day.eodSkipped && day.eodSkipped.length) lines.push('⚠️ Skipped after three failed tries: ' + Notify.esc(day.eodSkipped.join(', ')) + '.');
    lines.push('Paper trading and results start in Phase 3; every alert is already logged.');
    Notify.safeTelegram(lines.join('\n'));
    if (Config.get('emailDigest')) {
      try { Notify.email('Daily summary ' + Fmt.day(today), Notify.htmlFromTelegram(lines.join('\n'))); }
      catch (e) { ErrorLog.add('emailDigest', e); }
    }
    Store.trim('HealthLog', 3000);
    Store.trim('ErrorLog', 1000);
  },

  /** The closing summary's section on today's signals. */
  signalLines: function (today, day) {
    var e = Notify.esc, out = [];
    var reg = Market.saved();
    out.push(Market.line(reg));
    var list = AlertBook.today(today);
    if (!list.length) {
      out.push('<b>Signals today</b>: none.' + (day.eodScan && day.eodScan.scanned ? ' ' + day.eodScan.scanned + ' stocks checked at the close.' : ''));
      return out;
    }
    var by = {};
    list.forEach(function (a) { by[a.horizon] = (by[a.horizon] || 0) + 1; });
    var names = { INTRADAY: 'intraday', SWING: 'swing', MEDIUM: 'medium term', LONG: 'long term' };
    out.push('<b>Signals today: ' + list.length + '</b> (' + Object.keys(by).map(function (h) { return by[h] + ' ' + (names[h] || h); }).join(', ') + ')');
    list.slice(-15).forEach(function (a) {
      var st = SRCore.strategy(a.strategy);
      out.push((a.direction === 'EXIT' ? 'EXIT ' : a.direction === 'SHORT' ? 'SHORT ' : 'BUY ') + e(a.symbol) + ' · ' + e(st ? st.name : a.strategy) + ' · conf ' + a.confidence);
    });
    if (list.length > 15) out.push('… and ' + (list.length - 15) + ' more in the Alerts sheet.');
    return out;
  },

  weekly: function () {
    // The weekly performance report and strategy review arrive in Phase 3.
    Health.log('weekly', 'engine', true, 0, 0, 'Weekly report is added in Phase 3');
  },

  /** In December, remind once a week to add next year's NSE holidays. */
  yearEndCheck: function (today) {
    var month = Number(today.slice(5, 7)), year = Number(today.slice(0, 4));
    if (month !== 12 || MarketCal.weekday(today) !== 1 || MarketCal.hasYear(year + 1)) return;
    Notify.safeTelegram('📅 Please add the ' + (year + 1) + ' NSE trading holidays to the Holidays sheet once NSE publishes them (usually mid-December).');
  },

  indexLines: function (snap, verb) {
    var names = { 'NIFTY 50': 'Nifty 50', 'NIFTY BANK': 'Nifty Bank', 'INDIA VIX': 'India VIX' };
    return this.MAIN_INDICES.filter(function (s) { return snap.quotes[s]; }).map(function (s) {
      var q = snap.quotes[s];
      return names[s] + (verb ? ' ' + verb : '') + ' ' + Fmt.num(q.ltp) + ' (' + Fmt.pct(q.changePct) + ')';
    });
  },
};
