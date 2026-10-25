// state.js — user settings (stored on this phone; synced to the backend from Phase 4).
import { store } from './util.js';

export const APP_VERSION = '0.2.0';

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
  strategiesOff: [],        // strategy ids switched off
  backendUrl: '',
  token: '',
});

export const LIMITS = Object.freeze({
  realCapital: [1000, 1e10],
  paperCapital: [1000, 1e10],
  riskPct: [0.1, 5],
  maxPerStockPct: [1, 100],
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
