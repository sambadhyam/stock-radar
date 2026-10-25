// Connect: opened from the link the sheet sends (Stock Radar → Connect the app).
// Saves the web app address and token on this phone, checks them, then removes the token from the address bar.
import { h } from '../util.js';
import { t } from '../i18n.js';
import { screenHead } from '../ui.js';
import { getSettings, saveSettings } from '../state.js';
import { api, validUrl, validToken, isConnected } from '../api.js';
import { refresh, clearLive } from '../data.js';

export function render({ query }) {
  const u = (query.get('u') || '').trim();
  const tok = (query.get('t') || '').trim();
  const box = h('div', { class: 'empty', role: 'status', 'aria-live': 'polite' });
  const page = h('div', null, screenHead(t('connect.title'), null, '#/more'), box);

  if (!u && !tok) {
    box.replaceChildren(
      h('p', null, isConnected() ? t('connect.already') : t('connect.how')),
      h('a', { class: 'btn ' + (isConnected() ? 'btn-primary' : 'btn-ghost'), href: isConnected() ? '#/home' : '#/settings' }, isConnected() ? t('connect.open') : t('more.settings')));
    return page;
  }
  if (!validUrl(u) || !validToken(tok)) {
    box.replaceChildren(h('h2', null, t('connect.fail')), h('p', null, t('connect.bad')));
    return page;
  }
  // Keep the token out of the address bar and browser history from here on.
  try { history.replaceState(null, '', location.pathname + location.search + '#/connect?checking=1'); } catch (e) { /* ignore */ }
  const prev = getSettings();
  box.replaceChildren(h('p', null, t('connect.working')));
  api.ping({ backendUrl: u, token: tok }).then((r) => {
    if (prev.backendUrl !== u || prev.token !== tok) clearLive();
    saveSettings({ backendUrl: u, token: tok });
    box.replaceChildren(h('h2', null, t('connect.ok')), h('p', null, t('connect.okBody')), h('p', { class: 'faint' }, t('settings.connected', { v: r.version })),
      h('a', { class: 'btn btn-primary', href: '#/home' }, t('connect.open')));
    refresh();
  }).catch((e) => {
    box.replaceChildren(h('h2', null, t('connect.fail')), h('p', null, e.message),
      h('p', { class: 'faint' }, t('connect.how')));
  });
  return page;
}
