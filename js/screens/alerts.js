// Alerts: filterable feed, and the alert detail sheet with chart, plan, size and track record.
import { h, fmt, icon, copyText, fill, store, tone, istParts, NSE_HOLIDAYS_2026 } from '../util.js';
import { t } from '../i18n.js';
import { ICONS } from '../icons.js';
import { getSettings, positionSize } from '../state.js';
import {
  screenHead, filterChips, alertRow, horizonTag, statusChip, dirChip, trackStrip, stripLegend,
  openSheet, closeSheet, kvList, toast, previewBanner,
} from '../ui.js';
import { candleChart } from '../charts.js';
import { getData, loadAlertChart } from '../data.js';
import { api, isConnected } from '../api.js';

const OVERLAY_LABEL = { ema20: '20-day EMA', sma50: () => t('stock.dma50'), sma200: () => t('stock.dma200'), vwap: 'VWAP' };
const overlayLabel = (k) => (typeof OVERLAY_LABEL[k] === 'function' ? OVERLAY_LABEL[k]() : OVERLAY_LABEL[k] || k);

/* ---------- Filters, sorting and the numbers for what is shown ---------- */

const FILTER_KEY = 'sr.alertFilters';
const DEFAULT_FILTERS = { hz: 'all', period: 'all', day: '', result: 'all', dir: 'all', status: 'all', strategy: 'all', q: '', sort: 'new' };
let filters = { ...DEFAULT_FILTERS, ...(store.get(FILTER_KEY, {}) || {}) };
let appliedQuery = null;
let root = null;
// Older alerts than the bundle carries, loaded page by page when a date filter needs them.
const older = { list: [], oldest: null, done: false, loading: false, error: null };
const DAY = 86400000;

function saveFilters() { store.set(FILTER_KEY, filters); }
const dayStart = (ymd) => Date.parse(ymd + 'T00:00:00+05:30');
const ymdOf = (ms) => istParts(new Date(ms)).ymd;
const resultPct = (a) => (a.outcome && a.outcome.pct != null ? a.outcome.pct : null);
const netOf = (a) => (a.paper && a.paper.net != null ? a.paper.net : null);

/** The trading day before a date (weekends and NSE holidays skipped). */
function prevSession(ymd) {
  let t = Date.parse(ymd + 'T12:00:00+05:30') - DAY;
  for (let i = 0; i < 10; i++) {
    const p = istParts(new Date(t));
    if (p.weekday !== 'Sat' && p.weekday !== 'Sun' && !NSE_HOLIDAYS_2026.includes(p.ymd)) return p.ymd;
    t -= DAY;
  }
  return ymdOf(t);
}

/** [from, to) in ms for the period filter. */
function periodRange(f) {
  const today = istParts().ymd, t0 = dayStart(today);
  switch (f.period) {
    case 'today': return [t0, t0 + DAY];
    case 'prev': { const d = prevSession(today); return [dayStart(d), dayStart(d) + DAY]; }
    case '7d': return [t0 - 6 * DAY, t0 + DAY];
    case '30d': return [t0 - 29 * DAY, t0 + DAY];
    case 'day': return f.day ? [dayStart(f.day), dayStart(f.day) + DAY] : [0, Infinity];
    default: return [0, Infinity];
  }
}

/** Its time is over but the engine has not judged it yet (that happens after the close, on 1-minute prices). */
export const isPending = (a) => a.state !== 'CLOSED' && !!a.validTill && a.validTill < Date.now();

const RESULTS = {
  target: (a) => !!a.outcome && a.outcome.state === 'target',
  stop: (a) => !!a.outcome && a.outcome.state === 'stop',
  expired: (a) => !!a.outcome && a.outcome.state === 'expired',
  not: (a) => !!a.outcome && a.outcome.state === 'not',
  open: (a) => a.state !== 'CLOSED' && !isPending(a),
  pending: (a) => isPending(a),
  profit: (a) => resultPct(a) > 0,
  loss: (a) => resultPct(a) < 0,
};

const SORTS = {
  new: (a, b) => b.time - a.time,
  old: (a, b) => a.time - b.time,
  best: (a, b) => (resultPct(b) ?? -1e9) - (resultPct(a) ?? -1e9),
  worst: (a, b) => (resultPct(a) ?? 1e9) - (resultPct(b) ?? 1e9),
  conf: (a, b) => (b.confidence || 0) - (a.confidence || 0),
};

/** Every alert known on this phone: the latest from the bundle and any older pages, once each. */
function allAlerts(data) {
  const byId = new Map();
  for (const a of older.list) byId.set(a.id, a);
  for (const a of data.alerts) byId.set(a.id, a);
  return [...byId.values()];
}

function applyFilters(list, f) {
  const [from, to] = periodRange(f);
  const q = f.q.trim().toUpperCase();
  return list.filter((a) => a.time >= from && a.time < to
    && (f.hz === 'all' || a.horizon === f.hz)
    && (f.status === 'all' || a.status === f.status)
    && (f.dir === 'all' || a.dir === f.dir)
    && (f.strategy === 'all' || a.strategy === f.strategy)
    && (f.result === 'all' || (RESULTS[f.result] ? RESULTS[f.result](a) : true))
    && (!q || a.symbol.includes(q)))
    .sort(SORTS[f.sort] || SORTS.new);
}

/** Counts, win rate, average and money for a list of alerts (paper results after charges). */
function summarize(list) {
  const traded = list.filter((a) => a.outcome && a.outcome.state !== 'not' && resultPct(a) != null);
  const won = traded.filter((a) => resultPct(a) > 0).length, lost = traded.filter((a) => resultPct(a) < 0).length;
  const nets = traded.map(netOf).filter((v) => v != null);
  const count = (st) => list.filter((a) => a.outcome && a.outcome.state === st).length;
  return {
    n: list.length, open: list.filter((a) => a.state !== 'CLOSED' && !isPending(a)).length, pending: list.filter(isPending).length, traded: traded.length, won, lost,
    target: count('target'), stop: count('stop'), expired: count('expired'), not: count('not'),
    winRate: traded.length ? Math.round((won / traded.length) * 100) : null,
    avg: traded.length ? traded.reduce((s, a) => s + resultPct(a), 0) / traded.length : null,
    net: nets.length ? nets.reduce((s, v) => s + v, 0) : null,
  };
}

/** Load older alerts until the period is covered (or everything is here). */
async function ensureOlder(data) {
  if (older.loading || older.done) return;
  const total = data.alertsTotal || 0;
  const known = allAlerts(data);
  if (total && known.length >= total) { older.done = true; return; }
  if (!isConnected() || data.isDemo) return;
  const [from] = periodRange(filters);
  const oldest = () => Math.min(...known.map((a) => a.time), older.oldest || Infinity);
  if (from !== 0 && oldest() <= from) return;
  older.loading = true; older.error = null; redraw();
  try {
    for (let page = 0; page < 12; page++) {
      const r = await api.alertHistory(older.oldest || Math.min(...data.alerts.map((a) => a.time), Date.now()), 300);
      older.list.push(...(r.alerts || []));
      older.oldest = r.oldest || older.oldest;
      if (!r.more || !r.alerts || !r.alerts.length) { older.done = true; break; }
      if (from !== 0 && older.oldest <= from) break;
    }
  } catch (e) { older.error = e.message; }
  older.loading = false; redraw();
}

export function render({ data, query }) {
  // A link such as #/alerts?hz=swing sets that filter once (not again on every refresh).
  const qs = query.toString();
  if (qs && qs !== appliedQuery) {
    appliedQuery = qs;
    if (query.get('hz')) filters.hz = query.get('hz');
    if (query.get('status')) filters.status = query.get('status');
    if (query.get('result')) filters.result = query.get('result');
    if (query.get('period')) filters.period = query.get('period');
    saveFilters();
  }
  root = h('div');
  draw(data);
  ensureOlder(data);
  return root;
}

function redraw() { if (root && root.isConnected) draw(getData()); }

function setFilter(patch) {
  filters = { ...filters, ...patch };
  saveFilters();
  redraw();
  ensureOlder(getData());
}

function draw(data) {
  const items = applyFilters(allAlerts(data), filters);
  const search = h('input', { type: 'search', class: 'search-input', placeholder: t('alerts.search'), 'aria-label': t('alerts.search'), value: filters.q, autocapitalize: 'characters', autocomplete: 'off', spellcheck: 'false' });
  let timer = null;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { filters.q = search.value; saveFilters(); drawList(data, listBox, sumBox); }, 200);
  });
  const active = activeCount();
  const filterBtn = h('button', { type: 'button', class: 'btn btn-ghost filter-btn', onclick: () => openFilters(data), 'aria-label': t('alerts.filters') },
    icon(ICONS.filter), h('span', null, t('alerts.filters')), active ? h('span', { class: 'badge-count' }, String(active)) : null);
  const hzChips = filterChips([
    { value: 'all', label: t('common.all') },
    { value: 'intraday', label: t('hz.intraday') },
    { value: 'swing', label: t('hz.swing') },
    { value: 'medium', label: t('hz.medium') },
    { value: 'long', label: t('hz.long') },
  ], filters.hz, (v) => setFilter({ hz: v }), t('alerts.title'));
  const sumBox = h('div'), listBox = h('div');
  fill(root,
    data.isDemo ? previewBanner() : null,
    screenHead(t('alerts.title'), t('alerts.sub')),
    h('div', { class: 'search-row' }, search, filterBtn),
    hzChips,
    activeChips(data),
    sumBox,
    older.loading ? h('p', { class: 'note faint', role: 'status' }, t('alerts.loadingOlder')) : null,
    older.error ? h('p', { class: 'note loss' }, t('alerts.olderFail', { why: older.error })) : null,
    listBox);
  drawList(data, listBox, sumBox, items);
}

function drawList(data, listBox, sumBox, items = applyFilters(allAlerts(data), filters)) {
  fill(sumBox, summaryPanel(items));
  if (!items.length) {
    fill(listBox, h('div', { class: 'empty' }, h('p', null, t('alerts.empty')),
      h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => { filters = { ...DEFAULT_FILTERS }; saveFilters(); redraw(); } }, t('alerts.clear'))));
    return;
  }
  const shown = items.slice(0, 400);
  const rows = [];
  const byDate = filters.sort === 'new' || filters.sort === 'old';
  if (byDate) {
    // A heading for each day with that day's numbers.
    const groups = new Map();
    for (const a of shown) { const d = ymdOf(a.time); if (!groups.has(d)) groups.set(d, []); groups.get(d).push(a); }
    for (const [d, list] of groups) {
      const s = summarize(list);
      rows.push(h('li', { class: 'day-head' },
        h('span', { class: 'day-name' }, dayName(d)),
        h('span', { class: 'day-stats num' }, t('alerts.dayCount', { n: list.length }),
          s.net != null ? h('b', { class: tone(s.net) }, ' · ' + fmt.signedMoney(s.net)) : null)));
      for (const a of list) rows.push(alertRow(a, openAlert));
    }
  } else {
    for (const a of shown) rows.push(alertRow(a, openAlert));
  }
  fill(listBox, h('ul', { class: 'list' }, rows), items.length > shown.length ? h('p', { class: 'note faint' }, t('alerts.more', { n: items.length - shown.length })) : null);
}

function dayName(ymd) {
  const today = istParts().ymd;
  if (ymd === today) return t('home.today').replace(/^./, (c) => c.toUpperCase());
  if (ymd === prevSession(today)) return t('alerts.prevSession') + ' · ' + fmt.dayMonth(dayStart(ymd) + 12 * 3600000);
  return fmt.shortDate(dayStart(ymd) + 12 * 3600000);
}

/** What the shown alerts add up to; the result counts filter the list when tapped. */
function summaryPanel(items) {
  const s = summarize(items);
  const q = (key, label, n) => h('button', { type: 'button', class: 'qchip', 'aria-pressed': String(filters.result === key), disabled: !n && filters.result !== key,
    onclick: () => setFilter({ result: filters.result === key ? 'all' : key }) }, label + ' ', h('b', { class: 'num' }, String(n)));
  return h('div', { class: 'panel alert-sum' },
    h('div', { class: 'stat-line', style: { marginTop: 0 } },
      h('span', null, h('b', null, fmt.int(s.n)), ' ' + t('alerts.sumAlerts')),
      h('span', null, h('b', null, fmt.int(s.traded)), ' ' + t('alerts.sumTraded')),
      h('span', null, h('b', null, fmt.int(s.open)), ' ' + t('alerts.sumOpen'))),
    h('div', { class: 'qchips' },
      q('target', '🎯 ' + t('alerts.r.target'), s.target),
      q('stop', '🛑 ' + t('alerts.r.stop'), s.stop),
      q('expired', '⏳ ' + t('alerts.r.expired'), s.expired),
      q('not', '⛔ ' + t('alerts.r.not'), s.not),
      q('open', '📂 ' + t('alerts.r.open'), s.open),
      s.pending ? q('pending', '🕓 ' + t('alerts.r.pending'), s.pending) : null),
    s.pending ? h('p', { class: 'note', style: { marginTop: '8px' } }, t('alerts.pendingNote', { n: s.pending })) : null,
    s.traded ? h('div', { class: 'stat-line' },
      h('span', null, t('results.win') + ' ', h('b', null, `${s.winRate}%`), ` (${s.won}/${s.traded})`),
      h('span', null, t('alerts.sumAvg') + ' ', h('b', { class: tone(s.avg) }, fmt.pct(s.avg))),
      s.net != null ? h('span', null, t('alerts.sumNet') + ' ', h('b', { class: tone(s.net) }, fmt.signedMoney(s.net))) : null) : null,
    s.traded ? h('p', { class: 'note faint', style: { marginTop: '6px' } }, t('alerts.sumNote')) : null);
}

function activeCount() {
  return ['period', 'result', 'dir', 'status', 'strategy', 'sort'].filter((k) => filters[k] !== DEFAULT_FILTERS[k]).length;
}

function labelFor(k, v, data) {
  if (k === 'period') return v === 'day' && filters.day ? fmt.shortDate(dayStart(filters.day) + 12 * 3600000) : t('alerts.p.' + v);
  if (k === 'result') return t('alerts.r.' + v);
  if (k === 'dir') return t('dir.' + v);
  if (k === 'status') return t('status.' + v);
  if (k === 'strategy') return data.strategy(v).name;
  if (k === 'sort') return t('alerts.s.' + v);
  return v;
}

/** The filters in use, each with a ✕ to remove it. */
function activeChips(data) {
  const keys = ['period', 'result', 'dir', 'status', 'strategy', 'sort'].filter((k) => filters[k] !== DEFAULT_FILTERS[k]);
  if (!keys.length) return null;
  return h('div', { class: 'tags active-filters' },
    keys.map((k) => h('span', { class: 'tag' }, labelFor(k, filters[k], data),
      h('button', { type: 'button', 'aria-label': t('alerts.removeFilter', { f: labelFor(k, filters[k], data) }), onclick: () => setFilter({ [k]: DEFAULT_FILTERS[k], ...(k === 'period' ? { day: '' } : {}) }) }, icon(ICONS.close)))),
    h('button', { type: 'button', class: 'sec-link', onclick: () => setFilter({ ...DEFAULT_FILTERS, q: filters.q, hz: filters.hz }) }, t('alerts.clearAll')));
}

/** All filters and the sort order in a bottom sheet. */
function openFilters(data) {
  openSheet((closeBtn) => {
    const showBtn = h('button', { type: 'button', class: 'btn btn-primary btn-block', onclick: () => closeSheet() });
    const updateCount = () => { showBtn.textContent = t('alerts.showN', { n: applyFilters(allAlerts(getData()), filters).length }); };
    const change = (patch) => { filters = { ...filters, ...patch }; saveFilters(); updateCount(); redraw(); ensureOlder(getData()); };
    const section = (title, el) => h('div', { class: 'field' }, h('span', { class: 'label' }, title), el);
    const dayInput = h('input', { type: 'date', class: 'date-input', value: filters.day || '', max: istParts().ymd, 'aria-label': t('alerts.p.day') });
    dayInput.addEventListener('change', () => { if (dayInput.value) change({ period: 'day', day: dayInput.value }); });
    const stratSel = h('select', { 'aria-label': t('alerts.strategy') },
      h('option', { value: 'all', selected: filters.strategy === 'all' }, t('alerts.allStrategies')),
      data.strategies.map((st) => h('option', { value: st.id, selected: filters.strategy === st.id }, st.name)));
    stratSel.addEventListener('change', () => change({ strategy: stratSel.value }));
    updateCount();
    return h('div', null,
      h('div', { class: 'sheet-head' }, h('div', { class: 'grow' }, h('h2', { class: 'sheet-title' }, t('alerts.filters'))), closeBtn),
      section(t('alerts.period'), h('div', null,
        filterChips(['all', 'today', 'prev', '7d', '30d'].map((v) => ({ value: v, label: t('alerts.p.' + v) })), filters.period, (v) => { dayInput.value = ''; change({ period: v, day: '' }); }, t('alerts.period')),
        h('div', { class: 'date-row' }, h('span', { class: 'faint' }, t('alerts.p.day')), dayInput))),
      section(t('alerts.result'), filterChips(['all', 'target', 'stop', 'expired', 'not', 'open', 'pending', 'profit', 'loss'].map((v) => ({ value: v, label: v === 'all' ? t('common.all') : t('alerts.r.' + v) })), filters.result, (v) => change({ result: v }), t('alerts.result'))),
      section(t('alerts.direction'), filterChips(['all', 'buy', 'short', 'exit'].map((v) => ({ value: v, label: v === 'all' ? t('common.all') : t('dir.' + v) })), filters.dir, (v) => change({ dir: v }), t('alerts.direction'))),
      section(t('alerts.strategy'), stratSel),
      section(t('alerts.stratStatus'), filterChips(['all', 'live', 'paper', 'rejected'].map((v) => ({ value: v, label: v === 'all' ? t('common.all') : t('status.' + v) })), filters.status, (v) => change({ status: v }), t('alerts.stratStatus'))),
      section(t('alerts.sort'), filterChips(['new', 'old', 'best', 'worst', 'conf'].map((v) => ({ value: v, label: t('alerts.s.' + v) })), filters.sort, (v) => change({ sort: v }), t('alerts.sort'))),
      h('div', { class: 'btn-row', style: { marginTop: '18px' } }, showBtn,
        h('button', { type: 'button', class: 'btn btn-ghost btn-block', onclick: () => { filters = { ...DEFAULT_FILTERS, q: filters.q, hz: filters.hz }; saveFilters(); closeSheet(); redraw(); } }, t('alerts.reset'))));
  }, { label: t('alerts.filters') });
}

/** Open the full alert in a bottom sheet. */
export function openAlert(a) {
  const data = getData();
  const st = data.strategy(a.strategy);
  openSheet((closeBtn) => {
    const isExit = a.dir === 'exit';
    const mid = isExit ? a.lastPrice : (a.entryLo + a.entryHi) / 2;
    const settings = getSettings();
    const size = isExit ? null : positionSize(mid, a.stop, settings);

    const head = h('div', { class: 'sheet-head' },
      h('div', { class: 'grow' },
        h('h2', { class: 'sheet-title' }, a.symbol),
        h('div', { class: 'sheet-sub' }, dirChip(a.dir), horizonTag(a.horizon, true), statusChip(a.status)),
        h('div', { class: 'sheet-sub' }, h('span', null, a.strategyName), h('span', { class: 'faint num' }, `${fmt.dayMonth(a.time)} ${fmt.time(a.time)}`))),
      closeBtn);

    const drawChart = (c) => candleChart({
      candles: c.candles,
      levels: isExit ? {} : { entryLo: a.entryLo, entryHi: a.entryHi, stop: a.stop, targets: a.targets },
      overlays: (c.overlays || []).map((o) => ({ values: o.values, label: overlayLabel(o.key) })),
      mode: c.mode,
      label: `${a.symbol} ${t('stock.chart')}`,
    });
    // Sample alerts carry their chart; live ones load it from the engine when opened.
    const chart = a.chart ? drawChart(a.chart) : h('div', { class: 'chart', style: { minHeight: '120px', display: 'grid', placeItems: 'center' } }, h('span', { class: 'faint' }, t('alert.chartLoading')));
    if (!a.chart) {
      loadAlertChart(a).then((c) => chart.replaceWith(c && c.candles.length ? drawChart(c) : h('p', { class: 'muted' }, t('alert.chartNone'))))
        .catch((e) => chart.replaceWith(h('p', { class: 'muted' }, t('alert.chartFail', { why: e.message }))));
    }

    const plan = isExit
      ? kvList([
        [t('alert.lastPrice'), fmt.price(a.lastPrice), 'em'],
        [t('stock.dma200'), fmt.price(a.dma200)],
        [t('alert.confidence'), `${a.confidence}/100`],
      ])
      : kvList([
        [t('alert.entryZone'), fmt.priceRange(a.entryLo, a.entryHi), 'em'],
        [t('alert.stop'), fmt.price(a.stop), 'loss'],
        ...a.targets.map((v, i) => [a.targets.length > 1 ? t('alert.target' + (i + 1)) : t('alert.target'), fmt.price(v), 'gain']),
        [t('alert.rr'), fmt.num(a.rr, 1)],
        [t('alert.valid'), `${fmt.dayMonth(a.validTill)} ${fmt.time(a.validTill)}`],
        [t('alert.confidence'), `${a.confidence}/100`],
      ]);

    const sizeBlock = size ? h('div', null,
      h('h3', null, t('alert.size')),
      kvList([
        [t('alert.qty'), fmt.int(size.qty), 'em'],
        [t('alert.capitalUsed'), fmt.money(size.capitalUsed)],
        [t('alert.riskShare'), fmt.price(size.riskPerShare)],
        [t('alert.maxLoss'), fmt.money(size.maxLoss), 'loss'],
      ]),
      h('p', { class: 'note' }, t('alert.sizeNote', { cap: fmt.money(settings.realCapital), risk: settings.riskPct, max: settings.maxPerStockPct })),
      size.cappedByMax ? h('p', { class: 'note' }, t('alert.capped', { max: settings.maxPerStockPct, n: fmt.int(size.byRisk) })) : null) : null;

    const record = h('div', null,
      h('h3', null, t('alert.record')),
      h('div', { class: 'sheet-sub', style: { marginTop: 0 } }, h('span', null, st.name),
        h('span', { class: 'faint' }, st.trades >= 30 ? t('results.tradesDone', { n: st.trades }) : t('results.trades', { n: st.trades }))),
      trackStrip(st.outcomes),
      stripLegend());

    const statusNote = h('div', { class: 'paper-note' }, icon(ICONS.shield),
      h('span', null, isExit ? t('alert.exitNote')
        : a.dir === 'short' ? t('alert.shortNote')
          : a.status === 'live' ? t('status.liveNote', { win: st.win, n: st.trades }) : t('status.paperNote')));
    const p = a.paper;
    const paperLine = p && p.qty > 0 ? h('p', { class: 'note' }, t('alert.paperResult', { qty: fmt.int(p.qty), fill: fmt.price(p.fill) }) +
      (p.exit != null && p.net != null ? t('alert.paperExit', { exit: fmt.price(p.exit), net: fmt.signedMoney(p.net) }) : '') + '.') : null;

    const orderText = isExit
      ? [`EXIT ${a.symbol} (NSE)`, `Reason: ${a.headline}`, `Last price: ${fmt.price(a.lastPrice)}`, `Stock Radar ${a.status === 'live' ? '' : '[PAPER]'}`].join('\n')
      : [`${a.dir === 'short' ? 'SELL (short, intraday MIS)' : 'BUY'} ${a.symbol} (NSE)`, size ? `Qty: ${size.qty}` : '', `Limit: ${fmt.price(mid)} (zone ${fmt.priceRange(a.entryLo, a.entryHi)})`,
        `Stop-loss: ${fmt.price(a.stop)}`, `Target: ${a.targets.map(fmt.price).join(' / ')}`,
        `${t('hz.' + a.horizon)} (${t('hzw.' + a.horizon)})`, `Stock Radar ${a.status === 'live' ? '' : '[PAPER]'}`].filter(Boolean).join('\n');

    const actions = h('div', { class: 'btn-row' },
      h('button', {
        type: 'button', class: 'btn btn-primary',
        onclick: async () => toast((await copyText(orderText)) ? t('alert.copied') : t('alert.copyFail')),
      }, icon(ICONS.copy), t('alert.copy')),
      h('a', { class: 'btn btn-ghost', href: 'https://kite.zerodha.com/', target: '_blank', rel: 'noopener' }, icon(ICONS.external), t('alert.kite')));

    return h('div', null, head, chart, statusNote, paperLine,
      h('h3', null, isExit ? t('alert.changed') : t('alert.plan')),
      isExit ? h('p', { class: 'muted', style: { marginBottom: '10px' } }, a.headline) : null,
      plan, sizeBlock,
      h('h3', null, t('alert.why')),
      h('ul', { class: 'bullets' }, a.why.map((w) => h('li', null, w))),
      record, actions);
  }, { label: a.symbol });
}
