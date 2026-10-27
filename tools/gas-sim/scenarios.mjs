// scenarios.mjs — synthetic price series built so that one strategy should fire on the last bar.
// Shared by the tests and handy for exploring rule changes. Not market data.
const DAY = 86400000;

/** Weekday dates ending on endYmd (IST midnight), n of them. */
export function weekdays(endYmd, n) {
  const out = []; let t = Date.parse(endYmd + 'T00:00:00+05:30');
  while (out.length < n) { const wd = new Date(t + 5.5 * 3600000).getUTCDay(); if (wd !== 0 && wd !== 6) out.unshift(t); t -= DAY; }
  return out;
}

/** Daily candles from a list of closes. Opens at the previous close; highs/lows a little outside. */
export function dailyFrom(closes, { end = '2026-10-26', vol = 2e6, spikes = {}, wick = 0.004, opens = {} } = {}) {
  const ts = weekdays(end, closes.length);
  return closes.map((c, i) => {
    const o = opens[i] !== undefined ? opens[i] : i ? closes[i - 1] : c;
    const h = Math.max(o, c) * (1 + wick), l = Math.min(o, c) * (1 - wick);
    return { t: ts[i], o: r2(o), h: r2(h), l: r2(l), c: r2(c), v: Math.round(vol * (spikes[i] || 1)) };
  });
}
const r2 = (x) => Math.round(x * 100) / 100;

/** A deterministic random walk of closes, for long backtest histories. */
export function randomWalk(n, start, drift, vol, seed = 1) {
  let s = seed; const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const out = []; let p = start;
  for (let i = 0; i < n; i++) { p = Math.max(1, p * (1 + drift + vol * (rnd() - 0.5) * 2)); out.push(p); }
  return out;
}

/**
 * 5-minute sessions for each of the given weekday dates: 75 bars from 09:15, built by bar(k, dayIndex) → [o, h, l, c, v].
 */
export function sessions(dates, bar) {
  const out = [];
  dates.forEach((d, di) => { for (let k = 0; k < 75; k++) { const b = bar(k, di); out.push({ t: d + (555 + 5 * k) * 60000, o: b[0], h: b[1], l: b[2], c: b[3], v: b[4] }); } });
  return out;
}

/** An opening-range breakout every session: range 100–101, a high-volume close above it at 09:40, a climb to 102.6, then back to 100. */
export function orbSessions(dates) {
  return sessions(dates, (k) => {
    if (k < 3) return [[100.2, 101, 100, 100.7, 90000], [100.7, 100.9, 100.3, 100.5, 60000], [100.5, 100.8, 100.2, 100.6, 50000]][k];
    if (k < 5) return [[100.6, 100.8, 100.5, 100.7, 25000], [100.7, 100.9, 100.6, 100.8, 22000]][k - 3];
    if (k === 5) return [100.8, 101.25, 100.75, 101.2, 80000];
    if (k < 40) { const p = Math.min(102.6, 101.2 + (k - 5) * 0.06); return [r2(p - 0.05), r2(p + 0.05), r2(p - 0.1), r2(p), 20000]; }
    const p = Math.max(100, 102.6 - (k - 40) * 0.07); return [r2(p + 0.05), r2(p + 0.1), r2(p - 0.05), r2(p), 15000];
  });
}

/** Smooth trend with a tiny deterministic wiggle. */
export function trend(n, start, dailyPct, wiggle = 0.003) {
  const out = []; let p = start;
  for (let i = 0; i < n; i++) { p *= 1 + dailyPct / 100; out.push(p * (1 + wiggle * Math.sin(i * 1.7))); }
  return out;
}

export const daily = {
  'base-breakout': () => {
    const up = trend(240, 60, 0.22);
    const base = Array.from({ length: 20 }, (_, i) => up[up.length - 1] * (1 + 0.025 * Math.sin(i * 0.9)));
    const top = Math.max(...base) * 1.004;
    const closes = up.concat(base, [top * 1.004]);
    return dailyFrom(closes, { spikes: { [closes.length - 1]: 2.4 } });
  },
  'ema-pullback': () => {
    const up = trend(250, 50, 0.3, 0.002);
    const last = up[up.length - 1];
    // Two soft days, then today dips to the 20-day EMA and closes higher than it opened.
    const c = dailyFrom(up.concat([last * 0.99, last * 0.98, last * 0.975]));
    const i = c.length - 1;
    c[i].o = r2(last * 0.969); c[i].l = r2(last * 0.965); c[i].h = r2(last * 0.978);
    return c;
  },
  'rsi2': () => {
    const up = trend(250, 50, 0.25, 0.004);
    const last = up[up.length - 1];
    return dailyFrom(up.concat([last * 0.965, last * 0.935, last * 0.905]));
  },
  'macd': () => {
    const up = trend(230, 50, 0.3, 0.002);
    const last = up[up.length - 1];
    const dip = Array.from({ length: 12 }, (_, i) => last * (1 - 0.0015 * i));
    const lo = dip[dip.length - 1];
    return dailyFrom(up.concat(dip, [lo * 1.02, lo * 1.02 * 1.04]));
  },
  'trend-template': () => {
    const closes = trend(300, 40, 0.18, 0.002);
    return dailyFrom(closes);
  },
  'near-high': () => {
    const up = trend(200, 50, 0.25, 0.002);
    const hi = up[up.length - 1];
    const pull = Array.from({ length: 60 }, (_, i) => hi * (0.92 + 0.02 * Math.sin(i / 6)));
    const closes = up.concat(pull, [hi * 0.985]);
    return dailyFrom(closes, { spikes: { [closes.length - 1]: 1.6 } });
  },
  'holding-guard': () => {
    const up = trend(260, 50, 0.2, 0.002);
    return dailyFrom(up.concat([up[up.length - 1] * 0.92])); // one heavy fall through the trailing stop
  },
  flat: () => dailyFrom(Array.from({ length: 300 }, (_, i) => 100 * (1 + 0.004 * Math.sin(i)))),
};

/** 5-minute bars for the previous session (tight) and today up to a list of bars. */
export function intradayFrom(prevYmd, todayYmd, todayBars, { prevPrice = 100, prevVol = 20000 } = {}) {
  const bars = [];
  const at = (ymd, min) => Date.parse(`${ymd}T${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}:00+05:30`);
  for (let k = 0; k < 75; k++) {
    const c = prevPrice * (1 + 0.0006 * Math.sin(k / 3));
    bars.push({ t: at(prevYmd, 555 + 5 * k), o: r2(c * 0.9997), h: r2(c * 1.0008), l: r2(c * 0.9992), c: r2(c), v: prevVol });
  }
  todayBars.forEach((b, k) => bars.push({ t: at(todayYmd, 555 + 5 * k), o: b[0], h: b[1], l: b[2], c: b[3], v: b[4] }));
  return bars;
}

/** Nifty 50 5-minute bars: a flat Friday, then Monday opening at 22,600 and drifting up (dir 1) or down (dir −1). No volume, like the index. */
export function niftyIntraday(dir = 1, n = 30) {
  const t = []; let p = 22600;
  for (let k = 0; k < n; k++) { const o = p; p *= 1 + dir * 0.0004; t.push([r2(o), r2(Math.max(o, p) + 2), r2(Math.min(o, p) - 2), r2(p), 0]); }
  return intradayFrom('2026-10-23', '2026-10-26', t, { prevPrice: 22600, prevVol: 0 });
}

export const intraday = {
  // prev close 100. Opening range 15 minutes 100.0–101.0, then quiet, then a high-volume breakout.
  orb: () => intradayFrom('2026-10-23', '2026-10-26', [
    [100.2, 101.0, 100.0, 100.7, 90000], [100.7, 100.9, 100.3, 100.5, 60000], [100.5, 100.8, 100.2, 100.6, 50000],
    [100.6, 100.8, 100.5, 100.7, 25000], [100.7, 100.9, 100.6, 100.8, 22000], [100.8, 101.25, 100.75, 101.2, 80000],
  ]),
  // A strong first bar, a slide below VWAP, then a green bar reclaims VWAP.
  vwap: () => intradayFrom('2026-10-23', '2026-10-26', [
    [100.5, 102.4, 100.4, 102.2, 60000], [102.2, 102.3, 101.3, 101.4, 40000], [101.4, 101.5, 100.9, 101.0, 35000],
    [101.0, 101.1, 100.8, 100.9, 30000], [100.9, 101.0, 100.75, 100.85, 25000], [100.85, 101.4, 100.82, 101.35, 45000],
  ]),
  // Gap up 2% over the 100 close, green first bar, then a break of the morning high.
  gap: () => intradayFrom('2026-10-23', '2026-10-26', [
    [102.0, 102.6, 101.9, 102.5, 70000], [102.5, 102.6, 102.2, 102.3, 40000], [102.3, 102.9, 102.25, 102.85, 60000],
  ]),
  // A morning slide, then a turn: EMA 9 crosses above EMA 21 with price over VWAP.
  'ema-cross': () => {
    const t = [];
    let p = 100;
    for (let k = 0; k < 8; k++) { const o = p; p -= 0.05; t.push([r2(o), r2(o + 0.03), r2(p - 0.03), r2(p), 30000]); }
    for (let k = 0; k < 5; k++) { const o = p; p += 0.15; t.push([r2(o), r2(p + 0.03), r2(o - 0.03), r2(p), 40000]); }
    return intradayFrom('2026-10-23', '2026-10-26', t, { prevPrice: 100.2 });
  },
};
