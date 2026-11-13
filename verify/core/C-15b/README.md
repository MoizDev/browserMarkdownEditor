# C-15b: tree paths and sanctioned removals

These are headless-browser runs of the real app, not code-based tests. Each arm seeds a fresh named
OPFS vault after navigation and uses the actual explorer, editor and Trash dialogs. No app module is
imported into the page. Chrome for Testing **157.0.8103.39** and Playwright **1.63.0** are asserted,
not merely recorded. There is no IndexedDB shim.

## Witness, identity, and stated loss

- The fixture manifest includes three collapsed nested levels. Root/nested `.Assets` and `.Garbage`
  stay hidden. The benchmark getter must match the manifest initially and reflect moves/deletions
  afterward through the **same saved getter**.
- An init-script wrapper records each native `removeEntry` at invocation, with the report that
  already exists then. Native parent handles are resolved independently of app path code. The ten
  required removals are: trash, put-back, trash again, permanent bin delete, drag-move, rename,
  embed removal/retire, embed re-add/restore, root bin empty, nested bin empty. They must match ten
  distinct operation-start reports. Seven relocation copies share those openers. The two trash
  openings each have exactly one `trash-done` (12 records total); its `opens` names the opener and
  its `to` must match the native copy's real final name. EventTarget events equal the full log.
- Five native `getDirectoryHandle({create:true})` completions are independently recorded: two trash
  bucket lookups, retire's bucket and asset subfolder, then restore's asset folder. Each request must
  start AFTER its own opener. Trash directory/copy calls are attributed within the opener..done span;
  fixture-owned source/destination pairs, not optional hook claims, identify the seven copies. The count comes from those gestures, never from observed calls.
- **P:** scan every actual page/worker script response, then labelled supplemental fetches of every
  remaining `.js` in the identity inventory, made by `fetch` in that same browser context/origin.
  Assert every response-body SHA-256 against the build identity, then assert no anchor and no
  `window.__perf`/tree/events after the flow. Node never reads asserted script content from dist.
- **B:** same commit and flow; all four anchors must appear in an **actual app-fetched** script;
  tree/vault hooks must be live and the independent hand counts must agree. This is P's positive
  control. P/B parity compares final vault bytes by SHA-256 and initial/final visible DOM; an image
  must actually be visible and decoded after restoration, not just present on disk.
- **D:** same flow against the development server, StrictMode on; no root/tree hook, reports or events.
  Browser/driver, clean source commit, and the live server's explicit worktree root/cwd/serve grant
  are asserted. Observed response hashes are recorded. **Loss:** dev source text carries dead guarded
  code; dev does not claim textual exclusion or byte-identical transformed responses.
- The build helper writes `<outDir>.identity.json`: exact source commit, clean tree (or mutant patch
  SHA-256), mode and SHA-256 of every output file. The run requires `--expect-commit`, checks mode and
  clean/patch identity, and binds **every scanned response** to that inventory before a mutant can
  receive a named failure. Reading build files to generate identity is build bookkeeping, not the
  browser scan's asserted content oracle.
- Not covered: rollback fault paths, replace collisions, concurrent operations, native-disk
  permissions/FSEvents, devices, timing/layout equivalence, or workers the flow does not start.

One opening report is emitted before the first mutation, DIRECTORY CREATION INCLUDED (c-lead /
vr-lead ruling). Trash/displacement openers deliberately omit `to`: a collision-free name has not
been chosen yet. `displaceInto` emits `trash-done` AFTER the copy and BEFORE removing the source,
when the actual name and completed copy are facts. Its `opens` links the start and `to` identifies
that real copy; removal may then be matched to the opener through this completion. Failed-copy /
rollback traces are statically inventoried, not fault-driven or asserted complete by this happy-flow
gate. Move/rename/asset destinations known at start remain asserted. Original production statements
are not reordered and callback dependencies stay identical to the uninstrumented reference.

## Build and run

All installs/builds/static checks/servers/browser runs go through the integrator's `bme-lock`. Slow
commands run in `hc run --bg`; `hc wait` must report `ended:true` before stopping their server.
`impl/ref/c-15b` takes only `impl/reference` and its own hook commits, **never I-0 or impl/core**.
Reference has no Playwright, so copy this directory to the lane worktree and execute runs there.

```sh
export L=/Users/adham/Developer/bme-impl/scratch/bin/bme-lock
export S=/Users/adham/Developer/bme-impl/scratch/c-b
export REF=/Users/adham/Developer/bme-impl/wt/c-b-ref
export LANE=/Users/adham/Developer/bme-impl/wt/c-b
export COMMIT=$(git -C "$REF" rev-parse HEAD)

# In clean REF, with its own npm ci already complete. S/vite.config.mjs spreads
# REF/vite.config.ts and sets root=REF, a private cacheDir/outDir (HOWTO recipe).
cd "$REF"
"$L" build -- sh -c './node_modules/.bin/vite build --config "$S/vite.config.mjs" --mode benchmark --outDir "$S/benchmark-dist" && node verify/core/C-15b/build-identity.mjs --root "$REF" --out-dir "$S/benchmark-dist" --mode benchmark'
"$L" build -- sh -c './node_modules/.bin/vite build --config "$S/vite.config.mjs" --outDir "$S/production-dist" && node verify/core/C-15b/build-identity.mjs --root "$REF" --out-dir "$S/production-dist" --mode production'

# In a separate hc terminal, serve benchmark-dist through the serve grant:
"$L" serve -- ./node_modules/.bin/vite preview --config "$S/vite.config.mjs" --outDir "$S/benchmark-dist" --host 127.0.0.1 --port 6300 --strictPort

# From LANE, after copying this directory there:
cd "$LANE"
"$L" run -- node verify/core/C-15b/run.mjs --mode benchmark --url http://localhost:6300/ --out-dir "$S/benchmark-dist" --expect-commit "$COMMIT" --result "$S/benchmark.json"
# Stop benchmark preview, serve production-dist on 6300 instead, then:
"$L" run -- node verify/core/C-15b/run.mjs --mode production --url http://localhost:6300/ --out-dir "$S/production-dist" --expect-commit "$COMMIT" --result "$S/production.json"
"$L" run -- node verify/core/C-15b/run.mjs --compare "$S/benchmark.json" "$S/production.json"

# Stop preview. Start dev with an explicit positional root (record its hc ID):
cd "$REF"
"$L" serve -- ./node_modules/.bin/vite "$REF" --config "$S/vite.config.mjs" --host 127.0.0.1 --port 6300 --strictPort
# Then from LANE, DEV_ID being that live hc terminal:
"$L" run -- node verify/core/C-15b/run.mjs --mode dev --url http://localhost:6300/ --source-root "$REF" --dev-server "$DEV_ID" --expect-commit "$COMMIT" --result "$S/dev.json"
```

Each clean arm exits 0. Product assertions exit 1 with a named `FAIL` reason (`P-anchor`, `P-hook`,
`D-hook`, `B-control`, `hand-count`, `directory-precedence`, `PB-parity`, or the arm's `*-render`). Setup/identity failures
exit 2 as `INVALID`; product failures are never classified as invalid setup. Results include asserted
identities, response hashes/provenance, native calls, hook reports/events, file hashes, visible DOM,
screenshots and any stable failure reason.
Existence/location conditions use bounded native probes and propagate every error except the
NotFound result that defines absence. The asset.md BYTE witness instead waits for the next completed
successful close count (seed closes included), then reads once, retrying only NotReadableError at most
three times with 50ms yields. NotFoundError is never retried. Close-count timeout is an INVALID
witness/harness fault (exit2), not a named mutant kill. Witness counts/retries are recorded.

## Mutants and invalid executions

Copy clean REF to each mutant's own scratch root (exclude `.git`, `node_modules` and outputs). Apply
`git apply --check <absolute-patch>` then `git apply <absolute-patch>`; a failed patch is invalid,
never skipped. Each scratch root gets its own lock-wrapped npm ci and private Vite config/cache/dist.
After its build, write identity using the helper with `--root <mutant-source> --base-root "$REF"`,
its actual `--mode`, `--out-dir <mutant-dist>` and `--patch <absolute-patch>`.

- `unguarded-tree.patch`: production build, run P with the same normal invocation plus `--patch` and
  the mutant outDir. Required reason: **`FAIL P-anchor`**.
- `missing-retire.patch`: benchmark build, run B with the same normal invocation plus `--patch` and
  the mutant outDir. Required reason: **`FAIL hand-count`** (retire's native removal has no retire
  report). Dropping this report never changes the required ten native removals.
- `late-retire.patch`: benchmark build, identical invocation. Moves the retire report AFTER its
  directory creation while preserving the copy/removal reports. Required reason:
  **`FAIL directory-precedence`**. This proves the new precedence check independently of old checks.

Wrap the ordinary invocation as below. It accepts only exit 1 **and the named reason line**;
missing URLs, changed patches, wrong identities and setup errors are invalid, not kills.

```sh
"$L" run -- node verify/core/C-15b/run-mutant.mjs --expect P-anchor -- --mode production --url http://localhost:6300/ --out-dir "$S/mutant-a-dist" --expect-commit "$COMMIT" --patch "$LANE/verify/core/C-15b/unguarded-tree.patch" --result "$S/mutant-a.json"
"$L" run -- node verify/core/C-15b/run-mutant.mjs --expect hand-count -- --mode benchmark --url http://localhost:6300/ --out-dir "$S/mutant-b-dist" --expect-commit "$COMMIT" --patch "$LANE/verify/core/C-15b/missing-retire.patch" --result "$S/mutant-b.json"
"$L" run -- node verify/core/C-15b/run-mutant.mjs --expect directory-precedence -- --mode benchmark --url http://localhost:6300/ --out-dir "$S/mutant-c-dist" --expect-commit "$COMMIT" --patch "$LANE/verify/core/C-15b/late-retire.patch" --result "$S/mutant-c.json"
```

P/B scan anchors: `bme-perf-hooks-plant-7f3a`, `__perf`, `trash-done`,
`/\.tree\s*=\s*\{\s*paths\s*:/`, `/\.reports\s*=\s*\(\)\s*=>/`. Bare `tree` is not an anchor.
