// Scan: ranked long / medium / swing lists, and the stock detail sheet.
import { h, fmt, tone } from '../util.js';
import { t } from '../i18n.js';
import { screenHead, segmented, openSheet, kvList, previewBanner, alertRow } from '../ui.js';
import { candleChart } from '../charts.js';
import { getData, loadStockChart } from '../data.js';
import { api } from '../api.js';
import { openAlert } from './alerts.js';

export function render({ data, query }) {
  let tab = query.get('tab') || 'long';
  const body = h('div');
  const draw = () => {
    const rows = data.scan[tab] || [];
    const note = h('p', { class: 'sec-note' }, t('scan.' + tab + 'Note'),
      !data.isDemo && data.scan.at ? ' ' + t('scan.updated', { date: fmt.dayMonth(data.scan.at) }) : '');
    const empty = !rows.length ? h('p', { class: 'muted', style: { margin: '14px 0' } }, tab === 'long' ? t('scan.longEmpty') : t('scan.empty')) : null;
    const list = h('ul', { class: 'list' }, rows.map((r, i) => h('li', null,
      h('button', { type: 'button', class: 'row', onclick: () => openStock(r.symbol) },
        h('span', { class: 'row-title' }, h('span', { class: 'rank' }, String(i + 1)), r.symbol),
        h('span', { class: 'row-right score' },
          h('span', { class: 'score-bar', 'aria-hidden': 'true' }, h('i', { style: { width: r.score + '%' } })),
          h('span', { class: 'num' }, String(r.score))),
        h('span', { class: 'row-meta' }, h('span', null, r.sector),
          r.complete != null ? h('span', { class: r.complete < 90 ? 'faint' : '' }, t('scan.complete', { pct: r.complete })) : null),
        h('span'),
        h('span', { class: 'row-levels' }, r.line)))));
    const etfs = tab === 'long' ? h('section', { class: 'sec' },
      h('h2', { class: 'sec-title' }, t('scan.etfs')),
      h('p', { class: 'sec-note' }, t('scan.etfsNote')),
      h('ul', { class: 'list' }, data.scan.etfs.map((e) => h('li', null,
        h('button', { type: 'button', class: 'row', onclick: () => openStock(e.symbol) },
          h('span', { class: 'row-title' }, e.symbol), h('span'),
          h('span', { class: 'row-meta' }, e.sector)))))) : null;
    body.replaceChildren(note, empty || list, etfs || '');
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
  const holder = h('div', null, h('p', { class: 'muted', style: { padding: '24px 0' } }, t('stock.loading')));
  let title = null;
  openSheet((closeBtn) => {
    title = h('div', { class: 'grow' }, h('h2', { class: 'sheet-title' }, symbol));
    return h('div', null, h('div', { class: 'sheet-head' }, title, closeBtn), holder);
  }, { label: symbol });
  const fill = (sc) => {
    if (!sc) { holder.replaceChildren(h('p', { class: 'muted' }, t('alert.chartNone'))); return; }
    const parts = stockBody(data, symbol, sc);
    title.replaceChildren(...parts.head);
    holder.replaceChildren(...parts.body);
  };
  if (data.isDemo) fill(data.stockChart(symbol));
  else loadStockChart(symbol).then(fill).catch((e) => holder.replaceChildren(h('p', { class: 'muted' }, t('alert.chartFail', { why: e.message }))));
}

function stockBody(data, symbol, sc) {
  const all = sc.all;
  const last = all[all.length - 1];
  const prevC = all[all.length - 2] || last;
  const chg = ((last.c - prevC.c) / prevC.c) * 100;
  const year = all.slice(-250);
  const hi52 = Math.max(...year.map((c) => c.h));
  const lo52 = Math.min(...year.map((c) => c.l));
  const pos = hi52 > lo52 ? ((last.c - lo52) / (hi52 - lo52)) * 100 : 50;
  const pastAlerts = data.alerts.filter((a) => a.symbol === symbol);
  const f = data.fundamentals[symbol];
  const news = h('div', null, h('p', { class: 'muted' }, data.isDemo ? t('stock.newsNote') : t('stock.newsLoading')));
  if (!data.isDemo) {
    api.news(symbol).then((r) => news.replaceChildren(
      r.items.length ? h('ul', { class: 'bullets' }, r.items.map((n) => h('li', null,
        h('a', { href: n.link, target: '_blank', rel: 'noopener noreferrer' }, n.title),
        h('span', { class: 'faint' }, ' · ' + [n.source, n.at ? fmt.dayMonth(n.at) : ''].filter(Boolean).join(', '))))) : h('p', { class: 'muted' }, t('stock.newsNone')),
      h('p', { class: 'note faint' }, t('stock.newsSource'))))
      .catch((e) => news.replaceChildren(h('p', { class: 'muted' }, t('stock.newsFail', { why: e.message }))));
  }
  return {
    head: [h('h2', { class: 'sheet-title' }, symbol),
      h('div', { class: 'sheet-sub num' }, h('b', null, fmt.price(last.c)), h('span', { class: tone(chg) }, fmt.pct(chg)))],
    body: [
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
          [t('fund.sales'), f.sales3y != null ? fmt.pct(f.sales3y, 1, false) : '—'],
          [t('fund.profit'), f.profit3y != null ? fmt.pct(f.profit3y, 1, false) : '—'],
          [t('fund.pe'), `${fmt.num(f.pe, 1)} / ${fmt.num(f.pe5y, 1)}`],
          [t('fund.pledge'), f.pledge != null ? fmt.pct(f.pledge, 1, false) : '—'],
        ]),
        h('p', { class: 'note' }, t('fund.note'))) : null,
      h('h3', null, t('stock.pastAlerts')),
      pastAlerts.length ? h('ul', { class: 'list' }, pastAlerts.map((a) => alertRow(a, openAlert))) : h('p', { class: 'muted' }, t('stock.noAlerts')),
      h('h3', null, t('stock.news')),
      news,
    ].filter(Boolean),
  };
}
