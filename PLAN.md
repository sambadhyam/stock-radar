# Stock Radar India — build plan

Personal NSE analysis, alerts and self-checking paper trading. Phone-only workflow: the app lives on GitHub Pages, the engine runs in Google Apps Script, alerts arrive on Telegram, and every real order is placed by hand in Kite.

- **App:** https://sambadhyam.github.io/stock-radar/
- **Repo:** `sambadhyam/stock-radar`
- **Status:** Phase 4 complete (Web App API; the app shows live engine data once connected, sample data until then).

---

## 1. How the pieces fit

```
  Angel One SmartAPI ──┐   quotes, candles         ┌──> Telegram bot   (alerts, reports)
  Google Finance ──────┼──────────────────────┐    ├──> Gmail          (digests, fallback)
  Yahoo (last resort) ─┘                      ▼    │
                              ┌──────────────────────────────┐
   time triggers ───────────> │  Apps Script engine          │
   (08:50, each minute in     │  Sheet "Stock Radar DB"      │
    market hours, 16:00, Sat) │  + Drive JSON price history  │
                              └──────────────┬───────────────┘
                                             │ Web App JSON API (secret token)
                                             ▼
                              PWA on GitHub Pages (this repo)
                              phone home screen, works offline
```

Nothing in this system can place an order. Under SEBI's retail-algo rules, API orders must come from a whitelisted static IP; this design never needs one because it only reads data.

---

## 2. Verified facts (checked 25 October 2026)

| Topic | Finding | Source |
|---|---|---|
| Static IP scope | Needed only for order and GTT endpoints. Login, quotes and historical data work from any IP. Sessions end at midnight daily. | [SmartAPI forum: static IP](https://smartapi.angelone.in/smartapi/forum/post/18838), [SmartAPI forum: Aug–Oct 2025 changes](https://smartapi.angelone.in/smartapi/forum/post/18243), [Angel One: April 2026 changes](https://oga-prod.angelone.in/news/market-updates/what-s-changing-in-angel-one-s-smartapi-access-from-april-1-2026) |
| Login | `POST https://apiconnect.angelone.in/rest/auth/angelbroking/user/v1/loginByPassword` with `clientcode`, `password` (MPIN) and `totp`; headers include `X-PrivateKey` (API key), `X-UserType: USER`, `X-SourceID: WEB`. Returns jwtToken, refreshToken, feedToken. API secret is not used. | Official SDK source [angel-one/smartapi-python](https://github.com/angel-one/smartapi-python) (May 2025), [OpenAlgo Angel One guide](https://docs.openalgo.in/connect-brokers/angelone) |
| Live quotes | `POST /rest/secure/angelbroking/market/v1/quote` — up to 50 tokens per request, 1 request per second. | [SmartAPI forum: quote endpoint](https://smartapi.angelone.in/smartapi/forum/post/16902) |
| Candles | `POST /rest/secure/angelbroking/historical/v1/getCandleData` — 3/s, 180/min, 5,000/hour. Documented max days per call: 1-min 30, 5-min 90, 15-min 180, 1-hour 365, daily 2,000. Users report about 500 rows per call in practice, so requests are chunked. | [SmartAPI forum: rate limits](https://smartapi.angelone.in/smartapi/forum/post/16438), [SmartAPI forum: historical limits](https://smartapi.angelone.in/smartapi/forum/post/12716) |
| Index tokens | Nifty 50 `99926000`, India VIX `99926017`, Nifty 200 `99926033`, Nifty 500 `99926004`, Nifty Bank `99926009`, plus sector indices. Index candles have no volume. | [SmartAPI forum: 120 indices](https://smartapi.angelone.in/smartapi/forum/post/14205) |
| Instrument master | `https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json` | [Marketcalls tutorial](https://www.marketcalls.in/datafeed/how-to-fetch-historical-stock-market-data-using-smartapi-python-library-angelone-trading-account.html) |
| Apps Script quotas (Gmail account) | 6 min per run; **90 min of trigger runtime per day**; 20,000 URL fetches per day; 50 MB per fetch; 100 email recipients per day; 20 triggers per script; Script Properties 9 KB per value, 500 KB total. | [Google: Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas) |
| Google Finance | Historical GOOGLEFINANCE data cannot be read from Apps Script (shows #N/A). Current quotes can. | [Google Workspace Updates](https://workspaceupdates.googleblog.com/2016/09/historical-googlefinance-data-no-longer.html) |
| Yahoo Finance | Chart endpoint frequently returns HTTP 429 and crumb errors since February 2025. Treated as a last-resort fallback only. | [yfinance issue #2297](https://github.com/ranaroussi/yfinance/issues/2297) |
| NSE holidays left in 2026 | 10 Nov (Diwali Balipratipada), 24 Nov (Guru Nanak Jayanti), 25 Dec (Christmas). Muhurat trading Sunday 8 Nov, timings to be announced. | [Upstox](https://upstox.com/stocks-market/nse-holidays/), [ClearTax](https://cleartax.in/s/nse-holidays-2026) |
| Zerodha charges (defaults) | Delivery: ₹0 brokerage, STT 0.1% buy and sell, stamp 0.015% buy, DP ₹15.34 per scrip on sell days. Intraday: 0.03% or ₹20 per order, STT 0.025% sell, stamp 0.003% buy. Both: NSE transaction 0.00307%, SEBI ₹10 per crore, GST 18% on brokerage + fees. | [Zerodha charges](https://www.zerodha.com/charges) |

---

## 3. Decisions those facts drive

1. **Data sources.** Angel One is primary for live quotes and candles. Google Finance backs up current quotes only. Yahoo is last resort. Every number stores its source and timestamp; quotes older than the configured limit are rejected, and a gap of more than 2% between sources is flagged.
2. **Trigger budget.** With 90 minutes of trigger time per day, the per-minute trigger exists only in market hours: a daily trigger creates it at 09:14 and the engine removes it after 15:30. Target ≤ 4 seconds per minute-run (about 25 minutes a day). The EOD scan is split across chained runs with a saved cursor.
3. **Intraday method.** A minute after each 5-minute bar closes (09:21–14:31), official 5-minute candles for yesterday and today are fetched for every intraday stock (≤ 60, three requests a second in parallel) and the intraday strategies run on the bar that just closed. Bars more than 7 minutes old count as stale and are skipped. Nifty 50's own 5-minute bars are fetched with the stocks to give the day's direction. Rules (switches in Settings and Config): buys and shorts in every regime by default, with optional blocks for buys on Bear days and shorts on Bull days; buys only while Nifty 50 is above today's open and shorts only below (on by default); one alert per stock per day, the strongest signal winning (on by default). After the close, the Phase 3 evaluator re-checks every intraday alert against 1-minute candles to decide whether the target or the stop came first; if both fall in one candle, the stop is assumed.
4. **Storage.** Alerts, paper trades, strategy status, settings and logs live in the Sheet. Daily price history lives in Drive (folder "Stock Radar Data") as 12 JSON files, each holding about 45 symbols chosen by a fixed hash, so no index file is needed. About 450 trading days are loaded at first (one Angel One request per symbol); the files can hold up to 10 years for the Phase 5 backtester. After each close the last 12 days are re-fetched and merged, so a provisional candle is corrected the next day.
5. **Login.** Daily at 08:50 with client code, MPIN and a TOTP generated inside Apps Script (RFC 6238 with HMAC-SHA1). Re-login on any auth error.
6. **One copy of the trading logic.** `core/core.js` is a plain script (no import/export) so the same file runs in the browser for backtests and is pasted unchanged into Apps Script as `Core.gs`.
7. **Keys entry.** Keys are typed into a form opened from the sheet's Stock Radar menu and go straight into Script Properties, so they never sit in the code, the sheet or its version history. A manual fallback function exists for when the form can't open.
8. **Security.** The Web App runs as the owner and requires the secret token on every call. Keys live only in Script Properties and are masked out of every log and message. The Angel One account holds no money. Portfolio data never goes into the public repo. Permissions are declared in `appsscript.json` and kept narrow: this spreadsheet only (`spreadsheets.currentonly`), Drive files the script created (`drive.file`, through the Drive web API because `DriveApp` would force full Drive access), dialogs, external requests, triggers, mail to the owner and the owner's email address.
9. **English only.** Malayalam support was dropped at the owner's request in Phase 1.
11. **App ↔ engine (Phase 4).**
    - **Requests:** the Web App (`doPost` in Api.gs, deployed "Execute as me", access "Anyone") answers POST requests with a plain-text JSON body `{a, t, …}`. Plain text avoids the CORS preflight that Apps Script cannot answer.
    - **Access:** every request needs `APP_TOKEN` (constant-time compare). Responses never contain keys or tokens.
    - **Actions:** `ping`, `bundle` (everything the screens show, in the sample data's shape), `chart` (daily candles from Drive, or 5-minute candles for an intraday alert), `news` (Google News RSS, parsed and cached 30 minutes), `settings` (allow-listed, range-checked, written to Config and Strategies under the script lock) and `testTelegram`.
    - **Connecting:** the sheet's **Connect the app** sends a link `…/#/connect?u=…&t=…` to the owner's Telegram. The app saves both, pings, then removes the token from the address bar. **New app token** rotates it.
    - **On the phone:** the app caches the last bundle in localStorage, so it opens instantly and works offline, and refreshes in the background on open and every 5 minutes while visible. Charts and news load when a sheet opens. Until connected, the app shows the labelled sample data.
10. **Evaluation (Phase 3).** The rules live in core.js (`simulateTrade`, `tradeResult`, `metrics`, `graduate`) so the Phase 5 backtester matches the live record exactly.
    - **Entry** fills like a limit order: the first candle after the alert that trades into the entry range or better (at the open if it opens inside or better, else at the range edge). Opening beyond the stop first means NOT_TRIGGERED.
    - **Exit:** a gap through the stop or target exits at the open; a candle touching both counts as the stop; in the entry candle the target counts only for an open fill; still open at expiry means EXPIRED at the last close.
    - **Candles used:** intraday alerts on 1-minute candles from the first full minute after the alert to 15:15; others on daily candles from the day after the alert.
    - **Paper trades:** sized from `paperCapital` and `riskPct`, independently of each other (no cash limit), so each strategy's record is fair. Net of Zerodha charges, intraday MIS or delivery rates.
    - **Alpha:** Nifty 50 is measured over the same holding period (1-minute for intraday, close before entry to the exit-day close otherwise).
    - **Graduation**, judged on the latest 60 closed main trades (`graduationWindowTrades`), weekly on Saturday: LIVE_READY with ≥ 30 trades from ≥ 15 different trading days, average net > 0, profit factor ≥ 1.3, drawdown ≤ 15% and average alpha > 0. REJECTED when average net < 0 after ≥ 30 trades on ≥ 15 days; it keeps paper-trading silently and can recover. The day rule was added after 26 Oct 2026, when 38 intraday shorts lost together on one rebound day: trades from one day are one piece of evidence. Each change is a Telegram message, and the override column always decides the label.
    - **Shadow track:** signals blocked only by the market filters (regime, the intraday Bear/Bull switches, the day's direction) are logged with `track = shadow`, judged the same way, and compared per filter in the weekly "Filter check". They never count towards graduation or the paper account.
    - **Checkpoints:** medium and long buys get 1, 3, 6 and 12-month checkpoints plus a FINAL row, each against Nifty 50.
    - **Exit warnings** (holding guard) are judged after 20 trading days: right if the price fell.

---

## 4. Assumptions to confirm in Phase 1

Each has a test function you run once from the Apps Script editor.

| Assumption | Test | If it fails |
|---|---|---|
| `loginByPassword` accepts MPIN + TOTP | `testLogin()` | Switch to the MPIN login path the forum mentions |
| Quote FULL mode returns open, high, low, close, volume, average price and 52-week range | `testQuotes()` | Use OHLC mode plus candles |
| Data calls work from Google's servers without a whitelisted IP | `testQuotes()`, `testCandles()` | Move live data to Fyers or Upstox through the provider layer |
| The instrument master can be fetched and filtered within limits | `testInstrumentMaster()` | Build the token map with `searchScrip` (10/s) |
| Nifty index constituent CSVs are reachable from Apps Script | `testConstituents()` | Download the CSV on the phone and import it in the app |
| Telegram bot can message you | `testTelegram()` | Re-check bot token and chat ID |

Other working assumptions: Muhurat trading is treated as a closed day for the engine unless switched on; the 2027 holiday list is added when NSE publishes it; charge rates are editable in Config.

---

## 5. Daily quota budget (estimate)

| Job | Runs per day | Time each | Trigger minutes |
|---|---|---|---|
| Minute ticks (snapshots, bookkeeping) | ~430 | ≤ 2 s | ~10 |
| Intraday 5-minute scans (09:21–14:31) | 63 | ~25 s | ~26 |
| Pre-market login, regime, brief (08:50) | 1 | ≤ 30 s | 0.5 |
| EOD history update + evaluation + scans + summary (16:00) | 2–4 chained | ≤ 4 min | ~7 |
| Weekly report (Saturday) | 1 | ≤ 60 s | 1 |
| **Total** | | | **~45 of 90** |

URL fetches: about 4,600 on a normal day (63 scans × up to 60 candle requests, about 520 daily candles at the close, and one 1-minute request per stock with an intraday alert) against the 20,000 limit. The one-time history load (about 520 requests) takes one menu run plus one or two automatic follow-ups.

---

## 6. Sheet tabs (created by `setupSheets()`)

`Config`, `Holidays`, `Symbols`, `Alerts`, `PaperTrades`, `Strategies`, `Checkpoints`, `Holdings`, `Fundamentals`, `Backtests`, `Reports`, `HealthLog`, `ErrorLog`, `Checks`, `Metrics`.

Alerts is the source of truth: each row carries its evaluation (status OPEN / ACTIVE / CLOSED, outcome, fill and exit, paper quantity, gross and net P&L, charges, Nifty move, alpha, holding time). PaperTrades is rebuilt from it after every close. Metrics holds strategy × track × regime numbers ("Insufficient data" below 30 trades).

Config also holds every strategy parameter (keys like `orb.volMult`), copied from `SRCore.PARAMS` in core.js. Strategies has one row per strategy (enabled, status, override).

## 6a. Strategies (Phase 2)

| id | Horizon | Rule in short | Target | Regimes |
|---|---|---|---|---|
| orb | Intraday | First close beyond the 15-minute opening range, volume ≥ 1.5× the last 20 bars, not more than half the range past it | Range height projected 1× / 2× | All, both ways (switches: no buys on Bear days, no shorts on Bull days; buys need Nifty above its open, shorts below) |
| vwap | Intraday | Close back above (below) VWAP after ≥ 2 of the last 4 bars on the other side, on a green (red) bar | Day's high (low) so far | as orb |
| ema-cross | Intraday | EMA 9 crosses EMA 21 on 5-minute bars, RSI(14) 50–70 (30–50 for shorts), price on the same side of VWAP | 2× / 3× risk | as orb |
| gap | Intraday | Gap of 1–5% at the open. Go: first bar with the gap, then a break of the morning extreme without filling it. Fill: first bar against the gap, then a break the other way | Go: 2× / 3× risk. Fill: previous close | All |
| base-breakout | Swing | Close above a 20-day base no wider than 12%, volume ≥ 1.5× the 20-day average, above the 50-day average | Base height 1× / 2× | Bull, Neutral |
| ema-pullback | Swing | EMA 20 > EMA 50, 50-day average rising, low touches EMA 20 and closes above it on a green day, RSI(14) 40–65 | 20-day high | Bull, Neutral |
| rsi2 | Swing | Above the 200-day average and RSI(2) < 10 | 10-day high | Bull, Neutral |
| macd | Swing | MACD crosses above its signal; price and 50-day average above the 200-day | 2× / 3× risk | Bull, Neutral |
| trend-template | Medium | Minervini template (price > 50 > 150 > 200-day, 200-day rising a month, ≥ 30% over the 52-week low, ≤ 25% under the high, RS ≥ 70), on the first day it is met | 2× / 3× risk | Bull, Neutral |
| rs-leaders | Medium | Enters the top 20% of the universe for relative strength against Nifty 50 (weighted 3/6/9/12-month returns); price > 50-day > 200-day | 2× / 3× risk | Bull, Neutral |
| near-high | Medium | First close within 3% of the 52-week high, volume ≥ average, above the 50-day | 2× / 3× risk | Bull, Neutral |
| quality-value | Long | Fundamentals score ≥ 70 with ≥ 70% of the nine fields known, above the 200-day | 2× / 3× risk, judged mainly by checkpoints | All |
| holding-guard | Long (exit) | A holding closes > 1% under its 200-day average, or through a trailing stop (22-day high close − 3 ATR) | — | All |

Common checks (in `finalize`): levels rounded to the ₹0.05 tick (stops away from the entry, chart-level targets towards it, R-multiple targets computed from the rounded levels); reward-to-risk ≥ 1.5 intraday / 2 otherwise; stop distance under the horizon limit (2.5% / 8% / 15% / 25%); 20-day average traded value ≥ ₹10 crore; regime allowed. Confidence is the rule score until a strategy has paper trades, then blends in the record (up to half the weight at 30 trades).

Regime: High-volatility when India VIX ≥ 20 (or up 30% in 5 days and ≥ 16); Bull when Nifty is above its 200-day average, the 50-day is above the 200-day and ≥ 50% of Nifty 200 stocks are above their 50-day; Bear when Nifty is below its 200-day and either the 50-day is below the 200-day or breadth is under 35%; otherwise Neutral. Unknown (no signals) until 200 days of Nifty history exist.

---

## 7. File tree

```
stock-radar/
├── index.html               PWA shell
├── manifest.webmanifest     install metadata
├── sw.js                    offline cache (bump VERSION on every release)
├── .nojekyll                serve files as-is on GitHub Pages
├── assets/
│   ├── css/app.css          design tokens and components
│   ├── fonts/               Anek Latin (OFL), self-hosted
│   └── icons/               app icons
├── js/
│   ├── app.js               shell, router, boot
│   ├── util.js              DOM builder, Indian number formats, IST calendar
│   ├── i18n.js              all interface text
│   ├── state.js             settings, theme, position sizing
│   ├── ui.js                shared components (chips, track strip, sheets)
│   ├── charts.js            SVG candle and equity charts
│   ├── icons.js             inline icons
│   ├── data.js              sample data until connected; then the engine bundle with offline cache, charts on demand
│   ├── demo.js              Phase 0 sample data, always labelled
│   ├── api.js               engine client (POST text/plain, token, timeouts, plain-English errors)
│   ├── backtest.js          (Phase 5) in-browser backtester
│   └── screens/             home, alerts, scan, results, more, settings, connect
├── core/core.js             indicators, regime, strategies, checks, sizing, charges (SRCore)
├── apps-script/             files to paste into the Apps Script editor (README.md has the steps)
│   ├── appsscript.json      manifest: Asia/Kolkata timezone, V8
│   ├── Setup.gs             Stock Radar menu, sheet creation, keys form, setup checks, status
│   ├── Data.gs              settings, storage, keys, TOTP, Angel One / Google / Yahoo with failover, calendar, stock lists
│   ├── Engine.gs            schedule, daily tick (pre-market, snapshots, closing summary), job runner and failure alerts
│   ├── Api.gs               Telegram and email, the Web App API, Connect the app
│   ├── Signals.gs           Drive price history, regime, intraday and end-of-day scans, Alerts log and messages
│   ├── Review.gs            evaluator, paper trades, checkpoints, metrics, graduation, weekly and readiness reports
│   └── Core.gs              identical copy of core/core.js
├── tools/gas-sim/           Node simulator of Apps Script services + tests for apps-script/ and core.js (run: node tools/gas-sim/tests.mjs)
│                            scenarios.mjs holds the synthetic price series each strategy is tested on
├── PLAN.md                  this file
├── CLAUDE.md                conventions for future build sessions
└── README.md
```

---

## 8. UI design system

- **Palette.** "Backwater night" petrol blue for dark mode, "Monsoon paper" cool grey-green for light mode. Turmeric is the only accent and marks actions and Live-ready trust. Green and red are reserved for gains and losses. All text pairs meet WCAG AA in both themes.
- **Type.** Anek Latin by Ek Type, self-hosted. Condensed widths for headlines, tabular figures for every price.
- **Signature element.** The ball-by-ball track record: 30 dots in five groups of six, like overs, filling green (target hit), red (stop hit) or hollow (expired) as paper trades close. A strategy has to fill its strip before it can be trusted with real money.
- **Principles.** Evidence before advice. Plain sentences over jargon. Indian number grouping and IST everywhere. Thumb-first layout with bottom navigation and bottom sheets that close with the Android back button. Honest states for sample, stale or missing data.

---

## 9. Phases

| Phase | Deliverable | Status |
|---|---|---|
| 0 | Plan, verified facts, file tree, UI design preview | ✅ Done |
| 1 | `setupSheets()`, providers, TOTP login, Telegram, scheduler, health log, test functions | ✅ Done (23 simulator tests) |
| 2 | `core.js` indicators and strategies, intraday engine, EOD scans, alert logging, price history backfill | ✅ Done |
| 3 | Evaluator, metrics, auto paper trading, graduation, daily, weekly and readiness reports | ✅ Done (74 simulator tests) |
| 4 | Web App API, PWA wired to live data, settings synced to the engine | ✅ Done (79 simulator tests, live screens checked at 390×844) |
| 5 | Backtester and Backtest Baseline report, portfolio import, optional AI summaries | Next |
