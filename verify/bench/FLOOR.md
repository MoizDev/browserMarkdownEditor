# Metric-version calibration (never a gate verdict)

## Historical floor evidence

`t21`'s attribution/shedding experiment is preserved at `scratch/measure/`:
`floor-1-attribution.{txt,raw}`, `floor-2-shed.{txt,raw}`, and `floor-3-calibration.json`.
It measured the RETIRED Open Vault→text clock. The inputs/read-outs/sources and all40 sessions
remain immutable. Its9.048pp10/arm prefix is NOT the floor of the new note-input metric.
The amendment fixes session bounds1–5 (no other run work, VM down, free>=6GiB, zero swaps,
start load<=3, AC/lid open/no thermal throttling). There is no CPU-percent/1.5-core cutoff.

## New definition: explore, then one window

The metric is now `noteOpenToPaintMs`: resolve/stabilise the row outside the interval, deliver
real mouse input, start at page-received pointerdown.timeStamp, retain the existing visual
endpoint/witness. `noteOpenMetric.mjs` hashes the implementation, fixture, pin and cache regime.
For exploration (vr-lead-approved, MACHINE SHARED, never an accepted floor):

```sh
W=/Users/adham/Developer/bme-impl
L=$W/scratch/bin/bme-lock
DIST=$W/scratch/v-c/dist
"$L" run -- node verify/bench/floor-calibration.mjs "$DIST" 10 "$W/scratch/measure/note-open-exploratory-10.json" exploratory
"$L" run -- node verify/bench/floor-calibration.mjs "$DIST" 20 "$W/scratch/measure/note-open-exploratory-20.json" exploratory
```

Counts are PER ARM, ABBA, fresh cold profiles. Exploratory machine-invalid samples remain labelled
and may size a pilot mutant only; any swap-in attempt is excluded and retained, never averaged.
The quiet window must meet session bounds and the actual measured-shift witness. Outputs refuse
overwrite; preserve old evidence before an explicitly approved repeat.

After reviewing exploration and prebuilding the App.handleFileClick mutant at10% of its new median,
vr-lead requests ONE window. In it: opening20+20 calibration, control, mutant (bench README commands).
`floor-calibration.mjs <dist> 20 <new-output.json> window` enforces session bounds1–5 and publishes
a window opening record. Do NOT use an ordinary run grant for that recording.

Floors are keyed by metric id+definition hash. First window/no compiled floor = RECORD mode:
the opening block is not compared with itself, and the two timing arms follow in that same window.
Afterward vr-lead amends/reviews the recorded candidate and its entry in `metricFloors.mjs` is
committed for later windows. Those compare their opening exact relative HL95 half-width against
the compiled floor; a wider opening makes the WHOLE window invalid. No silent use of old floors.

## What the calibration file contains

- Raw values, captures/traces, build identities, definition hash, full measurement sources and
  every invalid attempt; per-arm and pooled median/quartiles/IQR.
- Exact fixed-n HL and median intervals for available10/20/40 prefixes. Prefix diagnostics never
  stop collection and have no joint-95% claim. V-04's corrected interval is separate.
- Root-n half-width projections `observedWidth*sqrt(observedN/proposedN)` are PLANNING ONLY,
  not distribution-free intervals for unobserved samples or substitutes for actual gate runs.
- Per-session CPU from host non-idle delta minus observed bench PID-tree CPU, including explicit
  orphan-Crashpad birth/path associations. Agents/daemons remain outside. Missed exits/rounding
  can conservatively overestimate outside CPU. Raw ps and top consumers remain available.
- This note-open wall-clock workload is NOT the save path's main-thread busy-time metric. Its
  absolute1ms projection is a scale diagnostic only, not proof of the mixed-note autosave budget.

Calibration itself makes no gate verdict. Control must still pass the unchanged5%/precision rule;
the mutant must fail with measured shift10% +/-3pp of that window's control median.
