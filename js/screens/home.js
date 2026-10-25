// Home: market regime, today's signals, paper account, track record, engine health.
import { h, fmt, tone, marketState, istParts } from '../util.js';
import { t, pick, getLang } from '../i18n.js';
import { sectionHead, alertRow, trackStrip, stripLegend, horizonTag, statusChip, previewBanner } from '../ui.js';
import { equityChart } from '../charts.js';
import { openAlert } from './alerts.js';
import { openStrategy } from './results.js';

export function render({ data }) {
  const m = data.market;
  const state = marketState();
  const stateKey = { open: 'market.open', pre: 'market.pre', closed: 'market.closed', weekend: 'market.weekend', holiday: 'market.holiday' }[state];
  const today = data.alerts.filter((a) => fmt.shortDate(a.time) === fmt.shortDate(data.asOf)).sort((a, b) => b.time - a.time);
  // On weekends, holidays and before the close, the latest session is not today: say which day it was.
  const isToday = istParts().ymd === data.session;
  const signalsTitle = isToday ? t('home.signals') : t('home.signalsOn', { date: fmt.dayMonth(data.asOf, getLang()) });
  const dayWord = isToday ? t('home.today') : t('home.lastSession');

  const hero = h('section', { class: 'hero', 'aria-labelledby': 'hero-title' },
    h('p', { class: 'hero-date' },
      h('span', null, fmt.longDate(Date.now(), getLang())),
      h('span', { class: 'mkt-state' + (state === 'open' ? ' open' : '') }, t(stateKey)),
      data.isDemo ? h('span', { class: 'chip sample' }, t('common.sample')) : null),
    h('h1', { class: 'hero-title', id: 'hero-title' }, t('regime.' + m.regime)),
    h('dl', { class: 'mkt' },
      h('dt', null, t('home.nifty')), h('dd', { class: 'v num' }, fmt.num(m.nifty)), h('dd', { class: 'c num ' + tone(m.niftyChg) }, fmt.pct(m.niftyChg)),
      h('dt', null, t('home.vix')), h('dd', { class: 'v num' }, fmt.num(m.vix)), h('dd', { class: 'c num ' + tone(-m.vixChg) }, fmt.pct(m.vixChg)),
      h('dt', null, t('home.breadth')), h('dd', { class: 'v num' }, t('home.breadthValue', { pct: m.breadth })), h('dd', { class: 'c' })));

  const signals = h('section', { class: 'sec' },
    sectionHead(signalsTitle, { count: today.length, link: { href: '#/alerts', label: t('common.seeAll') } }),
    h('ul', { class: 'list' }, today.slice(0, 3).map((a) => alertRow(a, openAlert))));

  const p = data.paper;
  const total = ((p.value - p.start) / p.start) * 100;
  const paper = h('section', { class: 'sec' },
    sectionHead(t('home.paper'), { link: { href: '#/results?tab=paper', label: t('common.seeAll') } }),
    h('div', { class: 'panel' },
      h('div', { class: 'big-num num' }, fmt.money(p.value)),
      h('div', { class: 'stat-line' },
        h('span', null, h('b', { class: tone(total) }, fmt.pct(total)), ' ', t('home.sinceStart')),
        h('span', null, h('b', { class: tone(p.today) }, fmt.signedMoney(p.today)), ' ', dayWord),
        h('span', null, t('home.openTrades', { n: p.open.length }))),
      equityChart({ points: p.curve, base: p.start, height: 64, mini: true, label: t('results.equity') })));

  // Live-ready strategies first, then the paper strategies closest to 30 trades. Rejected ones live on Results.
  const top = data.strategies.filter((st) => st.status !== 'rejected')
    .sort((a, b) => (b.status === 'live') - (a.status === 'live') || b.trades - a.trades).slice(0, 4);
  const track = h('section', { class: 'sec' },
    sectionHead(t('home.track'), { link: { href: '#/results', label: t('common.seeAll') } }),
    h('p', { class: 'sec-note' }, t('home.trackNote')),
    h('ul', { class: 'list' }, top.map((st) => h('li', null,
      h('button', { type: 'button', class: 'row', onclick: () => openStrategy(st) },
        h('span', { class: 'row-title', style: { fontSize: '16px' } }, pick(st.name)),
        h('span', { class: 'row-side' }, statusChip(st.status)),
        h('span', { class: 'row-meta', style: { gridColumn: '1 / -1' } }, horizonTag(st.horizon),
          h('span', null, st.trades >= 30 ? t('results.tradesDone', { n: st.trades }) : t('results.trades', { n: st.trades })),
          st.win != null ? h('span', { class: 'num' }, t('home.winShort', { pct: st.win })) : null),
        h('span', { style: { gridColumn: '1 / -1' } }, trackStrip(st.outcomes, { animate: true })))))),
    stripLegend());

  const e = data.engine;
  const engine = h('section', { class: 'sec' },
    sectionHead(t('home.engine')),
    h('div', { class: 'health' },
      h('div', { class: 'health-item ok' }, h('i'),
        h('span', null, h('b', null, t('home.engineSource', { source: e.source })), h('br'),
          t('home.lastCheck', { time: `${fmt.dayMonth(e.lastCheck, getLang())} ${fmt.time(e.lastCheck)}` }))),
      ...e.fallbacks.map((f) => h('div', { class: 'health-item ' + f.state }, h('i'),
        h('span', null, f.name, ' ', h('span', { class: 'faint' }, t(f.state === 'ok' ? 'home.fallbackReady' : 'home.fallbackOff')))))));

  return h('div', null, data.isDemo ? previewBanner() : null, hero, signals, paper, track, engine);
}
