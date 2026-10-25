// ui.js — shared interface components.
import { h, s, icon, fmt, tone } from './util.js';
import { t, pick } from './i18n.js';
import { ICONS } from './icons.js';

const HZ_LEVEL = { intraday: 1, swing: 2, medium: 3, long: 4 };

/** Horizon tag: four bars, filled by how long the trade is meant to last.
 *  Short label in lists; full label with holding window in detail sheets. */
export function horizonTag(hz, withWindow = false) {
  const n = HZ_LEVEL[hz] || 1;
  const bars = [0, 1, 2, 3].map((i) => s('rect', { x: i * 4, y: 9 - i * 3, width: 3, height: 3 + i * 3, rx: 1, class: i < n ? 'on' : '' }));
  return h('span', { class: 'hz' },
    s('svg', { viewBox: '0 0 16 12', 'aria-hidden': 'true' }, ...bars),
    withWindow ? `${t('hz.' + hz)}, ${t('hzw.' + hz)}` : t('hzs.' + hz));
}

export function statusChip(status) {
  const cls = status === 'live' ? 'live' : status === 'rejected' ? 'rejected' : 'paper';
  return h('span', { class: 'chip ' + cls }, t('status.' + cls));
}

export function dirChip(dir) {
  return h('span', { class: 'chip ' + dir }, t('dir.' + dir));
}

/** Ball-by-ball strip: 30 dots in five groups of six. outcomes: string of W, L, X. */
export function trackStrip(outcomes = '', { animate = false } = {}) {
  const last = outcomes.slice(-30).split('');
  const dots = [];
  for (let i = 0; i < 30; i++) {
    const o = last[i];
    const cls = o === 'W' ? 'w' : o === 'L' ? 'l' : o === 'X' ? 'x' : 'p';
    dots.push(h('i', { class: 'dot ' + cls, style: { '--i': i } }));
  }
  const overs = [0, 1, 2, 3, 4].map((g) => h('span', { class: 'over' }, dots.slice(g * 6, g * 6 + 6)));
  const wins = last.filter((c) => c === 'W').length;
  const losses = last.filter((c) => c === 'L').length;
  const flats = last.filter((c) => c === 'X').length;
  const label = `${wins} ${t('legend.win')}, ${losses} ${t('legend.loss')}, ${flats} ${t('legend.flat')}`;
  return h('div', { class: 'strip' + (animate ? ' play' : ''), role: 'img', 'aria-label': label }, overs);
}

export function stripLegend() {
  const item = (style, key) => h('span', null, h('i', { style }), t(key));
  return h('div', { class: 'strip-legend' },
    item({ background: 'var(--gain)' }, 'legend.win'),
    item({ background: 'var(--loss)' }, 'legend.loss'),
    item({ boxShadow: 'inset 0 0 0 2px var(--text-3)' }, 'legend.flat'),
    item({ background: 'var(--line)', transform: 'scale(.55)' }, 'legend.pending'));
}

export function screenHead(title, sub, backHref) {
  return h('header', { class: 'screen-head' },
    backHref ? h('a', { class: 'back-link', href: backHref }, icon(ICONS.back), t('common.back')) : null,
    h('h1', { class: 'screen-title' }, title),
    sub ? h('p', { class: 'screen-sub' }, sub) : null);
}

export function sectionHead(title, { count, link } = {}) {
  return h('div', { class: 'sec-head' },
    h('h2', { class: 'sec-title' }, title, count != null ? h('span', { class: 'sec-count' }, String(count)) : null),
    link ? h('a', { class: 'sec-link', href: link.href }, link.label) : null);
}

/** Segmented control. options: [{ value, label }] */
export function segmented(options, value, onChange, label) {
  const wrap = h('div', { class: 'seg', role: 'group', 'aria-label': label || '' });
  for (const o of options) {
    wrap.append(h('button', {
      type: 'button', 'aria-pressed': String(o.value === value),
      onclick: () => {
        wrap.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', 'false'));
        wrap.querySelector(`[data-v="${o.value}"]`).setAttribute('aria-pressed', 'true');
        onChange(o.value);
      },
      dataset: { v: o.value },
    }, o.label));
  }
  return wrap;
}

/** Horizontally scrolling filter chips. */
export function filterChips(options, value, onChange, label) {
  const wrap = h('div', { class: 'filters', role: 'group', 'aria-label': label || '' });
  for (const o of options) {
    wrap.append(h('button', {
      type: 'button', class: 'fchip', 'aria-pressed': String(o.value === value), dataset: { v: o.value },
      onclick: () => {
        wrap.querySelectorAll('.fchip').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === o.value)));
        onChange(o.value);
      },
    }, o.label));
  }
  return wrap;
}

/** One alert in a list. */
export function alertRow(a, onOpen) {
  const right = a.dir === 'exit'
    ? h('span', { class: 'row-right' }, dirChip('exit'))
    : h('span', { class: 'row-right num' }, `${t('dir.' + a.dir)} ${fmt.priceRange(a.entryLo, a.entryHi)}`);
  return h('li', null, h('button', { type: 'button', class: 'row', onclick: () => onOpen(a) },
    h('span', { class: 'row-title' }, a.symbol),
    right,
    h('span', { class: 'row-meta' }, horizonTag(a.horizon), h('span', null, pick(a.strategyName))),
    h('span', { class: 'row-side' }, statusChip(a.status)),
    a.dir === 'exit'
      ? h('span', { class: 'row-levels' }, pick(a.headline))
      : h('span', { class: 'row-levels num' },
        h('span', null, t('alert.stop') + ' ', h('b', null, fmt.price(a.stop))),
        h('span', null, t('alert.target') + ' ', h('b', null, fmt.price(a.targets[0]))),
        h('span', null, 'R:R ', h('b', null, fmt.num(a.rr, 1))),
        a.outcome
          ? h('span', { class: tone(a.outcome.pct) }, `${t(OUTCOME_KEY[a.outcome.state])} ${fmt.pct(a.outcome.pct, 1)}`)
          : h('span', { class: 'faint' }, fmt.time(a.time)))));
}

const OUTCOME_KEY = { target: 'legend.win', stop: 'legend.loss', expired: 'legend.flat' };
export function outcomeLabel(state) { return t(OUTCOME_KEY[state] || 'legend.flat'); }

// ---------- Toast ----------
let toastTimer;
export function toast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// ---------- Bottom sheet (Android back button closes it) ----------
let openSheetState = null;

export function openSheet(buildContent, { label } = {}) {
  const replacing = !!openSheetState; // opening a sheet from a sheet replaces it, keeping one history entry
  closeSheet(true);
  const root = document.getElementById('sheet-root');
  const scrim = h('div', { class: 'sheet-scrim', onclick: () => history.back() });
  const closeBtn = h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('a11y.close'), onclick: () => history.back() }, icon(ICONS.close));
  const panel = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': label || '', tabindex: '-1' },
    h('div', { class: 'sheet-handle', 'aria-hidden': 'true' }));
  panel.append(buildContent(closeBtn));
  root.append(scrim, panel);
  const lastFocus = document.activeElement;
  requestAnimationFrame(() => { scrim.classList.add('open'); panel.classList.add('open'); panel.focus({ preventScroll: true }); });
  if (replacing) history.replaceState({ sheet: true }, ''); else history.pushState({ sheet: true }, '');
  const onKey = (e) => { if (e.key === 'Escape') history.back(); };
  document.addEventListener('keydown', onKey);
  document.body.style.overflow = 'hidden';
  openSheetState = { scrim, panel, onKey, lastFocus };
  return panel;
}

/** Close the open sheet. silent=true skips the exit animation (used when replacing a sheet). */
export function closeSheet(silent = false) {
  if (!openSheetState) return;
  const { scrim, panel, onKey, lastFocus } = openSheetState;
  openSheetState = null;
  document.removeEventListener('keydown', onKey);
  document.body.style.overflow = '';
  if (silent) { scrim.remove(); panel.remove(); return; }
  scrim.classList.remove('open');
  panel.classList.remove('open');
  setTimeout(() => { scrim.remove(); panel.remove(); }, 320);
  if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
}

export function sheetIsOpen() { return !!openSheetState; }

export function kvList(pairs) {
  const dl = h('dl', { class: 'kv' });
  for (const p of pairs) {
    if (!p) continue;
    dl.append(h('dt', null, p[0]), h('dd', { class: 'num' + (p[2] ? ' ' + p[2] : '') }, p[1]));
  }
  return dl;
}

export function previewBanner() {
  return h('div', { class: 'banner', role: 'note' }, icon(ICONS.preview), h('span', null, t('preview.banner')));
}
