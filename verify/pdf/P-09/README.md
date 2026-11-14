# P-09 — role authority / WR-G0

**Charter §0:** these existing scripts/proofs are retained for the deferred review phase. They are
not a package/merge prerequisite and must not trigger more mutant, fault or identity reruns now.

A real production-app browser gate, not a module test. The driver never imports an app module into
the page or invokes a role-reader/editor/save function. Generated PDFs, builds and captures live in
scratch. Fixtures contain authored text/geometry and legacy serialized **data**, never editor code.

## The five parts

- **Witness:** named OPFS picker → real tree row → painted outer PDF (actual dark pixels and the
  authored text). Enter Annotate by toolbar, Cmd+E, or Neural Brain → Back to editor, which really
  unmounts/remounts PdfPane with the tab still in edit mode. Refused roles retain outer View + notice;
  editable mounts, dirty dots and writable opens must all be zero after pointer ink + app-handled
  Cmd+S. Read the actual OPFS file back: exact SHA, 400×600, `OUTER MUST SURVIVE`. Count writable
  opens AND actual closes, independently of save indicators. Read/hash the seed before any action.
- **Identity:** pinned Playwright/Chrome; fixture SHA; source/config fingerprint before and after
  production build; V-01a `buildIdentity` emitted inventory and `bindServedBodies(raw-route,
  production)`. Await `check()` at assertions; JS/MJS/CSS/WASM bodies and required app/PDF/role-worker
  fetches fail closed. Exact one-match mutant patches and source/mutant hashes are recorded. Shared
  tooling is in-tree; `toolbox.mjs` verifies its committed blob and reports its commit + used-file
  SHA-256. The historical 527faea scratch bridge is no longer imported. Gate-script hashes are also
  recorded per run.
- **Mutants:** `no-guard`, `null-plain`, `legacy-wins` are fresh scratch SOURCE copies built with
  production config. Zero/multiple patch matches fail before build. The same negative UI arm must
  mount a canvas, add a stroke and CLOSE a real changed OPFS write. `qualify-mutant.mjs` requires that
  named guard assertion, not any setup/crash/identity failure.
- **False passes excluded:** a blank/unopened PDF cannot pass; blanket edit disable fails plain-z,
  supported legacy, genuine main-built legacy and empty controls. Sample shape/close counters before
  each gesture and require advancement. The finite genuine legacy control has one existing stroke:
  real select/arrow move + undo relative to the locked paper proves editing, not camera panning.
  Independently extract the actual saved snapshot: every old draw ID plus the new one must survive.
  Unknown arms, absent required witnesses and empty requested sets are errors, never skipped checks.
- **Loss:** finite tree/marker/schema/failure/order corpus, not arbitrary malformed PDFs. The guard
  checks finite structure and known serialized-schema ceilings; W-03 owns semantic editor-load
  failure (no reset/save escape). The virtual declared limit is NOT real 2 GiB capacity qualification.
  P-08b owns writer-side attachment preservation; real helper entry awaits V-02. The filesystem's
  final check→write TOCTOU remains; versioned IO and P-12's mark are separate retained layers. No
  timing claim is made: functional raw-route binding disables the HTTP cache.

## Build and run

Follow the shared HOWTO and reserved ports. Slow commands run in hc background terminals, with
`bme-lock` for build/static/run/serve. Classic pdf.js runs are weight1 (PDFium pool is weight2).
Every preview has an EXIT cleanup in the browser-run shell; a failed gate must not leave it idle.
Set CHROME_PATH to HOWTO §5's exact Chrome for Testing executable, never installed/bundled Chrome.

```sh
export S=/Users/adham/Developer/bme-impl/scratch/p-c
L=/Users/adham/Developer/bme-impl/scratch/bin/bme-lock
# Shared tooling and fixture helpers are now in-tree. Fresh output dirs only.
node verify/fixtures/pdf/generators/role-authority-and-read-failure.mjs \
  --out "$S/fixtures-a" --seed 1346651697 > "$S/fixtures-a.jsonl"
node verify/fixtures/pdf/generators/role-authority-and-read-failure.mjs \
  --out "$S/fixtures-b" --seed 1346651697 > "$S/fixtures-b.jsonl"
# V-05 owns independent two-run/manifest admission. Oracle JSON is registered too.

# Private config: this worktree root, own cacheDir/outDir; source must be committed.
"$L" build -- env BUILD_CONFIG="$S/vite.config.mjs" sh -c '
  node verify/pdf/P-09/identity.mjs source "$PWD" "$S/build.json" &&
  ./node_modules/.bin/vite build --config "$BUILD_CONFIG" &&
  node verify/pdf/P-09/identity.mjs artifacts "$PWD" "$S/dist" "$S/build.json"'
# Start preview with hc run --bg and a serve grant; retain its terminal ID for cleanup.
# In the hc browser-run shell: trap 'hc kill <serve-id>; hc rm <serve-id>' EXIT
"$L" run -- env BUILD_IDENTITY="$S/build.json" CHROME_PATH="$CHROME_PATH" \
  node verify/pdf/P-09/corpus.mjs http://localhost:6420 "$S/fixtures-a" "$S/results" \
  verify/fixtures/pdf/manifest.json
```

`run.mjs ORIGIN FIXTURES OUT VARIANT ENTRY EXPECTATION` drives one named arm. ENTRY is toolbar,
keyboard, restore (real graph remount), reload (real reload → View, then Annotate), or retry (normal
refused role; the real Retry button must perform exactly one new role read). EXPECTATION is refused,
editable, reproduce (historical unfixed portfolio only), or funnel (entry-only mutant on App seam).
Use THEME=light|dark and DPR=1|2; inspect all four pictures, not just their existence.

RACE=replace|vault holds the real role-worker request, replaces OPFS bytes or switches by the actual
picker to a second vault with the same relative path, then releases the stale result. Invalid arm
combinations/typos fail before launch. FAULT/RACE arms use toolbar, separately from the normal matrix.

## Worker failures

`boot-fault.mjs BASE_IDENTITY BASE_DIST NEW_ROOT worker-boot-throw|worker-boot-stall` clones the emitted
build and changes ONLY the whole role-worker boot chunk. Its separate build.json records original
and injected hashes. Serve that config, use its BUILD_IDENTITY and matching FAULT. The shared binder
fetches the actual fault bytes—no route bypass—and requires exactly one matching worker fetch.
These boot faults do not qualify a role/guard/null/schema logic mutation.

FAULT=worker-death-at-read instead serves unchanged production bytes, using
`legacy-supported toolbar refused`. Its helper binds the emitted worker source and live CDP script
hash, obtains an **executable call** breakpoint inside the bounded stream-read statement, and holds
only the real inspect-role IPC until debugger readiness. At the read it terminates execution and
the captured public Worker. Require the exact hit location, native termination, target detachment,
one forwarded real request and NO returned capability. The client watchdog must leave outer View
read-only. This finite interruption is not exhaustive instruction-order/worker-failure coverage.
No app function is evaluated or called; only external CDP and public Worker APIs are used.

## Scratch source mutants

Inside a build grant, run `prepare-mutant.mjs NEW_DIR NAME`, then the normal production build with
its config and the same source/artifact identity wrapper. It APFS-clones an independent installation
(no node_modules symlink), patches source exactly once and records the patch. Serve on a reserved
port, then qualify (with the same automatic preview cleanup):

```sh
"$L" run -- env BUILD_IDENTITY="$M/build.json" CHROME_PATH="$CHROME_PATH" \
  node verify/pdf/P-09/qualify-mutant.mjs http://localhost:6421 "$S/fixtures-a" "$M/result" no-guard
```

Repeat null-plain/null-source and legacy-wins/board-with-stale-legacy. A changed OPFS write plus an
editable canvas and the named guard assertion are required; a crash or stale/no-write result fails
qualification. New patch contexts must be reviewed, never silently ignored.

## Owned seams / known obligations

P-09 does not own App.tsx/helpDoc.ts/PdfAnnotateCanvas. Exact App/help/agent requirements are in the
main checkout's `planning/60-implementation/seams/p-c-P-09.md`. On that seam, `entry-only` bypasses
ONLY PdfPane's refusal: real pen → live dirty dot → Cmd+S must send no annotate build/open no writable,
keep SHA exact and remain dirty. `entry-and-funnel` removes the two App checks too and must write.
This is a source fault, not an in-page app call. Real helper and W-03 recovery are separate acceptance.

Revoking primary authority cannot silently drop a previously validated dirty closing revision:
C-19 must keep it prompt-armed or durably preserve it without overwriting current source. That
App-steward arm is recorded in the seam; it is not claimed as a passing p-c run here.

The writer's 32 MiB JSON preflight is explicitly P-12: today's writer is uncapped until that package,
while P-09's reader enforces the agreed limit. P-12 must give a typed, visible skipped/unacknowledged
refusal (dirty kept), not a generic throw/failed acknowledgement; prove over-bound→0 writes/notice
and under-bound→real write/re-readable. This known integration gap is not hidden by the reader gate.
