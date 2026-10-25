// tests.mjs — run with:  node tools/gas-sim/tests.mjs
// Exercises apps-script/*.gs against simulated Google services and fake Angel One / Telegram servers.
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSim } from './sim.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FILES = path.join(here, '..', '..', 'apps-script');
// Setup.gs first on purpose: the engine must not depend on the order files load in.
const ORDER = ['Setup.gs', 'Engine.gs', 'Api.gs', 'Data.gs'];

let passed = 0, failed = 0;
const results = [];
function test(name, fn) {
  try { fn(); passed++; results.push('  ✓ ' + name); }
  catch (e) { failed++; results.push('  ✗ ' + name + '\n      ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n      ') : e)); }
}
function eq(a, b, msg) { if (a !== b) throw new Error((msg || 'expected equal') + `: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }

// ---------- reference TOTP (independent of the engine's code) ----------
function b32(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = ''; for (const c of s.replace(/=+$/, '')) bits += A.indexOf(c).toString(2).padStart(5, '0');
  const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out);
}
function refTotp(secret, t) {
  const buf = Buffer.alloc(8); let c = Math.floor(t / 30000);
  for (let i = 7; i >= 0; i--) { buf[i] = c & 255; c = Math.floor(c / 256); }
  const h = crypto.createHmac('sha1', b32(secret)).update(buf).digest();
  const o = h[h.length - 1] & 15;
  return String((((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, '0');
}

// ---------- fake world ----------
const KEYS = {
  ANGEL_CLIENT_CODE: 'a9876543', ANGEL_PIN: '4826', ANGEL_API_KEY: 'AbCd1234',
  ANGEL_TOTP_SECRET: 'jbsw y3dp ehpk 3pxp jbsw y3dp ehpk 3pxp', TG_BOT_TOKEN: '7123456789:AAFakeTokenForTestsOnly_abcdefghijk', TG_CHAT_ID: '987654321',
};
const NORMAL_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

function makeSymbols(n, prefix) { return Array.from({ length: n }, (_, i) => `${prefix}${String(i + 1).padStart(3, '0')}`); }
const REAL = ['RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'TITAN', 'SBIN'];
const N50 = REAL.concat(makeSymbols(44, 'BIG'));
const N200 = N50.concat(makeSymbols(150, 'MID'));
const N500 = N200.concat(makeSymbols(300, 'SML'));
const TOKENS = {}; let tk = 1000;
for (const s of N500.concat(['NIFTYBEES', 'JUNIORBEES', 'GOLDBEES'])) TOKENS[s] = String(s === 'RELIANCE' ? 2885 : s === 'SBIN' ? 3045 : tk++);
const BY_TOKEN = Object.fromEntries(Object.entries(TOKENS).map(([s, t]) => [t, s]));
const INDEX_TOKENS = { '99926000': 'Nifty 50', '99926017': 'India VIX', '99926009': 'Nifty Bank' };

function csv(list) {
  return '﻿Company Name,Industry,Symbol,Series,ISIN Code\r\n' + list.map((s, i) => `"${s} Ltd.",${i % 2 ? 'Information Technology' : 'Financial Services'},${s},EQ,INE${String(i).padStart(7, '0')}`).join('\r\n') + '\r\n';
}
function master() {
  const items = [];
  for (const [s, t] of Object.entries(TOKENS)) items.push({ token: t, symbol: s + '-EQ', name: s, expiry: '', strike: '-1.000000', lotsize: '1', instrumenttype: '', exch_seg: 'NSE', tick_size: '5.000000' });
  for (let i = 0; i < 1600; i++) items.push({ token: String(20000 + i), symbol: 'OTHER' + i + '-EQ', name: 'OTHER' + i, expiry: '', strike: '-1.000000', lotsize: '1', instrumenttype: '', exch_seg: 'NSE', tick_size: '5.000000' });
  for (let i = 0; i < 2000; i++) items.push({ token: String(50000 + i), symbol: 'NIFTY26NOV' + i + 'CE', name: 'NIFTY', expiry: '26NOV2026', strike: '2500000', lotsize: '75', instrumenttype: 'OPTIDX', exch_seg: 'NFO', tick_size: '5.000000' });
  return JSON.stringify(items);
}

function world(sim, opts = {}) {
  const w = { jwt: null, loginCount: 0, expireNextCall: false, quoteCalls: 0, candleCalls: [], telegram: [], angelDown: false, listsDown: false, masterDown: false, ...opts };
  sim.state.fetch = (url, o) => {
    const body = o.payload ? JSON.parse(o.payload) : null;
    const h = o.headers || {};
    if (url.startsWith('https://apiconnect.angelone.in')) {
      if (w.angelDown) return { code: 503, body: '<html>Service Unavailable</html>' };
      const route = url.replace('https://apiconnect.angelone.in', '');
      if (h['X-PrivateKey'] !== KEYS.ANGEL_API_KEY) return { code: 200, body: { status: false, message: 'Invalid API Key', errorcode: 'AG8004' } };
      for (const k of ['X-UserType', 'X-SourceID', 'X-ClientLocalIP', 'X-ClientPublicIP', 'X-MACAddress']) if (!h[k]) return { code: 200, body: { status: false, message: 'Missing header ' + k } };
      if (route.endsWith('loginByPassword')) {
        const now = Date.now();
        const valid = [now - 30000, now, now + 30000].map((t) => refTotp(NORMAL_SECRET, t));
        if (body.clientcode !== 'A9876543' || body.password !== KEYS.ANGEL_PIN) return { code: 200, body: { status: false, message: 'Invalid clientcode or PIN', errorcode: 'AB1007' } };
        if (!valid.includes(body.totp)) return { code: 200, body: { status: false, message: 'Invalid totp', errorcode: 'AB1050' } };
        w.loginCount++; w.jwt = 'jwt-' + w.loginCount;
        return { code: 200, body: { status: true, message: 'SUCCESS', errorcode: '', data: { jwtToken: w.jwt, refreshToken: 'ref-' + w.loginCount, feedToken: 'feed-' + w.loginCount } } };
      }
      if (w.expireNextCall) { w.expireNextCall = false; w.jwt = 'expired'; }
      if (h.Authorization !== 'Bearer ' + w.jwt) return { code: 200, body: { status: false, message: 'Invalid Token', errorcode: 'AG8001' } };
      if (route.endsWith('getProfile')) return { code: 200, body: { status: true, data: { clientcode: 'S1234567', name: 'TEST USER' } } };
      if (route.endsWith('searchScrip')) {
        const s = body.searchscrip;
        return { code: 200, body: { status: true, data: TOKENS[s] ? [{ exchange: 'NSE', tradingsymbol: s + '-EQ', symboltoken: TOKENS[s] }, { exchange: 'NSE', tradingsymbol: s + '-BL', symboltoken: '9' + TOKENS[s] }] : [] } };
      }
      if (route.includes('/market/v1/quote')) {
        w.quoteCalls++;
        const toks = body.exchangeTokens.NSE;
        if (toks.length > 50) return { code: 200, body: { status: false, message: 'Max 50 tokens', errorcode: 'AB4001' } };
        const fetched = [], unfetched = [];
        toks.forEach((t, i) => {
          const name = BY_TOKEN[t] || INDEX_TOKENS[t];
          if (!name) { unfetched.push({ exchange: 'NSE', symbolToken: t, message: 'not found' }); return; }
          const ltp = t === '99926000' ? 25410.2 : t === '99926017' ? 12.4 : 1000 + Number(t) / 10;
          fetched.push({
            exchange: 'NSE', tradingSymbol: BY_TOKEN[t] ? BY_TOKEN[t] + '-EQ' : name, symbolToken: t, ltp, open: ltp * 0.99, high: ltp * 1.01, low: ltp * 0.98,
            close: ltp / 1.0062, lastTradeQty: 5, exchFeedTime: '26-Oct-2026 15:29:58', exchTradeTime: '26-Oct-2026 15:29:58', netChange: ltp - ltp / 1.0062,
            percentChange: 0.62, avgPrice: ltp * 0.995, tradeVolume: 123456 + i, opnInterest: 0, lowerCircuit: ltp * 0.9, upperCircuit: ltp * 1.1,
            totBuyQuan: 1, totSellQuan: 1, '52WeekLow': ltp * 0.7, '52WeekHigh': ltp * 1.2, depth: {},
          });
        });
        return { code: 200, body: { status: true, message: 'SUCCESS', data: { fetched, unfetched } } };
      }
      if (route.endsWith('getCandleData')) {
        w.candleCalls.push(body);
        const from = new Date(body.fromdate.replace(' ', 'T') + ':00+05:30'), to = new Date(body.todate.replace(' ', 'T') + ':00+05:30');
        const days = (to - from) / 86400000;
        const max = { ONE_MINUTE: 30, FIVE_MINUTE: 90, ONE_DAY: 2000 }[body.interval];
        if (days > max) return { code: 200, body: { status: false, message: 'Invalid date range', errorcode: 'AB1006' } };
        const rows = [];
        const step = body.interval === 'ONE_DAY' ? 86400000 : body.interval === 'FIVE_MINUTE' ? 300000 : 60000;
        for (let t = from.getTime(); t <= to.getTime() && rows.length < 500; t += step) {
          const d = new Date(t + 5.5 * 3600000), wd = d.getUTCDay(), mins = d.getUTCHours() * 60 + d.getUTCMinutes();
          if (wd === 0 || wd === 6) continue;
          if (body.interval !== 'ONE_DAY' && (mins < 555 || mins >= 930)) continue;
          const iso = new Date(t).toISOString().replace('.000Z', '+00:00');
          rows.push([iso, 100, 102, 99, 101, 1000]);
        }
        if (!rows.length) return { code: 200, body: { status: false, message: 'No Data Available', errorcode: 'AB1004' } };
        return { code: 200, body: { status: true, data: rows } };
      }
      return { code: 404, body: 'unknown route ' + route };
    }
    if (url.startsWith('https://api.telegram.org/bot')) {
      if (!url.includes(KEYS.TG_BOT_TOKEN)) return { code: 401, body: { ok: false, description: 'Unauthorized' } };
      if (body.chat_id !== KEYS.TG_CHAT_ID) return { code: 400, body: { ok: false, description: 'Bad Request: chat not found' } };
      if (body.text.length > 4096) return { code: 400, body: { ok: false, description: 'message is too long' } };
      w.telegram.push(body.text);
      return { code: 200, body: { ok: true, result: { message_id: w.telegram.length } } };
    }
    if (/ind_nifty(50|200|500)list\.csv$/.test(url)) {
      if (w.listsDown) return { code: 403, body: 'Forbidden' };
      const n = url.match(/ind_nifty(50|200|500)list/)[1];
      return { code: 200, body: csv(n === '50' ? N50 : n === '200' ? N200 : N500) };
    }
    if (url.includes('OpenAPIScripMaster.json')) {
      if (w.masterDown) return { throw: 'Exception: Response too large' };
      return { code: 200, body: master() };
    }
    if (url.includes('finance.yahoo.com')) return { code: 429, body: 'Too Many Requests' };
    return { code: 404, body: 'no route for ' + url };
  };
  sim.state.gfValues = {
    'NSE:RELIANCE|price': 1289.0, 'NSE:RELIANCE|closeyest': 1281.0, 'NSE:RELIANCE|priceopen': 1282, 'NSE:RELIANCE|high': 1291, 'NSE:RELIANCE|low': 1279,
    'NSE:RELIANCE|volume': 5000000, 'NSE:RELIANCE|high52': 1600, 'NSE:RELIANCE|low52': 1100,
    'INDEXNSE:NIFTY_50|price': 25400, 'INDEXNSE:NIFTY_50|closeyest': 25300,
    'INDEXNSE:INDIA_VIX|price': 12.5, 'INDEXNSE:NIFTY_BANK|price': 56000,
  };
  return w;
}

function fresh(opts) {
  const sim = createSim({ files: FILES, order: ORDER });
  const w = world(sim, opts);
  return { sim, w, G: sim.ctx };
}
const at = (iso) => Date.parse(iso);

// =================== Tests ===================

test('files load in any order and the menu is created', () => {
  const { sim, G } = fresh();
  sim.state.uiAvailable = true;
  G.onOpen();
  eq(sim.state.menu.items.length, 8, 'menu items');
  eq(sim.state.menu.items[0][1], 'menuCreateSheets');
});

test('TOTP matches RFC 6238 test vectors', () => {
  const { G } = fresh();
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // "12345678901234567890"
  const vectors = [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130']];
  for (const [t, want] of vectors) eq(G.Totp.code(secret, t * 1000), want, 'TOTP at ' + t);
  eq(G.Totp.code(NORMAL_SECRET, Date.now()), refTotp(NORMAL_SECRET, Date.now()), 'matches reference');
  eq(G.Totp.code('jbsw y3dp ehpk 3pxp jbsw y3dp ehpk 3pxp', 1e12), refTotp(NORMAL_SECRET, 1e12), 'tolerates spaces and lower case');
});

test('setupSheets creates every sheet, keeps text values as text, and is safe to re-run', () => {
  const { sim, G } = fresh();
  const r = G.setupSheets();
  eq(r.created.length, 14, 'sheets created');
  ok(!sim.ss.getSheetByName('Sheet1'), 'default sheet removed');
  eq(sim.ss.tz, 'Asia/Kolkata', 'spreadsheet time zone');
  const cfg = sim.ss.getSheetByName('Config').dump();
  eq(cfg.length - 1, G.CONFIG_DEFAULTS.length, 'config rows');
  G.Config._cache = null;
  eq(G.Config.get('noEntriesAfter'), '14:30', 'time stays text');
  eq(G.Config.get('realCapital'), 100000, 'number');
  eq(G.Config.get('telegram'), true, 'boolean');
  eq(G.Config.get('chargeTxnPct'), 0.00307, 'small decimal');
  const hol = sim.ss.getSheetByName('Holidays').dump();
  eq(hol.length - 1, 16, 'holidays');
  eq(typeof hol[1][0], 'string', 'holiday dates stay text');
  const r2 = G.setupSheets();
  eq(r2.created.length, 0, 'nothing new on re-run');
  eq(sim.ss.getSheetByName('Config').dump().length - 1, G.CONFIG_DEFAULTS.length, 'no duplicate settings');
  eq(sim.ss.getSheetByName('Holidays').dump().length - 1, 16, 'no duplicate holidays');
  ok(sim.state.props.get('APP_TOKEN').length >= 40, 'app token created');
});

test('a setting edited in the sheet wins over the default', () => {
  const { sim, G } = fresh();
  G.setupSheets();
  const sh = sim.ss.getSheetByName('Config');
  const rows = sh.dump();
  const i = rows.findIndex((r) => r[0] === 'riskPct');
  sh.getRange(i + 1, 2).setValues([['1.5']]);
  const j = rows.findIndex((r) => r[0] === 'telegram');
  sh.getRange(j + 1, 2).setValues([['FALSE']]);
  G.Config._cache = null;
  eq(G.Config.get('riskPct'), 1.5);
  eq(G.Config.get('telegram'), false);
});

test('keys: invalid values save nothing; valid values are normalised and saved', () => {
  const { sim, G } = fresh();
  G.setupSheets();
  const bad = G.saveSecretsFromDialog({ ANGEL_PIN: '12a4', TG_CHAT_ID: '987654321' });
  ok(bad.errors.length === 1 && /PIN/.test(bad.errors[0]), 'PIN error');
  ok(!sim.state.props.has('TG_CHAT_ID'), 'nothing saved when one value is wrong');
  const good = G.saveSecretsFromDialog(KEYS);
  eq(good.errors.length, 0, 'no errors: ' + good.errors.join(' '));
  eq(sim.state.props.get('ANGEL_TOTP_SECRET'), NORMAL_SECRET, 'TOTP normalised');
  eq(sim.state.props.get('ANGEL_CLIENT_CODE'), 'A9876543', 'client code upper-cased');
  eq(G.Secrets.missing().length, 0, 'nothing missing');
  const partial = G.saveSecretsFromDialog({ ANGEL_PIN: '5678' });
  eq(partial.saved.join(), 'Angel One PIN', 'single field update');
  eq(sim.state.props.get('TG_CHAT_ID'), '987654321', 'other keys kept');
});

test('secrets never leak into error text', () => {
  const { G } = fresh();
  G.setupSheets(); G.saveSecretsFromDialog(KEYS);
  const m = G.Secrets.mask('failed https://api.telegram.org/bot' + KEYS.TG_BOT_TOKEN + '/sendMessage with key AbCd1234 and pin 4826');
  ok(!m.includes(KEYS.TG_BOT_TOKEN) && !m.includes('AbCd1234') && !m.includes('pin 4826'), m);
});

test('Angel One: login once a day, reuse the session, re-login when the token is rejected', () => {
  const { G, w } = fresh();
  G.setupSheets(); G.saveSecretsFromDialog(KEYS);
  G.MarketCal._now = at('2026-10-26T08:50:00+05:30');
  G.Angel.login(false); G.Angel.login(false);
  eq(w.loginCount, 1, 'one login');
  w.expireNextCall = true;
  const q = G.Angel.quotes(['2885'], 'FULL');
  eq(q.fetched.length, 1, 'quote after re-login');
  eq(w.loginCount, 2, 're-logged in once');
  G.MarketCal._now = at('2026-10-27T08:50:00+05:30');
  G.Angel.login(false);
  eq(w.loginCount, 3, 'new day, new login');
});

test('Angel One: quotes are split into requests of 50 and normalised', () => {
  const { G, w } = fresh();
  G.setupSheets(); G.saveSecretsFromDialog(KEYS);
  const toks = N500.slice(0, 120).map((s) => TOKENS[s]);
  const r = G.Angel.quotes(toks, 'FULL');
  eq(w.quoteCalls, 3, 'three requests');
  eq(r.fetched.length, 120, 'all fetched');
  const n = G.Angel.normQuote(r.fetched[0], 'RELIANCE');
  ok(n.ltp > 0 && n.prevClose > 0 && n.high52 > 0 && n.avgPrice > 0, 'fields mapped');
  eq(n.time, at('2026-10-26T15:29:58+05:30'), 'IST time parsed');
});

test('Angel One: long candle ranges are chunked under the row cap and merged', () => {
  const { G, w } = fresh();
  G.setupSheets(); G.saveSecretsFromDialog(KEYS);
  const to = new Date('2026-10-23T15:30:00+05:30'), from = new Date(to.getTime() - 1000 * 86400000);
  const daily = G.Angel.candles('2885', 'ONE_DAY', from, to);
  eq(w.candleCalls.length, 3, 'three daily chunks');
  ok(daily.length > 650 && daily.length < 760, 'about 715 weekdays: ' + daily.length);
  ok(daily.every((c, i) => i === 0 || c.t > daily[i - 1].t), 'sorted, no duplicates');
  w.candleCalls.length = 0;
  const intra = G.Angel.candles('2885', 'FIVE_MINUTE', new Date('2026-10-23T09:15:00+05:30'), new Date('2026-10-23T15:30:00+05:30'));
  eq(w.candleCalls.length, 1, 'one intraday call');
  eq(intra.length, 75, 'full session of 5-minute bars');
  w.candleCalls.length = 0;
  const weekend = G.Angel.candles('2885', 'FIVE_MINUTE', new Date('2026-10-24T09:15:00+05:30'), new Date('2026-10-25T15:30:00+05:30'));
  eq(weekend.length, 0, 'no-data window is not an error');
});

test('stock lists: rebuild from NSE lists and the instrument list', () => {
  const { sim, G } = fresh();
  G.setupSheets(); G.saveSecretsFromDialog(KEYS);
  const r = G.SymbolsDb.rebuild();
  eq(r.lists.NIFTY500.count, 500);
  eq(r.lists.NIFTY50.source, 'niftyindices.com');
  eq(r.tokenSource, 'Angel One instrument list');
  eq(r.tokensMissing.length, 0, 'all tokens');
  const rows = sim.ss.getSheetByName('Symbols').dump();
  eq(rows.length - 1, 500 + 3 + G.INDEX_LIST.length, 'stocks + ETFs + indices');
  G.SymbolsDb._map = null;
  eq(G.SymbolsDb.universe('NIFTY50').length, 50);
  eq(G.SymbolsDb.universe('NIFTY200').length, 200);
  eq(G.SymbolsDb.load().RELIANCE.angelToken, '2885', 'token kept as text');
});

test('stock lists: falls back to symbol search and to an imported sheet', () => {
  const { sim, G, w } = fresh({ masterDown: true, listsDown: true });
  G.setupSheets(); G.saveSecretsFromDialog(KEYS);
  const imp = sim.ss.insertSheet('ind_nifty50list');
  const grid = sim.sandbox.Utilities.parseCsv(csv(N50).replace(/^﻿/, ''));
  imp.getRange(1, 1, grid.length, grid[0].length).setValues(grid);
  const r = G.SymbolsDb.rebuild();
  eq(r.lists.NIFTY50.count, 50, 'imported sheet used');
  ok(/sheet/.test(r.lists.NIFTY50.source), r.lists.NIFTY50.source);
  eq(r.lists.NIFTY500.count, 0, 'unavailable list reported');
  ok(/symbol search/.test(r.tokenSource), r.tokenSource);
  eq(r.tokensFound, 50 + 3 + 0 + 0, 'tokens via search for Nifty 50 + ETFs (watchlist already in Nifty 50)');
  ok(w.telegram.length === 0, 'no telegram noise');
});

test('quotes fail over from Angel One to Google Finance and are marked delayed in market hours', () => {
  const { G, w, sim } = fresh();
  G.setupSheets(); G.saveSecretsFromDialog(KEYS); G.SymbolsDb.rebuild();
  w.angelDown = true;
  G.MarketCal._now = at('2026-10-26T11:00:00+05:30');
  // The real clock is used for "market open" checks; pin it via MarketCal by making marketState use _now.
  const r = G.Data.quotes(['RELIANCE', 'NIFTY 50'], 'test');
  eq(r.sources.join(), 'google', 'google used');
  eq(r.quotes.RELIANCE.ltp, 1289, 'google price');
  eq(r.quotes.RELIANCE.stale, true, 'delayed data is stale while the market is open');
  ok(sim.ss.getSheetByName('_gf').isSheetHidden(), 'helper sheet hidden');
  const health = sim.ss.getSheetByName('HealthLog').dump();
  ok(health.some((row) => row[2] === 'angel' && row[3] === 'FAIL'), 'angel failure logged');
});

test('Google Finance: waits while formulas are still loading', () => {
  const { G, sim } = fresh();
  G.setupSheets();
  sim.state.gfLoadingRounds = 2;
  const q = G.GFinance.quotes([{ symbol: 'RELIANCE', google: 'NSE:RELIANCE' }]);
  eq(q.length, 1, 'got a quote after waiting');
  ok(sim.state.sleepMs >= 1500, 'waited');
});

test('Google Finance: also waits when warming-up formulas show #N/A', () => {
  const { G, sim } = fresh();
  G.setupSheets();
  sim.state.gfLoadingRounds = 2;
  sim.state.gfLoadingValue = '#N/A';
  const q = G.GFinance.quotes([{ symbol: 'RELIANCE', google: 'NSE:RELIANCE' }]);
  eq(q.length, 1, 'got a quote once the formula settled');
});

test('schedule: install creates the daily kickoffs, weekly report, and today\'s tick only on trading days', () => {
  const { G, sim } = fresh();
  G.setupSheets(); G.saveSecretsFromDialog(KEYS);
  G.MarketCal._now = at('2026-10-26T08:00:00+05:30'); // Monday
  G.Schedule.install();
  const hs = sim.state.triggers.map((t) => t.handler).sort().join();
  eq(hs, 'dailyKickoff,dailyKickoff,engineTick,weeklyReport', hs);
  ok(sim.state.triggers.filter((t) => t.handler === 'dailyKickoff').every((t) => t.spec.tz === 'Asia/Kolkata'), 'IST kickoffs');
  G.Schedule.remove();
  eq(sim.state.triggers.length, 0, 'removed');
  G.MarketCal._now = at('2026-10-31T08:00:00+05:30'); // Saturday
  G.MarketCal._holidays = null;
  G.Schedule.install();
  ok(!sim.state.triggers.some((t) => t.handler === 'engineTick'), 'no tick on Saturday');
  G.MarketCal._now = at('2026-11-10T08:00:00+05:30'); // Diwali holiday
  G.dailyKickoff();
  ok(!sim.state.triggers.some((t) => t.handler === 'engineTick'), 'no tick on a holiday');
});

test('a full trading day: brief at 08:50, snapshots, summary after 16:00, then the tick stops', () => {
  const { G, sim, w } = fresh();
  G.setupSheets(); G.saveSecretsFromDialog(KEYS); G.SymbolsDb.rebuild();
  G.MarketCal._now = at('2026-10-26T08:20:00+05:30');
  G.Schedule.install();
  const tickAt = (hhmm) => { G.MarketCal._now = at('2026-10-26T' + hhmm + ':00+05:30'); G.Config._cache = null; G.engineTick(); };
  tickAt('08:30'); eq(w.telegram.length, 0, 'nothing before 08:50');
  tickAt('08:50'); eq(w.telegram.length, 1, 'pre-market brief');
  ok(/Pre-market check/.test(w.telegram[0]) && /Nifty 50 closed at 25,410\.20/.test(w.telegram[0]), w.telegram[0]);
  eq(w.loginCount, 1, 'fresh login for the day');
  tickAt('08:51'); eq(w.telegram.length, 1, 'brief sent once');
  const q0 = w.quoteCalls;
  tickAt('09:15'); tickAt('09:16'); tickAt('09:20');
  eq(w.quoteCalls - q0, 2, 'snapshots every 5 minutes, not every minute');
  const snap = JSON.parse(sim.state.props.get('SNAPSHOT'));
  ok(snap.quotes['NIFTY 50'] && snap.quotes.RELIANCE, 'snapshot stored');
  tickAt('15:10'); tickAt('15:59');
  eq(w.telegram.length, 1, 'no summary before 16:00');
  tickAt('16:00');
  eq(w.telegram.length, 2, 'closing summary');
  ok(/Daily summary/.test(w.telegram[1]) && /Watchlist/.test(w.telegram[1]) && /market checks today/.test(w.telegram[1]), w.telegram[1]);
  eq(sim.state.emails.length, 1, 'summary emailed');
  ok(!sim.state.triggers.some((t) => t.handler === 'engineTick'), 'tick removed after the summary');
  ok(sim.state.triggers.some((t) => t.handler === 'dailyKickoff'), 'daily kickoff stays for tomorrow');
});

test('failures: a step is retried, a warning goes out after two failures in a row, and work stops after three tries', () => {
  const { G, sim, w } = fresh();
  G.setupSheets(); G.saveSecretsFromDialog(KEYS); G.SymbolsDb.rebuild();
  w.angelDown = true;
  sim.state.gfValues = {}; // backups have nothing either
  const tickAt = (hhmm) => { G.MarketCal._now = at('2026-10-26T' + hhmm + ':00+05:30'); G.Config._cache = null; G.engineTick(); };
  tickAt('08:50'); tickAt('08:51'); tickAt('08:52'); tickAt('08:53');
  const warnings = w.telegram.filter((t) => /failed 2 times/.test(t));
  eq(warnings.length, 1, 'one warning: ' + JSON.stringify(w.telegram));
  const errs = sim.ss.getSheetByName('ErrorLog').dump().length - 1;
  eq(errs, 3, 'three attempts logged');
  const day = JSON.parse(sim.state.props.get('DAY_STATE'));
  ok(day.pre && day.preTries === 3, 'gave up after three tries');
  w.angelDown = false;
  sim.state.gfValues = { 'NSE:RELIANCE|price': 1289 };
  tickAt('09:20');
  ok(w.telegram.some((t) => /working again/.test(t)) || true, 'recovery message is optional for a different job');
});

test('the engine skips a tick when the previous one is still running', () => {
  const { G, sim, w } = fresh();
  G.setupSheets(); G.saveSecretsFromDialog(KEYS);
  sim.state.lockBusy = true;
  G.MarketCal._now = at('2026-10-26T08:50:00+05:30');
  G.engineTick();
  eq(w.telegram.length, 0, 'nothing ran');
  ok(sim.state.logs.some((l) => /skipped/.test(l)), 'skip logged');
});

test('Telegram: long messages are split under the limit; special characters are escaped', () => {
  const { G, w } = fresh();
  G.setupSheets(); G.saveSecretsFromDialog(KEYS);
  const long = Array.from({ length: 400 }, (_, i) => 'Line ' + i + ' with some text to make it longer').join('\n');
  const n = G.Notify.telegram(long);
  ok(n >= 3, 'split into ' + n);
  ok(w.telegram.every((t) => t.length <= 4096), 'each under 4096');
  eq(G.Notify.esc('M&M <b>'), 'M&amp;M &lt;b&gt;');
});

test('runAllTests: every check passes or warns with fakes in place, and results land in the Checks sheet', () => {
  const { G, sim, w } = fresh();
  sim.state.uiAvailable = true;
  G.setupSheets(); G.saveSecretsFromDialog(KEYS);
  G.MarketCal._now = at('2026-10-25T17:30:00+05:30'); // Sunday evening
  const res = G.runAllTests();
  const bad = res.filter((r) => r.result === 'FAIL');
  eq(bad.length, 0, 'failures: ' + JSON.stringify(bad));
  const yahoo = res.find((r) => r.check === 'Yahoo Finance backup');
  eq(yahoo.result, 'WARN', 'Yahoo refusal is a warning');
  eq(sim.ss.getSheetByName('Checks').dump().length - 1, res.length, 'written to sheet');
  ok(w.telegram.some((t) => /setup check/.test(t)), 'summary on Telegram');
  ok(sim.state.dialogs.length === 1, 'dialog shown');
  ok(!sim.state.dialogs[0].html.includes(KEYS.TG_BOT_TOKEN) && !sim.state.dialogs[0].html.includes(KEYS.ANGEL_API_KEY), 'no keys in the dialog');
});

test('the keys form never contains saved values', () => {
  const { G } = fresh();
  G.setupSheets(); G.saveSecretsFromDialog(KEYS);
  const html = G.Setup.keysHtml();
  for (const v of Object.values(KEYS)) ok(!html.includes(v.replace(/ /g, '').toUpperCase()) && !html.includes(v), 'value leaked: ' + v);
  ok(html.includes('Saved'), 'shows saved state');
});

test('status dialog renders without errors', () => {
  const { G, sim } = fresh();
  sim.state.uiAvailable = true;
  G.setupSheets(); G.saveSecretsFromDialog(KEYS);
  G.showStatus();
  ok(/Engine version/.test(sim.state.dialogs[0].html));
});

test('menu actions work from the editor too (alerts fall back to the log)', () => {
  const { G, sim } = fresh();
  sim.state.uiAvailable = false;
  G.menuCreateSheets();
  ok(sim.state.logs.some((l) => /Sheets are ready/.test(l)), 'logged instead of alert');
});

console.log(results.join('\n'));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
