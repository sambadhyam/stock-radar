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
- `core/core.js` and `apps-script/Core.gs` must stay byte-identical: no `import`/`export`, no DOM, no Apps Script services inside.
- Every interface string goes through `js/i18n.js` with both English and Malayalam entries.
- Sample data lives only in `js/demo.js`, and any screen showing it must show the design-preview banner.
- Colors, type and spacing come from the tokens at the top of `assets/css/app.css`; add a token rather than a one-off value.
- Bump `VERSION` in `sw.js` on every release and list any new file in its `ASSETS`.
- Prices use Indian grouping and IST (`fmt` in `js/util.js`). Use the real minus sign for negatives.
- The app never places orders. Alerts, paper trades and analysis only.

## Checking work
- Serve locally with `python3 -m http.server` and screenshot at 390×844 in both themes and both languages.
- Confirm there are no console errors and that the Android back button closes bottom sheets.
