# P-04 — prefetched PDF opening

## Current implementation

`src/components/pdfPaneModule.ts` is the PDF-owned resolved-component cache. Core owns the
EditorPane/prefetch wiring; its exact proposed diff is in
`planning/60-implementation/seams/p-f-P-04.md` in the main checkout. No core file is edited here.

## Write-first reproduction (retained)

`warm-open.mjs` drove unfixed production source `3d98258` with real idle prefetch and two
byte-identical GEN-P11-dense40 files. Playwright 1.63.0 / CfT157.0.8103.39, DPR1/2:
first reads **303.60 / 303.70ms**, second reads **3.00 / 2.70ms**. The loading root mutation
preceded a >200ms read plateau. Actual first native canvas blits contained ink and matched three
subsequent canvas hashes. Raw results/captures: `scratch/p-f/p04-baseline/`.

That was an unlocked functional reproduction, not a calibrated timing claim. The original
report binds the served app to its source/build through committed V-01a 527faea. Afterwards the
retained driver was tightened to use the native event timestamp and to distinguish document
reads by their actual PdfPane caller stack; that refinement has **not** been rerun.

The old driver's full invocation is positional `URL corpus output [record|verify]`, with
`CHROME`, `BUILD_WORKTREE`, `BUILD_DIST` set and, now that V-01a is merged, the default in-tree
verification toolbox. It remains a review-phase tool, not a merge prerequisite.

## Owner's revised sanity bar

Charter §0 supersedes the old package review matrix. No new mutants, fault/identity/witness
re-runs, reviewer queues or calibrated timing work are being built. Keep the existing
reproduction above. Acceptance is clean typecheck/lint and one real-app headless run of the
**applied core seam**, with an unqualified first-vs-second quick reading, Markdown-only no-PDF
network observation, and visually inspected light/dark captures.

**Ready under that bar.** On the lead-authorized detached scratch tree:

`lane 2635169e34291f428729df480cf5b6dfb805c598 + seam patch b1b947202bd1fd0ac888f20a9455cd35049c0f56a8c4f9e6df6d9fe884aca4d8`

The seam is uncommitted there; neither core file was edited on the lane branch. Own scratch
`npm ci`, typecheck and lint passed. Production preparation passed. One `sanity.mjs` run passed:

- light / DPR1: first **6.70ms**, second **3.00ms** to the document's native getFile call;
- dark / DPR2: first **6.60ms**, second **3.20ms**;
- Markdown-only vault: **zero PDF chunk/worker requests**;
- no page errors; real page input usable. Light/dark/Markdown screenshots looked at: sharp text,
  correctly sized PDF surface, legible controls and no overlay on the sidebar.

These are **unqualified single-run quick readings**, not a calibrated performance claim.
Results/captures: `scratch/p-f/p04-sanity-build/sanity.json` and its PNGs. Server/browser closed in
finally; no server is retained between runs. `sanity.mjs --prepare` runs under build; normal mode
runs under run, using in-tree serve/browser/vault helpers. Set BME_ROOT to the detached source,
BME_SCRATCH to the prepared output directory, BME_PDF to the authored dense40 PDF, BME_PATCH to
the exact seam patch and BME_PORT to an assigned port.

## Stated loss

The reproduction covers one authored dense document and one geometry per DPR. It is not
concurrency, import-error recovery, StrictMode, late close/rename/vault switch, full lazy-graph,
focus-matrix or general performance acceptance. Those old review obligations are deferred,
not silently claimed or deleted.
