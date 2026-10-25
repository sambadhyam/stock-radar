// demo.js — SAMPLE data for the Phase 0 design preview.
// Nothing here is market data. Prices, signals and results are invented to show the layout,
// and every screen that uses them carries the "Design preview" banner.
import { NSE_HOLIDAYS_2026, istParts } from './util.js';
import { ema, sma } from './charts.js';

// ---------- Deterministic random numbers ----------
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const tick = (v) => Math.round(v * 20) / 20; // NSE tick size 0.05

// ---------- Trading-day calendar ----------
function ymdOf(date) { return istParts(date).ymd; }
function isTradingDay(ymd) {
  const d = new Date(ymd + 'T12:00:00+05:30').getUTCDay();
  return d !== 0 && d !== 6 && !NSE_HOLIDAYS_2026.includes(ymd);
}
function addDays(ymd, n) {
  const d = new Date(ymd + 'T12:00:00+05:30');
  d.setUTCDate(d.getUTCDate() + n);
  return ymdOf(d);
}
/** Most recent completed trading day (today counts only after the 15:30 close). */
function lastSession(now = new Date()) {
  const p = istParts(now);
  let ymd = p.ymd;
  if (!isTradingDay(ymd) || p.minutes < 15 * 60 + 30) ymd = addDays(ymd, -1);
  while (!isTradingDay(ymd)) ymd = addDays(ymd, -1);
  return ymd;
}
function sessionsBack(endYmd, n) {
  const out = [];
  let ymd = endYmd;
  while (out.length < n) { if (isTradingDay(ymd)) out.unshift(ymd); ymd = addDays(ymd, -1); }
  return out;
}
function nextSessions(fromYmd, n) {
  let ymd = fromYmd, count = 0;
  while (count < n) { ymd = addDays(ymd, 1); if (isTradingDay(ymd)) count++; }
  return ymd;
}
const at = (ymd, hm) => new Date(`${ymd}T${hm}:00+05:30`).getTime();

// ---------- Candle builder ----------
function build(closes, { seed, vol = 0.009, volume = 8e6, spikes = {}, times }) {
  const r = rng(seed);
  let prev = closes[0] * (1 - vol * 0.3);
  return closes.map((c, i) => {
    const o = prev * (1 + (r() - 0.5) * vol * 0.8);
    const hiP = Math.max(o, c) * (1 + r() * vol * 0.75);
    const loP = Math.min(o, c) * (1 - r() * vol * 0.75);
    const v = Math.round(volume * (0.65 + r() * 0.7) * (spikes[i] || 1));
    prev = c;
    return { t: times[i], o: tick(o), h: tick(hiP), l: tick(loP), c: tick(c), v };
  });
}
function walk(n, { seed, start, drift = 0, noise = 0.01, path }) {
  const r = rng(seed);
  const out = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    const gauss = Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r());
    p = path ? path(i) * (1 + gauss * noise * 0.5) : p * (1 + drift + gauss * noise);
    out.push(p);
  }
  return out;
}

// ---------- Build the sample world ----------
const S = lastSession();
const days = (n) => sessionsBack(S, n).map((d) => at(d, '15:30'));

function chartReliance() {
  const n = 60;
  const closes = walk(n, { seed: 11, path: (i) => 1423 + 19 * Math.sin(i / 3.1) }).map((v) => Math.min(1446, Math.max(1401, v)));
  closes[56] = 1436.2; closes[57] = 1441.8; closes[58] = 1446.4; closes[59] = 1458.4;
  return build(closes, { seed: 12, vol: 0.008, volume: 9.5e6, spikes: { 59: 1.8 }, times: days(n) });
}
function chartIcici() {
  const times = Array.from({ length: 18 }, (_, i) => at(S, '09:15') + i * 5 * 60000);
  const closes = [1401.2, 1404.8, 1403.1, 1404.0, 1405.6, 1405.1, 1408.2, 1409.4, 1408.8, 1410.3, 1411.0, 1410.2, 1412.6, 1413.4, 1412.1, 1414.0, 1413.2, 1415.1];
  return build(closes, { seed: 21, vol: 0.0012, volume: 4.2e5, spikes: { 0: 1.9, 6: 2.1 }, times });
}
function chartSunpharma() {
  const n = 170;
  const closes = walk(n, { seed: 31, path: (i) => 1440 + i * 1.5 + 26 * Math.sin(i / 9) });
  closes[n - 1] = 1702.6;
  return build(closes, { seed: 32, vol: 0.009, volume: 3.1e6, times: days(n) });
}
function chartTitan() {
  const n = 60;
  const closes = walk(n, { seed: 41, path: (i) => (i < 53 ? 3300 + i * 6.1 : 3623 - (i - 53) * 16) });
  closes[n - 1] = 3556.0;
  return build(closes, { seed: 42, vol: 0.008, volume: 1.4e6, times: days(n) });
}
function chartInfy() {
  const n = 320;
  const closes = walk(n, { seed: 51, path: (i) => (i < 230 ? 1430 + i * 0.85 + 30 * Math.sin(i / 17) : 1625 - (i - 230) * 1.7) });
  closes[n - 1] = 1468.2;
  return build(closes, { seed: 52, vol: 0.011, volume: 6e6, times: days(n) });
}
function generic(seed, start, drift, n = 60) {
  const closes = walk(n, { seed, start, drift, noise: 0.011 });
  return build(closes, { seed: seed + 1, vol: 0.01, volume: 5e6, times: days(n) });
}

const charts = {
  RELIANCE: chartReliance(), ICICIBANK: chartIcici(), SUNPHARMA: chartSunpharma(),
  TITAN: chartTitan(), INFY: chartInfy(), HDFCBANK: generic(61, 1680, 0.0012), LT: generic(71, 3650, -0.0004),
};

const tail = (arr, n) => arr.slice(-n);

/** Prepend earlier sample sessions so a short series has a full year of history. */
function extendBack(candles, total, seed) {
  if (candles.length >= total) return candles;
  const m = total - candles.length;
  const firstYmd = ymdOf(new Date(candles[0].t));
  const dates = sessionsBack(addDays(firstYmd, -1), m).map((d) => at(d, '15:30'));
  // Walk backwards from the first open, then flip so the series flows into the existing candles.
  const back = walk(m, { seed, start: candles[0].o, drift: -0.0004, noise: 0.009 }).reverse();
  const avgVol = candles.reduce((a, c) => a + (c.v || 0), 0) / candles.length;
  return build(back, { seed: seed + 1, vol: 0.009, volume: avgVol, times: dates }).concat(candles);
}
function overlayEma(candles, period, show) {
  return tail(ema(candles.map((c) => c.c), period), show);
}
function overlaySma(candles, period, show) {
  return tail(sma(candles.map((c) => c.c), period), show);
}
function vwap(candles) {
  let pv = 0, vv = 0;
  return candles.map((c) => { const tp = (c.h + c.l + c.c) / 3; pv += tp * c.v; vv += c.v; return pv / vv; });
}

// ---------- Strategies ----------
const STRATEGIES = [
  { id: 'ema-pullback', name: 'Pullback to 20 EMA', horizon: 'swing', status: 'live', trades: 41,
    outcomes: 'WWLWXWWLWWLWWXWLWWLWWWLXWLWWLW', win: 61, avg: 0.84, pf: 1.62, vsNifty: 4.1,
    backtest: { win: 58, avg: 0.71, pf: 1.48, dd: -8.2 }, paperDd: -4.1 },
  { id: 'base-breakout', name: 'Base breakout', horizon: 'swing', status: 'paper', trades: 17,
    outcomes: 'WLWWLXWLLWWXWLWWL', avg: 0.51, pf: 1.34, vsNifty: 1.2, backtest: { win: 49, avg: 0.62, pf: 1.41, dd: -11.5 }, paperDd: -5.6 },
  { id: 'rsi2', name: 'RSI(2) dip in uptrend', horizon: 'swing', status: 'paper', trades: 12,
    outcomes: 'WWLWWXWLWWLW', avg: 0.66, pf: 1.71, vsNifty: 2.4, backtest: { win: 66, avg: 0.48, pf: 1.52, dd: -7.4 }, paperDd: -2.2 },
  { id: 'macd', name: 'MACD trend cross', horizon: 'swing', status: 'rejected', trades: 31,
    outcomes: 'LWLLXLWLLWLXLLWLLWXLLWLLWLXLWL', win: 29, avg: -0.38, pf: 0.81, vsNifty: -3.6, backtest: { win: 44, avg: 0.12, pf: 1.06, dd: -14.8 }, paperDd: -9.3 },
  { id: 'orb', name: 'Opening-range breakout', horizon: 'intraday', status: 'paper', trades: 14,
    outcomes: 'WLLWXWWLWLWXLW', avg: 0.12, pf: 1.12, vsNifty: 0.3, backtest: { win: 47, avg: 0.09, pf: 1.08, dd: -6.1 }, paperDd: -2.9 },
  { id: 'vwap', name: 'VWAP reclaim', horizon: 'intraday', status: 'paper', trades: 9,
    outcomes: 'LWWLXLWLW', avg: 0.04, pf: 1.03, vsNifty: -0.1, backtest: { win: 45, avg: 0.05, pf: 1.04, dd: -7.0 }, paperDd: -1.8 },
  { id: 'ema-cross', name: 'EMA 9/21 cross', horizon: 'intraday', status: 'paper', trades: 22,
    outcomes: 'WLLWLWXLWWLLWXLWWLLWLW', avg: -0.02, pf: 0.98, vsNifty: -0.4, backtest: { win: 43, avg: 0.02, pf: 1.01, dd: -9.9 }, paperDd: -3.7 },
  { id: 'gap', name: 'Gap and go', horizon: 'intraday', status: 'paper', trades: 5,
    outcomes: 'WXWLW', avg: 0.31, pf: 1.55, vsNifty: 0.6, backtest: { win: 51, avg: 0.14, pf: 1.17, dd: -5.2 }, paperDd: -0.9 },
  { id: 'trend-template', name: 'Trend template', horizon: 'medium', status: 'paper', trades: 6,
    outcomes: 'WWXLWW', avg: 3.9, pf: 2.1, vsNifty: 2.8, backtest: { win: 52, avg: 4.4, pf: 1.86, dd: -13.1 }, paperDd: -3.4 },
  { id: 'rs-leaders', name: 'Relative strength leaders', horizon: 'medium', status: 'paper', trades: 4,
    outcomes: 'WLWX', avg: 1.7, pf: 1.4, vsNifty: 0.9, backtest: { win: 50, avg: 3.1, pf: 1.62, dd: -15.6 }, paperDd: -4.0 },
  { id: 'near-high', name: 'Near 52-week high', horizon: 'medium', status: 'paper', trades: 3,
    outcomes: 'WWL', avg: 2.2, pf: 1.9, vsNifty: 1.1, backtest: { win: 48, avg: 2.6, pf: 1.44, dd: -16.2 }, paperDd: -2.5 },
  { id: 'quality-value', name: 'Quality-value score', horizon: 'long', status: 'paper', trades: 0,
    outcomes: '', avg: null, pf: null, vsNifty: null, backtest: { win: 57, avg: 14.2, pf: 2.3, dd: -24.0 }, paperDd: null },
  { id: 'holding-guard', name: 'Holding guard', horizon: 'long', status: 'paper', trades: 2,
    outcomes: 'WX', avg: 1.1, pf: null, vsNifty: null, backtest: { win: 54, avg: 2.9, pf: 1.5, dd: -9.0 }, paperDd: null },
];
for (const st of STRATEGIES) {
  if (st.win == null) {
    const o = st.outcomes.split('');
    st.win = o.length ? Math.round((o.filter((c) => c === 'W').length / o.length) * 100) : null;
  }
}
const byId = Object.fromEntries(STRATEGIES.map((st) => [st.id, st]));

// ---------- Alerts ----------
const prev = sessionsBack(S, 6);
const ALERTS = [
  {
    id: 'a1', symbol: 'ICICIBANK', horizon: 'intraday', strategy: 'orb', dir: 'buy', time: at(S, '09:47'),
    entryLo: 1407, entryHi: 1409, stop: 1401.5, targets: [1420], confidence: 58, validTill: at(S, '15:15'),
    chart: { candles: charts.ICICIBANK, mode: 'intraday', overlays: [{ key: 'vwap', values: vwap(charts.ICICIBANK) }] },
    why: [
      'Broke above the first 15-minute range high of ₹1,406.50',
      'Breakout candle volume is 2.1× the session average',
      'Price is above VWAP and Nifty is positive for the day',
    ],
  },
  {
    id: 'a2', symbol: 'RELIANCE', horizon: 'swing', strategy: 'base-breakout', dir: 'buy', time: at(S, '16:05'),
    entryLo: 1452, entryHi: 1460, stop: 1428, targets: [1520, 1560], confidence: 66, validTill: at(nextSessions(S, 2), '15:30'),
    chart: { candles: charts.RELIANCE, mode: 'day', overlays: [{ key: 'ema20', values: overlayEma(charts.RELIANCE, 20, 60) }] },
    why: [
      'Closed above its 12-week range high of ₹1,446',
      'Volume was 1.8× its 20-day average',
      'Nifty is above its 50 and 200-day averages',
    ],
  },
  {
    id: 'a3', symbol: 'TITAN', horizon: 'swing', strategy: 'ema-pullback', dir: 'buy', time: at(S, '16:05'),
    entryLo: 3550, entryHi: 3565, stop: 3492, targets: [3690, 3760], confidence: 74, validTill: at(nextSessions(S, 2), '15:30'),
    chart: { candles: charts.TITAN, mode: 'day', overlays: [{ key: 'ema20', values: overlayEma(charts.TITAN, 20, 60) }] },
    why: [
      'Pulled back to its rising 20-day EMA after a 9% run',
      'Closed as a bullish reversal candle at the EMA',
      'This strategy has a 61% win rate over 41 paper trades',
    ],
  },
  {
    id: 'a4', symbol: 'SUNPHARMA', horizon: 'medium', strategy: 'trend-template', dir: 'buy', time: at(S, '16:05'),
    entryLo: 1690, entryHi: 1708, stop: 1612, targets: [1880], confidence: 71, validTill: at(nextSessions(S, 3), '15:30'),
    chart: { candles: tail(charts.SUNPHARMA, 120), mode: 'day', overlays: [{ key: 'sma50', values: overlaySma(charts.SUNPHARMA, 50, 120) }] },
    why: [
      'Price is above its 50, 150 and 200-day averages, all rising',
      'Relative strength is in the top 8% of Nifty 200',
      'Trading 3% below its 52-week high',
    ],
  },
  {
    id: 'a5', symbol: 'INFY', horizon: 'long', strategy: 'holding-guard', dir: 'exit', time: at(S, '16:05'),
    lastPrice: 1468.2, dma200: tail(sma(charts.INFY.map((c) => c.c), 200), 1)[0], confidence: 63,
    headline: 'Closed below its 200-day average',
    chart: { candles: tail(charts.INFY, 120), mode: 'day', overlays: [{ key: 'sma200', values: overlaySma(charts.INFY, 200, 120) }] },
    why: [
      'Closed below its 200-day average for the second session',
      'Down 9.6% from its 3-month high',
      'You hold this stock in your imported portfolio',
    ],
  },
  {
    id: 'a6', symbol: 'HDFCBANK', horizon: 'swing', strategy: 'rsi2', dir: 'buy', time: at(prev[1], '16:05'),
    entryLo: 1648, entryHi: 1656, stop: 1621, targets: [1704], confidence: 62, validTill: at(prev[3], '15:30'),
    outcome: { state: 'target', pct: 3.1 },
    chart: { candles: charts.HDFCBANK, mode: 'day', overlays: [{ key: 'ema20', values: overlayEma(charts.HDFCBANK, 20, 60) }] },
    why: [
      'RSI(2) fell below 10 while price stayed above its 200-day average',
    ],
  },
  {
    id: 'a7', symbol: 'LT', horizon: 'swing', strategy: 'macd', dir: 'buy', time: at(prev[0], '16:05'),
    entryLo: 3612, entryHi: 3625, stop: 3561, targets: [3760], confidence: 41, validTill: at(prev[2], '15:30'),
    outcome: { state: 'stop', pct: -1.4 },
    chart: { candles: charts.LT, mode: 'day', overlays: [] },
    why: [
      'MACD crossed above its signal line with price above the 50-day average',
    ],
  },
];
for (const a of ALERTS) {
  const st = byId[a.strategy];
  a.status = st.status;
  a.strategyName = st.name;
  if (a.dir !== 'exit') {
    const mid = (a.entryLo + a.entryHi) / 2;
    a.rr = (a.targets[0] - mid) / (mid - a.stop);
  }
}

// ---------- Paper account ----------
function equityCurve() {
  const n = 46;
  const r = rng(91);
  const pts = [];
  let v = 100000;
  const dates = sessionsBack(S, n);
  for (let i = 0; i < n; i++) {
    if (i > 0) v *= 1 + (r() - 0.46) * 0.012;
    pts.push({ t: at(dates[i], '15:30'), v });
  }
  const scale = (103420 - 100000) / (pts[n - 1].v - 100000);
  return pts.map((p, i) => ({ t: p.t, v: i === 0 ? 100000 : 100000 + (p.v - 100000) * scale }));
}

const PAPER = {
  start: 100000, value: 103420, today: 820,
  curve: equityCurve(),
  open: [
    { symbol: 'RELIANCE', strategy: 'base-breakout', horizon: 'swing', entry: 1456, now: 1458.4, qty: 41 },
    { symbol: 'TITAN', strategy: 'ema-pullback', horizon: 'swing', entry: 3557.5, now: 3556, qty: 15 },
    { symbol: 'SUNPHARMA', strategy: 'trend-template', horizon: 'medium', entry: 1699, now: 1702.6, qty: 11 },
  ],
  closed: [
    { symbol: 'ICICIBANK', strategy: 'orb', horizon: 'intraday', state: 'expired', pct: 0.31, when: S },
    { symbol: 'HDFCBANK', strategy: 'rsi2', horizon: 'swing', state: 'target', pct: 3.1, when: prev[4] },
    { symbol: 'LT', strategy: 'macd', horizon: 'swing', state: 'stop', pct: -1.4, when: prev[3] },
    { symbol: 'BHARTIARTL', strategy: 'ema-pullback', horizon: 'swing', state: 'target', pct: 2.6, when: prev[2] },
    { symbol: 'TCS', strategy: 'vwap', horizon: 'intraday', state: 'stop', pct: -0.48, when: prev[1] },
  ],
};

// ---------- Screeners ----------
const SCAN = {
  long: [
    { symbol: 'HDFCBANK', sector: 'Banks', score: 82, complete: 100, line: 'ROE 17%, profit growth 15% a year, PE below its 5-year median' },
    { symbol: 'ITC', sector: 'FMCG', score: 79, complete: 100, line: 'Debt-free, ROCE 37%, steady dividends' },
    { symbol: 'INFY', sector: 'IT', score: 76, complete: 92, line: 'ROE 29%, strong free cash flow, PE near its median' },
    { symbol: 'SUNPHARMA', sector: 'Pharma', score: 74, complete: 100, line: 'Sales growth 11% a year, low debt, no promoter pledge' },
    { symbol: 'ASIANPAINT', sector: 'Paints', score: 71, complete: 83, line: 'ROCE 31%, but PE above its 5-year median' },
    { symbol: 'MARUTI', sector: 'Auto', score: 68, complete: 92, line: 'Net cash, profit growth 18% a year' },
  ],
  etfs: [
    { symbol: 'NIFTYBEES', sector: 'Nifty 50 ETF' },
    { symbol: 'JUNIORBEES', sector: 'Nifty Next 50 ETF' },
    { symbol: 'GOLDBEES', sector: 'Gold ETF' },
  ],
  medium: [
    { symbol: 'SUNPHARMA', sector: 'Pharma', score: 92, line: 'Relative strength in the top 8%, 3% below its 52-week high' },
    { symbol: 'BHARTIARTL', sector: 'Telecom', score: 89, line: 'All averages rising, new high last week' },
    { symbol: 'TITAN', sector: 'Consumer', score: 84, line: 'Above all averages, pulling back on light volume' },
    { symbol: 'BAJFINANCE', sector: 'Finance', score: 81, line: 'Top 15% strength, 6% below its 52-week high' },
  ],
  swing: [
    { symbol: 'TATASTEEL', sector: 'Metals', score: 78, line: 'Five-week base, 1.2% below the breakout level' },
    { symbol: 'AXISBANK', sector: 'Banks', score: 73, line: 'Near its rising 20-day EMA after a 7% run' },
    { symbol: 'HINDUNILVR', sector: 'FMCG', score: 66, line: 'RSI(2) at 12, above its 200-day average' },
  ],
};

const FUNDAMENTALS = {
  HDFCBANK: { roe: 17.1, roce: null, de: null, sales3y: 19.8, profit3y: 15.2, promoter: 0, pledge: 0, pe: 18.9, pe5y: 21.4, fcf: 'Positive' },
};

export const demo = {
  isDemo: true,
  asOf: at(S, '15:30'),
  session: S,
  market: { regime: 'bull', nifty: 25410.2, niftyChg: 0.62, vix: 12.4, vixChg: -3.1, breadth: 64 },
  engine: { source: 'Angel One', lastCheck: at(S, '15:30'), fallbacks: [{ name: 'Google Finance', state: 'ok' }, { name: 'Yahoo Finance', state: 'off' }] },
  strategies: STRATEGIES,
  strategy: (id) => byId[id],
  alerts: ALERTS,
  alert: (id) => ALERTS.find((a) => a.id === id),
  paper: PAPER,
  scan: SCAN,
  fundamentals: FUNDAMENTALS,
  charts,
  stockChart(symbol) {
    const seed = symbol.split('').reduce((a, ch) => a + ch.charCodeAt(0), 0);
    const base = charts[symbol] || generic(seed, 1000 + symbol.length * 180, 0.0009, 260);
    const c = extendBack(base, 260, seed + 7);
    return { candles: tail(c, 120), sma50: overlaySma(c, 50, 120), sma200: overlaySma(c, 200, 120), all: c };
  },
  reportDue(n) { return Date.now() + n * 86400000; },
};
