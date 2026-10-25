// app.js — shell, router and boot.
import { h, icon } from './util.js';
import { t } from './i18n.js';
import { ICONS } from './icons.js';
import { applyLook, getSettings, saveSettings, effectiveTheme } from './state.js';
import { closeSheet, sheetIsOpen } from './ui.js';
import { getData } from './data.js';
import * as home from './screens/home.js';
import * as alerts from './screens/alerts.js';
import * as scan from './screens/scan.js';
import * as results from './screens/results.js';
import * as more from './screens/more.js';
import * as settings from './screens/settings.js';

const ROUTES = {
  home: { tab: 'home', render: home.render },
  alerts: { tab: 'alerts', render: alerts.render },
  scan: { tab: 'scan', render: scan.render },
  results: { tab: 'results', render: results.render },
  more: { tab: 'more', render: more.render },
  settings: { tab: 'more', render: settings.render },
  portfolio: { tab: 'more', render: more.renderPortfolio },
  backtest: { tab: 'more', render: more.renderBacktest },
  about: { tab: 'more', render: more.renderAbout },
};
const TABS = ['home', 'alerts', 'scan', 'results', 'more'];

let appbar, main, tabbar;

function buildShell() {
  const themeBtn = h('button', { type: 'button', class: 'icon-btn', id: 'theme-btn' });
  themeBtn.addEventListener('click', () => { saveSettings({ theme: effectiveTheme() === 'dark' ? 'light' : 'dark' }); paintChrome(); });

  appbar = h('header', { class: 'appbar' },
    h('div', { class: 'appbar-inner' },
      h('a', { class: 'brand', href: '#/home', 'aria-label': t('app.name') }, icon(ICONS.mark), h('span', { class: 'brand-name' }, t('app.name'))),
      themeBtn));
  main = h('main', { id: 'main', tabindex: '-1', class: 'page' });
  tabbar = h('nav', { class: 'tabbar', 'aria-label': 'Main' }, h('div', { class: 'tabbar-inner' }));
  const skip = h('a', { class: 'skip', href: '#main', id: 'skip' });
  skip.addEventListener('click', (e) => { e.preventDefault(); main.focus(); });
  const sheetRoot = h('div', { id: 'sheet-root' });
  const toastEl = h('div', { id: 'toast', role: 'status', 'aria-live': 'polite' });
  document.body.replaceChildren(skip, appbar, main, tabbar, sheetRoot, toastEl);

  addEventListener('scroll', () => appbar.classList.toggle('scrolled', scrollY > 4), { passive: true });
}

/** Refresh shell controls for the current theme and tab. */
function paintChrome(activeTab) {
  document.getElementById('skip').textContent = t('a11y.skip');
  const themeBtn = document.getElementById('theme-btn');
  const dark = effectiveTheme() === 'dark';
  themeBtn.replaceChildren(icon(dark ? ICONS.sun : ICONS.moon));
  themeBtn.setAttribute('aria-label', dark ? t('a11y.themeLight') : t('a11y.themeDark'));
  if (activeTab) {
    tabbar.firstElementChild.replaceChildren(...TABS.map((tab) => h('a', {
      class: 'tab', href: '#/' + tab, 'aria-current': tab === activeTab ? 'page' : null,
    }, icon(ICONS[tab]), h('span', null, t('nav.' + tab)))));
  }
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs] = raw.split('?');
  const name = ROUTES[path] ? path : 'home';
  return { name, query: new URLSearchParams(qs || '') };
}

let lastRoute = '';
function route() {
  if (sheetIsOpen()) closeSheet(true);
  const { name, query } = parseHash();
  const r = ROUTES[name];
  const ctx = { data: getData(), query, rerender: () => route() };
  main.replaceChildren(r.render(ctx));
  paintChrome(r.tab);
  document.title = name === 'home' ? t('app.name') : `${t('nav.' + r.tab)} – ${t('app.name')}`;
  if (location.hash !== lastRoute) { scrollTo(0, 0); lastRoute = location.hash; }
}

function boot() {
  applyLook();
  buildShell();
  addEventListener('hashchange', route);
  addEventListener('popstate', () => { if (sheetIsOpen()) closeSheet(); });
  try {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (getSettings().theme === 'system') { applyLook(); paintChrome(); } });
  } catch (e) { /* older browsers */ }
  route();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
  }
}

boot();
