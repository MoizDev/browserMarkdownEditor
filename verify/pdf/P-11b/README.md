# First-font selection repair (P-11b)

The pinned classic text layer resets its ascent-measuring canvas while retaining a cached 30px
font entry. Source and real-app diagnosis: `scratch/p-f/P-11b-finding.md`; published newer-package
comparison: `scratch/p-f/P-11b-options.md`. Product uses only public `TextLayer.update` and viewport
clone, after render completion; it neither replaces nodes nor substitutes selection/copy strings.
Delete it when the classic pin reaches at least pdfjs-dist 6.4.299.

## Functional gate

Generate `first-font-title` with `--out <fresh-dir> --seed 1346651697`; use the admitted GEN-18-876
from P-00. Run through `bme-lock run` with a production preview started only for this run:

```sh
BUILD_WORKTREE=<fixed-source> BUILD_DIST=<its-production-output> CHROME=<pinned-CfT> \
  <bme-lock> run -- node verify/pdf/P-11b/title-selection.mjs \
  http://localhost:6480 <book-corpus> <first-font-corpus> <fresh-results>
```

P-00/V-01a are integrated. Use the in-tree helper and manifest without scratch-copy or old
manifest overrides. The adapter accepts only committed `verify/lib/identity.mjs` and records its
full commit and SHA. Historical reports retain their actual approved 527faea/77b908f provenance.
All app/PDF/worker (including `.mjs`) served bodies bind to emitted hashes via raw-route mode,
drained before assertions. No app module is imported into the page.

| Part | Contract |
|---|---|
| Witness | Named OPFS vault, real tree click and pointer drag, pre-action confirmed clipboard sentinel and empty selection; post-action noncollapsed live selection/endpoints in the actual title, exact independent copied string, caret offsets and glyph geometry, screenshot. The full page's last authored line must exist before the drag. |
| Identity | Fixture PDF+oracle hashes/lengths against committed manifests; actual source commit, clean tree or named patch hash, emitted/served bytes, browser157.0.8103.39 and driver1.63.0, theme/DPR. |
| Mutant | Disposable source checkout + own install: restore, `git apply --check verify/pdf/P-11b/mutants/omit-remeasure.patch`, apply, production build. Set `BUILD_MUTANT=omit-remeasure` and its source/dist. Require `requestedCasesComplete:true`, `mutantRejected:true`, no executionError: book/DPR2 and first-font30/DPR1 fail in both themes; all four noncollision controls pass. A setup error/nonzero exit alone is not a kill. |
| False pass | Hitting the right SPAN is insufficient: its width/left and native endpoint caret must match authored advances. A copied full title cannot hide a short live selection; a stale clipboard cannot replace the confirmed sentinel. Node-removal observer must stay zero. |
| Loss | Two authored first-font geometries, emulated DPR1/2 in one Chromium build. No all-font/gutter/hardware claim, and no upstream-upgrade acceptance. |

The eight cases are light/dark × DPR1/2 × GEN-18-876/first-font30. R3a/b/c are separate required
regressions, not replaced by this gate.

## Cost (outside the repair, no source-patched timer)

`cost.mjs` drives the same real app against fixed and omission builds. It observes population of
all 40 eager layers, then the 876-page book's open/middle/last demand-built layers (7 total; the
876-page eager pass is correctly skipped). MutationObserver timestamps are matched to CDP trace
markers. Main-thread scripting is the union of execution/callback/constructor/module slices,
including native callees; nested intervals are never double-counted. Long RunTask parent/child
records are collapsed. Two-frame settling is reported separately, never called eager completion.
`PerformanceObserver` long tasks are also retained for cross-checking.

The timing arm uses the shared **node-refetch** identity binding, no browser interception. A static
server exists in the runner's own process only for the run and closes in finally. Generic Google
font DNS names are blocked by a declared browser launch flag, not a page route. No product timer,
private API, source-patched instrumentation or performance hook is added.

All unlocked results are **advisory**, not acceptance. Source traces remain immutable. If reanalyzed,
`analyze-cost.mjs <browser-result.json> <fresh-output.json>` uses exactly the shared analyzer without
synthetic samples; the initial advisory analyzer missed `v8.callFunction` and duplicated nested long
tasks, so only `analysis-v2.json` superseding it is used. Its raw traces are unchanged.

Formal timing belongs to v-c under `planning/60-implementation/amendments/timing-window-bound.md`:
V-04 window-opening calibration, this metric's own same-build calibration, VM down, no other run
process, free≥6GiB, zero swap-ins, load1≤3, AC/lid/thermal checks. The runner itself never grants a
performance pass. See `scratch/p-f/P-11b-v-c-queue.md` for the predeclared sessions and commands.
