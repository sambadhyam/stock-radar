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

  test('core: confidence leans on the paper record as it grows, up to half at 30 trades', () => {
    eq(C.confidence(70, null), 70);
    eq(C.confidence(70, { trades: 30, winRatePct: 60, profitFactor: 1.5 }), Math.round(70 * 0.5 + (60 * 0.6 + 40) * 0.5));
    ok(C.confidence(70, { trades: 6, winRatePct: 20, profitFactor: 0.5 }) < 70, 'a poor record lowers it');
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
