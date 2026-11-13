# Browser-run toolbox

Plain Node ESM + pinned Playwright/CfT (`verify/browser-pin.json`), no runner. Drive the **real app**,
never import its modules. Read `scratch/HOWTO.md`; use assigned ports, own install, `hc run --bg`.
Stop servers between runs and for timing windows. JSDoc in each `.mjs` documents exact options.

## Runnable example: `verify/guards/toolbox-smoke.mjs`

Three notes/image → Open Vault → A → Cmd/Ctrl+E → type → read autosave → B→A → forced restore.
Expected through restore: **one A writable/close, zero removals/workers**. Controls cover reads,
completed-close barriers, async-false waits, and UTF-8 CSS loaded as stylesheet **and fetch()**.
Set `BME_SCRATCH`, `BME_PORT`, optionally `BME_ROOT`. Preparation and execution are separate:

```sh
L=/Users/adham/Developer/bme-impl/scratch/bin/bme-lock
export BME_MODE=production                     # repeat with dev for StrictMode
"$L" build -- node verify/guards/toolbox-smoke.mjs --prepare
"$L" run -- node verify/guards/toolbox-smoke.mjs
# Repeat BOTH phases with --mutant, then --binding-mutant; runs must fail their named witness.
```

**Never build under run/bench**: it deadlocks the pool. Preparation freezes dist + build identity
in `prepared.json`; execution refuses missing/mismatched preparation. OPFS is **not real disk**.

## Small API (all page operations take `page` first)

- **serve:** `prepareApp({root,scratch,mode})` reuses/acquires build. `serveApp({root,scratch,port,
  mode,build:false})` → url/distDir/identity/stop; stop in finally. Build/prepare refuse run/bench.
  `withSaveSkipped` uses an isolated APFS clone of **this worktree's own** dependencies.
- **identity:** `buildIdentity({worktree,distDir?,patch?})` → commit/treeClean/patchSha256/files
  [{path,sha256,bytes}]/manifestSha256. `bindServedBodies(context,{identity,origin,mode,buildMode,
  report?,blockExternalOrigins?,moduleOverrides?})` → check/stop. Attach before goto; **check before
  EVERY assertion and finish**. Functional `raw-route` hashes raw APIResponse bytes, fulfils
  unchanged, disables HTTP cache (recorded). Timed `node-refetch` never intercepts: browser URL
  list + Node fetch/URL at check, outside the timed action; not proof of cached browser bytes.
  Same-origin JS/CSS/wasm fail closed against emitted files; dev records modules. Foreign bodies
  are logged, never bound/blocked by default. Pass installReload's dev-only moduleOverrides.
- **browser:** openBrowser → fresh browser/context/identity/close; both pins enforced.
  `BME_CHROME_PATH` relocates CfT. **vault:** installVault(context,{name}) before page, seedVault
  ({name,files:path→text/bytes}) after goto; readVaultFile({name,path,binary?}) → text/Buffer;
  outsideChange supports write/delete/move/copy-delete (native move never silently copies).
  readWitness retries **only NotReadableError**, fresh handles; default20 attempts/19×25ms delays,
  cap100/1000ms; every retry logged, exhaustion=HarnessFault. **Never retries NotFoundError.**
  Optional afterCompletedCloses:{path,count,timeoutMs?:10000,intervalMs?:50} first waits on completed
  successful closes (requires counters with vaultName); logs observed count, timeout=HarnessFault.
  Count is absolute since reset: exclude fixture/external closes. waitForVault(asyncCondition,
  {arg?,timeoutMs:10000,intervalMs:50,report}) awaits native reads, requires true, hard deadline
  ≤300000ms; records last value/polls/elapsed. **No async filesystem waitForFunction.** Assert content.
- **input:** editMode/typeText/press/pointer/wheel use real driver input; await fontsReady before
  geometry/screenshots. **reload:** installReload before page; forceReload checks vanished marker
  and explicit arm. pinned-chrome uses native IDB; idb-shim recursively packs handles in dev,
  **refuses production**, loses native cloning. Production fallback belongs to V-02.
- **counters:** installCounters(context,{vaultName?}) before page; read/reset give window snapshots
  (reset returns old). Writes/completed closes/removal/iteration/getFile/workers/canvas IDs;
  vault-relative paths/opfsPath, start/completion times. Outside/readback **also count**. **No
  worker internals/blob bodies** (V-01b); no paused-target counters for timing. **requests:**
  recordRequests → read/stop, URL/origin/method/status/type/transfer bytes (raw-route is intercepted).
- **report:** createReport({scratch,name,fixtures,...}) → data/assert(label,expected,actual)/fail/finish;
  finish in finally, unique JSON/screenshot→scratch/reports. No assertions is not a pass. Include
  fixture hashes, reload arm, build identity and awaited served binding.
