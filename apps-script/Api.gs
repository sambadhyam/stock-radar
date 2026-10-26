/**
 * Stock Radar — Api.gs
 * Messages out (Telegram and email) and the Web App API the phone app talks to.
 *
 * The app sends POST requests with a plain-text JSON body {a: action, t: token, ...}.
 * Plain text avoids the browser's CORS preflight, which Apps Script cannot answer.
 * Every request must carry the app token kept in Script Properties; nothing is returned without it,
 * and no key, token or account detail is ever included in a response.
 */

var Notify = {
  /** Escape text for Telegram's HTML mode. */
  esc: function (s) {
    return String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  },

  /** Send an HTML message to your Telegram chat. Long messages are split. Throws if Telegram refuses. */
  telegram: function (html) {
    var token = Secrets.get('TG_BOT_TOKEN'), chat = Secrets.get('TG_CHAT_ID');
    if (!token || !chat) throw new Error('Telegram is not set up. Use Stock Radar → 2. Set up keys.');
    var parts = this.split(String(html), 3800);
    parts.forEach(function (text, i) {
      if (i) Utilities.sleep(1100);
      var res = Http.request('https://api.telegram.org/bot' + token + '/sendMessage', {
        method: 'post', contentType: 'application/json',
        payload: JSON.stringify({ chat_id: chat, text: text, parse_mode: 'HTML', disable_web_page_preview: true }),
      }, { retries: 2 });
      if (!(res.json && res.json.ok)) {
        var why = res.json && res.json.description ? res.json.description : res.code ? 'HTTP ' + res.code : String(res.text).slice(0, 120);
        throw new Error('Telegram did not accept the message: ' + Secrets.mask(why));
      }
    });
    return parts.length;
  },

  /** Send when Telegram is switched on in Config; never throws. Returns the number of messages sent. */
  safeTelegram: function (html) {
    try {
      if (Config.get('telegram') && Secrets.has('TG_BOT_TOKEN') && Secrets.has('TG_CHAT_ID')) return this.telegram(html);
    } catch (e) {
      console.log('Telegram failed: ' + e.message);
      try { Store.append('ErrorLog', [[new Date(), 'telegram', Secrets.mask(e.message).slice(0, 1000), '']]); } catch (x) { /* sheet missing */ }
    }
    return 0;
  },

  /** Split text into pieces under the limit, at line breaks where possible. */
  split: function (text, max) {
    if (text.length <= max) return [text];
    var out = [], cur = '';
    text.split('\n').forEach(function (line) {
      while (line.length > max) { // a single very long line
        if (cur) { out.push(cur); cur = ''; }
        out.push(line.slice(0, max));
        line = line.slice(max);
      }
      if ((cur ? cur.length + 1 : 0) + line.length > max) { out.push(cur); cur = line; }
      else cur = cur ? cur + '\n' + line : line;
    });
    if (cur) out.push(cur);
    return out;
  },

  /** Email yourself (the Google account that owns this sheet). */
  email: function (subject, html) {
    var to = Session.getEffectiveUser().getEmail();
    if (!to) throw new Error('Could not read your Google account email');
    if (MailApp.getRemainingDailyQuota() < 1) throw new Error('The daily email limit is used up');
    MailApp.sendEmail({ to: to, subject: 'Stock Radar: ' + subject, htmlBody: html, name: 'Stock Radar' });
  },

  /** Turn a Telegram-style message into a simple HTML email body. */
  htmlFromTelegram: function (text) {
    var body = String(text).split('\n').map(function (line) { return line === '' ? '<br>' : '<div>' + line + '</div>'; }).join('');
    return '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#0E242B;max-width:560px">' + body +
      '<p style="color:#58727A;font-size:12px;margin-top:18px">Stock Radar is a personal analysis tool, not investment advice.</p></div>';
  },
};

/* ============================== Web App API ============================== */

/** Opening the web app address in a browser only confirms it is running. */
function doGet() {
  return ContentService.createTextOutput('Stock Radar engine is running. Open the app to connect.').setMimeType(ContentService.MimeType.TEXT);
}

function doPost(e) {
  var out;
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!AppApi.authorised(req.t)) out = { ok: false, error: 'Not authorised. Connect the app again from the sheet: Stock Radar → Connect the app.' };
    else out = { ok: true, data: AppApi.handle(String(req.a || ''), req) };
  } catch (err) {
    ErrorLog.add('appApi', err);
    out = { ok: false, error: Secrets.mask((err && err.message) || String(err)).slice(0, 300) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

var AppApi = {
  MAX_ALERTS: 150,

  authorised: function (token) {
    var want = Secrets.get('APP_TOKEN');
    if (!want || typeof token !== 'string' || token.length !== want.length) return false;
    var diff = 0;
    for (var i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ token.charCodeAt(i);
    return diff === 0;
  },

  handle: function (action, req) {
    if (action === 'ping') return { version: SR_VERSION, at: Date.now() };
    if (action === 'bundle') return this.bundle();
    if (action === 'chart') return this.chart(String(req.symbol || ''), String(req.alertId || ''));
    if (action === 'settings') return this.saveSettings(req.settings || {}, req.strategies || {});
    if (action === 'news') return this.news(String(req.symbol || ''));
    if (action === 'testTelegram') {
      Notify.telegram('✅ Test message from the Stock Radar app. Alerts arrive in this chat.');
      return { sent: true };
    }
    throw new Error('Unknown request: ' + action);
  },

  ms: function (v) { return v instanceof Date ? v.getTime() : (Date.parse(v) || null); },
  num: function (v) { return typeof v === 'number' && isFinite(v) ? v : null; },
  lower: function (v) { return String(v || '').toLowerCase(); },
  statusKey: function (s) { return s === 'LIVE_READY' ? 'live' : s === 'REJECTED' ? 'rejected' : 'paper'; },
  regimeKey: function (s) { return { BULL: 'bull', NEUTRAL: 'neutral', BEAR: 'bear', HIGH_VOL: 'volatile' }[s] || 'unknown'; },

  /** Everything the app shows, in the same shape as its sample data. */
  bundle: function () {
    var self = this, now = MarketCal.now(), today = MarketCal.ymd(now), mins = MarketCal.minutes(now);
    var session = MarketCal.isTradingDay(today) && mins >= 555 ? today : MarketCal.lastCompletedSession();
    var asOf = session === today && mins < 930 ? now.getTime() : MarketCal.at(session, '15:30').getTime();
    var book = StrategyBook.load(), rows = Tables.read('Alerts').rows;
    var main = rows.filter(function (r) { return (r.track || 'main') !== 'shadow' && r.createdAt instanceof Date; });
    var trades = Review.closedTrades(rows).filter(function (x) { return x.track === 'main'; });
    var cap = Review.sizing().capital, rules = Review.rules();

    var strategies = SRCore.STRATEGIES.map(function (st) {
      var mine = trades.filter(function (x) { return x.strategy === st.id; }).sort(function (a, b) { return a.exitT - b.exitT; });
      var m = SRCore.metrics(Review.window(mine), { capital: cap });
      var b = book[st.id] || {};
      var outcomes = rows.filter(function (r) { return r.strategy === st.id && (r.track || 'main') === 'main' && r.status === 'CLOSED' && ['TARGET_HIT', 'STOP_HIT', 'EXPIRED'].indexOf(r.outcome) >= 0; })
        .sort(function (a, b2) { return self.ms(a.closedAt) - self.ms(b2.closedAt); })
        .map(function (r) { return r.outcome === 'TARGET_HIT' ? 'W' : r.outcome === 'STOP_HIT' ? 'L' : 'X'; }).join('').slice(-30);
      return {
        id: st.id, name: st.name, horizon: self.lower(st.horizon), status: self.statusKey(b.status), enabled: b.enabled !== false,
        override: b.override || '', trades: mine.length, days: m.days, outcomes: outcomes, win: m.winRatePct, avg: m.expectancyPct, pf: m.profitFactor,
        vsNifty: m.avgAlphaPct, paperDd: m.maxDrawdownPct === null ? null : -m.maxDrawdownPct, backtest: null,
        verdict: SRCore.graduate(m, rules).reason,
      };
    });
    var statusOf = {};
    strategies.forEach(function (st) { statusOf[st.id] = st.status; });

    var alerts = main.slice(-this.MAX_ALERTS).map(function (r) {
      var dir = self.lower(r.direction), why = String(r.reasons || '').split(' | ').filter(Boolean);
      var a = {
        id: String(r.id), symbol: String(r.symbol), horizon: self.lower(r.horizon), strategy: String(r.strategy), dir: dir,
        strategyName: SRCore.strategy(r.strategy) ? SRCore.strategy(r.strategy).name : String(r.strategy),
        time: self.ms(r.createdAt), validTill: self.ms(r.validTill), confidence: self.num(r.confidence), why: why,
        status: statusOf[r.strategy] || 'paper', regime: self.regimeKey(r.regime), source: String(r.source || ''),
        state: String(r.status || 'OPEN'),
      };
      if (dir === 'exit') {
        a.lastPrice = self.num(r.entryHigh) || self.num(r.entryLow);
        a.headline = why[0] || 'Exit check';
        a.dma200 = null;
      } else {
        a.entryLo = self.num(r.entryLow); a.entryHi = self.num(r.entryHigh); a.stop = self.num(r.stop);
        a.targets = [self.num(r.target1), self.num(r.target2)].filter(function (v) { return v !== null; });
        a.rr = self.num(r.rr);
      }
      if (r.status === 'CLOSED' && r.outcome) {
        var key = { TARGET_HIT: 'target', STOP_HIT: 'stop', EXPIRED: 'expired', NOT_TRIGGERED: 'not', EXIT_RIGHT: 'target', EXIT_EARLY: 'stop' }[r.outcome] || 'not';
        a.outcome = { state: key, pct: self.num(r.netPct) !== null ? r.netPct : self.num(r.outcomePct) };
      }
      if (self.num(r.fillPrice)) a.paper = { fill: r.fillPrice, exit: self.num(r.exitPrice), qty: self.num(r.paperQty), net: self.num(r.netPnl) };
      return a;
    });

    return {
      isDemo: false, version: SR_VERSION, updatedAt: Date.now(), session: session, asOf: asOf,
      market: this.market(), engine: this.engine(), strategies: strategies, alerts: alerts,
      paper: this.paper(rows, trades, cap, today), scan: this.scan(), fundamentals: this.fundamentals(),
      reports: this.reports(), paperStart: Secrets.props().getProperty('PAPER_START') || '',
      readinessSent: (Secrets.props().getProperty('READINESS_SENT') || '').split(',').filter(Boolean).map(Number),
      settings: this.settings(book), rules: rules,
    };
  },

  market: function () {
    var reg = Market.saved() || { state: 'UNKNOWN', reasons: [] }, snap = null;
    try { snap = JSON.parse(Secrets.props().getProperty('SNAPSHOT') || 'null'); } catch (e) { snap = null; }
    var q = (snap && snap.quotes) || {}, n = q['NIFTY 50'] || {}, v = q['INDIA VIX'] || {};
    return {
      regime: this.regimeKey(reg.state), reasons: reg.reasons || [],
      nifty: this.num(n.ltp) !== null ? n.ltp : (reg.nifty ? reg.nifty.close : null), niftyChg: this.num(n.changePct),
      vix: this.num(v.ltp) !== null ? v.ltp : (reg.vix ? reg.vix.close : null), vixChg: this.num(v.changePct),
      breadth: this.num(reg.breadthPct) !== null ? Math.round(reg.breadthPct) : null, at: snap ? snap.at : null,
    };
  },

  engine: function () {
    var snap = null, jobs = Jobs.status();
    try { snap = JSON.parse(Secrets.props().getProperty('SNAPSHOT') || 'null'); } catch (e) { snap = null; }
    var names = { preMarket: 'Pre-market check', intradayScan: 'Intraday scan', historyUpdate: 'Price history', evaluateIntraday: 'Judging intraday alerts', evaluateDaily: 'Judging other alerts', endOfDayScan: 'End-of-day scan', endOfDay: 'Closing summary', weekly: 'Weekly report' };
    var list = Object.keys(names).filter(function (k) { return jobs[k]; }).map(function (k) {
      var j = jobs[k];
      return { name: names[k], ok: !!j.ok, at: Date.parse(j.at) || null, error: j.ok ? '' : Secrets.mask(j.lastError || '').slice(0, 160) };
    });
    var src = snap && snap.sources && snap.sources.indexOf('angel') >= 0 ? 'Angel One' : snap && snap.sources && snap.sources.length ? snap.sources.join(', ') + ' (backup)' : 'Angel One';
    return { source: src, lastCheck: snap ? snap.at : null, fallbacks: [], jobs: list, schedule: Schedule.summary().kickoffs > 0 };
  },

  paper: function (rows, trades, cap, today) {
    var self = this;
    var withPnl = trades.filter(function (x) { return x.netPnl !== null; }).sort(function (a, b) { return a.exitT - b.exitT; });
    var realised = 0, todayPnl = 0, curve = [], start = Secrets.props().getProperty('PAPER_START');
    var startT = start ? MarketCal.at(start, '09:15').getTime() : (withPnl.length ? withPnl[0].exitT - 86400000 : Date.now() - 86400000);
    curve.push({ t: startT, v: cap });
    var byDay = {};
    withPnl.forEach(function (x) {
      realised += x.netPnl;
      var d = MarketCal.ymd(new Date(x.exitT));
      if (d === today) todayPnl += x.netPnl;
      byDay[d] = realised;
    });
    Object.keys(byDay).sort().forEach(function (d) { curve.push({ t: MarketCal.at(d, '15:30').getTime(), v: Math.round((cap + byDay[d]) * 100) / 100 }); });
    var open = [], unreal = 0;
    Tables.read('PaperTrades').rows.forEach(function (p) {
      if (p.status !== 'OPEN' || (p.track || 'main') !== 'main') return;
      var now = self.num(p.markPrice) || self.num(p.entryPrice);
      if (self.num(p.unrealisedPnl)) unreal += p.unrealisedPnl;
      open.push({ symbol: String(p.symbol), strategy: String(p.strategy), horizon: self.lower(p.horizon), entry: self.num(p.entryPrice), now: now, qty: self.num(p.qty), dir: self.lower(p.direction) });
    });
    var closed = rows.filter(function (r) { return (r.track || 'main') === 'main' && r.status === 'CLOSED' && ['TARGET_HIT', 'STOP_HIT', 'EXPIRED'].indexOf(r.outcome) >= 0 && self.num(r.netPct) !== null; })
      .sort(function (a, b) { return self.ms(b.closedAt) - self.ms(a.closedAt); }).slice(0, 30)
      .map(function (r) {
        return { symbol: String(r.symbol), strategy: String(r.strategy), horizon: self.lower(r.horizon), state: r.outcome === 'TARGET_HIT' ? 'target' : r.outcome === 'STOP_HIT' ? 'stop' : 'expired', pct: r.netPct, when: self.ms(r.closedAt), net: self.num(r.netPnl) };
      });
    var value = Math.round((cap + realised + unreal) * 100) / 100;
    if (curve.length === 1 || curve[curve.length - 1].v !== value) curve.push({ t: Date.now(), v: value });
    return { start: cap, value: value, today: Math.round(todayPnl * 100) / 100, unrealised: Math.round(unreal * 100) / 100, curve: curve, open: open, closed: closed };
  },

  scan: function () {
    var lists = null;
    try { lists = JSON.parse(Secrets.props().getProperty('SCAN_LISTS') || 'null'); } catch (e) { lists = null; }
    var all = SymbolsDb.load();
    var etfs = Object.keys(all).filter(function (s) { return all[s].type === 'ETF'; }).map(function (s) { return { symbol: s, sector: String(all[s].sector || all[s].name || '') }; });
    return { long: (lists && lists.long) || [], medium: (lists && lists.medium) || [], swing: (lists && lists.swing) || [], etfs: etfs, at: lists ? lists.at : null };
  },

  fundamentals: function () {
    var out = {}, self = this;
    Store.readObjects('Fundamentals').forEach(function (r) {
      if (!r.symbol) return;
      out[String(r.symbol).toUpperCase()] = {
        roe: self.num(r.roePct), roce: self.num(r.rocePct), de: self.num(r.debtToEquity), sales3y: self.num(r.sales3yPct), profit3y: self.num(r.profit3yPct),
        promoter: self.num(r.promoterPct), pledge: self.num(r.pledgePct), pe: self.num(r.pe), pe5y: self.num(r.pe5yMedian), fcf: self.num(r.fcf) === null ? null : (r.fcf > 0 ? 'Positive' : 'Negative'),
      };
    });
    return out;
  },

  reports: function () {
    var self = this;
    return Tables.read('Reports').rows.slice(-20).reverse().map(function (r) {
      return { type: String(r.type), at: self.ms(r.createdAt), title: String(r.title), summary: String(r.summary || '') };
    });
  },

  /** On/off settings the app may change (all TRUE/FALSE in the Config sheet). */
  SWITCHES: ['telegram', 'emailDigest', 'paperAlerts', 'intradayFollowNifty', 'intradayBlockBuysInBear', 'intradayBlockShortsInBull', 'intradayOneAlertPerStock'],

  settings: function (book) {
    var c = Config.all(), off = [], out;
    Object.keys(book).forEach(function (id) { if (!book[id].enabled) off.push(id); });
    out = {
      realCapital: c.realCapital, paperCapital: c.paperCapital, riskPct: c.riskPct, maxPerStockPct: c.maxPerStockPct,
      watchlist: Config.symbols('watchlist'), strategiesOff: off,
    };
    this.SWITCHES.forEach(function (k) { out[k] = c[k] === true; });
    return out;
  },

  /** Daily candles from the Drive history, or 5-minute candles of the alert's day for intraday alerts. */
  chart: function (symbol, alertId) {
    symbol = symbol.toUpperCase();
    if (!/^[A-Z0-9&-]{1,20}$/.test(symbol) && ['NIFTY 50', 'INDIA VIX', 'NIFTY BANK'].indexOf(symbol) < 0) throw new Error('Unknown symbol');
    var pack = function (k) { return k.map(function (c) { return [c.t, c.o, c.h, c.l, c.c, c.v]; }); };
    if (alertId) {
      var a = Tables.read('Alerts').rows.filter(function (r) { return String(r.id) === alertId; })[0];
      if (a && a.horizon === 'INTRADAY' && a.createdAt instanceof Date) {
        var m = SymbolsDb.load()[symbol], d = MarketCal.ymd(a.createdAt);
        if (m && m.angelToken) {
          var res = Angel.candlesMany([{ key: symbol, token: String(m.angelToken), from: MarketCal.at(d, '09:15'), to: MarketCal.at(d, '15:30') }], 'FIVE_MINUTE', {});
          if (res.data[symbol] && res.data[symbol].length) return { symbol: symbol, mode: 'intraday', candles: pack(res.data[symbol]) };
        }
      }
    }
    return { symbol: symbol, mode: 'day', candles: pack(History.get(symbol).slice(-330)) };
  },

  /** Recent headlines for a stock from Google News (the browser cannot read the feed directly). Cached 30 minutes. */
  news: function (symbol) {
    symbol = symbol.toUpperCase();
    if (!/^[A-Z0-9&-]{1,20}$/.test(symbol)) throw new Error('Unknown symbol');
    var cache = CacheService.getScriptCache(), key = 'news_' + symbol, hit = cache.get(key);
    if (hit) { try { return JSON.parse(hit); } catch (e) { /* refetch */ } }
    var meta = SymbolsDb.load()[symbol] || {};
    var name = String(meta.name || '').replace(/\s+(Ltd|Limited)\.?$/i, '').trim();
    var q = (name && name.toUpperCase() !== symbol ? '"' + name + '" OR ' : '') + symbol + ' share';
    var res = Http.request('https://news.google.com/rss/search?q=' + encodeURIComponent(q) + '&hl=en-IN&gl=IN&ceid=IN:en', { method: 'get' }, { retries: 1 });
    if (res.code !== 200) throw new Error('Google News did not answer (' + (res.code ? 'HTTP ' + res.code : 'no response') + ')');
    var text = String(res.text || ''), items = [], re = /<item>([\s\S]*?)<\/item>/g, m;
    var tag = function (block, name) {
      var mm = new RegExp('<' + name + '[^>]*>([\\s\\S]*?)<\\/' + name + '>').exec(block);
      if (!mm) return '';
      return mm[1].replace(/^<!\[CDATA\[|\]\]>$/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').trim();
    };
    while ((m = re.exec(text)) && items.length < 8) {
      var title = tag(m[1], 'title'), link = tag(m[1], 'link');
      if (!title || !/^https:\/\//.test(link)) continue;
      items.push({ title: title.slice(0, 220), link: link, source: tag(m[1], 'source').slice(0, 60), at: Date.parse(tag(m[1], 'pubDate')) || null });
    }
    var out = { symbol: symbol, items: items };
    try { cache.put(key, JSON.stringify(out), 1800); } catch (e) { /* too big to cache */ }
    return out;
  },

  /** Save settings changed in the app. Only these keys can be changed, each checked. */
  saveSettings: function (s, strategies) {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(8000)) throw new Error('The engine is busy (probably the end-of-day run). Try again in a few minutes.');
    try {
      var nums = { realCapital: [1000, 1e10], paperCapital: [1000, 1e10], riskPct: [0.1, 5], maxPerStockPct: [1, 100] };
      var write = {};
      Object.keys(nums).forEach(function (k) {
        if (s[k] === undefined) return;
        var v = Number(s[k]);
        if (!(isFinite(v) && v >= nums[k][0] && v <= nums[k][1])) throw new Error(k + ' is out of range');
        write[k] = String(v);
      });
      this.SWITCHES.forEach(function (k) { if (s[k] !== undefined) write[k] = s[k] === true ? 'TRUE' : 'FALSE'; });
      if (s.watchlist !== undefined) {
        var list = (s.watchlist || []).map(function (x) { return String(x).trim().toUpperCase(); }).filter(Boolean);
        if (list.length > 10 || list.some(function (x) { return !/^[A-Z0-9&-]{1,20}$/.test(x); })) throw new Error('The watchlist takes up to 10 NSE symbols');
        write.watchlist = list.join(',');
      }
      this.writeConfig(write);
      if (strategies && (strategies.off || strategies.overrides)) this.writeStrategies(strategies.off || null, strategies.overrides || {});
      Config._cache = null;
      StrategyBook._map = null;
      if (write.watchlist) { try { SymbolsDb.lookup(Config.symbols('watchlist')); } catch (e) { ErrorLog.add('watchlistLookup', e); } }
      return this.settings(StrategyBook.load());
    } finally {
      lock.releaseLock();
    }
  },

  writeConfig: function (write) {
    var keys = Object.keys(write);
    if (!keys.length) return;
    var sh = Store.require('Config'), n = sh.getLastRow() - 1;
    var have = n > 0 ? sh.getRange(2, 1, n, 1).getValues().map(function (r) { return String(r[0]).trim(); }) : [];
    keys.forEach(function (k) {
      var i = have.indexOf(k);
      if (i >= 0) sh.getRange(i + 2, 2).setValues([[write[k]]]);
      else {
        var row = Config.defaultRows().filter(function (r) { return r[0] === k; })[0];
        Store.append('Config', [[k, write[k], row ? row[2] : '']]);
      }
    });
  },

  writeStrategies: function (off, overrides) {
    var t = Tables.read('Strategies'), ok = ['', 'PAPER', 'LIVE_READY', 'REJECTED'];
    t.rows.forEach(function (o) {
      var id = String(o.id);
      if (off) o.enabled = off.indexOf(id) < 0;
      if (Object.prototype.hasOwnProperty.call(overrides, id)) {
        var v = String(overrides[id] || '').toUpperCase();
        if (ok.indexOf(v) < 0) throw new Error('Unknown status ' + v);
        o.override = v;
      }
    });
    Tables.writeCols(t, ['enabled', 'override'], 0);
    if (off) this.writeConfig({ strategiesOff: '' }); // the Strategies sheet is now the one place for on/off
  },
};

/* ============================== Menu: connect the app ============================== */

/** Stock Radar → Connect the app. Shows how to deploy the web app and sends the connect link. */
function menuConnectApp() {
  var url = Secrets.get('WEBAPP_URL');
  if (!url) { try { var u = ScriptApp.getService().getUrl(); if (/\/exec$/.test(u || '')) url = u; } catch (e) { url = ''; } }
  var html = HtmlService.createHtmlOutput(Setup.connectHtml(url)).setWidth(460).setHeight(560);
  SpreadsheetApp.getUi().showModalDialog(html, 'Connect the app');
}

/** Called by the dialog: remember the web app address and send the connect link. */
function sendConnectLink(url, toTelegram) {
  url = String(url || '').trim();
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,}\/exec$/.test(url)) return { ok: false, error: 'That does not look like a web app address. It starts with https://script.google.com/macros/s/ and ends with /exec.' };
  Secrets.props().setProperty('WEBAPP_URL', url);
  var link = 'https://sambadhyam.github.io/stock-radar/#/connect?u=' + encodeURIComponent(url) + '&t=' + Secrets.appToken();
  if (toTelegram) {
    Notify.telegram('🔗 <b>Connect the Stock Radar app</b>\nOpen this link on your phone (in Chrome, where the app is installed):\n' + Notify.esc(link) +
      '\n\nThe link holds your private app token. Delete this message after connecting. If it ever leaks, use Stock Radar → New app token.');
    return { ok: true, sent: true };
  }
  return { ok: true, link: link };
}

/** Stock Radar → New app token. The old one stops working at once; connect the app again afterwards. */
function newAppToken() {
  Secrets.props().deleteProperty('APP_TOKEN');
  Secrets.appToken();
  Ui.alert('New app token', 'The old token no longer works. Use Stock Radar → Connect the app to connect your phone again.');
}
