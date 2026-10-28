// Results: strategy board with track records, paper trades, readiness and weekly reports.
import { h, fmt, tone, istParts } from '../util.js';
import { t } from '../i18n.js';
import {
  screenHead, segmented, horizonTag, statusChip, trackStrip, stripLegend, openSheet, previewBanner, outcomeLabel,
} from '../ui.js';
import { equityChart } from '../charts.js';
import { toast } from '../ui.js';
import { getData, refresh } from '../data.js';
import { api, isConnected } from '../api.js';
import { reviewSection } from './review.js';

const HZ_ORDER = ['intraday', 'swing', 'medium', 'long'];

export function render({ data, query }) {
  let tab = query.get('tab') || 'strategies';
  const body = h('div');
  const draw = () => body.replaceChildren(tab === 'paper' ? paperTab(data) : tab === 'reports' ? reportsTab(data) : strategiesTab(data));
  draw();
  return h('div', null,
    data.isDemo ? previewBanner() : null,
    screenHead(t('results.title')),
    segmented([
      { value: 'strategies', label: t('results.strategies') },
      { value: 'paper', label: t('results.paper') },
      { value: 'reports', label: t('results.reports') },
    ], tab, (v) => { tab = v; draw(); }, t('results.title')),
    body);
}

function tradesLabel(st) {
  // Live data carries how many different days the trades came from; graduation needs enough of both.
  const need = (getData().rules && getData().rules.minDays) || 15;
  if (st.days != null && st.trades && (st.trades < 30 || st.days < need)) return t('results.tradesDays', { n: st.trades, d: st.days, need });
  return st.trades >= 30 ? t('results.tradesDone', { n: st.trades }) : t('results.trades', { n: st.trades });
}

function metricsLine(st) {
  if (!st.trades) return h('span', { class: 'row-levels faint' }, t('results.none'));
  return h('span', { class: 'row-levels num' },
    h('span', null, t('results.win') + ' ', h('b', null, `${st.win}%`)),
    st.avg != null ? h('span', null, t('results.avg') + ' ', h('b', { class: tone(st.avg) }, fmt.pct(st.avg))) : null,
    st.pf != null ? h('span', null, 'PF ', h('b', null, fmt.num(st.pf, 2))) : null);
}

function strategyRow(st) {
  return h('li', null,
    h('button', { type: 'button', class: 'row', onclick: () => openStrategy(st) },
      h('span', { class: 'row-title', style: { fontSize: '16px' } }, st.name),
      h('span', { class: 'row-side' }, statusChip(st.status)),
      h('span', { class: 'row-meta' }, tradesLabel(st)),
      h('span'),
      h('span', { style: { gridColumn: '1 / -1' } }, trackStrip(st.outcomes)),
      metricsLine(st)));
}

function strategiesTab(data) {
  const live = data.strategies.filter((s) => s.status === 'live').length;
  const rej = data.strategies.filter((s) => s.status === 'rejected').length;
  const paper = data.strategies.length - live - rej;
  const groups = HZ_ORDER.map((hz) => {
    const items = data.strategies.filter((s) => s.horizon === hz);
    if (!items.length) return null;
    return h('section', { class: 'sec', style: { marginTop: '24px' } },
      h('h2', { class: 'sec-title' }, t('hz.' + hz)),
      h('ul', { class: 'list' }, items.map(strategyRow)));
  });
  return h('div', null,
    h('p', { class: 'sec-note' }, h('b', null, t('results.summary', { live, paper, rej }))),
    h('p', { class: 'sec-note' }, t('results.rules')),
    stripLegend(),
    groups);
}

function paperTab(data) {
  const p = data.paper;
  const total = ((p.value - p.start) / p.start) * 100;
  const dayWord = istParts().ymd === data.session ? t('home.today') : t('home.lastSession');
  return h('div', null,
    h('div', { class: 'panel' },
      h('div', { class: 'big-num num' }, fmt.money(p.value)),
      h('div', { class: 'stat-line' },
        h('span', null, h('b', { class: tone(total) }, fmt.pct(total)), ' ', t('home.sinceStart')),
        h('span', null, h('b', { class: tone(p.today) }, fmt.signedMoney(p.today)), ' ', dayWord)),
      equityChart({ points: p.curve, base: p.start, label: t('results.equity') })),
    h('section', { class: 'sec' },
      h('h2', { class: 'sec-title' }, t('results.open'), h('span', { class: 'sec-count' }, String(p.open.length))),
      p.open.length ? null : h('p', { class: 'muted' }, t('results.noOpen')),
      h('ul', { class: 'list' }, p.open.map((o) => {
        const pct = (o.dir === 'short' ? (o.entry - o.now) : (o.now - o.entry)) / o.entry * 100;
        return h('li', null, h('div', { class: 'row' },
          h('span', { class: 'row-title' }, o.symbol),
          h('span', { class: 'row-right num ' + tone(pct) }, fmt.pct(pct)),
          h('span', { class: 'row-meta' }, horizonTag(o.horizon), h('span', null, data.strategy(o.strategy).name)),
          h('span', { class: 'row-side num muted' }, t('results.qty', { n: fmt.int(o.qty) })),
          h('span', { class: 'row-levels num' },
            h('span', null, t('results.entryAt', { price: fmt.price(o.entry) })),
            h('span', null, t('results.now', { price: fmt.price(o.now) })))));
      }))),
    h('section', { class: 'sec' },
      h('h2', { class: 'sec-title' }, t('results.closed')),
      p.closed.length ? null : h('p', { class: 'muted' }, t('results.none')),
      h('ul', { class: 'list' }, p.closed.map((c) => h('li', null, h('div', { class: 'row' },
        h('span', { class: 'row-title' }, c.symbol),
        h('span', { class: 'row-right num ' + tone(c.pct) }, fmt.pct(c.pct)),
        h('span', { class: 'row-meta' }, horizonTag(c.horizon), h('span', null, data.strategy(c.strategy).name)),
        h('span', { class: 'row-side muted' }, outcomeLabel(c.state))))))));
}

function reportsTab(data) {
  const sent = data.readinessSent || [];
  const due = [30, 60, 90].map((n) => ({ n, date: data.reportDue(n), sent: sent.includes(n) }));
  const saved = data.reports || [];
  return h('div', null,
    reviewSection(data),
    h('section', { class: 'sec' },
      h('h2', { class: 'sec-title' }, t('results.readiness')),
      h('p', { class: 'sec-note' }, t('results.readinessNote')),
      due[0].date == null ? h('p', { class: 'muted' }, t('results.readinessStart')) : null,
      h('ul', { class: 'list' }, due.map((d) => h('li', null, h('div', { class: 'row' },
        h('span', { class: 'row-title', style: { fontSize: '16px' } }, t('results.day', { n: d.n })),
        h('span', { class: 'row-right muted num' }, d.date != null ? fmt.shortDate(d.date) : '—'),
        h('span', { class: 'row-meta' }, d.sent ? t('results.sent') : t('results.scheduled'))))))),
    h('section', { class: 'sec' },
      h('h2', { class: 'sec-title' }, t('results.weekly')),
      h('p', { class: 'sec-note' }, t('results.weeklyNote'))),
    data.isDemo ? null : h('section', { class: 'sec' },
      h('h2', { class: 'sec-title' }, t('results.saved')),
      saved.length ? h('ul', { class: 'list' }, saved.map((r) => h('li', null, h('div', { class: 'row' },
        h('span', { class: 'row-title', style: { fontSize: '16px' } }, r.title),
        h('span', { class: 'row-right muted num' }, r.at ? fmt.shortDate(r.at) : ''),
        h('span', { class: 'row-meta' }, r.summary))))) : h('p', { class: 'muted' }, t('results.reportsNone'))));
}

/** Strategy detail: full metrics, backtest versus paper, status rules. */
export function openStrategy(st) {
  openSheet((closeBtn) => h('div', null,
    h('div', { class: 'sheet-head' },
      h('div', { class: 'grow' },
        h('h2', { class: 'sheet-title' }, st.name),
        h('div', { class: 'sheet-sub' }, horizonTag(st.horizon, true), statusChip(st.status))),
      closeBtn),
    h('div', { class: 'sheet-sub', style: { marginTop: 0 } }, tradesLabel(st)),
    trackStrip(st.outcomes),
    stripLegend(),
    st.trades && st.trades < 30 ? h('p', { class: 'note' }, t('results.early')) : null,
    st.quiet ? h('p', { class: 'note', style: { marginTop: '8px' } }, '🔕 ' + t('results.quiet')) : null,
    h('h3', null, t('results.backtest')),
    compareTable(st),
    h('p', { class: 'note' }, st.backtest && st.backtest.from ? t('results.backtestPeriod', { from: fmt.monthYear(Date.parse(st.backtest.from + 'T12:00:00+05:30')), to: fmt.monthYear(Date.parse(st.backtest.to + 'T12:00:00+05:30')) }) : t('results.backtestNote')),
    h('a', { class: 'sec-link', href: '#/backtest' }, t('results.openLab')),
    st.verdict ? h('div', null, h('h3', null, t('results.verdict')), h('p', { class: 'muted' }, st.verdict)) : null,
    h('p', { class: 'note' }, t('results.rules')),
    overrideBlock(st)), { label: st.name });
}

/** Set a strategy's status by hand (or back to automatic), saved in the engine's Strategies sheet. */
function overrideBlock(st) {
  if (!isConnected() || getData().isDemo) {
    return h('div', null,
      h('button', { type: 'button', class: 'btn btn-ghost btn-block', style: { marginTop: '18px' }, disabled: true }, t('results.override')),
      h('p', { class: 'note', style: { textAlign: 'center' } }, t('results.overrideConnect')));
  }
  const current = { PAPER: 'PAPER', LIVE_READY: 'LIVE_READY', REJECTED: 'REJECTED' }[String(st.override || '').toUpperCase()] || '';
  let saving = false;
  return h('div', { style: { marginTop: '18px' } },
    h('h3', null, t('results.override')),
    segmented([
      { value: '', label: t('results.overrideAuto') },
      { value: 'PAPER', label: t('status.paper') },
      { value: 'LIVE_READY', label: t('status.live') },
      { value: 'REJECTED', label: t('status.rejected') },
    ], current, async (v) => {
      if (saving) return;
      saving = true;
      try {
        await api.saveSettings({}, { overrides: { [st.id]: v } });
        toast(t('results.overrideSaved'));
        refresh();
      } catch (e) { toast(e.message); } finally { saving = false; }
    }, t('results.overrideTitle', { name: st.name })),
    h('p', { class: 'note' }, t('results.overrideNote')));
}

function compareTable(st) {
  const b = st.backtest || {};
  const rows = [
    [t('backtest.k.trades'), b.trades != null ? fmt.int(b.trades) : '—', st.trades ? fmt.int(st.trades) : '—'],
    [t('results.win'), b.win != null ? `${b.win}%` : '—', st.win != null ? `${st.win}%` : '—'],
    [t('results.avg'), b.avg != null ? fmt.pct(b.avg) : '—', st.avg != null ? fmt.pct(st.avg) : '—'],
    // A profit factor is undefined when nothing lost: say so instead of showing a blank.
    [t('results.pf'), b.pf != null ? fmt.num(b.pf, 2) : b.trades ? t('backtest.noLosses') : '—', st.pf != null ? fmt.num(st.pf, 2) : st.trades ? t('backtest.noLosses') : '—'],
    [t('results.dd'), b.dd != null ? fmt.pct(b.dd, 1) : '—', st.paperDd != null ? fmt.pct(st.paperDd, 1) : '—'],
    [t('results.vsNifty'), b.vsNifty != null ? fmt.pct(b.vsNifty, 1) : '—', st.vsNifty != null ? fmt.pct(st.vsNifty, 1) : '—'],
  ];
  return h('table', { class: 'cmp' },
    h('thead', null, h('tr', null, h('th', { scope: 'col' }, h('span', { class: 'visually-hidden' }, t('results.strategies'))),
      h('th', { scope: 'col' }, t('results.colBacktest')), h('th', { scope: 'col' }, t('results.colPaper')))),
    h('tbody', null, rows.map((r) => h('tr', null, h('th', { scope: 'row' }, r[0]), h('td', { class: 'num' }, r[1]), h('td', { class: 'num' }, r[2])))));
}
