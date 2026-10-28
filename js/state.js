// state.js — user settings, kept on this phone. When the engine is connected, its settings win and are saved there too.
import { store } from './util.js';

export const APP_VERSION = '0.6.9';
/** The oldest engine (SR_VERSION in Data.gs) whose settings and data this app fully understands. */
export const ENGINE_NEEDED = '0.6.0';

/** True when version a (like "0.5.1") is older than version b. */
export function olderVersion(a, b) {
  const x = String(a || '0').split('.').map(Number), y = String(b || '0').split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d < 0;
  }
  return false;
}

export const DEFAULTS = Object.freeze({
  theme: 'system',          // 'system' | 'light' | 'dark'
  realCapital: 100000,      // ₹ used for real position sizing in alert cards
  paperCapital: 100000,     // ₹ virtual capital for paper trading
  riskPct: 1,               // % of capital lost if a stop-loss is hit
  maxPerStockPct: 10,       // % cap on capital in a single stock
  watchlist: ['RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'TITAN'],
  telegram: true,
  emailDigest: true,
  paperAlerts: true,
  alertsOnlyTested: true,   // Telegram alerts only from strategies that did not lose money in the backtest
  intradayFollowNifty: true,       // buys only while Nifty 50 is above today's open, shorts only below
  intradayBlockBuysInBear: false,  // no intraday buys on Bear-regime days
  intradayBlockShortsInBull: false,// no intraday shorts on Bull-regime days
  intradayOneAlertPerStock: true,  // one intraday alert per stock per day
  portfolioMaxStockPct: 20, // warn when one holding is above this share of the portfolio
  portfolioMaxSectorPct: 35,// warn when one sector is above this share
  backtestYears: 10,        // years of daily history the engine loads for backtests
  intradayHistoryDays: 60,  // sessions of 5-minute history kept for intraday backtests
  backtestMinutesPerDay: 30,// most trigger minutes the backtest uses in 24 hours (Google allows 90 in all)
  aiSummaries: false,       // AI news summaries (Gemini key needed in the sheet)
  sessionReview: true,      // the session review on Telegram after the closing summary
  strategiesOff: [],        // strategy ids switched off
  backendUrl: '',
  token: '',
});

export const LIMITS = Object.freeze({
  realCapital: [1000, 1e10],
  paperCapital: [1000, 1e10],
  riskPct: [0.1, 5],
  maxPerStockPct: [1, 100],
  portfolioMaxStockPct: [5, 100],
  portfolioMaxSectorPct: [10, 100],
  backtestYears: [3, 15],
  intradayHistoryDays: [20, 120],
  backtestMinutesPerDay: [10, 40],
  watchlistMax: 10,
});

const KEY = 'sr.settings';
let settings = { ...DEFAULTS, ...(store.get(KEY, {}) || {}) };
const listeners = new Set();

export function getSettings() { return settings; }

export function saveSettings(patch) {
  settings = { ...settings, ...patch };
  store.set(KEY, settings);
  // Theme is also kept as a plain key so index.html can apply it before first paint.
  store.setRaw('sr.theme', settings.theme);
  applyLook();
  listeners.forEach((fn) => fn(settings));
  return settings;
}

export function onSettings(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** Apply the theme to the document. */
export function applyLook() {
  const root = document.documentElement;
  if (settings.theme === 'light' || settings.theme === 'dark') root.setAttribute('data-theme', settings.theme);
  else root.removeAttribute('data-theme');
  const dark = effectiveTheme() === 'dark';
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', dark ? '#0E252C' : '#EDF2F1'));
}

/** 'light' | 'dark' after resolving 'system'. */
export function effectiveTheme() {
  if (settings.theme === 'light' || settings.theme === 'dark') return settings.theme;
  try { return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; } catch (e) { return 'light'; }
}

/** Real position size from the user's settings. Returns null when the plan is invalid. */
export function positionSize(entry, stop, s = settings) {
  const riskPerShare = Math.abs(entry - stop);
  if (!(entry > 0) || !(riskPerShare > 0)) return null;
  const riskBudget = s.realCapital * (s.riskPct / 100);
  const byRisk = Math.floor(riskBudget / riskPerShare);
  const byCap = Math.floor((s.realCapital * (s.maxPerStockPct / 100)) / entry);
  const qty = Math.max(0, Math.min(byRisk, byCap));
  return { qty, byRisk, riskPerShare, capitalUsed: qty * entry, maxLoss: qty * riskPerShare, cappedByMax: byCap < byRisk };
}
