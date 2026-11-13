# C-15a: save-funnel measurement hooks

A headless-browser run of the real app, not a module-level test. No app module
or internal callback is imported or invoked by the run. The only mutations are
real UI input and explicitly external OPFS writes.

## Build and serve

All commands below run through the integrator's `bme-lock`; see the run's
scratch `HOWTO.md`. Use this seat's ports (6280–6299), separate output folders,
a scratch Vite config with the proper source `root`, and `--strictPort`.

From a **clean, committed source worktree**, build each mode with provenance:

```sh
L=/Users/adham/Developer/bme-impl/scratch/bin/bme-lock
"$L" build -- node verify/core/C-15a/build.mjs production /path/to/scratch-vite-config.mjs /path/to/prod
"$L" build -- node verify/core/C-15a/build.mjs benchmark /path/to/scratch-vite-config.mjs /path/to/bench
```

The helper runs normal `vite build`, verifies the source commit/tree did not
change, then writes `OUT.identity.json` beside each output: commit, clean tree,
mode and SHA-256 of **every** output file. For a mutant, pass its patch file as
the last argument. The helper checks reverse application and records patch and
actual diff SHA-256; its source worktree must differ only at the named App hook.
A failed build never leaves an old identity file in place.

Serve P (production preview), B (benchmark preview) and D (default-mode Vite
dev server) through `"$L" serve -- ...`, in hc terminals. D runs the same clean
committed source worktree; the run verifies its commit, empty `git status`, and
the served React dev module's absolute App source filename. Stop all servers
when the run is finished. Neither preview nor dev is started by the script.

## One invocation, three arms

Run from a checkout with Playwright **1.63.0** (the I-0 lane checkout for a
reference build). Copy the canonical script here into that checkout at the
same path if its branch has not received these verification scripts yet.
Prepare a scratch JSON config:

```json
{
  "commit": "THE_FULL_SOURCE_COMMIT",
  "artifacts": "/path/to/run-artifacts",
  "arms": {
    "P": { "url": "http://localhost:6281/", "identity": "/path/to/prod.identity.json" },
    "B": { "url": "http://localhost:6280/", "identity": "/path/to/bench.identity.json" },
    "D": { "url": "http://localhost:6282/", "root": "/path/to/clean-source-worktree" }
  }
}
```

```sh
"$L" run -- node verify/core/C-15a/funnel.mjs /path/to/run-config.json
```

The three fresh browser sessions run **sequentially**, weight 1. Each asserts
Chrome for Testing **157.0.8103.39** and driver **1.63.0** (not merely recording
them). The default executable is the run's pinned scratch Chrome; `chrome` in
the config can name the same pinned build at another path.

## Witnesses, identity and losses

Every arm opens a named OPFS vault, edits a note, waits for autosave, changes
it externally (the real polling fallback reloads it), edits it again, closes
the dirty tab immediately and reopens through the tree. An init wrapper
counts app `createWritable`/completed `close` calls and sanctioned hook events;
fixture and outside writes are excluded. Native disk probes start only after
the exact independent close count. They use bounded, awaited `page.evaluate`
reads, never an async `waitForFunction` predicate. Only witness-side
`NotReadableError` is retried (at most three retries, 50 ms yields, 10 s deadline,
counts in every report). App-side errors and other read errors are never retried.

- **P:** hash and scan every page/worker script response body. Also use actual
  browser `fetch` calls to retrieve every other emitted `.js` from that preview
  origin, labelled **supplemental**. Every scanned body must match its build
  identity hash. There is no Node-side dist-content assertion. Anchors are
  `bme-perf-hooks-plant-7f3a`, `__perf`, `ownerlessReports`; all must be absent.
  After the flow `window.__perf` is undefined; no hook report/event occurred.
- **B:** the same identity checks; all anchors must be present in a script
  **the user flow fetched**, not just supplemental responses. The funnel is
  live: two snapshot reads, at least two `pane:note` reports, exactly one `disk`
  report, no rejections, all reports ownerless. Two sanctioned `flushTab` write
  reports/events must precede exactly two independently completed writables.
- **D:** assert runtime absence and zero hook reports/events. Record observed
  response hashes. **Loss:** dev source text carries dead guarded code; text
  absence is not asserted. P/B file identities apply only to builds, not Vite's
  dynamically transformed dev modules.
- **Parity:** identical saved note bytes and visible DOM records in P/B/D
  (text, tab/tree labels, dirty state, DiskBars). Screenshots are retained for
  inspection; transient status text is not compared.

This note-only flow does **not** exercise rejections, the agent bucket, PDF
rotation/annotation, notebook export, metadata, conflict copies or recreation.
Those sites are instrumented but not behaviourally proved by this run. An
operation-start report does not promise a writable: refused versioned/recreate
attempts still report their sanctioned start. Mounted agent edits arrive via
the pane listener; only the host's direct funnel call is tagged `agent` today.

## Mutants

Apply a patch under `mutants/` to an independent scratch source worktree with
its **own** install, based on the same clean hook commit. Build it using the
same helper and normal production configuration (benchmark mode for the
missing-report mutant). In the corresponding arm of an otherwise identical
run config, use the mutant's own identity and add `patchSha256` matching that
patch. Use the same three-arm invocation, not a special negative-test mode.

- `unguarded-write.patch`: P must fail with `FAIL P-anchor ...`.
- `missing-flush-report.patch`: B must fail with
  `FAIL hand-count write-reports 0!=2`.

The runner checks these **named** reasons, not arbitrary nonzero exits:

```sh
"$L" run -- node verify/core/C-15a/mutants.mjs /path/to/unguarded-config.json /path/to/missing-config.json
```

A missing URL, unapplied patch, wrong commit/browser/driver, body hash mismatch,
or any setup error is **invalid** (exit 2), never a mutant kill. Product
failures have named reasons and exit 1: P-anchor, P-hook, D-hook, B-control,
hand-count, per-arm render/write failures and parity. The same clean gate must
exit 0 for P/B/D before either negative result is offered.
