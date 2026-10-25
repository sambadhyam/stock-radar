# Engine setup (Phase 1)

These files run in Google Apps Script, attached to your **Stock Radar DB** sheet. You copy them in once; after that everything is done from a **Stock Radar** menu inside the sheet.

Use Chrome with **⋮ → Desktop site** ticked for every step.

| File here | Name it in Apps Script |
|---|---|
| [Setup.gs](Setup.gs) | `Setup` |
| [Data.gs](Data.gs) | `Data` |
| [Engine.gs](Engine.gs) | `Engine` |
| [Api.gs](Api.gs) | `Api` |
| [appsscript.json](appsscript.json) | `appsscript.json` (optional, sets India time) |

---

## Part A — Copy the code in (about 10 minutes)

1. Open your **Stock Radar DB** sheet → **Extensions → Apps Script**.
2. Rename the starting file: tap **⋮** next to `Code.gs` → **Rename** → type `Setup` → Enter.
3. Add three more files: tap **+** next to **Files** → **Script**, name it `Data`. Repeat for `Engine` and `Api`.
4. Fill each file, one at a time:
   1. In another tab, open the file on GitHub (links in the table above).
   2. Tap the **copy icon** (two small squares) at the top right of the code. If you don't see it, tap **Raw**, then long-press → **Select all** → **Copy**.
   3. Back in Apps Script, open the matching file, tap in the code, long-press → **Select all**, then paste so it replaces everything.
5. Tap the **Save** icon (floppy disk). There should be no red error underline.
6. Recommended: tap the **gear icon** (Project Settings) → tick **Show "appsscript.json" manifest file in editor** → go back to the editor, open `appsscript.json`, replace its content with [appsscript.json](appsscript.json), and save. This sets the project to India time.

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

**What happens next:** on every trading day you get a **pre-market check on Telegram at 08:50** and a **daily summary on Telegram and email after 16:00**. Weekends and NSE holidays are skipped. Phase 1 has no buy/sell signals yet; strategies arrive in Phase 2.

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

## Updating later

When a later phase changes a file, repeat step A.4 for just that file and save. Your keys, sheets and settings stay as they are.

## Keeping it safe

Keys live in this script's private settings, not in the sheet or the code. Anyone who can edit this sheet could read them, so don't share the sheet, and keep 2-step verification on your Google account. The Angel One account is for data only; keep no money in it.
