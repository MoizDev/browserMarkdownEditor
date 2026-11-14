# C-07b: matcher recovery and per-vault ownership

Charter §0 rescoped this package to its **product fixes and one real-app sanity run**. The full
PL0-G1/G2 matrix, clock cells, mutants and reviewer proofs are deferred, not merge requirements.
No code-based tests or source fault hooks are added.

## Product changes

- A real `WorkerCrashed` leaves recovery/back-off to the shared host. Only an ending the matcher
  itself caused (cancel/deadline/handler or protocol failure) deliberately retires its worker.
- The client belongs to the vault. `releaseAgentMatcher` aborts its query and calls `dispose` when
  `chatStore.attach` changes vault or `onUninstalled` ends the helper. It does **not** run when chat
  is hidden or a document pane closes. An epoch fences an old lazy import after its vault closed.

Both defects began with real-browser reproductions over the app's agent WebSocket:

- `backoff-repro.mjs` + `faults/crash-after-hello.mjs`: one crash caused the matcher's finally to
  cancel the host's recovery; observed **two starts, one fired fault, owner idle** instead of failed
  after four automatic crashes. Its frozen red observation remains in lane scratch.
- `owner-release-repro.mjs`: a normal completed search followed by the real vault switch left an
  idle worker and its old client registry entry alive. Its red observation is kept too.

## Current sanity run

`sanity.mjs` uses the shared `verify/lib` browser, OPFS, counters, input and serving helpers. V-02's
logged real-WebSocket helper and V-01b's worker-target counters are not merged; the already-written
interim helpers under `verify/core/lib` provide only those missing pieces. No app module is imported
into the page. The one fault is a served prelude to the **real matcher chunk**, causing an uncaught
worker error during an actual search batch. It is removed for the host's automatic replacement.

The run checks automatic recovery before another tool call, the next search's correct answer,
that this query reuses the replacement, and that the real vault switch ends all matcher targets
and removes its owner. It captures dark/light screenshots; inspect them. Fresh named OPFS only,
no real vault, no helper CLI, no outside request. Browser/driver are the shared pinned versions.

Run from this worktree, in hc terminals, with assigned port 6320 (or `BME_PORT`):

```sh
L=/Users/adham/Developer/bme-impl/scratch/bin/bme-lock
"$L" build -- node verify/core/C-07/sanity.mjs --prepare
"$L" static -- npm run typecheck
"$L" static -- npm run lint
"$L" run -- node verify/core/C-07/sanity.mjs
```

Preparation and execution are separate. The run holds a memory-costing grant and only nests a
memory-free serve grant; it stops browser/server in finally. Default artefacts:
`/Users/adham/Developer/bme-impl/scratch/c-c/c07b/sanity/` (`reports/`, `screenshots/`).

## Kept work, owed to the review phase

The two red probes, `fixture.mjs`, `record-build.mjs` and their interim helper modules already existed
when the owner deferred reviewer proofs, so they are committed rather than discarded. Their older
prepared-build/body-binding path is not a merge requirement and is not re-run for this hand-off.
The full cross-product matrix, deliberate clock manipulations, permit-leak negative control and
other previously planned mutants **have not been built**; do not count them as passed. C-07a's
already-completed query/deadline/Stop/semantic/cap runs and mutants are kept under C-07a.
