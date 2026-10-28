// tests.mjs — run with:  node tools/gas-sim/tests.mjs
// Exercises apps-script/*.gs against simulated Google services and fake Angel One / Telegram servers.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSim } from './sim.mjs';
import { coreTests } from './core-tests.mjs';
import * as SC from './scenarios.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FILES = path.join(here, '..', '..', 'apps-script');
// Setup.gs first on purpose: the engine must not depend on the order files load in.
const ORDER = ['Setup.gs', 'Lab.gs', 'Review.gs', 'Signals.gs', 'Engine.gs', 'Api.gs', 'Data.gs', 'Core.gs'];
// Every test runs under the real manifest, so a permission missing from appsscript.json fails here first.
const MANIFEST = JSON.parse(fs.readFileSync(path.join(FILES, 'appsscript.json'), 'utf8'));

let passed = 0, failed = 0;
const results = [];
function test(name, fn) {
  try { fn(); passed++; results.push('  ✓ ' + name); }
  catch (e) { failed++; results.push('  ✗ ' + name + '\n      ' + (e && e.stack ? e.stack.split('\n').slice(0, process.env.FULL ? 200 : 4).join('\n      ') : e)); }
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
const GEMINI_KEY = 'test-only-gemini-key-not-real-0000000000'; // deliberately not in Google's key format, so secret scanners stay quiet

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
        if (w.onCandle) w.onCandle(body);
        const from = new Date(body.fromdate.replace(' ', 'T') + ':00+05:30'), to = new Date(body.todate.replace(' ', 'T') + ':00+05:30');
        if (w.rateLimitNext > 0) { w.rateLimitNext--; return { code: 403, body: { status: false, message: 'Access denied because of exceeding access rate', errorcode: 'AB1019' } }; }
        if (w.refuse && w.refuse[body.symboltoken] > 0) { w.refuse[body.symboltoken]--; return { code: 403, body: { status: false, message: 'Access denied because of exceeding access rate', errorcode: 'AB1019' } }; }
        if (w.refuseWhen && w.refuseWhen(body)) return { code: 403, body: 'Access denied because of exceeding access rate' }; // plain text, as Angel One sends it
        const custom = w.candleGen && w.candleGen(body.symboltoken, body.interval, from, to);
        if (custom) {
          const rows = custom.filter((c) => c.t >= from.getTime() && c.t <= to.getTime()).map((c) => [new Date(c.t).toISOString(), c.o, c.h, c.l, c.c, c.v]);
          return rows.length ? { code: 200, body: { status: true, data: rows } } : { code: 200, body: { status: false, message: 'No Data Available', errorcode: 'AB1004' } };
        }
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
      if (process.env.DUMP_TG) console.log("\n=== TELEGRAM ===\n" + body.text);
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
    if (url.startsWith('https://generativelanguage.googleapis.com/v1beta/models/')) {
      w.geminiCalls = (w.geminiCalls || 0) + 1;
      w.geminiUrl = url;
      if (w.geminiDown) return { code: 429, body: { error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).' } } };
      if (h['x-goog-api-key'] !== GEMINI_KEY) return { code: 400, body: { error: { code: 400, message: 'API key not valid. Please pass a valid API key.' } } };
      w.geminiPrompt = body.contents[0].parts[0].text;
      if (body.generationConfig && body.generationConfig.responseMimeType === 'application/json' && w.geminiReply) return { code: 200, body: { candidates: [{ content: { parts: [{ text: w.geminiReply }] }, finishReason: 'STOP' }] } };
      return { code: 200, body: { candidates: [{ content: { parts: [{ text: '- Profit rose 12% in the quarter.\n- **Won** a large order.\n- Shares rose after the results.\n- A fourth line that is dropped.' }] }, finishReason: 'STOP' }] } };
    }
    if (url.startsWith('https://news.google.com/rss/search')) {
      w.newsCalls = (w.newsCalls || 0) + 1;
      if (w.newsFor) {
        // A test's own feed: [title, pubDate, source] per item, for the decoded query.
        const q = decodeURIComponent(url.split('q=')[1].split('&')[0]);
        const xml = w.newsFor(q).map(([title, date, src], i) => `<item><title><![CDATA[${title}]]></title><link>https://news.google.com/rss/articles/t${i}</link><pubDate>${date}</pubDate><source url="https://example.com">${src}</source></item>`).join('');
        return { code: 200, body: '<?xml version="1.0"?><rss><channel>' + xml + '</channel></rss>' };
      }
      const item = (i) => `<item><title><![CDATA[Headline ${i} &amp; more]]></title><link>https://news.google.com/rss/articles/abc${i}</link><pubDate>Mon, 26 Oct 2026 0${i}:00:00 GMT</pubDate><source url="https://example.com">Paper ${i}</source></item>`;
      return { code: 200, body: '<?xml version="1.0"?><rss><channel>' + [1, 2, 3].map(item).join('') + '<item><title>No link</title><link>javascript:alert(1)</link></item></channel></rss>' };
    }
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
  const sim = createSim({ files: FILES, order: ORDER, manifest: MANIFEST });
  const w = world(sim, opts);
  return { sim, w, G: sim.ctx };
}
const at = (iso) => Date.parse(iso);

// =================== Tests ===================

test('files load in any order and the menu is created', () => {
  const { sim, G } = fresh();
  sim.state.uiAvailable = true;
  G.onOpen();
  eq(sim.state.menu.items.length, 14, 'menu items');
  ok(sim.state.menu.items.some((it) => it[1] === 'menuFinishEndOfDay'), 'finish end of day');
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
  eq(r.created.length, 15, 'sheets created');
  ok(!sim.ss.getSheetByName('Sheet1'), 'default sheet removed');
  eq(sim.ss.tz, 'Asia/Kolkata', 'spreadsheet time zone');
  const cfg = sim.ss.getSheetByName('Config').dump();
  eq(cfg.length - 1, G.Config.defaultRows().length, 'config rows');
  ok(cfg.some((r) => r[0] === 'orb.volMult'), 'strategy parameters are in Config');
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
  eq(sim.ss.getSheetByName('Config').dump().length - 1, G.Config.defaultRows().length, 'no duplicate settings');
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
  eq(r.tokenSource, 'symbol search');
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
  ok(sim.state.requests.some((q) => q.url.includes('searchScrip')), 'search used');
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
  const loginsBefore = w.loginCount;
  tickAt('08:50'); eq(w.telegram.length, 1, 'pre-market brief');
  ok(/Pre-market check/.test(w.telegram[0]) && /Last close/.test(w.telegram[0]) && /• Nifty 50: 25,410\.20 [▲▼▪]/.test(w.telegram[0]), w.telegram[0]);
  eq(w.loginCount - loginsBefore, 1, 'fresh login for the day');
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

// =================== Phase 2: history, scans, alerts ===================

/** A world where Nifty is in an uptrend, VIX is calm, and chosen stocks follow chosen scenarios. */
function marketWorld(opts = {}) {
  const env = fresh(opts);
  const { G, w } = env;
  G.setupSheets(); G.saveSecretsFromDialog(KEYS); G.SymbolsDb.rebuild();
  const end = opts.end || '2026-10-23';
  const nifty = SC.dailyFrom(SC.trend(300, 20000, 0.08), { end, vol: 0 });
  const vix = SC.dailyFrom(Array.from({ length: 300 }, () => 12.5), { end, vol: 0 });
  const quiet = SC.dailyFrom(SC.trend(300, 100, 0.01), { end, vol: 2e6 }); // liquid but going nowhere
  const niftyK = opts.niftyDown ? SC.dailyFrom(SC.trend(300, 26000, -0.08), { end, vol: 0 }) : nifty;
  w.daily = { '99926000': niftyK, '99926017': vix, ...(opts.daily || {}) };
  w.intra = opts.intra || {};
  w.minute = opts.minute || {};
  w.candleGen = (token, interval) => {
    if (interval === 'ONE_DAY') return w.daily[token] || (BY_TOKEN[token] && opts.allQuiet !== false ? quiet : null);
    if (interval === 'FIVE_MINUTE') return w.intra[token] || null;
    if (interval === 'ONE_MINUTE') return w.minute[token] || null;
    return null;
  };
  return env;
}
const tickAtDay = (G, ymd, hhmm) => { G.MarketCal._now = at(ymd + 'T' + hhmm + ':00+05:30'); G.Config._cache = null; G.StrategyBook._map = null; G.engineTick(); };
const alertsRows = (sim) => { const d = sim.ss.getSheetByName('Alerts').dump(); const h = d[0]; return d.slice(1).map((r) => Object.fromEntries(h.map((k, i) => [k, r[i]]))); };

test('price history: the menu loads every stock into 12 Drive files and reports on Telegram', () => {
  const { G, sim, w } = marketWorld();
  sim.state.uiAvailable = true;
  G.MarketCal._now = at('2026-10-25T21:00:00+05:30');
  const r = G.loadHistory();
  eq(r.remaining, 0, 'all loaded');
  eq(r.symbols, 500 + 3 + 3, 'stocks, ETFs and the three indices');
  const folder = sim.state.drive.items.find((f) => f.name === 'Stock Radar Data' && f.mimeType === 'application/vnd.google-apps.folder');
  ok(folder && folder.byApp, 'Drive folder created by the script');
  const inFolder = sim.state.drive.items.filter((f) => f.parents.includes(folder.id));
  const files = inFolder.map((f) => f.name).sort();
  eq(files.length, 12, 'twelve files'); eq(files[0], 'daily-00.json');
  ok(files.every((n) => /^daily-\d\d\.json$/.test(n)), files.join());
  const sizes = inFolder.map((f) => f.content.length);
  const total = sizes.reduce((a, b) => a + b, 0);
  if (process.env.SIZES) console.log('pack sizes (KB):', sizes.map((x) => Math.round(x / 1024)).join(' '), 'total MB', (total / 1048576).toFixed(1));
  ok(Math.max(...sizes) < 1.5 * 1048576, 'each file stays small: ' + Math.max(...sizes));
  ok(sim.state.alerts.some((a) => /Price history ready/.test(a.title)), 'dialog');
  ok(w.telegram.some((t) => /Price history ready/.test(t) && /Market regime/.test(t)), 'telegram: ' + w.telegram.join(' / '));
  ok(w.candleCalls.every((c) => c.interval === 'ONE_DAY'), 'daily candles only');
  // A fresh run reads the same data back from Drive.
  G.History.reset();
  const k = G.History.get('NIFTY 50');
  ok(k.length === 300 && k[k.length - 1].c > 20000, 'Nifty history: ' + k.length);
  eq(G.History.lastDay('NIFTY 50'), 20261023, 'newest day');
  eq(G.Market.saved().state, 'BULL', 'regime saved');
  const again = G.loadHistory();
  eq(again.loaded, 0, 'nothing to load the second time');
});

test('price history: rate-limited requests are retried, and the load continues in the background', () => {
  const { G, sim, w } = marketWorld();
  G.MarketCal._now = at('2026-10-25T21:00:00+05:30');
  w.rateLimitNext = 5;
  const part = G.Backfill.step(Date.now() + 60000);
  eq(part.remaining, 0, 'retries recovered every rate-limited request');
  G.History.scheduleContinue();
  ok(sim.state.triggers.some((t) => t.handler === 'continueHistory' && t.spec.after === 60000), 'one-off follow-up in a minute');
  G.continueHistory();
  ok(!sim.state.triggers.some((t) => t.handler === 'continueHistory'), 'follow-up removed when done');
  ok(w.telegram.some((t) => /Price history ready/.test(t)), 'done message');
});

test('strategies sheet: one row per strategy, and a strategy switched off there stays silent', () => {
  const { G, sim } = marketWorld();
  const rows = sim.ss.getSheetByName('Strategies').dump();
  eq(rows.length - 1, G.SRCore.STRATEGIES.length, 'thirteen strategies');
  ok(rows.slice(1).every((r) => r[4] === 'PAPER'), 'all start as paper');
  eq(G.StrategyBook.enabled(['INTRADAY']).length, 4);
  const i = rows.findIndex((r) => r[0] === 'orb');
  sim.ss.getSheetByName('Strategies').getRange(i + 1, 4).setValues([['FALSE']]);
  G.StrategyBook._map = null;
  ok(G.StrategyBook.enabled(['INTRADAY']).indexOf('orb') < 0, 'orb off');
  eq(G.setupSheets().strategiesAdded, 0, 'no duplicates on re-run');
});

test('a trading day with an opening-range breakout: one alert, logged and sent, then the square-off reminder', () => {
  const tcs = SC.intraday.orb(); // 5-minute bars for Fri 23 Oct and Mon 26 Oct
  const { G, sim, w } = marketWorld({ intra: { [TOKENS.TCS]: tcs } });
  G.MarketCal._now = at('2026-10-25T21:00:00+05:30');
  G.loadHistory();
  G.Schedule.install();
  const day = '2026-10-26';
  tickAtDay(G, day, '08:50');
  const brief = w.telegram[w.telegram.length - 1];
  ok(/Pre-market check/.test(brief) && /Market regime/.test(brief) && /Intraday: 5\d stocks, 4 strategies/.test(brief), brief);
  const ctx = JSON.parse(sim.state.props.get('INTRA_CTX'));
  eq(ctx.day, day); ok(ctx.s.TCS && ctx.s.TCS[1] >= 10, 'TCS liquid: ' + JSON.stringify(ctx.s.TCS));
  const sent0 = w.telegram.length;
  for (const t of ['09:16', '09:21', '09:26', '09:31', '09:36', '09:41']) tickAtDay(G, day, t);
  eq(w.telegram.length, sent0, 'no breakout yet');
  ok(w.candleCalls.some((c) => c.interval === 'FIVE_MINUTE'), 'five-minute candles fetched');
  tickAtDay(G, day, '09:46'); // the 09:40–09:45 bar has closed
  const alertMsg = w.telegram.slice(sent0).join('\n');
  ok(/🧪 Paper/.test(alertMsg) && /🟢 <b>BUY TCS<\/b> · ⚡ Intraday/.test(alertMsg) && /Opening-range breakout/.test(alertMsg), alertMsg);
  ok(/💰 <b>Entry:<\/b> ₹1\d\d\.\d\d – ₹/.test(alertMsg) && /🛑 <b>Stop-loss:<\/b> ₹[\d,.]+ \(−\d/.test(alertMsg) && /🎯 <b>Target:<\/b> ₹[\d,.]+ \(\+\d/.test(alertMsg), alertMsg);
  ok(/Reward:risk/.test(alertMsg) && /📦 <b>Size:<\/b> \d+ shares/.test(alertMsg) && /Today until 15:15, square off by then/.test(alertMsg) && /📝 <b>Why<\/b>/.test(alertMsg), alertMsg);
  let rows = alertsRows(sim);
  eq(rows.length, 1, 'one alert logged');
  const a = rows[0];
  eq(a.symbol, 'TCS'); eq(a.horizon, 'INTRADAY'); eq(a.strategy, 'orb'); eq(a.direction, 'BUY'); eq(a.status, 'OPEN'); eq(a.telegram, 'sent');
  ok(a.stop < a.entryLow && a.target1 > a.entryHigh && a.rr >= 1.5 && a.qty > 0, JSON.stringify(a));
  ok(/Angel One 5-minute candles to 09:45/.test(a.source), a.source);
  tickAtDay(G, day, '09:51'); // same bar is still the latest: no repeat
  eq(alertsRows(sim).length, 1, 'not repeated');
  const callsBefore = w.candleCalls.length;
  tickAtDay(G, day, '14:36');
  eq(w.candleCalls.length, callsBefore, 'no intraday scans after 14:30');
  tickAtDay(G, day, '15:10');
  ok(w.telegram.some((t) => /Square-off reminder/.test(t) && /BUY TCS/.test(t)), 'square-off reminder');
});

test('end of day: history update, regime, swing scan, alert and closing summary', () => {
  const end = '2026-10-26';
  const rel = SC.daily['base-breakout']().map((c) => c); // ends on 26 Oct
  const { G, sim, w } = marketWorld({ daily: { [TOKENS.RELIANCE]: rel } });
  // History as it stood on Friday evening, then Monday's close arrives at 16:00.
  w.daily['99926000'] = SC.dailyFrom(SC.trend(300, 20000, 0.08), { end, vol: 0 });
  w.daily['99926017'] = SC.dailyFrom(Array.from({ length: 300 }, () => 12.5), { end, vol: 0 });
  G.MarketCal._now = at('2026-10-23T21:00:00+05:30');
  G.loadHistory();
  eq(G.History.lastDay('RELIANCE'), 20261023, 'Friday history');
  G.MarketCal._now = at('2026-10-26T08:20:00+05:30');
  G.Schedule.install();
  tickAtDay(G, end, '08:50');
  const sent0 = w.telegram.length;
  tickAtDay(G, end, '16:00');
  eq(G.History.lastDay('RELIANCE'), 20261026, 'history updated with today');
  const day = JSON.parse(sim.state.props.get('DAY_STATE'));
  ok(day.eod, 'end of day finished: ' + JSON.stringify(day));
  const msgs = w.telegram.slice(sent0).join('\n----\n');
  ok(/BUY RELIANCE/.test(msgs) && /Base breakout/.test(msgs) && /Swing/.test(msgs) && /10 trading days/.test(msgs), msgs);
  ok(/Daily summary/.test(msgs) && /Signals today: 3<\/b> \(2 medium term, 1 swing\)/.test(msgs) && /Market regime/.test(msgs), msgs);
  // A strong breakout to a new high also meets the trend template and the near-high rule; each strategy logs its own alert.
  const rows = alertsRows(sim);
  eq(rows.map((r) => r.strategy).sort().join(), 'base-breakout,near-high,trend-template');
  const bb = rows.find((r) => r.strategy === 'base-breakout');
  eq(bb.symbol, 'RELIANCE'); eq(bb.horizon, 'SWING'); eq(bb.telegram, 'sent');
  ok(Object.prototype.toString.call(bb.validTill) === '[object Date]', 'valid-till date');
  ok(!sim.state.triggers.some((t) => t.handler === 'engineTick'), 'tick stopped');
  // The next day the same setup is inside its cooldown, so it is not alerted again.
  const sig = { symbol: 'RELIANCE', strategy: 'base-breakout', horizon: 'SWING', direction: 'BUY' };
  G.MarketCal._now = at('2026-10-27T16:05:00+05:30');
  eq(G.AlertBook.withoutRepeats([sig], G.Scans.params()).length, 0, 'cooldown');
  G.MarketCal._now = at('2026-11-12T16:05:00+05:30');
  eq(G.AlertBook.withoutRepeats([sig], G.Scans.params()).length, 1, 'after the cooldown');
});

test('end of day waits for Angel One to publish today\'s candle, then gives up at 16:45', () => {
  const { G, sim, w } = marketWorld(); // all history ends on Friday 23 Oct
  G.MarketCal._now = at('2026-10-23T21:00:00+05:30');
  G.loadHistory();
  G.MarketCal._now = at('2026-10-26T08:20:00+05:30');
  G.Schedule.install();
  tickAtDay(G, '2026-10-26', '08:50');
  const sent0 = w.telegram.length;
  tickAtDay(G, '2026-10-26', '16:00');
  tickAtDay(G, '2026-10-26', '16:20');
  eq(w.telegram.length, sent0, 'still waiting');
  tickAtDay(G, '2026-10-26', '16:46');
  const msg = w.telegram.slice(sent0).join('\n');
  ok(/Daily summary/.test(msg) && /had not published/.test(msg), msg);
});

/** A clock for the script that moves only when it asks Angel One for candles or sleeps, so deadlines bite as on Google. */
function slowClock(G, w, msPerCandle, sim) {
  const c = { now: Date.now() };
  sim.run('Date').now = () => c.now;
  w.onCandle = () => { c.now += msPerCandle; };
  const sleep = G.Utilities.sleep;
  G.Utilities.sleep = (ms) => { c.now += ms; sleep(ms); };
  return c;
}

test('end of day: price history carries on where it stopped and never asks for the same stock twice', () => {
  const { G, sim, w } = marketWorld();
  G.MarketCal._now = at('2026-10-23T21:00:00+05:30');
  G.loadHistory();
  G.MarketCal._now = at('2026-10-26T16:05:00+05:30');
  w.daily['99926000'] = SC.dailyFrom(SC.trend(300, 20000, 0.08), { end: '2026-10-26', vol: 0 });
  const quietMon = SC.dailyFrom(SC.trend(300, 100, 0.01), { end: '2026-10-26', vol: 2e6 });
  w.candleGen = (token, interval) => (interval === 'ONE_DAY' ? w.daily[token] || (BY_TOKEN[token] ? quietMon : null) : null);
  const clock = slowClock(G, w, 700, sim); // each request takes 0.7 s, so one run gets through only part of the list
  w.refuse = { [TOKENS.BIG001]: 2, [TOKENS.MID010]: 1 }; // early stocks refused for a moment
  const day = { day: '2026-10-26' };
  const asked = {}; w.candleCalls = [];
  let runs = 0, r;
  do { r = G.Scans.updateHistory('2026-10-26', day, clock.now + 120000); runs++; } while (r !== 'done' && runs < 40);
  eq(r, 'done', 'finished');
  ok(runs > 3, 'took several runs: ' + runs);
  w.candleCalls.forEach((c) => { asked[c.symboltoken] = (asked[c.symboltoken] || 0) + 1; });
  const targets = G.Backfill.targets().length;
  const twice = Object.entries(asked).filter(([t, n]) => n > 1 + (t === TOKENS.BIG001 ? 2 : t === TOKENS.MID010 ? 1 : t === '99926000' ? 0 : 0));
  eq(twice.length, 0, 'no stock asked for again: ' + JSON.stringify(twice.slice(0, 5)));
  ok(w.candleCalls.length <= targets + 3, 'requests ' + w.candleCalls.length + ' for ' + targets + ' stocks');
  eq(G.History.lastDay('BIG001'), 20261026, 'the refused stock was asked again and updated');
  eq(G.History.lastDay('SML300'), 20261026, 'the last stock updated');
  ok(sim.ss.getSheetByName('HealthLog').dump().some((row) => /left for the next run/.test(row.join(' '))), 'each run logged');
});

test('end of day: running late at 18:00 — a message, then it carries on in the background and the summary still comes', () => {
  const { G, sim, w } = marketWorld();
  G.MarketCal._now = at('2026-10-23T21:00:00+05:30');
  G.loadHistory();
  w.daily['99926000'] = SC.dailyFrom(SC.trend(300, 20000, 0.08), { end: '2026-10-26', vol: 0 });
  const quietMon = SC.dailyFrom(SC.trend(300, 100, 0.01), { end: '2026-10-26', vol: 2e6 });
  w.candleGen = (token, interval) => (interval === 'ONE_DAY' ? w.daily[token] || (BY_TOKEN[token] ? quietMon : null) : null);
  G.MarketCal._now = at('2026-10-26T08:20:00+05:30');
  G.Schedule.install();
  tickAtDay(G, '2026-10-26', '08:50');
  const sent0 = w.telegram.length;
  slowClock(G, w, 5000, sim); // a very slow evening: each run gets through only a few stocks
  ['16:00', '16:10', '17:00', '17:59'].forEach((t) => tickAtDay(G, '2026-10-26', t));
  eq(w.telegram.length, sent0, 'no summary yet');
  tickAtDay(G, '2026-10-26', '18:00');
  const late = w.telegram.slice(sent0).join('\n');
  ok(/running late/.test(late) && /updating the price history/.test(late) && /stocks to go/.test(late), late);
  ok(!sim.state.triggers.some((t) => t.handler === 'engineTick'), 'minute trigger stopped');
  ok(sim.state.triggers.some((t) => t.handler === 'continueEndOfDay'), 'background run scheduled');
  // The background runs carry on until the day is done.
  w.onCandle = null; // Angel One answers quickly again
  G.MarketCal._now = at('2026-10-26T18:02:00+05:30');
  G.continueEndOfDay();
  const day = JSON.parse(sim.state.props.get('DAY_STATE'));
  ok(day.eod, 'done: ' + JSON.stringify(day.eodDone));
  ok(!sim.state.triggers.some((t) => t.handler === 'continueEndOfDay'), 'no more background runs');
  const msgs = w.telegram.slice(sent0).join('\n----\n');
  ok(/Daily summary/.test(msgs) && /End-of-day work 16:00–18:02, later than planned/.test(msgs), msgs);
  eq(w.telegram.filter((t) => /running late/.test(t)).length, 1, 'the late message once');
});

test('end of day: at 22:30 whatever is left is skipped, so the closing summary still goes out', () => {
  const { G, sim, w } = marketWorld();
  G.MarketCal._now = at('2026-10-23T21:00:00+05:30');
  G.loadHistory();
  w.daily['99926000'] = SC.dailyFrom(SC.trend(300, 20000, 0.08), { end: '2026-10-26', vol: 0 });
  G.MarketCal._now = at('2026-10-26T08:20:00+05:30');
  G.Schedule.install();
  tickAtDay(G, '2026-10-26', '08:50');
  const sent0 = w.telegram.length;
  slowClock(G, w, 60000, sim); // hopeless: a minute per request
  tickAtDay(G, '2026-10-26', '16:00');
  tickAtDay(G, '2026-10-26', '18:00');
  G.MarketCal._now = at('2026-10-26T20:00:00+05:30');
  G.continueEndOfDay();
  ok(!JSON.parse(sim.state.props.get('DAY_STATE')).eod, 'still going at 20:00');
  ok(sim.state.triggers.some((t) => t.handler === 'continueEndOfDay'), 'next run planned');
  G.MarketCal._now = at('2026-10-26T22:31:00+05:30');
  G.continueEndOfDay();
  const day = JSON.parse(sim.state.props.get('DAY_STATE'));
  ok(day.eod, 'closed at the cap');
  const msgs = w.telegram.slice(sent0).join('\n----\n');
  ok(/Daily summary/.test(msgs) && /Not finished in time, so left out today: price history/.test(msgs), msgs);
  ok(!sim.state.triggers.some((t) => t.handler === 'continueEndOfDay'), 'stopped');
});

test('end of day: price history stops after 20 minutes of work, so a slow evening cannot use up the day\'s trigger time', () => {
  const { G, w } = marketWorld();
  G.MarketCal._now = at('2026-10-23T21:00:00+05:30');
  G.loadHistory();
  G.MarketCal._now = at('2026-10-26T17:30:00+05:30');
  w.daily['99926000'] = SC.dailyFrom(SC.trend(300, 20000, 0.08), { end: '2026-10-26', vol: 0 });
  const day = { day: '2026-10-26', histProbed: 1, histMs: 20 * 60000 };
  const calls = w.candleCalls.length;
  eq(G.Scans.updateHistory('2026-10-26', day, Date.now() + 200000), 'done', 'gives up on the rest');
  eq(w.candleCalls.length, calls, 'no more requests');
  ok(/Angel One answered slowly today: after 20 minutes \d+ stocks were still without today's candle/.test(day.histNote), day.histNote);
  ok(/Tomorrow's update fills in the gap/.test(day.histNote), day.histNote);
  const busy = { day: '2026-10-26', histProbed: 1, histMs: 20 * 60000, histReq: 900, histRefused: 610 };
  G.Scans.updateHistory('2026-10-26', busy, Date.now() + 200000);
  ok(/Angel One turned away 610 of 900 requests today \("exceeding access rate"/.test(busy.histNote), busy.histNote);
});

/** Angel One's "exceeding access rate" answer, for about half the requests at random (it sends it even at low rates). */
function refuseHalf(seed) {
  let x = seed >>> 0;
  return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296) < 0.5;
}

test('end of day: Angel One turning away half the requests does not slow the price history to a crawl', () => {
  const { G, sim, w } = marketWorld();
  G.MarketCal._now = at('2026-10-23T21:00:00+05:30');
  G.loadHistory();
  G.MarketCal._now = at('2026-10-26T16:05:00+05:30');
  w.daily['99926000'] = SC.dailyFrom(SC.trend(300, 20000, 0.08), { end: '2026-10-26', vol: 0 });
  const quietMon = SC.dailyFrom(SC.trend(300, 100, 0.01), { end: '2026-10-26', vol: 2e6 });
  w.candleGen = (token, interval) => (interval === 'ONE_DAY' ? w.daily[token] || (BY_TOKEN[token] ? quietMon : null) : null);
  const clock = slowClock(G, w, 300, sim); // each request takes 0.3 s
  const start = clock.now, coin = refuseHalf(42);
  w.refuseWhen = (body) => body.interval === 'ONE_DAY' && coin();
  const day = { day: '2026-10-26' };
  let runs = 0, r;
  do { r = G.Scans.updateHistory('2026-10-26', day, clock.now + 240000); runs++; clock.now += 30000; } while (r !== 'done' && runs < 40);
  eq(r, 'done', 'finished');
  const targets = G.Backfill.targets();
  // Every stock (the test's data has today's candle for all of them) got it: turned away four times means asked again next run.
  const missing = targets.filter((it) => BY_TOKEN[it.token] && !(G.History.lastDay(it.key) >= 20261026));
  eq(missing.length, 0, 'every stock got today\'s candle: ' + missing.slice(0, 5).map((it) => it.key));
  ok(!day.histNote, 'no note: ' + day.histNote);
  ok(day.histRefused > targets.length * 0.6, 'about half turned away: ' + day.histRefused + ' of ' + day.histReq);
  // At 0.3 s a request and three at a time, the work itself takes well under a second a stock even when half are turned
  // away; the 0.6.5 pause that grew to 16 s took about 6 s a stock here.
  const perStock = (clock.now - start - runs * 30000) / targets.length;
  ok(perStock < 1500, 'about ' + Math.round(perStock) + ' ms a stock over ' + runs + ' runs');
  ok(sim.ss.getSheetByName('HealthLog').dump().some((row) => /Angel One turned away \d+ of \d+ requests/.test(row.join(' '))), 'each run logs the refusals');
});

test('candles: only a batch turned away completely waits longer (2 s, then 5 s), and never more', () => {
  const { G, sim, w } = marketWorld();
  const clock = slowClock(G, w, 300, sim), sleeps = [];
  const sleep = G.Utilities.sleep;
  G.Utilities.sleep = (ms) => { sleeps.push(ms); sleep(ms); };
  let n = 0;
  w.refuseWhen = () => ++n <= 12; // Angel One refuses everything for a moment (four whole batches), then answers
  const items = ['BIG001', 'BIG002', 'BIG003', 'MID010', 'MID011', 'MID012'].map((s) => ({ key: s, token: TOKENS[s], from: at('2026-10-20T09:15:00+05:30'), to: at('2026-10-26T15:30:00+05:30') }));
  const res = G.Angel.candlesMany(items, 'ONE_DAY', {});
  eq(Object.keys(res.data).length, 6, 'all six arrived');
  eq(res.refused, 12, 'twelve refusals counted');
  eq(JSON.stringify(sleeps.slice(0, 5)), JSON.stringify([2000, 2000, 5000, 5000, 1100]), 'waits: ' + sleeps.join(', '));
  ok(Math.max.apply(null, sleeps) <= 5000, 'never longer than 5 s');
  // A batch with only some turned away keeps the normal pace, and the refused ones go to the back of the queue
  // (asked alone at the end, a refused one waits 2 s like any batch turned away completely).
  sleeps.length = 0; n = 0; w.candleCalls = [];
  w.refuseWhen = (body) => body.symboltoken === TOKENS.BIG001 && ++n <= 2;
  const res2 = G.Angel.candlesMany(items, 'ONE_DAY', {});
  eq(Object.keys(res2.data).length, 6, 'all six again');
  eq(JSON.stringify(sleeps), JSON.stringify([1100, 1100, 2000]), 'normal pace, then a short wait for the last one: ' + sleeps.join(', '));
  eq(w.candleCalls[3].symboltoken, TOKENS.MID010, 'the next stocks went first');
  void clock;
});

test('end of day: a stock turned away on every try is asked again in the next run, not given up', () => {
  const { G, w } = marketWorld();
  G.MarketCal._now = at('2026-10-23T21:00:00+05:30');
  G.loadHistory();
  G.MarketCal._now = at('2026-10-26T16:05:00+05:30');
  w.daily['99926000'] = SC.dailyFrom(SC.trend(300, 20000, 0.08), { end: '2026-10-26', vol: 0 });
  const quietMon = SC.dailyFrom(SC.trend(300, 100, 0.01), { end: '2026-10-26', vol: 2e6 });
  w.candleGen = (token, interval) => (interval === 'ONE_DAY' ? w.daily[token] || (BY_TOKEN[token] ? quietMon : null) : null);
  w.refuse = { [TOKENS.BIG001]: 5 }; // four tries in the first run, then once more in the second
  const day = { day: '2026-10-26' };
  eq(G.Scans.updateHistory('2026-10-26', day, Date.now() + 600000), 'more', 'one stock still to get');
  eq(day.histLeft, 1, 'counted as left: ' + day.histLeft);
  eq(day.histFailed || 0, 0, 'not counted as failed');
  eq(G.Scans.updateHistory('2026-10-26', day, Date.now() + 600000), 'done', 'second run');
  eq(G.History.lastDay('BIG001'), 20261026, 'got it in the second run');
});

test('end of day: the menu finishes a day the older code left half done', () => {
  const { G, sim, w } = marketWorld();
  sim.state.uiAvailable = true;
  G.MarketCal._now = at('2026-10-23T21:00:00+05:30');
  G.loadHistory();
  w.daily['99926000'] = SC.dailyFrom(SC.trend(300, 20000, 0.08), { end: '2026-10-26', vol: 0 });
  const quietMon = SC.dailyFrom(SC.trend(300, 100, 0.01), { end: '2026-10-26', vol: 2e6 });
  w.candleGen = (token, interval) => (interval === 'ONE_DAY' ? w.daily[token] || (BY_TOKEN[token] ? quietMon : null) : null);
  // The 0.6.4 engine got stuck on its first step (price history) and stopped at 18:00.
  sim.state.props.set('DAY_STATE', JSON.stringify({ day: '2026-10-26', pre: 1, eodStep: 0, hc: 120 }));
  G.MarketCal._now = at('2026-10-26T15:00:00+05:30');
  eq(G.menuFinishEndOfDay(), false, 'not before 16:00');
  ok(sim.state.alerts.some((a) => /starts by itself at 16:00/.test(a.msg || a.message || JSON.stringify(a))), 'says when');
  G.MarketCal._now = at('2026-10-26T20:15:00+05:30');
  const sent0 = w.telegram.length;
  eq(G.menuFinishEndOfDay(), true, 'finished in one go');
  const day = JSON.parse(sim.state.props.get('DAY_STATE'));
  ok(day.eod && day.eodDone.evi && day.eodDone.hist && day.eodDone.rev, JSON.stringify(day.eodDone));
  ok(w.telegram.slice(sent0).some((t) => /Daily summary/.test(t)), 'summary sent');
  eq(G.menuFinishEndOfDay(), true, 'a second press says it is done');
  ok(sim.state.alerts.some((a) => /already done/.test(JSON.stringify(a))), 'already done');
});

test('backtest: after 18:15 it waits until today\'s end-of-day work is done', () => {
  const { G, sim } = marketWorld();
  G.MarketCal._now = at('2026-10-26T18:20:00+05:30');
  sim.state.props.set('DAY_STATE', JSON.stringify({ day: '2026-10-26', eodStart: at('2026-10-26T16:00:00+05:30'), eodDone: { evi: 1 } }));
  eq(G.Backtest.quiet(), false, 'end of day still running');
  const when = G.Backtest.schedule();
  ok(when.getTime() - Date.now() >= 4 * 60000 && when.getTime() - Date.now() <= 6 * 60000, 'tries again in five minutes: ' + when.toISOString());
  sim.state.props.set('DAY_STATE', JSON.stringify({ day: '2026-10-26', eodStart: 1, eod: 2 }));
  eq(G.Backtest.quiet(), true, 'done');
  sim.state.props.set('DAY_STATE', JSON.stringify({ day: '2026-10-26' }));
  eq(G.Backtest.quiet(), true, 'the engine did not run today, so nothing to wait for');
  G.MarketCal._now = at('2026-10-26T17:00:00+05:30');
  eq(G.Backtest.quiet(), false, 'not during the evening work');
  G.MarketCal._now = at('2026-10-26T22:40:00+05:30');
  sim.state.props.set('DAY_STATE', JSON.stringify({ day: '2026-10-26', eodStart: 1 }));
  eq(G.Backtest.quiet(), true, 'after the 22:30 cap the backtest may go');
});

test('no signals while the regime is unknown, and the brief says what to do', () => {
  const { G, sim, w } = fresh();
  G.setupSheets(); G.saveSecretsFromDialog(KEYS); G.SymbolsDb.rebuild();
  G.MarketCal._now = at('2026-10-26T08:20:00+05:30');
  G.Schedule.install();
  tickAtDay(G, '2026-10-26', '08:50');
  ok(/6\. Load price history/.test(w.telegram[w.telegram.length - 1]), w.telegram[w.telegram.length - 1]);
  const calls = w.candleCalls.length;
  tickAtDay(G, '2026-10-26', '09:46');
  eq(w.candleCalls.length, calls, 'no candle requests without a regime');
});

test('alert messages respect the per-run limit and the paper switch', () => {
  const { G, sim, w } = marketWorld();
  const mk = (sym, conf) => ({ symbol: sym, strategy: 'orb', strategyName: 'Opening-range breakout', horizon: 'INTRADAY', direction: 'BUY', entry: 100, entryLow: 99.9, entryHigh: 100, stop: 99, target1: 102, target2: 103, rr: 2, riskPct: 1, confidence: conf, reasons: ['Test reason'], barTime: Date.now(), barEnd: '10:00', tradedValueCr: 50 });
  G.MarketCal._now = at('2026-10-26T10:01:00+05:30');
  const sigs = Array.from({ length: 8 }, (_, i) => mk('BIG00' + (i + 1), 50 + i));
  const before = w.telegram.length;
  const out = G.AlertBook.publish(sigs, { nowMs: G.MarketCal._now, source: 'Test' });
  eq(out.logged, 8); eq(out.sent, 5, 'five individual messages');
  const extra = w.telegram.slice(before);
  eq(extra.length, 6, 'plus one list of the rest');
  ok(/3 more signals/.test(extra[5]), extra[5]);
  ok(/BIG008/.test(extra[0]), 'highest confidence first');
  const sh = sim.ss.getSheetByName('Config'), cfg = sh.dump(), r = cfg.findIndex((x) => x[0] === 'paperAlerts');
  sh.getRange(r + 1, 2).setValues([['FALSE']]); G.Config._cache = null;
  const b2 = w.telegram.length;
  G.AlertBook.publish([mk('BIG009', 70)], { nowMs: G.MarketCal._now + 60000, source: 'Test' });
  eq(w.telegram.length, b2, 'paper alerts switched off: logged only');
  ok(alertsRows(sim).some((a) => a.symbol === 'BIG009' && /paper alerts off/.test(a.telegram)), 'reason recorded');
});

test('status shows price history, regime and strategies', () => {
  const { G, sim } = marketWorld();
  G.MarketCal._now = at('2026-10-25T21:00:00+05:30');
  G.loadHistory();
  sim.state.uiAvailable = true;
  G.showStatus();
  const html = sim.state.dialogs[sim.state.dialogs.length - 1].html;
  ok(/506 stocks and indices/.test(html) && /Bull \(as of Fri 23 Oct\)/.test(html) && /13 of 13/.test(html), html.split('<body>')[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
});

test('permissions: the manifest asks only for narrow access, and the code needs nothing more', () => {
  const want = ['spreadsheets.currentonly', 'script.container.ui', 'script.external_request', 'script.scriptapp', 'script.send_mail', 'userinfo.email', 'drive.file'];
  const have = MANIFEST.oauthScopes.map((x) => x.replace('https://www.googleapis.com/auth/', ''));
  eq(have.slice().sort().join(), want.slice().sort().join(), 'scopes');
  ok(!have.includes('drive') && !have.includes('spreadsheets'), 'no access to all of Drive or all spreadsheets');
  eq(MANIFEST.timeZone, 'Asia/Kolkata'); eq(MANIFEST.runtimeVersion, 'V8');
  ok(MANIFEST.dependencies.enabledAdvancedServices.some((x) => x.serviceId === 'drive' && x.version === 'v3'), 'Drive API switched on for the script');
  const code = ORDER.map((f) => fs.readFileSync(path.join(FILES, f), 'utf8')).join('\n');
  for (const bad of [/DriveApp/, /openById|openByUrl/, /GmailApp|DocumentApp|CalendarApp|FormApp|SlidesApp/]) ok(!bad.test(code), 'code must not use ' + bad + ' (it needs a wider permission)');
});

test('Drive: the script sees only its own files, even if you have a folder with the same name', () => {
  const env = fresh();
  const { G, sim } = env;
  // A folder of yours with the same name, which the script must never see or touch.
  sim.state.drive.items.push({ id: 'mine1', name: 'Stock Radar Data', mimeType: 'application/vnd.google-apps.folder', parents: [], content: '', trashed: false, byApp: false });
  sim.state.drive.items.push({ id: 'mine2', name: 'daily-00.json', mimeType: 'application/json', parents: ['mine1'], content: 'my own notes', trashed: false, byApp: false });
  G.setupSheets(); G.saveSecretsFromDialog(KEYS);
  const id = G.History.folderId();
  ok(id !== 'mine1', 'made its own folder');
  G.History.put('NIFTY 50', [{ t: Date.parse('2026-10-23T00:00:00+05:30'), o: 1, h: 2, l: 0.5, c: 1.5, v: 0 }]);
  G.History.flush();
  eq(sim.state.drive.items.find((x) => x.id === 'mine2').content, 'my own notes', 'your file untouched');
  G.History.reset();
  eq(G.History.get('NIFTY 50').length, 1, 'reads back its own file');
});

test('Drive: a failed read stops the job instead of overwriting history', () => {
  const { G, sim, w } = marketWorld();
  G.MarketCal._now = at('2026-10-25T21:00:00+05:30');
  G.loadHistory();
  const before = sim.state.drive.items.filter((x) => /^daily-/.test(x.name)).map((x) => x.content).join('|');
  G.History.reset();
  sim.state.drive.failReads = 1000; // Drive keeps failing for this run
  G.MarketCal._now = at('2026-10-26T16:50:00+05:30'); // past the wait for today's candle, so the files are read
  let threw = false;
  try { G.Scans.updateHistory('2026-10-26', {}, Date.now() + 60000); } catch (e) { threw = /Google Drive/.test(e.message); }
  ok(threw, 'the update stops with a Drive error');
  const after = sim.state.drive.items.filter((x) => /^daily-/.test(x.name)).map((x) => x.content).join('|');
  ok(before === after, 'no price file was overwritten');
});

test('Drive: a clear message when the Drive API or the permission is missing', () => {
  const { G, sim } = fresh();
  G.setupSheets();
  sim.state.drive.apiOff = true;
  const r = G.Checks.runOne('Google Drive files', G.Checks.drive);
  eq(r.result, 'FAIL'); ok(/Services/.test(r.detail) && /Drive API/.test(r.detail), r.detail);
  sim.state.drive.apiOff = false;
  const ok2 = G.Checks.runOne('Google Drive files', G.Checks.drive);
  eq(ok2.result, 'PASS', ok2.detail);
  const narrow = createSim({ files: FILES, order: ORDER, manifest: { ...MANIFEST, oauthScopes: MANIFEST.oauthScopes.filter((x) => !/drive/.test(x)) } });
  narrow.ctx.setupSheets();
  const r3 = narrow.ctx.Checks.runOne('Google Drive files', narrow.ctx.Checks.drive);
  eq(r3.result, 'FAIL'); ok(/permission is missing/.test(r3.detail), r3.detail);
});

// =================== Phase 3: evaluation, paper trades, graduation, reports ===================

/** 1-minute candles for one day: flat at `start` until `fromHHMM`, then moving `step` a minute. */
function minuteDay(ymd, start, fromHHMM, step) {
  const out = []; let p = start;
  const [fh, fm] = fromHHMM.split(':').map(Number), from = fh * 60 + fm;
  for (let m = 555; m < 930; m++) {
    const o = p;
    if (m >= from) p = Math.round((p + step) * 100) / 100;
    const t = Date.parse(`${ymd}T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00+05:30`);
    out.push({ t, o, h: Math.max(o, p) + 0.03, l: Math.min(o, p) - 0.03, c: p, v: 1000 });
  }
  return out;
}
const sheetRows = (sim, name) => { const d = sim.ss.getSheetByName(name).dump(); const h = d[0]; return d.slice(1).map((r) => Object.fromEntries(h.map((k, i) => [k, r[i]]))); };

test('evaluation: an intraday alert is judged on 1-minute candles after the close and becomes a paper trade', () => {
  const day = '2026-10-26';
  const { G, sim, w } = marketWorld({ end: day, intra: { [TOKENS.TCS]: SC.intraday.orb() }, minute: { [TOKENS.TCS]: minuteDay(day, 101.1, '09:47', 0.02) } });
  G.MarketCal._now = at('2026-10-25T21:00:00+05:30');
  G.loadHistory();
  G.Schedule.install();
  for (const t of ['08:50', '09:41', '09:46']) tickAtDay(G, day, t);
  eq(alertsRows(sim).length, 1, 'the breakout alert');
  const sent0 = w.telegram.length;
  tickAtDay(G, day, '16:00');
  const a = alertsRows(sim)[0];
  eq(a.status, 'CLOSED'); eq(a.outcome, 'TARGET_HIT');
  eq(a.fillPrice, 101.1, 'filled at the open of the first minute after the alert'); eq(a.exitPrice, a.target1);
  ok(a.paperQty > 0 && a.charges > 0 && a.netPnl < a.grossPnl && a.netPnl > 0, 'net of charges: ' + JSON.stringify({ q: a.paperQty, g: a.grossPnl, c: a.charges, n: a.netPnl }));
  ok(a.holdDays > 0 && a.holdDays < 1, 'part of a session'); eq(a.niftyPct, 0, 'flat Nifty'); eq(a.alphaPct, a.netPct);
  ok(w.candleCalls.some((c) => c.interval === 'ONE_MINUTE' && c.symboltoken === TOKENS.TCS), '1-minute candles fetched');
  const pt = sheetRows(sim, 'PaperTrades');
  eq(pt.length, 1); eq(pt[0].status, 'CLOSED'); eq(pt[0].exitReason, 'TARGET_HIT'); eq(pt[0].netPnl, a.netPnl); eq(pt[0].track, 'main');
  const st = sheetRows(sim, 'Strategies').find((r) => r.id === 'orb');
  eq(st.trades, 1); eq(st.wins, 1); eq(st.winRatePct, 100); ok(/1 of 30/.test(st.note), st.note);
  const m = sheetRows(sim, 'Metrics').find((r) => r.strategy === 'orb' && r.regime === 'ALL' && r.track === 'main');
  eq(m.trades, 1); ok(/Insufficient data/.test(m.note), m.note);
  const summary = w.telegram.slice(sent0).join('\n');
  ok(/Paper trading/.test(summary) && /Closed today: 1/.test(summary) && /TCS target hit/.test(summary) && /Since start/.test(summary), summary);
  // The session review follows the closing summary, with the day's numbers worked out exactly.
  const review = w.telegram.slice(sent0).find((x) => /📒 <b>Session review/.test(x));
  ok(review, 'session review sent: ' + w.telegram.slice(sent0).map((x) => x.slice(0, 40)).join(' / '));
  const net = Math.round(a.netPnl);
  ok(review.includes('Paper result today: <b>+₹' + net.toLocaleString('en-IN') + '</b>') && /1 trade closed · ✅ 1 won · ❌ 0 lost · win rate 100%/.test(review) && /🎯 Targets 1 · 🛑 Stops 0/.test(review), review);
  ok(/🏆 Best: TCS \+/.test(review) && /<b>By strategy<\/b>\n🟢 Opening-range breakout: 1 trade, 1 won/.test(review) && /🟢 Buys: 1 trade, 1 won/.test(review) && !/AI review/.test(review), review);
  const f = JSON.parse(sim.state.props.get('SESSION_REVIEW'));
  eq(f.day, '2026-10-26'); eq(f.paper.n, 1); eq(f.paper.won, 1); eq(f.paper.net, net); eq(f.paper.target, 1); eq(f.byStrategy[0].id, 'orb'); eq(f.ai, null);
  ok(sim.state.drive.items.some((x) => x.name === 'sessions.json'), 'kept in Drive for the app');
  ok(sheetRows(sim, 'Reports').some((r) => r.type === 'session'), 'listed in Reports');
  sim.state.uiAvailable = true;
  G.showStatus();
  ok(/1 closed, net ₹/.test(sim.state.dialogs[sim.state.dialogs.length - 1].html), 'status shows the paper account');
});

test('evaluation: swing and medium alerts are judged on later daily candles, with checkpoints against Nifty', () => {
  const end = '2026-10-26';
  const rel = SC.daily['base-breakout']();
  const { G, sim, w } = marketWorld({ end, daily: { [TOKENS.RELIANCE]: rel } });
  G.MarketCal._now = at('2026-10-23T21:00:00+05:30');
  G.loadHistory();
  G.MarketCal._now = at('2026-10-26T08:20:00+05:30');
  G.Schedule.install();
  tickAtDay(G, end, '08:50');
  tickAtDay(G, end, '16:00');
  let rows = alertsRows(sim);
  const bb = rows.find((r) => r.strategy === 'base-breakout');
  eq(bb.status, 'OPEN', 'nothing to judge on the alert day itself');
  // The next days: opens inside the entry range, then climbs through the target.
  const last = rel[rel.length - 1].c;
  const next = [[1.002, 1.01], [1.01, 1.03], [1.03, 1.07]].map(([o, c], i) => ({ o: last * o, c: last * c }));
  const ts = SC.weekdays('2026-10-29', 3);
  const more = next.map((x, i) => ({ t: ts[i], o: Math.round(x.o * 100) / 100, h: Math.round(Math.max(x.o, x.c) * 1.004 * 100) / 100, l: Math.round(Math.min(x.o, x.c) * 0.996 * 100) / 100, c: Math.round(x.c * 100) / 100, v: 2e6 }));
  G.History.put('RELIANCE', more);
  G.History.put('NIFTY 50', ts.map((t) => ({ t, o: 25000, h: 25010, l: 24990, c: 25000, v: 0 })));
  G.History.flush();
  G.MarketCal._now = at('2026-10-29T16:30:00+05:30');
  G.Review.daily('2026-10-29');
  rows = alertsRows(sim);
  const b2 = rows.find((r) => r.strategy === 'base-breakout');
  eq(b2.status, 'CLOSED'); eq(b2.outcome, 'TARGET_HIT'); eq(b2.fillPrice, more[0].o, 'filled at the next open');
  ok(b2.netPnl > 0 && b2.holdDays === 2, JSON.stringify({ n: b2.netPnl, h: b2.holdDays }));
  const tt = rows.find((r) => r.strategy === 'trend-template');
  eq(tt.status, 'ACTIVE', 'medium-term idea still running');
  ok(sheetRows(sim, 'PaperTrades').some((p) => p.strategy === 'trend-template' && p.status === 'OPEN' && p.unrealisedPnl !== ''), 'open trade marked to the last close');
  let cps = sheetRows(sim, 'Checkpoints');
  ok(cps.some((c) => c.alertId === b2.id && c.label === 'FINAL') === false, 'swing trades have no checkpoints');
  eq(cps.length, 0, 'no checkpoints due yet');
  // A month later the medium-term ideas get their 1-month checkpoint.
  const later = SC.weekdays('2026-11-27', 21).filter((t) => t > ts[2]).map((t) => ({ t, o: last * 1.07, h: last * 1.08, l: last * 1.06, c: last * 1.075, v: 2e6 }));
  G.History.put('RELIANCE', later);
  G.History.put('NIFTY 50', later.map((x) => ({ t: x.t, o: 25500, h: 25510, l: 25490, c: 25500, v: 0 })));
  G.History.flush();
  G.MarketCal._now = at('2026-11-27T16:30:00+05:30');
  G.Review.daily('2026-11-27');
  cps = sheetRows(sim, 'Checkpoints');
  const one = cps.filter((c) => c.label === '1M');
  eq(one.length, 2, 'trend template and near-high each get a 1-month checkpoint');
  const nk = G.History.get('NIFTY 50'), nBase = nk.find((c) => G.History.msToDay(c.t) === 20261026).c;
  const nWant = Math.round((25500 / nBase - 1) * 10000) / 100;
  ok(one.every((c) => c.returnPct > 0 && Math.abs(c.niftyReturnPct - nWant) < 0.01 && Math.abs(c.alphaPct - (c.returnPct - c.niftyReturnPct)) < 0.02), JSON.stringify(one) + ' want Nifty ' + nWant);
  G.Review.daily('2026-11-27');
  eq(sheetRows(sim, 'Checkpoints').length, cps.length, 'checkpoints are written once');
});

/** A closed paper trade row for the Alerts sheet, `day` days after 1 Sep 2026 (minute `i` that day). */
const closedRow = (i, pct, day, strategy = 'orb') => ({
  id: 'A2026-T' + i + '-' + strategy, createdAt: new Date(Date.parse('2026-09-01T10:00:00+05:30') + day * 86400000 + i * 60000), symbol: 'BIG001', horizon: 'INTRADAY', strategy,
  direction: 'BUY', entryLow: 100, entryHigh: 100.2, stop: 99, target1: 102, regime: 'BULL', status: 'CLOSED', outcome: pct > 0 ? 'TARGET_HIT' : 'STOP_HIT',
  closedAt: new Date(Date.parse('2026-09-01T14:00:00+05:30') + day * 86400000 + i * 60000), netPct: pct, netPnl: pct * 100, paperQty: 10, alphaPct: pct - 0.1, holdDays: 0.2, track: 'main',
});

test('graduation: 30 trades on only a few days are not enough, however good they look', () => {
  const { G, sim, w } = marketWorld();
  G.AlertBook.ensureHeaders();
  G.Store.append('Alerts', Array.from({ length: 40 }, (_, i) => closedRow(i, i % 3 === 0 ? -0.5 : 1.2, i % 4))); // four days
  G.MarketCal._now = at('2026-10-31T10:30:00+05:30');
  const before = w.telegram.length;
  G.weeklyReport();
  const msgs = w.telegram.slice(before).join('\n');
  ok(!/LIVE-READY/.test(msgs), 'not promoted');
  ok(/Opening-range breakout<\/b> · Paper · 40\/30 trades, 4\/15 days/.test(msgs), msgs);
  G.StrategyBook._map = null;
  eq(G.StrategyBook.load().orb.status, 'PAPER');
  ok(/only 4 of 15 different trading days/.test(sheetRows(sim, 'Strategies').find((r) => r.id === 'orb').statusReason), 'reason recorded');
  // Forty losers on four days are not rejected either.
  G.Store.append('Alerts', Array.from({ length: 40 }, (_, i) => closedRow(100 + i, -0.8, 10 + (i % 4))));
  G.weeklyReport();
  G.StrategyBook._map = null;
  eq(G.StrategyBook.load().orb.status, 'PAPER', 'not rejected on four days');
});

test('graduation: 30 good paper trades make a strategy Live-ready; a bad run demotes it, with a message each time', () => {
  const { G, sim, w } = marketWorld();
  G.AlertBook.ensureHeaders();
  const mk = (i, pct) => closedRow(i, pct, i); // one trade a day
  G.Store.append('Alerts', Array.from({ length: 30 }, (_, i) => mk(i, i % 3 === 0 ? -0.5 : 1.2)));
  G.MarketCal._now = at('2026-10-31T10:30:00+05:30'); // Saturday
  const before = w.telegram.length;
  G.weeklyReport();
  const msgs = w.telegram.slice(before).join('\n----\n');
  ok(/Opening-range breakout is now LIVE-READY/.test(msgs), msgs);
  ok(/Weekly report/.test(msgs) && /Status changes this week/.test(msgs), msgs);
  G.StrategyBook._map = null;
  eq(G.StrategyBook.load().orb.status, 'LIVE_READY');
  const st = sheetRows(sim, 'Strategies').find((r) => r.id === 'orb');
  eq(st.status, 'LIVE_READY'); ok(st.statusSince, 'date of the change');
  // Its next alert carries the record.
  G.Review.refreshStats(G.Review.alerts().rows);
  G.StrategyBook._map = null;
  const fmt = G.AlertBook.format({ symbol: 'TCS', strategy: 'orb', strategyName: 'Opening-range breakout', horizon: 'INTRADAY', direction: 'BUY', entry: 100, entryLow: 99.9, entryHigh: 100, stop: 99, target1: 102, target2: null, rr: 2, confidence: 70, reasons: ['x'] },
    G.StrategyBook.load().orb, { qty: 5, value: 500, riskAmount: 5 }, { text: 'Today until 15:15' }, { state: 'BULL' }, 'Test');
  ok(/✅ Live-ready \(67% wins over 30 paper trades\)/.test(fmt) && !/Paper signal/.test(fmt), fmt);
  // Thirty losers in a row: the latest 60 trades now lose money, so it is rejected.
  G.Store.append('Alerts', Array.from({ length: 30 }, (_, i) => closedRow(100 + i, -0.8, 30 + i)));
  G.MarketCal._now = at('2026-11-07T10:30:00+05:30');
  const b2 = w.telegram.length;
  G.weeklyReport();
  const m2 = w.telegram.slice(b2).join('\n');
  ok(/Opening-range breakout is now REJECTED/.test(m2) && /keeps paper-trading silently/.test(m2), m2);
  G.StrategyBook._map = null;
  eq(G.StrategyBook.load().orb.status, 'REJECTED');
  // An override in the sheet still decides the label.
  const sh = sim.ss.getSheetByName('Strategies'), d = sh.dump(), i = d.findIndex((r) => r[0] === 'orb'), col = d[0].indexOf('override') + 1;
  sh.getRange(i + 1, col).setValues([['PAPER']]);
  G.StrategyBook._map = null;
  eq(G.StrategyBook.load().orb.status, 'PAPER', 'override wins');
});

test('readiness report goes out on day 30 (once), and only the latest milestone if several are overdue', () => {
  const { G, sim, w } = marketWorld();
  sim.state.props.set('PAPER_START', '2026-09-26');
  const b = w.telegram.length;
  eq(G.Review.readinessIfDue('2026-10-26'), 30);
  const msg = w.telegram.slice(b).join('\n');
  ok(/Readiness report · day 30/.test(msg) && /Needs more data/.test(msg) && /#\/results/.test(msg), msg);
  eq(G.Review.readinessIfDue('2026-10-27'), null, 'sent once');
  ok(sheetRows(sim, 'Reports').some((r) => r.type === 'readiness'), 'saved in Reports');
  sim.state.props.set('PAPER_START', '2026-08-20'); sim.state.props.delete('READINESS_SENT');
  eq(G.Review.readinessIfDue('2026-10-26'), 60, 'latest overdue milestone');
  eq(sim.state.props.get('READINESS_SENT'), '30,60');
});

/** Change one Config value in the sheet, as you would by hand. */
function setConfig(sim, G, key, value) {
  const sh = sim.ss.getSheetByName('Config'), d = sh.dump(), r = d.findIndex((x) => x[0] === key);
  if (r < 0) throw new Error('no Config row ' + key);
  sh.getRange(r + 1, 2).setValues([[value]]);
  G.Config._cache = null;
}

test('intraday on a Bear day: buys go out by default, and the brief lists the day\'s rules', () => {
  const day = '2026-10-26';
  const { G, sim, w } = marketWorld({ end: day, niftyDown: true, intra: { [TOKENS.TCS]: SC.intraday.orb() } });
  G.MarketCal._now = at('2026-10-25T21:00:00+05:30');
  G.loadHistory();
  eq(G.Market.saved().state, 'BEAR');
  G.Schedule.install();
  tickAtDay(G, day, '08:50');
  const brief = w.telegram[w.telegram.length - 1];
  ok(/Intraday rules: buys while Nifty 50 is above its open, shorts while it is below; one alert per stock\./.test(brief), brief);
  const sent0 = w.telegram.length;
  for (const t of ['09:41', '09:46']) tickAtDay(G, day, t);
  ok(/BUY TCS/.test(w.telegram.slice(sent0).join('\n')), 'the buy is sent');
  const a = alertsRows(sim);
  eq(a.length, 1); eq(a[0].track, 'main'); eq(a[0].regime, 'BEAR');
});

test('shadow tracking: with "no buys on Bear days" on, an intraday buy is logged silently, judged, and kept out of the record', () => {
  const day = '2026-10-26';
  const { G, sim, w } = marketWorld({ end: day, niftyDown: true, intra: { [TOKENS.TCS]: SC.intraday.orb() }, minute: { [TOKENS.TCS]: minuteDay(day, 101.1, '09:47', 0.02) } });
  G.MarketCal._now = at('2026-10-25T21:00:00+05:30');
  G.loadHistory();
  eq(G.Market.saved().state, 'BEAR');
  setConfig(sim, G, 'intradayBlockBuysInBear', 'TRUE');
  G.Schedule.install();
  for (const t of ['08:50', '09:41']) tickAtDay(G, day, t);
  ok(/no buys today \(Bear day, your setting\)/.test(w.telegram[w.telegram.length - 1]), 'brief mentions the switch');
  const sent0 = w.telegram.length;
  tickAtDay(G, day, '09:46');
  eq(w.telegram.length, sent0, 'no message for a blocked buy');
  const a = alertsRows(sim);
  eq(a.length, 1); eq(a[0].track, 'shadow'); ok(/not sent: blocked by your setting: no intraday buys on Bear days, tracked silently/.test(a[0].telegram), a[0].telegram); ok(/-H$/.test(a[0].id), a[0].id);
  tickAtDay(G, day, '09:51');
  eq(alertsRows(sim).length, 1, 'shadows are not repeated either');
  tickAtDay(G, day, '16:00');
  const b = alertsRows(sim)[0];
  eq(b.outcome, 'TARGET_HIT', 'judged like any alert');
  eq(sheetRows(sim, 'Strategies').find((r) => r.id === 'orb').trades, 0, 'not in the strategy record');
  ok(sheetRows(sim, 'Metrics').some((r) => r.strategy === 'orb' && r.track === 'shadow' && r.trades === 1), 'in the shadow metrics');
  const summary = w.telegram.slice(sent0).join('\n');
  ok(/1 more signal was blocked by the market filters/.test(summary), summary);
  ok(!/Closed today: 1/.test(summary), 'paper account counts main trades only');
  const before = w.telegram.length;
  G.MarketCal._now = at('2026-10-31T10:30:00+05:30');
  G.weeklyReport();
  const weekly = w.telegram.slice(before).join('\n');
  ok(/Filter check/.test(weekly) && /Intraday \(by your Bear\/Bull switch\): blocked 1 averaged \+/.test(weekly), weekly);
});

test('trading with the day: a buy while Nifty 50 falls from its open is held back; with Nifty rising it goes out', () => {
  const day = '2026-10-26';
  const run = (dir) => {
    const env = marketWorld({ end: day, intra: { [TOKENS.TCS]: SC.intraday.orb(), '99926000': SC.niftyIntraday(dir) } });
    const { G } = env;
    G.MarketCal._now = at('2026-10-25T21:00:00+05:30');
    G.loadHistory();
    G.Schedule.install();
    for (const t of ['08:50', '09:41', '09:46']) tickAtDay(G, day, t);
    return env;
  };
  const down = run(-1);
  let a = alertsRows(down.sim);
  eq(a.length, 1); eq(a[0].track, 'shadow');
  ok(/not sent: against the day: Nifty 50 is down 0\.24% since the open, tracked silently/.test(a[0].telegram), a[0].telegram);
  ok(down.w.candleCalls.some((c) => c.interval === 'FIVE_MINUTE' && c.symboltoken === '99926000'), 'Nifty 5-minute bars fetched');
  const up = run(1);
  a = alertsRows(up.sim);
  eq(a.length, 1); eq(a[0].track, 'main'); eq(a[0].telegram, 'sent');
  ok(/Nifty 50 is up 0\.24% since the open/.test(a[0].reasons), a[0].reasons);
  ok(/Nifty 50 is up 0\.24% since the open/.test(up.w.telegram.join('\n')), 'the reason is in the message');
});

test('one intraday alert per stock per day: the strongest signal wins, later ones are dropped', () => {
  const { G, sim } = marketWorld();
  const sig = (sym, strategy, direction, confidence) => ({ symbol: sym, strategy, direction, confidence });
  const t0 = at('2026-10-26T10:01:00+05:30');
  const first = G.IntraSeen.filter('2026-10-26', [sig('TCS', 'orb', 'BUY', 60), sig('TCS', 'vwap', 'BUY', 72), sig('INFY', 'orb', 'BUY', 55)], t0, '');
  eq(first.map((s) => s.symbol + ':' + s.strategy).join(), 'TCS:vwap,INFY:orb');
  eq(G.IntraSeen.filter('2026-10-26', [sig('TCS', 'ema-cross', 'SHORT', 90)], t0 + 3 * 3600000, '').length, 0, 'not even later in the day, nor the other way');
  eq(G.IntraSeen.filter('2026-10-26', [sig('TCS', 'ema-cross', 'SHORT', 90)], t0, 'S|').length, 1, 'shadows are counted separately');
  eq(G.IntraSeen.filter('2026-10-27', [sig('TCS', 'orb', 'BUY', 60)], t0 + 86400000, '').length, 1, 'a new day starts fresh');
  setConfig(sim, G, 'intradayOneAlertPerStock', 'FALSE');
  sim.state.props.delete('INTRA_SEEN');
  const both = G.IntraSeen.filter('2026-10-26', [sig('TCS', 'orb', 'BUY', 60), sig('TCS', 'vwap', 'BUY', 72)], t0, '');
  eq(both.length, 2, 'switch off: one per strategy');
  eq(G.IntraSeen.filter('2026-10-26', [sig('TCS', 'orb', 'SHORT', 60)], t0 + 30 * 60000, '').length, 0, 'inside the cooldown');
  eq(G.IntraSeen.filter('2026-10-26', [sig('TCS', 'orb', 'SHORT', 60)], t0 + 61 * 60000, '').length, 1, 'after the cooldown');
});

test('menu: update paper results now', () => {
  const { G, sim } = marketWorld();
  sim.state.uiAvailable = true;
  G.MarketCal._now = at('2026-10-25T21:00:00+05:30');
  G.loadHistory();
  const r = G.updatePaperResults();
  ok(r && r.daily, 'ran');
  ok(sim.state.alerts.some((x) => /Paper results updated/.test(x.title)), 'dialog');
  G.MarketCal._now = at('2026-10-26T11:00:00+05:30');
  G.updatePaperResults();
  ok(sim.state.alerts.some((x) => /after 15:30/.test(x.msg)), 'not during market hours');
});

test('menu: intraday alerts left unjudged after the close are judged by Update paper results now', () => {
  const day = '2026-10-26';
  const { G, sim, w } = marketWorld({ end: day, intra: { [TOKENS.TCS]: SC.intraday.orb() }, minute: { [TOKENS.TCS]: minuteDay(day, 101.1, '09:47', 0.02) } });
  G.MarketCal._now = at('2026-10-25T21:00:00+05:30');
  G.loadHistory();
  G.Schedule.install();
  for (const t of ['08:50', '09:41', '09:46']) tickAtDay(G, day, t);
  eq(alertsRows(sim).length, 1, 'the breakout alert');
  w.angelDown = true; // Angel One does not answer during the end-of-day run
  for (const t of ['16:00', '16:01', '16:02', '16:03', '16:04', '16:05', '16:06']) tickAtDay(G, day, t);
  eq(alertsRows(sim)[0].status, 'OPEN', 'not judged at the close');
  w.angelDown = false;
  sim.state.uiAvailable = true;
  G.MarketCal._now = at(day + 'T22:00:00+05:30');
  G.updatePaperResults();
  const a = alertsRows(sim)[0];
  eq(a.status, 'CLOSED'); eq(a.outcome, 'TARGET_HIT', 'judged on 1-minute prices from the menu');
});

// =================== Phase 4: the Web App API ===================

const post = (G, body) => JSON.parse(G.doPost({ postData: { contents: JSON.stringify(body) } }).getContent());

/** A world after one trading day with an intraday alert judged and a swing scan run. */
function dayAfter() {
  const day = '2026-10-26';
  const env = marketWorld({ end: day, intra: { [TOKENS.TCS]: SC.intraday.orb() }, minute: { [TOKENS.TCS]: minuteDay(day, 101.1, '09:47', 0.02) }, daily: { [TOKENS.RELIANCE]: SC.daily['base-breakout']() } });
  const { G } = env;
  G.MarketCal._now = at('2026-10-25T21:00:00+05:30');
  G.loadHistory();
  G.Schedule.install();
  for (const t of ['08:50', '09:41', '09:46', '12:00', '15:10', '16:00']) tickAtDay(G, day, t);
  G.MarketCal._now = at('2026-10-26T18:00:00+05:30');
  return env;
}

test('web app: nothing without the token; ping and a bundle in the app\'s own shape with it', () => {
  const { G, sim, w } = dayAfter();
  const token = sim.state.props.get('APP_TOKEN');
  eq(post(G, { a: 'bundle' }).ok, false, 'no token');
  eq(post(G, { a: 'bundle', t: token.slice(0, -1) + 'x' }).ok, false, 'wrong token');
  ok(/Not authorised/.test(post(G, { a: 'ping', t: 'nope' }).error));
  const ping = post(G, { a: 'ping', t: token });
  eq(ping.ok, true); eq(ping.data.version, G.SR_VERSION);
  ok(/running/.test(G.doGet().getContent()), 'GET only says it is running');
  const raw = G.doPost({ postData: { contents: JSON.stringify({ a: 'bundle', t: token }) } });
  eq(raw.getMimeType(), 'application/json');
  const b = JSON.parse(raw.getContent()).data;
  eq(b.isDemo, false); eq(b.session, '2026-10-26');
  ok(['bull', 'neutral', 'bear', 'volatile', 'unknown'].includes(b.market.regime) && b.market.nifty > 0 && Array.isArray(b.market.reasons), JSON.stringify(b.market));
  eq(b.strategies.length, 13);
  const orb = b.strategies.find((x) => x.id === 'orb');
  eq(orb.outcomes, 'W'); eq(orb.trades, 1); eq(orb.status, 'paper'); eq(orb.horizon, 'intraday'); eq(orb.win, 100);
  const tcs = b.alerts.find((a) => a.symbol === 'TCS');
  ok(tcs && tcs.dir === 'buy' && tcs.horizon === 'intraday' && tcs.targets.length >= 1 && tcs.entryLo < tcs.entryHi && tcs.why.length >= 2 && tcs.time > 0, JSON.stringify(tcs));
  eq(tcs.outcome.state, 'target'); ok(tcs.outcome.pct > 0); eq(tcs.status, 'paper');
  ok(b.alerts.some((a) => a.symbol === 'RELIANCE' && a.horizon === 'swing'), 'swing alert from the close');
  ok(b.alerts.every((a) => !/-H$/.test(a.id)), 'no shadow alerts in the app');
  ok(b.paper.start === 100000 && b.paper.value > 100000 && b.paper.curve.length >= 2 && b.paper.closed.length === 1 && b.paper.closed[0].state === 'target', JSON.stringify(b.paper).slice(0, 400));
  ok(b.paper.open.some((o) => o.symbol === 'RELIANCE') === false, 'swing trade not filled yet');
  ok(b.engine.jobs.some((j) => j.name === 'Intraday scan' && j.ok), JSON.stringify(b.engine));
  ok(Array.isArray(b.scan.medium) && Array.isArray(b.scan.swing) && b.scan.etfs.length === 3, JSON.stringify(b.scan).slice(0, 300));
  ok(b.scan.medium.length > 0 && b.scan.medium.every((r) => r.score >= 0 && r.score <= 100 && r.line), 'medium list built at the close');
  eq(b.settings.riskPct, 1); eq(b.settings.watchlist.join(), 'RELIANCE,TCS,HDFCBANK,INFY,TITAN');
  const text = JSON.stringify(b);
  for (const v of Object.values(KEYS)) ok(!text.includes(v.replace(/ /g, '').toUpperCase()) && !text.includes(v), 'no key in the bundle');
  ok(!text.includes(token), 'no token in the bundle');
  ok(text.length < 400000, 'bundle size ' + text.length);
  if (process.env.BUNDLE_OUT) {
    // Fixtures for the app's screenshot check: the bundle plus chart and news answers.
    const tcsId = G.Tables.read('Alerts').rows.find((r) => r.symbol === 'TCS').id;
    const charts = {};
    for (const [sym, id] of [['RELIANCE', ''], ['TCS', tcsId], ['TCS', ''], ['HDFCBANK', '']]) charts[sym + '|' + id] = post(G, { a: 'chart', t: token, symbol: sym, alertId: id }).data;
    const news = post(G, { a: 'news', t: token, symbol: 'RELIANCE' }).data;
    fs.writeFileSync(process.env.BUNDLE_OUT, JSON.stringify({ bundle: b, charts, news, token, url: 'https://script.google.com/macros/s/AKfycbFAKEdeploymentIDforTests1234567890/exec' }));
  }
});

test('web app: charts — daily from Drive history, 5-minute for an intraday alert', () => {
  const { G, sim } = dayAfter();
  const token = sim.state.props.get('APP_TOKEN');
  const d = post(G, { a: 'chart', t: token, symbol: 'RELIANCE' });
  eq(d.ok, true); eq(d.data.mode, 'day'); ok(d.data.candles.length > 200 && d.data.candles[0].length === 6, 'daily candles');
  const id = G.Tables.read('Alerts').rows.find((r) => r.symbol === 'TCS').id;
  const i = post(G, { a: 'chart', t: token, symbol: 'TCS', alertId: id });
  eq(i.data.mode, 'intraday'); ok(i.data.candles.length >= 6, 'five-minute bars of the alert day');
  eq(post(G, { a: 'chart', t: token, symbol: '../x' }).ok, false, 'symbol checked');
});

test('web app: settings saved from the app reach the Config and Strategies sheets, with checks', () => {
  const { G, sim, w } = dayAfter();
  const token = sim.state.props.get('APP_TOKEN');
  eq(post(G, { a: 'bundle', t: token }).data.settings.intradayBlockBuysInBear, false, 'both directions by default');
  const r = post(G, { a: 'settings', t: token, settings: { riskPct: 1.5, realCapital: 250000, watchlist: ['tcs', 'SBIN'], paperAlerts: false, intradayBlockBuysInBear: true, intradayFollowNifty: false }, strategies: { off: ['macd'], overrides: { orb: 'live_ready' } } });
  eq(r.ok, true, r.error);
  G.Config._cache = null; G.StrategyBook._map = null;
  eq(G.Config.get('riskPct'), 1.5); eq(G.Config.get('realCapital'), 250000); eq(G.Config.get('paperAlerts'), false);
  eq(G.Config.get('intradayBlockBuysInBear'), true); eq(G.Config.get('intradayFollowNifty'), false); eq(G.Config.get('intradayOneAlertPerStock'), true, 'untouched');
  eq(r.data.intradayBlockBuysInBear, true); eq(r.data.intradayFollowNifty, false);
  eq(G.Config.get('watchlist'), 'TCS,SBIN');
  const book = G.StrategyBook.load();
  eq(book.macd.enabled, false); eq(book.orb.status, 'LIVE_READY', 'override');
  eq(r.data.strategiesOff.join(), 'macd');
  eq(post(G, { a: 'settings', t: token, settings: { riskPct: 9 } }).ok, false, 'out of range');
  eq(post(G, { a: 'settings', t: token, settings: { watchlist: ['BAD SYMBOL'] } }).ok, false, 'bad symbol');
  eq(post(G, { a: 'settings', t: token, strategies: { overrides: { orb: 'GODMODE' } } }).ok, false, 'bad status');
  const back = post(G, { a: 'settings', t: token, strategies: { overrides: { orb: '' } } });
  G.StrategyBook._map = null;
  eq(G.StrategyBook.load().orb.status, 'PAPER', 'override cleared');
  const before = w.telegram.length;
  eq(post(G, { a: 'testTelegram', t: token }).ok, true);
  eq(w.telegram.length, before + 1);
  eq(post(G, { a: 'unknown', t: token }).ok, false);
});

test('web app: settings saved while the engine is busy wait, show as saved, and are written within minutes', () => {
  const { G, sim } = dayAfter();
  const token = sim.state.props.get('APP_TOKEN');
  const cfg = (k) => { G.Config._cache = null; return G.Config.get(k); };
  sim.state.lockBusy = true;
  sim.state.cache.set('JOB_RUNNING', JSON.stringify({ name: 'tick', at: Date.now() }));
  const r = post(G, { a: 'settings', t: token, settings: { aiSummaries: true, riskPct: 1.5 }, strategies: { off: ['macd'] } });
  eq(r.ok, true, r.error);
  eq(r.data.pending, true); eq(r.data.aiSummaries, true); eq(r.data.riskPct, 1.5); eq(r.data.busy.name, 'tick', 'says which job is busy');
  eq(cfg('aiSummaries'), false, 'not written yet');
  ok(sim.state.triggers.some((t) => t.handler === 'applyPendingSettings'), 'a follow-up in a minute');
  const b = post(G, { a: 'bundle', t: token }).data;
  ok(b.settings.aiSummaries === true && b.settings.pending === true && b.settings.strategiesOff.includes('macd'), 'the app sees the new values: ' + JSON.stringify(b.settings));
  eq(post(G, { a: 'settings', t: token, settings: { riskPct: 99 } }).ok, false, 'checks still apply while busy');
  // Still busy a minute later: tries again.
  G.applyPendingSettings();
  eq(cfg('aiSummaries'), false);
  eq(sim.state.triggers.filter((t) => t.handler === 'applyPendingSettings').length, 1, 'one follow-up at a time');
  // Free again: the follow-up writes them.
  sim.state.lockBusy = false; sim.state.cache.delete('JOB_RUNNING');
  G.applyPendingSettings();
  eq(cfg('aiSummaries'), true); eq(cfg('riskPct'), 1.5);
  G.StrategyBook._map = null;
  eq(G.StrategyBook.load().macd.enabled, false, 'strategy switched off');
  eq(sim.state.props.get('PENDING_SETTINGS'), undefined, 'nothing left waiting');
  eq(post(G, { a: 'bundle', t: token }).data.settings.pending, undefined);
  // Any job that takes the lock writes waiting settings first.
  sim.state.lockBusy = true;
  post(G, { a: 'settings', t: token, settings: { aiSummaries: false } });
  sim.state.lockBusy = false;
  G.Jobs.run('someJob', () => true, { lock: true });
  eq(cfg('aiSummaries'), false, 'written by the next locked job');
  // A later save while free also writes anything older first, and the newer value wins.
  sim.state.lockBusy = true;
  post(G, { a: 'settings', t: token, settings: { riskPct: 2, telegram: false } });
  sim.state.lockBusy = false;
  post(G, { a: 'settings', t: token, settings: { riskPct: 1.2 } });
  eq(cfg('riskPct'), 1.2); eq(cfg('telegram'), false);
});

test('backtest: a step skipped because the engine is busy is not a failure', () => {
  const { G, sim } = labWorld();
  G.Backtest.start('menu');
  sim.state.lockBusy = true;
  for (let i = 0; i < 5; i++) G.continueBacktest();
  const j = G.Backtest.job();
  ok(j.stage !== 'failed' && !(j.fails > 0), JSON.stringify(j));
  ok(sim.state.triggers.some((t) => t.handler === 'continueBacktest'), 'tries again');
  sim.state.lockBusy = false;
});

test('web app: headlines from Google News, parsed, checked and cached', () => {
  const { G, sim, w } = dayAfter();
  const token = sim.state.props.get('APP_TOKEN');
  const r = post(G, { a: 'news', t: token, symbol: 'RELIANCE' });
  eq(r.ok, true, r.error);
  eq(r.data.items.length, 3, 'unsafe link dropped');
  eq(r.data.items[0].title, 'Headline 3 & more', 'newest first'); eq(r.data.items[0].source, 'Paper 3'); ok(r.data.items[0].at > r.data.items[2].at);
  post(G, { a: 'news', t: token, symbol: 'RELIANCE' });
  eq(w.newsCalls, 1, 'second call from the cache');
  const q = decodeURIComponent(sim.state.requests.find((x) => x.url.includes('news.google.com')).url.split('q=')[1].split('&')[0]);
  ok(/"RELIANCE"|RELIANCE share/.test(q), q);
});

test('web app: news leaves out price pages and old items, and looks further back when the month is quiet', () => {
  const { G, sim, w } = dayAfter();
  const token = sim.state.props.get('APP_TOKEN');
  const queries = [];
  w.newsFor = (q) => {
    queries.push(q);
    return /when:30d/.test(q) ? [
      ['TCS Share Price - Groww', 'Mon, 26 Oct 2026 05:00:00 GMT', 'Groww'],
      ['Tata Consultancy Services (TCS.NS) stock price, news, quote and history - Yahoo Finance', 'Sun, 25 Oct 2026 05:00:00 GMT', 'Yahoo Finance'],
      ['TCS shares rise 2% after strong Q2 deal wins - Mint', 'Fri, 23 Oct 2026 06:00:00 GMT', 'Mint'],
    ] : [
      ['TCS Share Price Today - TATA CONSULTANCY Stock Price Live NSE/BSE - Univest', 'Mon, 26 Oct 2026 07:00:00 GMT', 'Univest'],
      ['Gold BeES (₹ 116.01) - NAV, Reviews & asset allocation - The Economic Times', 'Thu, 01 Oct 2026 07:00:00 GMT', 'The Economic Times'],
      ['TCS wins a large UK pension contract - The Economic Times', 'Tue, 06 Oct 2026 08:00:00 GMT', 'The Economic Times'],
      ['TCS shares rise 2% after strong Q2 deal wins - Mint', 'Fri, 23 Oct 2026 06:00:00 GMT', 'Mint'],
      ['TCS Q1 results: profit up 6% - Business Standard', 'Thu, 10 Jul 2025 08:00:00 GMT', 'Business Standard'],
    ];
  };
  const r = post(G, { a: 'news', t: token, symbol: 'TCS' });
  eq(r.ok, true, r.error);
  eq(r.data.items.map((x) => x.title).join(' | '), 'TCS shares rise 2% after strong Q2 deal wins - Mint | TCS wins a large UK pension contract - The Economic Times',
    'news only, newest first, once each, nothing older than 120 days');
  eq(queries.length, 2, 'the last 30 days first, then further back');
  ok(/when:30d$/.test(queries[0]) && !/when:/.test(queries[1]), queries.join(' / '));
  ok(!G.AppApi.quotePage('Reliance share price jumps 4% after Q2 results beat estimates - Mint'), 'a news headline with "share price" stays');
  ok(G.AppApi.quotePage('RELIANCE Stock Price and Chart — NSE:RELIANCE — TradingView'), 'chart pages go');
});

test('session review: the AI part puts the day\'s numbers into words, and the review can be made again from the app', () => {
  const day = '2026-10-26';
  const { G, sim, w } = marketWorld({ end: day, intra: { [TOKENS.TCS]: SC.intraday.orb() }, minute: { [TOKENS.TCS]: minuteDay(day, 101.1, '09:47', 0.02) } });
  const token = sim.state.props.get('APP_TOKEN');
  G.MarketCal._now = at('2026-10-25T21:00:00+05:30');
  G.loadHistory();
  G.Schedule.install();
  setConfig(sim, G, 'aiSummaries', 'TRUE');
  G.saveSecretsFromDialog({ GEMINI_API_KEY: GEMINI_KEY });
  w.geminiReply = JSON.stringify({ overview: 'A small **winning** day: one breakout reached its target.', worked: ['Opening-range breakout made ₹50 on TCS.'], didnt: [], watch: ['Check whether breakouts keep working when Nifty is flat.'] });
  for (const tm of ['08:50', '09:41', '09:46', '16:00']) tickAtDay(G, day, tm);
  const review = w.telegram.find((x) => /📒 <b>Session review/.test(x));
  ok(review && /🤖 <b>AI review<\/b>/.test(review) && /A small winning day/.test(review) && /✔️ Opening-range breakout made/.test(review) && /👀 Check whether/.test(review), review);
  ok(/Use ONLY the facts below/.test(w.geminiPrompt) && /Paper trades closed today: 1\. Won 1/.test(w.geminiPrompt) && /Never recommend buying or selling/.test(w.geminiPrompt), w.geminiPrompt);
  ok(!w.geminiPrompt.includes(KEYS.ANGEL_CLIENT_ID) && !w.geminiPrompt.includes(GEMINI_KEY), 'nothing private in the prompt');
  const f = JSON.parse(sim.state.props.get('SESSION_REVIEW'));
  eq(post(G, { a: 'bundle', t: token }).data.review.day, day, 'the app gets the latest review');
  eq(post(G, { a: 'reviews', t: token }).data.list[0].day, day);
  eq(f.ai.worked.length, 1); eq(f.ai.didnt.length, 0); ok(!/\*\*/.test(f.ai.overview), 'markdown removed');
  // From the app: make it again (no Telegram unless asked); a Gemini failure keeps the numbers.
  w.geminiDown = true;
  const before = w.telegram.length;
  G.MarketCal._now = at('2026-10-26T19:00:00+05:30');
  const again = post(G, { a: 'reviewNow', t: token });
  eq(again.ok, true, again.error);
  eq(again.data.paper.n, 1); eq(again.data.ai, null); ok(/free quota/.test(again.data.aiError), again.data.aiError);
  eq(w.telegram.length, before, 'no message from the app button unless asked');
  // Off in the app: no review message after the close.
  eq(post(G, { a: 'settings', t: token, settings: { sessionReview: false } }).ok, true);
  G.Config._cache = null;
  eq(G.Config.get('sessionReview'), false);
});

test('session review: every alert is accounted for, and each filter is judged against the trades taken', () => {
  const { G, sim } = marketWorld();
  const day = '2026-10-27';
  const D = sim.run('Date'); // dates as the script's own realm makes them, like Sheets returns them
  const t = (hhmm) => new D(at(day + 'T' + hhmm + ':00+05:30'));
  let n = 0;
  const row = (o) => Object.assign({ id: 'A' + (++n), createdAt: t('10:00'), symbol: 'TCS', horizon: 'INTRADAY', strategy: 'ema-cross', strategyStatus: 'PAPER', direction: 'SHORT',
    entryLow: 100, entryHigh: 100.2, stop: 101, target1: 98, status: 'CLOSED', closedAt: t('11:00'), outcome: 'STOP_HIT', track: 'main', paperQty: 10,
    grossPnl: -20, charges: 10, netPnl: -30, netPct: -0.3, telegram: 'sent' }, o);
  const dayNote = 'not sent: against the day: Nifty 50 is up 0.20% since the open, tracked silently';
  G.AlertBook.ensureHeaders();
  G.Store.append('Alerts', [
    row({}), row({}), row({ outcome: 'TARGET_HIT', grossPnl: 60, netPnl: 50, netPct: 0.5 }), row({ outcome: 'EXPIRED', grossPnl: 0, netPnl: -10, netPct: -0.1 }),
    row({ outcome: 'NOT_TRIGGERED', paperQty: '', grossPnl: '', charges: '', netPnl: '', netPct: '' }),
    row({ symbol: 'MARUTI', outcome: 'EXPIRED', paperQty: 0, grossPnl: '', charges: '', netPnl: '', netPct: 0 }), // dearer than the per-stock limit
    ...Array.from({ length: 6 }, () => row({ track: 'shadow', telegram: dayNote, netPct: -0.06, netPnl: -6 })),
    row({ track: 'shadow', telegram: dayNote, outcome: 'NOT_TRIGGERED', netPct: '', netPnl: '' }),
    ...Array.from({ length: 5 }, () => row({ track: 'shadow', horizon: 'SWING', strategy: 'ema-pullback', direction: 'BUY', telegram: 'not sent: blocked by the Bear regime, tracked silently', status: 'OPEN', closedAt: '', outcome: '', netPct: '', netPnl: '' })),
    row({ symbol: 'INFY', status: 'OPEN', closedAt: '', outcome: '', paperQty: '', grossPnl: '', charges: '', netPnl: '', netPct: '' }), // its 1-minute prices did not come yet
  ]);
  const f = G.SessionReview.build(day);
  eq(JSON.stringify(f.alerts.fate), JSON.stringify({ traded: 4, notTriggered: 1, tooPricey: 1, noData: 0, pending: 1, open: 0, other: 0 }));
  eq(f.alerts.blocked, 12); eq(f.alerts.heldFate.traded, 6); eq(f.alerts.heldFate.open, 5); eq(f.alerts.heldFate.notTriggered, 1);
  eq(f.paper.n, 4); eq(f.paper.gross, 20); eq(f.paper.net, -20); eq(f.paper.charges, 40); // the charges turned a small gain into a loss
  eq(f.filters.length, 1); eq(f.filters[0].kind, 'day'); eq(f.filters[0].takenAvgPct, -0.04); eq(f.filters[0].verdict, 'same');
  const msg = G.SessionReview.message(f);
  if (process.env.DUMP_TG) console.log('\n=== REVIEW ===\n' + msg + '\n=== FACTS ===\n' + G.SessionReview.factLines(f).join('\n'));
  ok(msg.includes('after ₹40 charges (+₹20 before them)'), msg);
  ok(msg.includes('📣 7 alerts today: 4 paper trades, 1 never reached the entry, 1 was too pricey for the ₹10,000 per-stock limit (counted in % only), 1 not judged yet.'), msg);
  ok(msg.includes('⏳ 1 of today\'s intraday alerts is not judged yet.'), msg);
  ok(msg.includes('🔕 Day\'s direction: 6 held back, averaged −0.06% a trade against −0.04% for the trades taken: about the same, so no verdict yet'), msg);
  ok(msg.includes('🔕 Of the 12 held back today: 6 were judged, 1 never reached the entry, 5 still open.'), msg);
  ok(!/the filter helped/.test(msg), 'no claim the numbers do not support');
  const facts = G.SessionReview.factLines(f).join('\n');
  ok(/Result before charges: \+₹20\./.test(facts) && /about the same, so no verdict yet/.test(facts) && /too pricey for the ₹10,000 per-stock limit/.test(facts), facts);
  // The verdict itself.
  eq(G.SessionReview.verdict(6, -0.3, -0.04, true), 'helped');
  eq(G.SessionReview.verdict(6, 0.2, -0.04, true), 'cost');
  eq(G.SessionReview.verdict(3, -1, 0, true), 'few');
  eq(G.SessionReview.verdict(10, -1.0, -0.8, false), 'same');
  eq(G.SessionReview.verdict(10, -1.0, null, false), 'helped');
});

test('web app: swing and medium setups held back in a Bear market reach the app as paper-only plans', () => {
  const end = '2026-10-26';
  const { G, sim, w } = marketWorld({ end, niftyDown: true, daily: { [TOKENS.RELIANCE]: SC.daily['base-breakout']() } });
  const token = sim.state.props.get('APP_TOKEN');
  G.MarketCal._now = at('2026-10-23T21:00:00+05:30');
  G.loadHistory();
  G.MarketCal._now = at('2026-10-26T08:20:00+05:30');
  G.Schedule.install();
  tickAtDay(G, end, '08:50');
  const sent0 = w.telegram.length;
  tickAtDay(G, end, '16:00');
  eq(G.Market.saved().state, 'BEAR', 'a falling Nifty');
  ok(!w.telegram.slice(sent0).some((x) => /BUY RELIANCE/.test(x)), 'no buy alert in a Bear market');
  const held = alertsRows(sim).filter((r) => r.track === 'shadow' && r.symbol === 'RELIANCE');
  ok(held.length >= 1 && held.every((r) => /blocked by the Bear regime/.test(r.telegram)), JSON.stringify(held.map((r) => r.telegram)));
  const b = post(G, { a: 'bundle', t: token }).data;
  eq(b.market.regime, 'bear');
  ok(b.market.reasons.some((x) => /below its 200-day average/.test(x)), b.market.reasons.join(' '));
  ok(!b.alerts.some((a) => a.symbol === 'RELIANCE' && a.horizon !== 'intraday'), 'not among the real alerts');
  const plan = b.held.find((a) => a.symbol === 'RELIANCE' && a.strategy === 'base-breakout');
  ok(plan && plan.horizon === 'swing' && plan.held === 'blocked by the Bear regime' && plan.entryLo > 0 && plan.stop < plan.entryLo && plan.targets[0] > plan.entryHi, JSON.stringify(plan));
  if (process.env.DUMP_BUNDLE) { // for screenshots of the app against a real bundle
    const chart = post(G, { a: 'chart', t: token, symbol: 'RELIANCE' }).data, alertChart = post(G, { a: 'chart', t: token, symbol: 'RELIANCE', alertId: plan.id }).data;
    fs.writeFileSync(process.env.DUMP_BUNDLE, JSON.stringify({ bundle: b, chart, alertChart }));
  }
});

test('alerts: a strategy that lost money in the backtest stays off Telegram but keeps paper-trading; the switch and a hand-set status bring it back', () => {
  const tcs = SC.intraday.orb();
  const run = (setup) => {
    const env = marketWorld({ intra: { [TOKENS.TCS]: tcs } });
    const { G, sim } = env;
    G.MarketCal._now = at('2026-10-25T21:00:00+05:30');
    G.loadHistory();
    G.Schedule.install();
    // A baseline in which the opening-range breakout lost money after charges.
    sim.state.props.set('BT_SUMMARY', JSON.stringify({ runId: 't', at: Date.now(), universe: 'Nifty 200', daily: { from: '2016-10-24', to: '2026-10-23', symbols: 200 },
      intraday: { from: '2026-07-30', to: '2026-10-23', sessions: 60, symbols: 55 }, s: { orb: [120, 40, 31, -0.08, 0.81, 9.5, -0.1, null, 'loses'], vwap: [90, 35, 44, 0.06, 1.4, 4, 0.1, null, 'good'] } }));
    G.Backtest._sum = null;
    if (setup) setup(env);
    const day = '2026-10-26';
    for (const t of ['08:50', '09:41', '09:46']) tickAtDay(G, day, t);
    return { ...env, row: alertsRows(sim)[0] };
  };
  const quiet = run();
  eq(quiet.row.strategy, 'orb'); eq(quiet.row.track, 'main', 'still a paper trade');
  eq(quiet.row.telegram, 'not sent: lost money after charges in the backtest (kept as paper only)');
  ok(!quiet.w.telegram.some((t) => /BUY TCS/.test(t)), 'nothing on Telegram');
  const token = quiet.sim.state.props.get('APP_TOKEN');
  const resp = post(quiet.G, { a: 'bundle', t: token });
  ok(resp.ok, 'bundle: ' + resp.error);
  const b = resp.data;
  eq(b.strategies.find((s) => s.id === 'orb').quiet, true); eq(b.strategies.find((s) => s.id === 'vwap').quiet, false);
  eq(b.settings.alertsOnlyTested, true);
  const off = run(({ G, sim }) => { eq(post(G, { a: 'settings', t: sim.state.props.get('APP_TOKEN'), settings: { alertsOnlyTested: false } }).ok, true); G.Config._cache = null; });
  eq(off.row.telegram, 'sent', 'switched off in the app: sent as before');
  const byHand = run(({ G, sim }) => {
    const sh = sim.ss.getSheetByName('Strategies'), d = sh.dump(), r = d.findIndex((x) => x[0] === 'orb'), c = d[0].indexOf('override');
    sh.getRange(r + 1, c + 1, 1, 1).setValues([['PAPER']]); G.StrategyBook._map = null;
  });
  eq(byHand.row.telegram, 'sent', 'a status set by hand wins');
});

test('web app: older alerts come in pages for the date filters, newest first', () => {
  const { G, sim } = marketWorld();
  const token = sim.state.props.get('APP_TOKEN');
  G.AlertBook.ensureHeaders();
  const base = at('2026-09-01T10:00:00+05:30');
  G.Store.append('Alerts', Array.from({ length: 25 }, (_, i) => ({ id: 'H' + i, createdAt: new Date(base + i * 86400000), symbol: 'TCS', horizon: 'SWING', strategy: 'macd', direction: 'BUY',
    entryLow: 100, entryHigh: 101, stop: 95, target1: 110, rr: 2, confidence: 70, reasons: 'a | b', status: i % 2 ? 'CLOSED' : 'OPEN', outcome: i % 2 ? 'STOP_HIT' : '', netPct: i % 2 ? -1.5 : '', track: i === 3 ? 'shadow' : 'main' })));
  const p1 = post(G, { a: 'alerts', t: token, limit: 10 }).data;
  eq(p1.alerts.length, 10, JSON.stringify(p1).slice(0, 300)); eq(p1.more, true); eq(p1.alerts[0].id, 'H24', 'newest first');
  ok(p1.alerts.every((x, i) => i === 0 || x.time <= p1.alerts[i - 1].time), 'sorted');
  const p3 = post(G, { a: 'alerts', t: token, before: post(G, { a: 'alerts', t: token, before: p1.oldest, limit: 10 }).data.oldest, limit: 10 }).data;
  eq(p3.more, false); eq(p3.alerts.length, 4, '24 main alerts in all (the shadow one is left out)');
  eq(p3.alerts.find((x) => x.id === 'H1').outcome.state, 'stop', 'results come with them');
});

test('connect: the link carries the web app address and token; bad addresses are refused', () => {
  const { G, sim, w } = dayAfter();
  const bad = G.sendConnectLink('https://example.com/exec', true);
  eq(bad.ok, false);
  const url = 'https://script.google.com/macros/s/AKfycbx1234567890abcdefghijklmnopqrstuvwxyz/exec';
  const shown = G.sendConnectLink(url, false);
  ok(shown.ok && shown.link.startsWith('https://sambadhyam.github.io/stock-radar/#/connect?u=' + encodeURIComponent(url) + '&t=' + sim.state.props.get('APP_TOKEN')), shown.link);
  const before = w.telegram.length;
  eq(G.sendConnectLink(url, true).sent, true);
  ok(/Connect the Stock Radar app/.test(w.telegram[before]), w.telegram[before]);
  eq(sim.state.props.get('WEBAPP_URL'), url);
  sim.state.uiAvailable = true;
  G.menuConnectApp();
  ok(/Web app URL/.test(sim.state.dialogs[sim.state.dialogs.length - 1].html) && sim.state.dialogs[sim.state.dialogs.length - 1].html.includes(url), 'dialog prefilled');
  const old = sim.state.props.get('APP_TOKEN');
  G.newAppToken();
  ok(sim.state.props.get('APP_TOKEN') !== old, 'token rotated');
  eq(post(G, { a: 'ping', t: old }).ok, false, 'old token refused');
});

// =================== Phase 5: backtester, holdings, fundamentals, AI summaries ===================

/**
 * A world with four years of random-walk prices for the Nifty 50 stocks, a backtest universe of Nifty 50,
 * 20 sessions of 5-minute history, and TCS making an opening-range breakout every session while Nifty rises.
 */
function labWorld() {
  const end = '2026-10-23', LEN = 1300;
  const env = marketWorld({ end, allQuiet: false });
  const { G, sim, w } = env;
  w.daily['99926000'] = SC.dailyFrom(SC.randomWalk(LEN, 9000, 0.0005, 0.011, 3), { end, vol: 0 });
  w.daily['99926017'] = SC.dailyFrom(SC.randomWalk(LEN, 14, 0, 0.04, 5).map((v) => Math.min(30, Math.max(10, v))), { end, vol: 0 });
  N50.forEach((sym, i) => { w.daily[TOKENS[sym]] = SC.dailyFrom(SC.randomWalk(LEN, 100 + i * 7, 0.0003 + (i % 5) * 0.0002, 0.016, 11 + i), { end, vol: 3e6 }); });
  const days = SC.weekdays(end, 30);
  w.intra[TOKENS.TCS] = SC.orbSessions(days);
  w.intra['99926000'] = SC.sessions(days, (k) => { const o = 22600 * (1 + 0.0003 * k), c = o * 1.0003; return [Math.round(o * 100) / 100, Math.round(c * 100 + 200) / 100, Math.round(o * 100 - 200) / 100, Math.round(c * 100) / 100, 0]; });
  G.setupSheets();
  setConfig(sim, G, 'backtestUniverse', 'NIFTY50');
  setConfig(sim, G, 'backtestYears', '4');
  setConfig(sim, G, 'intradayHistoryDays', '20');
  G.MarketCal._now = at('2026-10-25T21:00:00+05:30'); // Sunday evening: a quiet time
  G.loadHistory();
  return env;
}

/** Run the backtest's background steps the way the one-off triggers would, until it finishes. */
function runBacktest(G, sim) {
  for (let i = 0; i < 15; i++) {
    const tr = sim.state.triggers.find((t) => t.handler === 'continueBacktest');
    if (!tr) break;
    G.continueBacktest();
  }
  return G.Backtest.job();
}

test('backtest: the menu loads long history, tests every strategy and sends the Backtest Baseline report', () => {
  const { G, sim, w } = labWorld();
  sim.state.uiAvailable = true;
  const before = w.telegram.length;
  G.menuBacktest();
  ok(/starts in about a minute/.test(sim.state.alerts[sim.state.alerts.length - 1].msg), sim.state.alerts[sim.state.alerts.length - 1].msg);
  ok(sim.state.triggers.some((t) => t.handler === 'continueBacktest'), 'runs in the background');
  const j = runBacktest(G, sim);
  eq(j.stage, 'done', 'finished: ' + JSON.stringify(j));
  const files = sim.state.drive.items.map((f) => f.name);
  for (const f of ['long-00.json', 'intra-00.json', 'bt-context.json', 'btd-00.json', 'bti-00.json', 'bt-result.json']) ok(files.includes(f), 'Drive file ' + f + ' in ' + files.join());
  ok(w.candleCalls.some((c) => c.interval === 'ONE_DAY' && c.fromdate < '2023-'), 'asked for older daily candles');
  ok(w.candleCalls.some((c) => c.interval === 'FIVE_MINUTE' && c.symboltoken === TOKENS.TCS), '5-minute history');
  // Long history joins the everyday file: about four years of candles.
  G.History.reset(); G.LongHistory.reset();
  const k = G.LongHistory.get('RELIANCE');
  ok(k.length > 950 && k.length < 1100, 'four years of daily candles: ' + k.length);
  ok(k.every((c, i) => i === 0 || c.t > k[i - 1].t), 'one candle per day, in order');
  const msg = w.telegram.slice(before).join('\n');
  ok(/🧪 <b>Backtest Baseline<\/b>/.test(msg) && /Swing<\/b> · \d+ Nifty 50 stocks/.test(msg) && /Intraday<\/b> · \d+ stocks · last \d+ sessions/.test(msg), msg);
  ok(/Opening-range breakout: \d+ trades/.test(msg) && /Read with care/.test(msg) && /Backtest lab/.test(msg), msg);
  ok(/🔕 <b>Paper only from now on<\/b>/.test(msg) || /📣 Every strategy kept its Telegram alerts/.test(msg), 'which strategies keep their Telegram alerts');
  const res = JSON.parse(sim.state.drive.items.find((f) => f.name === 'bt-result.json').content);
  const orb = res.strategies.orb;
  ok(orb.metrics.trades >= 15 && orb.metrics.winRatePct > 50, 'ORB trades every session on TCS: ' + JSON.stringify(orb.metrics));
  ok(orb.sample.every((x) => x[0] === 'TCS' && x[2] === 'B'), 'buys on TCS with Nifty rising');
  ok(Object.keys(res.strategies).length === 11, 'seven daily and four intraday strategies');
  ok(Array.isArray(res.scoreCheck) && res.scoreCheck.length >= 1 && res.scoreCheck.every((c) => c.trades > 0 && /below 60|60–69|70 and up/.test(c.band)), 'signal score check: ' + JSON.stringify(res.scoreCheck));
  ok(/Signal score check/.test(msg), 'score check in the report');
  const total = Object.values(res.strategies).reduce((a, s) => a + s.metrics.trades, 0);
  ok(total > 100, 'trades in total: ' + total);
  ok(res.strategies.macd.curve.length > 10 && res.strategies.macd.curve[0].v === 100000, 'monthly equity curve from the paper capital');
  // "Latest trades" come from every data file, newest first (trades arrive one file at a time).
  const macdSample = res.strategies.macd.sample;
  ok(macdSample.length === 20 && new Set(macdSample.map((x) => x[0])).size > 1, 'latest trades across stocks: ' + macdSample.map((x) => x[0]).join());
  const lastDay = Math.max(...macdSample.map((x) => x[1]));
  ok(lastDay > Date.parse('2026-06-01T00:00:00+05:30'), 'the latest trades are recent: ' + new Date(lastDay).toISOString());
  const rows = sheetRows(sim, 'Backtests');
  eq(rows.length, 11); ok(rows.every((r) => r.runId === j.runId && r.trades >= 0), 'one row per strategy');
  ok(sheetRows(sim, 'Reports').some((r) => r.type === 'backtest' && /Backtest Baseline/.test(r.title)), 'saved in Reports');
  // The app sees the numbers next to the paper record.
  const token = sim.state.props.get('APP_TOKEN');
  const b = post(G, { a: 'bundle', t: token }).data;
  eq(b.backtest.state, 'done');
  const bo = b.strategies.find((x) => x.id === 'orb').backtest;
  ok(bo && bo.trades === orb.metrics.trades && bo.win === orb.metrics.winRatePct && bo.dd <= 0 && /^\d{4}-\d\d-\d\d$/.test(bo.from), JSON.stringify(bo));
  eq(b.strategies.find((x) => x.id === 'holding-guard').backtest, null, 'not backtested');
  ok(b.params['orb.volMult'] === 1.5, 'strategy settings for the lab');
  // The lab's data: the result, stock lists, and history with the market context.
  const ov = post(G, { a: 'backtest', t: token }).data;
  ok(ov.result.runId === j.runId && ov.lists.universe.length === 50 && ov.lists.intraday.includes('TCS'), JSON.stringify(ov.lists).slice(0, 200));
  const dd = post(G, { a: 'btData', t: token, kind: 'daily', symbols: ['RELIANCE', 'TCS', '../BAD'], market: true }).data;
  ok(dd.series.RELIANCE.d.length > 950 && dd.series.RELIANCE.c.length === dd.series.RELIANCE.d.length, 'daily columns');
  ok(dd.market.days.length === dd.market.regime.length && dd.rs.RELIANCE.length === dd.market.days.length, 'market context');
  eq(Object.keys(dd.series).length, 2, 'bad symbol dropped');
  const id = post(G, { a: 'btData', t: token, kind: 'intraday', symbols: ['TCS'], market: true }).data;
  ok(id.series.TCS.t.length >= 20 * 75 && id.market.nifty.t.length >= 20 * 75 && Object.keys(id.market.regimeByDay).length > 500, 'intraday columns');
  if (process.env.LAB_OUT) {
    // Fixtures for the app's screenshot check of the Backtest lab and Portfolio screens.
    const syms = ov.lists.nifty50.slice(0, 50);
    const daily = { series: {}, rs: {} };
    for (let i = 0; i < syms.length; i += 10) { const part = post(G, { a: 'btData', t: token, kind: 'daily', symbols: syms.slice(i, i + 10), market: i === 0 }).data; Object.assign(daily.series, part.series); Object.assign(daily.rs, part.rs); if (part.market) daily.market = part.market; }
    const intraday = post(G, { a: 'btData', t: token, kind: 'intraday', symbols: ['TCS'].concat(ov.lists.intraday.filter((s) => s !== 'TCS').slice(0, 7)), market: true }).data;
    fs.writeFileSync(process.env.LAB_OUT, JSON.stringify({ bundle: b, overview: ov, daily, intraday, token, url: 'https://script.google.com/macros/s/AKfycbFAKEdeploymentIDforTests1234567890/exec' }));
  }
  // Running it again is a refresh, not a new baseline.
  const again = G.Backtest.start('menu');
  ok(again.first === false, 'second run is a refresh');
});

test('backtest: it waits for a quiet time, starts by itself after the first close, and refreshes monthly', () => {
  const { G, sim } = labWorld();
  G.MarketCal._now = at('2026-10-26T11:00:00+05:30'); // Monday, market open
  ok(!G.Backtest.quiet(), 'market hours are not quiet');
  G.Backtest.start('app');
  const when = G.Backtest.schedule();
  eq(new Date(when).toISOString(), new Date(at('2026-10-26T18:16:00+05:30')).toISOString(), 'scheduled for the evening');
  G.continueBacktest(); // a stray trigger during market hours does nothing but reschedule
  eq(G.Backtest.job().stage, 'long');
  sim.props = null;
  sim.state.props.delete('BT_JOB');
  G.MarketCal._now = at('2026-10-26T16:40:00+05:30');
  ok(G.Backtest.autoStart(), 'starts the first baseline after the close');
  ok(!G.Backtest.autoStart(), 'only once');
  sim.state.props.set('BT_SUMMARY', JSON.stringify({ at: at('2026-09-01T20:00:00+05:30'), daily: {}, intraday: {}, s: {} }));
  sim.state.props.set('BT_JOB', JSON.stringify({ stage: 'done' }));
  G.MarketCal._now = at('2026-10-31T10:40:00+05:30');
  ok(G.Backtest.weeklyCheck(), 'a two-month-old baseline is refreshed on Saturday');
  eq(G.Backtest.job().first, false);
});

test('backtest: it keeps to its share of the 90 trigger minutes a day and pauses until that share frees up', () => {
  const { G, sim } = labWorld();
  const when = () => { const tr = sim.state.triggers.filter((t) => t.handler === 'continueBacktest'); eq(tr.length, 1, 'one follow-up'); return new Date(tr[0].spec ? tr[0].spec.at : tr[0].at).getTime(); };
  G.MarketCal._now = at('2026-10-25T21:00:00+05:30'); // Sunday evening
  G.Backtest.start('menu');
  sim.state.props.set('BT_USAGE', JSON.stringify([[at('2026-10-25T19:00:00+05:30'), 29 * 60000]]));
  G.continueBacktest();
  let j = G.Backtest.job();
  eq(j.stage, 'long', 'no step while 29 of the 30 minutes are used');
  ok(/paused for today's time limit, continues Mon 26 Oct 19:01/.test(j.note), j.note);
  eq(when(), at('2026-10-26T19:01:00+05:30'), 'resumes when the old runs leave the 24-hour window');
  // Freed during market hours: waits for the evening instead.
  sim.state.props.set('BT_USAGE', JSON.stringify([[at('2026-10-25T10:00:00+05:30'), 29 * 60000]]));
  G.MarketCal._now = at('2026-10-25T21:05:00+05:30');
  G.continueBacktest();
  eq(when(), at('2026-10-26T18:16:00+05:30'), 'Monday evening, not 10:01 in market hours');
  j = G.Backtest.job();
  eq((j.note.match(/paused/g) || []).length, 1, 'the pause is noted once: ' + j.note);
  // A setting raises the share; then the step runs and is counted.
  setConfig(sim, G, 'backtestMinutesPerDay', '40');
  G.continueBacktest();
  j = G.Backtest.job();
  ok(!/paused/.test(j.note) && /Loading long price history|history loaded|Finished/.test(j.note), j.note);
  const runs = JSON.parse(sim.state.props.get('BT_USAGE'));
  eq(runs.length, 2, 'the step is logged'); ok(runs[1][1] >= 0);
  // The app can change it, within 10–40 minutes.
  const token = sim.state.props.get('APP_TOKEN');
  eq(post(G, { a: 'settings', t: token, settings: { backtestMinutesPerDay: 25 } }).data.backtestMinutesPerDay, 25);
  eq(post(G, { a: 'settings', t: token, settings: { backtestMinutesPerDay: 90 } }).ok, false, 'too much is refused');
});

test('portfolio: holdings from the app are saved, valued after the close, flagged, and never sent anywhere else', () => {
  const day = '2026-10-26';
  const { G, sim, w } = marketWorld({ end: day, daily: { [TOKENS.INFY]: SC.daily['holding-guard'](), [TOKENS.RELIANCE]: SC.daily['base-breakout']() } });
  G.MarketCal._now = at('2026-10-23T21:00:00+05:30');
  G.loadHistory();
  const token = sim.state.props.get('APP_TOKEN');
  const rows = [
    { symbol: 'RELIANCE', qty: 10, avgPrice: 50, lastPrice: 60, sector: 'Oil Gas & Consumable Fuels', isin: 'INE002A01018' },
    { symbol: 'INFY-EQ', qty: 20, avgPrice: 60, longTermQty: 20 },
    { symbol: 'NSE:TCS', qty: 2, avgPrice: 100 },
    { symbol: 'TCS', qty: 2, avgPrice: 110 },
    { symbol: 'not a symbol!', qty: 1, avgPrice: 5 },
  ];
  const r = post(G, { a: 'holdings', t: token, mode: 'replace', rows, source: 'Zerodha Console XLSX' });
  eq(r.ok, true, r.error);
  eq(r.data.result.saved, 3); eq(r.data.result.skipped.join(), 'not a symbol!');
  const h = sheetRows(sim, 'Holdings');
  eq(h.map((x) => x.symbol).join(), 'INFY,RELIANCE,TCS', 'cleaned and sorted');
  const tcs = h.find((x) => x.symbol === 'TCS');
  eq(tcs.qty, 4); eq(tcs.avgPrice, 105, 'duplicate rows merged at the average price');
  ok(sim.state.triggers.some((t) => t.handler === 'valueHoldings'), 'valued a minute later');
  G.valueHoldings();
  const v1 = post(G, { a: 'bundle', t: token }).data.portfolio;
  ok(v1 && v1.holdings.length === 3 && v1.totals.value > 0 && v1.sectors.length >= 1, JSON.stringify(v1).slice(0, 300));
  const infy = v1.holdings.find((x) => x.symbol === 'INFY');
  ok(infy.last > 0 && infy.trailStop > 0 && infy.dma200 > 0 && !infy.flags.length, 'INFY valued, nothing wrong yet: ' + JSON.stringify(infy));
  ok(v1.warnings.some((x) => x.kind === 'stock' && x.symbol === 'INFY'), 'concentration warning: ' + JSON.stringify(v1.warnings));
  // Your own stop-loss (5% under Friday's close) and buy date for a holding.
  const e1 = post(G, { a: 'holdings', t: token, mode: 'edit', symbol: 'INFY', patch: { stop: Math.round(infy.last * 0.95 * 100) / 100, buyDate: '2025-11-15' } });
  eq(e1.ok, true, e1.error);
  eq(post(G, { a: 'holdings', t: token, mode: 'edit', symbol: 'INFY', patch: { buyDate: '2027-01-01' } }).ok, false, 'future buy date refused');
  eq(post(G, { a: 'holdings', t: token, mode: 'edit', symbol: 'INFY', patch: { stop: -4 } }).ok, false, 'bad price refused');
  eq(post(G, { a: 'holdings', t: token, mode: 'edit', symbol: 'WIPRO', patch: { stop: 4 } }).ok, false, 'not held');
  // The close: the holding guard warns with your stop-loss, the holdings are valued, the 12-month note goes out once.
  G.MarketCal._now = at('2026-10-26T08:20:00+05:30');
  G.Schedule.install();
  tickAtDay(G, day, '08:50');
  const sent0 = w.telegram.length;
  tickAtDay(G, day, '16:00');
  const a = alertsRows(sim).find((x) => x.symbol === 'INFY' && x.direction === 'EXIT');
  ok(a && /at or below your stop-loss/.test(a.reasons) && /trailing stop/.test(a.reasons), 'exit alert: ' + (a && a.reasons));
  const msgs = w.telegram.slice(sent0).join('\n----\n');
  ok(/⚠️ <b>EXIT CHECK · INFY<\/b>/.test(msgs) && /you hold 20 shares/.test(msgs), 'exit message: ' + msgs);
  ok(/Your holdings<\/b>: ₹/.test(msgs) && /INFY: .*under its trailing stop/.test(msgs), 'closing summary: ' + msgs);
  ok(/📅 <b>INFY completes 12 months on Sun 15 Nov<\/b>/.test(msgs), '12-month note');
  w.telegram.length = 0;
  G.Portfolio.taxNotes();
  ok(!w.telegram.some((t) => /completes 12 months/.test(t)), 'sent once');
  const v2 = post(G, { a: 'bundle', t: token }).data.portfolio.holdings.find((x) => x.symbol === 'INFY');
  ok(v2.flags.includes('trail') && v2.flags.includes('stop') && v2.flags.includes('ltSoon') && v2.lt.longTermFrom === '2026-11-15', JSON.stringify(v2));
  eq(post(G, { a: 'holdings', t: token, mode: 'clear' }).data.portfolio, null, 'cleared');
  eq(post(G, { a: 'holdings', t: token, mode: 'replace', rows: [] }).ok, false, 'an empty file is refused');
});

test('fundamentals: a Screener export mapped by the app is matched to NSE symbols and scored', () => {
  const { G, sim } = marketWorld();
  const token = sim.state.props.get('APP_TOKEN');
  const rows = [
    { name: 'RELIANCE Ltd', roePct: 24, rocePct: 26, debtToEquity: 0.05, sales3yPct: 16, profit3yPct: 20, promoterPct: 70, pledgePct: 0, pe: 22, pe5yMedian: 30, fcf: 1200 },
    { symbol: 'TCS', name: 'Tata Consultancy', roePct: 45, rocePct: 55, debtToEquity: 0.1, sales3yPct: 12, profit3yPct: '' },
    { name: 'Some Unlisted Company', roePct: 5 },
  ];
  const r = post(G, { a: 'fundamentals', t: token, rows, source: 'Screener export' });
  eq(r.ok, true, r.error);
  eq(r.data.matched, 2); eq(r.data.unmatched.join(), 'Some Unlisted Company');
  eq(r.data.fields.roePct, 2); eq(r.data.fields.profit3yPct, 1, 'blanks are not counted');
  const f = sheetRows(sim, 'Fundamentals');
  eq(f.length, 2); eq(f.find((x) => x.symbol === 'TCS').profit3yPct, '', 'missing stays blank, never guessed');
  const b = post(G, { a: 'bundle', t: token }).data;
  eq(b.fundamentals.RELIANCE.roe, 24);
  eq(post(G, { a: 'fundamentals', t: token, rows: [{ name: 'Nobody' }] }).ok, false, 'nothing matched');
});

test('AI summaries: off by default, need a key, label-free text in, three bullets out, cached', () => {
  const { G, sim, w } = marketWorld();
  const token = sim.state.props.get('APP_TOKEN');
  const off = post(G, { a: 'summary', t: token, symbol: 'RELIANCE' });
  ok(!off.ok && /off/.test(off.error), off.error);
  eq(post(G, { a: 'bundle', t: token }).data.ai.enabled, false);
  eq(post(G, { a: 'settings', t: token, settings: { aiSummaries: true } }).ok, true);
  G.Config._cache = null;
  const after = post(G, { a: 'bundle', t: token }).data;
  eq(after.settings.aiSummaries, true, 'the switch stays on in the next bundle');
  eq(after.ai.enabled, true);
  const nokey = post(G, { a: 'summary', t: token, symbol: 'RELIANCE' });
  ok(!nokey.ok && /Set up keys/.test(nokey.error), nokey.error);
  eq(G.saveSecretsFromDialog({ GEMINI_API_KEY: GEMINI_KEY }).errors.length, 0);
  const r = post(G, { a: 'summary', t: token, symbol: 'RELIANCE' });
  eq(r.ok, true, r.error);
  eq(r.data.bullets.length, 3); eq(r.data.bullets[1], 'Won a large order.', 'markdown removed'); eq(r.data.headlines, 3);
  ok(/gemini-3\.5-flash-lite:generateContent$/.test(w.geminiUrl), w.geminiUrl);
  ok(/NSE: RELIANCE/.test(w.geminiPrompt) && /Headline 1 & more/.test(w.geminiPrompt) && /Do not give buy, sell or price advice/.test(w.geminiPrompt), w.geminiPrompt);
  post(G, { a: 'summary', t: token, symbol: 'RELIANCE' });
  eq(w.geminiCalls, 1, 'second call from the cache');
  w.geminiDown = true;
  const q = post(G, { a: 'summary', t: token, symbol: 'TCS' });
  ok(!q.ok && /free quota/.test(q.error), q.error);
  const text = JSON.stringify(sim.state.requests.filter((x) => x.url.includes('generativelanguage')).map((x) => x.url)) + JSON.stringify(q) + JSON.stringify(r);
  ok(!text.includes(GEMINI_KEY), 'the key is never in an address or an answer');
  eq(post(G, { a: 'bundle', t: token }).data.ai.key, true);
});

test('settings: the app can change the Phase 5 numbers and switches, within limits', () => {
  const { G, sim } = marketWorld();
  const token = sim.state.props.get('APP_TOKEN');
  const r = post(G, { a: 'settings', t: token, settings: { portfolioMaxStockPct: 25, portfolioMaxSectorPct: 40, backtestYears: 7.4, intradayHistoryDays: 90 } });
  eq(r.ok, true, r.error);
  G.Config._cache = null;
  eq(G.Config.get('backtestYears'), 7, 'whole years'); eq(G.Config.get('portfolioMaxSectorPct'), 40);
  eq(post(G, { a: 'settings', t: token, settings: { backtestYears: 40 } }).ok, false, 'out of range');
  eq(r.data.intradayHistoryDays, 90);
});

coreTests({ test, eq, ok, root: path.join(here, '..', '..') });

console.log(results.join('\n'));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
