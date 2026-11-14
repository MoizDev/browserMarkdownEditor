# Interim core browser-run helpers (C-07b → V-02)

Plain Node ESM + pinned Playwright. These drive the **real app**, not imported app modules. c-lead
and vr-lead authorised this seam while `verify/lib` was unmerged; **v-a's V-02 adopts/moves these
helpers into `verify/lib`**, and V-01b replaces the interim CDP target counter. V-01a has now landed:
new runs use its shared browser/vault/window-counter/serve helpers. These already-written copies
remain for the kept red probes, as charter §0 requires, not as an alternative for new runs. Other
core lanes may import the missing WebSocket/worker-target pieces, not copy them.

- `helper.mjs`: `installHelperStandIn(context,{cancel,record})`. Answers discovery and the real
  agent WebSocket using `shared/vaultAgentProtocol.ts`'s constants. Every frame is recorded with
  direction/time. Only a **user-started** run can receive `sendTool(name,args)`. It returns the
  call record plus its result promise. `cancel:'after-tool'` keeps Stop open until its in-flight
  tool replies; `cancel:'immediate'` closes a helper-side run that no longer awaits it (vault
  switch). Duplicate/unknown results are harness faults. `dispose` clears all Node waits.
- `counters.mjs`: `installCounters(context)` before goto → `{read(page)}`. **Worker-only**, not
  V-01a's filesystem/canvas counters: constructor/URL, posts (ids/op/path/priority/deadline), replies
  (metadata only), native terminate calls, errors, document freeze/resume, unhandled rejections.
  It never retains result bytes/bitmaps and never prevents a worker error itself. `read` also reads
  the benchmark's public `window.__perf.workers()` snapshot; it never mutates it.
- Same module: `installWorkerTargets(page,{record})` before goto → `{read,workers,session,stop}`.
  Auto-attach is not paused. Actual target attach/detach is independent of a claimed terminate
  counter; runs compare these two observations and assert started = ended + alive. V-01b's future
  `verify/lib/targets.mjs` takes over this part.
- `substitute.mjs`: `buildIdentity({worktree,distDir,patch?})` freezes emitted-file hashes plus
  commit/source diff/patch identity. `bindServedBodies(context,{identity,origin,mode,rules,record})`
  hashes **actual original response bytes**, binds production bodies to the emitted manifest,
  and fulfils unchanged unless a rule matches that served URL. A rule requires an exact anchor
  count and supplies a replacement/prelude. Every applied rule records original AND substituted
  SHA-256, URL, bytes, status and time. Absent/drifted anchors are harness faults, not skips.
  `check()` is called before gate assertions; `requireApplied(id)` proves a substitution was served.
  Worker faults separately report that their prelude actually fired; serving is not firing.
- `vault.mjs`: only named OPFS picker/seeding and native reads for these runs. `readWitness` opens
  fresh native handles and retries **only** a returned `NotReadableError`, never NotFound.
  `waitForVault` awaits each page.evaluate/native read; never pass an async filesystem predicate
  to Playwright waitForFunction. `__bmePickVault` changes the picker stub, not app state: use actual
  Open Vault/switcher gestures afterwards. V-01a's fuller vault API replaces this minimal piece.

No build/run is started by these modules. Separate preparation from execution, obey
`/Users/adham/Developer/bme-impl/scratch/HOWTO.md`, and stop servers between runs. No memory-costing
nested grants. Records contain fixtures only; the run must block outside requests, use fresh OPFS
and never open a real user vault. Existing body-binding/preparation probes are retained for the
review phase under charter §0, not additional merge conditions. Helpers are exercised only through
real-browser runs, never a unit test or in-file self-check; not every helper branch is claimed covered.
