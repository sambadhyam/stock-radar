// lab.js — Backtest lab: the engine's Backtest Baseline, and tests of your own run on this phone.
import { h, fmt, tone, fill, append } from '../util.js';
import { t } from '../i18n.js';
import { screenHead, previewBanner, segmented, openSheet, toast, horizonTag } from '../ui.js';
import { equityChart } from '../charts.js';
import { getData, refresh } from '../data.js';
import { api, isConnected } from '../api.js';
import { loadOverview, cachedOverview, runBacktest, downloadEstimateMb } from '../backtest.js';
import { openExplorer } from './explore.js';

const GROUPS = [['SWING', 'swing'], ['MEDIUM', 'medium'], ['INTRADAY', 'intraday']];
const COMMON_DAILY = ['minRROther', 'minTradedValueCr'];
const COMMON_INTRA = ['intraday.atrStopMult', 'intraday.maxRiskPct', 'minRRIntraday', 'minTradedValueCr'];
const SWING = ['swing.holdDays', 'swing.maxRiskPct', 'swing.cooldownDays'];
const MEDIUM = ['medium.holdDays', 'medium.maxRiskPct', 'medium.cooldownDays'];
/** The settings that change each strategy's signals (keys of SRCore.PARAMS). */
const STRAT_PARAMS = {
  'base-breakout': ['breakout.baseBars', 'breakout.maxBasePct', 'breakout.volMult', ...SWING, ...COMMON_DAILY],
  'ema-pullback': ['pullback.touchPct', ...SWING, ...COMMON_DAILY],
  rsi2: ['rsi2.max', ...SWING, ...COMMON_DAILY],
  macd: [...SWING, ...COMMON_DAILY],
  'trend-template': ['trend.minAboveLowPct', 'trend.maxBelowHighPct', 'trend.minRsPct', ...MEDIUM, ...COMMON_DAILY],
  'rs-leaders': ['medium.rsTopPct', ...MEDIUM, ...COMMON_DAILY],
  'near-high': ['nearHigh.withinPct', ...MEDIUM, ...COMMON_DAILY],
  orb: ['orb.minutes', 'orb.volMult', 'orb.maxChaseFrac', ...COMMON_INTRA],
  vwap: ['vwap.volMult', ...COMMON_INTRA],
  'ema-cross': ['emaCross.rsiMin', 'emaCross.rsiMax', ...COMMON_INTRA],
  gap: ['gap.minPct', 'gap.maxPct', 'gap.windowMinutes', ...COMMON_INTRA],
};

// Kept between redraws (fresh engine data redraws the screen every few minutes).
const state = { loading: false, error: null, form: null, run: null, starting: false };
let root = null;

export function render({ data }) {
  root = h('div');
  draw(data);
  const live = isConnected() && !data.isDemo;
  if (live && !cachedOverview() && !state.loading && !state.error) load(false);
  return root;
}

function redraw() { if (root && root.isConnected) draw(getData()); }

async function load(force) {
  state.loading = true; state.error = null; redraw();
  try { await loadOverview(force); } catch (e) { state.error = e.message; }
  state.loading = false; redraw();
}

function draw(data) {
  const live = isConnected() && !data.isDemo;
  const ov = live ? cachedOverview() : data.lab;
  fill(root,
    data.isDemo ? previewBanner() : null,
    screenHead(t('backtest.title'), t('backtest.sub'), '#/more'),
    cautions(),
    baselineSection(data, ov, live),
    live ? customSection(data, ov) : h('section', { class: 'sec' }, h('h2', { class: 'sec-title' }, t('backtest.custom')), h('p', { class: 'muted' }, t('backtest.connectFirst'))));
}

/* ---------- What a backtest can and cannot tell you ---------- */

function cautions() {
  return h('details', { class: 'panel note-panel' },
    h('summary', null, t('backtest.cautionTitle')),
    h('ul', { class: 'bullets', style: { marginTop: '10px' } },
      ['survivor', 'lookahead', 'costs', 'sizing', 'intraday', 'future'].map((k) => h('li', null, t('backtest.caution.' + k)))));
}

/* ---------- The engine's baseline ---------- */

function baselineSection(data, ov, live) {
  const info = live ? (ov && ov.info) || (data.backtest || {}) : (data.lab && data.lab.info) || {};
  const result = ov && ov.result;
  const head = h('div', { class: 'sec-head' }, h('h2', { class: 'sec-title' }, t('backtest.baseline')));
  const body = [];
  if (live && state.loading && !result) body.push(h('p', { class: 'muted' }, t('backtest.loading')));
  if (live && state.error) body.push(h('p', { class: 'note' }, t('backtest.loadFail', { why: state.error })), h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => load(true) }, t('backtest.retry')));
  if (info.state === 'running') body.push(h('div', { class: 'panel' }, h('b', null, t('backtest.running')), h('p', { class: 'muted', style: { marginTop: '4px' } }, info.note || ''), h('p', { class: 'note faint' }, t('backtest.runningNote'))));
  if (info.state === 'failed') body.push(h('p', { class: 'note' }, t('backtest.failed', { why: info.error || '' })));
  if (live && (info.state === 'none' || info.state === 'failed') && !result) body.push(h('p', { class: 'muted' }, t('backtest.none', { years: (data.settings && data.settings.backtestYears) || 10 })), startButton(info));
  if (result) {
    body.push(h('p', { class: 'sec-note' }, t('backtest.period', {
      n: result.daily.symbols, list: result.universe, from: monthYear(result.daily.from), to: monthYear(result.daily.to), s: result.intraday.sessions,
    }) + (result.at ? ' ' + t('backtest.ranOn', { date: fmt.shortDate(result.at) }) : '')));
    for (const [hz, key] of GROUPS) {
      const ids = Object.keys(result.strategies).filter((id) => result.strategies[id].horizon === hz);
      if (!ids.length) continue;
      body.push(h('h3', { class: 'lab-group' }, t('hz.' + key)), h('ul', { class: 'list' }, ids.map((id) => baselineRow(id, result.strategies[id], result))));
    }
    body.push(h('p', { class: 'note faint' }, t('backtest.verdictKey')));
    if (live) {
      body.push(h('div', { style: { marginTop: '14px' } },
        h('button', { type: 'button', class: 'btn btn-ghost btn-block', onclick: () => openExplorer(result) }, t('explore.open')),
        h('p', { class: 'note faint', style: { marginTop: '6px' } }, t('explore.openSub'))));
    }
    if (result.filter && result.filter.length) body.push(filterCheck(result.filter));
    if (live && info.state !== 'running') body.push(startButton(info, true));
  }
  return h('section', { class: 'sec' }, head, body);
}

function startButton(info, again = false) {
  const b = h('button', { type: 'button', class: again ? 'sec-link' : 'btn btn-primary', disabled: state.starting }, again ? t('backtest.runAgain') : t('backtest.start'));
  b.addEventListener('click', async () => {
    state.starting = true; b.disabled = true;
    try { await api.btStart(); toast(t('backtest.started')); await refresh(); await load(true); } catch (e) { toast(e.message); }
    state.starting = false; redraw();
  });
  return b;
}

const VERDICT_CHIP = { good: 'buy', thin: 'paper', loses: 'rejected', few: 'sample' };
function verdictChip(v) { return h('span', { class: 'chip ' + (VERDICT_CHIP[v] || 'sample') }, t('backtest.verdict.' + (v || 'few'))); }

/** Profit factor, or "no losses" when there were trades but not one lost (the factor is then undefined). */
function pfText(m) {
  if (!m || !m.trades) return '—';
  return m.profitFactor != null ? fmt.num(m.profitFactor, 2) : t('backtest.noLosses');
}

function numbersLine(m) {
  if (!m || !m.trades) return h('span', { class: 'row-levels faint' }, t('backtest.noTrades'));
  return h('span', { class: 'row-levels num' },
    h('span', null, t('backtest.trades', { n: fmt.int(m.trades) })),
    h('span', null, t('results.win') + ' ', h('b', null, `${m.winRatePct}%`)),
    h('span', null, t('backtest.avg') + ' ', h('b', { class: tone(m.expectancyPct) }, fmt.pct(m.expectancyPct))),
    h('span', null, 'PF ', h('b', null, pfText(m))));
}

function baselineRow(id, s, result) {
  return h('li', null, h('button', { type: 'button', class: 'row', onclick: () => openResult(s.name, s.horizon, s, { result, label: t('backtest.baseline') }) },
    h('span', { class: 'row-title', style: { fontSize: '16px' } }, s.name),
    h('span', { class: 'row-side' }, verdictChip(s.verdict)),
    numbersLine(s.metrics)));
}

function filterCheck(list) {
  const names = { INTRADAY: t('hz.intraday'), SWING: t('hz.swing'), MEDIUM: t('hz.medium') };
  return h('div', { class: 'panel', style: { marginTop: '14px' } },
    h('b', null, t('backtest.filterTitle')),
    h('ul', { class: 'bullets', style: { marginTop: '8px' } }, list.map((f) => h('li', null, t('backtest.filterLine', {
      hz: names[f.horizon] || f.horizon, by: t('backtest.filterBy.' + f.filter), n: fmt.int(f.blocked), avg: fmt.pct(f.blockedAvg), takenAvg: fmt.pct(f.takenAvg), taken: fmt.int(f.taken),
    })))),
    h('p', { class: 'note faint' }, t('backtest.filterNote')));
}

/* ---------- One strategy's result in a sheet ---------- */

function openResult(name, horizon, s, { result, label, compare } = {}) {
  const m = s.metrics || {};
  const cap = (result && result.capital) || 100000;
  openSheet((closeBtn) => h('div', null,
    h('div', { class: 'sheet-head' },
      h('div', { class: 'grow' }, h('h2', { class: 'sheet-title' }, name), h('div', { class: 'sheet-sub' }, horizonTag(String(horizon).toLowerCase(), true), s.verdict ? verdictChip(s.verdict) : null, label ? h('span', null, label) : null)),
      closeBtn),
    m.trades ? h('div', null,
      h('dl', { class: 'kv', style: { marginTop: '6px' } },
        kv(t('backtest.k.trades'), fmt.int(m.trades) + (m.days ? ' · ' + t('backtest.k.onDays', { n: fmt.int(m.days) }) : '')),
        kv(t('results.win'), `${m.winRatePct}%`),
        kv(t('backtest.k.avg'), fmt.pct(m.expectancyPct), tone(m.expectancyPct)),
        kv(t('backtest.k.avgWinLoss'), fmt.pct(m.avgWinPct) + ' / ' + fmt.pct(m.avgLossPct)),
        kv(t('results.pf'), pfText(m)),
        kv(t('backtest.k.dd'), m.maxDrawdownPct != null ? fmt.pct(-m.maxDrawdownPct, 1) : '—', 'loss'),
        kv(t('backtest.k.total'), m.totalNetPnl != null ? fmt.signedMoney(m.totalNetPnl) + ' (' + fmt.pct(m.returnPct, 1) + ')' : '—', tone(m.totalNetPnl)),
        s.cagrPct != null ? kv(t('backtest.k.cagr'), fmt.pct(s.cagrPct, 1), tone(s.cagrPct)) : null,
        kv(t('results.vsNifty'), m.avgAlphaPct != null ? fmt.pct(m.avgAlphaPct) + ' ' + t('backtest.k.perTrade') : '—', tone(m.avgAlphaPct)),
        kv(t('backtest.k.hold'), m.avgHoldDays != null ? (String(horizon) === 'INTRADAY' ? t('backtest.k.minutes', { n: Math.round(m.avgHoldDays * 375) }) : t('backtest.k.days', { n: fmt.num(m.avgHoldDays, 1) })) : '—'),
        s.maxOpen ? kv(t('backtest.k.maxOpen'), fmt.int(s.maxOpen)) : null),
      compare ? compareTable(compare, m) : null,
      s.curve && s.curve.length > 1 ? h('div', null, h('h3', null, t('backtest.curve', { cap: fmt.money(cap) })), equityChart({ points: s.curve, base: cap, long: true, label: t('backtest.curve', { cap: fmt.money(cap) }) })) : null,
      breakdown(t('backtest.byRegime'), s.regimes, (k) => t('regimeName.' + ({ BULL: 'bull', NEUTRAL: 'neutral', BEAR: 'bear', HIGH_VOL: 'volatile' }[k] || 'unknown'))),
      breakdown(t('backtest.byYear'), s.years, (k) => k, true),
      s.shadow && s.shadow.trades ? h('p', { class: 'note' }, t('backtest.shadowLine', { n: fmt.int(s.shadow.trades), avg: fmt.pct(s.shadow.expectancyPct), win: s.shadow.winRatePct })) : null,
      sampleTrades(s.sample, horizon)) : h('p', { class: 'muted', style: { marginTop: '10px' } }, t('backtest.noTrades')),
    s.counts ? h('p', { class: 'note faint' }, t('backtest.counts', { s: s.counts.symbols, open: s.counts.open, nt: s.counts.notTriggered })) : null,
    h('p', { class: 'note faint' }, t('backtest.sheetNote'))), { label: name });
}

function kv(label, value, cls) { return [h('dt', null, label), h('dd', { class: 'num ' + (cls || '') }, value)]; }

function compareTable(base, m) {
  const b = base.metrics || {};
  const row = (label, a, c) => h('tr', null, h('th', { scope: 'row' }, label), h('td', { class: 'num' }, a), h('td', { class: 'num' }, c));
  return h('div', null, h('h3', null, t('backtest.vsBaseline')),
    h('table', { class: 'cmp' },
      h('thead', null, h('tr', null, h('th', { scope: 'col' }, h('span', { class: 'visually-hidden' }, t('backtest.k.trades'))), h('th', { scope: 'col' }, t('backtest.yourTest')), h('th', { scope: 'col' }, t('backtest.baseline')))),
      h('tbody', null,
        row(t('backtest.k.trades'), fmt.int(m.trades), fmt.int(b.trades)),
        row(t('results.win'), m.winRatePct != null ? `${m.winRatePct}%` : '—', b.winRatePct != null ? `${b.winRatePct}%` : '—'),
        row(t('backtest.k.avg'), fmt.pct(m.expectancyPct), fmt.pct(b.expectancyPct)),
        row(t('results.pf'), pfText(m), pfText(b)),
        row(t('backtest.k.dd'), m.maxDrawdownPct != null ? fmt.pct(-m.maxDrawdownPct, 1) : '—', b.maxDrawdownPct != null ? fmt.pct(-b.maxDrawdownPct, 1) : '—'))));
}

function breakdown(title, obj, label, money = false) {
  const keys = Object.keys(obj || {});
  if (!keys.length) return null;
  keys.sort();
  return h('div', null, h('h3', null, title),
    h('table', { class: 'cmp' },
      h('thead', null, h('tr', null, h('th', { scope: 'col' }, h('span', { class: 'visually-hidden' }, title)), h('th', { scope: 'col' }, t('backtest.k.trades')), h('th', { scope: 'col' }, t('results.win')), h('th', { scope: 'col' }, money ? t('backtest.k.pnl') : t('backtest.avg')))),
      h('tbody', null, keys.map((k) => {
        const x = obj[k];
        return h('tr', null, h('th', { scope: 'row' }, label(k)), h('td', { class: 'num' }, fmt.int(x.trades)), h('td', { class: 'num' }, x.winRatePct != null ? `${x.winRatePct}%` : '—'),
          h('td', { class: 'num ' + tone(money ? x.totalNetPnl : x.expectancyPct) }, money ? (x.totalNetPnl != null ? fmt.signedMoney(x.totalNetPnl) : fmt.pct(x.expectancyPct)) : fmt.pct(x.expectancyPct)));
      }))));
}

function sampleTrades(list, horizon) {
  if (!list || !list.length) return null;
  const out = { T: t('legend.win'), S: t('legend.loss'), E: t('legend.flat') };
  return h('div', null, h('h3', null, t('backtest.sample')),
    h('ul', { class: 'list' }, list.slice(0, 15).map(([sym, dayT, dir, o, pct, exitT]) => h('li', null, h('div', { class: 'row' },
      h('span', { class: 'row-title', style: { fontSize: '15px' } }, (dir === 'S' ? t('backtest.short') + ' ' : '') + sym),
      h('span', { class: 'row-right num ' + tone(pct) }, fmt.pct(pct)),
      // Newest exit first, so the dates read signal → exit.
      h('span', { class: 'row-meta' }, (String(horizon) === 'INTRADAY'
        ? fmt.shortDate(dayT) + ' ' + fmt.time(dayT) + (exitT ? '–' + fmt.time(exitT) : '')
        : exitT ? fmt.dayMonth(dayT) + ' → ' + fmt.shortDate(exitT) : fmt.shortDate(dayT)) + ' · ' + (out[o] || o)))))));
}

function monthYear(ymd) { return ymd ? fmt.monthYear(Date.parse(ymd + 'T12:00:00+05:30')) : '—'; }

/** Years from the baseline's first possible trade to its last day. */
function testedYears(result) {
  const a = Date.parse((result.daily.from || '') + 'T12:00:00+05:30'), b = Date.parse((result.daily.to || '') + 'T12:00:00+05:30');
  return Number.isFinite(a) && Number.isFinite(b) && b > a ? (b - a) / (365.25 * 86400000) : 1;
}

/* ---------- Your own test ---------- */

function defaultForm(data, ov) {
  const ids = Object.keys((ov && ov.result && ov.result.strategies) || {});
  const settings = data.settings || {};
  return {
    strategy: ids.includes('base-breakout') ? 'base-breakout' : ids[0] || 'base-breakout', list: 'nifty50', years: 0, respectRegime: true,
    rules: { followNifty: settings.intradayFollowNifty !== false, onePerStock: settings.intradayOneAlertPerStock !== false, blockBuysInBear: !!settings.intradayBlockBuysInBear, blockShortsInBull: !!settings.intradayBlockShortsInBull },
    params: {},
  };
}

function customSection(data, ov) {
  const sec = h('section', { class: 'sec' }, h('h2', { class: 'sec-title' }, t('backtest.custom')), h('p', { class: 'sec-note' }, t('backtest.customNote')));
  if (!ov || !ov.result) { sec.append(h('p', { class: 'muted' }, t('backtest.customWait'))); return sec; }
  if (!state.form) state.form = defaultForm(data, ov);
  const f = state.form, result = ov.result, strategies = result.strategies;
  const strat = strategies[f.strategy] ? f.strategy : Object.keys(strategies)[0];
  f.strategy = strat;
  const intraday = strategies[strat].horizon === 'INTRADAY';
  const info = Object.fromEntries((ov.paramInfo || []).map((p) => [p[0], p]));
  const current = data.params || {};

  const select = h('select', { id: 'bt-strategy', 'aria-label': t('backtest.strategy') },
    GROUPS.map(([hz, key]) => h('optgroup', { label: t('hz.' + key) },
      Object.keys(strategies).filter((id) => strategies[id].horizon === hz).map((id) => h('option', { value: id, selected: id === strat }, strategies[id].name)))));
  select.addEventListener('change', () => { f.strategy = select.value; f.params = {}; if (strategies[f.strategy].horizon === 'INTRADAY' && f.list === 'universe') f.list = 'intraday'; if (strategies[f.strategy].horizon !== 'INTRADAY' && f.list === 'intraday') f.list = 'nifty50'; redraw(); });

  // The engine's backtest list gets its own button only when it is bigger than Nifty 50 (Nifty 200 by default).
  const wider = (ov.lists.universe || []).length > (ov.lists.nifty50 || []).length;
  const lists = intraday
    ? [{ value: 'intraday', label: t('backtest.list.intraday') }, { value: 'watchlist', label: t('backtest.list.watchlist') }]
    : [{ value: 'nifty50', label: t('backtest.list.nifty50') }, wider ? { value: 'universe', label: ov.lists.universeName || 'Nifty 200' } : null, { value: 'watchlist', label: t('backtest.list.watchlist') }].filter(Boolean);
  if (!lists.some((x) => x.value === f.list)) f.list = lists[0].value;
  const symbols = symbolsFor(f.list, ov.lists, intraday);
  // A test covers all the history the engine holds (like the baseline) or only its latest years.
  const tested = testedYears(result);
  const yearOptions = [3, 5, 10].filter((y) => y < tested - 0.5).map((y) => ({ value: y, label: t('backtest.yearsN', { n: y }) }))
    .concat([{ value: 0, label: t('backtest.yearsAll') }]);
  if (!yearOptions.some((o) => o.value === f.years)) f.years = 0;

  const sw = (id, label, sub, on, set) => {
    const input = h('input', { id, type: 'checkbox', role: 'switch', class: 'switch', checked: on });
    input.addEventListener('change', () => set(input.checked));
    return h('div', { class: 'srow' }, h('label', { class: 'srow-text', for: id }, h('span', null, label), sub ? h('small', null, sub) : null), input);
  };
  const rules = intraday ? [
    sw('bt-day', t('settings.followNifty'), t('settings.followNiftySub'), f.rules.followNifty, (v) => { f.rules.followNifty = v; }),
    sw('bt-one', t('settings.onePerStock'), null, f.rules.onePerStock, (v) => { f.rules.onePerStock = v; }),
    sw('bt-bear', t('settings.blockBuysBear'), null, f.rules.blockBuysInBear, (v) => { f.rules.blockBuysInBear = v; }),
    sw('bt-bull', t('settings.blockShortsBull'), null, f.rules.blockShortsInBull, (v) => { f.rules.blockShortsInBull = v; }),
  ] : [sw('bt-regime', t('backtest.respectRegime'), t('backtest.respectRegimeSub'), f.respectRegime, (v) => { f.respectRegime = v; })];

  const keys = STRAT_PARAMS[strat] || [];
  const inputs = keys.map((k) => {
    const id = 'bt-p-' + k.replace(/\W/g, '-'), base = current[k] != null ? current[k] : info[k] ? info[k][1] : '';
    const input = h('input', { id, type: 'number', inputmode: 'decimal', step: 'any', value: String(f.params[k] != null ? f.params[k] : base) });
    // Only values that differ from the engine's count as changes (a blank box means the engine's value).
    input.addEventListener('input', () => { const v = Number(input.value); if (input.value !== '' && Number.isFinite(v) && v !== Number(base)) f.params[k] = v; else delete f.params[k]; });
    return h('div', { class: 'field' }, h('label', { for: id }, info[k] ? info[k][2] : k), input, h('span', { class: 'hint' }, t('backtest.paramNow', { v: base })));
  });
  const params = h('details', { class: 'param-box' }, h('summary', null, t('backtest.params', { n: keys.length })), h('div', { style: { marginTop: '12px' } }, inputs,
    h('button', { type: 'button', class: 'sec-link', onclick: () => { f.params = {}; redraw(); } }, t('backtest.paramReset'))));

  const status = h('p', { class: 'note', role: 'status', 'aria-live': 'polite' }, state.run && state.run.status === 'running' ? state.run.progress || t('backtest.working') : '');
  // Everything the engine holds is downloaded once, whatever period is tested (a 200-day warm-up comes before the first trade).
  const mb = intraday ? downloadEstimateMb('intraday', symbols.length, result.intraday.sessions) : downloadEstimateMb('daily', symbols.length, tested + 0.8);
  const runBtn = h('button', { type: 'button', class: 'btn btn-primary btn-block', disabled: !symbols.length || (state.run && state.run.status === 'running') }, t('backtest.run'));
  runBtn.addEventListener('click', () => start(data, ov, symbols, intraday));
  const period = intraday
    ? h('p', { class: 'sec-note', style: { marginTop: '-6px', marginBottom: '14px' } }, t('backtest.intradayPeriod', { s: result.intraday.sessions }))
    : h('div', { class: 'field' }, h('span', { class: 'label' }, t('backtest.years')),
      yearOptions.length > 1 ? segmented(yearOptions, f.years, (v) => { f.years = v; redraw(); }, t('backtest.years')) : null,
      h('span', { class: 'hint' }, t(yearOptions.length > 1 ? 'backtest.yearsHint' : 'backtest.yearsHintAll', { from: monthYear(result.daily.from), to: monthYear(result.daily.to) })));

  append(sec,
    h('div', { class: 'field' }, h('label', { for: 'bt-strategy' }, t('backtest.strategy')), select),
    h('div', { class: 'field' }, h('span', { class: 'label' }, t('backtest.stocks')),
      segmented(lists, f.list, (v) => { f.list = v; redraw(); }, t('backtest.stocks')),
      h('span', { class: 'hint' }, t('backtest.stocksHint', { n: symbols.length, mb: mb < 1 ? '<1' : Math.round(mb) }))),
    period,
    h('div', { style: { marginBottom: '8px' } }, rules),
    keys.length ? params : null,
    h('div', { style: { marginTop: '16px' } }, runBtn),
    status,
    state.run && state.run.status === 'error' ? h('p', { class: 'note loss' }, state.run.error) : null,
    state.run && state.run.status === 'done' ? resultCard(state.run, strategies) : null);
  return sec;
}

function symbolsFor(list, lists, intraday) {
  if (list === 'watchlist') return (lists.watchlist || []).filter((s) => (intraday ? lists.intraday : lists.universe).includes(s) || !intraday);
  if (list === 'intraday') return lists.intraday || [];
  if (list === 'universe') return lists.universe || [];
  return lists.nifty50 && lists.nifty50.length ? lists.nifty50 : (lists.universe || []).slice(0, 50);
}

async function start(data, ov, symbols, intraday) {
  const f = state.form, lab = data.labSettings || {};
  const sizing = { ...(lab.sizing || { capital: 100000, riskPct: 1, maxPer: 10 }), fractional: true };
  const job = {
    kind: intraday ? 'intraday' : 'daily', strategy: f.strategy, symbols, years: f.years, respectRegime: f.respectRegime, rules: { ...f.rules },
    params: { ...(data.params || {}), ...f.params }, sizing, rates: lab.rates || {}, lab: { cooldownMinutes: lab.cooldownMinutes || 60, lastEntryMinute: lab.lastEntryMinute || 870, expiryMinute: lab.expiryMinute || 915 },
    changed: Object.keys(f.params).length,
  };
  state.run = { status: 'running', progress: t('backtest.working'), job };
  redraw();
  try {
    const res = await runBacktest(job, (p) => {
      state.run.progress = p.phase === 'download' ? t('backtest.downloading', { done: p.done, total: p.total }) : t('backtest.testing', { done: p.done, total: p.total });
      const el = root && root.querySelector('[role=status]');
      if (el) el.textContent = state.run.progress;
    });
    state.run = { status: 'done', result: res, job };
  } catch (e) {
    state.run = { status: 'error', error: t('backtest.runFail', { why: e.message }), job };
  }
  redraw();
}

function resultCard(run, strategies) {
  const r = run.result, m = r.metrics, base = strategies[run.job.strategy], name = base ? base.name : run.job.strategy;
  const changed = run.job.changed || 0;
  return h('div', { class: 'panel', style: { marginTop: '14px' } },
    h('div', { class: 'sec-head' }, h('b', null, t('backtest.yourResult', { name })), r.from ? h('span', { class: 'faint num', style: { fontSize: '13px' } }, fmt.monthYear(r.from) + ' – ' + fmt.monthYear(r.to)) : null),
    numbersLine(m),
    m.trades ? h('div', { style: { marginTop: '8px' } }, equityChart({ points: r.curve, base: run.job.sizing.capital, long: true, mini: true, label: t('backtest.curveShort') })) : null,
    h('button', { type: 'button', class: 'btn btn-ghost btn-block', style: { marginTop: '12px' }, disabled: !m.trades,
      onclick: () => openResult(name, base ? base.horizon : '', r, { result: { capital: run.job.sizing.capital }, label: t('backtest.yourTest'), compare: base }) }, t('backtest.details')),
    h('p', { class: 'note faint', style: { marginTop: '10px' } }, t('backtest.yourNote', { n: r.counts.symbols }) + ' ' + (changed ? t('backtest.changed', { n: changed }) : t('backtest.changedNone'))));
}
