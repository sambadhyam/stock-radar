// importers.js — turns a table from a broker or screener file into holdings or fundamentals.
// Column names differ between Zerodha Console, Kite and Screener exports and change over time, so columns are
// found by name patterns, and the import screens show what was found before anything is saved.
import { toYmd } from './xlsx.js';

const norm = (h) => String(h == null ? '' : h).toLowerCase().replace(/[\s ]+/g, ' ').trim();

/** NSE symbol as brokers write it: RELIANCE-EQ, NSE:RELIANCE, reliance.ns → RELIANCE. */
export function cleanSymbol(s) {
  return String(s == null ? '' : s).trim().toUpperCase().replace(/^(NSE|BSE):/, '').replace(/\.(NS|BO)$/, '').replace(/-(EQ|BE|BZ|BL|SM|ST|IV|RR)$/, '');
}
export const SYMBOL_RE = /^[A-Z0-9&-]{1,20}$/;

/** A number from a cell: 1,234.5 · 12.3% · ₹1,200 · (45) · − → number or null. */
export function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v == null ? '' : v).trim();
  if (!s || /^[-–—]+$/.test(s) || /^n\/?a$/i.test(s)) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/₹|rs\.?|inr|cr\.?|%|,|\s/gi, '').replace(/^[−–]/, '-');
  const n = Number(s);
  return Number.isFinite(n) && s !== '' ? (neg ? -n : n) : null;
}

/** Index of the first of the first 40 rows that passes `test(normalisedHeaders)`, or −1. */
function findHeader(rows, test) {
  for (let i = 0; i < Math.min(rows.length, 40); i++) if (test(rows[i].map(norm))) return i;
  return -1;
}

// ---------- Holdings ----------

const H = {
  symbol: /^(symbol|trading ?symbol|instrument|scrip( name| code)?|stock( name| symbol)?|security( name)?|nse ?(symbol|code))$/,
  qty: /\b(qty|quantity)\b/,
  longTerm: /long ?term/,
  avg: /^(avg|average)\b|average (cost|price|buy)|buy (avg|average|price)/,
  last: /^(ltp|last (traded )?price|previous clos(e|ing)( price)?|prev\.? close|close( price)?|cmp|current price|market price)$/,
  isin: /^isin/,
  sector: /^(sector|industry)/,
  name: /^(company( name)?|name|security name)$/,
  buyDate: /(buy|purchase|acquisition) ?date/,
};

/**
 * Holdings from a Zerodha Console holdings file (XLSX), a Kite holdings CSV, or any table with a symbol, a quantity
 * and an average price. Several quantity columns (available, discrepant, pledged) are added up; "long term" is a part
 * of those and is kept separately. Returns {rows, skipped, sheet, columns} or null when no table is recognised.
 */
export function parseHoldings(table) {
  const sheets = table.sheets.slice().sort((a, b) => Number(/equity|holding/i.test(b.name)) - Number(/equity|holding/i.test(a.name)));
  for (const sh of sheets) {
    const hi = findHeader(sh.rows, (h) => h.some((x) => H.symbol.test(x)) && h.some((x) => H.qty.test(x) && !H.longTerm.test(x)) && h.some((x) => H.avg.test(x)));
    if (hi < 0) continue;
    const h = sh.rows[hi].map(norm);
    const col = (re) => h.findIndex((x) => re.test(x));
    const cSym = col(H.symbol), cAvg = col(H.avg), cLast = col(H.last), cIsin = col(H.isin), cSector = col(H.sector), cName = col(H.name), cBuy = col(H.buyDate);
    const qtyCols = h.map((x, i) => (H.qty.test(x) && !H.longTerm.test(x) ? i : -1)).filter((i) => i >= 0);
    const cLong = h.findIndex((x) => H.qty.test(x) && H.longTerm.test(x));
    const rows = [], skipped = [];
    for (const r of sh.rows.slice(hi + 1)) {
      const raw = r[cSym];
      if (raw == null || raw === '' || /^(grand )?total/i.test(String(raw))) continue;
      const symbol = cleanSymbol(raw), avg = toNumber(r[cAvg]);
      const qty = qtyCols.reduce((a, i) => a + (toNumber(r[i]) || 0), 0);
      if (!SYMBOL_RE.test(symbol) || !(qty > 0) || avg == null || avg < 0) { skipped.push(String(raw).slice(0, 40)); continue; }
      rows.push({
        symbol, qty, avgPrice: avg, lastPrice: cLast >= 0 ? toNumber(r[cLast]) : null,
        isin: cIsin >= 0 ? String(r[cIsin] ?? '').trim().slice(0, 12) : '', sector: cSector >= 0 ? String(r[cSector] ?? '').trim().slice(0, 60) : '',
        name: cName >= 0 ? String(r[cName] ?? '').trim().slice(0, 80) : '', longTermQty: cLong >= 0 ? toNumber(r[cLong]) : null,
        buyDate: cBuy >= 0 ? toYmd(r[cBuy]) : '',
      });
    }
    const label = (i) => (i >= 0 ? String(sh.rows[hi][i]) : '');
    return { rows, skipped, sheet: sh.name, columns: { symbol: label(cSym), qty: qtyCols.map(label), avg: label(cAvg), last: label(cLast), longTerm: label(cLong) } };
  }
  return null;
}

/** Holdings valued with the prices in the file (used before the engine values them, or when not connected). */
export function localPortfolio(rows) {
  let invested = 0, value = 0;
  const holdings = rows.map((r) => {
    const last = r.lastPrice > 0 ? r.lastPrice : null, v = r.qty * (last || r.avgPrice);
    invested += r.qty * r.avgPrice; value += v;
    return { symbol: r.symbol, name: r.name || '', sector: r.sector || 'Other', qty: r.qty, avg: r.avgPrice, last, value: v, pnl: last ? (last - r.avgPrice) * r.qty : null,
      pnlPct: last && r.avgPrice > 0 ? (last / r.avgPrice - 1) * 100 : null, flags: [], longTermQty: r.longTermQty, buyDate: r.buyDate || '' };
  });
  holdings.forEach((x) => { x.weightPct = value > 0 ? Math.round(x.value / value * 1000) / 10 : null; });
  holdings.sort((a, b) => b.value - a.value);
  const sec = {};
  holdings.forEach((x) => { sec[x.sector] = (sec[x.sector] || 0) + x.value; });
  return {
    holdings, local: true, warnings: [],
    sectors: Object.keys(sec).map((s) => ({ sector: s, value: sec[s], pct: value > 0 ? Math.round(sec[s] / value * 1000) / 10 : 0 })).sort((a, b) => b.value - a.value),
    totals: { invested, value, pnl: value - invested, pnlPct: invested > 0 ? (value / invested - 1) * 100 : null, dayPnl: null, dayPct: null },
  };
}

// ---------- Fundamentals ----------

/** The fields the long-term score uses: key, label, and a pattern for a matching column name. */
export const FUND_FIELDS = [
  ['roePct', 'Return on equity %', /^(roe|return on equity)\b/],
  ['rocePct', 'Return on capital employed %', /^(roce|return on capital)/],
  ['debtToEquity', 'Debt to equity', /debt ?\/ ?eq|debt to equity|^d ?\/ ?e$/],
  ['sales3yPct', 'Sales growth, 3 years %', /(sales|revenue).*(gr|var|growth|cagr).*3|3 ?(y|yr|yrs|year|years)\b.*(sales|revenue)/],
  ['profit3yPct', 'Profit growth, 3 years %', /(profit|np|pat|earnings).*(gr|var|growth|cagr).*3|3 ?(y|yr|yrs|year|years)\b.*(profit|earnings)/],
  ['promoterPct', 'Promoter holding %', /prom(oter)?\.? ?hold/],
  ['pledgePct', 'Pledged %', /pledg/],
  ['pe', 'Price to earnings (P/E)', /^(p\/e|pe|stock p\/e|price to earnings?|price ?\/ ?earnings?)( ratio)?$/],
  ['pe5yMedian', 'P/E, 5-year median or average', /(hist|median|avg|average|mean).*\bp\/?e\b.*5|5 ?(y|yr|yrs|year|years)\b.*\bp\/?e\b|\bp\/?e\b.*5 ?(y|yr|yrs|year|years)\b/],
  ['fcf', 'Free cash flow', /free cash ?flow|\bfcf\b/],
];
const F_SYMBOL = /^(nse ?code|nse ?symbol|symbol|ticker|trading ?symbol)$/;
const F_NAME = /^(name|company( name)?|stock( name)?)$/;
const fnorm = (h) => norm(h).replace(/\b(rs|cr|crore|inr)\b\.?/g, '').replace(/[%₹]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Find the table and a first guess of which column holds each field. Returns
 * {sheet, header: [names], data: [[cells]], symbolCol, nameCol, map: {field: column or −1}} or null.
 */
export function guessFundamentals(table) {
  for (const sh of table.sheets) {
    const hi = findHeader(sh.rows, (h) => {
      const f = h.map((x) => fnorm(x));
      const hits = FUND_FIELDS.filter(([, , re]) => f.some((x) => re.test(x))).length;
      return (f.some((x) => F_SYMBOL.test(x)) || f.some((x) => F_NAME.test(x))) && hits >= 2;
    });
    if (hi < 0) continue;
    const header = sh.rows[hi].map((x) => String(x ?? '')), f = header.map(fnorm);
    const map = {};
    for (const [key, , re] of FUND_FIELDS) {
      // When several columns match (ROE and ROE 3Yr), take the plainest name.
      let best = -1;
      f.forEach((x, i) => { if (re.test(x) && (best < 0 || x.length < f[best].length)) best = i; });
      map[key] = best;
    }
    return {
      sheet: sh.name, header, data: sh.rows.slice(hi + 1).filter((r) => r.some((c) => c !== '' && c != null)),
      symbolCol: f.findIndex((x) => F_SYMBOL.test(x)), nameCol: f.findIndex((x) => F_NAME.test(x)), map,
    };
  }
  return null;
}

/** Rows for the engine from a guess (after any changes made on screen). Blank cells stay blank: nothing is guessed. */
export function fundamentalsRows(g) {
  return g.data.map((r) => {
    const o = { symbol: g.symbolCol >= 0 ? cleanSymbol(r[g.symbolCol]) : '', name: g.nameCol >= 0 ? String(r[g.nameCol] ?? '').trim().slice(0, 100) : '' };
    for (const [key] of FUND_FIELDS) { const c = g.map[key]; o[key] = c >= 0 ? toNumber(r[c]) : null; }
    return o;
  }).filter((o) => (o.symbol || o.name) && !/^(median|average|total)/i.test(o.name));
}
