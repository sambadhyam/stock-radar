// data.js — single place screens get their data from.
// Not connected: the clearly labelled sample data from demo.js (screens show the preview banner).
// Connected: the engine's bundle, in the same shape, cached on the phone so the app opens instantly
// and works offline; a fresh copy is fetched in the background.
import { demo } from './demo.js';
import { store } from './util.js';
import { api, isConnected } from './api.js';
import { sma, ema } from './charts.js';

const KEY = 'sr.bundle';
const REFRESH_MS = 5 * 60 * 1000;
const listeners = new Set();
let live = null;
let status = { loading: false, error: null, kind: null, at: 0 };
let inflight = null;

/** Add helper functions to a bundle so it reads like the sample data. */
function adapt(b) {
  if (!b || !Array.isArray(b.alerts) || !Array.isArray(b.strategies)) return null;
  const byId = Object.fromEntries(b.strategies.map((st) => [st.id, st]));
  const unknown = (id) => ({ id, name: id, horizon: 'swing', status: 'paper', trades: 0, outcomes: '', win: null, avg: null, pf: null, vsNifty: null, backtest: null, paperDd: null });
  return {
    ...b,
    isDemo: false,
    strategy: (id) => byId[id] || unknown(id),
    alert: (id) => b.alerts.find((a) => a.id === id),
    stockChart: () => null, // loaded on demand with loadStockChart()
    reportDue: (n) => (b.paperStart ? Date.parse(b.paperStart + 'T16:00:00+05:30') + n * 86400000 : null),
    fundamentals: b.fundamentals || {},
    scan: { long: [], medium: [], swing: [], etfs: [], ...(b.scan || {}) },
    // Phase 5 (absent from older engines, so the screens get safe defaults)
    backtest: b.backtest || { state: 'none' },
    portfolio: b.portfolio || null,
    ai: b.ai || { enabled: false, key: false },
    params: b.params || {},
    labSettings: b.labSettings || null,
    review: b.review || null,
    alertsTotal: b.alertsTotal || (b.alerts ? b.alerts.length : 0),
    held: Array.isArray(b.held) ? b.held : [], // engine 0.6.5+: setups the market filter held back (paper only)
  };
}

const cached = isConnected() ? adapt(store.get(KEY, null)) : null;
if (cached) live = cached;

export function getData() { return (isConnected() && live) || demo; }

/** What the data layer is doing, for the "updated" line and error notes. */
export function dataStatus() {
  return { connected: isConnected(), live: !!(isConnected() && live), updatedAt: live ? live.updatedAt : null, ...status };
}

export function onData(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const notify = () => listeners.forEach((fn) => { try { fn(); } catch (e) { /* a screen failed to redraw */ } });

/** Fetch a fresh bundle. Resolves to true when new data arrived. Never throws. */
export function refresh() {
  if (!isConnected()) return Promise.resolve(false);
  if (inflight) return inflight;
  status = { ...status, loading: true };
  notify();
  inflight = api.bundle().then((b) => {
    const a = adapt(b);
    if (!a) throw new Error('The engine sent incomplete data.');
    live = a;
    store.set(KEY, b);
    status = { loading: false, error: null, kind: null, at: Date.now() };
    return true;
  }).catch((e) => {
    status = { loading: false, error: e.message || String(e), kind: e.kind || 'engine', at: Date.now() };
    return false;
  }).finally(() => { inflight = null; notify(); });
  return inflight;
}

/** Forget the engine's data (after disconnecting or changing the connection). */
export function clearLive() {
  live = null;
  store.set(KEY, null);
  status = { loading: false, error: null, kind: null, at: 0 };
  notify();
}

/** Refresh when the app comes back to the screen and every few minutes while it is open. */
export function startAutoRefresh() {
  const due = () => !status.loading && Date.now() - Math.max(status.at, live ? live.updatedAt || 0 : 0) > REFRESH_MS;
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && due()) refresh(); });
  setInterval(() => { if (document.visibilityState === 'visible' && due()) refresh(); }, 60 * 1000);
  if (isConnected()) refresh();
}

// ---------- Charts on demand ----------
const chartCache = new Map();
const toCandles = (rows) => rows.map((r) => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }));
const tail = (arr, n) => arr.slice(-n);

async function fetchCandles(symbol, alertId) {
  const key = symbol + '|' + (alertId || '');
  if (chartCache.has(key)) return chartCache.get(key);
  const res = await api.chart(symbol, alertId);
  const out = { mode: res.mode, all: toCandles(res.candles || []) };
  chartCache.set(key, out);
  return out;
}

/** Chart for an alert's sheet: {candles, mode, overlays: [{key, values}]}, or null when there is no data. */
export async function loadAlertChart(a) {
  const { mode, all } = await fetchCandles(a.symbol, a.horizon === 'intraday' ? a.id : '');
  if (!all.length) return null;
  if (mode === 'intraday') {
    let pv = 0, vv = 0;
    const vw = all.map((c) => { const tp = (c.h + c.l + c.c) / 3; pv += tp * (c.v || 0); vv += c.v || 0; return vv ? pv / vv : tp; });
    return { mode, candles: all, overlays: [{ key: 'vwap', values: vw }] };
  }
  const closes = all.map((c) => c.c), show = a.horizon === 'swing' ? 60 : 120;
  const key = a.horizon === 'swing' ? 'ema20' : a.horizon === 'medium' ? 'sma50' : 'sma200';
  const values = key === 'ema20' ? ema(closes, 20) : sma(closes, key === 'sma50' ? 50 : 200);
  return { mode: 'day', candles: tail(all, show), overlays: [{ key, values: tail(values, show) }] };
}

/** Chart for the stock sheet, in the same shape as demo.stockChart(). */
export async function loadStockChart(symbol) {
  const { all } = await fetchCandles(symbol, '');
  if (!all.length) return null;
  const closes = all.map((c) => c.c);
  return { candles: tail(all, 120), sma50: tail(sma(closes, 50), 120), sma200: all.length >= 200 ? tail(sma(closes, 200), 120) : null, all };
}
