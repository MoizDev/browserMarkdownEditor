# C-17a — browser-storage recovery sanity

`run.mjs URL OUTPUT [--mirror] [--theme dark] [--notice-api]` drives the actual app
using `verify/lib` and an OPFS vault. `--notice-api` is a dev-server-only witness
of the already-loaded storage module's pending notice; it does not initiate recovery.

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

App's notification subscription/show call is pending the App-owned seam; c-lead
accepted the consuming API witness for this package. No App or ESLint edits here.
Legacy raw writers are reconciled once per load after first paint and on hide /
pagehide. A raw write followed by another window's clear *before* that checkpoint
can still be lost until C-17b migrates the writer. Mirrored helper writes queue
immediately with a batch delay of at most one second. Unknown/library keys are
excluded; values and removals are mirrored only for the exact registered keys.
