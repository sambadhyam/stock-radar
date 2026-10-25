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
| [Core.gs](Core.gs) | `Core` (Phase 2; the same file as `core/core.js`) |
| [appsscript.json](appsscript.json) | `appsscript.json` (required: India time and the exact permissions the engine may use) |

---

## Part A — Copy the code in (about 10 minutes)

1. Open your **Stock Radar DB** sheet → **Extensions → Apps Script**.
2. Rename the starting file: tap **⋮** next to `Code.gs` → **Rename** → type `Setup` → Enter.
3. Add the other files: tap **+** next to **Files** → **Script**, name it `Data`. Repeat for `Engine`, `Api`, `Signals` and `Core`.
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

## Strategies and settings

The **Strategies** sheet has one row per strategy. Set **enabled** to FALSE to switch one off. Every strategy starts as **PAPER**: its alerts are labelled "PAPER — not for real money" until it has a track record (Phase 3). The **override** column lets you force a status (PAPER, LIVE_READY or REJECTED).

Every threshold the strategies use is a row in **Config** (keys such as `orb.volMult` or `swing.holdDays`), with a description next to it. Change the value in column B; the next scan uses it.

| Horizon | Strategies | Universe | When |
|---|---|---|---|
| Intraday | Opening-range breakout, VWAP reclaim, EMA 9/21 cross, Gap and go / gap fill | Nifty 50 + watchlist | After each 5-minute bar, 09:20–14:30; valid until 15:15 |
| Swing (2–10 days) | Base breakout, Pullback to 20 EMA, RSI(2) dip in uptrend, MACD trend cross | Nifty 200 | After the close |
| Medium (1–6 months) | Trend template, Relative strength leaders, Near 52-week high | Nifty 200 | After the close |
| Long (12+ months) | Quality-value score (needs the Fundamentals sheet, Phase 5), Holding guard (exit warnings for stocks in the Holdings sheet) | Nifty 500 + ETFs | After the close |

Every signal must pass: reward-to-risk of at least 1.5 (intraday) or 2 (others), an average traded value of at least ₹10 crore a day, a stop no further than the horizon's limit, and a market regime the strategy is allowed to trade in. Swing and medium buys need a Bull or Neutral regime; intraday buys are allowed in Bull, Neutral and High-volatility, intraday shorts in Bear, Neutral and High-volatility. No signals go out while the price history is missing or stale.

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

## Updating later

When a later phase changes a file, repeat step A.4 for just that file and save. Your keys, sheets and settings stay as they are.

## Keeping it safe

Keys live in this script's private settings, not in the sheet or the code. Anyone who can edit this sheet could read them, so don't share the sheet, and keep 2-step verification on your Google account. The Angel One account is for data only; keep no money in it.
