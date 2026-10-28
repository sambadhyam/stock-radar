// core-tests.mjs — tests for core/core.js (the shared trading logic). Run through tests.mjs.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import * as S from './scenarios.mjs';

export function coreTests({ test, eq, ok, root }) {
  const corePath = path.join(root, 'core', 'core.js');
  const gsPath = path.join(root, 'apps-script', 'Core.gs');
  // A bare context, like a browser page without the app: no Apps Script services, no DOM.
  const load = () => { const ctx = vm.createContext({}); vm.runInContext(fs.readFileSync(corePath, 'utf8'), ctx); return ctx.SRCore; };
  const C = load();
  const bull = { state: 'BULL' }, bear = { state: 'BEAR' };
  const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, `${msg}: got ${a}, want ${b} ± ${tol}`);

  test('core: core.js and Core.gs are byte-identical and use only plain script', () => {
    const a = fs.readFileSync(corePath), b = fs.readFileSync(gsPath);
    ok(a.equals(b), 'core/core.js and apps-script/Core.gs differ: copy core.js over Core.gs');
    const src = a.toString('utf8');
    for (const bad of [/^\s*(import|export)\s/m, /\bdocument\./, /\bwindow\./, /SpreadsheetApp|UrlFetchApp|PropertiesService|Utilities\.|DriveApp|CacheService/, /\?\.|\?\?/]) {
      ok(!bad.test(src), 'core.js must not use ' + bad);
    }
    ok(load().VERSION, 'loads in a bare context');
  });

  test('core: indicators match published reference values', () => {
    // EMA(10) example from StockCharts' "Moving Averages" article.
    const e = C.ind.ema([22.27, 22.19, 22.08, 22.17, 22.18, 22.13, 22.23, 22.43, 22.24, 22.29, 22.15, 22.39, 22.38, 22.61, 23.36], 10);
    eq(e.slice(9).map((x) => x.toFixed(2)).join(), '22.22,22.21,22.24,22.27,22.33,22.52', 'EMA');
    // RSI(14) on StockCharts' sample closes (rounded to 2 decimals, so 70.46 rather than 70.53).
    const cl = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64];
    const r = C.ind.rsi(cl, 14);
    eq(r[13], null, 'no RSI before 14 changes');
    near(r[14], 70.46, 0.01, 'RSI first value'); near(r[15], 66.25, 0.01, 'RSI second value');
    eq(C.ind.sma([1, 2, 3, 4, 5], 3).join(), ',,2,3,4', 'SMA');
    // ATR: constant 2-point bars with no gaps give exactly 2.
    const bars = Array.from({ length: 20 }, (_, i) => ({ o: 100, h: 101, l: 99, c: 100 }));
    eq(C.ind.atr(bars, 14)[19], 2, 'ATR');
    const m = C.ind.macd(Array.from({ length: 60 }, (_, i) => 100 + i), 12, 26, 9);
    ok(m.line[59] > 0 && m.signal[59] > 0 && Math.abs(m.hist[59]) < 0.01, 'MACD of a straight line settles to a constant gap');
    const vw = C.ind.vwap([{ h: 11, l: 9, c: 10, v: 100 }, { h: 21, l: 19, c: 20, v: 300 }], 0);
    eq(vw[1], 17.5, 'VWAP');
  });

  test('core: prices round to the ₹0.05 tick and format the Indian way', () => {
    eq(C.util.tickRound(101.03), 101.05); eq(C.util.tickRound(101.024), 101); eq(C.util.tickRound(101.03, 'down'), 101); eq(C.util.tickRound(101.01, 'up'), 101.05);
    eq(C.util.tickRound(1234.55, 'down'), 1234.55, 'exact ticks stay');
    eq(C.util.inr(-1234567.5), '−₹12,34,567.50');
    eq(C.util.istMinute(Date.parse('2026-10-26T09:15:00+05:30')), 555);
  });

  const dailyIds = ['base-breakout', 'ema-pullback', 'rsi2', 'macd', 'trend-template', 'near-high'];
  for (const id of dailyIds) {
    test(`core: ${id} fires on its scenario with sound levels`, () => {
      const k = S.daily[id]();
      const r = C.scanDaily('TEST', k, { regime: bull, strategies: [id], rsPct: 95, rsPrevPct: id === 'trend-template' ? 60 : 95 });
      eq(r.signals.length, 1, 'signals (rejected: ' + JSON.stringify(r.rejected) + ')');
      const s = r.signals[0];
      eq(s.strategy, id); eq(s.direction, 'BUY'); eq(s.horizon, C.strategy(id).horizon);
      ok(s.stop < s.entryLow && s.entryLow <= s.entry && s.entry <= s.entryHigh && s.target1 > s.entryHigh, 'levels in order: ' + JSON.stringify(s));
      ok(s.rr >= 2, 'reward-to-risk at least 2: ' + s.rr);
      for (const v of [s.entry, s.stop, s.target1]) eq(Math.round(v * 20) / 20, v, 'on the tick: ' + v);
      ok(s.confidence >= 0 && s.confidence <= 100 && s.reasons.length >= 2, 'confidence and reasons');
      ok(s.reasons.every((x) => typeof x === 'string' && !/undefined|NaN/.test(x)), 'clean reasons: ' + s.reasons.join(' | '));
      const blocked = C.scanDaily('TEST', k, { regime: bear, strategies: [id], rsPct: 95, rsPrevPct: id === 'trend-template' ? 60 : 95 });
      eq(blocked.signals.length, 0, 'a Bear regime blocks swing and medium buys');
      ok(/regime/.test(blocked.rejected[0].why), blocked.rejected[0].why);
    });
  }

  test('core: an RSI(2) dip needs a signal score of at least rsi2.minScore (70 by default)', () => {
    eq(C.params()['rsi2.minScore'], 70);
    const k = S.daily.rsi2();
    const r = C.scanDaily('T', k, { regime: bull, strategies: ['rsi2'] });
    eq(r.signals.length, 1); ok(r.signals[0].ruleScore >= 70, 'a deep dip in a strong uptrend: ' + r.signals[0].ruleScore);
    eq(C.scanDaily('T', k, { regime: bull, strategies: ['rsi2'], params: C.params({ 'rsi2.minScore': 99 }) }).signals.length, 0, 'below the floor: no signal');
  });

  test('core: relative-strength leaders fire only on the day they enter the top 20%', () => {
    const k = S.daily['trend-template']();
    eq(C.scanDaily('T', k, { regime: bull, strategies: ['rs-leaders'], rsPct: 92, rsPrevPct: 70 }).signals.length, 1, 'enters the top 20%');
    eq(C.scanDaily('T', k, { regime: bull, strategies: ['rs-leaders'], rsPct: 92, rsPrevPct: 85 }).signals.length, 0, 'already a leader yesterday');
  });

  test('core: nothing fires on a flat, sideways stock', () => {
    const r = C.scanDaily('FLAT', S.daily.flat(), { regime: bull, rsPct: 50, rsPrevPct: 50, holding: { qty: 5, avgPrice: 100 } });
    eq(r.signals.length, 0, JSON.stringify(r.signals.map((s) => s.strategy)));
  });

  test('core: holding guard warns once when a holding falls through its trailing stop', () => {
    const k = S.daily['holding-guard']();
    const r = C.scanDaily('INFY', k, { regime: bull, strategies: ['holding-guard'], holding: { qty: 20, avgPrice: 60 } });
    eq(r.signals.length, 1); eq(r.signals[0].direction, 'EXIT');
    ok(r.signals[0].reasons.some((x) => /trailing stop/.test(x)) && r.signals[0].reasons.some((x) => /average price/.test(x)), r.signals[0].reasons.join(' | '));
    eq(C.scanDaily('INFY', k, { regime: bull, strategies: ['holding-guard'] }).signals.length, 0, 'only for stocks you hold');
    eq(C.scanDaily('INFY', k.slice(0, -1), { regime: bull, strategies: ['holding-guard'], holding: { qty: 20, avgPrice: 60 } }).signals.length, 0, 'not the day before');
  });

  test('core: quality-value uses only known fundamentals and needs enough of them', () => {
    const good = { roePct: 24, rocePct: 26, debtToEquity: 0.05, sales3yPct: 16, profit3yPct: 20, promoterPct: 70, pledgePct: 0, pe: 22, pe5yMedian: 30, fcf: 1200 };
    const q = C.qualityValue(good);
    eq(q.completenessPct, 100); ok(q.score >= 95, 'score ' + q.score);
    const partial = C.qualityValue({ roePct: 24, rocePct: '', debtToEquity: null });
    eq(partial.completenessPct, 11, 'one of nine known'); eq(partial.score, 100, 'scored only on what is known');
    const k = S.daily['trend-template']();
    eq(C.scanDaily('T', k, { regime: bear, strategies: ['quality-value'], fundamentals: good }).signals.length, 1, 'long-term ideas are allowed in any regime');
    eq(C.scanDaily('T', k, { regime: bull, strategies: ['quality-value'], fundamentals: { roePct: 24 } }).signals.length, 0, 'too incomplete to count');
    eq(C.scanDaily('T', k, { regime: bull, strategies: ['quality-value'] }).signals.length, 0, 'no fundamentals, no signal');
  });

  const mirror = (bars) => bars.map((b) => ({ t: b.t, o: 200 - b.o, h: 200 - b.l, l: 200 - b.h, c: 200 - b.c, v: b.v }));
  for (const id of ['orb', 'vwap', 'ema-cross', 'gap']) {
    test(`core: intraday ${id} fires on its scenario, and its mirror image fires as a SHORT`, () => {
      const bars = S.intraday[id]();
      const nowMs = bars[bars.length - 1].t + 6 * 60000;
      const opts = { regime: bull, strategies: [id], prevClose: 100, tradedValueCr: 500, nowMs, lastEntryMinute: 870 };
      const r = C.scanIntraday('TCS', bars, opts);
      eq(r.signals.length, 1, 'buy (rejected: ' + JSON.stringify(r.rejected) + ')');
      const s = r.signals[0];
      eq(s.direction, 'BUY'); eq(s.horizon, 'INTRADAY');
      ok(s.stop < s.entry && s.target1 > s.entry && s.rr >= 1.5, JSON.stringify(s));
      ok(/^\d\d:\d\d$/.test(s.barEnd), 'bar end time');
      const sh = C.scanIntraday('TCS', mirror(bars), { ...opts, regime: bear });
      eq(sh.signals.length, 1, 'short (rejected: ' + JSON.stringify(sh.rejected) + ')');
      const x = sh.signals[0];
      eq(x.direction, 'SHORT');
      ok(x.stop > x.entry && x.target1 < x.entry && x.rr >= 1.5, JSON.stringify(x));
      eq(C.scanIntraday('TCS', mirror(bars), opts).signals.length, 1, 'shorts are allowed on Bull days by default');
      eq(C.scanIntraday('TCS', bars, { ...opts, regime: bear }).signals.length, 1, 'buys are allowed on Bear days by default');
      eq(C.scanIntraday('TCS', bars, { ...opts, lastEntryMinute: C.util.istMinute(bars[bars.length - 1].t) }).signals.length, 0, 'no entries after the cut-off');
      eq(C.scanIntraday('TCS', bars, { ...opts, tradedValueCr: 2 }).signals.length, 0, 'liquidity filter');
    });
  }

  test('core: an intraday breakout that has already been taken does not fire again', () => {
    const bars = S.intraday.orb();
    const extra = { ...bars[bars.length - 1] };
    extra.t += 300000; extra.o = 101.2; extra.h = 101.35; extra.l = 101.1; extra.c = 101.3; extra.v = 90000;
    const r = C.scanIntraday('TCS', bars.concat([extra]), { regime: bull, strategies: ['orb'], tradedValueCr: 500, nowMs: extra.t + 360000, lastEntryMinute: 870 });
    eq(r.signals.length, 0, 'second close above the range is not a new breakout');
  });

  test('core: market regime from Nifty, VIX and breadth', () => {
    const nifty = S.dailyFrom(S.trend(260, 20000, 0.08));
    const vix = (v) => S.dailyFrom(Array.from({ length: 10 }, (_, i) => (typeof v === 'function' ? v(i) : v)));
    eq(C.regime(nifty, vix(12), 62).state, 'BULL');
    eq(C.regime(nifty, vix(12), 40).state, 'NEUTRAL', 'weak breadth');
    eq(C.regime(nifty, vix(23), 62).state, 'HIGH_VOL', 'VIX level');
    eq(C.regime(nifty, vix((i) => (i < 5 ? 12 : 18)), 62).state, 'HIGH_VOL', 'VIX jump');
    const down = S.dailyFrom(S.trend(260, 26000, -0.08));
    eq(C.regime(down, vix(14), 30).state, 'BEAR');
    const u = C.regime(nifty.slice(0, 150), vix(12), 60);
    eq(u.state, 'UNKNOWN'); ok(/Not enough/.test(u.reasons[0]));
    ok(C.regime(nifty, vix(12), 62).reasons.every((x) => !/NaN|undefined/.test(x)), 'clean reasons');
  });

  test('core: relative strength ranks the strongest stock highest', () => {
    const nifty = S.dailyFrom(S.trend(300, 100, 0.05));
    const ranks = C.rsRanks({ FAST: S.dailyFrom(S.trend(300, 100, 0.2)), MID: S.dailyFrom(S.trend(300, 100, 0.05)), SLOW: S.dailyFrom(S.trend(300, 100, -0.1)) }, nifty);
    eq(ranks.now.FAST, 100); eq(ranks.now.SLOW, 0); eq(ranks.now.MID, 50); ok(ranks.prev.FAST === 100, 'yesterday too');
  });

  test('core: the common checks reject weak reward, wide stops and thin stocks', () => {
    const st = C.strategy('base-breakout'), P = C.params();
    const base = { direction: 'BUY', entry: 100, entryLow: 99.5, entryHigh: 100.5, stop: 97, score: 60, reasons: ['x'] };
    eq(C.finalize({ ...base, target1: 104 }, st, P, { regime: bull, tradedValueCr: 50 }).rejected, 'reward-to-risk 1.33 is below 2');
    ok(/limit/.test(C.finalize({ ...base, stop: 85, target1: 140 }, st, P, { regime: bull, tradedValueCr: 50 }).rejected), 'stop too wide');
    ok(/crore/.test(C.finalize({ ...base, target1: 110 }, st, P, { regime: bull, tradedValueCr: 3 }).rejected), 'thin stock');
    ok(/side/.test(C.finalize({ ...base, stop: 101, target1: 110 }, st, P, { regime: bull, tradedValueCr: 50 }).rejected), 'stop above entry');
    const okSig = C.finalize({ ...base, targetR: [2, 3] }, st, P, { regime: bull, tradedValueCr: 50 }).signal;
    eq(okSig.target1, 106); eq(okSig.rr, 2); eq(okSig.target2, 109);
    const P2 = C.params({ minRROther: 1.2, 'orb.volMult': 'abc' });
    eq(P2.minRROther, 1.2, 'override from Config'); eq(P2['orb.volMult'], 1.5, 'bad value falls back');
  });

  test('core: the entry range always ends well before the stop-loss', () => {
    // An opening-range short whose breakout bar closed far below the range: the raw range (close to range low)
    // reached past the ATR stop, so a fill at its top would have been above the stop (seen on 27 Oct, AXISBANK).
    const st = C.strategy('orb'), P = C.params();
    const raw = { direction: 'SHORT', entry: 1213, entryLow: 1213, entryHigh: 1216, stop: 1215.95, targetR: [2, 3], score: 60, reasons: ['x'] };
    const sig = C.finalize(raw, st, P, { regime: bull, tradedValueCr: 500 }).signal;
    ok(sig.entryHigh < sig.stop, 'short: range ends below the stop: ' + sig.entryHigh + ' vs ' + sig.stop);
    ok(sig.entryHigh - sig.entry <= (sig.stop - sig.entry) / 2 + 1e-9 && sig.entryLow === 1213, JSON.stringify(sig));
    const buy = C.finalize({ direction: 'BUY', entry: 500, entryLow: 496, entryHigh: 500, stop: 497, targetR: [2, 3], score: 60, reasons: ['x'] }, st, P, { regime: bull, tradedValueCr: 500 }).signal;
    ok(buy.entryLow > buy.stop && buy.entry - buy.entryLow <= (buy.entry - buy.stop) / 2 + 1e-9, 'buy: ' + JSON.stringify(buy));
    const wide = C.finalize({ direction: 'BUY', entry: 100, entryLow: 99.5, entryHigh: 100.5, stop: 97, targetR: [2, 3], score: 60, reasons: ['x'] }, C.strategy('base-breakout'), P, { regime: bull, tradedValueCr: 50 }).signal;
    eq(wide.entryLow, 99.5, 'a range already clear of the stop is kept');
  });

  test('core: the signal score is the strategy\'s rule score, whatever its paper record (the number the backtest checks)', () => {
    const k = S.daily['base-breakout']();
    for (const track of [null, { trades: 30, winRatePct: 10, profitFactor: 0.2 }, { trades: 30, winRatePct: 90, profitFactor: 5 }]) {
      const r = C.scanDaily('TEST', k, { regime: bull, strategies: ['base-breakout'], tracks: track ? { 'base-breakout': track } : {} });
      eq(r.signals.length, 1);
      eq(r.signals[0].confidence, r.signals[0].ruleScore, 'record ' + JSON.stringify(track));
    }
    eq(C.confidence, undefined, 'no blended score any more');
  });

  test('core: a signal blocked only by the market filters comes back as a shadow signal', () => {
    const k = S.daily['base-breakout']();
    const r = C.scanDaily('TEST', k, { regime: bear, strategies: ['base-breakout'] });
    eq(r.signals.length, 0); eq(r.shadow.length, 1, 'shadow');
    ok(r.shadow[0].shadow === true && r.shadow[0].symbol === 'TEST' && r.shadow[0].rr >= 2, JSON.stringify(r.shadow[0]));
    eq(r.shadow[0].blocked, 'blocked by the Bear regime');
    const bars = S.intraday.orb();
    const o = { regime: bear, strategies: ['orb'], prevClose: 100, tradedValueCr: 500, nowMs: bars[bars.length - 1].t + 360000, lastEntryMinute: 870 };
    const ri = C.scanIntraday('TCS', bars, { ...o, block: { BUY: ['BEAR'], SHORT: ['BULL'] } });
    eq(ri.signals.length, 0); eq(ri.shadow.length, 1, 'your Bear-day switch: the buy is tracked silently');
    eq(ri.shadow[0].blocked, 'blocked by your setting: no intraday buys on Bear days');
    eq(C.scanIntraday('TCS', bars, { ...o, regime: bull, block: { BUY: ['BEAR'], SHORT: ['BULL'] } }).signals.length, 1, 'the switch acts only on Bear days');
    const sb = C.scanIntraday('TCS', mirror(bars), { ...o, regime: bull, block: { BUY: [], SHORT: ['BULL'] } });
    eq(sb.shadow.length, 1); ok(/no intraday shorts on Bull days/.test(sb.shadow[0].blocked), sb.shadow[0].blocked);
    eq(C.scanDaily('TEST', k, { regime: { state: 'UNKNOWN' }, strategies: ['base-breakout'] }).shadow.length, 0, 'no shadows without a known regime');
    eq(C.scanDaily('TEST', k, { regime: bear, strategies: ['base-breakout'], params: C.params({ minRROther: 9 }) }).shadow.length, 0, 'other checks still apply');
  });

  test('core: trading with the day — buys need Nifty 50 above its open, shorts below', () => {
    const bars = S.intraday.orb(), last = bars[bars.length - 1].t;
    const o = { regime: bull, strategies: ['orb'], prevClose: 100, tradedValueCr: 500, nowMs: last + 360000, lastEntryMinute: 870 };
    const up = S.niftyIntraday(1), down = S.niftyIntraday(-1);
    const d = C.dayDirection(up, last);
    eq(d.dir, 'UP'); eq(d.open, 22600); eq(d.pct, 0.24, 'six bars of +0.04% by the 09:40 bar');
    eq(C.dayDirection(down, last).dir, 'DOWN');
    eq(C.dayDirection(up.filter((b) => !(C.util.istMinute(b.t) === 555 && C.util.istDay(b.t) === C.util.istDay(last))), last), null, 'no 09:15 bar, no direction');
    eq(C.dayDirection([], last), null);
    const withUp = C.scanIntraday('TCS', bars, { ...o, niftyBars: up, followNifty: true });
    eq(withUp.signals.length, 1);
    ok(withUp.signals[0].reasons.some((x) => /^Nifty 50 is up 0\.24% since the open \(22,600\.00 → 22,654\.\d\d\)\.$/.test(x)), withUp.signals[0].reasons.join(' | '));
    const withDown = C.scanIntraday('TCS', bars, { ...o, niftyBars: down, followNifty: true });
    eq(withDown.signals.length, 0); eq(withDown.shadow.length, 1, 'a buy against a falling day is tracked silently');
    eq(withDown.shadow[0].blocked, 'against the day: Nifty 50 is down 0.24% since the open');
    const off = C.scanIntraday('TCS', bars, { ...o, niftyBars: down, followNifty: false });
    eq(off.signals.length, 1, 'switch off: the buy goes out'); ok(off.signals[0].reasons.some((x) => /down 0\.24%/.test(x)), 'with the day noted');
    eq(C.scanIntraday('TCS', mirror(bars), { ...o, niftyBars: up, followNifty: true }).shadow.length, 1, 'a short against a rising day waits');
    eq(C.scanIntraday('TCS', mirror(bars), { ...o, niftyBars: down, followNifty: true }).signals.length, 1, 'a short with a falling day goes out');
    eq(C.scanIntraday('TCS', bars, { ...o, followNifty: true }).signals.length, 1, 'no Nifty bars: no check');
  });

  test('core: graduation also needs the trades spread over enough different days', () => {
    const rules = { minTrades: 30, minDays: 15, minPF: 1.3, maxDrawdownPct: 15 };
    const day = (n) => Date.parse('2026-09-01T10:00:00+05:30') + n * 86400000;
    const many = (nDays) => Array.from({ length: 32 }, (_, i) => ({ netPct: i % 3 ? 1.2 : -0.5, netPnl: i % 3 ? 120 : -50, exitT: day(i % nDays) + 3600000 + i, dayT: day(i % nDays), alphaPct: 0.3 }));
    const m3 = C.metrics(many(3));
    eq(m3.days, 3); eq(m3.trades, 32);
    const g3 = C.graduate(m3, rules);
    eq(g3.status, 'PAPER'); ok(/only 3 of 15 different trading days/.test(g3.reason), g3.reason);
    eq(C.graduate({ ...m3, expectancyPct: -0.4 }, rules).status, 'PAPER', 'not rejected on a few days either');
    const m20 = C.metrics(many(20)), g20 = C.graduate(m20, rules);
    eq(m20.days, 20); eq(g20.status, 'LIVE_READY', g20.reason); ok(/32 trades on 20 days/.test(g20.reason), g20.reason);
    eq(C.graduate({ ...m20, expectancyPct: -0.4 }, rules).status, 'REJECTED');
    eq(C.metrics([{ netPct: 1, exitT: day(1) }, { netPct: 1, exitT: day(1) + 60000 }]).days, 1, 'falls back to the exit day');
    ok(/0 of 30 closed paper trades, on 0 of 15 different days/.test(C.graduate(C.metrics([]), rules).reason), 'needs-more-data note mentions days');
  });

  // Daily-style candles for the trade simulator: t is a running day number, barMs 0.
  const day = (i, o, h, l, c) => ({ t: i * 86400000, o, h, l, c, v: 1000 });
  const buyA = { direction: 'BUY', entryLow: 100, entryHigh: 101, stop: 98, target: 104 };
  const shortA = { direction: 'SHORT', entryLow: 99, entryHigh: 100, stop: 102, target: 96 };
  const sim = (a, candles, extra) => C.simulateTrade(a, candles, { expiryMs: 10 * 86400000, nowMs: 20 * 86400000, barMs: 0, ...extra });

  test('core: a paper trade fills like a limit order and exits at the target', () => {
    const r = sim(buyA, [day(1, 100.5, 101.5, 100, 101), day(2, 101, 104.5, 100.6, 104)]);
    eq(r.state, 'CLOSED'); eq(r.outcome, 'TARGET_HIT'); eq(r.fillPrice, 100.5, 'filled at the open inside the range'); eq(r.exitPrice, 104);
    near(r.pct, (104 / 100.5 - 1) * 100, 0.001, 'gross move'); eq(r.bars, 1);
    const lim = sim(buyA, [day(1, 103, 105, 100.8, 102)], { nowMs: 5 * 86400000 });
    eq(lim.fillPrice, 101, 'opened above the range, filled at its top'); eq(lim.state, 'ACTIVE', 'target in the fill candle does not count after a limit fill');
    const better = sim(buyA, [day(1, 99, 99.5, 98.5, 99.2)], { nowMs: 5 * 86400000 });
    eq(better.fillPrice, 99, 'a lower open fills at the open');
  });

  test('core: the stop wins when one candle touches both, and gaps exit at the open', () => {
    eq(sim(buyA, [day(1, 100.5, 101, 100.2, 100.8), day(2, 100.8, 105, 97.5, 103)]).outcome, 'STOP_HIT', 'both in one candle: stop first');
    const g = sim(buyA, [day(1, 100.5, 101, 100.2, 100.8), day(2, 96, 97, 95, 96.5)]);
    eq(g.outcome, 'STOP_HIT'); eq(g.exitPrice, 96, 'gap through the stop exits at the open');
    const up = sim(buyA, [day(1, 100.5, 101, 100.2, 100.8), day(2, 106, 107, 105, 106.5)]);
    eq(up.outcome, 'TARGET_HIT'); eq(up.exitPrice, 106, 'gap over the target exits at the open');
    const same = sim(buyA, [day(1, 100.5, 101, 97, 98.5)]);
    eq(same.outcome, 'STOP_HIT', 'stop in the entry candle');
  });

  test('core: not triggered, expired and still open', () => {
    const failed = sim(buyA, [day(1, 97, 99, 96, 98)]);
    eq(failed.outcome, 'NOT_TRIGGERED'); ok(/beyond the stop/.test(failed.note), failed.note);
    const never = sim(buyA, [day(1, 103, 104, 102, 103), day(2, 103, 103.5, 101.5, 102)]);
    eq(never.outcome, 'NOT_TRIGGERED'); ok(/never came/.test(never.note));
    eq(sim(buyA, [day(1, 103, 104, 102, 103)], { nowMs: 5 * 86400000 }).state, 'OPEN', 'still waiting before expiry');
    const exp = sim(buyA, [day(1, 100.5, 101, 100.2, 100.8), day(10, 101, 102, 100.5, 101.6), day(11, 101, 110, 90, 105)]);
    eq(exp.outcome, 'EXPIRED'); eq(exp.exitPrice, 101.6, 'closed at the last close inside the window; later candles ignored');
    const act = sim(buyA, [day(1, 100.5, 101, 100.2, 100.8), day(2, 100.8, 102, 100.5, 101.9)], { nowMs: 3 * 86400000 });
    eq(act.state, 'ACTIVE'); near(act.pct, (101.9 / 100.5 - 1) * 100, 0.001, 'marked to the last close');
  });

  test('core: short trades mirror the rules', () => {
    const r = sim(shortA, [day(1, 99.5, 100, 98.5, 99), day(2, 99, 99.2, 95.5, 96)]);
    eq(r.outcome, 'TARGET_HIT'); eq(r.fillPrice, 99.5); eq(r.exitPrice, 96); near(r.pct, (99.5 - 96) / 99.5 * 100, 0.001, 'short gain');
    eq(sim(shortA, [day(1, 99.5, 100, 98.5, 99), day(2, 99, 102.5, 95.5, 100)]).outcome, 'STOP_HIT', 'both in one candle');
    eq(sim(shortA, [day(1, 103, 104, 102.5, 103)]).outcome, 'NOT_TRIGGERED', 'opened above the stop');
  });

  test('core: intraday minute bars stop at the expiry minute', () => {
    const t0 = Date.parse('2026-10-26T15:10:00+05:30');
    const mins = [0, 1, 2, 3, 4, 5].map((i) => ({ t: t0 + i * 60000, o: 100.5, h: 100.9, l: 100.3, c: 100.6 + i / 100, v: 10 }));
    const r = C.simulateTrade(buyA, mins, { expiryMs: Date.parse('2026-10-26T15:15:00+05:30'), nowMs: Date.parse('2026-10-26T16:00:00+05:30'), barMs: 60000 });
    eq(r.outcome, 'EXPIRED'); eq(r.exitPrice, 100.64, 'close of the 15:14 bar'); eq(r.exitT, t0 + 4 * 60000);
  });

  test('core: net results after Zerodha charges', () => {
    const d = C.tradeResult('BUY', 100, 500, 510, false, {});
    const ch = C.charges(50000, 51000, false, {}).total;
    eq(d.grossPnl, 1000); eq(d.charges, ch); eq(d.netPnl, Math.round((1000 - ch) * 100) / 100); near(d.netPct, (1000 - ch) / 50000 * 100, 0.001, 'net %');
    const sh = C.tradeResult('SHORT', 10, 200, 190, true, {});
    eq(sh.grossPnl, 100); eq(sh.charges, C.charges(1900, 2000, true, {}).total, 'bought back at 190, sold at 200');
    eq(C.tradeResult('BUY', 0, 500, 510, false, {}).netPct, null, 'no quantity, no result');
  });

  test('core: strategy metrics — win rate, expectancy, profit factor, drawdown, alpha', () => {
    const tr = [
      { netPct: 2, netPnl: 2000, exitT: 1, holdDays: 3, alphaPct: 1.5 },
      { netPct: -1, netPnl: -1000, exitT: 2, holdDays: 2, alphaPct: -0.5 },
      { netPct: -1, netPnl: -1000, exitT: 3, holdDays: 4, alphaPct: -1 },
      { netPct: 3, netPnl: 3000, exitT: 4, holdDays: 5, alphaPct: 2 },
    ];
    const m = C.metrics(tr, { capital: 100000 });
    eq(m.trades, 4); eq(m.wins, 2); eq(m.losses, 2); eq(m.winRatePct, 50); eq(m.avgWinPct, 2.5); eq(m.avgLossPct, -1);
    eq(m.expectancyPct, 0.75); eq(m.profitFactor, 2.5); eq(m.avgHoldDays, 3.5); eq(m.avgAlphaPct, 0.5); eq(m.totalNetPnl, 3000); eq(m.returnPct, 3);
    near(m.maxDrawdownPct, 2000 / 102000 * 100, 0.01, 'peak 1,02,000 to 1,00,000');
    eq(C.metrics([{ netPct: 1, netPnl: 100, exitT: 1 }], {}).profitFactor, null, 'no losses yet');
    eq(C.metrics([{ netPct: 10, exitT: 1 }, { netPct: -10, exitT: 2 }], { capital: 100 }).returnPct, -1, 'percent results compound when rupees are unknown');
  });

  test('core: graduation to Live-ready or Rejected needs 30 trades and every condition', () => {
    const rules = { minTrades: 30, minPF: 1.3, maxDrawdownPct: 15 };
    const good = { trades: 32, wins: 20, losses: 12, winRatePct: 62.5, expectancyPct: 0.8, profitFactor: 1.9, maxDrawdownPct: 6, avgAlphaPct: 0.4 };
    eq(C.graduate({ ...good, trades: 29 }, rules).status, 'PAPER'); ok(/29 of 30/.test(C.graduate({ ...good, trades: 29 }, rules).reason));
    const live = C.graduate(good, rules);
    eq(live.status, 'LIVE_READY'); ok(/62.5% win over 32 trades/.test(live.reason), live.reason);
    eq(C.graduate({ ...good, expectancyPct: -0.2 }, rules).status, 'REJECTED');
    const pf = C.graduate({ ...good, profitFactor: 1.1 }, rules);
    eq(pf.status, 'PAPER'); ok(/profit factor 1.1/.test(pf.reason), pf.reason);
    eq(C.graduate({ ...good, maxDrawdownPct: 22 }, rules).status, 'PAPER', 'drawdown limit');
    eq(C.graduate({ ...good, avgAlphaPct: -0.1 }, rules).status, 'PAPER', 'must beat Nifty');
    eq(C.graduate({ ...good, profitFactor: null, losses: 0, wins: 32 }, rules).status, 'LIVE_READY', 'no losses at all');
  });

  test('core: Live-ready also needs a whole record that luck cannot easily explain, and no losing backtest', () => {
    const rules = { minTrades: 30, minPF: 1.3, maxDrawdownPct: 15, minT: 2 };
    const good = { trades: 32, wins: 20, losses: 12, winRatePct: 62.5, expectancyPct: 0.8, profitFactor: 1.9, maxDrawdownPct: 6, avgAlphaPct: 0.4, sdPct: 1.5, tStat: 3.0 };
    eq(C.graduate(good, rules).status, 'LIVE_READY');
    const noisy = { ...good, sdPct: 4, tStat: 1.1 };
    const g = C.graduate(noisy, rules);
    eq(g.status, 'PAPER');
    ok(/could still be luck \(at this average, about 68 more trades would show it\)/.test(g.reason), g.reason); // (2 × 4 / 0.8)² = 100, so 68 more
    eq(C.graduate(noisy, rules, { ...good, trades: 150, tStat: 2.5 }).status, 'LIVE_READY', 'the whole record decides the luck test');
    eq(C.graduate(good, rules, { ...good, trades: 150, tStat: 1.2 }).status, 'PAPER', 'a good latest window is not enough on its own');
    const bt = C.graduate(good, { ...rules, btVerdict: 'loses' });
    eq(bt.status, 'PAPER'); ok(/Backtest Baseline says it loses money after charges/.test(bt.reason), bt.reason);
    eq(C.graduate(good, { ...rules, btVerdict: 'thin' }).status, 'LIVE_READY', 'a thin but positive backtest does not block');
    eq(C.graduate({ ...good, expectancyPct: -0.3 }, { ...rules, btVerdict: 'loses' }).status, 'REJECTED', 'rejecting is unchanged');
    // metrics() gives the spread and the t-value: [1, −0.5, 2, 0.5] has mean 0.75, sd 1.041, t 1.44.
    const m = C.metrics([1, -0.5, 2, 0.5].map((x, i) => ({ netPct: x, exitT: i + 1 })));
    eq(m.sdPct, 1.041); eq(m.tStat, 1.44);
    eq(C.metrics([{ netPct: 1, exitT: 1 }]).tStat, null, 'one trade has no spread');
    // A strategy with no edge (wins +0.9%, losses −0.6%, about 0.1% charges) on 30 trades: how often it would look
    // Live-ready, with and without the luck test.
    let x = 7; const rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
    let pass = 0, passLuck = 0; const N = 3000;
    for (let i = 0; i < N; i++) {
      const tr = Array.from({ length: 30 }, (_, j) => { const v = (rnd() < 0.4 ? 0.9 : -0.6) - 0.1; return { netPct: v, exitT: j + 1, alphaPct: v }; });
      const mm = C.metrics(tr);
      if (C.graduate(mm, { minTrades: 30, minPF: 1.3, maxDrawdownPct: 15 }).status === 'LIVE_READY') pass++;
      if (C.graduate(mm, rules).status === 'LIVE_READY') passLuck++;
    }
    ok(pass / N > 0.05, 'without the luck test, about 1 in 10 pass: ' + pass / N);
    ok(passLuck / N < 0.03, 'with it, under 3 in 100: ' + passLuck / N);
  });

  test('core: position size and Zerodha charges', () => {
    const p = C.positionSize(100000, 1, 500, 490, 100);
    eq(p.qty, 100); eq(p.riskAmount, 1000); eq(p.capped, false);
    const c = C.positionSize(100000, 1, 500, 490, 10);
    eq(c.qty, 20, 'capped at 10% of capital'); eq(c.capped, true);
    eq(C.positionSize(100000, 1, 500, 500, 10).qty, 0, 'no risk, no size');
    // Intraday ₹1,00,000 buy and ₹1,01,000 sell: ₹20 + ₹20 brokerage, 0.025% STT on the sell,
    // 0.00307% exchange fee, ₹10/crore SEBI, 0.003% stamp on the buy, 18% GST on brokerage + fees.
    const ch = C.charges(100000, 101000, true, {});
    eq(ch.brokerage, 40); eq(ch.stt, 25.25); eq(ch.stamp, 3); eq(ch.txn, 6.17); eq(ch.sebi, 0.2); eq(ch.gst, 8.35); eq(ch.total, 82.97);
    // Delivery: no brokerage, 0.1% STT both sides, 0.015% stamp on the buy, DP ₹15.34 on the sell.
    const d = C.charges(100000, 110000, false, {});
    eq(d.brokerage, 0); eq(d.stt, 210); eq(d.stamp, 15); eq(d.dp, 15.34);
    eq(d.total, Math.round((210 + 15 + 210000 * 0.0000307 + 0.21 + (210000 * 0.0000307 + 0.21) * 0.18 + 15.34) * 100) / 100);
  });
}
