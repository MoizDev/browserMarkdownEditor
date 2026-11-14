# C-15d-step: graph step elapsed samples

Approved extension of C9 core counters (`perf-assetJobs.md`, second extension).
Branch `impl/ref/c-15d-step`, based only on `impl/reference`. No implementation
branch enters this reference, and no simulation, camera or drawing rule changes.

Benchmark-only `window.__perf.graph.stepMs` returns a copy of:
`{ samples: number[], total: number, count: number }`. It records only completed
working steps, retains the last 4096 durations, and keeps total/count for the
current layout. The existing nodes-array reheat and unmount reset all fields.
Callers cannot mutate retained samples through the getter. Zero durations are
valid at the browser clock's resolution.

The two `performance.now()` reads immediately bracket the EXISTING `step()` call,
not fit or draw. Samples are elapsed wall time of that call, not exclusive kernel
CPU: the pre-existing C-15d position capture is inside `step()` too. Statistical
absolute step-ms numbers are NOT certified until the native overhead companion
has run. Reference and candidate benchmark builds both carry the instrument.

## Functional gate

`graph-step.mjs` selects strict step checks in the existing C-15d real-app gate;
the original invocation without that flag still has its old semantics. Supply
ALL P/B/D URLs, build identity files and expected commit exactly as C-15d's README
describes. Driver runs from the lane's own pinned Playwright installation, using
unchanged temporary copies of these verification files (reference has no driver).

P: scan actual browser script bodies plus same-origin supplemental JS, SHA-bound
to the build identity; no anchors, no root/report or direct graph clock calls.
B: actual fetched positive marker, live hook, timer counts equal completed steps
(and equal step advances across the same interval), finite/nonnegative samples,
total agrees with the retained samples for this 300-step flow. Samples stop at
rest, are copied, reset on a new layout, and empty after unmount. D: no hook
creation/report/direct graph clock reads. Browser157.0.8103.39 and driver1.63.0
are asserted. Every served script's hash is checked against its build identity.
P/B canvas PNGs, DOM, draw coordinates and disk bytes must remain identical.

The SAME invocation adds an approved B-only **scope witness, not timing**:
- Outside the app, a wrapper adds +1000 to performance.now's logical offset ONLY
  when the graph canvas calls clearRect. It never delays a thread or pauses a target.
- The wrapper must see clearRect/offset and direct GraphView clock reads, otherwise
  the execution is a harness fault, never a mutant kill.
- Each published sample equals its observed end-start clock pair, whose offsets
  must be identical. An end stamp after drawing picks up the offset and fails.
- GraphView has NO elapsed dt: one working step per loop, fixed alpha/cooling per
  step, with the contract's fixed force/integration constants. All 300 position
  frames in this scope arm must equal the native-clock B arm as doubles, confirming
  the wrapper did not change what the graph computes.
- Loss: this proves stamp placement relative to drawing, NOT that every other
  operation is excluded. Scope/clock-observer samples are NEVER timing data; the
  native overhead adapter installs neither this clock nor the functional observer.

Mutants are source patches in independent scratch copies, built with the normal
production configuration. Same invocation and identity rules, same clean D control:
- unguarded API: production must fail `FAIL P-anchor`.
- whole-frame end stamp: moved guard/count remain correct, but fit/draw precede
  the end stamp. Scope witness must fail `FAIL hand-count` for the draw marker.
Only Node exit1 plus the expected stable reason counts. Setup/identity/clock
observer failures exit2, never a kill. Patch failure is invalid setup.

## Overhead companion (pending accepted window, v-c)

Never run it as a private functional timing. vr-lead approved per-session p95 busy JS duration from the TRACE of GraphView-owned
RAF callbacks, working steps2..300, excluding the initial synchronous loop. This
is NOT RAF presentation cadence and NOT step time. Callback identity must match
native RAF ids and GraphView's script in RequestAnimationFrame stacks; FunctionCall
inside the matching FireAnimationFrame supplies the metric, not observer RAFs.
Raw callback start/end/RAF timestamps, ownership, fixture/build hashes and native
C9 stepMs samples retain separate provenance. v-c's V-04 method owns adaptive
sessions, controls, confidence intervals and machine validity (no private count
or statistics; five means graph nodes, never five sessions).

The upper HL bound of benchmark-minus-production must be below
max(0.2ms,5% production p95). v-c freezes that numeric budget BEFORE either
comparison arm from separate production-only calibration. Its metric includes
budgetSource{productionBuild,fixtureHashes,calibrationReportHash,statistic,
productionP95,formula}; identical frozen metric goes into production A/A noise
and P/B comparison. No candidate/pooled data chooses the floor, no mid-run tuning.

Required bound: instrument cost <=max(0.2ms,5% production p95 frame time); if it
exceeds that, witness and timing arms run separately. Until that accepted-window
comparison exists, cost is UNKNOWN and absolute step-ms remains uncertified.
Functional success is not an overhead pass. G0's timed adapters are handed to v-c
and not run outside its accepted windows.

## Explicit losses

This five-note flow does not exercise the4096-sample wraparound, all drag/reset
interleavings, native disk/FSEvents, full graph catalogue or the instrumentation
cost bound. Missing-hook reproduction and final run artifacts are in the lane
hand-off; no code-based tests or in-app assertions are added.
