// bt-worker.js — runs a backtest in the background with the same core.js the engine uses, so the screen
// never freezes and the numbers follow exactly the rules of the live paper record.
/* global importScripts, SRCore */
importScripts('../core/core.js');

const REG = { U: 'UNKNOWN', B: 'BULL', N: 'NEUTRAL', R: 'BEAR', H: 'HIGH_VOL' };
// yyyymmdd → midnight IST in milliseconds (the engine's day convention)
const dayMs = (d) => Date.UTC(Math.floor(d / 10000), (Math.floor(d / 100) % 100) - 1, d % 100) - 330 * 60000;

self.onmessage = (e) => {
  const m = e.data;
  try {
    const result = m.kind === 'intraday' ? runIntraday(m) : runDaily(m);
    self.postMessage({ type: 'done', id: m.id, result });
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String((err && err.message) || err) });
  }
};

function progress(m, done, total) { self.postMessage({ type: 'progress', id: m.id, done, total }); }

function runDaily(m) {
  const C = SRCore, P = C.params(m.params);
  const ctx = { days: m.market.days, regime: m.market.regime.split('').map((ch) => REG[ch] || 'UNKNOWN'), niftyClose: m.market.niftyClose, rs: m.rs };
  const syms = Object.keys(m.series), trades = [], counts = { open: 0, notTriggered: 0, symbols: 0 };
  syms.forEach((s, k) => {
    const col = m.series[s];
    const candles = col.d.map((d, i) => ({ t: dayMs(d), o: col.o[i], h: col.h[i], l: col.l[i], c: col.c[i], v: col.v[i] }));
    const r = C.backtestDaily(s, candles, { params: P, strategies: [m.strategy], ctx, sizing: m.sizing, rates: m.rates, from: m.fromDay, ignoreRegime: !m.respectRegime });
    for (const t of r.trades) trades.push(t);
    counts.open += r.open; counts.notTriggered += r.notTriggered; counts.symbols++;
    if (k % 4 === 3 || k === syms.length - 1) progress(m, k + 1, syms.length);
  });
  return summarise(trades, counts, m);
}

function runIntraday(m) {
  const C = SRCore, P = C.params(m.params);
  const bars = (col) => col.t.map((t, i) => ({ t: t * 60000, o: col.o[i], h: col.h[i], l: col.l[i], c: col.c[i], v: col.v[i] }));
  const nifty = m.market.nifty ? bars(m.market.nifty) : null, regimeByDay = {};
  for (const d of Object.keys(m.market.regimeByDay)) regimeByDay[d] = REG[m.market.regimeByDay[d]] || 'UNKNOWN';
  const syms = Object.keys(m.series), trades = [], counts = { open: 0, notTriggered: 0, symbols: 0 };
  syms.forEach((s, k) => {
    const r = C.backtestIntraday(s, bars(m.series[s]), {
      params: P, strategies: [m.strategy], niftyBars: nifty, regimeByDay, followNifty: m.rules.followNifty,
      block: { BUY: m.rules.blockBuysInBear ? ['BEAR'] : [], SHORT: m.rules.blockShortsInBull ? ['BULL'] : [] },
      onePerStock: m.rules.onePerStock, cooldownMinutes: m.lab.cooldownMinutes, lastEntryMinute: m.lab.lastEntryMinute,
      expiryMinute: m.lab.expiryMinute, sizing: m.sizing, rates: m.rates,
    });
    for (const t of r.trades) trades.push(t);
    counts.open += r.open; counts.notTriggered += r.notTriggered; counts.symbols++;
    progress(m, k + 1, syms.length);
  });
  return summarise(trades, counts, m);
}

function summarise(trades, counts, m) {
  const C = SRCore, cap = m.sizing.capital;
  const main = trades.filter((t) => t.track === 'main'), shadow = trades.filter((t) => t.track === 'shadow');
  main.sort((a, b) => a.exitT - b.exitT);
  const s = C.btSummary(main, { capital: cap }), sh = C.metrics(shadow, { capital: cap });
  return {
    metrics: s.metrics, regimes: s.regimes, years: s.years, curve: s.curve, maxOpen: s.maxOpen, cagrPct: s.cagrPct, from: s.from, to: s.to, counts,
    shadow: { trades: sh.trades, winRatePct: sh.winRatePct, expectancyPct: sh.expectancyPct, profitFactor: sh.profitFactor },
    sample: main.slice(-40).reverse().map((t) => [t.symbol, t.dayT, t.direction === 'SHORT' ? 'S' : 'B', t.outcome.charAt(0), t.netPct, t.exitT]),
  };
}
