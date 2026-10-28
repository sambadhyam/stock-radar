// explore.js — every trade of the engine's Backtest Baseline, filtered and broken down on this phone.
// The trades come from the engine once per baseline (bt-trades.json) and are kept in IndexedDB.
import { h, fmt, tone, fill } from '../util.js';
import { t } from '../i18n.js';
import { openSheet, segmented, filterChips } from '../ui.js';
import { loadTrades } from '../backtest.js';

const HZ = [['SWING', 'allSwing'], ['MEDIUM', 'allMedium'], ['INTRADAY', 'allIntraday']];
const REGIMES = ['BULL', 'NEUTRAL', 'BEAR', 'HIGH_VOL'];
const REGIME_KEY = { BULL: 'bull', NEUTRAL: 'neutral', BEAR: 'bear', HIGH_VOL: 'volatile', UNKNOWN: 'unknown' };
const TIMES = [[555, 630, '09:15–10:30'], [630, 750, '10:30–12:30'], [750, 931, '12:30–15:30']];
const BEST_WORST = 12;

// Kept while the app is open, so reopening the explorer keeps the last filters.
const view = { f: { strategy: 'all', dir: 'all', track: 'taken', year: 'all', market: 'all', score: 'all', symbol: 'all' }, by: 'year', showAll: false, filtersOpen: false };
let cache = { runId: null, trades: null };

/** Open the explorer for this baseline result (the engine's bt-result). */
export function openExplorer(result) {
  const body = h('div', null, h('p', { class: 'muted', role: 'status' }, t('explore.loading')));
  openSheet((closeBtn) => h('div', null,
    h('div', { class: 'sheet-head' },
      h('div', { class: 'grow' }, h('h2', { class: 'sheet-title' }, t('explore.title')), h('div', { class: 'sheet-sub', id: 'ex-sub' })),
      closeBtn),
    body), { label: t('explore.title') });
  start(result, body);
}

async function start(result, body) {
  try {
    if (cache.runId !== result.runId || !cache.trades) {
      const data = await loadTrades(result.runId);
      cache = { runId: result.runId, trades: decode(data, result) };
    }
    draw(result, body);
  } catch (e) {
    fill(body, h('p', { class: 'note loss' }, t('explore.loadFail', { why: e.message })),
      h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => { fill(body, h('p', { class: 'muted' }, t('explore.loading'))); start(result, body); } }, t('explore.retry')));
  }
}

/** Short rows from the engine into plain objects (signal day and minute in IST). */
function decode(d, result) {
  const hz = {};
  for (const [id, s] of Object.entries(result.strategies || {})) hz[id] = s.horizon;
  return d.rows.map((r) => {
    const strategy = d.strategies[r[1]], dayT = r[4] * 60000, ist = new Date(dayT + 330 * 60000);
    return {
      symbol: d.syms[r[0]], strategy, horizon: hz[strategy] || '', shadow: r[2] === 1, regime: d.regimes[r[3]] || 'UNKNOWN', dayT,
      outcome: d.outcomes[r[6]] || 'EXPIRED', netPct: r[7], netPnl: r[8], hold: r[9], alpha: r[10], short: r[11] === 1, heldBy: r[12] || '', score: r[13],
      year: ist.getUTCFullYear(), minute: ist.getUTCHours() * 60 + ist.getUTCMinutes(), day: Math.floor((dayT + 330 * 60000) / 86400000),
    };
  });
}

/** The filters in force, in a few words for the closed filter panel. */
function activeText(f, result) {
  const parts = [];
  if (f.strategy === 'all') parts.push(t('explore.f.all'));
  else if (f.strategy.startsWith('hz:')) parts.push(t('explore.f.' + { SWING: 'allSwing', MEDIUM: 'allMedium', INTRADAY: 'allIntraday' }[f.strategy.slice(3)]));
  else parts.push(result.strategies[f.strategy] ? result.strategies[f.strategy].name : f.strategy);
  parts.push(t('explore.track.' + f.track));
  if (f.dir !== 'all') parts.push(t('explore.dir.' + f.dir));
  if (f.year !== 'all') parts.push(String(f.year));
  if (f.market !== 'all') parts.push(t('regimeName.' + REGIME_KEY[f.market]));
  if (f.score !== 'all') parts.push(t('explore.f.score') + ' ' + t('explore.score.' + f.score));
  if (f.symbol !== 'all') parts.push(f.symbol);
  return parts.join(' · ');
}

function scoreBand(s) { return s == null ? 'none' : s < 60 ? 'lt60' : s < 70 ? '60' : '70'; }

function matches(x, f) {
  if (f.strategy !== 'all') {
    if (f.strategy.startsWith('hz:')) { if (x.horizon !== f.strategy.slice(3)) return false; } else if (x.strategy !== f.strategy) return false;
  }
  if (f.dir === 'buy' && x.short) return false;
  if (f.dir === 'short' && !x.short) return false;
  if (f.track === 'taken' && x.shadow) return false;
  if (f.track === 'held' && !x.shadow) return false;
  if (f.year !== 'all' && x.year !== Number(f.year)) return false;
  if (f.market !== 'all' && x.regime !== f.market) return false;
  if (f.score !== 'all' && scoreBand(x.score) !== f.score) return false;
  if (f.symbol !== 'all' && x.symbol !== f.symbol) return false;
  return true;
}

/** Trades, days, win rate, average after charges, profit factor, targets hit, rupee total, average hold, against Nifty. */
function stats(list) {
  const n = list.length, days = new Set();
  let wins = 0, sum = 0, gp = 0, gl = 0, tgt = 0, rupees = 0, allRupees = n > 0, hold = 0, nHold = 0, alpha = 0, nAlpha = 0;
  for (const x of list) {
    days.add(x.day);
    sum += x.netPct;
    if (x.netPct > 0) { wins++; gp += x.netPct; } else gl -= x.netPct;
    if (x.outcome === 'TARGET_HIT') tgt++;
    if (typeof x.netPnl === 'number') rupees += x.netPnl; else allRupees = false;
    if (typeof x.hold === 'number') { hold += x.hold; nHold++; }
    if (typeof x.alpha === 'number') { alpha += x.alpha; nAlpha++; }
  }
  return {
    n, days: days.size, win: n ? Math.round(wins / n * 1000) / 10 : null, avg: n ? sum / n : null, pf: gl > 0 ? gp / gl : null,
    targets: n ? Math.round(tgt / n * 1000) / 10 : null, total: allRupees ? rupees : null, hold: nHold ? hold / nHold : null, alpha: nAlpha ? alpha / nAlpha : null,
  };
}

function draw(result, body) {
  const all = cache.trades, f = view.f;
  const sub = document.getElementById('ex-sub');
  const first = all.reduce((a, x) => Math.min(a, x.dayT), Infinity), last = all.reduce((a, x) => Math.max(a, x.dayT), 0);
  if (sub) sub.textContent = t('explore.sub', { n: fmt.int(all.length), from: fmt.monthYear(first), to: fmt.monthYear(last) });
  const redraw = () => draw(result, body);
  const set = (k) => (v) => { f[k] = v; view.showAll = false; redraw(); };

  // Filters
  const stratSelect = h('select', { id: 'ex-strategy', 'aria-label': t('explore.f.strategy') },
    h('option', { value: 'all', selected: f.strategy === 'all' }, t('explore.f.all')),
    HZ.map(([hz, key]) => {
      const ids = Object.keys(result.strategies).filter((id) => result.strategies[id].horizon === hz);
      if (!ids.length) return null;
      return h('optgroup', { label: t('hz.' + hz.toLowerCase()) },
        h('option', { value: 'hz:' + hz, selected: f.strategy === 'hz:' + hz }, t('explore.f.' + key)),
        ids.map((id) => h('option', { value: id, selected: f.strategy === id }, result.strategies[id].name)));
    }));
  stratSelect.addEventListener('change', () => set('strategy')(stratSelect.value));
  const years = [...new Set(all.map((x) => x.year))].sort();
  const yearSelect = h('select', { id: 'ex-year', 'aria-label': t('explore.f.year') },
    h('option', { value: 'all', selected: f.year === 'all' }, t('explore.year.all')), years.map((y) => h('option', { value: String(y), selected: String(f.year) === String(y) }, String(y))));
  yearSelect.addEventListener('change', () => set('year')(yearSelect.value));
  const marketSelect = h('select', { id: 'ex-market', 'aria-label': t('explore.f.market') },
    h('option', { value: 'all', selected: f.market === 'all' }, t('explore.market.all')), REGIMES.map((r) => h('option', { value: r, selected: f.market === r }, t('regimeName.' + REGIME_KEY[r]))));
  marketSelect.addEventListener('change', () => set('market')(marketSelect.value));
  const symbols = [...new Set(all.map((x) => x.symbol))].sort();
  const stockSelect = h('select', { id: 'ex-stock', 'aria-label': t('explore.f.stock') },
    h('option', { value: 'all', selected: f.symbol === 'all' }, t('explore.stock.all')), symbols.map((s) => h('option', { value: s, selected: f.symbol === s }, s)));
  stockSelect.addEventListener('change', () => set('symbol')(stockSelect.value));

  const filters = h('details', { class: 'param-box', open: view.filtersOpen },
    h('summary', null, t('explore.filters'), h('span', { class: 'filter-sum' }, activeText(f, result))),
    h('div', { style: { marginTop: '12px' } },
      h('div', { class: 'field' }, h('label', { for: 'ex-strategy' }, t('explore.f.strategy')), stratSelect),
      h('div', { class: 'field' }, h('span', { class: 'label' }, t('explore.f.dir')),
        segmented(['all', 'buy', 'short'].map((v) => ({ value: v, label: t('explore.dir.' + v) })), f.dir, set('dir'), t('explore.f.dir'))),
      h('div', { class: 'field' }, h('span', { class: 'label' }, t('explore.f.track')),
        segmented(['taken', 'held', 'all'].map((v) => ({ value: v, label: t('explore.track.' + v) })), f.track, set('track'), t('explore.f.track'))),
      h('div', { class: 'pair' },
        h('div', { class: 'field' }, h('label', { for: 'ex-year' }, t('explore.f.year')), yearSelect),
        h('div', { class: 'field' }, h('label', { for: 'ex-market' }, t('explore.f.market')), marketSelect)),
      h('div', { class: 'field' }, h('span', { class: 'label' }, t('explore.f.score')),
        segmented(['all', 'lt60', '60', '70'].map((v) => ({ value: v, label: t('explore.score.' + v) })), f.score, set('score'), t('explore.f.score'))),
      h('div', { class: 'field' }, h('label', { for: 'ex-stock' }, t('explore.f.stock')), stockSelect)));

  filters.addEventListener('toggle', () => { view.filtersOpen = filters.open; });
  const list = all.filter((x) => matches(x, f));
  const m = stats(list);
  const hzs = new Set(list.map((x) => x.horizon));
  const onlyIntraday = hzs.size === 1 && hzs.has('INTRADAY'), oneHorizon = hzs.size === 1;

  const summary = !m.n ? h('p', { class: 'muted', style: { marginTop: '14px' } }, t('explore.none')) : h('dl', { class: 'kv', style: { marginTop: '14px' } },
    kv(t('backtest.k.trades'), fmt.int(m.n) + ' · ' + t('backtest.k.onDays', { n: fmt.int(m.days) })),
    kv(t('results.win'), m.win + '%'),
    kv(t('backtest.k.avg'), fmt.pct(m.avg), tone(m.avg)),
    kv(t('results.pf'), m.pf != null ? fmt.num(m.pf, 2) : t('backtest.noLosses')),
    kv(t('explore.k.targets'), m.targets + '%'),
    m.total != null ? kv(t('backtest.k.total'), fmt.signedMoney(m.total), tone(m.total)) : null,
    oneHorizon && m.hold != null ? kv(t('backtest.k.hold'), onlyIntraday ? t('backtest.k.minutes', { n: Math.round(m.hold * 375) }) : t('backtest.k.days', { n: fmt.num(m.hold, 1) })) : null,
    m.alpha != null ? kv(t('results.vsNifty'), fmt.pct(m.alpha) + ' ' + t('backtest.k.perTrade'), tone(m.alpha)) : null);

  // Break down by
  const byOptions = ['year', 'strategy', 'stock', 'market', 'score', 'dir'];
  if (list.some((x) => x.horizon === 'INTRADAY')) byOptions.push('time');
  if (f.track !== 'taken') byOptions.push('filter');
  if (!byOptions.includes(view.by)) view.by = 'year';
  const groups = breakdown(list, view.by, result);

  fill(body, filters, summary,
    m.n ? h('div', null,
      h('h3', null, t('explore.by')),
      filterChips(byOptions.map((v) => ({ value: v, label: t('explore.by.' + v) })), view.by, (v) => { view.by = v; view.showAll = false; redraw(); }, t('explore.by')),
      table(groups, view.by === 'stock', redraw)) : null,
    stockCheck(result),
    h('p', { class: 'note faint' }, t('explore.note')));
}

function kv(label, value, cls) { return [h('dt', null, label), h('dd', { class: 'num ' + (cls || '') }, value)]; }

/** Groups for the chosen breakdown, each {label, stats}, in a sensible order. */
function breakdown(list, by, result) {
  const key = {
    year: (x) => String(x.year),
    strategy: (x) => x.strategy,
    stock: (x) => x.symbol,
    market: (x) => x.regime,
    score: (x) => scoreBand(x.score),
    dir: (x) => (x.short ? 'short' : 'buy'),
    time: (x) => { const i = TIMES.findIndex(([a, b]) => x.minute >= a && x.minute < b); return i < 0 ? 'other' : String(i); },
    filter: (x) => x.heldBy || 'taken',
  }[by];
  const map = new Map();
  for (const x of list) { const k = key(x); if (!map.has(k)) map.set(k, []); map.get(k).push(x); }
  const label = {
    year: (k) => k,
    strategy: (k) => (result.strategies[k] ? result.strategies[k].name : k),
    stock: (k) => k,
    market: (k) => t('regimeName.' + (REGIME_KEY[k] || 'unknown')),
    score: (k) => (k === 'none' ? '—' : t('explore.score.' + k)),
    dir: (k) => t('explore.dir.' + k),
    time: (k) => (TIMES[Number(k)] ? TIMES[Number(k)][2] : k),
    filter: (k) => t('explore.filter.' + k),
  }[by];
  let rows = [...map.entries()].map(([k, l]) => ({ key: k, label: label(k), s: stats(l) }));
  const order = {
    year: (a, b) => a.key.localeCompare(b.key),
    strategy: (a, b) => stratOrder(a.key, result) - stratOrder(b.key, result),
    stock: (a, b) => (b.s.total ?? b.s.avg * b.s.n) - (a.s.total ?? a.s.avg * a.s.n) || b.s.avg - a.s.avg,
    market: (a, b) => REGIMES.indexOf(a.key) - REGIMES.indexOf(b.key),
    score: (a, b) => ['lt60', '60', '70', 'none'].indexOf(a.key) - ['lt60', '60', '70', 'none'].indexOf(b.key),
    dir: (a, b) => a.key.localeCompare(b.key),
    time: (a, b) => a.key.localeCompare(b.key),
    filter: (a, b) => a.key.localeCompare(b.key),
  }[by];
  rows.sort(order);
  return rows;
}

function stratOrder(id, result) {
  const ids = Object.keys(result.strategies);
  const hz = ['SWING', 'MEDIUM', 'INTRADAY'].indexOf((result.strategies[id] || {}).horizon);
  return hz * 100 + ids.indexOf(id);
}

function table(rows, isStock, redraw) {
  let shown = rows, hidden = 0;
  if (isStock && !view.showAll && rows.length > BEST_WORST * 2) {
    shown = rows.slice(0, BEST_WORST).concat([null], rows.slice(-BEST_WORST));
    hidden = rows.length - BEST_WORST * 2;
  }
  const head = h('thead', null, h('tr', null,
    h('th', { scope: 'col' }, h('span', { class: 'visually-hidden' }, t('explore.by'))),
    h('th', { scope: 'col' }, t('explore.col.trades')), h('th', { scope: 'col' }, t('explore.col.win')),
    h('th', { scope: 'col' }, t('explore.col.avg')), h('th', { scope: 'col' }, t('explore.col.total'))));
  const body = h('tbody', null, shown.map((r) => (r === null
    ? h('tr', null, h('td', { colspan: '5', class: 'faint gap-cell' }, t('explore.hidden', { n: fmt.int(hidden) })))
    : h('tr', null,
      h('th', { scope: 'row' }, r.label),
      h('td', { class: 'num' }, fmt.int(r.s.n)),
      h('td', { class: 'num' }, r.s.win + '%'),
      h('td', { class: 'num ' + tone(r.s.avg) }, fmt.pct(r.s.avg)),
      h('td', { class: 'num ' + tone(r.s.total) }, r.s.total != null ? fmt.signedMoney(r.s.total) : '—')))));
  return h('div', null,
    h('table', { class: 'cmp explore-table' }, head, body),
    isStock && rows.length > BEST_WORST * 2 ? h('button', { type: 'button', class: 'sec-link', style: { marginTop: '8px' }, onclick: () => { view.showAll = !view.showAll; redraw(); } },
      view.showAll ? t('explore.showLess') : t('explore.showAll', { n: fmt.int(rows.length) })) : null,
    isStock ? h('p', { class: 'note faint' }, t('explore.stockNote')) : null);
}

/** The engine's check of whether stocks that did well with a strategy kept doing well (PLAN §3.22). */
function stockCheck(result) {
  const list = result.stockCheck;
  const names = { INTRADAY: t('hz.intraday'), SWING: t('hz.swing'), MEDIUM: t('hz.medium') };
  return h('div', { class: 'panel', style: { marginTop: '16px' } },
    h('b', null, t('explore.check.title')),
    list && list.length
      ? [h('ul', { class: 'bullets', style: { marginTop: '8px' } }, list.map((c) => h('li', null, t('explore.check.line', {
        hz: names[c.horizon] || c.horizon, picks: fmt.int(c.picks), pick: c.picksAvg != null ? fmt.pct(c.picksAvg) : '—', rest: c.restAvg != null ? fmt.pct(c.restAvg) : '—',
        verdict: t('explore.check.verdict.' + c.verdict), both: fmt.int(c.both), luck: fmt.num(c.luck, 1),
      })))), h('p', { class: 'note faint' }, t(list.some((c) => c.verdict === 'better') ? 'explore.check.noteBetter' : 'explore.check.note'))]
      : h('p', { class: 'muted', style: { marginTop: '6px' } }, t('explore.check.none')));
}
