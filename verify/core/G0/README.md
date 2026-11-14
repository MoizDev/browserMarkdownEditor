# G0 — graph fixtures and TB-GR

Implementation-phase tools, not a code-based test suite. No app source is changed.
Charter section0 applies: the force-constant mutant and timed gates are deferred
to the separate review phase; they are not merge conditions. The generator,
real-app twin runner and A/A sanity run remain because G1/G2 use them.

## Corpus

The implementation is `verify/fixtures/core/generators/graphset.mjs`, invited into
V-05's area by vr-lead and approved by c-lead. `graphset.mjs` here is only its CLI
wrapper. It IMPORTS V-05's writer, CLI and seeded PRNG; none is copied. Generated
bytes stay outside the repository. Each output emits JSONL `{file,sha256,bytes}`;
the final `graphset-manifest.json` is schema1/core, one identity per vault/sidecar.
Authored outputs retain NOASSERTION/proposed CC0-1.0 until licence approval.

```sh
L build -- node verify/core/G0/graphset.mjs --out <fresh-directory> --seed 123456789 --set all
```

Sets are `all` (default), `exact`, `timed` (large baseline DATA, not a timed run),
and `geometry`. Same seed/arguments produce the same vault bytes independently.
Portable paths, UTF-8/LF, declared output order, no clock/environment/Math.random.

- Exact topology: sparse two-edge vaults at5/32/150/500/600; hub-heavy, dense
  ten-edge, disconnected and duplicate-basename variants at32/600 (13 vaults).
- Large topology:500/2000/5000/10000/20000, each sparse2/hubs2/dense10 (15 vaults).
- Extra5000-note disconnected/duplicate vaults support kernel geometry (2 vaults).
- G1 sidecars:5000-point uniform, golden spiral, collinear, clustered, hubs,
  components, sparse, dense and coincident; plus32/600-point coincident inputs.
  Each names its vault and SHA, ordered IDs, exact double coordinates and zero
  velocities. Coincident IDs are20 indices apart; other points are mirrored and
  their outgoing targets are symmetric, keeping the near-coincidence y response
  observable rather than clipping both implementations to the speed clamp.

**Topology and geometry are different inputs.** Today's app always initializes
its golden spiral. Duplicate filenames do NOT create coincident positions. G0
never applies the sidecar or adds a mutable hook: G1's seed-patched real-app builds
consume it. Metadata explicitly assigns sidecars to G1, not G0's A/A witness.
No ambiguous duplicate basename is used as a link destination, so D08's reference
last-wins versus current first-wins fix cannot confound a force differential.

## Prepare, then run (no nested builds)

Use the run's bme-lock, assigned ports and pinned dependencies. Preparation is
separate; an execution run cannot build. For the recorded A/A, the clean detached
reference worktree was `W/wt/c-e-g0-reference`, at
`4d2198fe8aa89daa13b11d0a14b7a7fed3dfb5af` (main plus approved C-15d hooks).
It has its OWN npm ci, never a shared node_modules link.

```sh
L build -- node verify/core/G0/prepare.mjs --root <worktree> --scratch <outside-build-directory>
L run -w 2 -- node verify/core/G0/tbgr.mjs \
  --out <run-directory> --seed 123456789 \
  --reference <prepared-reference-directory> --candidate <prepared-candidate-directory>
```

Both prepared apps must be benchmark builds. The runner serves them at6360/6361
under its run grant with `serveApp({build:false})`, stops them in finally, opens
fresh PINNED browsers/contexts, and seeds identical named OPFS containers. It uses
shared `installVault/seedVault`, `openBrowser`, `createReport`, and served-body
binding before assertions. Functional raw-route binds the observed script/CSS
bytes unchanged and blocks foreign font/CDN requests; HTTP cache is disabled and
this is explicitly NOT timing.

Default sanity cases are32-node duplicate basenames and600-node dense topology,
each in dark and light. `--cases all` selects every exact topology; alternatively
pass a comma-separated fixture-ID list. `--themes dark` or `light` narrows themes.
The complete corpus is generated TWICE in fresh directories; its emitted hashes
must agree, while the selected actual notes are opened through the real file tree
in Reading mode and their graphs are opened through Neural Brain.

TB-GR checks ordered directed edge identities, all node IDs, finite coordinates,
nonzero displacement in steps1..30, every step1..300, and rest after step300.
Reference/candidate clocks may differ: rings join by step tag, node coordinates
join by ID, and values compare as doubles (`Object.is`, no epsilon/rounding).
It reports the first different step/node/axis and double bits, saving both rings
on divergence. Settled PNGs also compare byte-identically. No app module or
extracted simulation function is imported or invoked in the page.

## Recorded sanity

`W=/Users/adham/Developer/bme-impl`, `L=$W/scratch/bin/bme-lock`.

- Full manifest: `W/scratch/c-e/G0/generated-all/graphset-manifest.json`.
  SHA256 `970c87efb92be33b3f4b40e34327b2d59a8a97570e25b74415c42ba97725b639`.
  41 vault/sidecar records,42 emitted files including that manifest.
- A/A: same prepared reference in both slots at
  `W/scratch/c-e/G0/reference-4d`, output `W/scratch/c-e/G0/aa-sanity`.
- PASS report: `reports/2026-11-14T01-02-20.479Z-tb-gr-673b1380-4a47-4a32-834d-16146f6cbce9.json`.
  All300 steps equal in all four pairs:19,200 compared doubles per32-note pair,
  360,000 per600-note pair; zero differences. Independent complete-corpus hashes
  match. All layouts finite, moving, then settled at exactly300; PNG pairs equal.
  Chrome157.0.8103.39, Playwright1.63.0. Screenshots inspected in BOTH themes:
  sparse/duplicate layout readable;600-node dense crowding matches today's app.
- Latest report metadata also retains per-arm served-binding details and an
  explicit fixture hash map (reporting-only follow-up; no application change).

## Deferred / losses

Only the selected32/600 topologies were exercised in the app; other generated
sizes and G1 sidecars were not. Determinism on a second machine, force-mutation
proof, large-graph timing, instrumentation cost and native disk are not claimed.
Timed adapter ideas/API notes already held by v-c stay with the review-phase
queue; no new timed gate or mutant was built for merge. Theta/crossover selection
belongs to G1. Static gates and one real-app sanity are the current merge bar.
