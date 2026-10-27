// portfolio.js — your Zerodha holdings: import a holdings file, then value, sector mix, warnings and exit levels.
// The file is read on this phone. Holdings go only to your own engine (your Google Sheet), never anywhere else.
import { h, fmt, tone, store, fill } from '../util.js';
import { t } from '../i18n.js';
import { screenHead, openSheet, toast, closeSheet } from '../ui.js';
import { getData, refresh, loadStockChart } from '../data.js';
import { api, isConnected } from '../api.js';
import { candleChart } from '../charts.js';
import { readTableFile } from '../xlsx.js';
import { parseHoldings, localPortfolio } from '../importers.js';

const KEY = 'sr.holdings'; // the last imported rows, kept on this phone while the engine is not connected
const state = { preview: null, busy: false, removeArmed: 0 };
let root = null;

export function render({ data }) {
  root = h('div');
  draw(data);
  return root;
}
function redraw() { if (root && root.isConnected) draw(getData()); }

function current(data) {
  const live = isConnected() && !data.isDemo;
  if (live && data.portfolio) return { view: data.portfolio, live: true };
  const local = store.get(KEY, null);
  if (local && local.rows && local.rows.length) return { view: { ...localPortfolio(local.rows), importedAt: local.at, source: local.source }, live: false, pending: live };
  return { view: null, live };
}

function draw(data) {
  const { view, live, pending } = current(data);
  const connected = isConnected() && !data.isDemo;
  const sub = view ? (view.local ? t('portfolio.subLocal') : t('portfolio.subLive')) : t('portfolio.sub');
  fill(root,
    screenHead(t('portfolio.title'), sub, '#/more'),
    state.preview ? previewPanel(connected) : view ? portfolioView(view, live, pending, connected, data) : emptyState(connected));
}

/* ---------- Import ---------- */

function fileButton(label, primary = true) {
  const input = h('input', { type: 'file', accept: '.xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', class: 'visually-hidden', tabindex: '-1', 'aria-hidden': 'true' });
  const btn = h('button', { type: 'button', class: 'btn ' + (primary ? 'btn-primary' : 'btn-ghost') + ' btn-block', disabled: state.busy }, label);
  btn.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    if (/\.xls$/i.test(file.name)) { toast(t('import.oldXls')); return; }
    state.busy = true; btn.disabled = true; btn.textContent = t('import.reading');
    try {
      const table = await readTableFile(file);
      const parsed = parseHoldings(table);
      if (!parsed) throw new Error(t('portfolio.noTable'));
      if (!parsed.rows.length) throw new Error(t('portfolio.noRows', { n: parsed.skipped.length }));
      state.preview = { ...parsed, file: file.name };
    } catch (e) { toast(e.message || String(e)); }
    state.busy = false; redraw();
  });
  return h('div', null, btn, input);
}

function emptyState(connected) {
  return h('div', { class: 'empty' },
    h('h2', null, t('portfolio.emptyTitle')),
    h('p', null, t('portfolio.emptyBody')),
    fileButton(t('portfolio.import')),
    howTo(),
    connected ? null : h('p', { class: 'note faint', style: { marginTop: '10px' } }, t('portfolio.notConnected')));
}

function howTo() {
  return h('details', { class: 'panel note-panel', style: { marginTop: '18px' } },
    h('summary', null, t('portfolio.howTitle')),
    h('ol', { class: 'steps' }, [1, 2, 3, 4].map((n) => h('li', null, t('portfolio.how' + n)))),
    h('p', { class: 'note faint' }, t('portfolio.howPrivacy')));
}

function previewPanel(connected) {
  const p = state.preview, shown = p.rows.slice(0, 40);
  const total = p.rows.reduce((a, r) => a + r.qty * r.avgPrice, 0);
  const save = h('button', { type: 'button', class: 'btn btn-primary btn-block', disabled: state.busy }, connected ? t('portfolio.save') : t('portfolio.keepLocal'));
  save.addEventListener('click', async () => {
    state.busy = true; save.disabled = true;
    const source = (/\.xlsx$/i.test(p.file) ? 'XLSX ' : 'CSV ') + p.file.slice(0, 40);
    try {
      if (connected) {
        const r = await api.holdings({ mode: 'replace', rows: p.rows, source });
        store.set(KEY, null);
        toast(t('portfolio.saved', { n: r.result.saved }) + (r.result.unknown && r.result.unknown.length ? ' ' + t('portfolio.unknown', { list: r.result.unknown.join(', ') }) : ''));
        await refresh();
      } else {
        store.set(KEY, { rows: p.rows, at: Date.now(), source });
        toast(t('portfolio.keptLocal'));
      }
      state.preview = null;
    } catch (e) { toast(e.message); }
    state.busy = false; redraw();
  });
  return h('div', null,
    h('div', { class: 'panel' },
      h('b', null, t('portfolio.found', { n: p.rows.length, sheet: p.sheet })),
      h('div', { class: 'stat-line' }, h('span', null, t('portfolio.invested') + ' ', h('b', { class: 'num' }, fmt.money(total)))),
      h('p', { class: 'note faint' }, t('portfolio.columns', { sym: p.columns.symbol, qty: p.columns.qty.join(' + '), avg: p.columns.avg }) + (p.columns.longTerm ? ' ' + t('portfolio.columnsLong', { c: p.columns.longTerm }) : '')),
      p.skipped.length ? h('p', { class: 'note' }, t('portfolio.skipped', { n: p.skipped.length, list: p.skipped.slice(0, 8).join(', ') })) : null),
    h('ul', { class: 'list', style: { marginTop: '8px' } }, shown.map((r) => h('li', null, h('div', { class: 'row' },
      h('span', { class: 'row-title', style: { fontSize: '16px' } }, r.symbol),
      h('span', { class: 'row-right num' }, fmt.money(r.qty * r.avgPrice)),
      h('span', { class: 'row-meta num' }, fmt.int(r.qty) + ' × ' + fmt.price(r.avgPrice) + (r.longTermQty ? ' · ' + t('portfolio.longTermQty', { n: fmt.int(r.longTermQty) }) : '')))))),
    p.rows.length > shown.length ? h('p', { class: 'note faint' }, t('portfolio.more', { n: p.rows.length - shown.length })) : null,
    h('div', { class: 'btn-row' }, save,
      h('button', { type: 'button', class: 'btn btn-ghost btn-block', onclick: () => { state.preview = null; redraw(); } }, t('portfolio.cancel'))),
    h('p', { class: 'note faint', style: { marginTop: '10px' } }, connected ? t('portfolio.replaceNote') : t('portfolio.localNote')));
}

/* ---------- The portfolio ---------- */

const FLAG = { below200: 'flag.below200', trail: 'flag.trail', stop: 'flag.stop', target: 'flag.target', ltSoon: 'flag.ltSoon' };

function portfolioView(v, live, pending, connected, data) {
  const tt = v.totals || {};
  const summary = h('div', { class: 'panel' },
    h('div', { class: 'muted', style: { fontSize: '14px' } }, t('portfolio.value')),
    h('div', { class: 'big-num num' }, fmt.money(tt.value)),
    h('div', { class: 'stat-line num' },
      h('span', null, t('portfolio.invested') + ' ', h('b', null, fmt.money(tt.invested))),
      h('span', null, t('portfolio.pnl') + ' ', h('b', { class: tone(tt.pnl) }, fmt.signedMoney(tt.pnl) + ' (' + fmt.pct(tt.pnlPct) + ')')),
      tt.dayPnl != null ? h('span', null, t('portfolio.today') + ' ', h('b', { class: tone(tt.dayPnl) }, fmt.signedMoney(tt.dayPnl) + ' (' + fmt.pct(tt.dayPct) + ')')) : null),
    h('p', { class: 'note faint', style: { marginTop: '8px' } },
      (v.valuedAt ? t('portfolio.valuedAt', { date: fmt.shortDate(v.valuedAt) }) : v.local ? t('portfolio.filePrices') : t('portfolio.notValued')) +
      (v.importedAt ? ' ' + t('portfolio.importedAt', { date: fmt.shortDate(v.importedAt) }) : '')));
  const warnings = (v.warnings || []).map((w) => h('div', { class: 'banner warn-banner' },
    h('span', null, w.kind === 'stock' ? t('portfolio.warnStock', { s: w.symbol, pct: w.pct, limit: w.limit }) : t('portfolio.warnSector', { s: w.sector, pct: w.pct, limit: w.limit }))));
  const flagged = v.holdings.filter((x) => x.flags && x.flags.length);
  const sectors = h('section', { class: 'sec' }, h('h2', { class: 'sec-title' }, t('portfolio.sectors')),
    h('ul', { class: 'bars' }, (v.sectors || []).slice(0, 10).map((s) => h('li', null,
      h('div', { class: 'bar-label' }, h('span', null, s.sector), h('span', { class: 'num faint' }, `${s.pct}%`)),
      h('div', { class: 'bar' }, h('i', { style: { width: Math.max(2, Math.min(100, s.pct)) + '%' } }))))));
  const list = h('section', { class: 'sec' },
    h('div', { class: 'sec-head' }, h('h2', { class: 'sec-title' }, t('portfolio.holdings'), h('span', { class: 'sec-count' }, String(v.holdings.length)))),
    flagged.length ? h('p', { class: 'sec-note' }, t('portfolio.flaggedNote', { n: flagged.length })) : null,
    h('ul', { class: 'list' }, v.holdings.map((x) => holdingRow(x, live, connected))));
  const actions = h('section', { class: 'sec' },
    fileButton(t('portfolio.importNew'), false),
    removeButton(live, connected),
    !live ? h('p', { class: 'note faint', style: { marginTop: '10px' } }, pending ? t('portfolio.pendingNote') : t('portfolio.notConnected')) : null,
    howTo());
  return h('div', null, summary, warnings.length ? h('div', { style: { marginTop: '12px', display: 'grid', gap: '8px' } }, warnings) : null, list, sectors, actions);
}

function holdingRow(x, live, connected) {
  return h('li', null, h('button', { type: 'button', class: 'row', onclick: () => openHolding(x, live && connected) },
    h('span', { class: 'row-title' }, x.symbol),
    h('span', { class: 'row-right num ' + tone(x.pnlPct) }, x.pnlPct != null ? fmt.pct(x.pnlPct) : '—'),
    h('span', { class: 'row-meta num' }, fmt.int(x.qty) + ' × ' + fmt.price(x.avg) + (x.last ? ' · ' + t('portfolio.now', { p: fmt.price(x.last) }) : '') + (x.weightPct != null ? ' · ' + x.weightPct + '%' : '')),
    h('span'),
    x.flags && x.flags.length ? h('span', { class: 'row-levels' }, x.flags.map((f) => h('span', { class: 'chip ' + (f === 'target' || f === 'ltSoon' ? 'paper' : 'exit') }, t(FLAG[f] || f, { date: x.lt ? fmt.dayMonth(Date.parse(x.lt.longTermFrom + 'T12:00:00+05:30')) : '' })))) : null));
}

function removeButton(live, connected) {
  const btn = h('button', { type: 'button', class: 'btn btn-ghost btn-block', style: { marginTop: '10px' } }, t('portfolio.remove'));
  btn.addEventListener('click', async () => {
    if (Date.now() - state.removeArmed > 4000) { state.removeArmed = Date.now(); btn.textContent = t('portfolio.removeConfirm'); return; }
    state.removeArmed = 0;
    try {
      if (live && connected) { await api.holdings({ mode: 'clear' }); await refresh(); }
      store.set(KEY, null);
      toast(t('portfolio.removed'));
    } catch (e) { toast(e.message); }
    redraw();
  });
  return btn;
}

/* ---------- One holding ---------- */

function openHolding(x, editable) {
  const chartBox = h('div', null, h('p', { class: 'note faint' }, t('stock.loading')));
  if (isConnected() && !getData().isDemo) {
    loadStockChart(x.symbol).then((c) => {
      if (!c) { chartBox.replaceChildren(h('p', { class: 'note faint' }, t('alert.chartNone'))); return; }
      const levels = {};
      if (x.stop) levels.stop = x.stop;
      if (x.target) levels.targets = [x.target];
      chartBox.replaceChildren(candleChart({
        candles: c.candles, levels, mode: 'day', label: `${x.symbol} ${t('stock.chart')}`,
        overlays: [{ values: c.sma50, label: t('stock.dma50') }, ...(c.sma200 ? [{ values: c.sma200, label: t('stock.dma200') }] : [])],
      }));
    }).catch((e) => chartBox.replaceChildren(h('p', { class: 'note faint' }, t('alert.chartFail', { why: e.message }))));
  } else chartBox.replaceChildren();
  const alerts = (getData().alerts || []).filter((a) => a.symbol === x.symbol && a.dir === 'exit').slice(-5).reverse();
  const field = (id, label, value, type = 'number') => {
    const input = h('input', { id, type: type === 'date' ? 'text' : 'number', inputmode: type === 'date' ? 'numeric' : 'decimal', step: 'any', value: value == null ? '' : String(value), placeholder: type === 'date' ? 'yyyy-mm-dd' : '' });
    return { input, el: h('div', { class: 'field' }, h('label', { for: id }, label), input) };
  };
  const stop = field('h-stop', t('portfolio.stop'), x.stop), target = field('h-target', t('portfolio.target'), x.target), buy = field('h-buy', t('portfolio.buyDate'), x.buyDate, 'date');
  const save = h('button', { type: 'button', class: 'btn btn-primary btn-block' }, t('portfolio.saveLevels'));
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      await api.holdings({ mode: 'edit', symbol: x.symbol, patch: { stop: stop.input.value.trim(), target: target.input.value.trim(), buyDate: buy.input.value.trim() } });
      toast(t('portfolio.levelsSaved'));
      closeSheet();
      refresh();
    } catch (e) { toast(e.message); save.disabled = false; }
  });
  openSheet((closeBtn) => h('div', null,
    h('div', { class: 'sheet-head' }, h('div', { class: 'grow' }, h('h2', { class: 'sheet-title' }, x.symbol), h('div', { class: 'sheet-sub' }, x.name || '', x.sector ? h('span', null, x.sector) : null)), closeBtn),
    chartBox,
    h('dl', { class: 'kv', style: { marginTop: '10px' } },
      kv(t('portfolio.qty'), fmt.int(x.qty) + (x.longTermQty ? ' · ' + t('portfolio.longTermQty', { n: fmt.int(x.longTermQty) }) : '')),
      kv(t('portfolio.avg'), fmt.price(x.avg)),
      kv(t('portfolio.last'), x.last ? fmt.price(x.last) : '—'),
      kv(t('portfolio.pnl'), x.pnl != null ? fmt.signedMoney(x.pnl) + ' (' + fmt.pct(x.pnlPct) + ')' : '—', tone(x.pnl)),
      x.dma200 != null ? kv(t('stock.dma200'), fmt.price(x.dma200), x.last && x.last < x.dma200 ? 'loss' : '') : null,
      x.trailStop != null ? kv(t('portfolio.trail'), fmt.price(x.trailStop), x.last && x.last < x.trailStop ? 'loss' : '') : null,
      x.lt ? kv(t('portfolio.ltFrom'), fmt.shortDate(Date.parse(x.lt.longTermFrom + 'T12:00:00+05:30'))) : null),
    x.trailStop != null ? h('p', { class: 'note faint' }, t('portfolio.trailNote')) : null,
    editable ? h('div', null, h('h3', null, t('portfolio.yourLevels')), h('p', { class: 'note', style: { marginTop: 0, marginBottom: '10px' } }, t('portfolio.levelsNote')), stop.el, target.el, buy.el, save)
      : h('p', { class: 'note' }, t('portfolio.levelsConnect')),
    alerts.length ? h('div', null, h('h3', null, t('portfolio.exitAlerts')), h('ul', { class: 'bullets' }, alerts.map((a) => h('li', null, fmt.shortDate(a.time) + ': ' + (a.headline || (a.why || [])[0] || ''))))) : null,
    h('p', { class: 'note faint' }, t('portfolio.taxNote'))), { label: x.symbol });
}

function kv(label, value, cls) { return [h('dt', null, label), h('dd', { class: 'num ' + (cls || '') }, value)]; }
