// api.js — talks to the Apps Script engine (Web App).
// Requests are POST with a plain-text JSON body, which browsers send without a CORS preflight.
// The token lives only in this phone's storage and in the engine's Script Properties.
import { getSettings } from './state.js';

const TIMEOUT_MS = 30000; // Apps Script can take several seconds to wake up

export class ApiError extends Error {
  constructor(message, kind) { super(message); this.kind = kind; } // kind: 'offline' | 'auth' | 'engine' | 'setup'
}

export function isConnected(s = getSettings()) {
  return !!(s.backendUrl && s.token);
}

/** A web app address looks like https://script.google.com/macros/s/…/exec */
export function validUrl(u) {
  return /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,}\/exec$/.test(String(u || '').trim());
}
export function validToken(t) {
  return /^[a-f0-9]{32,80}$/i.test(String(t || '').trim());
}

/** Call one engine action. Throws ApiError with a plain-English message. */
export async function call(action, payload = {}, conn = getSettings()) {
  if (!validUrl(conn.backendUrl) || !validToken(conn.token)) throw new ApiError('The app is not connected to the engine yet.', 'setup');
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), TIMEOUT_MS) : null;
  let res;
  try {
    res = await fetch(conn.backendUrl.trim(), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...payload, a: action, t: conn.token.trim() }),
      redirect: 'follow',
      cache: 'no-store',
      signal: ctrl ? ctrl.signal : undefined,
    });
  } catch (e) {
    throw new ApiError(navigator.onLine === false ? 'You are offline.' : 'Could not reach the engine. Check the connection and try again.', 'offline');
  } finally {
    if (timer) clearTimeout(timer);
  }
  let body = null;
  try { body = await res.json(); } catch (e) { body = null; }
  if (!body) throw new ApiError('The engine sent an unexpected answer. Check that the web app is deployed with access for "Anyone".', 'engine');
  if (!body.ok) throw new ApiError(body.error || 'The engine could not do that.', /authori/i.test(body.error || '') ? 'auth' : 'engine');
  return body.data;
}

export const api = {
  ping: (conn) => call('ping', {}, conn),
  bundle: () => call('bundle'),
  chart: (symbol, alertId) => call('chart', { symbol, alertId: alertId || '' }),
  saveSettings: (settings, strategies) => call('settings', { settings, strategies }),
  testTelegram: () => call('testTelegram'),
  news: (symbol) => call('news', { symbol }),
  // Phase 5
  backtest: () => call('backtest'),
  btData: (kind, symbols, market) => call('btData', { kind, symbols, market: !!market }),
  btStart: () => call('btStart'),
  holdings: (payload) => call('holdings', payload),
  fundamentals: (rows, source) => call('fundamentals', { rows, source }),
  summary: (symbol) => call('summary', { symbol }),
  alertHistory: (before, limit) => call('alerts', { before, limit }),
  reviews: () => call('reviews'),
  reviewNow: (telegram) => call('reviewNow', { telegram: !!telegram }),
};
