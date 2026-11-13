# Graph measurement surface (C-15d)

This is a headless-browser gate driving the real application, not an extracted
simulation or a code-based test. The reference branch is `impl/reference`
(`b10d0d3` plus `ff3d755`) plus this package; no implementation-domain merge.

## Surface and lifetime

Benchmark builds expose `window.__perf.graph`:

- `positions()` copies `{ ids, ring: [{ step, x, y }] }`. Coordinates are the
  unrounded doubles after each completed working physics step, in node-array
  order. The ring holds at most 512 frames (all 300 fresh settling steps fit).
- `snapshot()` copies the directed edge list passed to the drawing loop.
- `steps` counts completed physics steps, not animation callbacks.
- `publications` counts distinct node/link prop-array pairs received by the
  mounted view, including the first pair. Active-note/theme/hover renders do not
  count. The app retains the arrays when a graph rebuild finds no change.

Today the `[nodes]` seeding effect reheats to alpha 1 even when only degrees
changed. That effect resets `steps`, the ring and `ids`, preserving the real
simulation's survivor positions/velocities exactly as before. A links-only
publication restarts the loop but neither reheats nor resets the counter. A
pointer-down reheat continues the current history. Unmount releases retained
arrays; existing hook references then return empty arrays and zero counters.

## Witness, identity and loss

Five real OPFS notes form A→B→C→D→E. The browser opens the named vault and clicks
Neural Brain. It checks the five exact IDs, four exact directed edges, and
independently observes five canvas arcs/four edge draws. Two reads 500 ms apart
must advance. All frames 1–300 must be finite and present; after settling, a
one-second read must be identical. Mutating returned copies must have no effect.

A screenshot supplies A's painted centre (its independently hand-counted palette
colour). Its projected reported position must agree within 1 CSS pixel. A fresh
OPFS handle writes E→A outside the app's code path; the real observer/poll must
publish five edges and increment publications exactly once. Leaving the graph
must empty the surface. No application module is imported into the page.

The same browser actions on production must leave identical file bytes, visible
graph text, canvas draw coordinates and settled PNG bytes. Every emitted JS/HTML
chunk is scanned for the plant/`__perf` anchors: absent in production and present
in benchmark. Bare `graph` is intentionally not a scan anchor: ordinary graph
UI/CSS already contains it. These are functional gates, not timing sign-off.
No native-disk observer/FSEvents claim is made; storage is OPFS with real IDB.

Mutants are patches applied with `git apply` to independent scratch source
copies, with their own `npm ci`, built through the normal Vite configuration:

- `unguarded.patch`: registers the surface outside the benchmark guard. Its
  production scan must fail; otherwise shipping instrumentation is undetected.
- `frame-count.patch`: increments once per RAF, including idle callbacks. Its
  one-second settled read must fail; otherwise equal-step comparison is unsound.

A patch failure is a failed mutant setup, never evidence that a mutant was killed.

## Run

Follow the integrator's `scratch/HOWTO.md` for builds, private cache and locks.
Use the pinned Chrome for Testing 157.0.8103.39 and Playwright 1.63.0 from I-0.
The reference worktree has no driver dependency: copy `graph-hooks.mjs` into the
lane worktree's same `verify/core/C-15d/` path and run that copy against the
reference previews. Do not merge I-0 into the reference branch.

For the original run, `$W=/Users/adham/Developer/bme-impl`, `$L=$W/scratch/bin/bme-lock`.
The reference scratch config is `$W/scratch/c-e/vite.config.mjs`, with root
`$W/wt/c-e-ref`, private cache `$W/scratch/c-e/vite-cache` and scratch output.
Build with `$L build -- ./node_modules/.bin/vite build --config <config>`;
add `--mode benchmark` for the benchmark. Serve the two outputs through `$L serve`
with `vite preview --config <config> --outDir <output> --port <port> --strictPort`.
Run slow commands in hc terminals. From `$W/wt/c-e`:

```sh
$L run -- node verify/core/C-15d/graph-hooks.mjs \
  --bench-url=http://localhost:6361/ --prod-url=http://localhost:6362/ \
  --bench-dist=$W/scratch/c-e/benchmark --prod-dist=$W/scratch/c-e/production \
  --out=$W/scratch/c-e/paired
```

For the frame-count scratch preview, run with only
`--bench-url=http://localhost:6363/ --out=$W/scratch/c-e/frame-count` (expect exit 1).
For the unguarded production output, run with only
`--prod-dist=$W/scratch/c-e/mutant-unguarded-dist --out=$W/scratch/c-e/unguarded`
(expect exit 1 before any browser launch).

## Recorded evidence

Under `$W/scratch/c-e/`: `reproduction/report.json` records the unmodified
reference failing after the real graph opens because its hook is absent.
`paired/report.json` passes: steps 31→61 over 500 ms, settled 300, all 300 frames,
publications 1→2, and A's pixel/projection centres differ by about 0.012 px.
Both builds have 211 served JS/HTML chunks; production has zero planted chunks,
benchmark has one (GraphView). Production/benchmark settled PNGs are byte-identical.
`unguarded/report.json` fails the production plant scan. `frame-count/report.json`
fails because idle steps rise from 300 to 361 over one second.
`logs/` holds successful build, typecheck and lint output. Static gates ran in the
I-0 lane worktree with the two hook files mirrored unchanged from the reference.
