// Settings: capital and risk, watchlist, alert switches, strategies, appearance, backend connection.
import { h, icon, fmt } from '../util.js';
import { t, pick } from '../i18n.js';
import { ICONS } from '../icons.js';
import { getSettings, saveSettings, LIMITS } from '../state.js';
import { screenHead, segmented, toast } from '../ui.js';

const SYMBOL_RE = /^[A-Z0-9&-]{1,20}$/;

function numberField({ id, label, hint, value, pre, post, step = 'any', money = false }) {
  const input = h('input', {
    id, type: 'number', inputmode: 'decimal', step, value: String(value),
    class: (pre ? 'has-pre ' : '') + (post ? 'has-post' : ''), 'aria-describedby': id + '-hint',
  });
  // Show money in Indian grouping (₹1,00,000) next to the label while typing.
  const shown = money ? h('span', { class: 'faint num', style: { fontWeight: 600 } }) : null;
  const paint = () => { if (shown) shown.textContent = Number.isFinite(Number(input.value)) && input.value !== '' ? fmt.money(Number(input.value)) : ''; };
  input.addEventListener('input', paint);
  paint();
  return {
    input,
    el: h('div', { class: 'field' },
      h('label', { for: id, style: { display: 'flex', justifyContent: 'space-between', gap: '12px' } }, h('span', null, label), shown),
      h('div', { class: 'input-wrap' },
        pre ? h('span', { class: 'affix pre', 'aria-hidden': 'true' }, pre) : null,
        input,
        post ? h('span', { class: 'affix post', 'aria-hidden': 'true' }, post) : null),
      h('span', { class: 'hint', id: id + '-hint' }, hint)),
  };
}

function switchRow(id, title, sub, checked, disabled = false) {
  const input = h('input', { id, type: 'checkbox', role: 'switch', class: 'switch', checked, disabled });
  return { input, el: h('div', { class: 'srow' }, h('label', { class: 'srow-text', for: id }, h('span', null, title), sub ? h('small', null, sub) : null), input) };
}

export function render({ data, rerender }) {
  const s = getSettings();
  let watch = [...s.watchlist];
  const off = new Set(s.strategiesOff);

  const real = numberField({ id: 'f-real', label: t('settings.realCap'), hint: t('settings.realCapHint'), value: s.realCapital, pre: '₹', step: '1000', money: true });
  const paper = numberField({ id: 'f-paper', label: t('settings.paperCap'), hint: t('settings.paperCapHint'), value: s.paperCapital, pre: '₹', step: '1000', money: true });
  const risk = numberField({ id: 'f-risk', label: t('settings.risk'), hint: t('settings.riskHint'), value: s.riskPct, post: '%', step: '0.1' });
  const maxStock = numberField({ id: 'f-max', label: t('settings.maxStock'), hint: t('settings.maxStockHint'), value: s.maxPerStockPct, post: '%', step: '1' });

  // Watchlist
  const tags = h('div', { class: 'tags' });
  const drawTags = () => tags.replaceChildren(...watch.map((sym) => h('span', { class: 'tag' }, sym,
    h('button', { type: 'button', 'aria-label': t('settings.remove', { s: sym }), onclick: () => { watch = watch.filter((x) => x !== sym); drawTags(); } }, icon(ICONS.close)))));
  drawTags();
  const addInput = h('input', { type: 'text', id: 'f-add', autocapitalize: 'characters', autocomplete: 'off', spellcheck: 'false', placeholder: t('settings.addSymbol'), 'aria-label': t('settings.addSymbol') });
  const addSymbol = () => {
    const sym = addInput.value.trim().toUpperCase();
    if (!sym) return;
    if (!SYMBOL_RE.test(sym)) { addInput.setAttribute('aria-invalid', 'true'); toast(t('settings.invalid')); return; }
    if (watch.includes(sym)) { toast(t('settings.watchDup', { s: sym })); return; }
    if (watch.length >= LIMITS.watchlistMax) { toast(t('settings.watchFull')); return; }
    watch.push(sym); addInput.value = ''; addInput.removeAttribute('aria-invalid'); drawTags();
  };
  addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addSymbol(); } });

  const tg = switchRow('f-tg', t('settings.telegram'), t('settings.telegramSub'), s.telegram);
  const em = switchRow('f-em', t('settings.email'), t('settings.emailSub'), s.emailDigest);
  const pa = switchRow('f-pa', t('settings.paperAlerts'), t('settings.paperAlertsSub'), s.paperAlerts);

  const stratRows = data.strategies.map((st) => {
    const r = switchRow('f-st-' + st.id, pick(st.name), t('hz.' + st.horizon), !off.has(st.id));
    r.input.addEventListener('change', () => { if (r.input.checked) off.delete(st.id); else off.add(st.id); });
    return r.el;
  });

  const url = h('input', { id: 'f-url', type: 'url', value: s.backendUrl, placeholder: 'https://script.google.com/macros/s/…/exec', disabled: true });
  const token = h('input', { id: 'f-token', type: 'password', value: s.token, autocomplete: 'off', disabled: true });

  const save = () => {
    const checks = [
      [real.input, LIMITS.realCapital], [paper.input, LIMITS.paperCapital], [risk.input, LIMITS.riskPct], [maxStock.input, LIMITS.maxPerStockPct],
    ];
    let ok = true;
    for (const [input, [min, max]] of checks) {
      const v = Number(input.value);
      const good = input.value !== '' && Number.isFinite(v) && v >= min && v <= max;
      input.setAttribute('aria-invalid', String(!good));
      if (!good) ok = false;
    }
    if (!ok) { toast(t('settings.invalid')); return; }
    saveSettings({
      realCapital: Number(real.input.value), paperCapital: Number(paper.input.value),
      riskPct: Number(risk.input.value), maxPerStockPct: Number(maxStock.input.value),
      watchlist: watch, telegram: tg.input.checked, emailDigest: em.input.checked, paperAlerts: pa.input.checked,
      strategiesOff: [...off],
    });
    toast(t('settings.saved'));
  };

  return h('div', null,
    screenHead(t('settings.title'), t('settings.sub'), '#/more'),
    h('section', { class: 'form-sec' }, h('h2', null, t('settings.money')), real.el, paper.el, risk.el, maxStock.el),
    h('section', { class: 'form-sec' },
      h('h2', null, t('settings.watchlist')),
      h('p', { class: 'sec-note' }, t('settings.watchlistHint')),
      tags,
      h('div', { class: 'add-row' }, addInput, h('button', { type: 'button', class: 'btn btn-ghost', onclick: addSymbol }, icon(ICONS.plus), t('settings.add')))),
    h('section', { class: 'form-sec' },
      h('h2', null, t('settings.alerts')), tg.el, em.el, pa.el,
      h('button', { type: 'button', class: 'btn btn-ghost btn-block', style: { marginTop: '12px' }, disabled: true }, t('settings.testTg')),
      h('p', { class: 'note faint', style: { textAlign: 'center', marginTop: '6px', fontSize: '12px' } }, t('common.comingPhase', { n: 1 }))),
    h('section', { class: 'form-sec' },
      h('h2', null, t('settings.strategies')),
      h('p', { class: 'sec-note' }, t('settings.strategiesSub')),
      stratRows),
    h('section', { class: 'form-sec' },
      h('h2', null, t('settings.look')),
      h('div', { class: 'field' }, h('span', { class: 'label' }, t('settings.theme')),
        segmented([
          { value: 'system', label: t('theme.system') }, { value: 'light', label: t('theme.light') }, { value: 'dark', label: t('theme.dark') },
        ], s.theme, (v) => saveSettings({ theme: v }), t('settings.theme'))),
      h('div', { class: 'field' }, h('span', { class: 'label' }, t('settings.lang')),
        segmented([{ value: 'en', label: 'English' }, { value: 'ml', label: 'മലയാളം' }], s.lang,
          (v) => { saveSettings({ lang: v }); rerender(); }, t('settings.lang')))),
    h('section', { class: 'form-sec' },
      h('h2', null, t('settings.connection')),
      h('div', { class: 'field' }, h('label', { for: 'f-url' }, t('settings.url')), url),
      h('div', { class: 'field' }, h('label', { for: 'f-token' }, t('settings.token')), token, h('span', { class: 'hint' }, t('settings.connHint')))),
    h('div', { class: 'sticky-save' }, h('button', { type: 'button', class: 'btn btn-primary btn-block', onclick: save }, t('settings.save'))));
}
