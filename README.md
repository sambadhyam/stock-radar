# Stock Radar

A personal tool for the Indian stock market: it reads NSE data, applies fixed rules for intraday, swing, medium and long-term setups, sends alerts to Telegram, and paper-trades every signal so each strategy earns trust before real money follows. Orders are always placed by hand in Zerodha Kite.

**Open the app:** https://sambadhyam.github.io/stock-radar/

## Install on Android
1. Open the link above in Chrome.
2. Tap **⋮ → Add to Home screen** (or **Install app**).
3. Open it from the home screen; it works offline after the first visit.

## Status
All five phases are built. The app shows your engine's live alerts, paper results and strategy records once connected (Stock Radar → Connect the app in the sheet). The engine runs in Google Apps Script (setup steps in [apps-script/README.md](apps-script/README.md)):
- 13 strategies across intraday, swing, medium and long horizons, with Telegram alerts.
- Every alert is judged on later real prices and paper-traded after estimated Zerodha charges.
- Strategies graduate to Live-ready, or are rejected, on their own record, spread over at least 15 trading days.
- Daily, weekly and day-30/60/90 readiness reports.
- A Backtest Baseline on up to 10 years of history with the same rules, and a Backtest lab in the app for your own tests.
- Portfolio import from Zerodha (P&L, sector mix, concentration warnings, exit warnings) and fundamentals import from Screener.
- Optional AI news summaries (Gemini), off by default and always labelled "not a signal".

Until connected it shows clearly labelled sample data. See [PLAN.md](PLAN.md) for the full build plan.

## Disclaimer
This is not investment advice. Signals can be wrong, and paper results do not guarantee future returns.

Typeface: Anek by Ek Type, SIL Open Font License (see `assets/fonts/OFL-Anek.txt`).
