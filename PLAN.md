# Stock Radar India — build plan

Personal NSE analysis, alerts and self-checking paper trading. Phone-only workflow: the app lives on GitHub Pages, the engine runs in Google Apps Script, alerts arrive on Telegram, and every real order is placed by hand in Kite.

- **App:** https://sambadhyam.github.io/stock-radar/
- **Repo:** `sambadhyam/stock-radar`
- **Status:** Phase 0 complete (plan, verified facts, UI design preview with sample data)

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
3. **Intraday method.** Each minute: one or two batched quote calls (≤ 60 symbols). Official 5-minute candles are fetched only for symbols with a setup forming. After the close, the evaluator re-checks every intraday alert against 1-minute candles to decide whether the target or the stop came first; if both fall in one candle, the stop is assumed.
4. **Storage.** Alerts, paper trades, strategy status, settings and logs live in the Sheet. Multi-year daily price history lives in Drive as packed JSON files, which keeps the Sheet small and fast and feeds the in-app backtester.
5. **Login.** Daily at 08:50 with client code, MPIN and a TOTP generated inside Apps Script (RFC 6238 with HMAC-SHA1). Re-login on any auth error.
6. **One copy of the trading logic.** `core/core.js` is a plain script (no import/export) so the same file runs in the browser for backtests and is pasted unchanged into Apps Script as `Core.gs`.
7. **Bilingual messages.** The engine stores reasons as codes with parameters (for example `ORB_BREAK {level: 1406.5}`); the app turns them into English or Malayalam.
8. **Security.** The Web App runs as the owner and requires the secret token on every call. Keys live only in Script Properties. The Angel One account holds no money. Portfolio data never goes into the public repo.

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
| Intraday engine (09:15–15:30) | ~375 | ≤ 4 s | ~25 |
| 5-min candle checks for active setups | ~75 | ≤ 3 s | ~4 |
| Pre-market login + brief (08:50) | 1 | ≤ 30 s | 0.5 |
| EOD fetch, scans, evaluator, paper trades (16:00) | 4–8 chained | ≤ 60 s | ~6 |
| Weekly report (Saturday) | 1 | ≤ 60 s | 1 |
| **Total** | | | **~37 of 90** |

URL fetches: roughly 1,500 on a normal day against the 20,000 limit. The one-time history backfill (about 500 symbols) is spread over several runs.

---

## 6. Sheet tabs (created by `setupSheets()` in Phase 1)

`Config`, `Holidays`, `Symbols`, `Alerts`, `PaperTrades`, `Strategies`, `Checkpoints`, `Holdings`, `Fundamentals`, `Backtests`, `Reports`, `HealthLog`, `ErrorLog`.

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
│   ├── fonts/               Anek Latin + Malayalam (OFL), self-hosted
│   └── icons/               app icons
├── js/
│   ├── app.js               shell, router, boot
│   ├── util.js              DOM builder, Indian number formats, IST calendar
│   ├── i18n.js              English and Malayalam text
│   ├── state.js             settings, theme, position sizing
│   ├── ui.js                shared components (chips, track strip, sheets)
│   ├── charts.js            SVG candle and equity charts
│   ├── icons.js             inline icons
│   ├── data.js              data source switch (sample now, API in Phase 4)
│   ├── demo.js              Phase 0 sample data, always labelled
│   ├── api.js               (Phase 4) Apps Script client with offline cache
│   ├── backtest.js          (Phase 5) in-browser backtester
│   └── screens/             home, alerts, scan, results, more, settings
├── core/core.js             (Phase 2) indicators, strategies, evaluator maths
├── apps-script/             (Phase 1+) files to paste into the Apps Script editor
│   ├── appsscript.json      manifest: Asia/Kolkata timezone, V8, scopes
│   ├── Core.gs              identical copy of core/core.js
│   ├── Data.gs              providers, TOTP login, failover, price history
│   ├── Engine.gs            scheduler, intraday and EOD engines, evaluator, paper trading
│   ├── Api.gs               Web App API, Telegram and Gmail
│   └── Setup.gs             setupSecrets, setupSheets, installTriggers, test functions
├── PLAN.md                  this file
├── CLAUDE.md                conventions for future build sessions
└── README.md
```

---

## 8. UI design system

- **Palette.** "Backwater night" petrol blue for dark mode, "Monsoon paper" cool grey-green for light mode. Turmeric is the only accent and marks actions and Live-ready trust. Green and red are reserved for gains and losses. All text pairs meet WCAG AA in both themes.
- **Type.** Anek by Ek Type, one family covering Latin and Malayalam, self-hosted. Condensed widths for headlines, tabular figures for every price.
- **Signature element.** The ball-by-ball track record: 30 dots in five groups of six, like overs, filling green (target hit), red (stop hit) or hollow (expired) as paper trades close. A strategy has to fill its strip before it can be trusted with real money.
- **Principles.** Evidence before advice. Plain sentences over jargon. Indian number grouping and IST everywhere. Thumb-first layout with bottom navigation and bottom sheets that close with the Android back button. Honest states for sample, stale or missing data.

---

## 9. Phases

| Phase | Deliverable | Status |
|---|---|---|
| 0 | Plan, verified facts, file tree, UI design preview | ✅ Done |
| 1 | `setupSheets()`, providers, TOTP login, Telegram, scheduler, health log, test functions | Next |
| 2 | `core.js` indicators and strategies, intraday engine, EOD scans, alert logging | |
| 3 | Evaluator, metrics, auto paper trading, graduation, daily, weekly and readiness reports | |
| 4 | Web App API, PWA wired to live data, settings synced to the engine | |
| 5 | Backtester and Backtest Baseline report, portfolio import, optional AI summaries | |
