// review.js — the session review: the day's paper results by strategy, buys and shorts, time of day and filters,
// worked out by the engine after the close, with an optional AI write-up of those numbers (labelled, not advice).
import { h, fmt, tone } from '../util.js';
import { t } from '../i18n.js';
import { openSheet, toast } from '../ui.js';
import { api, isConnected } from '../api.js';
import { getData, refresh } from '../data.js';

const signed = (x) => (x == null ? '—' : fmt.signedMoney(x));
const dayLabel = (ymd) => fmt.shortDate(Date.parse(ymd + 'T12:00:00+05:30'));
const HZ_ICON = { INTRADAY: '⚡', SWING: '📈', MEDIUM: '🗓️', LONG: '🌱' };

/** One review as a tappable row: date, money, trades and win rate. */
export function reviewRow(f) {
  const p = f.paper || {};
  return h('li', null, h('button', { type: 'button', class: 'row', onclick: () => openReview(f) },
    h('span', { class: 'row-title', style: { fontSize: '16px' } }, dayLabel(f.day)),
    h('span', { class: 'row-right num ' + tone(p.net) }, p.n ? signed(p.net) : '—'),
    h('span', { class: 'row-meta' }, p.n ? t('review.rowMeta', { n: p.n, win: p.winRatePct, pct: fmt.pct(p.returnPct) }) : t('review.noTrades')),
    h('span', { class: 'row-side' }, f.ai ? h('span', { class: 'chip paper' }, t('review.aiChip')) : null)));
}

/** The reviews section for Results → Reports. */
export function reviewSection(data) {
  const sec = h('section', { class: 'sec', style: { marginTop: '8px' } },
    h('h2', { class: 'sec-title' }, t('review.title')),
    h('p', { class: 'sec-note' }, t('review.note')));
  const latest = data.review;
  const list = h('ul', { class: 'list' }, latest ? reviewRow(latest) : null);
  sec.append(list);
  if (!latest) sec.append(h('p', { class: 'muted' }, t('review.none')));
  const live = isConnected() && !data.isDemo;
  if (live) {
    // Earlier days come from the engine's Drive file, once per visit.
    api.reviews().then((r) => {
      const older = (r.list || []).filter((x) => !latest || x.day !== latest.day);
      if (older.length) list.append(...older.slice(0, 30).map(reviewRow));
    }).catch(() => { /* the latest one is enough */ });
    const btn = h('button', { type: 'button', class: 'btn btn-ghost btn-block', style: { marginTop: '12px' } }, t('review.makeNow'));
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.textContent = t('review.making');
      try {
        const f = await api.reviewNow(false);
        if (f) openReview(f);
        refresh();
      } catch (e) { toast(e.message); }
      btn.disabled = false; btn.textContent = t('review.makeNow');
    });
    sec.append(btn, h('p', { class: 'note faint', style: { marginTop: '6px' } }, t('review.makeNote')));
  }
  return sec;
}

function table(head, rows) {
  return h('table', { class: 'cmp' },
    h('thead', null, h('tr', null, head.map((x, i) => h('th', { scope: 'col' }, i === 0 ? h('span', { class: 'visually-hidden' }, x) : x)))),
    h('tbody', null, rows.map((r) => h('tr', null, r.map((c, i) => (i === 0 ? h('th', { scope: 'row' }, c) : h('td', { class: 'num ' + (c && c.cls ? c.cls : '') }, c && c.text != null ? c.text : c)))))));
}
const money = (x) => ({ text: signed(x), cls: tone(x) });

/** The full review in a bottom sheet. */
export function openReview(f) {
  const p = f.paper || {}, ai = f.ai;
  const data = getData();
  openSheet((closeBtn) => h('div', null,
    h('div', { class: 'sheet-head' },
      h('div', { class: 'grow' }, h('h2', { class: 'sheet-title' }, t('review.sheetTitle')), h('div', { class: 'sheet-sub' }, h('span', null, dayLabel(f.day)), h('span', { class: 'faint' }, t('review.regime', { r: t('regimeName.' + ({ BULL: 'bull', NEUTRAL: 'neutral', BEAR: 'bear', HIGH_VOL: 'volatile' }[f.regime] || 'unknown')) }) + (f.nifty && f.nifty.pct != null ? ' · Nifty ' + fmt.pct(f.nifty.pct) : '')))),
      closeBtn),
    p.n ? h('div', { class: 'panel' },
      h('div', { class: 'muted', style: { fontSize: '14px' } }, t('review.result')),
      h('div', { class: 'big-num num ' + tone(p.net) }, signed(p.net)),
      h('div', { class: 'stat-line' },
        h('span', null, h('b', { class: tone(p.returnPct) }, fmt.pct(p.returnPct)), ' ' + t('review.ofCapital', { cap: fmt.money(f.capital) })),
        h('span', null, t('review.charges', { c: fmt.money(p.charges) })),
        p.gross != null ? h('span', null, h('b', { class: tone(p.gross) }, signed(p.gross)), ' ' + t('review.beforeCharges')) : null),
      h('div', { class: 'stat-line' },
        h('span', null, h('b', null, String(p.n)), ' ' + t('review.trades')),
        h('span', null, '✅ ', h('b', null, String(p.won))),
        h('span', null, '❌ ', h('b', null, String(p.lost))),
        p.flat ? h('span', null, '➖ ', h('b', null, String(p.flat))) : null,
        h('span', null, t('results.win') + ' ', h('b', null, `${p.winRatePct}%`))),
      h('div', { class: 'stat-line' },
        h('span', null, '🎯 ' + t('alerts.r.target') + ' ', h('b', null, String(p.target))),
        h('span', null, '🛑 ' + t('alerts.r.stop') + ' ', h('b', null, String(p.stop))),
        h('span', null, '⏳ ' + t('alerts.r.expired') + ' ', h('b', null, String(p.expired))),
        p.notTriggered ? h('span', null, '⛔ ' + t('alerts.r.not') + ' ', h('b', null, String(p.notTriggered))) : null))
      : h('p', { class: 'muted', style: { marginTop: '8px' } }, t('review.noTradesLong')),
    f.best || f.worst ? h('dl', { class: 'kv', style: { marginTop: '12px' } },
      f.best ? [h('dt', null, '🏆 ' + t('review.best')), h('dd', { class: 'num ' + tone(f.best.net) }, `${f.best.symbol} ${fmt.pct(f.best.pct)} (${signed(f.best.net)})`)] : null,
      f.worst ? [h('dt', null, '💥 ' + t('review.worst')), h('dd', { class: 'num ' + tone(f.worst.net) }, `${f.worst.symbol} ${fmt.pct(f.worst.pct)} (${signed(f.worst.net)})`)] : null) : null,
    aiBox(f),
    f.byStrategy && f.byStrategy.length ? h('div', null, h('h3', null, t('review.byStrategy')),
      table([t('review.byStrategy'), t('review.colTrades'), t('review.colWon'), t('review.colNet')], f.byStrategy.map((g) => [g.name, String(g.n), String(g.won), money(g.net)]))) : null,
    f.byDir && (f.byDir.BUY || f.byDir.SHORT) ? h('div', null, h('h3', null, t('review.byDir')),
      table([t('review.byDir'), t('review.colTrades'), t('review.colWon'), t('review.colNet')], ['BUY', 'SHORT'].filter((d) => f.byDir[d]).map((d) => [d === 'BUY' ? '🟢 ' + t('dir.buy') : '🔴 ' + t('dir.short'), String(f.byDir[d].n), String(f.byDir[d].won), money(f.byDir[d].net)]))) : null,
    f.byTime && f.byTime.length ? h('div', null, h('h3', null, t('review.byTime')),
      table([t('review.byTime'), t('review.colTrades'), t('review.colWon'), t('review.colNet')], f.byTime.map((g) => [g.label, String(g.n), String(g.won), money(g.net)]))) : null,
    f.filters && f.filters.length ? h('div', null, h('h3', null, t('review.filters')),
      h('ul', { class: 'bullets' }, f.filters.map((g) => h('li', null, filterLine(g))),
        heldLine(f) ? h('li', null, heldLine(f)) : null)) : null,
    f.opened && f.opened.length ? h('div', null, h('h3', null, t('review.opened')),
      h('ul', { class: 'list' }, f.opened.map((o) => h('li', null, h('div', { class: 'row' },
        h('span', { class: 'row-title', style: { fontSize: '15px' } }, (o.dir === 'SHORT' ? '🔴 ' : '🟢 ') + o.symbol),
        h('span', { class: 'row-right num' }, fmt.priceRange(o.entryLow, o.entryHigh)),
        h('span', { class: 'row-meta' }, (HZ_ICON[o.horizon] || '') + ' ' + o.strategy),
        h('span'),
        h('span', { class: 'row-levels num' }, h('span', null, t('alert.stop') + ' ', h('b', null, fmt.price(o.stop))), h('span', null, t('alert.target') + ' ', h('b', null, fmt.price(o.target1))))))))) : null,
    h('div', { class: 'stat-line', style: { marginTop: '16px' } },
      f.total ? h('span', null, '🧾 ' + t('review.sinceStart') + ' ', h('b', { class: tone(f.total.net) }, `${signed(f.total.net)} (${fmt.pct(f.total.returnPct)})`)) : null,
      f.open ? h('span', null, '📂 ' + t('review.stillOpen') + ' ', h('b', null, String(f.open.n)), f.open.n ? h('b', { class: tone(f.open.unrealised) }, ` (${signed(f.open.unrealised)})`) : null) : null),
    f.alerts ? h('p', { class: 'note', style: { marginTop: '8px' } }, '📣 ' + (f.alerts.fate && f.alerts.n
      ? t('review.alertsFate', { n: f.alerts.n, b: f.alerts.buy, s: f.alerts.short, x: f.alerts.blocked, parts: fateText(f.alerts.fate, f.alerts.perStock) })
      : t('review.alertsLine', { n: f.alerts.n, b: f.alerts.buy, s: f.alerts.short, x: f.alerts.blocked }))) : null,
    h('p', { class: 'note faint' }, t('review.footer')),
    data.isDemo ? h('p', { class: 'note' }, t('preview.banner')) : null), { label: t('review.sheetTitle') });
}

/** "4 paper trades, 1 never reached the entry, …" — what became of the alerts (held: the held-back ones). */
function fateText(o, perStock, held) {
  if (!o) return '';
  const parts = [];
  if (o.traded) parts.push(held ? t('review.fate.judged', { n: o.traded }) : t('review.fate.traded', { n: o.traded }));
  if (o.notTriggered) parts.push(t('review.fate.notTriggered', { n: o.notTriggered }));
  if (o.tooPricey) parts.push(t('review.fate.tooPricey', { n: o.tooPricey, cap: fmt.money(perStock || 0) }));
  if (o.noData) parts.push(t('review.fate.noData', { n: o.noData }));
  if (o.open) parts.push(t('review.fate.open', { n: o.open }));
  if (o.other) parts.push(t('review.fate.other', { n: o.other }));
  return parts.join(', ');
}

/** One market filter: what its held-back signals did against the trades taken, and the verdict. */
function filterLine(g) {
  const by = t('backtest.filterBy.' + g.kind), hz = g.intraday === false ? t('review.filterLonger') : '';
  if (!g.verdict) { // a review saved before engine 0.6.5
    return t('review.filterLine', { by, n: g.n, avg: fmt.pct(g.avgPct) }) + ' ' + (g.avgPct < 0 ? t('review.filterHelped') : g.avgPct > 0 ? t('review.filterCost') : '');
  }
  const line = g.takenAvgPct != null
    ? t('review.filterVs', { by, hz, n: g.n, avg: fmt.pct(g.avgPct), taken: fmt.pct(g.takenAvgPct) })
    : t('review.filterAlone', { by, hz, n: g.n, avg: fmt.pct(g.avgPct) });
  return line + ' ' + t('review.verdict.' + g.verdict);
}

/** The held-back signals that are not in the filter lines yet (never reached the entry, or still open). */
function heldLine(f) {
  const hf = f.alerts && f.alerts.heldFate;
  if (!hf || !(hf.notTriggered || hf.open || hf.noData)) return '';
  return t('review.heldFate', { n: f.alerts.blocked, parts: fateText(hf, f.alerts.perStock, true) });
}

function aiBox(f) {
  const ai = f.ai;
  if (!ai) {
    return h('p', { class: 'note faint', style: { marginTop: '12px' } }, f.aiError ? t('review.aiFailed', { why: f.aiError }) : t('review.aiOff'));
  }
  const items = (list, mark) => (list || []).map((x) => h('li', null, mark + ' ' + x));
  return h('div', { class: 'ai-box', style: { marginTop: '14px' } },
    h('div', { class: 'ai-label' }, t('review.aiLabel', { model: ai.model || 'Gemini' })),
    ai.overview ? h('p', { style: { margin: '6px 0 8px' } }, ai.overview) : null,
    h('ul', { class: 'plain-list' }, items(ai.worked, '✔️'), items(ai.didnt, '✖️'), items(ai.watch, '👀')));
}
