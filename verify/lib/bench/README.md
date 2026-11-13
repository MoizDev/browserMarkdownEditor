# One benchmark method (V-04)

Plain Node ESM driving the real built app with Playwright, not a test runner. No app imports,
paused targets, private statistics, or native picker claims. Follow the run's scratch HOWTO.

## Running the method witness

First merge the domain branch and install the worktree's own pinned dependencies through
`bme-lock build`. Build the ordinary production bundle through the same lock with a scratch
Vite config (`outDir` and `cacheDir` outside the worktree). Never build in a timing window.

```sh
W=/Users/adham/Developer/bme-impl
L=$W/scratch/bin/bme-lock
DIST=$W/scratch/v-c/dist
# Development only; four sessions, clearly EXPLORATORY, MACHINE SHARED.
"$L" run -- node verify/bench/open-vault.mjs "$DIST" "$DIST" exploratory cold
# The printed report contains the median used to calibrate a 10% source mutant.
"$L" build -- node verify/bench/build-delay.mjs /absolute/control/report.json
# This prints the scratch mutant dist. Both bundles must exist before a window.
```

After lead review, request a window through vr-lead. Only the integrator opens/closes it.
Budget cool-down to the memory/load floor, 80 sessions per comparison, and 20% margin. During
that window run same-build first, then mutant, passing the first report as the noise record:

```sh
"$L" bench -- node verify/bench/open-vault.mjs "$DIST" "$DIST" accepted cold
"$L" bench -- node verify/bench/open-vault.mjs "$DIST" /absolute/mutant/dist accepted cold /absolute/noise/report.json
```

The first must **pass**, the second must **fail its measured regression rule**, with no app,
identity, missing-witness or setup error, and a measured shift near 10%. A miscalibrated mutant
is explicitly UNPROVEN, not evidence of method acceptance. The adapter records the actual
busy-wait duration, its fraction of the current control, and the observed HL shift; both must
be within three percentage points of 10% in accepted runs. Never widen the threshold or the
witness tolerance to get a result. Warm is a separate invocation/recording, not mixed into cold.

## Library boundary

- `runner.mjs`: `runBenchmark(config, adapterFactory)` returns `{status, reportPath, report}`.
  Config declares gate slug, mode, temperature, arms, metric, input script and source files,
  witness, identity, mutant, false pass and losses. See `verify/bench/open-vault.mjs`.
- The adapter factory receives `(config, reportDir)` and returns build `identities`, pin/driver
  metadata, `measure({arm,artifacts,temperature})`, `recheck()`, optional `validate(report)`, and
  `close()`. A measurement returns `values` (one scalar, or per-frame samples for a percentile),
  its witness, `captures` (nonempty array of existing files), `trace` (existing file), browser
  identity, events, memory and network records. Missing captures are invalid, never a pass.
  A harness fault may throw
  `error.invalidCause`; an app/witness/identity failure MUST NOT. All close paths run in finally.
- `browser.mjs` is the small, replaceable browser/toolbox adapter. It currently needs persistent
  profiles, which V-01a does not supply. It uses the shared browser pin, creates no counters and
  serves already-built files itself under its parent's grant (6200/6201, strict bind). There are
  no nested build/serve grants that could deadlock during a window. Adopt V-01a's seed/picker
  helpers when that prelude is merged; the statistical method does not depend on their shape.
  A rejecting loopback proxy blocks remote requests without Playwright routing, which would
  disable the HTTP cache and make the warm claim false. Cache-hit events are retained.

## Inference and pass rules

Sources/formulas are beside the code in `stats.mjs`. Samples are independent **sessions**, not
frames. A balanced block is A B B A; an invalid slot is repeated before advancing. Fresh persistent
browser/profile/context per session; warm restarts that same profile after a discarded prime.
The Open Vault scenario resets its app-session state after the prime, preserving HTTP/code/shader
caches and OPFS; it does NOT claim restored-session startup (V-08). Fixtures are seeded and read
once before measurement, so there is no cold-disk claim.

- Scalar comparisons: Hodges–Lehmann median of all B−A pairwise differences, exact Mann–Whitney
  rank-sum inversion. Relative change uses log values and `expm1` bounds. This distribution-free
  inference assumes independent common-shape location distributions (on log scale for ratios).
  Ties are conservative; no normal approximation or pooled per-frame pseudo-replication.
- Targets: exact binomial/order-statistic CI of the median. Percentile targets first compute the
  requested percentile inside each session, then gate q80 of those session values with its exact
  binomial CI. Minimum 14 sessions; finite two-sided confidence bounds may require more.
  Percentile comparisons instead use HL on ONE percentile per session (vr-lead's §8.2 ruling).
  Loss: this tests a shift of the typical session's p95, NOT the worst-fifth tail; a gate needing
  that tail compared requires a new contract, raised to vr-lead.
- No regression: upper relative change strictly below +5%; higher-is-better gates use the lower
  change bound. An absolute floor needs an explicit, predeclared resolution justification.
  Target: upper bound <= target. Improvement is reported positive; its lower bound must exceed zero.
  Noise recordings always use no-regression: a baseline need not meet a future target, and equal
  builds cannot establish improvement. Same-build defaults to `purpose:'noise'`; an explicit
  `purpose:'gate'` can target that build after a noise record. Target/improvement noise defaults
  to relative +5%; declare `noiseMetric` with a justified absolute floor for nonpositive metrics.
- Counts: 10, 14, 18, 22, 26, 30, 34, 38, 40 per arm (percentile starts at 14). Stop only when the
  interval half-width <= one third of the declared threshold. Wider at 40 is **inconclusive**.
  Bonferroni across all planned looks plus one possible confirmation protects >=95% coverage
  despite adaptive width stopping. Every look also reports the uncorrected fixed-n 95% interval,
  diagnostic only. `correctionPreventedDecision` exposes a correction-only inconclusive result
  for escalation; it never changes the cap or the verdict.
- One explicit near-boundary confirmation is allowed: prior failure less than its half-width,
  identical builds/script/metric/cache policy, no prior confirmation. Pass its report as the last
  CLI argument (use `-` for an absent noise argument). Before starting, fix its count to the first
  run's final count, with no adaptive looks. It passes only if BOTH independent confirmation data
  and pooled data pass at the corrected level (vr-lead ruling). The pooled fixed-n interval alone
  has a selected-count coverage caveat: its size depended on the first data. The independent,
  fixed-size, single-look confirmation carries the guarantee; pooling is an extra plan condition.
  The 40-session cap applies to each run; a confirmation can pool up to 80 per arm. The durable
  history lists both; ordinary re-runs cannot hide an earlier accepted failure.

## Machine validity, locking and reports

`bme-lock` is authoritative. Accepted mode requires an ancestor's bench grant, an unexpired
integrator window, and no other live grant (even serve); exploratory mode needs a run grant.
`locks/bench.lock` is only extra serialization, created with `wx`, with PID/holder/time/token.
A dead PID is reported STALE, never automatically stolen (unlink/recreate races new holders).
Explicit recovery: `node verify/bench/v-c.mjs reclaim <exact-token> <cause>` rechecks a dead PID
and matching token, serializes reclaimers and logs time/PID/token/cause in
`scratch/v-c/reports/lock-recoveries.jsonl`. A live PID/mismatched token is never removed.
Every session checks ownership/window before and after.

`machine.mjs` implements the evidence-based `timing-window-bound.md` §4 amendment: no run-owned
build/typecheck/lint/server/other Chrome/VM beside the bench PID tree; VM down; free memory >=6GiB;
zero swap-ins; **start** load1 <=3.0 (measured shed maximum2.15 +0.85 daemon-burst margin); AC,
lid open (ioreg), no thermal throttling. Raw vm_stat/pmset, load and top CPU consumers are recorded
before/after. Process ownership is checked during the session too, from authoritative grants,
executable/CWD/run-root argv match. Argv itself is never retained. Agent roots come from hc; another
runtime never inherits agent status. Unknown runtime ownership is invalid, not silently ignored.
There is NO aggregate-CPU or per-process CPU-percentage cutoff. Page-ins are not swap-ins.
At most three immediate invalid attempts per slot, then reschedule; never average an invalidity.
Lanes may tighten, not loosen, these limits. Closing/expiring the window is a harness stop.

A window also requires its **opening10+10 ABBA cold V-04 control block**. The observed, fixed-n
relative HL95 half-width must be <=0.09048038882908842, the actual10/arm floor prefix in
`scratch/measure/floor-3-calibration.json`. Only that canonical prebuilt control can establish the
opening proof; its first20 valid sessions also feed its ordinary noise run (no double counting).
Proofs are stored under `scratch/v-c/reports/window-calibrations/`, keyed by dated window identity.
An opening block noisier than the floor invalidates the WHOLE window; later gates refuse it.
This is window validity, not gate precision: the gate still needs half-width <=5%/3 at <=40/arm,
with the unchanged estimators and correction. Above-bound sessions and top consumers remain in
JSON/Markdown, never averaged. The mutant still needs its10% +/-3pp measured witness.

Reports live at `scratch/v-c/reports/<gate>/<timestamp-id>/report.{json,md}`. JSON retains raw
session samples, all invalid attempts, script source, identities, machine readings, discarded
primes, per-look estimates, captures/traces and report links. Nonfinite bounds serialize as
`"Infinity"`/`"-Infinity"`, not ambiguous JSON null. `history.json` lists every completed attempt.

Not yet covered by this witness: C9 pixel holes/blur under-reporting, full hook-to-production
instrumentation cost, native picker/disk, real hardware, peak process memory, restored startup.
The hook-free open-path gate's screenshot/trace/rAF instruments are identical in both arms; it
does not establish the <=max(0.2ms,5%) overhead bound for future instrumented frame-time gates.
