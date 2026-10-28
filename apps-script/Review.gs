/**
 * Stock Radar — Review.gs
 * Checks every alert against what the price did next, keeps the paper trades, scores each
 * strategy, decides Live-ready / Rejected, and writes the daily, weekly and readiness reports.
 * The maths (fills, exits, charges, metrics, graduation) lives in Core.gs, so the phone app's
 * backtester uses exactly the same rules.
 *
 * How an alert is judged (all automatic):
 *   - Intraday: after the close, with 1-minute candles from the alert time to 15:15.
 *   - Swing, medium and long: after each close, with the daily candles in your Drive.
 *   - The entry fills like a limit order inside the alert's entry range; a candle touching both
 *     the stop and the target counts as a stop; leftovers close at expiry.
 *   - Each filled alert is a paper trade sized from the virtual capital (Config paperCapital and
 *     riskPct), with Zerodha charges taken off. Trades are sized independently, as if each were
 *     the only position, so every strategy gets a fair record.
 *   - Exit warnings for holdings are judged 20 trading days later: right if the price fell.
 */

var REVIEW_OUTCOMES = ['TARGET_HIT', 'STOP_HIT', 'EXPIRED', 'EXIT_RIGHT', 'EXIT_EARLY'];

/* ============================== Sheet helpers ============================== */

var Tables = {
  /** Make sure a sheet exists with at least these header columns (missing ones are added at the end). */
  ensure: function (name, headers) {
    var ss = Store.ss(), sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name, ss.getSheets().length);
    var have = Store.headers(sh).filter(function (h) { return h !== ''; });
    var missing = headers.filter(function (h) { return have.indexOf(h) < 0; });
    if (missing.length) {
      Store.ensureCols(sh, have.length + missing.length);
      sh.getRange(1, have.length + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
      if (!have.length) sh.setFrozenRows(1);
    }
    return sh;
  },

  /** Every row as an object (with its sheet row number in _row). */
  read: function (name) {
    var sh = Store.sheet(name);
    if (!sh || sh.getLastRow() < 2) return { sh: sh, hdr: sh ? Store.headers(sh) : [], rows: [] };
    var hdr = Store.headers(sh);
    var rows = sh.getRange(2, 1, sh.getLastRow() - 1, hdr.length).getValues().map(function (r, i) {
      var o = { _row: i + 2 };
      hdr.forEach(function (h, j) { o[h] = r[j]; });
      return o;
    });
    return { sh: sh, hdr: hdr, rows: rows };
  },

  /** Write some columns back for all rows from index `from` (0-based in t.rows) to the end. */
  writeCols: function (t, cols, from) {
    if (!t.rows.length || from >= t.rows.length) return;
    var clean = function (v) { return v === null || v === undefined || (typeof v === 'number' && !isFinite(v)) ? '' : v; };
    cols.forEach(function (c) {
      var j = t.hdr.indexOf(c);
      if (j < 0) return;
      var vals = t.rows.slice(from).map(function (o) { return [clean(o[c])]; });
      t.sh.getRange(t.rows[from]._row, j + 1, vals.length, 1).setValues(vals);
    });
  },
};

/* ============================== The evaluator ============================== */

var Review = {
  EVAL_COLS: ['status', 'triggeredAt', 'closedAt', 'outcome', 'outcomePct', 'netPct', 'fillPrice', 'exitPrice', 'paperQty', 'grossPnl', 'charges', 'netPnl', 'niftyPct', 'alphaPct', 'holdDays', 'evaluatedAt'],
  PAPER_EXTRA: ['direction', 'regime', 'track', 'markPrice', 'unrealisedPnl'],
  STRAT_EXTRA: ['expectancyPct', 'avgWinPct', 'avgLossPct', 'avgHoldDays', 'openTrades', 'statusReason', 'note', 'tradeDays'],
  CHECK_EXTRA: ['strategy', 'horizon'],
  METRIC_HEADERS: ['strategy', 'name', 'horizon', 'track', 'regime', 'trades', 'wins', 'losses', 'winRatePct', 'avgWinPct', 'avgLossPct', 'expectancyPct', 'profitFactor', 'maxDrawdownPct', 'avgHoldDays', 'avgAlphaPct', 'totalNetPnl', 'note', 'updatedAt', 'days'],
  CHECKPOINTS: [['1M', 1], ['3M', 3], ['6M', 6], ['12M', 12]],

  rates: function () {
    var c = Config.all();
    return {
      brokerageIntradayPct: c.chargeBrokerageIntradayPct, brokerageIntradayMax: c.chargeBrokerageIntradayMax,
      sttDeliveryPct: c.chargeSttDeliveryPct, sttIntradaySellPct: c.chargeSttIntradaySellPct, txnPct: c.chargeTxnPct,
      sebiPerCrore: c.chargeSebiPerCrore, stampDeliveryPct: c.chargeStampDeliveryPct, stampIntradayPct: c.chargeStampIntradayPct,
      gstPct: c.chargeGstPct, dpPerSell: c.chargeDpPerSell,
    };
  },

  sizing: function () {
    return { capital: Number(Config.get('paperCapital')) || 100000, riskPct: Number(Config.get('riskPct')) || 1, maxPer: Number(Config.get('maxPerStockPct')) || 10 };
  },

  /** The Alerts sheet with every evaluation column present. */
  alerts: function () {
    AlertBook.ensureHeaders();
    return Tables.read('Alerts');
  },

  ms: function (v) { return v instanceof Date ? v.getTime() : (Date.parse(v) || 0); },
  num: function (v) { return typeof v === 'number' && isFinite(v); },
  round: function (x, d) { var f = Math.pow(10, d === undefined ? 2 : d); return Math.round(x * f) / f; },

  /** Mark the start of paper trading the first time the evaluator runs. */
  startDay: function () {
    var p = Secrets.props(), s = p.getProperty('PAPER_START');
    if (!s) { s = MarketCal.ymd(); p.setProperty('PAPER_START', s); }
    return s;
  },

  /**
   * Fill in an alert row from a simulated trade. ctx: {intraday, nowMs, niftyPct(fromT, toT, fillT), toDate(t)}
   */
  apply: function (r, s, ctx) {
    var sz = this.sizing();
    r._dirty = true;
    r.evaluatedAt = new Date(ctx.nowMs);
    r.status = s.state;
    r.outcome = s.state === 'CLOSED' ? s.outcome : '';
    r.triggeredAt = s.fillT !== null ? ctx.toDate(s.fillT, 'fill') : '';
    r.fillPrice = s.fillPrice !== null ? s.fillPrice : '';
    r.closedAt = s.state === 'CLOSED' ? (s.exitT !== null ? ctx.toDate(s.exitT, 'exit') : r.validTill) : '';
    r.exitPrice = s.exitPrice !== null ? s.exitPrice : '';
    r.outcomePct = this.num(s.pct) && s.state === 'CLOSED' ? this.round(s.pct, 2) : '';
    ['paperQty', 'grossPnl', 'charges', 'netPnl', 'netPct', 'niftyPct', 'alphaPct', 'holdDays'].forEach(function (k) { r[k] = ''; });
    r._mark = ''; r._unrealised = '';
    if (s.fillPrice === null) return r;
    // Sizing, charges and the net result come from Core.gs, so the backtester uses exactly the same maths.
    var p = SRCore.paperResult(r.direction, Number(r.stop), s, sz, this.rates(), ctx.intraday);
    r.paperQty = p.qty;
    if (s.state !== 'CLOSED') {
      if (p.mark !== null) { r._mark = p.mark; r._unrealised = p.unrealised; }
      return r;
    }
    r.netPct = p.netPct === null ? '' : p.netPct;
    if (p.netPnl !== null) { r.grossPnl = p.grossPnl; r.charges = p.charges; r.netPnl = p.netPnl; }
    var nifty = ctx.niftyPct(s.fillT, s.exitT);
    if (this.num(nifty)) { r.niftyPct = this.round(nifty, 3); if (this.num(r.netPct)) r.alphaPct = this.round(r.netPct - nifty, 3); }
    r.holdDays = p.holdDays;
    return r;
  },

  /* ------------------------------ Intraday ------------------------------ */

  /**
   * After the close: judge intraday alerts whose day is over, with 1-minute candles.
   * Returns 'done' or 'more' (when time ran out).
   */
  intraday: function (today, day, deadline) {
    var t = this.alerts(), nowMs = MarketCal.now().getTime(), self = this;
    var due = t.rows.filter(function (r) {
      return r.horizon === 'INTRADAY' && r.status !== 'CLOSED' && r.direction !== 'EXIT' && r.createdAt instanceof Date && self.ms(r.validTill) && self.ms(r.validTill) <= nowMs;
    });
    if (!due.length) return 'done';
    var meta = SymbolsDb.load(), groups = {}, items = [];
    due.forEach(function (r) {
      var d = MarketCal.ymd(r.createdAt), key = r.symbol + '|' + d;
      if (!groups[key]) {
        groups[key] = { day: d, rows: [] };
        var m = meta[r.symbol];
        if (m && m.angelToken) items.push({ key: key, token: String(m.angelToken), from: MarketCal.at(d, '09:15'), to: MarketCal.at(d, '15:30') });
      }
      groups[key].rows.push(r);
      var nk = 'NIFTY 50|' + d;
      if (!groups[nk]) { groups[nk] = { day: d, rows: [], index: true }; items.push({ key: nk, token: '99926000', from: MarketCal.at(d, '09:15'), to: MarketCal.at(d, '15:30') }); }
    });
    var res = Angel.candlesMany(items, 'ONE_MINUTE', { deadline: deadline });
    var changed = 0;
    Object.keys(groups).forEach(function (key) {
      var g = groups[key];
      if (g.index || !g.rows.length) return;
      var k = res.data[key];
      if (!k) {
        // No minute data: give up after five days so a missing day never blocks the record forever.
        g.rows.forEach(function (r) {
          if (nowMs - self.ms(r.validTill) > 5 * 86400000) { r._dirty = true; r.status = 'CLOSED'; r.outcome = 'NO_DATA'; r.closedAt = r.validTill; r.evaluatedAt = new Date(nowMs); changed++; }
        });
        return;
      }
      var nk = res.data['NIFTY 50|' + g.day] || [];
      g.rows.forEach(function (r) {
        var from = Math.ceil(self.ms(r.createdAt) / 60000) * 60000; // the first full minute after the alert went out
        var after = k.filter(function (c) { return c.t >= from; });
        var s = SRCore.simulateTrade({ direction: r.direction, entryLow: Number(r.entryLow), entryHigh: Number(r.entryHigh), stop: Number(r.stop), target: Number(r.target1) },
          after, { expiryMs: self.ms(r.validTill), nowMs: nowMs, barMs: 60000 });
        self.apply(r, s, {
          intraday: true, nowMs: nowMs,
          toDate: function (ms) { return new Date(ms); },
          niftyPct: function (a, b) { return self.niftyMinutePct(nk, a, b); },
        });
        changed++;
      });
    });
    if (changed) this.writeEval(t);
    Health.log('evaluate', 'intraday', true, 0, changed, changed + ' intraday alerts judged; ' + Object.keys(res.failed).length + ' symbols without minute candles');
    return res.left.length ? 'more' : 'done';
  },

  /** Nifty 50 percent change between two moments, from 1-minute candles. */
  niftyMinutePct: function (k, fromT, toT) {
    if (!k.length || !this.num(fromT) || !this.num(toT)) return null;
    var before = null, end = null;
    for (var i = 0; i < k.length; i++) {
      if (k[i].t < fromT) before = k[i].c;
      if (k[i].t <= toT) end = k[i].c;
    }
    if (before === null) before = k[0].o;
    return before > 0 && end !== null ? (end / before - 1) * 100 : null;
  },

  /** Write the evaluation columns from the first row changed in this run to the end (rows in between keep their values). */
  writeEval: function (t) {
    var first = -1;
    for (var i = 0; i < t.rows.length; i++) if (t.rows[i]._dirty) { first = i; break; }
    if (first >= 0) Tables.writeCols(t, this.EVAL_COLS, first);
  },

  /* ------------------------------ Daily horizons ------------------------------ */

  /**
   * After the close and the history update: judge swing, medium and long alerts and exit warnings with daily
   * candles, add due checkpoints, rebuild the paper trades and refresh every strategy's numbers.
   */
  daily: function (today) {
    this.startDay();
    var t = this.alerts(), nowMs = MarketCal.now().getTime(), self = this;
    var niftyK = History.get('NIFTY 50'), niftyIdx = this.dayIndex(niftyK);
    var changed = 0, exitDays = Number(Config.get('exitCheckDays')) || 20, cache = {};
    t.rows.forEach(function (r) {
      if (r.status === 'CLOSED' || r.horizon === 'INTRADAY' || !r.symbol || !(r.createdAt instanceof Date)) return;
      var sym = String(r.symbol), k = cache[sym] || (cache[sym] = History.get(sym));
      var alertDay = History.msToDay(self.ms(r.createdAt));
      var after = k.filter(function (c) { return History.msToDay(c.t) > alertDay; });
      if (r.direction === 'EXIT') { self.exitCheck(r, after, nowMs, exitDays, niftyK, niftyIdx, alertDay); changed++; return; }
      var s = SRCore.simulateTrade({ direction: r.direction, entryLow: Number(r.entryLow), entryHigh: Number(r.entryHigh), stop: Number(r.stop), target: Number(r.target1) },
        after, { expiryMs: self.ms(r.validTill), nowMs: nowMs, barMs: 0 });
      self.apply(r, s, {
        intraday: false, nowMs: nowMs,
        toDate: function (dayMs, what) { return new Date(dayMs + (what === 'fill' ? 555 : 930) * 60000); },
        niftyPct: function (a, b) { return self.niftyDailyPct(niftyK, niftyIdx, a, b); },
      });
      changed++;
    });
    if (changed) this.writeEval(t);
    var cps = this.checkpoints(t.rows, today, niftyK, niftyIdx);
    this.paperTrades(t.rows);
    var stats = this.refreshStats(t.rows);
    Health.log('evaluate', 'daily', true, 0, changed, changed + ' alerts judged with daily candles, ' + cps + ' checkpoints added');
    return { judged: changed, checkpoints: cps, stats: stats };
  },

  /** Map yyyymmdd → index in a daily candle list. */
  dayIndex: function (k) {
    var m = {};
    k.forEach(function (c, i) { m[History.msToDay(c.t)] = i; });
    return m;
  },

  /** Nifty 50 change from the close before the entry day to the close of the exit day. */
  niftyDailyPct: function (k, idx, fillT, exitT) {
    if (!k.length || !this.num(fillT) || !this.num(exitT)) return null;
    var i = idx[History.msToDay(fillT)], j = idx[History.msToDay(exitT)];
    if (i === undefined || j === undefined) return null;
    var base = i > 0 ? k[i - 1].c : k[i].o;
    return base > 0 ? (k[j].c / base - 1) * 100 : null;
  },

  /** An exit warning is judged after N trading days: right if the price is lower than at the warning. */
  exitCheck: function (r, after, nowMs, n, niftyK, niftyIdx, alertDay) {
    r._dirty = true;
    r.evaluatedAt = new Date(nowMs);
    if (after.length < n) { r.status = 'ACTIVE'; return; }
    var c = after[n - 1], base = Number(r.entryHigh) || Number(r.entryLow);
    if (!(base > 0)) { r.status = 'CLOSED'; r.outcome = 'NO_DATA'; r.closedAt = new Date(nowMs); return; }
    var pct = (base - c.c) / base * 100;
    r.status = 'CLOSED';
    r.outcome = pct > 0 ? 'EXIT_RIGHT' : 'EXIT_EARLY';
    r.closedAt = new Date(c.t + 930 * 60000);
    r.exitPrice = c.c;
    r.outcomePct = this.round(pct, 2);
    r.netPct = r.outcomePct;
    r.holdDays = n;
    var i = niftyIdx[alertDay], j = niftyIdx[History.msToDay(c.t)];
    if (i !== undefined && j !== undefined && niftyK[i].c > 0) {
      var np = (niftyK[j].c / niftyK[i].c - 1) * 100;
      r.niftyPct = this.round(np, 2);
      r.alphaPct = this.round(pct + np, 2); // what selling saved, compared with the market's own move
    }
  },

  /* ------------------------------ Checkpoints ------------------------------ */

  addMonths: function (ymd, n) {
    var y = Number(ymd.slice(0, 4)), m = Number(ymd.slice(5, 7)) - 1 + n, d = Number(ymd.slice(8, 10));
    y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
    var last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    var pad = function (x) { return (x < 10 ? '0' : '') + x; };
    return y + '-' + pad(m + 1) + '-' + pad(Math.min(d, last));
  },

  /** Medium and long buy ideas at 1, 3, 6 and 12 months and at their final result, each against Nifty 50. */
  checkpoints: function (rows, today, niftyK, niftyIdx) {
    var self = this, sh = Tables.ensure('Checkpoints', ['alertId', 'symbol', 'label', 'dueDate', 'price', 'returnPct', 'niftyReturnPct', 'alphaPct', 'evaluatedAt'].concat(this.CHECK_EXTRA));
    var have = {};
    Tables.read('Checkpoints').rows.forEach(function (c) { have[c.alertId + '|' + c.label] = true; });
    var todayN = History.ymdToDay(today), add = [];
    rows.forEach(function (r) {
      if ((r.horizon !== 'MEDIUM' && r.horizon !== 'LONG') || r.direction !== 'BUY' || r.track === 'shadow' || !(r.createdAt instanceof Date)) return;
      var k = History.get(String(r.symbol)), idx = self.dayIndex(k), alertYmd = MarketCal.ymd(r.createdAt), aDay = History.ymdToDay(alertYmd);
      var i0 = idx[aDay];
      if (i0 === undefined) return;
      var base = k[i0].c, nBase = niftyIdx[aDay] !== undefined ? niftyK[niftyIdx[aDay]].c : null;
      var row = function (label, dueYmd, price, dayN) {
        var ret = (price / base - 1) * 100, nj = niftyIdx[dayN], nret = nBase && nj !== undefined ? (niftyK[nj].c / nBase - 1) * 100 : null;
        return {
          alertId: r.id, symbol: r.symbol, label: label, dueDate: MarketCal.at(dueYmd, '15:30'), price: price, returnPct: self.round(ret, 2),
          niftyReturnPct: nret === null ? '' : self.round(nret, 2), alphaPct: nret === null ? '' : self.round(ret - nret, 2),
          evaluatedAt: new Date(), strategy: r.strategy, horizon: r.horizon,
        };
      };
      self.CHECKPOINTS.forEach(function (cp) {
        if (have[r.id + '|' + cp[0]]) return;
        var due = self.addMonths(alertYmd, cp[1]), dueN = History.ymdToDay(due);
        if (dueN > todayN) return;
        for (var j = i0 + 1; j < k.length; j++) {
          var dn = History.msToDay(k[j].t);
          if (dn >= dueN) { add.push(row(cp[0], due, k[j].c, dn)); break; }
        }
      });
      if (!have[r.id + '|FINAL'] && r.status === 'CLOSED' && REVIEW_OUTCOMES.indexOf(r.outcome) >= 0 && self.num(r.exitPrice) && r.closedAt instanceof Date) {
        var closed = MarketCal.ymd(r.closedAt), cn = History.ymdToDay(closed);
        var f = row('FINAL', closed, r.exitPrice, cn);
        if (self.num(r.netPct)) f.returnPct = r.netPct; // the paper trade's net result
        if (self.num(r.alphaPct)) f.alphaPct = r.alphaPct;
        if (self.num(r.niftyPct)) f.niftyReturnPct = r.niftyPct;
        add.push(f);
      }
    });
    if (add.length) Store.append('Checkpoints', add);
    return add.length;
  },

  /* ------------------------------ Paper trades ------------------------------ */

  /** PaperTrades is rebuilt from the Alerts sheet each time, so it can never drift from it. */
  paperTrades: function (rows) {
    Tables.ensure('PaperTrades', ['id', 'alertId', 'symbol', 'horizon', 'strategy', 'status', 'entryAt', 'entryPrice', 'qty', 'stop', 'target', 'exitAt', 'exitPrice', 'exitReason', 'grossPnl', 'charges', 'netPnl', 'netPct', 'holdingDays'].concat(this.PAPER_EXTRA));
    var self = this;
    var out = rows.filter(function (r) { return self.num(r.fillPrice) && r.fillPrice > 0 && Number(r.paperQty) > 0; }).map(function (r) {
      return {
        id: 'P' + String(r.id).slice(1), alertId: r.id, symbol: r.symbol, horizon: r.horizon, strategy: r.strategy,
        status: r.status === 'CLOSED' ? 'CLOSED' : 'OPEN', entryAt: r.triggeredAt, entryPrice: r.fillPrice, qty: r.paperQty,
        stop: r.stop, target: r.target1, exitAt: r.closedAt, exitPrice: r.exitPrice, exitReason: r.outcome,
        grossPnl: r.grossPnl, charges: r.charges, netPnl: r.netPnl, netPct: r.netPct, holdingDays: r.holdDays,
        direction: r.direction, regime: r.regime, track: r.track || 'main', markPrice: r._mark || '', unrealisedPnl: r._unrealised === undefined ? '' : r._unrealised,
      };
    });
    Store.replaceAll('PaperTrades', out);
    return out.length;
  },

  /* ------------------------------ Strategy numbers ------------------------------ */

  /** Closed trades as the metrics function wants them. */
  closedTrades: function (rows) {
    var self = this;
    return rows.filter(function (r) { return r.status === 'CLOSED' && REVIEW_OUTCOMES.indexOf(r.outcome) >= 0 && self.num(r.netPct); }).map(function (r) {
      var track = r.track || 'main';
      return {
        strategy: r.strategy, horizon: r.horizon, regime: r.regime || 'UNKNOWN', track: track, symbol: r.symbol,
        netPct: r.netPct, netPnl: Number(r.paperQty) > 0 && self.num(r.netPnl) ? r.netPnl : null,
        exitT: self.ms(r.closedAt), dayT: self.ms(r.createdAt) || null, holdDays: self.num(r.holdDays) ? r.holdDays : null, alphaPct: self.num(r.alphaPct) ? r.alphaPct : null,
        blockedBy: track === 'shadow' ? self.blockKind(r.telegram) : '',
      };
    });
  },

  /** Which market filter held a shadow signal back, from its note: 'day', 'switch' or 'regime'. */
  blockKind: function (note) {
    var s = String(note || '');
    return /against the day/.test(s) ? 'day' : /your setting/.test(s) ? 'switch' : 'regime';
  },

  rules: function () {
    return {
      minTrades: Number(Config.get('graduationMinTrades')) || 30, minDays: Number(Config.get('graduationMinDays')) || 0,
      minPF: Number(Config.get('graduationMinPF')) || 1.3, maxDrawdownPct: Number(Config.get('graduationMaxDrawdownPct')) || 15,
    };
  },

  /** The latest closed main trades a strategy is judged on (all of them until there are enough). */
  window: function (list) {
    var n = Number(Config.get('graduationWindowTrades')) || 60;
    return list.slice().sort(function (a, b) { return a.exitT - b.exitT; }).slice(-n);
  },

  /** Metrics sheet (strategy × track × regime), Strategies sheet numbers, and a saved paper summary. */
  refreshStats: function (rows) {
    var self = this, trades = this.closedTrades(rows), cap = this.sizing().capital, rules = this.rules(), now = new Date();
    var metricRows = [];
    SRCore.STRATEGIES.forEach(function (st) {
      ['main', 'shadow'].forEach(function (track) {
        var mine = trades.filter(function (x) { return x.strategy === st.id && x.track === track; });
        if (track === 'shadow' && !mine.length) return;
        ['ALL'].concat(SRCore.REGIMES).forEach(function (rg) {
          var list = rg === 'ALL' ? mine : mine.filter(function (x) { return x.regime === rg; });
          if (rg !== 'ALL' && !list.length) return;
          var m = SRCore.metrics(list, { capital: cap });
          var row = { strategy: st.id, name: st.name, horizon: st.horizon, track: track, regime: rg, updatedAt: now,
            note: m.trades < rules.minTrades ? 'Insufficient data (' + m.trades + ' of ' + rules.minTrades + ')' : m.days < rules.minDays ? 'Insufficient data (trades on ' + m.days + ' of ' + rules.minDays + ' days)' : '' };
          Object.keys(m).forEach(function (k) { row[k] = m[k] === null ? '' : m[k]; });
          metricRows.push(row);
        });
      });
    });
    Tables.ensure('Metrics', this.METRIC_HEADERS);
    Store.replaceAll('Metrics', metricRows);

    // Strategies sheet: the numbers each status is judged on.
    var sh = Tables.ensure('Strategies', ['id', 'name', 'horizon', 'enabled', 'status', 'override', 'trades', 'wins', 'losses', 'flats', 'winRatePct', 'avgNetPct', 'profitFactor', 'maxDrawdownPct', 'alphaPct', 'updatedAt', 'statusSince'].concat(this.STRAT_EXTRA));
    StrategyBook.seed();
    var t = Tables.read('Strategies');
    var open = {};
    rows.forEach(function (r) { if (r.status === 'ACTIVE' && (r.track || 'main') === 'main') open[r.strategy] = (open[r.strategy] || 0) + 1; });
    t.rows.forEach(function (o) {
      var list = self.window(trades.filter(function (x) { return x.strategy === o.id && x.track === 'main'; }));
      var m = SRCore.metrics(list, { capital: cap }), g = SRCore.graduate(m, rules);
      var b = function (v) { return v === null ? '' : v; };
      o.trades = m.trades; o.wins = m.wins; o.losses = m.losses; o.flats = m.flats; o.winRatePct = b(m.winRatePct);
      o.avgNetPct = b(m.expectancyPct); o.expectancyPct = b(m.expectancyPct); o.profitFactor = b(m.profitFactor);
      o.maxDrawdownPct = b(m.maxDrawdownPct); o.alphaPct = b(m.avgAlphaPct); o.avgWinPct = b(m.avgWinPct); o.avgLossPct = b(m.avgLossPct);
      o.avgHoldDays = b(m.avgHoldDays); o.openTrades = open[o.id] || 0; o.updatedAt = now; o.tradeDays = m.days;
      o.note = g.status === String(o.status).toUpperCase() ? g.reason : 'Next weekly review: ' + g.status.replace('_', '-') + '. ' + g.reason;
    });
    Tables.writeCols(t, ['trades', 'wins', 'losses', 'flats', 'winRatePct', 'avgNetPct', 'expectancyPct', 'profitFactor', 'maxDrawdownPct', 'alphaPct', 'avgWinPct', 'avgLossPct', 'avgHoldDays', 'openTrades', 'updatedAt', 'note', 'tradeDays'], 0);
    StrategyBook._map = null;

    var summary = this.paperSummary(rows, trades);
    Secrets.props().setProperty('PAPER_SUMMARY', JSON.stringify(summary));
    return summary;
  },

  /** Totals for the main paper account: closed and open trades, overall and per horizon. */
  paperSummary: function (rows, trades) {
    var cap = this.sizing().capital, self = this;
    var main = trades.filter(function (x) { return x.track === 'main' && self.num(x.netPnl); });
    var by = {}, total = 0;
    main.forEach(function (x) { by[x.horizon] = (by[x.horizon] || 0) + x.netPnl; total += x.netPnl; });
    var openN = 0, unreal = 0;
    rows.forEach(function (r) {
      if (r.status === 'ACTIVE' && (r.track || 'main') === 'main' && Number(r.paperQty) > 0) { openN++; if (self.num(r._unrealised)) unreal += r._unrealised; }
    });
    Object.keys(by).forEach(function (h) { by[h] = self.round(by[h]); });
    return { capital: cap, closed: main.length, netPnl: this.round(total), returnPct: this.round(total / cap * 100, 2), byHorizon: by, open: openN, unrealisedPnl: this.round(unreal), at: new Date().toISOString(), start: Secrets.props().getProperty('PAPER_START') || '' };
  },

  /* ------------------------------ Reports ------------------------------ */

  /** The closing summary's paper-trading lines for today. */
  paperLines: function (today) {
    var e = Notify.esc, self = this, rows = Tables.read('Alerts').rows, L = [];
    var s = null;
    try { s = JSON.parse(Secrets.props().getProperty('PAPER_SUMMARY') || 'null'); } catch (x) { s = null; }
    var closedToday = rows.filter(function (r) {
      return (r.track || 'main') === 'main' && r.status === 'CLOSED' && REVIEW_OUTCOMES.indexOf(r.outcome) >= 0 && r.direction !== 'EXIT' &&
        r.closedAt instanceof Date && MarketCal.ymd(r.closedAt) === today && Number(r.paperQty) > 0;
    });
    var notTrig = rows.filter(function (r) { return (r.track || 'main') === 'main' && r.outcome === 'NOT_TRIGGERED' && r.closedAt instanceof Date && MarketCal.ymd(r.closedAt) === today; }).length;
    L.push('💼 <b>Paper trading</b> (virtual ' + Fmt.money(this.sizing().capital, 0) + ')');
    if (closedToday.length) {
      var net = 0, w = 0, l = 0;
      closedToday.forEach(function (r) { net += Number(r.netPnl) || 0; if (Number(r.netPnl) > 0) w++; else if (Number(r.netPnl) < 0) l++; });
      L.push('Closed today: ' + closedToday.length + ' · net ' + Fmt.money(self.round(net), 0) + ' (' + w + ' won, ' + l + ' lost, after charges)');
      var mark = { TARGET_HIT: '✅', STOP_HIT: '❌', EXPIRED: '⏹️' };
      closedToday.slice(0, 8).forEach(function (r) {
        L.push((mark[r.outcome] || '•') + ' ' + (r.direction === 'SHORT' ? 'SHORT ' : '') + e(r.symbol) + ' ' + self.outcomeName(r.outcome) + ' ' + Fmt.pct(Number(r.netPct)) + ' (' + Fmt.money(Number(r.netPnl), 0) + ')');
      });
      if (closedToday.length > 8) L.push('… and ' + (closedToday.length - 8) + ' more in the PaperTrades sheet.');
    } else {
      L.push('Closed today: none.');
    }
    if (notTrig) L.push(notTrig + ' alert' + (notTrig > 1 ? 's' : '') + ' never reached the entry range (not counted).');
    if (s) {
      L.push('Open: ' + s.open + ' position' + (s.open === 1 ? '' : 's') + (s.open ? ', unrealised ' + Fmt.money(s.unrealisedPnl, 0) : '') + '.');
      var parts = Object.keys(s.byHorizon).map(function (h) { return (AlertBook.HORIZON_NAMES[h] || h) + ' ' + Fmt.money(s.byHorizon[h], 0); });
      L.push('Since start: ' + Fmt.money(s.netPnl, 0) + ' (' + Fmt.pct(s.returnPct) + ') from ' + s.closed + ' closed trade' + (s.closed === 1 ? '' : 's') + (parts.length ? ' · ' + parts.join(' · ') : '') + '.');
    }
    return L;
  },

  outcomeName: function (o) {
    return { TARGET_HIT: 'target hit', STOP_HIT: 'stopped out', EXPIRED: 'expired', NOT_TRIGGERED: 'not triggered', EXIT_RIGHT: 'exit was right', EXIT_EARLY: 'exit was early', NO_DATA: 'no data' }[o] || o;
  },

  statusName: function (s) { return { PAPER: 'Paper', LIVE_READY: 'Live-ready', REJECTED: 'Rejected' }[s] || s; },

  /** One strategy as two short lines for Telegram. */
  strategyLines: function (st, m, g, current) {
    var bits = [];
    if (m.trades) {
      bits.push('win ' + m.winRatePct + '%');
      bits.push('avg ' + Fmt.pct(m.expectancyPct) + '/trade');
      if (m.profitFactor !== null) bits.push('PF ' + m.profitFactor.toFixed(2));
      if (m.maxDrawdownPct !== null) bits.push('DD ' + m.maxDrawdownPct.toFixed(1) + '%');
      if (m.avgAlphaPct !== null) bits.push('vs Nifty ' + Fmt.pct(m.avgAlphaPct));
    }
    var icon = current === 'LIVE_READY' ? '✅' : current === 'REJECTED' ? '⛔' : '🧪', rules = this.rules();
    return [icon + ' <b>' + Notify.esc(st.name) + '</b> · ' + this.statusName(current) + ' · ' + m.trades + '/' + rules.minTrades + ' trades' + (rules.minDays ? ', ' + m.days + '/' + rules.minDays + ' days' : ''),
      '   ' + (bits.length ? bits.join(' · ') : 'no closed paper trades yet')];
  },

  /**
   * Saturday: refresh the numbers, apply Live-ready / Rejected decisions (a message for each change),
   * and send the weekly report on Telegram and email.
   */
  weekly: function () {
    var self = this, t = this.alerts(), rows = t.rows, trades = this.closedTrades(rows), rules = this.rules(), cap = this.sizing().capital;
    // Numbers were refreshed at the last close; the decisions below use the closed trades directly.
    var changes = this.graduation(trades, rules, cap);
    var today = MarketCal.ymd(), weekAgo = Date.now() - 7 * 86400000;
    var week = trades.filter(function (x) { return x.track === 'main' && x.exitT >= weekAgo; });
    var wNet = 0, wWins = 0;
    week.forEach(function (x) { if (self.num(x.netPnl)) wNet += x.netPnl; if (x.netPct > 0) wWins++; });
    var s = null;
    try { s = JSON.parse(Secrets.props().getProperty('PAPER_SUMMARY') || 'null'); } catch (x) { s = null; }
    var L = ['📊 <b>Weekly report</b> · week to ' + Fmt.day(MarketCal.lastCompletedSession()), ''];
    L.push('<b>Paper trading</b>: ' + week.length + ' trade' + (week.length === 1 ? '' : 's') + ' closed this week, ' + wWins + ' won, net ' + Fmt.money(this.round(wNet), 0) + ' after charges.');
    if (s) L.push('Since start: ' + Fmt.money(s.netPnl, 0) + ' (' + Fmt.pct(s.returnPct) + ' of ' + Fmt.money(cap, 0) + '), ' + s.open + ' open.');
    L.push(Market.line(Market.saved()));
    L.push('', '<b>Strategies</b> (closed paper trades / ' + rules.minTrades + ' needed' + (rules.minDays ? ', on ' + rules.minDays + '+ different days' : '') + ')');
    var book = StrategyBook.load();
    SRCore.STRATEGIES.forEach(function (st) {
      var m = SRCore.metrics(self.window(trades.filter(function (x) { return x.strategy === st.id && x.track === 'main'; })), { capital: cap });
      L = L.concat(self.strategyLines(st, m, null, book[st.id] ? book[st.id].status : 'PAPER'));
    });
    if (changes.length) {
      L.push('', '<b>Status changes this week</b>');
      changes.forEach(function (c) { L.push('• ' + Notify.esc(c.name) + ': ' + self.statusName(c.from) + ' → ' + self.statusName(c.to)); });
    }
    L = L.concat(this.filterCheckLines(trades, cap));
    L.push('', 'Every number is from paper trades judged on real Angel One prices, after estimated Zerodha charges. Not investment advice.');
    var text = L.join('\n');
    Notify.safeTelegram(text);
    if (Config.get('emailDigest')) { try { Notify.email('Weekly report ' + Fmt.day(today), Notify.htmlFromTelegram(text)); } catch (e) { ErrorLog.add('weeklyEmail', e); } }
    this.saveReport('weekly', 'Weekly report ' + today, week.length + ' trades closed, net ' + this.round(wNet), { changes: changes, summary: s });
    return { changes: changes.length, closedThisWeek: week.length };
  },

  /** Apply the Live-ready / Rejected rules; send a message for every change. Returns the changes. */
  graduation: function (trades, rules, cap) {
    var self = this, t = Tables.read('Strategies'), changes = [], now = new Date();
    t.rows.forEach(function (o) {
      var st = SRCore.strategy(String(o.id));
      if (!st) return;
      var m = SRCore.metrics(self.window(trades.filter(function (x) { return x.strategy === st.id && x.track === 'main'; })), { capital: cap });
      var g = SRCore.graduate(m, rules), from = String(o.status || 'PAPER').toUpperCase();
      o.statusReason = g.reason;
      if (g.status === from) return;
      o.status = g.status; o.statusSince = now;
      var override = String(o.override || '').trim();
      changes.push({ id: st.id, name: st.name, from: from, to: g.status, reason: g.reason, override: override });
    });
    Tables.writeCols(t, ['status', 'statusSince', 'statusReason'], 0);
    StrategyBook._map = null;
    changes.forEach(function (c) {
      var head = c.to === 'LIVE_READY' ? '🎓 <b>' + Notify.esc(c.name) + ' is now LIVE-READY</b>'
        : c.to === 'REJECTED' ? '⛔ <b>' + Notify.esc(c.name) + ' is now REJECTED</b>'
        : (c.from === 'LIVE_READY' ? '↩️ <b>' + Notify.esc(c.name) + ' is back to PAPER</b>' : '🔄 <b>' + Notify.esc(c.name) + ' is back to PAPER</b>');
      var tail = c.to === 'LIVE_READY' ? 'Its alerts now show this record. You still decide every trade yourself.'
        : c.to === 'REJECTED' ? 'It keeps paper-trading silently, so it can recover. No more alerts from it on Telegram.'
        : c.from === 'LIVE_READY' ? 'Its record has slipped, so its alerts are labelled PAPER again.' : 'It has recovered enough to send paper alerts again.';
      Notify.safeTelegram(head + '\n' + Notify.esc(c.reason) + '\n' + tail + (c.override ? '\nNote: your override in the Strategies sheet (' + Notify.esc(c.override) + ') still decides how its alerts are labelled.' : ''));
    });
    return changes;
  },

  /**
   * Did the market filters help? Signals they blocked (tracked silently) against those they let through,
   * per horizon, and for intraday per filter: the regime, your Bear/Bull switches and the day's direction.
   */
  filterCheckLines: function (trades, cap) {
    var L = [], shadow = trades.filter(function (x) { return x.track === 'shadow'; });
    if (!shadow.length) return L;
    var names = { regime: 'by the regime', switch: 'by your Bear/Bull switch', day: 'by the day\'s direction' };
    var line = function (label, sh, mn) {
      var a = SRCore.metrics(sh, { capital: cap }), b = SRCore.metrics(mn, { capital: cap });
      return label + ': blocked ' + a.trades + ' averaged ' + Fmt.pct(a.expectancyPct) + ' (win ' + a.winRatePct + '%)' +
        (b.trades ? ' vs taken ' + b.trades + ' at ' + Fmt.pct(b.expectancyPct) + ' (win ' + b.winRatePct + '%)' : '');
    };
    L.push('', '<b>Filter check</b> (signals the market filters blocked, paper-tracked silently)');
    ['INTRADAY', 'SWING', 'MEDIUM', 'LONG'].forEach(function (h) {
      var sh = shadow.filter(function (x) { return x.horizon === h; });
      if (!sh.length) return;
      var mn = trades.filter(function (x) { return x.track === 'main' && x.horizon === h; });
      var kinds = {};
      sh.forEach(function (x) { kinds[x.blockedBy || 'regime'] = true; });
      var ks = Object.keys(kinds);
      if (ks.length === 1) { L.push(line((AlertBook.HORIZON_NAMES[h] || h) + ' (' + names[ks[0]] + ')', sh, mn)); return; }
      ks.forEach(function (k) { L.push(line((AlertBook.HORIZON_NAMES[h] || h) + ' ' + names[k], sh.filter(function (x) { return (x.blockedBy || 'regime') === k; }), mn)); });
    });
    return L;
  },

  /** Day 30, 60 and 90 after paper trading began: a verdict for every strategy. Sent once each. */
  readinessIfDue: function (today) {
    var p = Secrets.props(), start = p.getProperty('PAPER_START');
    if (!start) return null;
    var days = Math.round((Date.parse(today + 'T12:00:00+05:30') - Date.parse(start + 'T12:00:00+05:30')) / 86400000);
    var sent = (p.getProperty('READINESS_SENT') || '').split(',').filter(Boolean);
    var due = [30, 60, 90].filter(function (d) { return days >= d && sent.indexOf(String(d)) < 0; });
    if (!due.length) return null;
    var milestone = due[due.length - 1]; // if several are overdue, send the latest one only
    this.readiness(milestone);
    p.setProperty('READINESS_SENT', sent.concat(due.map(String)).join(','));
    return milestone;
  },

  readiness: function (dayN) {
    var self = this, rows = Tables.read('Alerts').rows, trades = this.closedTrades(rows), rules = this.rules(), cap = this.sizing().capital;
    var L = ['📋 <b>Readiness report · day ' + dayN + ' of paper trading</b>', ''];
    var groups = { LIVE_READY: [], PAPER: [], REJECTED: [], MORE: [] };
    SRCore.STRATEGIES.forEach(function (st) {
      var m = SRCore.metrics(self.window(trades.filter(function (x) { return x.strategy === st.id && x.track === 'main'; })), { capital: cap });
      var g = SRCore.graduate(m, rules);
      var key = g.status === 'PAPER' && (m.trades < rules.minTrades || m.days < rules.minDays) ? 'MORE' : g.status;
      groups[key].push({ st: st, m: m, g: g });
    });
    var show = function (title, list) {
      if (!list.length) return;
      L.push('<b>' + title + '</b>');
      list.forEach(function (x) { L = L.concat(self.strategyLines(x.st, x.m, x.g, x.g.status)); L.push('   ' + Notify.esc(x.g.reason)); });
      L.push('');
    };
    show('Live-ready', groups.LIVE_READY);
    show('Needs more data', groups.MORE);
    show('Paper: enough trades, not good enough yet', groups.PAPER);
    show('Rejected', groups.REJECTED);
    L.push('Live-ready needs ' + rules.minTrades + '+ closed trades' + (rules.minDays ? ' on ' + rules.minDays + '+ different days' : '') + ', a positive average after charges, profit factor ≥ ' + rules.minPF + ', drawdown ≤ ' + rules.maxDrawdownPct + '% and beating Nifty 50 over the same holding periods.');
    L.push('Performance screen: https://sambadhyam.github.io/stock-radar/#/results (shows live numbers once the app is connected in Phase 4).');
    var text = L.join('\n');
    Notify.safeTelegram(text);
    if (Config.get('emailDigest')) { try { Notify.email('Readiness report, day ' + dayN, Notify.htmlFromTelegram(text)); } catch (e) { ErrorLog.add('readinessEmail', e); } }
    this.saveReport('readiness', 'Readiness report, day ' + dayN, groups.LIVE_READY.length + ' live-ready, ' + groups.REJECTED.length + ' rejected, ' + groups.MORE.length + ' need more data', {
      day: dayN, verdicts: SRCore.STRATEGIES.map(function (st) {
        var m = SRCore.metrics(self.window(trades.filter(function (x) { return x.strategy === st.id && x.track === 'main'; })), { capital: cap });
        return { id: st.id, status: SRCore.graduate(m, rules).status, trades: m.trades, winRatePct: m.winRatePct, expectancyPct: m.expectancyPct, profitFactor: m.profitFactor };
      }),
    });
    return text;
  },

  saveReport: function (type, title, summary, payload) {
    try {
      Tables.ensure('Reports', ['id', 'type', 'createdAt', 'title', 'summary', 'payload']);
      var json = JSON.stringify(payload || {});
      Store.append('Reports', [{ id: 'R' + Utilities.formatDate(new Date(), IST, 'yyyyMMdd-HHmm') + '-' + type, type: type, createdAt: new Date(), title: title, summary: summary, payload: json.length > 45000 ? json.slice(0, 45000) : json }]);
    } catch (e) { ErrorLog.add('saveReport', e); }
  },
};

/* ============================== Menu: update paper results ============================== */

/** Stock Radar → Update paper results now. Judges alerts and refreshes the numbers outside market hours. */
function updatePaperResults() {
  var today = MarketCal.ymd();
  if (MarketCal.marketState() === 'open') { Ui.alert('Paper results', 'This runs by itself after the close. Please try again after 15:30.'); return null; }
  var t0 = Date.now(), out = { intraday: '', daily: null };
  var r1 = Jobs.run('evaluateIntraday', function () { return Review.intraday(today, {}, t0 + 200000); }, { lock: true, wait: 10000 });
  var r2 = Jobs.run('evaluateDaily', function () { return Review.daily(today); }, { lock: true, wait: 10000 });
  out.intraday = r1; out.daily = r2;
  var s = null;
  try { s = JSON.parse(Secrets.props().getProperty('PAPER_SUMMARY') || 'null'); } catch (e) { s = null; }
  Ui.alert('Paper results updated',
    (r2 ? r2.judged + ' alerts checked with daily prices, ' + r2.checkpoints + ' checkpoints added.\n' : 'Could not update daily results (see ErrorLog).\n') +
    (r1 === 'more' ? 'Some intraday alerts are left for the next run.\n' : '') +
    (s ? '\nPaper account: ' + s.closed + ' closed trades, net ' + Fmt.money(s.netPnl, 0) + ' (' + Fmt.pct(s.returnPct) + '), ' + s.open + ' open.' : '') +
    '\n\nDetails are in the PaperTrades, Metrics and Strategies sheets.');
  return out;
}

/* ============================== Session review (after the close) ============================== */

/**
 * The day's paper results worked out from the Alerts sheet: money and %, wins and losses, targets and stops,
 * each strategy, buys against shorts, the time of day and the market filters. Every number is computed here;
 * the optional AI part (Lab.gs AiSummary.session) only puts these numbers into words.
 * Sent to Telegram after the closing summary, kept for the app (last one in Script Properties, 60 days in Drive).
 */
var SessionReview = {
  KEY: 'SESSION_REVIEW',
  FILE: 'sessions.json',
  KEEP: 60,
  TIMES: [['09:15–10:30', 555, 630], ['10:30–12:30', 630, 750], ['12:30–15:30', 750, 931]],

  build: function (day) {
    var rows = Tables.read('Alerts').rows, cap = Review.sizing().capital, self = this, R = Review;
    var on = function (d) { return d instanceof Date && MarketCal.ymd(d) === day; };
    var isMain = function (r) { return (r.track || 'main') === 'main'; };
    var created = rows.filter(function (r) { return on(r.createdAt); });
    var mainNew = created.filter(isMain);
    var closed = rows.filter(function (r) { return r.status === 'CLOSED' && on(r.closedAt); });
    var paid = function (r) { return REVIEW_OUTCOMES.indexOf(r.outcome) >= 0 && r.direction !== 'EXIT' && Number(r.paperQty) > 0 && R.num(r.netPnl); };
    var trades = closed.filter(function (r) { return isMain(r) && paid(r); });
    var count = function (list, f) { return list.filter(f).length; };
    var hz = function (h) { return count(mainNew, function (r) { return r.horizon === h; }); };
    var net = 0, gross = 0, charges = 0, pctSum = 0;
    trades.forEach(function (r) { net += Number(r.netPnl) || 0; gross += Number(r.grossPnl) || 0; charges += Number(r.charges) || 0; pctSum += Number(r.netPct) || 0; });
    var won = count(trades, function (r) { return r.netPnl > 0; }), lost = count(trades, function (r) { return r.netPnl < 0; });
    var pick = function (r) {
      if (!r) return null;
      var st = SRCore.strategy(r.strategy);
      return { symbol: String(r.symbol), strategy: st ? st.name : String(r.strategy), horizon: String(r.horizon), dir: String(r.direction), pct: R.round(Number(r.netPct), 2), net: R.round(Number(r.netPnl), 0) };
    };
    var sorted = trades.slice().sort(function (a, b) { return b.netPnl - a.netPnl; });
    var minute = function (r) { return MarketCal.minutes(r.createdAt); };
    var byTime = this.TIMES.map(function (t) {
      var g = self.group(trades.filter(function (r) { return r.horizon === 'INTRADAY' && minute(r) >= t[1] && minute(r) < t[2]; }), function () { return 'x'; }).x;
      return g ? { label: t[0], n: g.n, won: g.won, lost: g.lost, net: g.net, avgPct: g.avgPct } : null;
    }).filter(Boolean);
    var strat = this.group(trades, function (r) { return r.strategy; });
    var byStrategy = Object.keys(strat).map(function (id) { var g = strat[id], st = SRCore.strategy(id); g.id = id; g.name = st ? st.name : id; return g; })
      .sort(function (a, b) { return b.net - a.net; });
    var dirs = this.group(trades, function (r) { return r.direction; });
    // Held-back signals against the trades taken, intraday with intraday and the rest with the rest, in % a trade.
    var judged = function (r) { return REVIEW_OUTCOMES.indexOf(r.outcome) >= 0 && r.direction !== 'EXIT' && R.num(r.netPct); };
    var takenAvg = function (intra) {
      var list = closed.filter(function (r) { return isMain(r) && judged(r) && (r.horizon === 'INTRADAY') === intra; });
      return list.length ? R.round(list.reduce(function (a, r) { return a + Number(r.netPct); }, 0) / list.length, 2) : null;
    };
    var taken = { INTRADAY: takenAvg(true), OTHER: takenAvg(false) };
    var shadowClosed = closed.filter(function (r) { return !isMain(r) && judged(r); });
    var kinds = this.group(shadowClosed, function (r) { return R.blockKind(r.telegram) + '|' + (r.horizon === 'INTRADAY' ? 'INTRADAY' : 'OTHER'); });
    var filters = Object.keys(kinds).map(function (key) {
      var g = kinds[key], kind = key.split('|')[0], hz = key.split('|')[1];
      return { kind: kind, intraday: hz === 'INTRADAY', n: g.n, won: g.won, avgPct: g.avgPct, net: g.net, takenAvgPct: taken[hz], verdict: self.verdict(g.n, g.avgPct, taken[hz], hz === 'INTRADAY') };
    }).sort(function (a, b) { return b.n - a.n; });
    // What became of every alert made today, so the numbers add up (sent ones, and the ones held back).
    var fateOf = function (r) {
      if (r.status !== 'CLOSED') return r.horizon === 'INTRADAY' ? 'pending' : 'open';
      if (r.outcome === 'NOT_TRIGGERED') return 'notTriggered';
      if (r.outcome === 'NO_DATA') return 'noData';
      if (REVIEW_OUTCOMES.indexOf(r.outcome) < 0) return 'other';
      return isMain(r) && !(Number(r.paperQty) > 0 && R.num(r.netPnl)) ? 'tooPricey' : 'traded';
    };
    var fate = function (list) {
      var o = { traded: 0, notTriggered: 0, tooPricey: 0, noData: 0, pending: 0, open: 0, other: 0 };
      list.forEach(function (r) { if (r.direction !== 'EXIT') o[fateOf(r)]++; });
      return o;
    };
    var opened = mainNew.filter(function (r) { return r.horizon !== 'INTRADAY' && r.direction !== 'EXIT'; }).slice(0, 15).map(function (r) {
      var st = SRCore.strategy(r.strategy);
      return { symbol: String(r.symbol), horizon: String(r.horizon), strategy: st ? st.name : String(r.strategy), dir: String(r.direction), entryLow: Number(r.entryLow), entryHigh: Number(r.entryHigh), stop: Number(r.stop), target1: Number(r.target1) };
    });
    var ps = null, snap = null;
    try { ps = JSON.parse(Secrets.props().getProperty('PAPER_SUMMARY') || 'null'); } catch (e) { ps = null; }
    try { snap = JSON.parse(Secrets.props().getProperty('SNAPSHOT') || 'null'); } catch (e) { snap = null; }
    var nq = snap && snap.quotes && snap.quotes['NIFTY 50'], reg = Market.saved();
    return {
      v: 1, day: day, at: Date.now(), capital: cap, regime: reg ? reg.state : 'UNKNOWN',
      nifty: nq ? { last: nq.ltp, pct: R.num(nq.changePct) ? R.round(nq.changePct, 2) : null } : null,
      alerts: { n: mainNew.length, intraday: hz('INTRADAY'), swing: hz('SWING'), medium: hz('MEDIUM'), long: hz('LONG'),
        buy: count(mainNew, function (r) { return r.direction === 'BUY'; }), short: count(mainNew, function (r) { return r.direction === 'SHORT'; }),
        exit: count(mainNew, function (r) { return r.direction === 'EXIT'; }), blocked: created.length - mainNew.length,
        pending: count(mainNew, function (r) { return r.status !== 'CLOSED' && r.horizon === 'INTRADAY'; }),
        fate: fate(mainNew), heldFate: fate(created.filter(function (r) { return !isMain(r); })),
        perStock: Math.round(cap * (Review.sizing().maxPer || 100) / 100) },
      paper: { n: trades.length, won: won, lost: lost, flat: trades.length - won - lost, winRatePct: trades.length ? Math.round(won / trades.length * 100) : null,
        net: R.round(net, 0), gross: R.round(gross, 0), charges: R.round(charges, 0), returnPct: cap > 0 ? R.round(net / cap * 100, 2) : null, avgPct: trades.length ? R.round(pctSum / trades.length, 2) : null,
        target: count(trades, function (r) { return r.outcome === 'TARGET_HIT'; }), stop: count(trades, function (r) { return r.outcome === 'STOP_HIT'; }),
        expired: count(trades, function (r) { return r.outcome === 'EXPIRED'; }),
        notTriggered: count(closed, function (r) { return isMain(r) && r.outcome === 'NOT_TRIGGERED'; }) },
      best: sorted.length ? pick(sorted[0]) : null, worst: sorted.length > 1 ? pick(sorted[sorted.length - 1]) : null,
      byStrategy: byStrategy, byDir: dirs, byTime: byTime, filters: filters, opened: opened,
      open: ps ? { n: ps.open, unrealised: ps.unrealisedPnl } : null,
      total: ps ? { net: ps.netPnl, returnPct: ps.returnPct, closed: ps.closed } : null,
      ai: null,
    };
  },

  /**
   * Did a filter help today? Its held-back signals against the trades taken (same kind of horizon), in % a trade.
   * A gap under 0.05 points (intraday) or 0.5 points (longer trades) is too small to mean anything, and so are
   * fewer than five signals. Returns 'helped', 'cost', 'same' or 'few'.
   */
  verdict: function (n, avg, taken, intraday) {
    if (!(n >= 5) || !Review.num(avg)) return 'few';
    if (!Review.num(taken)) return avg < 0 ? 'helped' : avg > 0 ? 'cost' : 'same';
    var gap = avg - taken;
    return Math.abs(gap) < (intraday ? 0.05 : 0.5) ? 'same' : gap < 0 ? 'helped' : 'cost';
  },

  /** "49 paper trades, 3 never reached the entry, …" for the alerts made today. held: the held-back ones. */
  fateText: function (o, perStock, held) {
    if (!o) return '';
    var plural = function (n, one, many) { return n + ' ' + (n === 1 ? one : many); };
    var parts = [];
    if (o.traded) parts.push(held ? plural(o.traded, 'was judged', 'were judged') : plural(o.traded, 'paper trade', 'paper trades'));
    if (o.notTriggered) parts.push(o.notTriggered + ' never reached the entry');
    if (o.tooPricey) parts.push(plural(o.tooPricey, 'was', 'were') + ' too pricey for the ' + Fmt.money(perStock, 0) + ' per-stock limit (counted in % only)');
    if (o.noData) parts.push(o.noData + ' had no price data');
    if (o.pending) parts.push(o.pending + ' not judged yet');
    if (o.open) parts.push(o.open + ' still open');
    if (o.other) parts.push(o.other + ' other');
    return parts.join(', ');
  },

  /** A filter's result in words, e.g. "averaged −0.06% a trade against −0.07% for the trades taken: about the same". */
  filterText: function (g) {
    var tail = { helped: 'the filter helped', cost: 'the filter cost money today', same: 'about the same, so no verdict yet', few: 'too few to judge' }[g.verdict];
    var vs = Review.num(g.takenAvgPct) ? ' against ' + Fmt.pct(g.takenAvgPct) + ' for the trades taken' : '';
    if (!g.verdict) tail = g.avgPct < 0 ? 'the filter helped' : g.avgPct > 0 ? 'they would have made money' : ''; // a review saved before 0.6.5
    return 'averaged ' + Fmt.pct(g.avgPct) + ' a trade' + vs + (tail ? ': ' + tail : '');
  },

  /** n, won, lost, net ₹ and average % per group. */
  group: function (list, keyOf) {
    var out = {};
    list.forEach(function (r) {
      var k = keyOf(r);
      if (!k) return;
      var g = out[k] || (out[k] = { n: 0, won: 0, lost: 0, net: 0, pct: 0 });
      var n = Number(r.netPnl) || 0;
      g.n++; if (n > 0) g.won++; else if (n < 0) g.lost++;
      g.net += n; g.pct += Number(r.netPct) || 0;
    });
    Object.keys(out).forEach(function (k) { var g = out[k]; g.net = Review.round(g.net, 0); g.avgPct = Review.round(g.pct / g.n, 2); delete g.pct; });
    return out;
  },

  /** The review as plain sentences: the AI's only source, so it cannot quote a number that is not here. */
  factLines: function (f) {
    var L = [], p = f.paper, m = function (x) { return Fmt.money(x, 0); };
    L.push('Date: ' + Fmt.day(f.day) + '. Market regime: ' + SRCore.regimeName(f.regime) + '.' + (f.nifty && f.nifty.pct !== null ? ' Nifty 50 closed ' + Fmt.pct(f.nifty.pct) + '.' : ''));
    L.push('Alerts sent today: ' + f.alerts.n + ' (' + f.alerts.intraday + ' intraday, ' + f.alerts.swing + ' swing, ' + f.alerts.medium + ' medium term, ' + f.alerts.long + ' long term; ' + f.alerts.buy + ' buys, ' + f.alerts.short + ' shorts, ' + f.alerts.exit + ' exit checks). ' + f.alerts.blocked + ' more signals were held back by the market filters.');
    if (f.alerts.fate) L.push('What became of today\'s alerts: ' + this.fateText(f.alerts.fate, f.alerts.perStock) + '.');
    L.push('Paper trades closed today: ' + p.n + '. Won ' + p.won + ', lost ' + p.lost + ', flat ' + p.flat + (p.winRatePct !== null ? '. Win rate ' + p.winRatePct + '%' : '') + '.');
    L.push('Net result today after charges: ' + m(p.net) + (p.returnPct !== null ? ' (' + Fmt.pct(p.returnPct) + ' of the ' + m(f.capital) + ' paper capital)' : '') + '. Result before charges: ' + (p.gross > 0 ? '+' : '') + m(p.gross) + '. Charges ' + m(p.charges) + '. Average per trade after charges ' + (p.avgPct !== null ? Fmt.pct(p.avgPct) : '—') + '.');
    L.push('Targets hit ' + p.target + ', stop-losses hit ' + p.stop + ', expired ' + p.expired + ', never reached the entry ' + p.notTriggered + '.');
    if (f.best) L.push('Best trade: ' + f.best.symbol + ' (' + f.best.strategy + ', ' + f.best.dir.toLowerCase() + ') ' + Fmt.pct(f.best.pct) + ', ' + m(f.best.net) + '.');
    if (f.worst) L.push('Worst trade: ' + f.worst.symbol + ' (' + f.worst.strategy + ', ' + f.worst.dir.toLowerCase() + ') ' + Fmt.pct(f.worst.pct) + ', ' + m(f.worst.net) + '.');
    f.byStrategy.forEach(function (g) { L.push('Strategy ' + g.name + ': ' + g.n + ' trades, ' + g.won + ' won, ' + g.lost + ' lost, net ' + m(g.net) + ', average ' + Fmt.pct(g.avgPct) + '.'); });
    ['BUY', 'SHORT'].forEach(function (d) { var g = f.byDir[d]; if (g) L.push((d === 'BUY' ? 'Buys' : 'Shorts') + ': ' + g.n + ' trades, ' + g.won + ' won, net ' + m(g.net) + ', average ' + Fmt.pct(g.avgPct) + '.'); });
    f.byTime.forEach(function (g) { L.push('Intraday alerts from ' + g.label + ': ' + g.n + ' trades, ' + g.won + ' won, net ' + m(g.net) + '.'); });
    var names = { regime: 'the market regime filter', switch: 'the Bear/Bull switches', day: 'the day\'s-direction filter' }, self = this;
    f.filters.forEach(function (g) { L.push('Signals held back by ' + (names[g.kind] || g.kind) + (g.intraday === false ? ' (swing and longer)' : g.intraday ? ' (intraday)' : '') + ' and closed today: ' + g.n + ', ' + g.won + ' would have won; they ' + self.filterText(g) + '.'); });
    if (f.alerts.pending) L.push(f.alerts.pending + ' of today\'s intraday alerts ' + (f.alerts.pending === 1 ? 'is' : 'are') + ' not judged yet.');
    if (f.open) L.push('Paper trades still open: ' + f.open.n + ', unrealised ' + m(f.open.unrealised) + '.');
    if (f.total) L.push('Since the paper account started: ' + m(f.total.net) + ' (' + Fmt.pct(f.total.returnPct) + ') over ' + f.total.closed + ' closed trades.');
    return L;
  },

  /** The Telegram message. */
  message: function (f) {
    var e = Notify.esc, p = f.paper, L = [], m = function (x) { return Fmt.money(x, 0); };
    var signed = function (x) { return (x > 0 ? '+' : '') + Fmt.money(x, 0); };
    var tr = function (n) { return n + ' trade' + (n === 1 ? '' : 's'); };
    L.push('📒 <b>Session review · ' + Fmt.day(f.day) + '</b>');
    if (p.n) {
      L.push((p.net > 0 ? '📈' : p.net < 0 ? '📉' : '➖') + ' Paper result today: <b>' + signed(p.net) + '</b>' + (p.returnPct !== null ? ' (' + Fmt.pct(p.returnPct) + ' of ' + m(f.capital) + ')' : '') + ', after ' + m(p.charges) + ' charges' +
        (Review.num(p.gross) ? ' (' + signed(p.gross) + ' before them)' : ''));
      L.push('📊 ' + tr(p.n) + ' closed · ✅ ' + p.won + ' won · ❌ ' + p.lost + ' lost' + (p.flat ? ' · ➖ ' + p.flat + ' flat' : '') + (p.winRatePct !== null ? ' · win rate ' + p.winRatePct + '%' : ''));
      L.push('🎯 Targets ' + p.target + ' · 🛑 Stops ' + p.stop + ' · ⏳ Expired ' + p.expired + (p.notTriggered ? ' · ⛔ Not triggered ' + p.notTriggered : ''));
      if (f.best) L.push('🏆 Best: ' + e(f.best.symbol) + ' ' + Fmt.pct(f.best.pct) + ' (' + signed(f.best.net) + ') · ' + e(f.best.strategy));
      if (f.worst) L.push('💥 Worst: ' + e(f.worst.symbol) + ' ' + Fmt.pct(f.worst.pct) + ' (' + signed(f.worst.net) + ') · ' + e(f.worst.strategy));
    } else {
      L.push('📊 No paper trades closed today' + (p.notTriggered ? ' (' + p.notTriggered + ' alert' + (p.notTriggered === 1 ? '' : 's') + ' never reached the entry)' : '') + '.');
    }
    if (f.byStrategy.length) {
      L.push('', '<b>By strategy</b>');
      f.byStrategy.forEach(function (g) { L.push((g.net > 0 ? '🟢' : g.net < 0 ? '🔴' : '⚪') + ' ' + e(g.name) + ': ' + tr(g.n) + ', ' + g.won + ' won, ' + signed(g.net) + ' (avg ' + Fmt.pct(g.avgPct) + ')'); });
    }
    if (f.byDir.BUY || f.byDir.SHORT) {
      L.push('', '<b>Buys and shorts</b>');
      if (f.byDir.BUY) L.push('🟢 Buys: ' + tr(f.byDir.BUY.n) + ', ' + f.byDir.BUY.won + ' won, ' + signed(f.byDir.BUY.net));
      if (f.byDir.SHORT) L.push('🔴 Shorts: ' + tr(f.byDir.SHORT.n) + ', ' + f.byDir.SHORT.won + ' won, ' + signed(f.byDir.SHORT.net));
    }
    if (f.byTime.length > 1) {
      L.push('', '<b>Time of day</b> (intraday)');
      f.byTime.forEach(function (g) { L.push('🕘 ' + g.label + ': ' + tr(g.n) + ', ' + g.won + ' won, ' + signed(g.net)); });
    }
    if (f.filters.length) {
      var names = { regime: 'Market regime', switch: 'Your Bear/Bull switch', day: 'Day\'s direction' }, self = this;
      L.push('', '<b>Filters</b> (signals held back, tracked silently)');
      f.filters.forEach(function (g) { L.push('🔕 ' + names[g.kind] + (g.intraday === false ? ' (swing and longer)' : '') + ': ' + g.n + ' held back, ' + self.filterText(g)); });
      if (f.alerts.heldFate && (f.alerts.heldFate.notTriggered || f.alerts.heldFate.open || f.alerts.heldFate.noData)) L.push('🔕 Of the ' + f.alerts.blocked + ' held back today: ' + this.fateText(f.alerts.heldFate, f.alerts.perStock, true) + '.');
    }
    if (f.opened.length) {
      L.push('', '<b>New swing and longer signals</b>');
      f.opened.forEach(function (o) { L.push((o.dir === 'SHORT' ? '🔴 ' : '🟢 ') + e(o.symbol) + ' · ' + (AlertBook.HORIZON_ICONS[o.horizon] || '') + ' ' + e(o.strategy) + '\n   💰 ' + Fmt.money(o.entryLow) + ' – ' + Fmt.money(o.entryHigh) + ' · 🛑 ' + Fmt.money(o.stop) + ' · 🎯 ' + Fmt.money(o.target1)); });
    }
    if (f.ai) {
      L.push('', '🤖 <b>AI review</b> <i>(' + e(f.ai.model) + ', not advice)</i>');
      if (f.ai.overview) L.push(e(f.ai.overview));
      f.ai.worked.forEach(function (x) { L.push('✔️ ' + e(x)); });
      f.ai.didnt.forEach(function (x) { L.push('✖️ ' + e(x)); });
      f.ai.watch.forEach(function (x) { L.push('👀 ' + e(x)); });
    }
    L.push('');
    if (f.alerts.n && f.alerts.fate) L.push('📣 ' + f.alerts.n + ' alert' + (f.alerts.n === 1 ? '' : 's') + ' today: ' + this.fateText(f.alerts.fate, f.alerts.perStock) + (f.alerts.exit ? ', ' + f.alerts.exit + ' exit check' + (f.alerts.exit === 1 ? '' : 's') : '') + '.');
    if (f.alerts.pending) L.push('⏳ ' + f.alerts.pending + ' of today\'s intraday alerts ' + (f.alerts.pending === 1 ? 'is' : 'are') + ' not judged yet.');
    if (f.open) L.push('📂 Still open: ' + f.open.n + ' paper trade' + (f.open.n === 1 ? '' : 's') + (f.open.n ? ', unrealised ' + signed(f.open.unrealised) : ''));
    if (f.total) L.push('🧾 Since start: ' + signed(f.total.net) + ' (' + Fmt.pct(f.total.returnPct) + ') over ' + f.total.closed + ' closed ' + (f.total.closed === 1 ? 'trade' : 'trades'));
    L.push('<i>Paper trading with virtual money, after estimated Zerodha charges. Details: app → Results → Reports.</i>');
    return L.join('\n');
  },

  /** Build, add the AI part when switched on, save and send. opts: {force: send even with nothing to report, telegram: false to skip the message}. */
  run: function (day, opts) {
    opts = opts || {};
    var f = this.build(day);
    if (!opts.force && !f.alerts.n && !f.paper.n && !f.paper.notTriggered) return null;
    try { f.ai = AiSummary.session(f); } catch (e) { ErrorLog.add('aiSessionReview', e); f.aiError = Secrets.mask(String(e.message || e)).slice(0, 200); }
    this.save(f);
    if (opts.telegram !== false && Config.get('sessionReview') !== false) Notify.safeTelegram(this.message(f));
    Review.saveReport('session', 'Session review ' + day, (f.paper.n ? f.paper.n + ' trades, net ' + Fmt.money(f.paper.net, 0) + ' (' + Fmt.pct(f.paper.returnPct) + ')' : 'No trades closed') + ', ' + f.alerts.n + ' alerts', { day: day });
    return f;
  },

  save: function (f) {
    var json = JSON.stringify(f);
    if (json.length < 8800) Secrets.props().setProperty(this.KEY, json);
    else { var g = JSON.parse(json); g.opened = g.opened.slice(0, 3); g.byStrategy = g.byStrategy.slice(0, 6); Secrets.props().setProperty(this.KEY, JSON.stringify(g).slice(0, 8800)); }
    try {
      var all = (DataFile.read(this.FILE) || { v: 1, list: [] }).list || [], day = f.day;
      all = all.filter(function (x) { return x.day !== day; }).concat([f]).sort(function (a, b) { return a.day < b.day ? -1 : 1; }).slice(-this.KEEP);
      DataFile.write(this.FILE, { v: 1, list: all });
    } catch (e) { ErrorLog.add('sessionHistory', e); }
  },

  latest: function () { try { return JSON.parse(Secrets.props().getProperty(this.KEY) || 'null'); } catch (e) { return null; } },
  list: function () { try { return ((DataFile.read(this.FILE) || {}).list || []).slice().reverse(); } catch (e) { return []; } },
};
