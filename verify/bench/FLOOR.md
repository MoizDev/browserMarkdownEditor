# Timing-floor evidence (t21 procedure; no bound yet)

The integrator owns steps 1–2 in one measurement window: three minutes of per-second process/load/
memory attribution, then shedding run-owned servers/helpers/VM and three more minutes of samples.
Files: `scratch/measure/floor-1-attribution.txt` and `floor-2-shed.txt`.

After the integrator confirms the shed sampler is finished and releases its bench grant, v-c runs
step 3 through the existing V-04 adapter and its **prebuilt** same-build cold control workload:

```sh
L=/Users/adham/Developer/bme-impl/scratch/bin/bme-lock
"$L" bench -- node verify/bench/floor-calibration.mjs /Users/adham/Developer/bme-impl/scratch/v-c/dist 20
```

`20` is sessions **per arm** (40 fresh profiles total, ABBA). Budget 3 minutes: about 90–100 seconds
of contexts, report I/O and margin; no additional cool-down is needed after the integrator's 3-minute
shed sampling. Step 3 starts only in the measurement window, never under an ordinary run grant.

Output is `scratch/measure/floor-3-calibration.json`, with per-session captures/traces in
`scratch/v-c/floor-calibration/<run-id>/`. It refuses to overwrite an older experiment. A repeat must
preserve the earlier evidence under a distinct name first. Raw measurements, every invalid attempt,
build identities and the full measurement sources remain in the JSON. No baseline or gate verdict
is reported, and no load/CPU preflight parameter is defined or changed by this experiment.

- Twenty valid sessions per arm are fixed before starting. No early stopping, no adaptive count.
  Sessions with memory below 6GiB, any swap-in, battery power or reported throttling are excluded,
  listed and retried, at most three immediate attempts per slot. Load and CPU are evidence, not
  exclusions during the experiment whose purpose is to establish their bound.
- Descriptive values: each arm and pooled median, quartiles, IQR and raw values. Exact fixed-n HL
  and median intervals are reported for available 10/20/40 prefixes. These prefix diagnostics are
  not used to stop and have no joint-95% claim. The V-04 corrected interval is reported separately.
- Requested half-width projections at 10/20/40 per arm use the observed endpoint width times
  `sqrt(observedN / proposedN)`. These are labelled **planning-only root-n estimates**, never
  distribution-free intervals for unobserved samples and never a replacement for actual gate runs.
- CPU is sampled per session at one-second cadence plus endpoints. The bench is the collector PID
  tree (Chrome, inline server, sampler included). Agent roots come from `hc ls --json` and `hc get`;
  other node/build/browser/VM commands never inherit an agent label. All agents/daemons count as
  outside. Host non-idle CPU-time delta minus observed bench CPU-time gives the outside estimate;
  missed exits/centisecond ps rounding can conservatively overestimate outside CPU. Top consumers,
  raw `ps` and CDP CPU times are retained. There is **no 1.5-core or per-process cutoff** here.
- The wall-clock Open Vault metric is not autosave CPU time. Its absolute-millisecond projection
  against a 1/3ms half-width is a scale diagnostic only, NOT evidence that the mixed-note save gate
  resolves +1ms. V-08 must measure that actual save workload separately.

Send all three files plus a paragraph to vr-lead. Only vr-lead writes
`planning/60-implementation/amendments/timing-window-bound.md`; only after that amendment exists
may v-c commit the resulting preflight bound. The old scalar V-04 method and pass rules stay frozen.
The superseded proposed 5%-process/1.5-core CPU rule is not implemented as a bound.
