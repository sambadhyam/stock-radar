/**
 * Stock Radar — core.js
 * The trading logic, written once and used in two places:
 *   - the phone app (backtests, Phase 5), loaded as a plain script
 *   - the Apps Script engine, pasted unchanged as Core.gs
 * Keep this file byte-identical to apps-script/Core.gs. No import/export, no DOM, no Apps Script services.
 *
 * Contents: helpers, indicators, market regime, relative strength, the strategies,
 * the checks every signal must pass, confidence, position size, Zerodha charges,
 * and the evaluation maths: following a trade through later candles, its net result,
 * strategy metrics and the Live-ready / Rejected decision.
 *
 * Candles are objects {t, o, h, l, c, v} sorted oldest first; t is milliseconds.
 * Directions: BUY, SHORT (intraday only) and EXIT (for holdings).
 */
var SRCore = (function () {
  'use strict';

  var VERSION = '0.6.1';
  var OPEN_MIN = 555;   // 09:15 IST in minutes after midnight
  var CLOSE_MIN = 930;  // 15:30 IST
  var ALL_REGIMES = ['BULL', 'NEUTRAL', 'BEAR', 'HIGH_VOL'];

  /* =============================== Helpers =============================== */

  function num(x) { return typeof x === 'number' && isFinite(x); }
  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
  function round(x, d) { var f = Math.pow(10, d === undefined ? 2 : d); return Math.round(x * f) / f; }

  /** Round to the NSE tick of ₹0.05. mode 'down', 'up' or nearest. */
  function tickRound(x, mode) {
    if (!num(x)) return x;
    var t = x * 20;
    var r = mode === 'down' ? Math.floor(t + 1e-9) : mode === 'up' ? Math.ceil(t - 1e-9) : Math.round(t);
    return Math.round(r * 5) / 100;
  }

  /** Minutes after midnight in IST for a timestamp. */
  function istMinute(t) { return ((Math.floor(t / 60000) + 330) % 1440 + 1440) % 1440; }
  /** A day number in IST, equal for every moment of the same Indian calendar day. */
  function istDay(t) { return Math.floor((t + 330 * 60000) / 86400000); }
  function hhmm(min) { var h = Math.floor(min / 60), m = min % 60; return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m; }

  /** 1,03,420.50 with Indian grouping and a real minus sign. */
  function inr(n, d) {
    if (!num(n)) return '—';
    var parts = Math.abs(n).toFixed(d === undefined ? 2 : d).split('.');
    var whole = parts[0], last3 = whole.slice(-3), rest = whole.slice(0, -3);
    var grouped = rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3 : last3;
    return (n < 0 ? '−' : '') + '₹' + grouped + (parts[1] ? '.' + parts[1] : '');
  }
  function pct(n, d) { return num(n) ? (n < 0 ? '−' : '') + Math.abs(n).toFixed(d === undefined ? 1 : d) + '%' : '—'; }
  function times(n) { return n.toFixed(1) + '×'; }

  function maxOf(a, from, to) { var m = -Infinity; for (var i = Math.max(0, from); i <= to; i++) if (a[i] > m) m = a[i]; return m; }
  function minOf(a, from, to) { var m = Infinity; for (var i = Math.max(0, from); i <= to; i++) if (a[i] < m) m = a[i]; return m; }
  function meanOf(a, from, to) {
    var s = 0, n = 0;
    for (var i = Math.max(0, from); i <= to; i++) if (num(a[i])) { s += a[i]; n++; }
    return n ? s / n : null;
  }
  function pluck(candles, key) { var out = new Array(candles.length); for (var i = 0; i < candles.length; i++) out[i] = candles[i][key]; return out; }

  /* ============================== Indicators ============================== */
  // Each returns an array as long as its input, with null where there is not enough data yet.

  function nulls(n) { var a = new Array(n); for (var i = 0; i < n; i++) a[i] = null; return a; }

  function sma(v, n) {
    var out = nulls(v.length), sum = 0;
    for (var i = 0; i < v.length; i++) {
      sum += v[i];
      if (i >= n) sum -= v[i - n];
      if (i >= n - 1) out[i] = sum / n;
    }
    return out;
  }

  /** Exponential average seeded with a simple average; leading nulls are skipped. */
  function ema(v, n) {
    var out = nulls(v.length), k = 2 / (n + 1), start = 0, i;
    while (start < v.length && !num(v[start])) start++;
    if (v.length - start < n) return out;
    var prev = 0;
    for (i = start; i < start + n; i++) prev += v[i];
    prev /= n;
    out[start + n - 1] = prev;
    for (i = start + n; i < v.length; i++) { prev = v[i] * k + prev * (1 - k); out[i] = prev; }
    return out;
  }

  /** Wilder's RSI. */
  function rsi(v, n) {
    var out = nulls(v.length);
    if (v.length <= n) return out;
    var gain = 0, loss = 0, d, i;
    for (i = 1; i <= n; i++) { d = v[i] - v[i - 1]; if (d > 0) gain += d; else loss -= d; }
    gain /= n; loss /= n;
    var val = function () { return loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss); };
    out[n] = val();
    for (i = n + 1; i < v.length; i++) {
      d = v[i] - v[i - 1];
      gain = (gain * (n - 1) + (d > 0 ? d : 0)) / n;
      loss = (loss * (n - 1) + (d < 0 ? -d : 0)) / n;
      out[i] = val();
    }
    return out;
  }

  function trueRange(candles) {
    var out = new Array(candles.length);
    for (var i = 0; i < candles.length; i++) {
      var c = candles[i];
      if (i === 0) { out[i] = c.h - c.l; continue; }
      var pc = candles[i - 1].c;
      out[i] = Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc));
    }
    return out;
  }

  /** Wilder's average true range. */
  function atr(candles, n) {
    var tr = trueRange(candles), out = nulls(candles.length);
    if (candles.length < n) return out;
    var prev = 0, i;
    for (i = 0; i < n; i++) prev += tr[i];
    prev /= n;
    out[n - 1] = prev;
    for (i = n; i < candles.length; i++) { prev = (prev * (n - 1) + tr[i]) / n; out[i] = prev; }
    return out;
  }

  function macd(v, fast, slow, signal) {
    var f = ema(v, fast || 12), s = ema(v, slow || 26), line = nulls(v.length);
    for (var i = 0; i < v.length; i++) if (num(f[i]) && num(s[i])) line[i] = f[i] - s[i];
    var sig = ema(line, signal || 9), hist = nulls(v.length);
    for (var j = 0; j < v.length; j++) if (num(line[j]) && num(sig[j])) hist[j] = line[j] - sig[j];
    return { line: line, signal: sig, hist: hist };
  }

  /** Volume-weighted average price from bar `from` onwards (one session). */
  function vwap(candles, from) {
    var out = nulls(candles.length), pv = 0, vol = 0;
    for (var i = Math.max(0, from || 0); i < candles.length; i++) {
      var c = candles[i], typical = (c.h + c.l + c.c) / 3;
      pv += typical * (c.v || 0);
      vol += c.v || 0;
      out[i] = vol > 0 ? pv / vol : typical;
    }
    return out;
  }

  function stdev(v, n) {
    var out = nulls(v.length), m = sma(v, n);
    for (var i = n - 1; i < v.length; i++) {
      var s = 0;
      for (var j = i - n + 1; j <= i; j++) s += (v[j] - m[i]) * (v[j] - m[i]);
      out[i] = Math.sqrt(s / n);
    }
    return out;
  }

  /* ============================== Parameters ============================== */
  // Every threshold the strategies use. The engine copies these into the Config sheet
  // (with the same keys) so they can be changed without touching code.

  var PARAMS = [
    ['minRRIntraday', 1.5, 'Lowest reward-to-risk accepted for intraday signals'],
    ['minRROther', 2, 'Lowest reward-to-risk accepted for swing, medium and long signals'],
    ['minTradedValueCr', 10, 'Minimum 20-day average traded value in rupees crore (liquidity filter)'],
    ['regime.vixHigh', 20, 'India VIX at or above this makes the market regime High-volatility'],
    ['regime.vixJumpPct', 30, 'A VIX rise of this many percent in 5 days also counts as High-volatility'],
    ['regime.breadthBull', 50, 'Percent of Nifty 200 stocks above their 50-day average needed for Bull'],
    ['regime.breadthBear', 35, 'Below this percent of Nifty 200 stocks above their 50-day average, a weak Nifty is Bear'],
    ['intraday.atrStopMult', 1.5, 'Intraday stop distance in 5-minute ATRs'],
    ['intraday.maxRiskPct', 2.5, 'Largest intraday stop distance accepted, percent of price'],
    ['orb.minutes', 15, 'Length of the opening range in minutes (multiple of 5)'],
    ['orb.volMult', 1.5, 'Breakout bar volume needed, times the average of the previous 20 bars'],
    ['orb.maxChaseFrac', 0.5, 'Skip a breakout that closed further past the range than this share of the range height'],
    ['vwap.volMult', 1, 'Reclaim bar volume needed, times the average of the previous 20 bars'],
    ['emaCross.rsiMin', 50, 'Lowest 5-minute RSI(14) for an EMA 9/21 buy (a short needs 100 minus the max)'],
    ['emaCross.rsiMax', 70, 'Highest 5-minute RSI(14) for an EMA 9/21 buy (a short needs 100 minus the min)'],
    ['gap.minPct', 1, 'Smallest opening gap, percent, for gap-and-go or gap-fill'],
    ['gap.maxPct', 5, 'Largest opening gap, percent, for gap-and-go or gap-fill'],
    ['gap.windowMinutes', 75, 'Gap setups are only taken this many minutes after 09:15'],
    ['swing.holdDays', 10, 'Trading days a swing signal stays valid'],
    ['swing.maxRiskPct', 8, 'Largest swing stop distance accepted, percent of price'],
    ['swing.cooldownDays', 14, 'Calendar days before the same swing strategy may alert the same stock again'],
    ['breakout.baseBars', 20, 'Trading days in the base before a breakout'],
    ['breakout.maxBasePct', 12, 'Widest base accepted, percent from low to high'],
    ['breakout.volMult', 1.5, 'Breakout day volume needed, times the 20-day average'],
    ['pullback.touchPct', 1, 'How close the day\'s low must come to the 20-day EMA, percent'],
    ['rsi2.max', 10, 'RSI(2) must be below this for a dip buy'],
    ['medium.holdDays', 120, 'Trading days a medium-term signal stays valid'],
    ['medium.maxRiskPct', 15, 'Largest medium-term stop distance accepted, percent of price'],
    ['medium.cooldownDays', 30, 'Calendar days before the same medium-term strategy may alert the same stock again'],
    ['medium.rsTopPct', 20, 'Relative strength leaders must rank in the top this many percent of the universe'],
    ['trend.minAboveLowPct', 30, 'Trend template: price at least this many percent above the 52-week low'],
    ['trend.maxBelowHighPct', 25, 'Trend template: price at most this many percent below the 52-week high'],
    ['trend.minRsPct', 70, 'Trend template: relative-strength percentile needed'],
    ['nearHigh.withinPct', 3, 'Near 52-week high: close within this many percent of the high'],
    ['long.holdDays', 250, 'Trading days a long-term signal stays valid'],
    ['long.maxRiskPct', 25, 'Largest long-term stop distance accepted, percent of price'],
    ['long.cooldownDays', 90, 'Calendar days before the long-term strategy may alert the same stock again'],
    ['long.minScore', 70, 'Quality-value score needed (0–100)'],
    ['long.minCompletenessPct', 70, 'Share of fundamentals that must be known before a score counts, percent'],
    ['guard.atrMult', 3, 'Holding guard trailing stop: highest close of the lookback minus this many ATRs'],
    ['guard.lookback', 22, 'Holding guard trailing stop lookback, trading days'],
    ['guard.belowPct', 1, 'Holding guard: a close this many percent under the 200-day average counts as a break'],
    ['guard.cooldownDays', 5, 'Calendar days before the holding guard repeats the same warning'],
  ];

  function defaultParams() { var o = {}; PARAMS.forEach(function (p) { o[p[0]] = p[1]; }); return o; }

  /** Defaults overlaid with any values given (unknown keys are ignored, bad numbers fall back). */
  function params(overrides) {
    var o = defaultParams();
    if (overrides) Object.keys(o).forEach(function (k) {
      var v = Number(overrides[k]);
      if (overrides[k] !== undefined && overrides[k] !== '' && isFinite(v)) o[k] = v;
    });
    return o;
  }

  /* ============================== Strategies list ============================== */

  var BUY_UP = { BUY: ['BULL', 'NEUTRAL'] };
  // Intraday strategies may buy or short in any regime. The engine narrows this with your switches
  // (no buys on Bear days, no shorts on Bull days) and with the day's direction (see finalize).
  var INTRA = { BUY: ALL_REGIMES, SHORT: ALL_REGIMES };

  var STRATEGIES = [
    { id: 'orb', name: 'Opening-range breakout', horizon: 'INTRADAY', kind: 'intraday', regimes: INTRA },
    { id: 'vwap', name: 'VWAP reclaim', horizon: 'INTRADAY', kind: 'intraday', regimes: INTRA },
    { id: 'ema-cross', name: 'EMA 9/21 cross', horizon: 'INTRADAY', kind: 'intraday', regimes: INTRA },
    { id: 'gap', name: 'Gap and go / gap fill', horizon: 'INTRADAY', kind: 'intraday', regimes: INTRA },
    { id: 'base-breakout', name: 'Base breakout', horizon: 'SWING', kind: 'daily', regimes: BUY_UP },
    { id: 'ema-pullback', name: 'Pullback to 20 EMA', horizon: 'SWING', kind: 'daily', regimes: BUY_UP },
    { id: 'rsi2', name: 'RSI(2) dip in uptrend', horizon: 'SWING', kind: 'daily', regimes: BUY_UP },
    { id: 'macd', name: 'MACD trend cross', horizon: 'SWING', kind: 'daily', regimes: BUY_UP },
    { id: 'trend-template', name: 'Trend template', horizon: 'MEDIUM', kind: 'daily', regimes: BUY_UP },
    { id: 'rs-leaders', name: 'Relative strength leaders', horizon: 'MEDIUM', kind: 'daily', regimes: BUY_UP },
    { id: 'near-high', name: 'Near 52-week high', horizon: 'MEDIUM', kind: 'daily', regimes: BUY_UP },
    { id: 'quality-value', name: 'Quality-value score', horizon: 'LONG', kind: 'fundamental', regimes: { BUY: ALL_REGIMES } },
    { id: 'holding-guard', name: 'Holding guard', horizon: 'LONG', kind: 'holding', regimes: { EXIT: ALL_REGIMES } },
  ];
  var BY_ID = {};
  STRATEGIES.forEach(function (s) { BY_ID[s.id] = s; });

  function strategy(id) { return BY_ID[id] || null; }

  /* ============================== Market regime ============================== */

  /**
   * Bull / Neutral / Bear / High-volatility from Nifty 50 against its 50- and 200-day averages,
   * India VIX level and 5-day change, and breadth (percent of the universe above its 50-day average).
   */
  function regime(nifty, vix, breadthPct, P) {
    P = P || params();
    var out = { state: 'UNKNOWN', reasons: [], nifty: null, vix: null, breadthPct: num(breadthPct) ? round(breadthPct, 1) : null, asOf: null };
    if (!nifty || nifty.length < 200) { out.reasons.push('Not enough Nifty 50 history yet (need 200 trading days).'); return out; }
    var c = pluck(nifty, 'c'), i = c.length - 1;
    var s50 = sma(c, 50)[i], s200 = sma(c, 200)[i];
    out.nifty = { close: c[i], sma50: round(s50), sma200: round(s200) };
    out.asOf = nifty[i].t;
    var vNow = null, vJump = null;
    if (vix && vix.length >= 6) {
      vNow = vix[vix.length - 1].c;
      var v5 = vix[vix.length - 6].c;
      vJump = v5 > 0 ? (vNow / v5 - 1) * 100 : null;
      out.vix = { close: vNow, change5dPct: num(vJump) ? round(vJump, 1) : null };
    }
    var above200 = c[i] > s200, trendUp = s50 > s200;
    out.reasons.push('Nifty 50 at ' + inr(c[i]).replace('₹', '') + ' is ' + (above200 ? 'above' : 'below') + ' its 200-day average (' + inr(s200, 0).replace('₹', '') + ')' +
      ', and the 50-day average is ' + (trendUp ? 'above' : 'below') + ' the 200-day.');
    if (num(vNow)) out.reasons.push('India VIX ' + vNow.toFixed(2) + (num(vJump) ? ' (' + (vJump >= 0 ? '+' : '−') + Math.abs(vJump).toFixed(0) + '% in 5 days)' : '') + '.');
    else out.reasons.push('India VIX history is missing, so volatility was not checked.');
    if (num(breadthPct)) out.reasons.push(round(breadthPct, 0) + '% of Nifty 200 stocks are above their 50-day average.');
    out.state = regimeState(c[i], s50, s200, vNow, vJump, breadthPct, P);
    return out;
  }

  /** The regime rule itself, from one day's numbers (shared by regime() and the backtester's day-by-day context). */
  function regimeState(close, s50, s200, vNow, vJump, breadthPct, P) {
    var above200 = close > s200, trendUp = s50 > s200;
    if (num(vNow) && (vNow >= P['regime.vixHigh'] || (num(vJump) && vJump >= P['regime.vixJumpPct'] && vNow >= P['regime.vixHigh'] * 0.8))) return 'HIGH_VOL';
    if (above200 && trendUp && (!num(breadthPct) || breadthPct >= P['regime.breadthBull'])) return 'BULL';
    if (!above200 && (!trendUp || (num(breadthPct) && breadthPct < P['regime.breadthBear']))) return 'BEAR';
    return 'NEUTRAL';
  }

  /** Percent of the given candle series whose last close is above its 50-day average. */
  function breadth(seriesList) {
    var up = 0, n = 0;
    seriesList.forEach(function (candles) {
      if (!candles || candles.length < 50) return;
      var c = pluck(candles, 'c'), m = sma(c, 50), i = c.length - 1;
      n++;
      if (c[i] > m[i]) up++;
    });
    return n ? (up / n) * 100 : null;
  }

  var REGIME_NAMES = { BULL: 'Bull', NEUTRAL: 'Neutral', BEAR: 'Bear', HIGH_VOL: 'High volatility', UNKNOWN: 'Unknown' };
  function regimeName(state) { return REGIME_NAMES[state] || state; }

  /* ============================ Relative strength ============================ */

  /** Weighted 3/6/9/12-month return, minus the same for Nifty 50, `back` bars before the end. */
  function rsRaw(closes, niftyCloses, back) {
    return rsAt(closes, closes.length - 1 - back, niftyCloses, niftyCloses.length - 1 - back);
  }

  /** The same, at bar i of a stock's closes and bar j of Nifty 50's closes. Null without 252 bars of history. */
  function rsAt(closes, i, niftyCloses, j) {
    if (i < 252 || j < 252) return null;
    var r = function (a, k, n) { return a[k - n] > 0 ? a[k] / a[k - n] - 1 : 0; };
    var mine = 0.4 * r(closes, i, 63) + 0.2 * r(closes, i, 126) + 0.2 * r(closes, i, 189) + 0.2 * r(closes, i, 252);
    var mkt = 0.4 * r(niftyCloses, j, 63) + 0.2 * r(niftyCloses, j, 126) + 0.2 * r(niftyCloses, j, 189) + 0.2 * r(niftyCloses, j, 252);
    return mine - mkt;
  }

  /** Percentile rank (0–100, higher is stronger) for each symbol today and one session earlier. */
  function rsRanks(seriesBySymbol, nifty) {
    var nc = pluck(nifty || [], 'c');
    var rank = function (back) {
      var list = [];
      Object.keys(seriesBySymbol).forEach(function (sym) {
        var s = seriesBySymbol[sym];
        if (!s || s.length < 253) return;
        var v = rsRaw(pluck(s, 'c'), nc, back);
        if (num(v)) list.push({ sym: sym, v: v });
      });
      list.sort(function (a, b) { return a.v - b.v; });
      var out = {};
      list.forEach(function (x, k) { out[x.sym] = list.length > 1 ? (k / (list.length - 1)) * 100 : 50; });
      return out;
    };
    return { now: rank(0), prev: rank(1) };
  }

  /* ============================ Daily context ============================ */

  function Daily(candles) {
    this.k = candles;
    this.n = candles.length;
    this.o = pluck(candles, 'o'); this.h = pluck(candles, 'h'); this.l = pluck(candles, 'l');
    this.c = pluck(candles, 'c'); this.v = pluck(candles, 'v');
    this.memo = {};
  }
  Daily.prototype.get = function (key, make) { if (!(key in this.memo)) this.memo[key] = make.call(this); return this.memo[key]; };
  Daily.prototype.sma = function (n) { return this.get('sma' + n, function () { return sma(this.c, n); }); };
  Daily.prototype.ema = function (n) { return this.get('ema' + n, function () { return ema(this.c, n); }); };
  Daily.prototype.rsi = function (n) { return this.get('rsi' + n, function () { return rsi(this.c, n); }); };
  Daily.prototype.atr = function (n) { return this.get('atr' + n, function () { return atr(this.k, n); }); };
  Daily.prototype.macd = function () { return this.get('macd', function () { return macd(this.c, 12, 26, 9); }); };
  /** Average volume of the n bars before bar i. */
  Daily.prototype.avgVol = function (i, n) { return meanOf(this.v, i - n, i - 1); };
  /** Average traded value (close × volume) of the n bars ending at bar i, in rupees crore. */
  Daily.prototype.tradedValueCr = function (i, n) {
    var s = 0, k = 0;
    for (var j = Math.max(0, i - n + 1); j <= i; j++) { s += this.c[j] * (this.v[j] || 0); k++; }
    return k ? s / k / 1e7 : null;
  };

  /** Average traded value of the last 20 sessions in crore, or null. */
  function liquidityCr(candles) {
    if (!candles || candles.length < 5) return null;
    return new Daily(candles).tradedValueCr(candles.length - 1, 20);
  }

  /* ============================ Daily strategies ============================ */
  // Each returns a raw idea {direction, entry, entryLow, entryHigh, stop, target1, target2, score, reasons}
  // or null. A target set as a multiple of the risk is given as targetR: [2, 3] instead of target1/target2,
  // so it is worked out from the rounded entry and stop. The common checks happen in finalize().

  var DAILY = {};

  DAILY['base-breakout'] = function (x, i, P) {
    var B = Math.round(P['breakout.baseBars']);
    if (i < Math.max(60, B + 21)) return null;
    var H = maxOf(x.h, i - B, i - 1), L = minOf(x.l, i - B, i - 1), width = (H - L) / L * 100;
    var s50 = x.sma(50)[i], a = x.atr(14)[i], av = x.avgVol(i, 20);
    if (!(width <= P['breakout.maxBasePct']) || !num(s50) || !num(a) || !(av > 0)) return null;
    if (!(x.c[i] > H && x.c[i - 1] <= H)) return null;
    var vr = x.v[i] / av;
    if (vr < P['breakout.volMult'] || !(x.c[i] > s50)) return null;
    var c = x.c[i], height = H - L, s200 = x.sma(200)[i];
    var reasons = [
      'Closed at ' + inr(c) + ', above the ' + B + '-day base high of ' + inr(H) + '.',
      'The base was tight: ' + pct(width) + ' from low to high.',
      'Volume was ' + times(vr) + ' the 20-day average.',
    ];
    if (num(s200)) reasons.push('Price is ' + (c > s200 ? 'above' : 'below') + ' the 200-day average.');
    return {
      direction: 'BUY', entry: c, entryLow: Math.max(H, c - 0.5 * a), entryHigh: c + 0.25 * a,
      stop: Math.max(L, H - a), target1: c + height, target2: c + 2 * height,
      score: 55 + clamp((vr - P['breakout.volMult']) * 10, 0, 15) + clamp((P['breakout.maxBasePct'] - width) * 1.5, 0, 15) + (num(s200) && c > s200 ? 10 : 0),
      reasons: reasons,
    };
  };

  DAILY['ema-pullback'] = function (x, i, P) {
    if (i < 210) return null;
    var e20 = x.ema(20), e50 = x.ema(50), s50 = x.sma(50), s200 = x.sma(200), r = x.rsi(14)[i], a = x.atr(14)[i];
    if (![e20[i], e50[i], s50[i - 10], s200[i], r, a].every(num)) return null;
    var c = x.c[i];
    if (!(e20[i] > e50[i] && s50[i] > s50[i - 10] && c > s200[i])) return null;
    var touched = x.l[i] <= e20[i] * (1 + P['pullback.touchPct'] / 100);
    if (!(touched && x.l[i] >= e50[i] && c > e20[i] && c > x.o[i] && r >= 40 && r <= 65)) return null;
    var above = 0;
    for (var j = i - 10; j < i; j++) if (x.c[j] > e20[j]) above++;
    if (above < 5) return null;
    var high20 = maxOf(x.h, i - 20, i - 1), stop = Math.min(x.l[i], x.l[i - 1]) - 0.25 * a;
    return {
      direction: 'BUY', entry: c, entryLow: Math.max(e20[i], c - 0.4 * a), entryHigh: c + 0.2 * a,
      stop: stop, target1: high20, target2: c + 3 * (c - stop),
      score: 55 + (above >= 8 ? 10 : 0) + clamp((65 - r) / 2, 0, 10) + (c > s50[i] ? 10 : 0),
      reasons: [
        'Uptrend: the 20-day EMA is above the 50-day EMA and the 50-day average is rising.',
        'The day\'s low (' + inr(x.l[i]) + ') came back to the 20-day EMA (' + inr(e20[i]) + ') and the close held above it.',
        'Closed higher than it opened; RSI(14) is ' + r.toFixed(0) + '.',
        'Target is the recent 20-day high of ' + inr(high20) + '.',
      ],
    };
  };

  DAILY['rsi2'] = function (x, i, P) {
    if (i < 210) return null;
    var s200 = x.sma(200)[i], r2 = x.rsi(2)[i], a = x.atr(14)[i];
    if (![s200, r2, a].every(num)) return null;
    var c = x.c[i];
    if (!(c > s200 && r2 < P['rsi2.max'])) return null;
    var high10 = maxOf(x.h, i - 10, i - 1), stop = c - 1.5 * a;
    return {
      direction: 'BUY', entry: c, entryLow: c - 0.3 * a, entryHigh: c + 0.1 * a,
      stop: stop, target1: high10, target2: high10 + a,
      score: 50 + clamp((P['rsi2.max'] - r2) * 2, 0, 20) + clamp(((c / s200) - 1) * 100, 0, 15),
      reasons: [
        'Price is above its 200-day average (' + inr(s200) + '), so the long-term trend is up.',
        'RSI(2) fell to ' + r2.toFixed(1) + ', a short-term oversold dip.',
        'Target is the 10-day high of ' + inr(high10) + '.',
      ],
    };
  };

  DAILY['macd'] = function (x, i, P) {
    if (i < 210) return null;
    var m = x.macd(), s50 = x.sma(50)[i], s200 = x.sma(200)[i], a = x.atr(14)[i];
    if (![m.line[i], m.signal[i], m.line[i - 1], m.signal[i - 1], s50, s200, a].every(num)) return null;
    var c = x.c[i];
    if (!(m.line[i - 1] <= m.signal[i - 1] && m.line[i] > m.signal[i])) return null;
    if (!(c > s200 && s50 > s200)) return null;
    var stop = minOf(x.l, i - 9, i) - 0.25 * a;
    return {
      direction: 'BUY', entry: c, entryLow: c - 0.3 * a, entryHigh: c + 0.2 * a,
      stop: stop, targetR: [2, 3],
      score: 50 + (m.line[i] < 0 ? 10 : 0) + (c > s50 ? 10 : 0) + clamp((m.hist[i] / a) * 40, 0, 10),
      reasons: [
        'MACD crossed above its signal line' + (m.line[i] < 0 ? ' from below zero (an early turn).' : '.'),
        'Trend filter passed: price and the 50-day average are above the 200-day average.',
        'Stop under the 10-day low; target set at 2× the risk.',
      ],
    };
  };

  function trendTemplateOk(x, i, P, rs) {
    if (i < 252) return false;
    var c = x.c[i], s50 = x.sma(50)[i], s150 = x.sma(150)[i], s200 = x.sma(200), s200i = s200[i], s200p = s200[i - 21];
    if (![s50, s150, s200i, s200p].every(num)) return false;
    var hi = maxOf(x.h, i - 251, i), lo = minOf(x.l, i - 251, i);
    return c > s150 && c > s200i && s150 > s200i && s200i > s200p && s50 > s150 && c > s50 &&
      c >= lo * (1 + P['trend.minAboveLowPct'] / 100) && c >= hi * (1 - P['trend.maxBelowHighPct'] / 100) &&
      num(rs) && rs >= P['trend.minRsPct'];
  }

  function mediumStop(x, i, P) {
    var c = x.c[i], s50 = x.sma(50)[i], a = x.atr(14)[i];
    var floor = c * (1 - P['medium.maxRiskPct'] / 100);
    var s = num(s50) && s50 < c ? Math.max(floor, s50 - 0.5 * a) : c - 2.5 * a;
    if (!(s < c - 0.5 * a)) s = c - 2 * a; // keep the stop a sensible distance below price
    return s;
  }

  DAILY['trend-template'] = function (x, i, P, o) {
    if (!trendTemplateOk(x, i, P, o.rsPct)) return null;
    if (trendTemplateOk(x, i - 1, P, o.rsPrevPct)) return null; // only the day it first qualifies
    var c = x.c[i], stop = mediumStop(x, i, P), hi = maxOf(x.h, i - 251, i);
    return {
      direction: 'BUY', entry: c, entryLow: c - 0.5 * x.atr(14)[i], entryHigh: c * 1.01,
      stop: stop, targetR: [2, 3],
      score: 55 + clamp((o.rsPct - P['trend.minRsPct']) / 2, 0, 15) + clamp((1 - (hi - c) / hi * 4) * 15, 0, 15),
      reasons: [
        'Trend template met today: price above the 50-, 150- and 200-day averages, stacked in order, with the 200-day rising for a month.',
        'Price is ' + pct((c / hi - 1) * -100) + ' below its 52-week high.',
        'Relative strength ranks in the top ' + Math.max(1, Math.round(100 - o.rsPct)) + '% of the universe.',
      ],
    };
  };

  DAILY['rs-leaders'] = function (x, i, P, o) {
    var top = 100 - P['medium.rsTopPct'];
    if (!num(o.rsPct) || o.rsPct < top || (num(o.rsPrevPct) && o.rsPrevPct >= top)) return null;
    var s50 = x.sma(50)[i], s200 = x.sma(200)[i], c = x.c[i];
    if (!num(s50) || !num(s200) || !(c > s50 && s50 > s200)) return null;
    var stop = mediumStop(x, i, P);
    return {
      direction: 'BUY', entry: c, entryLow: c - 0.5 * x.atr(14)[i], entryHigh: c * 1.01,
      stop: stop, targetR: [2, 3],
      score: 55 + clamp((o.rsPct - top) * 1.5, 0, 20) + (c > x.sma(20)[i] ? 10 : 0),
      reasons: [
        'Entered the top ' + P['medium.rsTopPct'] + '% for relative strength against Nifty 50 today (rank ' + Math.round(o.rsPct) + ' of 100).',
        'Price is above the 50-day average, which is above the 200-day.',
      ],
    };
  };

  DAILY['near-high'] = function (x, i, P) {
    if (i < 253) return null;
    var w = P['nearHigh.withinPct'] / 100, hi = maxOf(x.h, i - 251, i), hiPrev = maxOf(x.h, i - 252, i - 1);
    var s50 = x.sma(50)[i], av = x.avgVol(i, 20), a = x.atr(14)[i], c = x.c[i];
    if (![s50, av, a].every(num)) return null;
    if (!(c >= hi * (1 - w) && x.c[i - 1] < hiPrev * (1 - w))) return null;
    if (!(c > s50 && x.v[i] >= av)) return null;
    var stop = Math.max(c * (1 - P['medium.maxRiskPct'] / 100), c - 2.5 * a);
    return {
      direction: 'BUY', entry: c, entryLow: c - 0.4 * a, entryHigh: c * 1.01,
      stop: stop, targetR: [2, 3],
      score: 55 + clamp((x.v[i] / av - 1) * 15, 0, 15) + (c >= hi ? 10 : 0),
      reasons: [
        'Closed within ' + P['nearHigh.withinPct'] + '% of the 52-week high of ' + inr(hi) + '.',
        'Volume ' + times(x.v[i] / av) + ' the 20-day average; price above the 50-day average.',
      ],
    };
  };

  /* ============================ Long-term: quality-value ============================ */

  var FUND_FIELDS = ['roePct', 'rocePct', 'debtToEquity', 'sales3yPct', 'profit3yPct', 'promoterPct', 'pledgePct', 'peVsMedian', 'fcf'];

  /** 0–100 score from whatever fundamentals are known, and how complete they are. Missing values are never guessed. */
  function qualityValue(f) {
    f = f || {};
    var lin = function (x, lo, hi) { return clamp((x - lo) / (hi - lo), 0, 1); };
    var parts = {};
    var val = function (k) { var v = f[k]; return v === '' || v === null || v === undefined ? null : Number(v); };
    var roe = val('roePct'), roce = val('rocePct'), de = val('debtToEquity'), s3 = val('sales3yPct'), p3 = val('profit3yPct');
    var prom = val('promoterPct'), pledge = val('pledgePct'), pe = val('pe'), pem = val('pe5yMedian'), fcf = val('fcf');
    if (num(roe)) parts.roePct = lin(roe, 5, 20);
    if (num(roce)) parts.rocePct = lin(roce, 8, 22);
    if (num(de)) parts.debtToEquity = 1 - lin(de, 0.1, 1.5);
    if (num(s3)) parts.sales3yPct = lin(s3, 0, 15);
    if (num(p3)) parts.profit3yPct = lin(p3, 0, 18);
    if (num(prom)) parts.promoterPct = lin(prom, 30, 65);
    if (num(pledge)) parts.pledgePct = 1 - lin(pledge, 0, 20);
    if (num(pe) && num(pem) && pe > 0 && pem > 0) parts.peVsMedian = 1 - lin(pe / pem, 0.8, 1.3);
    if (num(fcf)) parts.fcf = fcf > 0 ? 1 : 0;
    var keys = Object.keys(parts), sum = 0;
    keys.forEach(function (k) { sum += parts[k]; });
    return { score: keys.length ? round((sum / keys.length) * 100, 0) : null, completenessPct: round(keys.length / FUND_FIELDS.length * 100, 0), parts: parts };
  }

  DAILY['quality-value'] = function (x, i, P, o) {
    if (!o.fundamentals || i < 200) return null;
    var q = qualityValue(o.fundamentals), s200 = x.sma(200)[i], c = x.c[i];
    if (!num(q.score) || q.completenessPct < P['long.minCompletenessPct'] || q.score < P['long.minScore']) return null;
    if (!num(s200) || !(c > s200)) return null;
    var stop = Math.max(c * (1 - P['long.maxRiskPct'] / 100), s200 * 0.95);
    return {
      direction: 'BUY', entry: c, entryLow: c * 0.98, entryHigh: c * 1.02,
      stop: stop, targetR: [2, 3],
      score: clamp(q.score * 0.8 + q.completenessPct * 0.15, 0, 95),
      reasons: [
        'Quality-value score ' + q.score + ' of 100 from ' + q.completenessPct + '% complete fundamentals.',
        'Price is above its 200-day average, so the market agrees for now.',
        'Long-term idea: judged at 1, 3, 6 and 12 months against Nifty 50, not only by the target.',
      ],
      extra: { qualityScore: q.score, completenessPct: q.completenessPct },
    };
  };

  /* ============================ Holdings: exit warnings ============================ */

  DAILY['holding-guard'] = function (x, i, P, o) {
    if (!o.holding || i < 30) return null;
    var c = x.c[i], reasons = [], s200 = x.sma(200);
    var L = Math.round(P['guard.lookback']), a = x.atr(L);
    var gb = 1 - P['guard.belowPct'] / 100;
    if (num(s200[i]) && num(s200[i - 1]) && c < s200[i] * gb && x.c[i - 1] >= s200[i - 1] * gb) {
      reasons.push('Closed more than ' + P['guard.belowPct'] + '% below the 200-day average (' + inr(s200[i]) + ') today.');
    }
    if (num(a[i]) && num(a[i - 1]) && i > L + 1) {
      var ch = maxOf(x.c, i - L + 1, i) - P['guard.atrMult'] * a[i];
      var chPrev = maxOf(x.c, i - L, i - 1) - P['guard.atrMult'] * a[i - 1];
      if (c < ch && x.c[i - 1] >= chPrev) reasons.push('Fell through the trailing stop of ' + inr(ch) + ' (highest close of ' + L + ' days minus ' + P['guard.atrMult'] + ' ATR).');
    }
    // Your own levels for this holding (set in the app's Portfolio screen), on the day they are crossed.
    var myStop = Number(o.holding.stop), myTarget = Number(o.holding.target);
    if (myStop > 0 && c <= myStop && x.c[i - 1] > myStop) reasons.push('Closed at ' + inr(c) + ', at or below your stop-loss of ' + inr(myStop) + '.');
    if (myTarget > 0 && c >= myTarget && x.c[i - 1] < myTarget) reasons.push('Closed at ' + inr(c) + ', at or above your target of ' + inr(myTarget) + '. Consider booking some profit.');
    if (!reasons.length) return null;
    var avg = Number(o.holding.avgPrice);
    if (avg > 0) reasons.push('Against your average price of ' + inr(avg) + ' this holding is ' + (c >= avg ? 'up ' : 'down ') + pct(Math.abs(c / avg - 1) * 100) + '.');
    return { direction: 'EXIT', entry: c, entryLow: c, entryHigh: c, stop: null, target1: null, target2: null, score: 60 + (reasons.length > 2 ? 15 : 0), reasons: reasons };
  };

  /* ============================ Intraday context ============================ */

  function Intra(bars, nowMs) {
    this.k = bars;
    this.n = bars.length;
    this.o = pluck(bars, 'o'); this.h = pluck(bars, 'h'); this.l = pluck(bars, 'l');
    this.c = pluck(bars, 'c'); this.v = pluck(bars, 'v');
    var today = istDay(num(nowMs) ? nowMs : bars[bars.length - 1].t), i0 = bars.length;
    for (var j = 0; j < bars.length; j++) if (istDay(bars[j].t) === today) { i0 = j; break; }
    this.i0 = i0;
    this.today = bars.length - i0;
    this.e9 = ema(this.c, 9); this.e21 = ema(this.c, 21);
    this.r14 = rsi(this.c, 14); this.a14 = atr(bars, 14);
    this.vw = vwap(bars, i0);
  }
  Intra.prototype.minute = function (i) { return istMinute(this.k[i].t); };
  Intra.prototype.volRatio = function (i, n) { var m = meanOf(this.v, i - n, i - 1); return m > 0 ? this.v[i] / m : null; };

  var INTRADAY = {};

  INTRADAY['orb'] = function (x, i, P) {
    var k = Math.max(1, Math.round(P['orb.minutes'] / 5)), a = x.i0;
    if (x.today < k + 1 || i < 20 || x.minute(a) !== OPEN_MIN) return null;
    var H = maxOf(x.h, a, a + k - 1), L = minOf(x.l, a, a + k - 1), height = H - L, c = x.c[i], j;
    if (!(height > 0)) return null;
    var dir = null;
    if (c > H) { for (j = a + k; j < i; j++) if (x.c[j] > H) return null; dir = 'BUY'; }
    else if (c < L) { for (j = a + k; j < i; j++) if (x.c[j] < L) return null; dir = 'SHORT'; }
    else return null;
    var vr = x.volRatio(i, 20), at = x.a14[i];
    if (!num(vr) || vr < P['orb.volMult'] || !num(at)) return null;
    var chase = dir === 'BUY' ? c - H : L - c;
    if (chase > P['orb.maxChaseFrac'] * height) return null;
    var m = P['intraday.atrStopMult'], vw = x.vw[i], trendOk = dir === 'BUY' ? x.e9[i] > x.e21[i] : x.e9[i] < x.e21[i];
    var vwOk = dir === 'BUY' ? c > vw : c < vw;
    var label = Math.round(P['orb.minutes']) + '-minute';
    var idea = dir === 'BUY'
      ? { entry: c, entryLow: H, entryHigh: c, stop: Math.max(L, c - m * at), target1: H + height, target2: H + 2 * height }
      : { entry: c, entryLow: c, entryHigh: L, stop: Math.min(H, c + m * at), target1: L - height, target2: L - 2 * height };
    idea.direction = dir;
    idea.score = 50 + clamp((vr - P['orb.volMult']) * 12, 0, 20) + (trendOk ? 10 : 0) + (vwOk ? 10 : 0);
    idea.reasons = [
      'First close ' + (dir === 'BUY' ? 'above the ' + label + ' opening-range high of ' + inr(H) : 'below the ' + label + ' opening-range low of ' + inr(L)) + '.',
      'Breakout bar volume ' + times(vr) + ' the average of the previous 20 bars.',
      'Price is ' + (c > vw ? 'above' : 'below') + ' VWAP (' + inr(vw) + ')' + (trendOk ? ' and the 9 EMA leads the 21 EMA the same way.' : '.'),
      'Targets: the range height (' + inr(height) + ') projected once and twice.',
    ];
    return idea;
  };

  INTRADAY['vwap'] = function (x, i, P) {
    var a = x.i0;
    if (x.today < 4 || i < 20) return null;
    var vw = x.vw, c = x.c[i], at = x.a14[i], vr = x.volRatio(i, 20);
    if (![vw[i], vw[i - 1], at, vr].every(num) || i - 1 < a) return null;
    var dir = null, below = 0, above = 0;
    for (var j = Math.max(a, i - 4); j < i; j++) { if (x.c[j] < vw[j]) below++; else above++; }
    if (x.c[i - 1] < vw[i - 1] && c > vw[i] && c > x.o[i] && below >= 2) dir = 'BUY';
    else if (x.c[i - 1] > vw[i - 1] && c < vw[i] && c < x.o[i] && above >= 2) dir = 'SHORT';
    if (!dir || vr < P['vwap.volMult']) return null;
    var dayHigh = maxOf(x.h, a, i - 1), dayLow = minOf(x.l, a, i - 1), idea;
    if (dir === 'BUY') {
      var sb = Math.min(x.l[i], x.l[i - 1]) - 0.1 * at;
      idea = { entry: c, entryLow: vw[i], entryHigh: c, stop: sb, target1: dayHigh, target2: dayHigh + (dayHigh - c) };
    } else {
      var ss = Math.max(x.h[i], x.h[i - 1]) + 0.1 * at;
      idea = { entry: c, entryLow: c, entryHigh: vw[i], stop: ss, target1: dayLow, target2: dayLow - (c - dayLow) };
    }
    idea.direction = dir;
    idea.score = 50 + clamp((vr - 1) * 10, 0, 15) + ((dir === 'BUY') === (x.e9[i] > x.e21[i]) ? 10 : 0) + (x.today > 12 ? 5 : 0);
    idea.reasons = [
      (dir === 'BUY' ? 'Reclaimed VWAP (' + inr(vw[i]) + ') after trading below it, closing on a green bar.' : 'Rejected at VWAP (' + inr(vw[i]) + ') after trading above it, closing on a red bar.'),
      'Bar volume ' + times(vr) + ' the 20-bar average.',
      'Target is the day\'s ' + (dir === 'BUY' ? 'high of ' + inr(dayHigh) : 'low of ' + inr(dayLow)) + ' so far.',
    ];
    return idea;
  };

  INTRADAY['ema-cross'] = function (x, i, P) {
    if (x.today < 2 || i < 25) return null;
    var e9 = x.e9, e21 = x.e21, r = x.r14[i], at = x.a14[i], vw = x.vw[i], c = x.c[i];
    if (![e9[i], e9[i - 1], e21[i], e21[i - 1], r, at, vw].every(num)) return null;
    var dir = null;
    if (e9[i - 1] <= e21[i - 1] && e9[i] > e21[i] && r >= P['emaCross.rsiMin'] && r <= P['emaCross.rsiMax'] && c > vw) dir = 'BUY';
    else if (e9[i - 1] >= e21[i - 1] && e9[i] < e21[i] && r <= 100 - P['emaCross.rsiMin'] && r >= 100 - P['emaCross.rsiMax'] && c < vw) dir = 'SHORT';
    if (!dir) return null;
    var risk = P['intraday.atrStopMult'] * at, s = dir === 'BUY' ? 1 : -1;
    return {
      direction: dir, entry: c, entryLow: dir === 'BUY' ? c - 0.2 * at : c, entryHigh: dir === 'BUY' ? c : c + 0.2 * at,
      stop: c - s * risk, targetR: [2, 3],
      score: 50 + clamp(Math.abs(r - 50) / 2, 0, 10) + clamp((x.volRatio(i, 20) || 0) * 5, 0, 10),
      reasons: [
        'The 9-period EMA crossed ' + (dir === 'BUY' ? 'above' : 'below') + ' the 21-period EMA on 5-minute bars.',
        'RSI(14) at ' + r.toFixed(0) + ' confirms the move without being stretched.',
        'Price is ' + (dir === 'BUY' ? 'above' : 'below') + ' VWAP (' + inr(vw) + '). Target set at 2× the risk.',
      ],
    };
  };

  INTRADAY['gap'] = function (x, i, P, o) {
    var a = x.i0, pc = o.prevClose;
    if (!num(pc) || pc <= 0 || x.today < 2 || x.minute(a) !== OPEN_MIN) return null;
    if (x.minute(i) + 5 > OPEN_MIN + P['gap.windowMinutes']) return null;
    var open = x.o[a], gap = (open / pc - 1) * 100, size = Math.abs(gap);
    if (size < P['gap.minPct'] || size > P['gap.maxPct']) return null;
    var c = x.c[i], hiPrev = maxOf(x.h, a, i - 1), loPrev = minOf(x.l, a, i - 1), first = x.k[a];
    var firstGreen = first.c > first.o, at = x.a14[i] || (first.h - first.l), idea = null;
    var firstBreak = function (above) {
      for (var j = a + 1; j < i; j++) {
        if (above && x.c[j] > maxOf(x.h, a, j - 1)) return false;
        if (!above && x.c[j] < minOf(x.l, a, j - 1)) return false;
      }
      return true;
    };
    if (gap > 0 && firstGreen && c > hiPrev && firstBreak(true) && loPrev > pc) {
      var s1 = loPrev - 0.1 * at;
      idea = { direction: 'BUY', entry: c, entryLow: hiPrev, entryHigh: c, stop: s1, targetR: [2, 3], kind: 'go' };
    } else if (gap < 0 && !firstGreen && c < loPrev && firstBreak(false) && hiPrev < pc) {
      var s2 = hiPrev + 0.1 * at;
      idea = { direction: 'SHORT', entry: c, entryLow: c, entryHigh: loPrev, stop: s2, targetR: [2, 3], kind: 'go' };
    } else if (gap > 0 && !firstGreen && c < loPrev && firstBreak(false)) {
      idea = { direction: 'SHORT', entry: c, entryLow: c, entryHigh: loPrev, stop: hiPrev + 0.1 * at, target1: pc, target2: pc - 0.5 * (hiPrev - pc), kind: 'fill' };
    } else if (gap < 0 && firstGreen && c > hiPrev && firstBreak(true)) {
      idea = { direction: 'BUY', entry: c, entryLow: hiPrev, entryHigh: c, stop: loPrev - 0.1 * at, target1: pc, target2: pc + 0.5 * (pc - loPrev), kind: 'fill' };
    }
    if (!idea) return null;
    var vr = x.volRatio(i, Math.min(20, i)) || 1;
    idea.score = 50 + clamp(size * 5, 0, 15) + clamp((vr - 1) * 10, 0, 15);
    idea.reasons = [
      'Opened ' + (gap > 0 ? 'up ' : 'down ') + pct(size) + ' from the previous close of ' + inr(pc) + '.',
      idea.kind === 'go'
        ? 'Gap and go: the first bar ' + (gap > 0 ? 'was green and price broke the morning high' : 'was red and price broke the morning low') + ' without filling the gap.'
        : 'Gap fill: the first bar went against the gap and price broke the morning ' + (gap > 0 ? 'low' : 'high') + '; target is the previous close.',
    ];
    delete idea.kind;
    return idea;
  };

  /* ============================ Checks, rounding, confidence ============================ */

  function horizonKey(h) { return h === 'INTRADAY' ? 'intraday' : h === 'SWING' ? 'swing' : h === 'MEDIUM' ? 'medium' : 'long'; }

  /**
   * Nifty 50's direction since today's open, as of the close of the 5-minute bar starting at t.
   * niftyBars: Nifty 50 5-minute candles (today's must start at 09:15). Returns {dir: 'UP'|'DOWN'|'FLAT',
   * open, close, pct}, or null when today's Nifty bars are missing.
   */
  function dayDirection(niftyBars, t) {
    if (!niftyBars || !niftyBars.length || !num(t)) return null;
    var day = istDay(t), open = null, close = null;
    for (var i = 0; i < niftyBars.length; i++) {
      var b = niftyBars[i];
      if (istDay(b.t) !== day) continue;
      if (b.t > t) break;
      if (open === null) { if (istMinute(b.t) !== OPEN_MIN) return null; open = b.o; }
      close = b.c;
    }
    if (!(open > 0) || !num(close)) return null;
    return { dir: close > open ? 'UP' : close < open ? 'DOWN' : 'FLAT', open: open, close: close, pct: round((close / open - 1) * 100, 2) };
  }

  /** "Nifty 50 is up 0.42% since the open." */
  function dayLine(day) {
    return 'Nifty 50 is ' + (day.dir === 'FLAT' ? 'flat' : (day.dir === 'UP' ? 'up ' : 'down ') + Math.abs(day.pct).toFixed(2) + '%') + ' since the open (' +
      inr(day.open).replace('₹', '') + ' → ' + inr(day.close).replace('₹', '') + ').';
  }

  /**
   * Round levels to the tick, work out reward-to-risk and apply the checks every signal must pass.
   * Returns {signal}, or {rejected: 'reason'}. A signal that passes every check except the market filters
   * also comes back as {rejected, shadow: signal}, so it can be paper-tracked silently to test those filters.
   * The market filters, in order:
   *   - the regimes the strategy may fire in
   *   - o.block: your switches, e.g. {BUY: ['BEAR'], SHORT: ['BULL']} for no intraday buys on Bear days
   *   - o.day: the day's direction from dayDirection(); a buy needs Nifty 50 above today's open, a short below
   * A blocked signal carries `blocked`, a short plain-English reason.
   */
  function finalize(raw, st, P, o) {
    var dir = raw.direction, isExit = dir === 'EXIT', regimeState = (o.regime && o.regime.state) || 'UNKNOWN';
    var allowed = (st.regimes && st.regimes[dir]) || [];
    var regimeOk = allowed.indexOf(regimeState) >= 0;
    var regimeWhy = 'regime ' + regimeName(regimeState) + ' does not allow ' + dir;
    var blocked = regimeOk ? '' : 'blocked by the ' + regimeName(regimeState) + ' regime';
    if (!blocked && o.block && o.block[dir] && o.block[dir].indexOf(regimeState) >= 0) {
      blocked = 'blocked by your setting: no intraday ' + (dir === 'SHORT' ? 'shorts' : 'buys') + ' on ' + regimeName(regimeState) + ' days';
    }
    if (!blocked && o.day && ((dir === 'BUY' && o.day.dir === 'DOWN') || (dir === 'SHORT' && o.day.dir === 'UP'))) {
      blocked = 'against the day: Nifty 50 is ' + (o.day.dir === 'UP' ? 'up ' : 'down ') + Math.abs(o.day.pct).toFixed(2) + '% since the open';
    }
    var sig = {
      strategy: st.id, strategyName: st.name, horizon: st.horizon, direction: dir,
      entry: tickRound(raw.entry), entryLow: tickRound(Math.min(raw.entryLow, raw.entryHigh), 'down'), entryHigh: tickRound(Math.max(raw.entryLow, raw.entryHigh), 'up'),
      stop: null, target1: null, target2: null, rr: null, riskPct: null,
      ruleScore: Math.round(clamp(raw.score || 50, 0, 100)), reasons: raw.reasons || [], extra: raw.extra || null,
      tradedValueCr: num(o.tradedValueCr) ? round(o.tradedValueCr, 1) : null,
    };
    if (isExit) { sig.confidence = sig.ruleScore; return regimeOk ? { signal: sig } : { rejected: regimeWhy }; }
    var buy = dir === 'BUY';
    sig.stop = tickRound(raw.stop, buy ? 'down' : 'up');
    // The entry range must end well before the stop-loss: at most half the risk from the entry on the stop's
    // side. Otherwise (a breakout bar that closed far past its level) a fill at the far edge would sit next to,
    // or even beyond, the stop.
    var risk0 = buy ? sig.entry - sig.stop : sig.stop - sig.entry;
    if (risk0 > 0) {
      if (buy) sig.entryLow = Math.min(sig.entry, Math.max(sig.entryLow, tickRound(sig.entry - 0.5 * risk0, 'up')));
      else sig.entryHigh = Math.max(sig.entry, Math.min(sig.entryHigh, tickRound(sig.entry + 0.5 * risk0, 'down')));
    }
    if (raw.targetR) {
      // Multiples of the rounded risk, rounded away from the entry so 2× really is at least 2×.
      var rk = buy ? sig.entry - sig.stop : sig.stop - sig.entry;
      sig.target1 = tickRound(sig.entry + (buy ? 1 : -1) * raw.targetR[0] * rk, buy ? 'up' : 'down');
      sig.target2 = raw.targetR[1] ? tickRound(sig.entry + (buy ? 1 : -1) * raw.targetR[1] * rk, buy ? 'up' : 'down') : null;
    } else {
      // Targets from chart levels are rounded towards the entry, so they are never promised beyond the level.
      sig.target1 = tickRound(raw.target1, buy ? 'down' : 'up');
      sig.target2 = num(raw.target2) ? tickRound(raw.target2, buy ? 'down' : 'up') : null;
    }
    if (sig.target2 !== null && (buy ? sig.target2 <= sig.target1 : sig.target2 >= sig.target1)) sig.target2 = null;
    var risk = buy ? sig.entry - sig.stop : sig.stop - sig.entry, reward = buy ? sig.target1 - sig.entry : sig.entry - sig.target1;
    if (!(risk > 0)) return { rejected: 'stop is not on the right side of the entry' };
    if (!(reward > 0)) return { rejected: 'target is not beyond the entry' };
    sig.rr = round(reward / risk, 2);
    sig.riskPct = round(risk / sig.entry * 100, 2);
    var hk = horizonKey(st.horizon);
    if (sig.riskPct > P[hk + '.maxRiskPct']) return { rejected: 'stop is ' + sig.riskPct + '% away, above the ' + P[hk + '.maxRiskPct'] + '% limit' };
    var minRR = st.horizon === 'INTRADAY' ? P.minRRIntraday : P.minRROther;
    if (sig.rr < minRR) return { rejected: 'reward-to-risk ' + sig.rr + ' is below ' + minRR };
    if (!num(o.tradedValueCr)) return { rejected: 'no volume history for the liquidity check' };
    if (o.tradedValueCr < P.minTradedValueCr) return { rejected: 'average traded value ₹' + round(o.tradedValueCr, 1) + ' crore is below ₹' + P.minTradedValueCr + ' crore' };
    sig.confidence = confidence(sig.ruleScore, o.track);
    if (blocked) {
      if (regimeState === 'UNKNOWN') return { rejected: regimeWhy };
      sig.blocked = blocked;
      return { rejected: regimeOk ? blocked : regimeWhy, shadow: sig };
    }
    return { signal: sig };
  }

  /**
   * Confidence 0–100: the rule strength, blended with the strategy's own paper record once it has one.
   * track: {trades, winRatePct, profitFactor} or null. The record counts for up to half, reached at 30 trades.
   */
  function confidence(ruleScore, track) {
    var rule = clamp(ruleScore, 0, 100);
    if (!track || !(track.trades > 0)) return Math.round(rule);
    var pf = num(track.profitFactor) ? track.profitFactor : 1;
    var record = clamp((num(track.winRatePct) ? track.winRatePct : 50) * 0.6 + clamp((pf - 0.5) * 40, 0, 40), 0, 100);
    var w = Math.min(track.trades, 30) / 30 * 0.5;
    return Math.round(rule * (1 - w) + record * w);
  }

  /* ============================ Scans ============================ */

  function wanted(list, kinds) {
    return STRATEGIES.filter(function (s) {
      return kinds.indexOf(s.kind) >= 0 && (!list || list.indexOf(s.id) >= 0);
    });
  }

  /**
   * Daily strategies on one stock's daily candles; the last candle is the session just closed.
   * opts: {params, regime, strategies: [ids], rsPct, rsPrevPct, fundamentals, holding, tracks: {id: track}}
   * Returns {signals: [...], rejected: [{strategy, why}]}.
   */
  function scanDaily(symbol, candles, opts) {
    opts = opts || {};
    var P = opts.params || params(), out = { signals: [], shadow: [], rejected: [] };
    if (!candles || candles.length < 30) return out;
    var x = new Daily(candles), i = x.n - 1;
    var tv = x.tradedValueCr(i, 20);
    wanted(opts.strategies, ['daily', 'fundamental', 'holding']).forEach(function (st) {
      if (st.kind === 'holding' && !opts.holding) return;
      if (st.kind === 'fundamental' && !opts.fundamentals) return;
      var raw = null;
      try { raw = DAILY[st.id](x, i, P, opts); } catch (e) { out.rejected.push({ strategy: st.id, why: 'error: ' + e.message }); return; }
      if (!raw) return;
      var f = finalize(raw, st, P, { regime: opts.regime, tradedValueCr: tv, track: opts.tracks && opts.tracks[st.id] });
      if (f.signal) { f.signal.symbol = symbol; f.signal.barTime = candles[i].t; out.signals.push(f.signal); }
      else out.rejected.push({ strategy: st.id, why: f.rejected });
      if (f.shadow) { f.shadow.symbol = symbol; f.shadow.barTime = candles[i].t; f.shadow.shadow = true; out.shadow.push(f.shadow); }
    });
    return out;
  }

  /**
   * Intraday strategies on 5-minute bars (yesterday's and today's, completed bars only).
   * opts: {params, regime, strategies, prevClose, tradedValueCr, nowMs, lastEntryMinute, tracks,
   *        niftyBars (Nifty 50 5-minute bars, for the day's direction), followNifty (true: buy only while
   *        Nifty 50 is above today's open, short only below), block ({BUY: [regimes], SHORT: [regimes]})}
   */
  function scanIntraday(symbol, bars, opts) {
    opts = opts || {};
    var P = opts.params || params(), out = { signals: [], shadow: [], rejected: [] };
    if (!bars || bars.length < 25) return out;
    var x = new Intra(bars, opts.nowMs), i = x.n - 1;
    if (x.today < 1 || i < x.i0) return out;
    var endMin = x.minute(i) + 5;
    if (num(opts.lastEntryMinute) && endMin > opts.lastEntryMinute) return out;
    var day = opts.niftyBars ? dayDirection(opts.niftyBars, bars[i].t) : null;
    wanted(opts.strategies, ['intraday']).forEach(function (st) {
      var raw = null;
      try { raw = INTRADAY[st.id](x, i, P, opts); } catch (e) { out.rejected.push({ strategy: st.id, why: 'error: ' + e.message }); return; }
      if (!raw) return;
      var f = finalize(raw, st, P, { regime: opts.regime, tradedValueCr: opts.tradedValueCr, track: opts.tracks && opts.tracks[st.id], block: opts.block, day: opts.followNifty ? day : null });
      var s = f.signal || f.shadow;
      if (s) { s.symbol = symbol; s.barTime = bars[i].t; s.barEnd = hhmm(endMin); if (day) s.reasons = s.reasons.concat([dayLine(day)]); }
      if (f.signal) out.signals.push(f.signal);
      else out.rejected.push({ strategy: st.id, why: f.rejected });
      if (f.shadow) { f.shadow.shadow = true; out.shadow.push(f.shadow); }
    });
    return out;
  }

  /* ============================ Position size and charges ============================ */

  /** Shares to buy so a stop-out loses capital × risk%, capped at maxPerStock% of capital. */
  function positionSize(capital, riskPct, entry, stop, maxPerStockPct) {
    var risk = Math.abs(entry - stop);
    if (!(capital > 0) || !(entry > 0) || !(risk > 0)) return { qty: 0, riskAmount: 0, value: 0, capped: false };
    var byRisk = Math.floor((capital * riskPct / 100) / risk);
    var byCap = Math.floor((capital * (maxPerStockPct || 100) / 100) / entry);
    var qty = Math.max(0, Math.min(byRisk, byCap));
    return { qty: qty, riskAmount: round(qty * risk), value: round(qty * entry), capped: byCap < byRisk };
  }

  /**
   * Estimated Zerodha charges for one round trip. rates use the Config keys without the "charge" prefix:
   * {brokerageIntradayPct, brokerageIntradayMax, sttDeliveryPct, sttIntradaySellPct, txnPct, sebiPerCrore,
   *  stampDeliveryPct, stampIntradayPct, gstPct, dpPerSell}
   */
  function charges(buyValue, sellValue, intraday, rates) {
    var r = rates || {};
    var g = function (k, d) { var v = Number(r[k]); return isFinite(v) && r[k] !== '' && r[k] !== undefined ? v : d; };
    var turnover = buyValue + sellValue, brokerage = 0, stt, stamp, dp = 0;
    if (intraday) {
      var perOrder = function (v) { return v > 0 ? Math.min(v * g('brokerageIntradayPct', 0.03) / 100, g('brokerageIntradayMax', 20)) : 0; };
      brokerage = perOrder(buyValue) + perOrder(sellValue);
      stt = sellValue * g('sttIntradaySellPct', 0.025) / 100;
      stamp = buyValue * g('stampIntradayPct', 0.003) / 100;
    } else {
      stt = turnover * g('sttDeliveryPct', 0.1) / 100;
      stamp = buyValue * g('stampDeliveryPct', 0.015) / 100;
      dp = sellValue > 0 ? g('dpPerSell', 15.34) : 0;
    }
    var txn = turnover * g('txnPct', 0.00307) / 100;
    var sebi = turnover / 1e7 * g('sebiPerCrore', 10);
    var gst = (brokerage + txn + sebi) * g('gstPct', 18) / 100;
    var total = brokerage + stt + stamp + txn + sebi + gst + dp;
    return { brokerage: round(brokerage), stt: round(stt), stamp: round(stamp), txn: round(txn), sebi: round(sebi), gst: round(gst), dp: round(dp), total: round(total) };
  }

  /* ============================ Evaluation ============================ */

  /**
   * Follow one alert through the candles after it, the way a paper trade would go.
   *   alert: {direction: 'BUY'|'SHORT', entryLow, entryHigh, stop, target}
   *   candles: oldest first, only those after the alert (1-minute bars for intraday, daily bars otherwise)
   *   opts: {expiryMs, nowMs, barMs} — a candle counts while t + barMs <= expiryMs (barMs 60000 for
   *         1-minute bars, 0 for daily bars, so the expiry day itself counts)
   * Rules, the same for every horizon:
   *   - Entry like a limit order: the first candle that trades into the entry range or better. If it opens
   *     inside or better, the fill is the open; otherwise the edge of the range. Opening beyond the stop
   *     before any entry means the setup failed: NOT_TRIGGERED.
   *   - After entry: a gap through the stop or target exits at the open. If one candle touches both
   *     the stop and the target, the stop is assumed to have come first. In the entry candle, the target
   *     only counts if the fill was at the open.
   *   - Still open at expiry: EXPIRED at the last close before the expiry. Never filled by then: NOT_TRIGGERED.
   * Returns {state: 'OPEN'|'ACTIVE'|'CLOSED', outcome, fillT, fillPrice, exitT, exitPrice, lastT, lastPrice, pct, bars, note}.
   * pct is the gross move in the trade's favour, in percent.
   */
  function simulateTrade(a, candles, opts) {
    opts = opts || {};
    var buy = a.direction !== 'SHORT', exp = opts.expiryMs, barMs = opts.barMs || 0;
    var out = { state: 'OPEN', outcome: '', fillT: null, fillPrice: null, exitT: null, exitPrice: null, lastT: null, lastPrice: null, pct: null, bars: 0, note: '' };
    var move = function (from, to) { return buy ? (to / from - 1) * 100 : (from - to) / from * 100; };
    var fillIndex = -1, k, c;
    var close = function (outcome, price, cc, idx) {
      out.state = 'CLOSED'; out.outcome = outcome; out.exitT = cc.t; out.exitPrice = price;
      out.pct = round(move(out.fillPrice, price), 3); out.bars = idx - fillIndex;
      return out;
    };
    for (k = 0; k < (candles || []).length; k++) {
      c = candles[k];
      if (num(exp) && c.t + barMs > exp) break;
      out.lastT = c.t; out.lastPrice = c.c;
      if (fillIndex < 0) {
        var touched = buy ? c.l <= a.entryHigh : c.h >= a.entryLow;
        if (!touched) continue;
        var atOpen = buy ? c.o <= a.entryHigh : c.o >= a.entryLow;
        var fill = atOpen ? c.o : (buy ? a.entryHigh : a.entryLow);
        if (buy ? fill <= a.stop : fill >= a.stop) {
          out.state = 'CLOSED'; out.outcome = 'NOT_TRIGGERED'; out.note = 'Opened beyond the stop before an entry was possible.';
          return out;
        }
        fillIndex = k; out.state = 'ACTIVE'; out.fillT = c.t; out.fillPrice = fill;
        if (buy ? c.l <= a.stop : c.h >= a.stop) return close('STOP_HIT', a.stop, c, k);
        if (atOpen && (buy ? c.h >= a.target : c.l <= a.target)) return close('TARGET_HIT', a.target, c, k);
        continue;
      }
      if (buy ? c.o <= a.stop : c.o >= a.stop) return close('STOP_HIT', c.o, c, k);
      if (buy ? c.o >= a.target : c.o <= a.target) return close('TARGET_HIT', c.o, c, k);
      if (buy ? c.l <= a.stop : c.h >= a.stop) return close('STOP_HIT', a.stop, c, k);
      if (buy ? c.h >= a.target : c.l <= a.target) return close('TARGET_HIT', a.target, c, k);
    }
    var ended = num(exp) && num(opts.nowMs) && opts.nowMs >= exp;
    if (fillIndex < 0) {
      if (ended) { out.state = 'CLOSED'; out.outcome = 'NOT_TRIGGERED'; out.note = 'The price never came into the entry range before the alert expired.'; }
      return out;
    }
    if (ended) return close('EXPIRED', out.lastPrice, { t: out.lastT }, k - 1);
    out.pct = round(move(out.fillPrice, out.lastPrice), 3);
    out.bars = (k - 1) - fillIndex;
    return out;
  }

  /** Rupee result of a paper trade after estimated Zerodha charges. */
  function tradeResult(direction, qty, fill, exit, intraday, rates) {
    if (!(qty > 0) || !(fill > 0) || !(exit > 0)) return { grossPnl: 0, charges: 0, netPnl: 0, netPct: null };
    var buyValue = qty * (direction === 'SHORT' ? exit : fill), sellValue = qty * (direction === 'SHORT' ? fill : exit);
    var gross = sellValue - buyValue, ch = charges(buyValue, sellValue, intraday, rates).total, net = gross - ch;
    return { grossPnl: round(gross), charges: round(ch), netPnl: round(net), netPct: round(net / (qty * fill) * 100, 3) };
  }

  /**
   * The paper result of a simulated trade (from simulateTrade), the same way for the live record and the backtester.
   * sizing: {capital, riskPct, maxPer, fractional}. The quantity comes from positionSize(); with fractional (backtests)
   * it is not rounded down to whole shares, so expensive stocks still get a rupee result. Percent results use at least
   * one share, so a stock too pricey for the virtual account still counts in the stats.
   * Returns {qty, netPct, grossPnl, charges, netPnl, mark, unrealised, holdDays}; netPct and the rupee fields are null
   * until the trade is closed (an open trade gets mark and unrealised instead).
   */
  function paperResult(direction, stop, s, sizing, rates, intraday) {
    var out = { qty: 0, netPct: null, grossPnl: null, charges: null, netPnl: null, mark: null, unrealised: null, holdDays: null };
    if (!s || s.fillPrice === null || s.fillPrice === undefined) return out;
    var qty = positionSize(sizing.capital, sizing.riskPct, s.fillPrice, stop, sizing.maxPer).qty;
    if (sizing.fractional) {
      var risk = Math.abs(s.fillPrice - stop);
      qty = risk > 0 ? Math.min(sizing.capital * sizing.riskPct / 100 / risk, sizing.capital * (sizing.maxPer || 100) / 100 / s.fillPrice) : 0;
      qty = Math.max(0, Math.floor(qty * 1000) / 1000);
    }
    out.qty = qty;
    var closed = s.state === 'CLOSED', price = closed ? s.exitPrice : s.lastPrice;
    if (!closed) {
      if (qty > 0 && price > 0) { out.mark = price; out.unrealised = tradeResult(direction, qty, s.fillPrice, price, intraday, rates).netPnl; }
      return out;
    }
    out.netPct = tradeResult(direction, Math.max(qty, sizing.fractional ? qty : 1), s.fillPrice, price, intraday, rates).netPct;
    if (qty > 0) {
      var real = tradeResult(direction, qty, s.fillPrice, s.exitPrice, intraday, rates);
      out.grossPnl = real.grossPnl; out.charges = real.charges; out.netPnl = real.netPnl;
    }
    out.holdDays = intraday ? round((s.exitT - s.fillT) / 60000 / 375, 3) : s.bars;
    return out;
  }

  /** Nifty 50's move in percent between two moments, from its bars of that session: last close before fromT to last close at toT. */
  function niftyMove(bars, fromT, toT) {
    if (!bars || !bars.length || !num(fromT) || !num(toT)) return null;
    var before = null, end = null;
    for (var i = 0; i < bars.length; i++) {
      if (bars[i].t < fromT) before = bars[i].c;
      if (bars[i].t <= toT) end = bars[i].c;
    }
    if (before === null) before = bars[0].o;
    return before > 0 && end !== null ? (end / before - 1) * 100 : null;
  }

  /** Calendar days before the same strategy may alert the same stock again (daily strategies). */
  function cooldownDays(strategyId, horizon, P) {
    return strategyId === 'holding-guard' ? P['guard.cooldownDays'] : horizon === 'SWING' ? P['swing.cooldownDays'] : horizon === 'MEDIUM' ? P['medium.cooldownDays'] : P['long.cooldownDays'];
  }

  /** Trading days a signal of this horizon stays valid (intraday: the same session). */
  function holdDaysFor(horizon, P) {
    return horizon === 'INTRADAY' ? 0 : Math.max(1, Math.round(P[horizonKey(horizon) + '.holdDays']));
  }

  /**
   * Strategy metrics from closed trades [{netPct, netPnl?, exitT, dayT?, holdDays?, alphaPct?}], in exit order.
   * Drawdown is on an equity curve that starts at `capital` (rupee results when every trade has one,
   * otherwise percent results compounded). Profit factor is null while there are no losses.
   * days counts the different trading days the trades were signalled on (dayT, else exitT): trades from
   * one day share one market move, so they are weaker evidence than the same number spread over many days.
   */
  function metrics(trades, opts) {
    opts = opts || {};
    var cap = opts.capital > 0 ? opts.capital : 100000;
    var list = (trades || []).filter(function (x) { return num(x.netPct); }).slice().sort(function (a, b) { return (a.exitT || 0) - (b.exitT || 0); });
    var money = list.length > 0 && list.every(function (x) { return num(x.netPnl); });
    var n = list.length, wins = 0, losses = 0, flats = 0, sumW = 0, sumL = 0, gp = 0, gl = 0, sum = 0;
    var hold = 0, nHold = 0, alpha = 0, nAlpha = 0, eq = cap, peak = cap, maxDD = 0, total = 0, seen = {}, days = 0;
    list.forEach(function (x) {
      var dt = num(x.dayT) ? x.dayT : x.exitT;
      if (num(dt) && !seen[istDay(dt)]) { seen[istDay(dt)] = true; days++; }
      sum += x.netPct;
      if (x.netPct > 0) { wins++; sumW += x.netPct; } else if (x.netPct < 0) { losses++; sumL += x.netPct; } else flats++;
      var v = money ? x.netPnl : x.netPct;
      if (v > 0) gp += v; else gl -= v;
      if (money) { total += x.netPnl; eq += x.netPnl; } else eq *= 1 + x.netPct / 100;
      if (eq > peak) peak = eq;
      var dd = peak > 0 ? (peak - eq) / peak * 100 : 0;
      if (dd > maxDD) maxDD = dd;
      if (num(x.holdDays)) { hold += x.holdDays; nHold++; }
      if (num(x.alphaPct)) { alpha += x.alphaPct; nAlpha++; }
    });
    return {
      trades: n, days: days, wins: wins, losses: losses, flats: flats,
      winRatePct: n ? round(wins / n * 100, 1) : null,
      avgWinPct: wins ? round(sumW / wins, 2) : null,
      avgLossPct: losses ? round(sumL / losses, 2) : null,
      expectancyPct: n ? round(sum / n, 3) : null,
      profitFactor: gl > 0 ? round(gp / gl, 2) : null,
      maxDrawdownPct: n ? round(maxDD, 2) : null,
      avgHoldDays: nHold ? round(hold / nHold, 2) : null,
      avgAlphaPct: nAlpha ? round(alpha / nAlpha, 2) : null,
      totalNetPnl: money ? round(total) : null,
      returnPct: n ? round((eq / cap - 1) * 100, 2) : null,
    };
  }

  /**
   * Live-ready, Rejected or still Paper, from a strategy's metrics.
   * rules: {minTrades, minDays, minPF, maxDrawdownPct}
   *   Both decisions need at least minTrades closed trades, spread over at least minDays different trading days.
   *   LIVE_READY: average net result above zero after charges, profit factor at least minPF, drawdown within
   *               the limit, and beating Nifty 50 over the same holding periods (average alpha above zero).
   *   REJECTED:   an average net result below zero.
   */
  function graduate(m, rules) {
    var need = rules.minTrades, needDays = rules.minDays || 0, days = m && num(m.days) ? m.days : 0;
    if (!m || !(m.trades >= need)) {
      return { status: 'PAPER', reason: 'Needs more data: ' + (m ? m.trades : 0) + ' of ' + need + ' closed paper trades' + (needDays ? ', on ' + days + ' of ' + needDays + ' different days' : '') + '.' };
    }
    if (days < needDays) {
      return { status: 'PAPER', reason: 'Needs more days: ' + m.trades + ' trades, but on only ' + days + ' of ' + needDays + ' different trading days. Trades on the same day tend to win or lose together.' };
    }
    if (m.expectancyPct < 0) return { status: 'REJECTED', reason: 'Loses ' + Math.abs(m.expectancyPct).toFixed(2) + '% per trade on average after charges, over ' + m.trades + ' trades' + (num(m.days) ? ' on ' + m.days + ' days' : '') + '.' };
    var pfOk = m.profitFactor === null ? (m.losses === 0 && m.wins > 0) : m.profitFactor >= rules.minPF;
    var fails = [];
    if (!(m.expectancyPct > 0)) fails.push('average result is not above zero');
    if (!pfOk) fails.push('profit factor ' + m.profitFactor + ' is below ' + rules.minPF);
    if (!(m.maxDrawdownPct <= rules.maxDrawdownPct)) fails.push('drawdown ' + m.maxDrawdownPct + '% is above ' + rules.maxDrawdownPct + '%');
    if (!(m.avgAlphaPct > 0)) fails.push('does not beat Nifty 50 over the same holding periods');
    if (fails.length) return { status: 'PAPER', reason: 'Not yet: ' + fails.join('; ') + '.' };
    return {
      status: 'LIVE_READY',
      reason: m.winRatePct + '% win over ' + m.trades + ' trades' + (num(m.days) ? ' on ' + m.days + ' days' : '') + ', ' + (m.expectancyPct >= 0 ? '+' : '−') + Math.abs(m.expectancyPct).toFixed(2) + '% a trade after charges, profit factor ' +
        (m.profitFactor === null ? 'with no losses' : m.profitFactor) + ', beating Nifty 50 by ' + m.avgAlphaPct.toFixed(2) + '% a trade.',
    };
  }

  /* ============================ Backtesting ============================ */
  // The same strategies, checks, fills, exits, charges and metrics as the live paper record, replayed one
  // session (or one 5-minute bar) at a time. Nothing looks ahead: each decision uses data up to that bar only,
  // and every trade is judged on the bars that came after it.

  /** day number → position, for a list of day numbers. */
  function dayIndexOf(days) { var m = {}; for (var j = 0; j < days.length; j++) m[days[j]] = j; return m; }

  /**
   * For each day in `days`, the index of the latest time on or before it; −1 when there is none or it is more
   * than maxGap calendar days old (so a suspended or delisted stock does not linger).
   */
  function alignTimes(times, days, maxGap) {
    var out = new Array(days.length), i = -1, n = times ? times.length : 0, gap = maxGap || 7;
    for (var j = 0; j < days.length; j++) {
      while (i + 1 < n && istDay(times[i + 1]) <= days[j]) i++;
      out[j] = i >= 0 && days[j] - istDay(times[i]) <= gap ? i : -1;
    }
    return out;
  }

  /**
   * The market as it stood at each Nifty 50 close, for a daily backtest: the regime and every stock's
   * relative-strength percentile, each worked out only from data up to that day, with the live rules.
   * input: {nifty, vix, series: {SYM: daily candles, or {t: [times], c: [closes]} to save memory}, params}
   * Returns {days, regime, breadth, rs: {SYM: [percentile|null]}, niftyClose} (arrays indexed by Nifty day).
   */
  function btContext(input) {
    var P = input.params || params(), nifty = input.nifty || [], vix = input.vix || [], series = input.series || {};
    var D = nifty.length, days = new Array(D), j;
    for (j = 0; j < D; j++) days[j] = istDay(nifty[j].t);
    var nc = pluck(nifty, 'c'), n50 = sma(nc, 50), n200 = sma(nc, 200), vAt = alignTimes(pluck(vix, 't'), days, 7);
    var up = nulls(D), cnt = nulls(D), raw = {}, syms = Object.keys(series).sort();
    for (j = 0; j < D; j++) { up[j] = 0; cnt[j] = 0; }
    syms.forEach(function (sym) {
      var k = series[sym] || [], col = !Array.isArray(k) && k.c ? k : null;
      var c = col ? col.c : pluck(k, 'c'), tt = col ? col.t : pluck(k, 't');
      if (c.length < 50) return;
      var m50 = sma(c, 50), at = alignTimes(tt, days, 7), r = nulls(D);
      for (var jj = 0; jj < D; jj++) {
        var i = at[jj];
        if (i < 0) continue;
        if (num(m50[i])) { cnt[jj]++; if (c[i] > m50[i]) up[jj]++; }
        r[jj] = rsAt(c, i, nc, jj);
      }
      raw[sym] = r;
    });
    var rs = {}, have = syms.filter(function (s) { return raw[s]; });
    have.forEach(function (s) { rs[s] = nulls(D); });
    for (j = 0; j < D; j++) {
      var list = [];
      for (var q = 0; q < have.length; q++) { var v = raw[have[q]][j]; if (num(v)) list.push({ s: have[q], v: v }); }
      list.sort(function (a, b) { return a.v - b.v; });
      for (q = 0; q < list.length; q++) rs[list[q].s][j] = round(list.length > 1 ? q / (list.length - 1) * 100 : 50, 2);
    }
    var regime = new Array(D), breadth = nulls(D);
    for (j = 0; j < D; j++) {
      var b = cnt[j] ? up[j] / cnt[j] * 100 : null;
      breadth[j] = num(b) ? round(b, 1) : null;
      if (j < 199) { regime[j] = 'UNKNOWN'; continue; }
      var vi = vAt[j], vNow = null, vJump = null;
      if (vi >= 5) { vNow = vix[vi].c; vJump = vix[vi - 5].c > 0 ? (vNow / vix[vi - 5].c - 1) * 100 : null; }
      regime[j] = regimeState(nc[j], n50[j], n200[j], vNow, vJump, b, P);
    }
    return { days: days, regime: regime, breadth: breadth, rs: rs, niftyClose: nc };
  }

  /** One finished backtest trade, or a note of why there is none ('open' at the end of the data, 'notTriggered'). */
  function btTrade(symbol, st, sig, track, regimeName0, dayT, s, sizing, rates, intraday, niftyPct) {
    if (s.state !== 'CLOSED') return 'open';
    if (s.outcome === 'NOT_TRIGGERED') return 'notTriggered';
    var r = paperResult(sig.direction, sig.stop, s, sizing, rates, intraday);
    var alpha = num(niftyPct) && num(r.netPct) ? round(r.netPct - niftyPct, 3) : null;
    return {
      symbol: symbol, strategy: st.id, horizon: st.horizon, direction: sig.direction, track: track, regime: regimeName0,
      dayT: dayT, fillT: s.fillT, exitT: s.exitT, outcome: s.outcome, entry: sig.entry, stop: sig.stop, target: sig.target1,
      fill: s.fillPrice, exit: s.exitPrice, qty: r.qty, netPct: r.netPct, netPnl: r.netPnl, holdDays: r.holdDays, alphaPct: alpha,
      blocked: sig.blocked || '',
    };
  }

  /**
   * Replay the daily strategies over one stock's full history with the day-by-day context from btContext.
   * opts: {params, strategies, ctx, sizing {capital, riskPct, maxPer, fractional}, rates, from, to (day numbers),
   *        shadows (default true: also signals the regime blocked), ignoreRegime (treat those as taken)}
   * Repeats follow the live cooldowns; each signal is judged on the following daily candles until it expires.
   * Returns {trades, open, notTriggered}: trades still open at the end of the data are counted, not judged.
   */
  function backtestDaily(symbol, candles, opts) {
    opts = opts || {};
    var P = opts.params || params(), ctx = opts.ctx, out = { trades: [], open: 0, notTriggered: 0 };
    if (!ctx || !candles || candles.length < 60) return out;
    var x = new Daily(candles), n = x.n, at = ctx._index || (ctx._index = dayIndexOf(ctx.days));
    var rs = (ctx.rs && ctx.rs[symbol]) || [], sizing = opts.sizing || { capital: 100000, riskPct: 1, maxPer: 10, fractional: true };
    var list = wanted(opts.strategies, ['daily']), last = {}, nc = ctx.niftyClose || [];
    for (var i = 30; i < n - 1; i++) {
      var dn = istDay(candles[i].t);
      if ((opts.from && dn < opts.from) || (opts.to && dn > opts.to)) continue;
      var j = at[dn];
      if (j === undefined || !ctx.regime[j] || ctx.regime[j] === 'UNKNOWN') continue;
      var o = { rsPct: num(rs[j]) ? rs[j] : null, rsPrevPct: j > 0 && num(rs[j - 1]) ? rs[j - 1] : null }, tv = null;
      for (var q = 0; q < list.length; q++) {
        var st = list[q], raw = null;
        try { raw = DAILY[st.id](x, i, P, o); } catch (e) { raw = null; }
        if (!raw) continue;
        if (tv === null) tv = x.tradedValueCr(i, 20);
        var f = finalize(raw, st, P, { regime: { state: ctx.regime[j] }, tradedValueCr: tv, track: null });
        var sig = f.signal || f.shadow;
        if (!sig || (f.shadow && opts.shadows === false && !opts.ignoreRegime)) continue;
        var track = f.signal || opts.ignoreRegime ? 'main' : 'shadow', key = st.id + '|' + track;
        if (last[key] !== undefined && candles[i].t - last[key] < cooldownDays(st.id, st.horizon, P) * 86400000) continue;
        last[key] = candles[i].t;
        var hd = holdDaysFor(st.horizon, P), complete = i + hd <= n - 1;
        var s = simulateTrade({ direction: sig.direction, entryLow: sig.entryLow, entryHigh: sig.entryHigh, stop: sig.stop, target: sig.target1 },
          candles.slice(i + 1, Math.min(n, i + hd + 1)), { expiryMs: complete ? candles[i + hd].t : null, nowMs: complete ? candles[n - 1].t : null, barMs: 0 });
        var np = null;
        if (s.state === 'CLOSED' && num(s.fillT)) {
          var jf = at[istDay(s.fillT)], jx = at[istDay(s.exitT)];
          if (jf !== undefined && jx !== undefined && jf > 0 && nc[jf - 1] > 0) np = (nc[jx] / nc[jf - 1] - 1) * 100;
        }
        var t = btTrade(symbol, st, sig, track, ctx.regime[j], candles[i].t, s, sizing, opts.rates || {}, false, np);
        if (t === 'open') out.open++; else if (t === 'notTriggered') out.notTriggered++; else out.trades.push(t);
      }
    }
    return out;
  }

  /**
   * Replay the intraday strategies over one stock's 5-minute history, bar by bar, with the live rules:
   * yesterday's and today's bars only, no entries after lastEntryMinute, your switches (block), the day's
   * direction (niftyBars + followNifty), one alert per stock per day (or one per strategy and direction with a
   * cooldown), and each trade judged on the following 5-minute bars until expiryMinute. The live record uses
   * 1-minute candles, so these results are a little coarser; a bar touching both the stop and the target is a stop.
   * opts: {params, strategies, niftyBars, regimeByDay {day: state}, followNifty, block, onePerStock (default true),
   *        cooldownMinutes (60), lastEntryMinute (870), expiryMinute (915), sizing, rates, shadows (default true)}
   */
  function backtestIntraday(symbol, bars, opts) {
    opts = opts || {};
    var P = opts.params || params(), out = { trades: [], open: 0, notTriggered: 0 };
    if (!bars || bars.length < 100) return out;
    var byDay = {}, days = [], i;
    for (i = 0; i < bars.length; i++) { var dd = istDay(bars[i].t); if (!byDay[dd]) { byDay[dd] = []; days.push(dd); } byDay[dd].push(bars[i]); }
    var nByDay = {};
    (opts.niftyBars || []).forEach(function (b) { var d0 = istDay(b.t); (nByDay[d0] || (nByDay[d0] = [])).push(b); });
    var turnover = days.map(function (d) { var sum = 0; byDay[d].forEach(function (b) { sum += b.c * (b.v || 0); }); return sum / 1e7; });
    var lastEntry = num(opts.lastEntryMinute) ? opts.lastEntryMinute : 870, expMin = num(opts.expiryMinute) ? opts.expiryMinute : 915;
    var onePer = opts.onePerStock !== false, coolMs = (num(opts.cooldownMinutes) ? opts.cooldownMinutes : 60) * 60000;
    var sizing = opts.sizing || { capital: 100000, riskPct: 1, maxPer: 10, fractional: true };
    for (var di = 1; di < days.length; di++) {
      var d = days[di], prev = byDay[days[di - 1]], today = byDay[d], state = opts.regimeByDay ? opts.regimeByDay[d] : null;
      if (!state || state === 'UNKNOWN' || prev.length < 20) continue;
      var tvs = turnover.slice(Math.max(0, di - 20), di), tv = 0;
      tvs.forEach(function (v) { tv += v; });
      tv = tvs.length ? tv / tvs.length : null;
      var expiry = (d * 1440 - 330 + expMin) * 60000, nb = nByDay[d] || null, took = {}, seen = {};
      for (var k = 0; k < today.length; k++) {
        if (istMinute(today[k].t) + 5 > lastEntry) break;
        var r = scanIntraday(symbol, prev.concat(today.slice(0, k + 1)), {
          params: P, regime: { state: state }, strategies: opts.strategies, prevClose: prev[prev.length - 1].c, tradedValueCr: tv,
          nowMs: today[k].t + 360000, lastEntryMinute: lastEntry, niftyBars: nb, followNifty: !!opts.followNifty, block: opts.block,
        });
        var found = r.signals.map(function (sg) { return { sig: sg, track: 'main' }; });
        if (opts.shadows !== false) found = found.concat(r.shadow.map(function (sg) { return { sig: sg, track: 'shadow' }; }));
        found.sort(function (a, b) { return b.sig.confidence - a.sig.confidence; });
        for (var f = 0; f < found.length; f++) {
          var sig = found[f].sig, track = found[f].track, st = strategy(sig.strategy), now = today[k].t;
          if (onePer) {
            if (took[track]) continue;
            took[track] = true;
          } else {
            var full = track + sig.strategy + sig.direction, pair = track + sig.strategy;
            if (seen[full] || (seen[pair] !== undefined && now - seen[pair] < coolMs)) continue;
            seen[full] = now; seen[pair] = now;
          }
          var s = simulateTrade({ direction: sig.direction, entryLow: sig.entryLow, entryHigh: sig.entryHigh, stop: sig.stop, target: sig.target1 },
            today.slice(k + 1), { expiryMs: expiry, nowMs: expiry + 1, barMs: 300000 });
          var np = s.state === 'CLOSED' && num(s.fillT) ? niftyMove(nb, s.fillT, s.exitT) : null;
          var t = btTrade(symbol, st, sig, track, state, now, s, sizing, opts.rates || {}, true, np);
          if (t === 'open') out.open++; else if (t === 'notTriggered') out.notTriggered++; else out.trades.push(t);
        }
      }
    }
    return out;
  }

  /**
   * Summary of backtest trades (one strategy, or any group): the same metrics as the live record, plus results
   * by regime and by year, a month-end equity curve (rupees, starting at capital), the most trades open at once,
   * and the yearly growth rate. opts: {capital}
   */
  function btSummary(trades, opts) {
    opts = opts || {};
    var cap = opts.capital > 0 ? opts.capital : 100000;
    var list = (trades || []).filter(function (x) { return num(x.netPct); }).slice().sort(function (a, b) { return a.exitT - b.exitT; });
    var m = metrics(list, { capital: cap }), out = { metrics: m, regimes: {}, years: {}, curve: [], maxOpen: 0, from: null, to: null, cagrPct: null };
    if (!list.length) return out;
    var groups = function (keyOf) {
      var g = {};
      list.forEach(function (x) { var k = keyOf(x); (g[k] || (g[k] = [])).push(x); });
      var res = {};
      Object.keys(g).forEach(function (k) {
        var mm = metrics(g[k], { capital: cap });
        res[k] = { trades: mm.trades, winRatePct: mm.winRatePct, expectancyPct: mm.expectancyPct, profitFactor: mm.profitFactor, totalNetPnl: mm.totalNetPnl };
      });
      return res;
    };
    out.regimes = groups(function (x) { return x.regime || 'UNKNOWN'; });
    out.years = groups(function (x) { return String(new Date(x.exitT + 330 * 60000).getUTCFullYear()); });
    var money = m.totalNetPnl !== null, eq = cap, month = null, lastT = null, events = [];
    out.from = list.reduce(function (a, x) { return Math.min(a, num(x.dayT) ? x.dayT : x.exitT); }, Infinity);
    out.to = list[list.length - 1].exitT;
    out.curve.push({ t: out.from, v: cap });
    list.forEach(function (x) {
      var dt = new Date(x.exitT + 330 * 60000), key = dt.getUTCFullYear() * 12 + dt.getUTCMonth();
      if (month !== null && key !== month) out.curve.push({ t: lastT, v: round(eq, 2) }); // month end, before this trade
      eq = money ? eq + x.netPnl : eq * (1 + x.netPct / 100);
      month = key; lastT = x.exitT;
      if (num(x.fillT)) { events.push([x.fillT, 1]); events.push([x.exitT, -1]); }
    });
    out.curve.push({ t: out.to, v: round(eq, 2) });
    events.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    var open = 0;
    events.forEach(function (e) { open += e[1]; if (open > out.maxOpen) out.maxOpen = open; });
    var years = (out.to - out.from) / (365.25 * 86400000);
    if (years >= 0.5 && eq > 0) out.cagrPct = round((Math.pow(eq / cap, 1 / years) - 1) * 100, 2);
    return out;
  }

  return {
    VERSION: VERSION,
    OPEN_MIN: OPEN_MIN,
    CLOSE_MIN: CLOSE_MIN,
    REGIMES: ALL_REGIMES,
    STRATEGIES: STRATEGIES,
    PARAMS: PARAMS,
    FUND_FIELDS: FUND_FIELDS,
    ind: { sma: sma, ema: ema, rsi: rsi, atr: atr, macd: macd, vwap: vwap, stdev: stdev, trueRange: trueRange },
    util: { tickRound: tickRound, istMinute: istMinute, istDay: istDay, hhmm: hhmm, inr: inr, pct: pct, maxOf: maxOf, minOf: minOf, pluck: pluck },
    params: params,
    strategy: strategy,
    regime: regime,
    regimeName: regimeName,
    breadth: breadth,
    rsRanks: rsRanks,
    liquidityCr: liquidityCr,
    qualityValue: qualityValue,
    scanDaily: scanDaily,
    scanIntraday: scanIntraday,
    dayDirection: dayDirection,
    finalize: finalize,
    confidence: confidence,
    positionSize: positionSize,
    charges: charges,
    simulateTrade: simulateTrade,
    tradeResult: tradeResult,
    paperResult: paperResult,
    niftyMove: niftyMove,
    cooldownDays: cooldownDays,
    holdDaysFor: holdDaysFor,
    metrics: metrics,
    graduate: graduate,
    btContext: btContext,
    backtestDaily: backtestDaily,
    backtestIntraday: backtestIntraday,
    btSummary: btSummary,
  };
})();
