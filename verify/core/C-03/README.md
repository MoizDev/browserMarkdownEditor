# C-03: asset reconciliation belongs to its vault activation

## Unfixed reproduction

`reproduce.mjs` drives the actual built app in pinned Chrome for Testing
157.0.8103.39 with Playwright 1.63.0 (both asserted). No app module/callback is
an entry; no IndexedDB shim. Named OPFS vaults replace only the picker and
permission grants. Fixture/external writes are excluded from app counters.

Build an unchanged App/context source snapshot in an isolated source worktree
with its own install and private Vite config, under the build lock:

```sh
L=/Users/adham/Developer/bme-impl/scratch/bin/bme-lock
"$L" build -- node verify/core/C-03/build.mjs production /path/to/private-vite.mjs /path/to/unfixed-dist
```

Serve that output using `L serve -- vite preview --strictPort` on this seat's
port, immediately around the browser run (never leave it up while queued for a
run). The identity helper binds the source commit/tree/mode to every output
file hash; the browser asserts the HTML and every actual script response hash.

```sh
"$L" run -- node verify/core/C-03/reproduce.mjs \
  http://localhost:6285/ /path/to/artifacts /path/to/unfixed-dist.identity.json
```

The script removes `![[x.png]]` from A/a.md, switches to B inside autosave's
second, and holds A's closing writable **after its real close**, until B is
committed on screen. It then releases that write. A native wrapper records
source `removeEntry` attempts/completions without inserting an await before
the native invocation. It waits for completed A/.Assets/x.png removal (not
merely a retired copy), then for the independent completed A/a.md close count,
and reads real files. Disk reads retry only NotReadableError (three retries,
25 ms yield); NotFoundError is not retried. The original picture is proved
renderable before the edit.

Expected unfixed result: `FAIL D05-preservation ...`, exit1; observation.json
must say live=false, retired=true, neighbour's embed unchanged, A's edited
text saved and native source removal completed. URL/hash/pin or witness setup
errors are invalid (exit2), not reproduction proof. Other real flow failures
have FAIL D05-flow and do not count as reproducing the named defect.

## Candidate gate (being implemented)

The approved `__perf.assetJobs.completed` hook supplies only a completion WAIT
on the benchmark build. Independent native removal counts, listings and bytes
supply truth. The production companion is explicitly not a completion proof.
Acceptance also needs detached A→B→A, copy-stage cancellation, same-vault
last-reference retirement and plain-link protection, failed-write queue recovery,
revision invalidation/one-pass typing protection, fresh returned-neighbour image
paint and all three named mutants. Save-path timing remains pending V-04/V-08.
