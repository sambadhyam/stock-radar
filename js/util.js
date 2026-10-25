// util.js — DOM builder, formatters, storage and market-calendar helpers.
// No dependencies. All text goes in through textContent, never innerHTML.

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Create an HTML element. attrs: class, text, on<event>, dataset, style{}, aria-*, any attribute. */
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  setAttrs(el, attrs);
  add(el, kids);
  return el;
}

/** Create an SVG element. */
export function s(tag, attrs, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  add(el, kids);
  return el;
}

function setAttrs(el, attrs) {
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value' && 'value' in el) el.value = v;
    else if (k === 'checked' && 'checked' in el) el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
}

function add(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false || k === '') continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}

/** Parse a small trusted SVG icon string (from icons.js only) into a node. */
export function icon(markup) {
  const tpl = document.createElement('template');
  tpl.innerHTML = markup.trim(); // icons.js holds static, author-written markup only
  return tpl.content.firstElementChild;
}

// ---------- Formatting (Indian grouping, IST) ----------
const nfCache = new Map();
function nf(min, max) {
  const key = min + ':' + max;
  if (!nfCache.has(key)) nfCache.set(key, new Intl.NumberFormat('en-IN', { minimumFractionDigits: min, maximumFractionDigits: max }));
  return nfCache.get(key);
}
const MINUS = '−';

export const fmt = {
  /** 25,410.20 */
  num(v, d = 2) { return isFiniteNum(v) ? (v < 0 ? MINUS : '') + nf(d, d).format(Math.abs(v)) : '—'; },
  /** ₹1,03,420 */
  money(v, d = 0) { return isFiniteNum(v) ? (v < 0 ? MINUS : '') + '₹' + nf(d, d).format(Math.abs(v)) : '—'; },
  /** ₹1,452.50, or ₹1,452 when the price is a whole number */
  price(v) { return fmt.money(v, priceDecimals(v)); },
  /** +₹820 / −₹410 */
  signedMoney(v, d = 0) { return isFiniteNum(v) ? (v > 0 ? '+' : v < 0 ? MINUS : '') + '₹' + nf(d, d).format(Math.abs(v)) : '—'; },
  /** +0.62% */
  pct(v, d = 2, signed = true) {
    if (!isFiniteNum(v)) return '—';
    const sign = v > 0 ? (signed ? '+' : '') : v < 0 ? MINUS : '';
    return sign + nf(d, d).format(Math.abs(v)) + '%';
  },
  int(v) { return isFiniteNum(v) ? (v < 0 ? MINUS : '') + nf(0, 0).format(Math.abs(v)) : '—'; },
  /** ₹1,452–1,460 or ₹1,407.50–1,409.00 */
  priceRange(lo, hi) {
    const d = Math.max(priceDecimals(lo), priceDecimals(hi));
    return '₹' + nf(d, d).format(lo) + '–' + nf(d, d).format(hi);
  },
  /** 14:32 in IST */
  time(d) { return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(toDate(d)); },
  /** Sunday, 25 October (localized) */
  longDate(d, lang) {
    return new Intl.DateTimeFormat(lang === 'ml' ? 'ml-IN' : 'en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'long' }).format(toDate(d));
  },
  /** 25 Oct 2026 */
  shortDate(d, lang) {
    return new Intl.DateTimeFormat(lang === 'ml' ? 'ml-IN' : 'en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' }).format(toDate(d));
  },
  /** 25 Oct */
  dayMonth(d, lang) {
    return new Intl.DateTimeFormat(lang === 'ml' ? 'ml-IN' : 'en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' }).format(toDate(d));
  },
};

export function isFiniteNum(v) { return typeof v === 'number' && Number.isFinite(v); }
/** 0 decimals for whole-rupee prices, otherwise 2 (NSE ticks are 0.05). */
export function priceDecimals(v) { return Number.isInteger(Math.round(v * 100) / 100) ? 0 : 2; }
function toDate(d) { return d instanceof Date ? d : new Date(d); }

/** Change class name for a signed number: 'gain' | 'loss' | '' */
export function tone(v) { return v > 0 ? 'gain' : v < 0 ? 'loss' : ''; }

// ---------- Safe storage (localStorage can throw or be empty) ----------
export const store = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
  },
  raw(key) { try { return localStorage.getItem(key); } catch (e) { return null; } },
  setRaw(key, value) { try { localStorage.setItem(key, value); return true; } catch (e) { return false; } },
};

// ---------- NSE market calendar (IST) ----------
// Equity segment trading holidays, calendar year 2026 (weekdays only).
// Verified against Upstox and ClearTax holiday pages on 25 Oct 2026; the backend keeps an editable copy.
export const NSE_HOLIDAYS_2026 = [
  '2026-01-15', '2026-01-26', '2026-03-03', '2026-03-26', '2026-03-31', '2026-04-03',
  '2026-04-14', '2026-05-01', '2026-05-28', '2026-06-26', '2026-09-14', '2026-10-02',
  '2026-10-20', '2026-11-10', '2026-11-24', '2026-12-25',
];

/** Current IST parts for a Date. */
export function istParts(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const hour = Number(get('hour')) % 24;
  return { ymd: `${get('year')}-${get('month')}-${get('day')}`, weekday: get('weekday'), minutes: hour * 60 + Number(get('minute')) };
}

/** 'open' | 'pre' | 'closed' | 'holiday' | 'weekend' — normal session 09:15–15:30 IST. */
export function marketState(d = new Date()) {
  const p = istParts(d);
  if (p.weekday === 'Sat' || p.weekday === 'Sun') return 'weekend';
  if (NSE_HOLIDAYS_2026.includes(p.ymd)) return 'holiday';
  if (p.minutes >= 9 * 60 + 15 && p.minutes < 15 * 60 + 30) return 'open';
  if (p.minutes >= 9 * 60 && p.minutes < 9 * 60 + 15) return 'pre';
  return 'closed';
}

/** Copy text to clipboard with a fallback for older WebViews. */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch (e) { /* fall through */ }
  try {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (e) { return false; }
}
