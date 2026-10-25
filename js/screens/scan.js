// Scan: ranked long / medium / swing lists, and the stock detail sheet.
import { h, fmt, tone } from '../util.js';
import { t, pick } from '../i18n.js';
import { screenHead, segmented, openSheet, kvList, previewBanner, alertRow } from '../ui.js';
import { candleChart } from '../charts.js';
import { getData } from '../data.js';
import { openAlert } from './alerts.js';

export function render({ data, query }) {
  let tab = query.get('tab') || 'long';
  const body = h('div');
  const draw = () => {
    const rows = data.scan[tab];
    const note = h('p', { class: 'sec-note' }, t('scan.' + tab + 'Note'));
    const list = h('ul', { class: 'list' }, rows.map((r, i) => h('li', null,
      h('button', { type: 'button', class: 'row', onclick: () => openStock(r.symbol) },
        h('span', { class: 'row-title' }, h('span', { class: 'rank' }, String(i + 1)), r.symbol),
        h('span', { class: 'row-right score' },
          h('span', { class: 'score-bar', 'aria-hidden': 'true' }, h('i', { style: { width: r.score + '%' } })),
          h('span', { class: 'num' }, String(r.score))),
        h('span', { class: 'row-meta' }, h('span', null, r.sector),
          r.complete != null ? h('span', { class: r.complete < 90 ? 'faint' : '' }, t('scan.complete', { pct: r.complete })) : null),
        h('span'),
        h('span', { class: 'row-levels' }, pick(r.line))))));
    const etfs = tab === 'long' ? h('section', { class: 'sec' },
      h('h2', { class: 'sec-title' }, t('scan.etfs')),
      h('p', { class: 'sec-note' }, t('scan.etfsNote')),
      h('ul', { class: 'list' }, data.scan.etfs.map((e) => h('li', null,
        h('button', { type: 'button', class: 'row', onclick: () => openStock(e.symbol) },
          h('span', { class: 'row-title' }, e.symbol), h('span'),
          h('span', { class: 'row-meta' }, e.sector)))))) : null;
    body.replaceChildren(note, list, etfs || '');
  };
  draw();
  return h('div', null,
    data.isDemo ? previewBanner() : null,
    screenHead(t('scan.title')),
    segmented([
      { value: 'long', label: t('scan.long') },
      { value: 'medium', label: t('scan.medium') },
      { value: 'swing', label: t('scan.swing') },
    ], tab, (v) => { tab = v; draw(); }, t('scan.title')),
    body);
}

export function openStock(symbol) {
  const data = getData();
  const sc = data.stockChart(symbol);
  const all = sc.all;
  const last = all[all.length - 1];
  const prevC = all[all.length - 2];
  const chg = ((last.c - prevC.c) / prevC.c) * 100;
  const year = all.slice(-250);
  const hi52 = Math.max(...year.map((c) => c.h));
  const lo52 = Math.min(...year.map((c) => c.l));
  const pos = ((last.c - lo52) / (hi52 - lo52)) * 100;
  const pastAlerts = data.alerts.filter((a) => a.symbol === symbol);
  const f = data.fundamentals[symbol];

  openSheet((closeBtn) => h('div', null,
    h('div', { class: 'sheet-head' },
      h('div', { class: 'grow' },
        h('h2', { class: 'sheet-title' }, symbol),
        h('div', { class: 'sheet-sub num' }, h('b', null, fmt.price(last.c)), h('span', { class: tone(chg) }, fmt.pct(chg)))),
      closeBtn),
    candleChart({
      candles: sc.candles,
      overlays: [{ values: sc.sma50, label: t('stock.dma50') }, ...(sc.sma200 ? [{ values: sc.sma200, label: t('stock.dma200') }] : [])],
      mode: 'day', label: `${symbol} ${t('stock.chart')}`,
    }),
    h('h3', null, t('stock.range')),
    h('div', { class: 'range', role: 'img', 'aria-label': `${fmt.price(lo52)} – ${fmt.price(hi52)}` }, h('i', { style: { left: `calc(${pos.toFixed(1)}% - 1.5px)` } })),
    h('div', { class: 'range-labels num' }, h('span', null, fmt.price(lo52)), h('span', null, fmt.price(hi52))),
    h('div', { style: { marginTop: '14px' } }, kvList([
      [t('stock.dma50'), fmt.price(sc.sma50[sc.sma50.length - 1])],
      sc.sma200 ? [t('stock.dma200'), fmt.price(sc.sma200[sc.sma200.length - 1])] : null,
    ])),
    f ? h('div', null,
      h('h3', null, t('stock.fund')),
      kvList([
        ['ROE', f.roe != null ? fmt.pct(f.roe, 1, false) : '—'],
        ['ROCE', f.roce != null ? fmt.pct(f.roce, 1, false) : '—'],
        [t('fund.de'), f.de != null ? fmt.num(f.de, 2) : '—'],
        [t('fund.sales'), fmt.pct(f.sales3y, 1, false)],
        [t('fund.profit'), fmt.pct(f.profit3y, 1, false)],
        [t('fund.pe'), `${fmt.num(f.pe, 1)} / ${fmt.num(f.pe5y, 1)}`],
        [t('fund.pledge'), fmt.pct(f.pledge, 1, false)],
      ]),
      h('p', { class: 'note' }, t('fund.note'))) : null,
    h('h3', null, t('stock.pastAlerts')),
    pastAlerts.length ? h('ul', { class: 'list' }, pastAlerts.map((a) => alertRow(a, openAlert))) : h('p', { class: 'muted' }, t('stock.noAlerts')),
    h('h3', null, t('stock.news')),
    h('p', { class: 'muted' }, t('stock.newsNote'))), { label: symbol });
}
