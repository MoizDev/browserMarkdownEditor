# Browser-run toolbox

Plain Node ESM + the pinned Playwright/Chrome for Testing (`verify/browser-pin.json`), no runner. Drive the
**real app**, never import its modules. It is used **only when a change needs it** (a UI/UX change, or anything
visible only by using the app); `typecheck` and `lint` gate everything else. JSDoc documents exact options.

## Setup, once per machine

```sh
npm ci
node verify/install-browser.mjs     # = npm run verify:browser; downloads, checks the sha256, prints the path
```

- **Browser**: `BME_CHROME_PATH` if set, else `<BME_BROWSER_CACHE or the per-user cache>/<version>/…`
  (macOS `~/Library/Caches/bme-verify/browsers`, Linux `$XDG_CACHE_HOME` or `~/.cache`, Windows
  `%LOCALAPPDATA%`). A missing browser fails naming the installer.
- **Scratch**: `BME_SCRATCH`, else a per-clone folder under the OS temp dir (`paths.mjs` `scratchDir`). Builds,
  profiles, screenshots and reports go there, never into the repo; `prepareApp` refuses a scratch inside it.
- **Ports** are yours to choose and strict: a taken port fails instead of moving. Servers stop on exit.
- **Material not in the repo** (a corpus, upstream fixtures, a reference checkout) is named by an env variable or
  argument; a kit without it stops with one sentence saying what to provide (`paths.mjs` `requiredInput`).

## Runnable example: `verify/guards/toolbox-smoke.mjs`

Three notes/image → Open Vault → A → Cmd/Ctrl+E → type → read autosave → B→A → forced restore;
then an original EPUB fixture opens its real opaque frame with zero pageerrors.
Expected through restore: **one A writable/close, zero removals/workers**. Controls cover reads,
completed-close barriers, async-false waits, and UTF-8 CSS loaded as stylesheet **and fetch()**.
`BME_PORT` (default 6160), optionally `BME_SCRATCH`, `BME_ROOT`, `BME_MODE`. Preparation and execution are
separate steps:

```sh
export BME_MODE=production                     # repeat with dev for StrictMode
node verify/guards/toolbox-smoke.mjs --prepare
BME_PORT=6160 node verify/guards/toolbox-smoke.mjs
# The mutant arms (--mutant, --binding-mutant, --init-mutant, …) prove the oracles; not routine.
```

Preparation freezes dist + build identity in `prepared.json`; a run serves exactly that and never
rebuilds. Dev rechecks HEAD + src/index/shared/public/config content (generated EPUB too):
`build.devSourceCheck` records expected/actual; drift is HarnessFault. Kept extra mutants are dev-only
`--dev-drift-mutant` / `--head-drift-mutant`, plus `--init-mutant` (both phases).
The latter hides subframe FSA constructors and removes guards, proving the pageerror oracle.
OPFS is **not real disk**.

## Small API (all page operations take `page` first)

- **serve:** `prepareApp({root?,scratch?,mode})` builds and freezes. `serveApp({root?,scratch?,port,
  mode,build:false})` → url/distDir/identity/stop; stop in finally. `scratch` defaults to
  `scratchDir('app', mode)`. `withSaveSkipped` copies **this worktree's own** dependencies (an APFS
  clone on macOS).
- **paths:** `sourceRoot`, `scratchRoot`, `scratchDir(...)`, `pin`, `pinnedChromePath()`,
  `pinnedChrome()` (throws naming the installer), `browserCache()`, `requiredInput(VAR, what)`.
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
- **counters:** installCounters and installVault are main-window-only, safely skip missing FSA;
  they never enter opaque EPUB/engine frames. installCounters(context,{vaultName?}) before page;
  read/reset give window snapshots
  (reset returns old). Writes/completed closes/removal/iteration/getFile/workers/canvas IDs;
  vault-relative paths/opfsPath, start/completion times. Outside/readback **also count**. **No
  worker internals/blob bodies** (V-01b); no paused-target counters for timing. **requests:**
  recordRequests → read/stop, URL/origin/method/status/type/transfer bytes (raw-route is intercepted).
- **targets:** instrumentTargets(page,{debuggingPort,vaultName,report}) → check/read/stop; functional
  only, never bench; a loopback port you chose. Same runtime in window/workers, strict announced
  worker receipts; frames deferred. See TARGETS.md: measured CfT157 WorkerLocation crash, minimal
  sequence, and mandatory rule to take pre-resume URLs from TargetInfo, never WorkerLocation.
- **report:** createReport({scratch,name,fixtures,...}) → data/assert(label,expected,actual)/fail/finish;
  expected/actual are assertion-time JSON snapshots; comparison still uses the original values.
  finish in finally, unique JSON/screenshot→scratch/reports. No assertions is not a pass. Include
  fixture hashes, reload arm, build identity and awaited served binding.
