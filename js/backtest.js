// backtest.js — the Backtest lab's data and runs. Price history comes from the engine in small parts and is kept
// on this phone (IndexedDB), so later tests start at once; each test runs core.js in a background worker.
import { api } from './api.js';
import { idb } from './idb.js';

const DAILY_CHUNK = 10, INTRA_CHUNK = 4;
let overview = null, overviewAt = 0;

/** The engine's backtest result, stock lists and strategy settings (cached for a few minutes). */
export async function loadOverview(force = false) {
  if (!force && overview && Date.now() - overviewAt < 5 * 60000) return overview;
  const o = await api.backtest();
  overview = o; overviewAt = Date.now();
  const run = o.result ? o.result.runId : '';
  if (run) idb.keepOnly(run + '|'); // drop history kept for an older run
  return o;
}
export function cachedOverview() { return overview; }

/** Every trade of the baseline run (about 25,000 short rows), kept on this phone once loaded. */
export async function loadTrades(runId) {
  const key = runId + '|trades';
  const kept = await idb.get(key);
  if (kept && kept.rows) return kept;
  const data = await api.btTrades();
  if (!data || !data.rows) throw new Error('The engine has no backtest trades yet.');
  if (data.runId === runId) await idb.set(key, data);
  return data;
}

async function fetchParts(kind, runId, symbols, chunk, onProgress) {
  const prefix = runId + '|' + kind.charAt(0) + '|', out = { series: {}, rs: {}, market: await idb.get(prefix + 'market') };
  const need = [];
  for (const s of symbols) {
    const v = await idb.get(prefix + s);
    if (v) { out.series[s] = v.series; if (v.rs) out.rs[s] = v.rs; } else need.push(s);
  }
  const total = need.length;
  let done = 0;
  if (!out.market && !need.length) need.push(...symbols.slice(0, 1));
  for (let i = 0; i < need.length; i += chunk) {
    const part = need.slice(i, i + chunk);
    const r = await api.btData(kind, part, !out.market);
    if (r.market) { out.market = r.market; await idb.set(prefix + 'market', r.market); }
    for (const s of Object.keys(r.series || {})) {
      out.series[s] = r.series[s];
      if (r.rs && r.rs[s]) out.rs[s] = r.rs[s];
      await idb.set(prefix + s, { series: r.series[s], rs: r.rs ? r.rs[s] : null });
    }
    done += part.length;
    onProgress({ phase: 'download', done: Math.min(done, total), total });
  }
  return out;
}

/**
 * Run one strategy over a list of stocks.
 * job: {kind: 'daily'|'intraday', strategy, symbols, years, respectRegime, rules, params, sizing, rates, lab}
 * onProgress({phase: 'download'|'test', done, total}). Resolves to the worker's summary.
 */
export async function runBacktest(job, onProgress = () => {}) {
  const o = await loadOverview();
  if (!o.result) throw new Error('The engine has no backtest data yet. Start the backtest first.');
  const runId = o.result.runId, intraday = job.kind === 'intraday';
  const data = await fetchParts(job.kind, runId, job.symbols, intraday ? INTRA_CHUNK : DAILY_CHUNK, onProgress);
  if (!Object.keys(data.series).length) throw new Error('No price history for these stocks yet.');
  const msg = { id: Date.now(), kind: job.kind, strategy: job.strategy, series: data.series, rs: data.rs, market: data.market, params: job.params, sizing: job.sizing, rates: job.rates, lab: job.lab, rules: job.rules, respectRegime: job.respectRegime };
  if (!intraday && job.years > 0) { // 0 means all the history the engine holds
    const days = data.market.days, last = days[days.length - 1];
    msg.fromDay = last - Math.round(job.years * 365.25);
  }
  return new Promise((resolve, reject) => {
    let worker;
    try { worker = new Worker(new URL('./bt-worker.js', import.meta.url)); } catch (e) { reject(new Error('This browser cannot run background work.')); return; }
    worker.onmessage = (e) => {
      const r = e.data;
      if (r.type === 'progress') onProgress({ phase: 'test', done: r.done, total: r.total });
      else { worker.terminate(); if (r.type === 'done') resolve(r.result); else reject(new Error(r.message)); }
    };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message || 'The test stopped with an error.')); };
    worker.postMessage(msg);
  });
}

/**
 * Rough download size for the first test on a list, in MB (later tests use the copy on this phone).
 * span: years of daily history, or sessions of 5-minute history, that the engine holds.
 */
export function downloadEstimateMb(kind, n, span) {
  return Math.max(0.1, kind === 'intraday' ? n * 0.17 * Math.max(1, span || 60) / 60 : n * 0.011 * Math.max(1, span || 10));
}
