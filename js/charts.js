// charts.js — small SVG charts drawn with theme tokens (no external library).
// candleChart: price candles with entry zone, stop-loss, targets, overlays and volume.
// equityChart: paper-account equity against its starting capital.
import { h, s, fmt, priceDecimals } from './util.js';
import { t, getLang } from './i18n.js';

const W = 340;

function niceStep(range, count) {
  const raw = range / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  return step * mag;
}

function axisNum(v) { return fmt.num(v, Math.abs(v) >= 10000 ? 0 : priceDecimals(v)); }

function timeLabel(ts, mode) {
  return mode === 'intraday' ? fmt.time(ts) : fmt.dayMonth(ts, getLang());
}

/** Spread label centres so tags never overlap (minimum gap in px). */
function spread(tags, gap, top, bottom) {
  tags.sort((a, b) => a.y - b.y);
  for (let i = 1; i < tags.length; i++) if (tags[i].y - tags[i - 1].y < gap) tags[i].y = tags[i - 1].y + gap;
  const overflow = tags.length ? tags[tags.length - 1].y - bottom : 0;
  if (overflow > 0) for (const tg of tags) tg.y -= overflow;
  for (let i = tags.length - 2; i >= 0; i--) if (tags[i + 1].y - tags[i].y < gap) tags[i].y = tags[i + 1].y - gap;
  for (const tg of tags) tg.y = Math.max(top, tg.y);
  return tags;
}

/**
 * @param {object} o
 * @param {{t:number,o:number,h:number,l:number,c:number,v?:number}[]} o.candles
 * @param {{entryLo?:number,entryHi?:number,stop?:number,targets?:number[]}} [o.levels]
 * @param {{values:(number|null)[], label:string}[]} [o.overlays]
 * @param {'day'|'intraday'} [o.mode]
 */
export function candleChart({ candles, levels = {}, overlays = [], mode = 'day', height = 236, label = '' }) {
  const H = height;
  const padR = 56, padT = 8, padB = 18, volH = candles.some((c) => c.v) ? 30 : 0;
  const x1 = W - padR;
  const pTop = padT, pBot = H - padB - volH - (volH ? 6 : 0);
  const n = candles.length;
  const step = x1 / n;
  const bodyW = Math.max(1.4, Math.min(9, step * 0.62));

  const levelVals = [levels.entryLo, levels.entryHi, levels.stop, ...(levels.targets || [])].filter((v) => v > 0);
  let lo = Math.min(...candles.map((c) => c.l), ...levelVals);
  let hi = Math.max(...candles.map((c) => c.h), ...levelVals);
  const pad = (hi - lo) * 0.06 || 1;
  lo -= pad; hi += pad;
  const y = (p) => pTop + ((hi - p) / (hi - lo)) * (pBot - pTop);
  const xc = (i) => i * step + step / 2;

  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': label });

  // Grid and price axis
  const gStep = niceStep(hi - lo, 4);
  const gridVals = [];
  for (let v = Math.ceil(lo / gStep) * gStep; v <= hi; v += gStep) gridVals.push(v);
  const g = s('g');
  for (const v of gridVals) g.append(s('line', { x1: 0, x2: x1, y1: y(v), y2: y(v), class: 'grid' }));
  svg.append(g);

  // Entry zone, stop-loss and targets
  if (levels.entryLo > 0 && levels.entryHi > 0) {
    const top = y(Math.max(levels.entryLo, levels.entryHi));
    const bh = Math.max(2, Math.abs(y(levels.entryLo) - y(levels.entryHi)));
    svg.append(s('rect', { x: 0, y: top, width: x1, height: bh, class: 'entry-band' }));
  }
  if (levels.stop > 0) svg.append(s('line', { x1: 0, x2: x1, y1: y(levels.stop), y2: y(levels.stop), class: 'stop-line' }));
  for (const tg of levels.targets || []) svg.append(s('line', { x1: 0, x2: x1, y1: y(tg), y2: y(tg), class: 'tgt-line' }));

  // Volume
  if (volH) {
    const maxV = Math.max(...candles.map((c) => c.v || 0)) || 1;
    const vg = s('g');
    candles.forEach((c, i) => {
      const vh = ((c.v || 0) / maxV) * volH;
      vg.append(s('rect', { x: xc(i) - bodyW / 2, y: H - padB - vh, width: bodyW, height: Math.max(0.5, vh), class: 'vol' }));
    });
    svg.append(vg);
  }

  // Candles
  const cg = s('g');
  candles.forEach((c, i) => {
    const up = c.c >= c.o;
    const cls = up ? 'up' : 'dn';
    cg.append(s('line', { x1: xc(i), x2: xc(i), y1: y(c.h), y2: y(c.l), class: cls, 'stroke-width': 1 }));
    const top = y(Math.max(c.o, c.c));
    cg.append(s('rect', { x: xc(i) - bodyW / 2, y: top, width: bodyW, height: Math.max(1, Math.abs(y(c.o) - y(c.c))), class: cls, rx: 0.6 }));
  });
  svg.append(cg);

  // Overlays (moving averages)
  overlays.forEach((ov, k) => {
    let d = '';
    ov.values.forEach((v, i) => { if (v != null) d += (d ? 'L' : 'M') + xc(i).toFixed(1) + ' ' + y(v).toFixed(1); });
    if (d) svg.append(s('path', { d, class: 'overlay o' + k }));
  });

  // Right-side tags: levels first, then the last price, then grid labels where there is room
  const last = candles[n - 1];
  const tags = [];
  if (levels.entryLo > 0) tags.push({ y: y((levels.entryLo + levels.entryHi) / 2), v: (levels.entryLo + levels.entryHi) / 2, cls: 'entry' });
  if (levels.stop > 0) tags.push({ y: y(levels.stop), v: levels.stop, cls: 'stop' });
  for (const tg of levels.targets || []) tags.push({ y: y(tg), v: tg, cls: 'tgt' });
  tags.push({ y: y(last.c), v: last.c, cls: 'last' });
  spread(tags, 16, pTop + 7, pBot - 7);
  const tagG = s('g');
  for (const tg of tags) {
    tagG.append(s('rect', { x: x1 + 4, y: tg.y - 7.5, width: padR - 5, height: 15, rx: 4, class: 'tag-bg ' + tg.cls }));
    tagG.append(s('text', { x: x1 + 4 + (padR - 5) / 2, y: tg.y + 3.5, 'text-anchor': 'middle', class: 'tag-tx ' + (tg.cls === 'entry' ? 'entry' : '') }, axisNum(tg.v)));
  }
  for (const v of gridVals) {
    const yy = y(v);
    if (tags.some((tg) => Math.abs(tg.y - yy) < 13) || yy < pTop + 4 || yy > pBot - 2) continue;
    svg.append(s('text', { x: x1 + 8, y: yy + 3.5 }, axisNum(v)));
  }
  svg.append(tagG);

  // Time labels
  const ticks = 4;
  for (let k = 0; k < ticks; k++) {
    const i = Math.round((k * (n - 1)) / (ticks - 1));
    const anchor = k === 0 ? 'start' : k === ticks - 1 ? 'end' : 'middle';
    svg.append(s('text', { x: k === 0 ? 0 : k === ticks - 1 ? x1 : xc(i), y: H - 4, 'text-anchor': anchor }, timeLabel(candles[i].t, mode)));
  }

  // Crosshair and readout
  const read = h('div', { class: 'chart-read', 'aria-live': 'off' });
  const xh = s('line', { y1: pTop, y2: H - padB, class: 'xhair', visibility: 'hidden' });
  svg.append(xh);
  const showRead = (i) => {
    const c = candles[i];
    read.replaceChildren(
      h('span', null, timeLabel(c.t, mode)),
      h('span', null, 'O ', h('b', null, axisNum(c.o))),
      h('span', null, 'H ', h('b', null, axisNum(c.h))),
      h('span', null, 'L ', h('b', null, axisNum(c.l))),
      h('span', null, 'C ', h('b', { class: c.c >= c.o ? 'gain' : 'loss' }, axisNum(c.c))));
  };
  showRead(n - 1);
  const hit = s('rect', { x: 0, y: 0, width: x1, height: H, fill: 'transparent' });
  const move = (e) => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.floor(px / step)));
    xh.setAttribute('x1', xc(i)); xh.setAttribute('x2', xc(i)); xh.setAttribute('visibility', 'visible');
    showRead(i);
  };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerdown', move);
  hit.addEventListener('pointerleave', () => { xh.setAttribute('visibility', 'hidden'); showRead(n - 1); });
  svg.append(hit);

  const legend = h('div', { class: 'chart-legend' },
    levels.entryLo > 0 ? h('span', { class: 'e' }, h('i'), t('alert.entryZone')) : null,
    levels.stop > 0 ? h('span', { class: 's' }, h('i'), t('alert.stop')) : null,
    (levels.targets || []).length ? h('span', { class: 't' }, h('i'), t('alert.target')) : null,
    ...overlays.map((ov, k) => h('span', { class: 'o o' + k }, h('i'), ov.label)));

  return h('div', { class: 'chart' }, read, svg, legend);
}

/**
 * Equity curve against starting capital.
 * @param {{t:number,v:number}[]} points
 */
export function equityChart({ points, base, height = 132, mini = false, label = '' }) {
  const H = height;
  const padR = mini ? 0 : 56, padT = 6, padB = mini ? 4 : 18;
  const x1 = W - padR;
  const vals = points.map((p) => p.v);
  let lo = Math.min(base, ...vals), hi = Math.max(base, ...vals);
  const pad = (hi - lo) * 0.1 || 1;
  lo -= pad; hi += pad;
  const n = points.length;
  const x = (i) => (i / (n - 1)) * x1;
  const y = (v) => padT + ((hi - v) / (hi - lo)) * (H - padT - padB);
  const up = vals[n - 1] >= base;

  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': label });
  svg.append(s('line', { x1: 0, x2: x1, y1: y(base), y2: y(base), class: 'base-line' }));
  const d = points.map((p, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.v).toFixed(1)).join('');
  svg.append(s('path', { d, class: 'eq-line ' + (up ? 'up' : 'dn') }));
  svg.append(s('circle', { cx: x(n - 1), cy: y(vals[n - 1]), r: 3.5, class: 'end-dot ' + (up ? 'up' : 'dn') }));

  if (!mini) {
    const maxV = Math.max(...vals), minV = Math.min(...vals);
    const labels = spread([
      { y: y(maxV), v: maxV }, { y: y(minV), v: minV }, { y: y(base), v: base },
    ].filter((l, i, arr) => arr.findIndex((m) => m.v === l.v) === i), 14, padT + 6, H - padB - 4);
    for (const l of labels) svg.append(s('text', { x: x1 + 8, y: l.y + 3.5 }, fmt.money(l.v)));
    svg.append(s('text', { x: 0, y: H - 4 }, fmt.dayMonth(points[0].t, getLang())));
    svg.append(s('text', { x: x1, y: H - 4, 'text-anchor': 'end' }, fmt.dayMonth(points[n - 1].t, getLang())));
  }
  const wrap = h('div', { class: 'chart' });
  if (!mini) {
    const read = h('div', { class: 'chart-read' });
    const xh = s('line', { y1: padT, y2: H - padB, class: 'xhair', visibility: 'hidden' });
    svg.append(xh);
    const show = (i) => read.replaceChildren(h('span', null, fmt.dayMonth(points[i].t, getLang())), h('b', null, fmt.money(points[i].v)),
      h('span', { class: points[i].v >= base ? 'gain' : 'loss' }, fmt.pct(((points[i].v - base) / base) * 100)));
    show(n - 1);
    const hit = s('rect', { x: 0, y: 0, width: x1, height: H, fill: 'transparent' });
    const move = (e) => {
      const r = svg.getBoundingClientRect();
      const i = Math.max(0, Math.min(n - 1, Math.round((((e.clientX - r.left) / r.width) * W / x1) * (n - 1))));
      xh.setAttribute('x1', x(i)); xh.setAttribute('x2', x(i)); xh.setAttribute('visibility', 'visible');
      show(i);
    };
    hit.addEventListener('pointermove', move);
    hit.addEventListener('pointerdown', move);
    hit.addEventListener('pointerleave', () => { xh.setAttribute('visibility', 'hidden'); show(n - 1); });
    svg.append(hit);
    wrap.append(read);
  }
  wrap.append(svg);
  return wrap;
}

/** Simple moving average helper for overlays. */
export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Exponential moving average helper for overlays. */
export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (i === period - 1) { prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period; out[i] = prev; }
    else if (i >= period) { prev = values[i] * k + prev * (1 - k); out[i] = prev; }
  }
  return out;
}
