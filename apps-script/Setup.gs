/**
 * Stock Radar — Setup.gs
 * The "Stock Radar" menu in your sheet, sheet creation, the keys form, setup checks and status.
 *
 * Use the menu in this order the first time:
 *   1. Create sheets   2. Set up keys   3. Run all tests   4. Load stock lists   5. Start daily schedule
 *   6. Load price history
 */

/** Adds the Stock Radar menu whenever the sheet is opened. */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Stock Radar')
    .addItem('1. Create sheets', 'menuCreateSheets')
    .addItem('2. Set up keys', 'menuSetupKeys')
    .addItem('3. Run all tests', 'runAllTests')
    .addItem('4. Load stock lists', 'loadSymbols')
    .addItem('5. Start daily schedule', 'installSchedule')
    .addItem('6. Load price history', 'loadHistory')
    .addSeparator()
    .addItem('Status', 'showStatus')
    .addItem('Send a test Telegram message', 'testTelegram')
    .addItem('Stop daily schedule', 'removeSchedule')
    .addToUi();
}

/* ============================ Sheet layout ============================ */

/** Every sheet the engine uses. A function, so it never depends on the order files are loaded in. */
function sheetSchemas_() {
  return [
  { name: 'Config', headers: ['key', 'value', 'description'], widths: [200, 170, 520], textCols: [2] },
  { name: 'Holidays', headers: ['date', 'holiday'], widths: [120, 320], textCols: [1] },
  { name: 'Symbols', headers: SYMBOL_HEADERS, widths: [130, 240, 70, 100, 140, 170, 120, 200, 80, 80, 80, 150], textCols: [4] },
  { name: 'Alerts', headers: ['id', 'createdAt', 'symbol', 'horizon', 'strategy', 'strategyStatus', 'direction', 'entryLow', 'entryHigh', 'stop', 'target1', 'target2', 'rr', 'confidence', 'reasons', 'regime', 'source', 'validTill', 'status', 'triggeredAt', 'closedAt', 'outcome', 'outcomePct', 'netPct', 'notes'] },
  { name: 'PaperTrades', headers: ['id', 'alertId', 'symbol', 'horizon', 'strategy', 'status', 'entryAt', 'entryPrice', 'qty', 'stop', 'target', 'exitAt', 'exitPrice', 'exitReason', 'grossPnl', 'charges', 'netPnl', 'netPct', 'holdingDays'] },
  { name: 'Strategies', headers: ['id', 'name', 'horizon', 'enabled', 'status', 'override', 'trades', 'wins', 'losses', 'flats', 'winRatePct', 'avgNetPct', 'profitFactor', 'maxDrawdownPct', 'alphaPct', 'updatedAt', 'statusSince'] },
  { name: 'Checkpoints', headers: ['alertId', 'symbol', 'label', 'dueDate', 'price', 'returnPct', 'niftyReturnPct', 'alphaPct', 'evaluatedAt'] },
  { name: 'Holdings', headers: ['symbol', 'qty', 'avgPrice', 'lastPrice', 'sector', 'importedAt'] },
  { name: 'Fundamentals', headers: ['symbol', 'roePct', 'rocePct', 'debtToEquity', 'sales3yPct', 'profit3yPct', 'promoterPct', 'pledgePct', 'pe', 'pe5yMedian', 'fcf', 'source', 'updatedAt'] },
  { name: 'Backtests', headers: ['runId', 'strategy', 'horizon', 'from', 'to', 'symbols', 'trades', 'winRatePct', 'avgNetPct', 'profitFactor', 'maxDrawdownPct', 'cagrPct', 'createdAt'] },
  { name: 'Reports', headers: ['id', 'type', 'createdAt', 'title', 'summary', 'payload'] },
  { name: 'HealthLog', headers: ['time', 'job', 'source', 'result', 'ms', 'items', 'detail'], widths: [150, 110, 90, 70, 70, 60, 420] },
  { name: 'ErrorLog', headers: ['time', 'job', 'message', 'stack'], widths: [150, 110, 420, 300] },
  { name: 'Checks', headers: ['time', 'check', 'result', 'detail'], widths: [150, 190, 80, 560] },
  ];
}

/**
 * Create every sheet with its header row, fill in default settings and the 2026 holidays.
 * Safe to run again: existing data and your edits are kept, missing pieces are added.
 */
function setupSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone(IST);
  var created = [], updated = [];
  sheetSchemas_().forEach(function (schema) {
    var sh = ss.getSheetByName(schema.name);
    var isNew = !sh;
    if (isNew) { sh = ss.insertSheet(schema.name, ss.getSheets().length); created.push(schema.name); }
    Store.ensureCols(sh, schema.headers.length);
    var have = isNew ? [] : Store.headers(sh).filter(function (h) { return h !== ''; });
    if (!have.length) {
      sh.getRange(1, 1, 1, schema.headers.length).setValues([schema.headers]);
    } else {
      var missing = schema.headers.filter(function (h) { return have.indexOf(h) < 0; });
      if (missing.length) {
        Store.ensureCols(sh, have.length + missing.length);
        sh.getRange(1, have.length + 1, 1, missing.length).setValues([missing]);
        updated.push(schema.name);
      }
    }
    var width = Math.max(schema.headers.length, sh.getLastColumn());
    sh.getRange(1, 1, 1, width).setFontWeight('bold').setBackground('#E1E9E8').setFontColor('#0E242B');
    sh.setFrozenRows(1);
    (schema.textCols || []).forEach(function (c) { sh.getRange(1, c, sh.getMaxRows(), 1).setNumberFormat('@'); });
    if (isNew) {
      (schema.widths || []).forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
      if (!schema.widths) sh.setColumnWidths(1, schema.headers.length, 120);
    }
  });

  // Default settings: add any that are missing, never overwrite yours.
  var cfg = ss.getSheetByName('Config');
  var haveKeys = cfg.getLastRow() > 1 ? cfg.getRange(2, 1, cfg.getLastRow() - 1, 1).getValues().map(function (r) { return String(r[0]); }) : [];
  var newCfg = Config.defaultRows().filter(function (r) { return haveKeys.indexOf(r[0]) < 0; }).map(function (r) { return [r[0], String(r[1]), r[2]]; });
  if (newCfg.length) Store.append('Config', newCfg);

  // One row per strategy in the Strategies sheet (switch on/off and override status there).
  var strategiesAdded = StrategyBook.seed();

  // Holidays: add the 2026 list where missing.
  var hol = ss.getSheetByName('Holidays');
  var haveDays = hol.getLastRow() > 1 ? hol.getRange(2, 1, hol.getLastRow() - 1, 1).getValues().map(function (r) {
    return r[0] instanceof Date ? Utilities.formatDate(r[0], IST, 'yyyy-MM-dd') : String(r[0]);
  }) : [];
  var newHol = NSE_HOLIDAYS_2026.filter(function (r) { return haveDays.indexOf(r[0]) < 0; });
  if (newHol.length) Store.append('Holidays', newHol);

  // Remove the empty default tab that new spreadsheets start with.
  ['Sheet1', 'Sheet 1'].forEach(function (n) {
    var sh = ss.getSheetByName(n);
    if (sh && sh.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(sh);
  });

  Secrets.appToken();
  Config._cache = null;
  MarketCal._holidays = null;
  return { created: created, updated: updated, settingsAdded: newCfg.length, holidaysAdded: newHol.length, strategiesAdded: strategiesAdded };
}

function menuCreateSheets() {
  var r = setupSheets();
  Ui.alert('Sheets are ready',
    (r.created.length ? 'Created: ' + r.created.join(', ') + '.\n\n' : 'All sheets were already there.\n\n') +
    (r.updated.length ? 'Added new columns to: ' + r.updated.join(', ') + '.\n\n' : '') +
    'Settings added: ' + r.settingsAdded + '. Holidays added: ' + r.holidaysAdded + '. Strategies added: ' + r.strategiesAdded + '.\n\n' +
    (Secrets.missing().length ? 'Next: Stock Radar → 2. Set up keys.' : 'Your keys are already saved.'));
}

/* ============================ Keys form ============================ */

function menuSetupKeys() {
  var html = HtmlService.createHtmlOutput(Setup.keysHtml()).setWidth(440).setHeight(640);
  SpreadsheetApp.getUi().showModalDialog(html, 'Stock Radar keys');
}

/** Called by the keys form. Returns which keys were saved, or why nothing was saved. */
function saveSecretsFromDialog(values) {
  return Secrets.save(values || {});
}

/**
 * Plan B if the keys form does not open on your phone.
 * Type each value between the quotes, press Run, read the result in the log,
 * then delete the values again and save the file, so no key stays in the code.
 */
function setupSecretsManually() {
  var values = {
    ANGEL_CLIENT_CODE: '',
    ANGEL_PIN: '',
    ANGEL_API_KEY: '',
    ANGEL_TOTP_SECRET: '',
    TG_BOT_TOKEN: '',
    TG_CHAT_ID: '',
    GEMINI_API_KEY: '',
  };
  var r = Secrets.save(values);
  console.log(r.errors.length ? 'Nothing saved. ' + r.errors.join(' ') :
    'Saved: ' + (r.saved.join(', ') || 'nothing (all values were empty)') + '. Now delete the values you typed above and save this file.');
}

/* ============================ Tests ============================ */

/** Run every setup check, write the results to the Checks sheet and send a summary to Telegram. */
function runAllTests() {
  // Each result is written to the Checks sheet as soon as it is known, so a slow network
  // never loses the results. Big downloads (stock lists) are checked in 4. Load stock lists.
  Store.replaceAll('Checks', []);
  var results = Checks.runAll(function (r) { Store.append('Checks', [[new Date(), r.check, r.result, r.detail]]); });
  var count = function (k) { return results.filter(function (r) { return r.result === k; }).length; };
  var summary = count('PASS') + ' passed, ' + count('WARN') + ' warnings, ' + count('FAIL') + ' failed' + (count('NOT RUN') ? ', ' + count('NOT RUN') + ' not run' : '');
  var notPass = results.filter(function (r) { return r.result !== 'PASS'; });
  Notify.safeTelegram('<b>Stock Radar setup check</b>\n' + summary +
    (notPass.length ? '\n\n' + notPass.map(function (r) { return r.result + ': ' + Notify.esc(r.check) + ' — ' + Notify.esc(r.detail); }).join('\n') : '\n\nEverything works.'));
  Ui.dialog('Setup check: ' + summary, Setup.checksHtml(results, summary), 640);
  return results;
}

function testTelegram() { Setup.showOne('Telegram message', Checks.telegram); }
function testLogin() { Setup.showOne('Angel One login', Checks.angelLogin); }
function testQuotes() { Setup.showOne('Live quotes', Checks.quotes); }
function testCandles() { Setup.showOne('Daily candles', Checks.dailyCandles); }
function testInstrumentMaster() { Setup.showOne('Instrument list', Checks.instrumentList); }
function testConstituents() { Setup.showOne('Nifty stock lists', Checks.constituents); }

var Checks = {
  LIST: [
    ['Keys saved', 'keys'],
    ['Telegram message', 'telegram'],
    ['Email', 'email'],
    ['Angel One login', 'angelLogin'],
    ['Symbol search', 'search'],
    ['Live quotes', 'quotes'],
    ['Daily candles', 'dailyCandles'],
    ['5-minute candles', 'intradayCandles'],
    ['Google Finance backup', 'googleFinance'],
    ['Yahoo Finance backup', 'yahoo'],
    ['Price cross-check', 'crossCheck'],
    ['Trading calendar', 'calendar'],
  ],

  /** Runs the checks within a time budget. If Angel One login fails, the other Angel One checks are skipped. */
  runAll: function (onResult) {
    var self = this, t0 = Date.now(), out = [], loginFailed = false;
    this.LIST.forEach(function (c) {
      var r;
      if (Date.now() - t0 > 240000) r = { check: c[0], result: 'NOT RUN', detail: 'Stopped early to stay inside Google\'s 6-minute limit. Run 3. Run all tests again.' };
      else if (loginFailed && self.ANGEL_CHECKS.indexOf(c[1]) >= 0) r = { check: c[0], result: 'SKIP', detail: 'Skipped because Angel One login failed' };
      else r = self.runOne(c[0], self[c[1]]);
      if (c[1] === 'angelLogin' && r.result === 'FAIL') loginFailed = true;
      out.push(r);
      if (onResult) { try { onResult(r); } catch (e) { /* sheet write is optional */ } }
    });
    return out;
  },

  ANGEL_CHECKS: ['search', 'quotes', 'dailyCandles', 'intradayCandles', 'crossCheck'],

  runOne: function (name, fn) {
    var t0 = Date.now();
    var r;
    try { r = fn.call(Checks); } catch (e) { r = { result: 'FAIL', detail: Secrets.mask(e.message) }; }
    r.check = name;
    r.detail = Secrets.mask(r.detail || '') + ' (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)';
    return r;
  },

  needAngel: function () {
    if (!Angel.configured()) return { result: 'SKIP', detail: 'Angel One keys are not saved yet' };
    return null;
  },

  keys: function () {
    var missing = Secrets.missing();
    return missing.length ? { result: 'FAIL', detail: 'Missing: ' + missing.join(', ') + '. Use Stock Radar → 2. Set up keys.' } : { result: 'PASS', detail: 'All required keys are saved' };
  },

  telegram: function () {
    if (!Secrets.has('TG_BOT_TOKEN') || !Secrets.has('TG_CHAT_ID')) return { result: 'SKIP', detail: 'Telegram keys are not saved yet' };
    Notify.telegram('✅ Stock Radar is connected to this chat. Alerts and reports will arrive here.');
    return { result: 'PASS', detail: 'Test message sent. Check Telegram.' };
  },

  email: function () {
    Notify.email('Email test', Notify.htmlFromTelegram('Stock Radar can email you. Daily summaries will arrive here after 4 pm on trading days.'));
    return { result: 'PASS', detail: 'Test email sent to ' + Session.getEffectiveUser().getEmail() + '. Emails left today: ' + MailApp.getRemainingDailyQuota() };
  },

  angelLogin: function () {
    var skip = this.needAngel(); if (skip) return skip;
    Angel.login(true);
    var who = '';
    try { var p = Angel.profile(); who = p && p.name ? ' as ' + p.name : ''; } catch (e) { who = ' (profile not readable: ' + e.message + ')'; }
    return { result: 'PASS', detail: 'Logged in with PIN and TOTP' + who };
  },

  search: function () {
    var skip = this.needAngel(); if (skip) return skip;
    var hit = Angel.findToken('RELIANCE');
    return hit ? { result: 'PASS', detail: 'RELIANCE is ' + hit.angelSymbol + ', token ' + hit.token } : { result: 'FAIL', detail: 'RELIANCE was not found' };
  },

  /** Indices plus two stocks, in FULL mode; reports which fields Angel One returns. */
  quotes: function () {
    var skip = this.needAngel(); if (skip) return skip;
    var rel = Angel.findToken('RELIANCE') || { token: '2885' };
    var tokens = ['99926000', '99926017', rel.token];
    var raw = Angel.quotes(tokens, 'FULL');
    if (!raw.fetched.length) return { result: 'FAIL', detail: 'No quotes returned. Unfetched: ' + JSON.stringify(raw.unfetched).slice(0, 200) };
    var stock = raw.fetched.filter(function (q) { return String(q.symbolToken) === String(rel.token); })[0] || raw.fetched[0];
    var wanted = ['ltp', 'open', 'high', 'low', 'close', 'tradeVolume', 'avgPrice', '52WeekHigh', '52WeekLow', 'exchFeedTime'];
    var absent = wanted.filter(function (k) { return stock[k] === undefined; });
    var shown = raw.fetched.map(function (q) { var n = Angel.normQuote(q); return n.symbol + ' ' + Fmt.num(n.ltp) + ' (' + Fmt.pct(n.changePct) + ')'; }).join(', ');
    return { result: absent.length ? 'WARN' : 'PASS', detail: shown + (absent.length ? '. Missing fields: ' + absent.join(', ') : '. All needed fields present.') };
  },

  dailyCandles: function () {
    var skip = this.needAngel(); if (skip) return skip;
    var rel = Angel.findToken('RELIANCE') || { token: '2885' };
    var to = MarketCal.now(), from = new Date(to.getTime() - 60 * 86400000);
    var rows = Angel.candles(rel.token, 'ONE_DAY', from, to);
    if (rows.length < 20) return { result: 'FAIL', detail: 'Only ' + rows.length + ' daily candles for the last 60 days' };
    var last = rows[rows.length - 1];
    return { result: 'PASS', detail: rows.length + ' daily candles. Last: ' + MarketCal.ymd(new Date(last.t)) + ' close ' + Fmt.num(last.c) };
  },

  intradayCandles: function () {
    var skip = this.needAngel(); if (skip) return skip;
    var rel = Angel.findToken('RELIANCE') || { token: '2885' };
    var day = MarketCal.lastCompletedSession();
    var rows = Angel.candles(rel.token, 'FIVE_MINUTE', MarketCal.at(day, '09:15'), MarketCal.at(day, '15:30'));
    if (rows.length < 60) return { result: 'WARN', detail: 'Only ' + rows.length + ' five-minute candles for ' + day + ' (expected about 75)' };
    return { result: 'PASS', detail: rows.length + ' five-minute candles for ' + Fmt.day(day) };
  },

  instrumentList: function () {
    var r = InstrumentMaster.nseEquity();
    return { result: 'PASS', detail: r.count + ' NSE stocks found in a ' + (r.bytes / 1048576).toFixed(1) + ' MB file' };
  },

  constituents: function () {
    var parts = [], worst = 'PASS';
    ['NIFTY50', 'NIFTY200', 'NIFTY500'].forEach(function (ix) {
      var g = Constituents.get(ix);
      if (g.rows.length) parts.push(ix + ': ' + g.rows.length + ' from ' + g.source);
      else { parts.push(ix + ': not reachable (' + g.error + ')'); worst = 'WARN'; }
    });
    var tip = worst === 'WARN' ? '. Fix: open the list link on your phone, download the CSV, then in this sheet use File → Import → Upload → Insert new sheet, and run 4. Load stock lists.' : '';
    return { result: worst, detail: parts.join('; ') + tip };
  },

  googleFinance: function () {
    var got = GFinance.quotes([
      { symbol: 'RELIANCE', google: 'NSE:RELIANCE' }, { symbol: 'NIFTY 50', google: 'INDEXNSE:NIFTY_50' }, { symbol: 'INDIA VIX', google: 'INDEXNSE:INDIA_VIX' },
    ]);
    if (!got.length) return { result: 'FAIL', detail: 'Google Finance returned no prices' };
    var names = got.map(function (q) { return q.symbol + ' ' + Fmt.num(q.ltp); });
    return { result: got.length === 3 ? 'PASS' : 'WARN', detail: names.join(', ') + (got.length < 3 ? '. Some tickers did not resolve; the main data source is Angel One.' : '') };
  },

  yahoo: function () {
    var got = Yahoo.quotes([{ symbol: 'RELIANCE', yahoo: 'RELIANCE.NS' }]);
    return got.length ? { result: 'PASS', detail: 'RELIANCE ' + Fmt.num(got[0].ltp) } :
      { result: 'WARN', detail: 'Yahoo refused the request, which is common from Google servers. Only matters if both Angel One and Google Finance fail.' };
  },

  crossCheck: function () {
    var skip = this.needAngel(); if (skip) return skip;
    var rel = Angel.findToken('RELIANCE') || { token: '2885', angelSymbol: 'RELIANCE-EQ' };
    var a = Angel.normQuote(Angel.quotes([rel.token], 'LTP').fetched[0] || {}, 'RELIANCE');
    var g = GFinance.quotes([{ symbol: 'RELIANCE', google: 'NSE:RELIANCE' }])[0];
    if (!a.ltp || !g) return { result: 'WARN', detail: 'Could not get both prices to compare' };
    var diff = ((a.ltp - g.ltp) / g.ltp) * 100, limit = Number(Config.get('crossCheckPct'));
    return { result: Math.abs(diff) <= limit ? 'PASS' : 'WARN', detail: 'RELIANCE: Angel One ' + Fmt.num(a.ltp) + ', Google ' + Fmt.num(g.ltp) + ', gap ' + Fmt.pct(diff) + (MarketCal.marketState() === 'open' ? ' (Google is about 15–20 min delayed)' : '') };
  },

  calendar: function () {
    var today = MarketCal.ymd(), state = MarketCal.marketState();
    var next = MarketCal.isTradingDay(today) && MarketCal.minutes() < 930 ? today : MarketCal.nextTradingDay(today);
    var hol = MarketCal.upcomingHolidays(60);
    return {
      result: 'PASS',
      detail: 'Today: ' + Fmt.day(today) + ', ' + state + '. Next session: ' + Fmt.day(next) + '. ' +
        (hol.length ? 'Next holiday: ' + Fmt.day(hol[0].ymd) + ' (' + hol[0].name + ').' : 'No holidays in the next 60 days.') +
        (MarketCal.hasYear(Number(today.slice(0, 4)) + 1) ? '' : ' Holidays for next year are not added yet; that is expected until NSE publishes them.'),
    };
  },
};

/* ============================ Stock lists and schedule ============================ */

/** Download the Nifty 50/200/500 lists and Angel One tokens into the Symbols sheet. */
function loadSymbols() {
  Store.require('Symbols');
  var r = Jobs.run('loadSymbols', function () { return SymbolsDb.rebuild(); }, { lock: true, wait: 20000, rethrow: true });
  var lines = [];
  ['NIFTY50', 'NIFTY200', 'NIFTY500'].forEach(function (ix) {
    var l = r.lists[ix];
    lines.push(ix + ': ' + (l.count ? l.count + ' stocks from ' + l.source : 'not reachable, kept the saved list'));
  });
  lines.push('', 'Stocks: ' + r.stocks + ', ETFs: ' + r.etfs + ', indices: ' + r.indices + '.');
  lines.push('Angel One tokens found for ' + r.tokensFound + ' stocks and ETFs, using the ' + r.tokenSource + '.');
  if (r.tokensMissing.length) lines.push('No token yet for: ' + r.tokensMissing.slice(0, 15).join(', ') + (r.tokensMissing.length > 15 ? ' and ' + (r.tokensMissing.length - 15) + ' more' : '') + '. Run this again to retry.');
  lines.push('', 'Took ' + r.seconds + ' s. Next: Stock Radar → 5. Start daily schedule.');
  Ui.alert('Stock lists loaded', lines.join('\n'));
  return r;
}

/** Turn on the daily engine. */
function installSchedule() {
  var missing = Secrets.missing();
  if (missing.length) { Ui.alert('Keys needed first', 'Missing: ' + missing.join(', ') + '.\nUse Stock Radar → 2. Set up keys.'); return; }
  var listsMissing = SymbolsDb.universe('NIFTY50').length < 40;
  Schedule.install();
  var s = Schedule.summary(), today = MarketCal.ymd();
  var next = MarketCal.isTradingDay(today) && MarketCal.minutes() < 16 * 60 ? today : MarketCal.nextTradingDay(today);
  Ui.alert('Daily schedule is on',
    'Next trading day: ' + Fmt.day(next) + '.\n\n' +
    '• 08:50 pre-market check on Telegram\n• Market snapshots every ' + Config.get('heartbeatMinutes') + ' minutes in the session\n• After 16:00 closing summary on Telegram and email\n\n' +
    (s.tickRunning ? 'The engine is already running for today.' : 'It starts by itself on the next trading morning.') +
    (listsMissing ? '\n\nNote: the Nifty stock lists are not loaded yet. Phase 1 only needs the indices and your watchlist, but run 4. Load stock lists before Phase 2.' : ''));
}

function removeSchedule() {
  Schedule.remove();
  Ui.alert('Daily schedule is off', 'No more automatic runs. Use Stock Radar → 5. Start daily schedule to turn it back on.');
}

/* ============================ Status ============================ */

function showStatus() {
  Ui.dialog('Stock Radar status', Setup.statusHtml(), 600);
}

/* ============================ Helpers ============================ */

/** Alerts and dialogs that also work when a function is run from the editor (they log instead). */
var Ui = {
  alert: function (title, msg) {
    try { var ui = SpreadsheetApp.getUi(); ui.alert(title, msg, ui.ButtonSet.OK); }
    catch (e) { console.log(title + '\n' + msg); }
  },
  dialog: function (title, html, height) {
    try { SpreadsheetApp.getUi().showModalDialog(HtmlService.createHtmlOutput(html).setWidth(460).setHeight(height || 560), title); }
    catch (e) { console.log(title + '\n' + String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')); }
  },
};

var Setup = {
  /** "412 of 499" plus the first few stocks still missing a code. */
  tokenLine: function () {
    var all = SymbolsDb.load(), total = 0, missing = [];
    Object.keys(all).forEach(function (k) {
      if (all[k].type === 'INDEX') return;
      total++;
      if (!all[k].angelToken) missing.push(k);
    });
    var line = (total - missing.length) + ' of ' + total;
    if (missing.length) line += '. Missing: ' + missing.slice(0, 15).join(', ') + (missing.length > 15 ? ' and ' + (missing.length - 15) + ' more' : '');
    return line;
  },

  historyLine: function () {
    var m = History.meta();
    if (!m || !m.symbols) return 'Not loaded yet: use Stock Radar → 6. Load price history';
    return m.symbols + ' stocks and indices, up to ' + (m.last ? Fmt.day(History.dayToYmd(m.last)) : '—');
  },

  regimeLine: function () {
    var r = Market.saved();
    return r ? SRCore.regimeName(r.state) + (r.asOfDay ? ' (as of ' + Fmt.day(History.dayToYmd(r.asOfDay)) + ')' : '') : 'Not worked out yet';
  },

  CSS: 'body{font-family:Roboto,Arial,sans-serif;margin:0;padding:2px 2px 18px;color:#0E242B;font-size:14px;line-height:1.45}' +
    'h3{font-size:15px;margin:16px 0 6px}p{margin:0 0 10px}.muted{color:#58727A}' +
    '.f{margin:0 0 14px}label{display:flex;justify-content:space-between;gap:8px;font-weight:600;margin-bottom:4px}' +
    '.ok{color:#0B7B42;font-weight:700;font-size:12px;white-space:nowrap}.no{color:#845400;font-weight:700;font-size:12px;white-space:nowrap}' +
    'input[type=text],input[type=password]{width:100%;box-sizing:border-box;height:44px;border:1px solid #CBD8D7;border-radius:10px;padding:0 12px;font-size:16px;font-family:inherit}' +
    '.hint{color:#58727A;font-size:12px;margin-top:3px}' +
    'button{height:46px;border:0;border-radius:12px;background:#E7A92F;color:#1E1500;font-weight:700;font-size:15px;width:100%;cursor:pointer}' +
    'button:disabled{opacity:.6}.msg{margin-top:12px;padding:10px 12px;border-radius:10px;display:none}' +
    '.msg.good{display:block;background:#DCEFE4;color:#0B7B42}.msg.bad{display:block;background:#F7E0E1;color:#BE2A33}' +
    'table{width:100%;border-collapse:collapse}td{padding:7px 4px;border-bottom:1px solid #E1E9E8;vertical-align:top}' +
    '.r{font-weight:700;white-space:nowrap}.PASS{color:#0B7B42}.WARN{color:#845400}.FAIL{color:#BE2A33}.SKIP{color:#58727A}' +
    '.show{display:flex;justify-content:flex-start;gap:8px;align-items:center;font-weight:500;margin:0 0 14px}',

  esc: function (s) {
    return String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },

  keysHtml: function () {
    var self = this;
    var fields = Secrets.status().map(function (f) {
      return '<div class="f"><label for="' + f.key + '"><span>' + self.esc(f.label) + '</span>' +
        (f.set ? '<span class="ok">Saved</span>' : f.required ? '<span class="no">Not saved</span>' : '') + '</label>' +
        '<input id="' + f.key + '" name="' + f.key + '" type="' + (f.secret ? 'password' : 'text') + '" data-secret="' + (f.secret ? 1 : 0) + '" ' +
        'autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="' + (f.set ? 'Leave empty to keep the saved value' : '') + '">' +
        '<div class="hint">' + self.esc(f.hint) + '</div></div>';
    }).join('');
    return '<!doctype html><html><head><base target="_top"><meta name="viewport" content="width=device-width,initial-scale=1"><style>' + this.CSS + '</style></head><body>' +
      '<p class="muted">Each key is stored privately in this script\'s settings, not in the sheet or the code. Leave a box empty to keep what is already saved.</p>' +
      '<label class="show"><input type="checkbox" id="show"> Show what I type</label>' + fields +
      '<button id="save">Save keys</button><div id="msg" class="msg"></div>' +
      '<script>' +
      'var ids=' + JSON.stringify(SECRET_FIELDS.map(function (f) { return f.key; })) + ';' +
      'document.getElementById("show").onchange=function(){var t=this.checked?"text":"password";ids.forEach(function(k){var el=document.getElementById(k);if(el.getAttribute("data-secret")==="1")el.type=t;});};' +
      'document.getElementById("save").onclick=function(){var b=this,m=document.getElementById("msg"),v={};ids.forEach(function(k){v[k]=document.getElementById(k).value;});' +
      'b.disabled=true;b.textContent="Saving…";m.className="msg";' +
      'google.script.run.withSuccessHandler(function(r){b.disabled=false;b.textContent="Save keys";' +
      'if(r.errors.length){m.className="msg bad";m.textContent=r.errors.join(" ");return;}' +
      'ids.forEach(function(k){document.getElementById(k).value="";});' +
      'm.className="msg good";m.textContent=r.saved.length?"Saved: "+r.saved.join(", ")+". Close this box, then use Stock Radar → 3. Run all tests.":"Nothing new to save.";})' +
      '.withFailureHandler(function(e){b.disabled=false;b.textContent="Save keys";m.className="msg bad";m.textContent="Could not save: "+(e&&e.message?e.message:e);})' +
      '.saveSecretsFromDialog(v);};' +
      '</script></body></html>';
  },

  checksHtml: function (results, summary) {
    var self = this;
    var rows = results.map(function (r) {
      return '<tr><td class="r ' + r.result + '">' + r.result + '</td><td><b>' + self.esc(r.check) + '</b><br><span class="muted">' + self.esc(r.detail) + '</span></td></tr>';
    }).join('');
    return '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>' + this.CSS + '</style></head><body>' +
      '<p><b>' + this.esc(summary) + '.</b> The same results are in the Checks sheet.</p><table>' + rows + '</table>' +
      '<p class="muted" style="margin-top:12px">WARN means a backup or optional part needs attention; the engine still runs. FAIL needs fixing first.</p></body></html>';
  },

  statusHtml: function () {
    var self = this, keys = Secrets.status(), jobs = Jobs.status(), sched = Schedule.summary(), sess = Angel.session();
    var li = function (label, value) { return '<tr><td class="muted">' + self.esc(label) + '</td><td><b>' + self.esc(value) + '</b></td></tr>'; };
    var keyLine = keys.filter(function (k) { return k.required; }).map(function (k) { return (k.set ? '✓ ' : '✗ ') + k.label; }).join(', ');
    var jobRows = Object.keys(jobs).sort().map(function (n) {
      var j = jobs[n];
      return li(n, (j.ok ? 'OK' : 'Failed ×' + j.fails) + ' at ' + Utilities.formatDate(new Date(j.at), IST, 'd MMM HH:mm') + (j.ok ? '' : ' — ' + j.lastError));
    }).join('');
    var today = MarketCal.ymd();
    return '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>' + this.CSS + '</style></head><body><table>' +
      li('Engine version', SR_VERSION) +
      li('Keys', keyLine) +
      li('Stocks loaded', String(SymbolsDb.count())) +
      li('Stocks with an Angel One code', Setup.tokenLine()) +
      li('Daily schedule', sched.kickoffs ? 'On' + (sched.tickRunning ? ', running now' : ', waiting for the next trading morning') : 'Off') +
      li('Angel One session', sess.jwt && sess.day === today ? 'Logged in today at ' + Utilities.formatDate(new Date(sess.at), IST, 'HH:mm') : 'Not logged in today') +
      li('Market', MarketCal.marketState() + ' (' + Fmt.day(today) + ')') +
      li('Price history', Setup.historyLine()) +
      li('Market regime', Setup.regimeLine()) +
      li('Strategies on', String(StrategyBook.enabled(['INTRADAY', 'SWING', 'MEDIUM', 'LONG']).length) + ' of ' + SRCore.STRATEGIES.length) +
      li('Emails left today', String(MailApp.getRemainingDailyQuota())) +
      li('App token (for Phase 4)', 'Saved, shown when the app is connected') +
      '</table><h3>Last runs</h3><table>' + (jobRows || li('No runs yet', 'They appear after the schedule starts')) + '</table></body></html>';
  },

  showOne: function (name, fn) {
    var r = Checks.runOne(name, fn);
    Ui.alert(name + ': ' + r.result, r.detail);
    return r;
  },
};
