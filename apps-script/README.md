# Engine setup

These files run in Google Apps Script, attached to your **Stock Radar DB** sheet. You copy them in once; after that everything is done from a **Stock Radar** menu inside the sheet.

Use Chrome with **⋮ → Desktop site** ticked for every step.

| File here | Name it in Apps Script |
|---|---|
| [Setup.gs](Setup.gs) | `Setup` |
| [Data.gs](Data.gs) | `Data` |
| [Engine.gs](Engine.gs) | `Engine` |
| [Api.gs](Api.gs) | `Api` |
| [Signals.gs](Signals.gs) | `Signals` (Phase 2) |
| [Review.gs](Review.gs) | `Review` (Phase 3) |
| [Core.gs](Core.gs) | `Core` (Phase 2; the same file as `core/core.js`) |
| [appsscript.json](appsscript.json) | `appsscript.json` (required: India time and the exact permissions the engine may use) |

---

## Part A — Copy the code in (about 10 minutes)

1. Open your **Stock Radar DB** sheet → **Extensions → Apps Script**.
2. Rename the starting file: tap **⋮** next to `Code.gs` → **Rename** → type `Setup` → Enter.
3. Add the other files: tap **+** next to **Files** → **Script**, name it `Data`. Repeat for `Engine`, `Api`, `Signals`, `Review` and `Core`.
4. Fill each file, one at a time:
   1. In another tab, open the file on GitHub (links in the table above).
   2. Tap the **copy icon** (two small squares) at the top right of the code. If you don't see it, tap **Raw**, then long-press → **Select all** → **Copy**.
   3. Back in Apps Script, open the matching file, tap in the code, long-press → **Select all**, then paste so it replaces everything.
5. Tap the **Save** icon (floppy disk). There should be no red error underline.
6. Tap the **gear icon** (Project Settings) → tick **Show "appsscript.json" manifest file in editor** → go back to the editor, open `appsscript.json`, replace its content with [appsscript.json](appsscript.json), and save. This sets India time and limits what the script may access (see "Permissions" below). Under **Services** on the left you should now see **Drive**; if not, tap **+** next to Services → **Drive API** → **Add**.

You never paste keys into these files.

---

## Part B — Set up from the sheet menu (about 10 minutes)

1. Switch to the sheet tab and **reload the page**. After a few seconds a **Stock Radar** menu appears in the menu bar, usually after **Help**. If the menu bar is hidden, tap the small **⌃** at the top right.
2. **Stock Radar → 1. Create sheets.** The first time, Google asks for permission:
   - **Continue** → pick your Google account.
   - "Google hasn't verified this app" → **Advanced** → **Go to Stock Radar Engine (unsafe)** → **Allow**.
   - This is your own code asking to use your sheet, connect to Angel One, Telegram and NSE, run on a schedule, and email you the daily summary.
   - If nothing seemed to happen, run **1. Create sheets** again. You'll see "Sheets are ready".
3. **Stock Radar → 2. Set up keys.** Fill in the six boxes and tap **Save keys**:
   - Angel One client ID, PIN, SmartAPI API key, TOTP secret key
   - Telegram bot token and chat ID
   - (Gemini is optional, leave it empty for now)
4. **Stock Radar → 3. Run all tests.** Takes 1–2 minutes. You get a results box, a Telegram message, a test email, and the same results in the **Checks** sheet.
5. **Stock Radar → 4. Load stock lists.** Takes 1–3 minutes. Fills the **Symbols** sheet with Nifty 50/200/500 stocks, 3 core ETFs and the main indices.
6. **Stock Radar → 5. Start daily schedule.**
7. **Stock Radar → 6. Load price history.** Google asks for one more permission the first time (Drive, for the price files). About two years of daily candles for every stock go into a **Stock Radar Data** folder in your Drive. The first batch takes up to 4 minutes; the rest load by themselves, and Telegram tells you when it's done.

**What happens next:** on every trading day:
- **08:50** pre-market check on Telegram, with the market regime.
- **09:21–14:31**, a minute after each 5-minute bar closes: the intraday scan of the Nifty 50 and your watchlist. Each signal is a Telegram message and a row in the **Alerts** sheet.
- **15:10** square-off reminder, if intraday alerts went out.
- **After 16:00** the price history is updated, the swing, medium-term and long-term scans run, and the daily summary arrives on Telegram and email.

Weekends and NSE holidays are skipped.

**Every alert is judged automatically** (Phase 3):
- Intraday alerts after the close, on 1-minute candles.
- Swing, medium and long alerts after each close, on daily candles.
- Each filled alert is a paper trade from your virtual capital (`paperCapital`, `riskPct`), after estimated Zerodha charges. The results go into the **Alerts**, **PaperTrades**, **Metrics**, **Strategies** and **Checkpoints** sheets.
- The daily summary shows the paper results.
- Every Saturday the weekly report decides which strategies are **Live-ready** or **Rejected**, with a message for each change.
- On day 30, 60 and 90 a **readiness report** gives a verdict for every strategy.

---

## Permissions

`appsscript.json` lists exactly what the engine may do, so Google asks only for these:

| Permission | Why |
|---|---|
| Spreadsheets this script is installed in | Read and write the Stock Radar DB sheet only, no other spreadsheet |
| Show prompts and sidebars | The keys form, test results and status boxes |
| Connect to an external service | Angel One, Telegram, Google Finance, NSE |
| Run when you are not present | The daily schedule |
| Send email as you | The daily summary to your own address |
| See your email address | To know where to send that summary |
| Only the Drive files used with this app | The "Stock Radar Data" folder the script creates; it cannot see the rest of your Drive |

## Phase 2 update (if you set up Phase 1 already)

1. Open the sheet → **Extensions → Apps Script**.
2. Add two new files: **+** next to **Files** → **Script** → name it `Signals`; again → `Core`.
3. Paste these five files over what is there, one at a time (open the link, **Ctrl+A**, **Ctrl+C**; in Apps Script click in the file, **Ctrl+A**, **Ctrl+V**):
   [Core.gs](https://raw.githubusercontent.com/sambadhyam/stock-radar/main/apps-script/Core.gs) →  `Core`,
   [Signals.gs](https://raw.githubusercontent.com/sambadhyam/stock-radar/main/apps-script/Signals.gs) → `Signals`,
   [Data.gs](https://raw.githubusercontent.com/sambadhyam/stock-radar/main/apps-script/Data.gs) → `Data`,
   [Engine.gs](https://raw.githubusercontent.com/sambadhyam/stock-radar/main/apps-script/Engine.gs) → `Engine`,
   [Setup.gs](https://raw.githubusercontent.com/sambadhyam/stock-radar/main/apps-script/Setup.gs) → `Setup`.
   `Api.gs` and `appsscript.json` are unchanged.
4. **Ctrl+S** to save. Go back to the sheet and reload it.
5. Paste [appsscript.json](https://raw.githubusercontent.com/sambadhyam/stock-radar/main/apps-script/appsscript.json) too (Project Settings → tick **Show "appsscript.json" manifest file in editor** first). Check that **Drive** appears under **Services**.
6. **Stock Radar → 1. Create sheets.** This adds the strategy settings to **Config** and a row per strategy to **Strategies**. Your keys and settings are kept.
7. **Stock Radar → 6. Load price history**, and allow the permissions (the Drive one says "only the specific Google Drive files you use with this app").

Your daily schedule keeps running; there is no need to start it again.

## Phase 4 update: connect the phone app

**1. Paste four files** (open the link, **Ctrl+A**, **Ctrl+C**; in Apps Script click in the file, **Ctrl+A**, **Ctrl+V**):
[Api.gs](https://raw.githubusercontent.com/sambadhyam/stock-radar/main/apps-script/Api.gs) → `Api`,
[Signals.gs](https://raw.githubusercontent.com/sambadhyam/stock-radar/main/apps-script/Signals.gs) → `Signals`,
[Setup.gs](https://raw.githubusercontent.com/sambadhyam/stock-radar/main/apps-script/Setup.gs) → `Setup`,
[Data.gs](https://raw.githubusercontent.com/sambadhyam/stock-radar/main/apps-script/Data.gs) → `Data`.
Then **Ctrl+S**.

**2. Publish the engine as a web app** (once):
1. In Apps Script, top right: **Deploy → New deployment**.
2. Click the gear next to "Select type" and choose **Web app**.
3. Set **Execute as: Me** and **Who has access: Anyone**, then click **Deploy**.
4. If Google asks, allow access as before.
5. Copy the **Web app URL** (it ends with `/exec`).

"Anyone" only means the app can reach the engine. Every request must carry your private app token, and without it the engine returns nothing.

**3. Connect the phone:**
1. Reload the sheet, then run **Stock Radar → Connect the app**.
2. Paste the Web app URL and click **Send the connect link to my Telegram**.
3. On your phone, open that link from Telegram in Chrome. The app saves the connection, checks it, and switches from sample data to your engine.
4. Delete the Telegram message afterwards.

**After any later code update**, the web app keeps running the old code until you publish a new version: **Deploy → Manage deployments → ✏️ (edit) → Version: New version → Deploy**. The address stays the same.

If the link ever leaks, run **Stock Radar → New app token** and connect again.

## Phase 3 update

1. In Apps Script add a new file: **+** next to **Files** → **Script** → name it `Review`.
2. Paste these six files over what is there (open the link, **Ctrl+A**, **Ctrl+C**; click in the Apps Script file, **Ctrl+A**, **Ctrl+V**):
   [Review.gs](https://raw.githubusercontent.com/sambadhyam/stock-radar/main/apps-script/Review.gs) → `Review`,
   [Core.gs](https://raw.githubusercontent.com/sambadhyam/stock-radar/main/apps-script/Core.gs) → `Core`,
   [Signals.gs](https://raw.githubusercontent.com/sambadhyam/stock-radar/main/apps-script/Signals.gs) → `Signals`,
   [Engine.gs](https://raw.githubusercontent.com/sambadhyam/stock-radar/main/apps-script/Engine.gs) → `Engine`,
   [Data.gs](https://raw.githubusercontent.com/sambadhyam/stock-radar/main/apps-script/Data.gs) → `Data`,
   [Setup.gs](https://raw.githubusercontent.com/sambadhyam/stock-radar/main/apps-script/Setup.gs) → `Setup`.
   `Api.gs` and `appsscript.json` are unchanged.
3. **Ctrl+S**, go back to the sheet and reload it.
4. **Stock Radar → 1. Create sheets.** Adds the new columns, the **Metrics** sheet and three new settings. Nothing else changes.

The schedule keeps running. The first results arrive with the next closing summary.

## How alerts are judged

| Outcome | Meaning |
|---|---|
| TARGET_HIT | The price reached the first target after the entry |
| STOP_HIT | The price reached the stop first (if one candle touched both, the stop is assumed) |
| EXPIRED | Neither, by the end of the alert's window; closed at the last price |
| NOT_TRIGGERED | The price never came into the entry range (or opened beyond the stop first); not counted |
| EXIT_RIGHT / EXIT_EARLY | Exit warnings for your holdings, 20 trading days later: the price fell, or rose |

The entry works like a limit order inside the alert's entry range, at the price you could actually have got after the alert went out. Paper trades are sized from the virtual capital and are independent of each other, so every strategy gets a fair record.

A strategy becomes **Live-ready** after at least 30 closed paper trades, using its latest 60. It also needs a positive average result after charges, a profit factor of 1.3 or more, a drawdown of 15% or less, and to beat Nifty 50 over the same holding periods. It is **Rejected** if its average result after charges is negative after 30 trades. A rejected strategy keeps paper-trading silently and can recover. You can set any status by hand in the **override** column of the Strategies sheet.

**Signals blocked only by the market filters** (for example, swing buys in a Bear market, or an intraday buy while Nifty 50 is below its open) are logged with track "shadow" and judged the same way, without any message. They never count towards a strategy's record. The weekly report's **Filter check** compares them with the signals that were taken, separately for the regime, your Bear/Bull switches and the day's direction, to show whether each filter helps. Switch this off with `shadowTracking` in Config.

**Live-ready or Rejected** needs at least 30 closed paper trades (`graduationMinTrades`) spread over at least 15 different trading days (`graduationMinDays`). Trades from the same day share one market move, so 38 shorts on one rebound day count as one piece of evidence, not 38.

**Stock Radar → Update paper results now** runs the judging straight away outside market hours.

## Strategies and settings

The **Strategies** sheet has one row per strategy. Set **enabled** to FALSE to switch one off. Every strategy starts as **PAPER**: its alerts are labelled "PAPER — not for real money" until it has a track record (Phase 3). The **override** column lets you force a status (PAPER, LIVE_READY or REJECTED).

Every threshold the strategies use is a row in **Config** (keys such as `orb.volMult` or `swing.holdDays`), with a description next to it. Change the value in column B; the next scan uses it.

| Horizon | Strategies | Universe | When |
|---|---|---|---|
| Intraday | Opening-range breakout, VWAP reclaim, EMA 9/21 cross, Gap and go / gap fill | Nifty 50 + watchlist | After each 5-minute bar, 09:20–14:30; valid until 15:15 |
| Swing (2–10 days) | Base breakout, Pullback to 20 EMA, RSI(2) dip in uptrend, MACD trend cross | Nifty 200 | After the close |
| Medium (1–6 months) | Trend template, Relative strength leaders, Near 52-week high | Nifty 200 | After the close |
| Long (12+ months) | Quality-value score (needs the Fundamentals sheet, Phase 5), Holding guard (exit warnings for stocks in the Holdings sheet) | Nifty 500 + ETFs | After the close |

Every signal must pass: reward-to-risk of at least 1.5 (intraday) or 2 (others), an average traded value of at least ₹10 crore a day, a stop no further than the horizon's limit, and a market regime the strategy is allowed to trade in. Swing and medium buys need a Bull or Neutral regime. No signals go out while the price history is missing or stale.

**Intraday rules** (each is a switch in the app's Settings → Intraday signals, and a row in Config):

| Config key | Default | What it does |
|---|---|---|
| `intradayFollowNifty` | TRUE | Buy only while Nifty 50 is above today's opening price; short only while it is below. Nifty's own 5-minute bars are fetched with the stocks. |
| `intradayBlockBuysInBear` | FALSE | No intraday buys on Bear-regime days. Off means buy and short signals in every regime. |
| `intradayBlockShortsInBull` | FALSE | No intraday shorts on Bull-regime days. |
| `intradayOneAlertPerStock` | TRUE | At most one intraday alert per stock per day; when several strategies fire together, the strongest wins. |

---

## What good test results look like

| Check | Expected | If not |
|---|---|---|
| Keys saved | PASS | Run 2. Set up keys again |
| Telegram message | PASS, and a "connected" message in Telegram | Tap **Start** in your bot's chat, re-check bot token and chat ID |
| Email | PASS, and a test email arrives | Check spam |
| Angel One login | PASS with your name | See "Angel One errors" below |
| Symbol search | PASS | Usually fixed with the login |
| Live quotes | PASS | WARN lists missing fields: send me a screenshot |
| Daily candles | PASS | Send a screenshot |
| 5-minute candles | PASS (WARN is fine on some days) | |
| Instrument list | PASS | WARN or FAIL is fine: the engine uses symbol search instead |
| Nifty stock lists | PASS | WARN: use the import steps below |
| Google Finance backup | PASS | WARN is fine |
| Yahoo Finance backup | WARN is normal | Only a last-resort backup |
| Price cross-check | PASS | WARN during market hours is normal (Google is delayed) |
| Trading calendar | PASS | |

Send me a screenshot of the results box (or the Checks sheet) when you're done.

---

## Fixes

**No Stock Radar menu.** Reload the sheet with Desktop site on and wait 10 seconds. Check that the `Setup` file was saved and starts with the Stock Radar comment.

**The keys form doesn't open.** Plan B: in Apps Script open `Setup`, find `setupSecretsManually`, type each value between its quotes, choose `setupSecretsManually` in the function list at the top and tap **Run**. Read the message in the log below, then **delete the values you typed and save**, so no key stays in the code.

**Angel One errors**
- *Invalid totp*: the TOTP secret key is wrong. Copy the text key again from the SmartAPI TOTP page (or enable TOTP again to get a new one) and save it in 2. Set up keys.
- *Invalid clientcode or PIN*: re-check your client ID and 4-digit PIN.
- *Invalid API Key*: copy the API key again from your app on the SmartAPI portal.
- *Account not active*: finish Angel One's account opening (eSign) first.

**Nifty stock lists not reachable** (NSE sometimes blocks Google's servers). Do this once for each list:
1. Open these links in Chrome on your phone; each downloads a CSV file:
   [Nifty 50](https://niftyindices.com/IndexConstituent/ind_nifty50list.csv), [Nifty 200](https://niftyindices.com/IndexConstituent/ind_nifty200list.csv), [Nifty 500](https://niftyindices.com/IndexConstituent/ind_nifty500list.csv)
2. In the sheet: **File → Import → Upload** → choose the file → **Import location: Insert new sheet(s)** → **Import data**.
3. After all three, run **4. Load stock lists**. The new tabs are read automatically.

**Where to look when something goes wrong.** The **ErrorLog** sheet lists failures with times; **HealthLog** shows each data source call. In Apps Script, **Executions** (list icon on the left) shows every run.

**Stopping everything.** Stock Radar → **Stop daily schedule**. Turn it back on with **5. Start daily schedule**.

---

**Optional: drop permissions granted before.** Phase 1 was allowed to use all your spreadsheets. To remove that older permission: open [myaccount.google.com/connections](https://myaccount.google.com/connections) → **Stock Radar Engine** → delete the connection. Then in the sheet run any Stock Radar menu item and allow again (only the list above is asked for), and run **5. Start daily schedule** once more.

**"Google Drive files" check fails.** If it says the Drive API is not switched on: in Apps Script tap **+** next to **Services** → **Drive API** → **Add**, then run the check again. If it says the permission is missing: paste the latest `appsscript.json`, then run **6. Load price history** and allow.

## Update 0.5.1: intraday fixes (after Monday 26 October)

Paste six files (every file except Setup; open each link, select all, copy; then in Apps Script select all in the matching file, paste, save):
[Core.gs](Core.gs) → `Core`, [Signals.gs](Signals.gs) → `Signals`, [Review.gs](Review.gs) → `Review`, [Engine.gs](Engine.gs) → `Engine`, [Api.gs](Api.gs) → `Api`, [Data.gs](Data.gs) → `Data`.
Then publish the web app again: **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**.

## Updating later

When a later phase changes a file, repeat step A.4 for just that file and save. Your keys, sheets and settings stay as they are.

## Keeping it safe

Keys live in this script's private settings, not in the sheet or the code. Anyone who can edit this sheet could read them, so don't share the sheet, and keep 2-step verification on your Google account. The Angel One account is for data only; keep no money in it.
