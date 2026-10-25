// Alerts: filterable feed, and the alert detail sheet with chart, plan, size and track record.
import { h, fmt, icon, copyText } from '../util.js';
import { t } from '../i18n.js';
import { ICONS } from '../icons.js';
import { getSettings, positionSize } from '../state.js';
import {
  screenHead, filterChips, alertRow, horizonTag, statusChip, dirChip, trackStrip, stripLegend,
  openSheet, kvList, toast, previewBanner,
} from '../ui.js';
import { candleChart } from '../charts.js';
import { getData, loadAlertChart } from '../data.js';

const OVERLAY_LABEL = { ema20: '20-day EMA', sma50: () => t('stock.dma50'), sma200: () => t('stock.dma200'), vwap: 'VWAP' };
const overlayLabel = (k) => (typeof OVERLAY_LABEL[k] === 'function' ? OVERLAY_LABEL[k]() : OVERLAY_LABEL[k] || k);

export function render({ data, query }) {
  let hz = query.get('hz') || 'all';
  let st = query.get('status') || 'all';
  const list = h('ul', { class: 'list' });

  const draw = () => {
    const items = data.alerts
      .filter((a) => (hz === 'all' || a.horizon === hz) && (st === 'all' || a.status === st))
      .sort((a, b) => b.time - a.time);
    list.replaceChildren(...(items.length
      ? items.map((a) => alertRow(a, openAlert))
      : [h('li', { class: 'empty' }, h('p', null, t('alerts.empty')),
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => { location.hash = '#/alerts'; } }, t('alerts.clear')))]));
  };

  const hzChips = filterChips([
    { value: 'all', label: t('common.all') },
    { value: 'intraday', label: t('hz.intraday') },
    { value: 'swing', label: t('hz.swing') },
    { value: 'medium', label: t('hz.medium') },
    { value: 'long', label: t('hz.long') },
  ], hz, (v) => { hz = v; draw(); }, t('alerts.title'));

  const stChips = filterChips([
    { value: 'all', label: t('common.all') },
    { value: 'live', label: t('status.live') },
    { value: 'paper', label: t('status.paper') },
    { value: 'rejected', label: t('status.rejected') },
  ], st, (v) => { st = v; draw(); }, t('results.strategies'));

  draw();
  return h('div', null,
    data.isDemo ? previewBanner() : null,
    screenHead(t('alerts.title'), t('alerts.sub')),
    hzChips, stChips, list);
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
