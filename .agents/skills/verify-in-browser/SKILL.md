---
name: verify-in-browser
description: How to actually verify a change in this repo — there is no test suite, so verification means Playwright driving the running app in headless Chromium against an OPFS-stubbed vault. Load before writing any verification script, before driving the app, and before claiming a change works.
---

# Verifying a change

**There are no code-based tests in this repo** — no unit tests, no suites, no test script.
`npm run typecheck` and `npm run lint` are the static gates; everything behavioural, the helper
included, is verified by Playwright driving the running app in headless Chromium. A change is not
verified because it typechecks.

**The driver is pinned:** import `chromium` from the repo's **playwright@1.63.0** dev dependency,
never the npx cache. **The browser is pinned separately** in `verify/browser-pin.json`: Chrome for
Testing **157.0.8103.39**, launched with `executablePath`, never `channel: 'chrome'` or the bundled
Chromium. Its installed path is the scratch browser root + pin.version + pin.executable (see the
run's `scratch/HOWTO.md`). `verify/lib/` supplies the shared run toolbox; start with its README.
Every report records the actual driver/browser version, build identity, fixture hashes and reload arm.
Use `verify/lib/identity.mjs`'s shared `buildIdentity` and `bindServedBodies`: attach before goto,
await binding before every assertion and finish. Functional `raw-route` binds APIResponse raw bytes
then fulfils unchanged (HTTP cache disabled, recorded); timed `node-refetch` never intercepts, using
server bytes plus the browser URL list, not proof of the cached browser body. Same-origin JS/CSS/wasm
is fail-closed against emitted files; foreign requests are logged, never blocked by default.

## The harness, step by step

Each step below exists because skipping it produces a *working change that looks broken*.

1. **Use your assigned port, `--strictPort`, and scratch-only Vite cache/output.** Read the run's
   `scratch/HOWTO.md`: installs/builds use `bme-lock build`, static gates `static`, servers `serve`,
   browsers `run`. Start slow commands in `hc run --bg`. **Never build while holding run/bench**:
   prepare under build first (`toolbox-smoke.mjs --prepare` / `prepareApp`), then serve the frozen
   dist/identity with `serveApp({build:false})` under run. Nested preparation fails loudly; it can
   deadlock the shared pool. Stop the server between runs. Never use Vite's default 5173 or the
   developer's 5199. Lifecycle uses dev (StrictMode) and production; timing uses benchmark.

2. **Stub `window.showDirectoryPicker` with OPFS**, in an `addInitScript` *before* the page loads.
   The native picker cannot open headless.

3. **Patch `queryPermission` / `requestPermission` to return `'granted'`** — on the handle you
   return *and* on the result of `FileSystemDirectoryHandle.prototype.getDirectoryHandle`.
   Otherwise a restored vault asks for a user gesture that never comes.

4. **Seed fixture notes into OPFS after `page.goto` has landed on the real origin**, with
   `getFileHandle` + `createWritable`. `navigator.storage.getDirectory` is `undefined` on
   `about:blank`, which has no storage bucket. Re-seed every run — OPFS is per browser context.

5. **Press `⌘E` before testing anything about the caret, typing, or cell editing.** Files open in
   Reading mode by default, where nothing is editable.

6. **Selectors:** the editor is `.cm-content` inside `.cm-scroller`. Chromium only, by design. The
   welcome screen carries up to **two** `.welcome-btn`s, and the second one opens a *different*
   vault: `Open Vault` (always — the picker) plus either `Open '<linked vault>'` (a hash naming a
   known vault whose grant has lapsed) or `Restore '<previous vault>'` (a stored handle whose grant
   has lapsed). Never both — the linked branch returns before the stored one is reached. Match
   `{ name: 'Open Vault', exact: true }`; a loose `{ name: 'Open' }` is ambiguous on the linked
   screen. The vault switcher (`.vault-switcher`, `aria-label="Switch vault — <name>"`, bottom of the
   sidebar) exists only once a vault is open, and `.vault-menu-row` only inside its menu. Stub the
   picker with a NAMED OPFS subfolder, not the OPFS root: the root's `name` is `''`, so the switcher
   shows no name and Trash (keyed on it) is disabled. Tooltips are `.tooltip` (≈400ms hover delay).

7. **Stored OPFS handle reads crashed the bundled Chromium 153.0.8010.12 and installed Chrome
   153.0.8010.53**, on reload and second-vault opens. This was browser-build-dependent, not an app
   regression; installed Chrome also updates itself, invalidating comparisons across runs.

   Two explicit reload / restore / two-vault arms — always record which you took:
   - **Pinned Chrome for Testing by `executablePath`, no shim.** Use the version and executable in
     `verify/browser-pin.json`. The integrator measured 157.0.8103.39 surviving **3 of 3** stored-
     handle reload runs. This exercises native structured cloning (`keyval-store` in
     `indexedDB.databases()`, no `__h_idb:` keys). A crash is a harness fault, not an app failure.
   - **Dev fallback: route-intercept the `idb-keyval` module** with a localStorage shim storing
     `{__handle: name}`, re-resolved from the OPFS root — **pack/unpack recursively**, because
     `recent-vaults` is an array of objects each holding a handle, not a bare handle. Works on the
     bundled build, but the real structured-clone path then goes unexercised. (Deleting the
     `keyval-store` database before the reload and re-opening through the picker dodges the read
     instead — and dodges what you were testing, if that was the restore.)

   **A `goto` that differs only in the `#hash` does not reload** — it navigates in-page, the restore
   effect never re-runs, and a link-opens-a-note probe silently proves nothing. Force it
   (`page.reload()`), and assert you did: set a `window` marker before, check it is gone after.

8. **`await document.fonts.ready` before asserting a column width.** Two fonts re-trigger the table
   fit when they land, and only one of them is a request you could watch for. The app reaches **two**
   Google hosts: `index.html` links a `fonts.googleapis.com` stylesheet (Fira Code) and preconnects
   `fonts.gstatic.com`, and a chosen text font adds a second stylesheet at runtime (`App.tsx`'s
   `google-font-link`) — but the request that moves layout is the **gstatic woff2**, fetched only for
   a face something actually renders, so a default load makes no font request at all. **KaTeX's faces
   are bundled locally** and a table holding maths re-fits when they arrive too (`tableFit`'s
   `mathProbe`). Offline is not an exemption.

9. **Suppressed browser menus are asserted, not screenshotted.** To check the app's own context menu
   replaced the browser's, assert `defaultPrevented` on the `contextmenu` event — the OS menu never
   appears in a screenshot either way.

10. **Outside changes are simulated in OPFS, from OUTSIDE the app's code path** — a separate
    `page.evaluate` (or a Worker) opening fresh `navigator.storage.getDirectory()` handles and writing
    with `createWritable`, deleting with `removeEntry`, renaming with `handle.move()` (which gives real
    `moved` records) or copy + delete (which does not — the hash-pairing path). First assert
    `typeof FileSystemObserver === 'function'` in this Chromium; `delete window.FileSystemObserver` in an
    init script forces the polling fallback (`liveDetection === 'polling'`) and the save-time check
    alone. Count the app's own writes with an init-script wrapper on `createWritable`, and tree work
    with one on `FileSystemDirectoryHandle.prototype.entries` plus a MutationObserver on `.tree-item`s.
    Real-disk FSEvents (records, `.crswap` handling) differ from OPFS and cannot be driven headless —
    the native picker is the wall; say so rather than claim them.
    Use `verify/lib/vault.mjs`'s `readWitness` for bounded NotReadableError-only retries (every
    retry is reported; exhaustion is a harness fault). **Never retry NotFoundError**: it may be a
    real deletion. For swap races, readWitness's `afterCompletedCloses:{path,count}` first waits
    on completed successful counter closes; reset after seeding, pass the expected absolute count.
    Its bounded wait reports the observed count and fails as HarnessFault. For async conditions use
    `waitForVault`, **never `page.waitForFunction(async ...)`**: a returned Promise can appear
    truthy before the native read completes. The helper records its last value and hard deadline.

11. **The terminal needs the real helper:** `npm run helper:dev` (a source run: dev origins allowed,
    the in-process PTY backend, never the installed macOS PTY host) beside the dev server — loopback to
    loopback raises no Local Network Access prompt. Set `VAULTAGENT_TERMINAL_SHELL=/bin/sh` for a
    deterministic shell (test-only; the user's real login shell runs otherwise). Type into
    `.xterm-helper-textarea`. The WebGL renderer draws to a canvas, so assert through the shell's own
    side effects (`echo marker > $TMPDIR/x`, read it back from Node) or screenshots; `.xterm-rows` holds
    text only under the DOM renderer fallback. Kill stray helpers you started; never stop the user's
    installed one.

## Sketch

```js
await page.addInitScript(() => {
  const grant = (h) => {
    h.queryPermission = async () => 'granted'
    h.requestPermission = async () => 'granted'
    return h
  }
  const getDir = FileSystemDirectoryHandle.prototype.getDirectoryHandle
  FileSystemDirectoryHandle.prototype.getDirectoryHandle = async function (...a) {
    return grant(await getDir.apply(this, a))
  }
  window.showDirectoryPicker = async () => grant(await navigator.storage.getDirectory())
})
await page.goto(`http://localhost:${PORT}/`)   // seed OPFS only AFTER this line
```

## Read the colour off the element the TEXT NODE hangs off

`getComputedStyle(el).color` on a wrapper says what that wrapper would paint, not what you see: a
CodeMirror mark decoration wraps the highlighter's own span, so the inner one wins. Three rounds of
"measured, it works" missed a bug a screenshot showed in one second. When a check is about what the
user SEES, walk to the text node's parent — or take the screenshot and look at it.

## What to check beyond the change itself

Per the repo's standing instruction: be picky about the UI. If something on screen is visibly
wrong — misaligned, flickering, mis-sized — fix it even if it is not what you were sent to do.

Reading integration additionally needs zero EPUB writes/hash equality, disguised-binary refusal, rename/retry/reload/vault identity, fresh/adopt/live/IME emphasis, native PDF/EPUB shared-toggle paint, reversible layout/anchor preservation, inactive-page capability, independent manual PDF Text and lazy-network checks. Isolated worker proofs are not integrated acceptance.

EPUB opaque-frame runs must omit Playwright's `serviceWorkers:'block'`: its injected service-worker
blocker reads navigator.serviceWorker in a sandboxed realm and throws SecurityError. Use a fresh
context with no service worker instead; this does not loosen the frame CSP. Select file rows using
the displayed name (`.md` hidden), scope shared emphasis to `.editor-slot-header`, and compare
whole canonical words across prefix text nodes. Wait for reader navigation/restore to settle,
not merely the first `.chapter` attach. Explicit Cmd+S on a clean NOTE intentionally writes it;
separate that gesture from zero-write display-only tests. EPUB Cmd+S remains a required no-write probe.
