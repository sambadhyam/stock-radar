// fundamentals.js — import company fundamentals (for example a Screener.in export) for the long-term score.
// The file is read on this phone; columns are matched by name, and you can fix any match before importing.
// Values that are missing stay missing: the score never guesses them.
import { h, fill } from '../util.js';
import { t } from '../i18n.js';
import { screenHead, toast, previewBanner } from '../ui.js';
import { getData, refresh } from '../data.js';
import { api, isConnected } from '../api.js';
import { readTableFile } from '../xlsx.js';
import { guessFundamentals, fundamentalsRows, FUND_FIELDS } from '../importers.js';

const state = { guess: null, file: '', busy: false, result: null };
let root = null;

export function render({ data }) {
  root = h('div');
  draw(data);
  return root;
}
function redraw() { if (root && root.isConnected) draw(getData()); }

function draw(data) {
  const connected = isConnected() && !data.isDemo;
  const have = Object.keys(data.fundamentals || {}).length;
  fill(root,
    data.isDemo ? previewBanner() : null,
    screenHead(t('fund.title'), t('fund.sub'), '#/more'),
    h('p', { class: 'sec-note' }, data.isDemo ? t('fund.demoCount') : have ? t('fund.have', { n: have }) : t('fund.none')),
    state.result ? resultPanel(state.result) : null,
    state.guess ? mapping(connected) : picker(connected),
    steps());
}

function picker(connected) {
  const input = h('input', { type: 'file', accept: '.xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', class: 'visually-hidden', tabindex: '-1', 'aria-hidden': 'true' });
  const btn = h('button', { type: 'button', class: 'btn btn-primary btn-block', disabled: !connected || state.busy }, t('fund.pick'));
  btn.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    if (/\.xls$/i.test(file.name)) { toast(t('import.oldXls')); return; }
    state.busy = true; btn.disabled = true; btn.textContent = t('import.reading');
    try {
      const g = guessFundamentals(await readTableFile(file));
      if (!g) throw new Error(t('fund.noTable'));
      state.guess = g; state.file = file.name; state.result = null;
    } catch (e) { toast(e.message || String(e)); }
    state.busy = false; redraw();
  });
  return h('div', { style: { marginTop: '6px' } }, btn, input, connected ? null : h('p', { class: 'note faint', style: { marginTop: '8px' } }, t('fund.connectFirst')));
}

function mapping(connected) {
  const g = state.guess;
  const opts = (sel) => [h('option', { value: '-1', selected: sel < 0 }, t('fund.notInFile'))].concat(g.header.map((name, i) => h('option', { value: String(i), selected: i === sel }, name || t('fund.column', { n: i + 1 }))));
  const rows = FUND_FIELDS.map(([key, label]) => {
    const id = 'fm-' + key, sel = h('select', { id }, opts(g.map[key]));
    sel.addEventListener('change', () => { g.map[key] = Number(sel.value); redraw(); });
    return h('div', { class: 'field' }, h('label', { for: id }, label), sel);
  });
  const idSel = h('select', { id: 'fm-id' }, opts(g.symbolCol >= 0 ? g.symbolCol : g.nameCol));
  idSel.addEventListener('change', () => { const c = Number(idSel.value); if (g.symbolCol >= 0) g.symbolCol = c; else g.nameCol = c; redraw(); });
  const list = fundamentalsRows(g), found = FUND_FIELDS.filter(([k]) => g.map[k] >= 0).length;
  const go = h('button', { type: 'button', class: 'btn btn-primary btn-block', disabled: !connected || state.busy || !list.length }, t('fund.import', { n: list.length }));
  go.addEventListener('click', async () => {
    state.busy = true; go.disabled = true;
    try {
      state.result = await api.fundamentals(list, 'Import ' + state.file.slice(0, 40));
      state.guess = null;
      toast(t('fund.done', { n: state.result.matched }));
      await refresh();
    } catch (e) { toast(e.message); }
    state.busy = false; redraw();
  });
  return h('div', null,
    h('div', { class: 'panel' },
      h('b', null, t('fund.found', { n: list.length, sheet: g.sheet })),
      h('p', { class: 'note' }, t('fund.fields', { n: found, total: FUND_FIELDS.length })),
      found < FUND_FIELDS.length ? h('p', { class: 'note faint' }, t('fund.fieldsNote')) : null),
    h('div', { class: 'form-sec' }, h('h2', null, t('fund.match')),
      h('div', { class: 'field' }, h('label', { for: 'fm-id' }, g.symbolCol >= 0 ? t('fund.symbolCol') : t('fund.nameCol')), idSel),
      rows),
    h('div', { class: 'btn-row' }, go, h('button', { type: 'button', class: 'btn btn-ghost btn-block', onclick: () => { state.guess = null; redraw(); } }, t('portfolio.cancel'))),
    h('p', { class: 'note faint', style: { marginTop: '10px' } }, t('fund.privacy')));
}

function resultPanel(r) {
  return h('div', { class: 'panel', style: { marginBottom: '14px' } },
    h('b', null, t('fund.resultTitle', { n: r.matched })),
    h('p', { class: 'note' }, t('fund.resultBody', { pct: r.completenessPct, total: r.total })),
    r.unmatchedCount ? h('p', { class: 'note' }, t('fund.unmatched', { n: r.unmatchedCount, list: r.unmatched.slice(0, 12).join(', ') })) : null,
    h('p', { class: 'note faint' }, t('fund.next')));
}

function steps() {
  return h('details', { class: 'panel note-panel', style: { marginTop: '18px' } },
    h('summary', null, t('fund.howTitle')),
    h('ol', { class: 'steps' }, [1, 2, 3, 4].map((n) => h('li', null, t('fund.how' + n)))),
    h('p', { class: 'note faint' }, t('fund.howColumns')));
}
