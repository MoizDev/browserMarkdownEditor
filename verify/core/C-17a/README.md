# C-17a — browser-storage recovery sanity

`node run.mjs --url URL --out OUTPUT --mirror --console-only [--theme dark]`
drives the actual app using `verify/lib` and an OPFS vault. `--console-only` skips
JSON reports and the before screenshot; workspace screenshots remain for inspection.
`--notice-api` is dev-only and checks that App has already consumed the notice.

## Observed

- Unfixed clear + reload: light/font22/tab7 became dark/font16/tab4; a three-note
  session lost alpha/beta and its scroll record. Evidence:
  `/Users/adham/Developer/bme-impl/scratch/c-b/C-17a/baseline/`.
- Production candidate: nondefault settings, all three notes and gamma's exact
  scroll record survive clear + reload. Another window clears while the live
  Settings panel changes font22→23; the newer value survives recovery and reload.
- Settings → Reset to Defaults performs the genuine `terminalFontSize` removal.
  After reconciliation its mirror entry is a tombstone; another clear + reload
  does not resurrect it. Reconciliation is awaited by observing IndexedDB, not sleep.
- Dev/StrictMode dark run: same flow passes, and the notice API returns
  `Settings restored after another tab reset them` once, then null.

Passing reports: `scratch/c-b/C-17a/sanity-reload/report.json` (production light)
and `scratch/c-b/C-17a/dev-notice/report.json` (dev dark), under the absolute
`/Users/adham/Developer/bme-impl/` scratch root. Both themes' `after.png` were inspected.
Final typecheck/lint pass: hc terminal `t382`; production build: `t362`.

The initial expanded run exposed a harness assumption: activating another headless
page need not hide this page. The removal arm now uses real reloads and observes
post-first-paint reconciliation. This run does not independently prove native hide
or shutdown durability. All scoped servers stop in the controller's `finally`.

## Deliberate seams / limits

App now subscribes and consumes the one-shot notice through its existing status-line
announcement. Ordinary startup retains static imports and renders immediately; only
a startup that actually restores values reloads once so module-scope stores reread them.
A tab-local sessionStorage flag preserves that notice across the recovery reload.
The earlier reports above predate this static-import correction; the current runner
also waits for the real App-rendered notice. ESLint enforcement is a later package.
Legacy raw writers are reconciled once per load after first paint and on hide /
pagehide. A raw write followed by another window's clear *before* that checkpoint
can still be lost until C-17b migrates the writer. Mirrored helper writes queue
immediately with a batch delay of at most one second. Unknown/library keys are
excluded; values and removals are mirrored only for the exact registered keys.
