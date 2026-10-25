# Notes for build sessions

Read `PLAN.md` first: it holds the architecture, verified API facts, quota budget and phase status.

## Who uses this and how
- The owner works from an Android phone only: no laptop, terminal, npm or clasp.
- Frontend files are committed straight to this repo; GitHub Pages serves `main` from the root.
- Apps Script files in `apps-script/` are pasted by hand into the editor, so keep them few, complete and paste-ready (no placeholders), and give Android-friendly steps.
- Work is phased. After each phase, stop and wait for the owner's "next".

## Rules
- No build step. Vanilla JS ES modules in the browser; plain scripts in Apps Script (V8).
- Never commit secrets, tokens, personal holdings or account data. Secrets live in Apps Script Script Properties only.
- `core/core.js` and `apps-script/Core.gs` must stay byte-identical: no `import`/`export`, no DOM, no Apps Script services inside. Edit core.js, then `cp core/core.js apps-script/Core.gs` (a test fails if they differ).
- Strategy thresholds live in `SRCore.PARAMS`; they appear in the Config sheet automatically. Each strategy has a scenario in `tools/gas-sim/scenarios.mjs` and a test that it fires there (and its mirror fires as a short, for intraday).
- Every interface string goes through `js/i18n.js` (English only; Malayalam was dropped at the owner's request).
- Sample data lives only in `js/demo.js`, and any screen showing it must show the design-preview banner.
- Colors, type and spacing come from the tokens at the top of `assets/css/app.css`; add a token rather than a one-off value.
- Bump `VERSION` in `sw.js` on every release and list any new file in its `ASSETS`.
- Prices use Indian grouping and IST (`fmt` in `js/util.js`). Use the real minus sign for negatives.
- The app never places orders. Alerts, paper trades and analysis only.

## Apps Script rules
- Files share one global scope and may load in any order: no top-level code may use something defined in another file (wrap such tables in functions, like `sheetSchemas_()`).
- Avoid names that clash with Google services (`Calendar`, `Drive`, `Sheets`, `Gmail`…); the calendar helper is `MarketCal`.
- Stay with ES2015-era syntax in `.gs` (no optional chaining or `??`) to be safe on the V8 runtime.
- Write text-like values (times, dates, tokens) into columns formatted as plain text (`setNumberFormat('@')`), or Sheets converts them.
- Never log or show key values; pass messages through `Secrets.mask`.
- Permissions are listed explicitly in `appsscript.json` (`oauthScopes`), so automatic detection is off. A new Google service means adding its scope there; the simulator refuses anything not listed. Keep them narrow: `spreadsheets.currentonly`, `drive.file`. Never use `DriveApp` (it forces access to the whole Drive); use `DriveFiles` in Signals.gs, which calls the Drive web API.
- After any change in `apps-script/`, run `node tools/gas-sim/tests.mjs` and keep it green.

## Checking work
- Serve locally with `python3 -m http.server` and screenshot at 390×844 in both themes.
- Confirm there are no console errors and that the Android back button closes bottom sheets.
