// More: the menu, plus the About page. Portfolio, Backtest lab and Fundamentals have their own screens.
import { h, icon } from '../util.js';
import { t } from '../i18n.js';
import { ICONS } from '../icons.js';
import { screenHead, previewBanner } from '../ui.js';
import { APP_VERSION } from '../state.js';
import { isConnected } from '../api.js';

export function render({ data }) {
  const item = (href, ic, title, sub) => h('li', null,
    h('a', { class: 'row', href },
      icon(ICONS[ic]),
      h('span', { class: 'srow-text' }, h('span', { style: { fontWeight: 620 } }, title), h('small', null, sub)),
      icon(ICONS.chevron)));
  const list = h('ul', { class: 'list menu' },
    item('#/portfolio', 'portfolio', t('more.portfolio'), t('more.portfolioSub')),
    item('#/backtest', 'backtest', t('more.backtest'), t('more.backtestSub')),
    item('#/fundamentals', 'fund', t('more.fund'), t('more.fundSub')),
    item('#/settings', 'settings', t('more.settings'), t('more.settingsSub')),
    item('#/about', 'about', t('more.about'), t('more.aboutSub')));
  list.querySelectorAll('.row > svg:last-child').forEach((el) => el.classList.add('chev'));
  return h('div', null,
    data.isDemo ? previewBanner() : null,
    screenHead(t('more.title')),
    list,
    h('p', { class: 'foot' }, t('more.version', { v: APP_VERSION }) + ' ' + (isConnected() && !data.isDemo ? t('more.connected') : t('more.notConnected'))));
}

export function renderAbout() {
  return h('div', null,
    screenHead(t('about.title'), null, '#/more'),
    h('div', { style: { display: 'grid', gap: '14px', maxWidth: '62ch' } },
      h('p', null, t('about.p1')),
      h('p', null, h('b', null, t('about.p2'))),
      h('p', null, t('about.p3'))),
    h('section', { class: 'sec' }, h('h2', { class: 'sec-title' }, t('about.data')), h('p', { class: 'muted', style: { marginTop: '6px', maxWidth: '62ch' } }, t('about.dataBody'))),
    h('section', { class: 'sec' }, h('h2', { class: 'sec-title' }, t('about.credits')), h('p', { class: 'muted', style: { marginTop: '6px' } }, t('about.creditsBody'))));
}
