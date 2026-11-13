# Graph measurement surface (C-15d)

A headless-browser gate drives the real application, not an extracted simulation.
The reference branch is main `b10d0d3` plus its benchmark-constant commits and this
hook package, never an implementation-domain merge.

## Surface and lifetime

Benchmark builds expose `window.__perf.graph`:

- `positions()` copies `{ ids, ring: [{ step, x, y }] }`: unrounded doubles after
  completed working physics steps, in node-array order. At most 512 frames remain.
- `snapshot()` copies the directed edges passed to the drawing loop.
- `steps` counts completed physics steps, not animation callbacks.
- `publications` counts distinct node/link prop-array pairs received by the mounted
  view, including the first. Active-note/theme/hover renders do not count.

Today's `[nodes]` seeding effect reheats to alpha 1 even for changed degrees with
unchanged IDs. It resets steps, IDs and history without changing survivor positions
or velocities. A links-only publication neither reheats nor resets. A pointer-down
reheat continues history. Unmount releases arrays; held hook references read empty
arrays and zero counters.

## Three-arm gate, identity and losses

One invocation always supplies P (production preview), B (benchmark preview), and
D (dev server). All three arms must pass on clean code. Every arm seeds the same
five-note A→B→C→D→E fixture, opens the real vault/graph, checks the five circles and
four drawn edges, captures the settled canvas, then saves E→A using a fresh OPFS
handle outside app code. The real observer/poll must show five links. It leaves
the graph through its real button. No app module is imported into the page.

P scans bodies from every script response the browser observed (page and worker
requests through the browser context). It then fetches every remaining `.js` in
the build inventory from that SAME preview origin, labelled supplemental. Node
never supplies asserted bundle content. Every scanned body's SHA-256 must match
its entry in the build identity. No plant/`__perf`/graph-hook anchor may occur;
`window.__perf` and its graph key must be undefined after the flow, with no observed
root creation or hook reports.

B is the positive control: an anchor must occur in an actual app-requested script,
and the graph hook must be live. Hand counts require exact IDs/edges, advancing
steps over 500 ms, all frames 1..300, finite doubles, and no change in an idle
one-second read. Returned-copy mutation cannot change another read. A's painted
centre from a screenshot must agree with the reported-position projection within
one CSS pixel. The outside save raises publications exactly once; unmount empties
the surface. P/B disk bytes, graph DOM, canvas coordinates and settled PNG bytes
must agree.

D asserts no root creation/report and undefined hook state. **Loss:** dev serves
source with dead guarded hook text; dev-source text exclusion is not claimed.
The required run uses default development mode. An additional invocation against
`vite --mode benchmark`, with gate argument `--dev-mode=benchmark`, exercises the
repaired command-and-mode constant; it must also pass.

Every report asserts Chrome for Testing 157.0.8103.39 and Playwright 1.63.0. Each
build's `write-identity.mjs` output sits beside its outDir and records commit,
clean source (or mutant patch SHA-256), mode and every output file's SHA-256. The
browser requires the expected commit/patch and binds every scanned served body
to that inventory. D has no outDir: it checks the clean dev worktree's Git HEAD,
and checks its supervised hc program's explicit positional Vite root, cwd and
strict port match the requested worktree and URL; observed response hashes are
recorded. There is no app diagnostic route. These are functional OPFS gates, not
native-disk/FSEvents or timing sign-off. Ring wraparound and the full layout/input
catalogue are left to later graph gates.

## Build and run

Obey `scratch/HOWTO.md`: own installs, private cache, pinned browser, every build/
static/browser/serve operation under bme-lock, slow commands in hc terminals.
Reference has no Playwright dependency. Copy `graph-hooks.mjs` into the lane's
same `verify/core/C-15d/` path, resolving the lane's I-0 driver; do not merge I-0
into reference. Static gates likewise use unchanged mirrored hook source in lane.

Set `W=/Users/adham/Developer/bme-impl`, `L=$W/scratch/bin/bme-lock`,
`REF=$W/wt/c-e-ref`, `S=$W/scratch/c-e/c15-v2`, and `COMMIT=$(git -C "$REF" rev-parse HEAD)`.
Create a scratch Vite config importing the reference config, with `root: REF`, a
private `cacheDir` and scratch outDir. From the CLEAN reference worktree, build
both modes and write identity immediately in the same locked command:

```sh
$L build -- bash -c './node_modules/.bin/vite build --config <cfg> --outDir <P> && node verify/core/C-15d/write-identity.mjs --output=<P> --mode=production'
$L build -- bash -c './node_modules/.bin/vite build --config <cfg> --outDir <B> --mode benchmark && node verify/core/C-15d/write-identity.mjs --output=<B> --mode=benchmark'
```

Serve P/B at 6360/6361 with `$L serve -- vite preview --config <cfg> --outDir <P|B>
--port <port> --strictPort`. Start D in an hc terminal, keeping its returned ID:
`$L serve -- ./node_modules/.bin/vite "$REF" --config <cfg> --port 6362 --strictPort`.
The explicit positional root is required for the dev identity assertion. From lane:

```sh
$L run -- node verify/core/C-15d/graph-hooks.mjs \
  --commit=$COMMIT \
  --prod-url=http://localhost:6360/ --prod-identity=$S/production.identity.json \
  --bench-url=http://localhost:6361/ --bench-identity=$S/benchmark.identity.json \
  --dev-url=http://localhost:6362/ --dev-root=$REF --dev-terminal=<hc-ID> \
  --out=$S/clean
```

Expect `PASS C-15d P/B/D`, exit 0. Full identities, response provenance/hashes,
hand counts, runtime observations and parity inputs are in `report.json`.

## Mutants: same invocation, named failure only

Apply each `.patch` to an independent scratch source copy of `COMMIT` (patch
failure is invalid setup), install independently, and build normal production
and benchmark modes. Pass `--commit=$COMMIT --patch=<absolute-patch-file>` to the
identity writer; it records the patch SHA-256. Never patch the source worktree.

Use the SAME gate invocation above, changing only that mutant's P/B URLs/identity
paths/output and adding `--prod-patch=<patch-sha256> --bench-patch=<patch-sha256>`.
D remains the same clean reference dev server control. The mutant is killed only
when exit 1 accompanies its exact stable reason line:

- `unguarded.patch`: `FAIL P-anchor ...` (shipping hook code).
- `frame-count.patch`: `FAIL hand-count ...` (idle RAFs counted as physics steps).

A missing URL, wrong browser/driver, hash/commit mismatch, patch or build failure,
timeout or other setup failure exits 2 and is INVALID, never a mutant kill. The
mutant runner must match the reason prefix, not just nonzero exit status.

## Earlier evidence, superseded method

The initial `2beff49` five-note flow passed its hand counts and killed both
mutants, but r-gates correctly refused its Node-side dist scan, absent dev arm
and missing asserted build/browser identity. Those logs remain under
`scratch/c-e/{paired,unguarded,frame-count}` as historical evidence only; they are
NOT sign-off for this revised gate. The fresh three-arm reports supersede them.
