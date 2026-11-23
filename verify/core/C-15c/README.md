# C-15c — editor counters on the reference app

This is a headless-browser run driving the real app, not an imported-editor check. The **same
invocation** runs production (P), benchmark (B), and the StrictMode dev server (D), in that order.
Each arm uses a fresh context, a named OPFS vault, the file tree, real typing and mode shortcuts,
and an explicit app save. No app module is imported or called; `__perf.editor.reset()` is the C9
interval control. Playwright is asserted to be 1.63.0 and Chrome for Testing 157.0.8103.39.

## Witness, identity, loss and controls

- Two fixtures: plain prose and a note with one SVG image and one math block. The run waits for the
  actual selected note's first sentence (not an old note's mounted editor), enters Edit mode,
  clicks its final prose line, and asserts keyboard focus. It types `counterinterval` with 15
  individual real key presses, asserts the new suffix, then flips read/edit twice.
- After reset, B must see transactions >= 15, exactly two mode renders, coverage >= 15, no
  create/revGap/error renders, and windows equal the sum of full-render reasons. Every rebuild has
  one finite, nonnegative `l3Ms.samples` value and `l3Ms.total` is their sum. `l1Ms` is null today.
  Plain prose builds zero widgets; the mixed note builds widgets. The parse must be idle and cover
  the exact new source length. These identity checks prevent typing into an unfocused/read-only
  view or measuring a cheap partial parse from passing.
- P collects every page/worker script response through `context.on('response')` and reads its
  response body. Every other emitted JS file is additionally fetched **from the same preview
  origin through the browser context**, explicitly labelled supplemental. All these bytes are
  hash-matched against the build identity and scanned for the planted marker, `__perf`, and unique
  counter keys. Node may list/hash build artefacts to prepare the identity; **Node never supplies
  the asserted scan content**. The generic `editor` string is not an anchor (existing CSS uses it).
- B is the positive control: the actually fetched application scripts contain every anchor and
  the hook is live. P and D must end with `window.__perf` and its editor key undefined. An init-script
  setter also counts every hook-root assignment, so creating and later deleting the root does not
  pass the no-report/no-hook-event assertion. The B arm proves that observer fires.
- Every P/B identity records the clean source commit (or base commit + mutant patch SHA-256), mode,
  and every emitted file's SHA-256. Every scanned response body must match its entry. D instead
  asserts a clean source worktree at that commit, hashes its source files, and verifies the actual
  listening dev process's cwd and scratch config/root. D records transformed response hashes;
  it does not falsely equate transformed code with raw TSX.
- **Dev loss:** dev source text carries dead guarded code. D proves behavioural exclusion, not text
  exclusion. The shared constant must be `command === 'build' && mode === 'benchmark'` before running.
- P/B parity compares every vault file's bytes and the rendered editor DOM for both notes. Random
  `blob:` object-URL IDs are normalized; image dimensions and its backing bytes are independently
  checked. SVG/KaTeX/font readiness is witnessed, and screenshots are retained for visual review.
- The outside saved-file witness first waits for the path's completed successful native closes
  to reach the flow's target (seed closes count too; the target is captured before typing). This
  awaited loop has a ten-second deadline and 30 ms yields; a missing close is a harness fault.
  Only after that boundary does it read the bytes once, with at most three counted `NotReadableError`
  retries. A byte mismatch is never polled away; **NotFoundError and app page errors are never retried**.
  Probe errors, close polls, completed counts and every read/retry are retained in the report.
- Mutant (a), `unguarded-widget.patch`: moves one constructor count outside the guard. The **same
  invocation** must fail with `FAIL P-anchor ...`. Without it, shipped instrumentation could pass.
- Mutant (b), `mode-uncounted.patch`: rebuilds but omits the mode increment. The **same invocation**
  must fail with `FAIL hand-count fullRenders.mode 0!=2`. Without it, E0's reference could silently
  omit mode-render work. A missing URL, patch mismatch, hash/identity failure, or another setup
  error is `INVALID`, exit 2, **never a mutant kill**. Named gate failures exit 1; clean runs exit 0.
- Not covered: timing budgets, incremental rendering, per-pane attribution, native-disk events,
  stored-handle reload, and dev-source text exclusion. No IndexedDB shim is used; this flow does
  not reload. External network requests are aborted.

## Preparation and execution

Use ports you chose and the pinned browser (`node verify/install-browser.mjs`; `BME_CHROME_PATH`
overrides). REF is a clean reference checkout holding only the reference and these hooks/scripts;
LANE is a worktree with the pinned Playwright driver (copy this verification directory there when
needed). S is a scratch folder outside both. `S/vite.config.mjs` imports the reference's original
Vite config, sets its literal `root`, a private `cacheDir`, and an `outDir` selected with `BME_OUT`.
Commit the source and scripts before building identities.

In the reference checkout, run each build and its identity step together:

```sh
REF=/path/to/clean/reference; LANE=/path/to/this/worktree; S=/path/to/scratch
CFG=$S/vite.config.mjs
DRIVER=$LANE/verify/core/C-15c
BME_OUT=$S/production ./node_modules/.bin/vite build --config $CFG && node $DRIVER/build-identity.mjs $REF production $S/production $S/production.identity.json
BME_OUT=$S/benchmark ./node_modules/.bin/vite build --config $CFG --mode benchmark && node $DRIVER/build-identity.mjs $REF benchmark $S/benchmark $S/benchmark.identity.json
node "$DRIVER/build-identity.mjs" "$REF" development - "$S/development.identity.json"
```

Start three servers in separate terminals, all with cwd `$REF`:

```sh
BME_OUT=$S/production ./node_modules/.bin/vite preview --config "$CFG" --port 6340 --strictPort
BME_OUT=$S/benchmark ./node_modules/.bin/vite preview --config "$CFG" --port 6341 --strictPort
./node_modules/.bin/vite --config "$CFG" --port 6343 --strictPort
```

A scratch JSON spec names the same three arms (absolute paths), e.g. `$S/candidate.json`:

```json
{"arms":[
  {"kind":"P","url":"http://localhost:6340/","identity":"<S>/production.identity.json"},
  {"kind":"B","url":"http://localhost:6341/","identity":"<S>/benchmark.identity.json"},
  {"kind":"D","url":"http://localhost:6343/","identity":"<S>/development.identity.json","serverConfig":"<S>/vite.config.mjs"}
]}
```

From the lane checkout (the output directory defaults to `C-15c/` under the toolbox scratch folder):

```sh
node verify/core/C-15c/editor-hooks.mjs "$S/candidate.json" "$S/candidate-run"
```

The full report (identities, scanned-body hashes, counters, witnesses) and screenshots go to the
output directory. Stop every server afterward. Mirror hook source into the lane for its unchanged
`npm run typecheck` and `npm run lint`; do not merge I-0 into the reference.

## Mutants

Export the clean hook commit with `git archive` into two separate scratch source trees. For each,
`git apply --check` the corresponding patch, then apply it. A stale patch fails preparation.
Each copy gets its **own**, lock-wrapped `npm ci` and scratch Vite config; never reuse/symlink another
worktree's `node_modules`. Build (a) in production mode and (b) in benchmark mode. After the build,
create its identity with:

```sh
node "$DRIVER/build-identity.mjs" <mutant-source> <mode> <mutant-outDir> <mutant-identity.json> "$W/wt/c-d-ref" <absolute-patch-file>
```

Serve on a spare assigned port. Copy the candidate spec, replacing only the relevant P or B arm's
URL/identity and adding its `patch` path. Invoke **the identical driver command shape** with that spec
and a separate output directory. Check both exit 1 and the exact named reason line. Never treat an
`INVALID` or a missing report as rejection. Preserve the commands, output and patch SHA alongside the
clean-run reports.
