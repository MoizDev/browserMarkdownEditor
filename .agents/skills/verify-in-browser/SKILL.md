---
name: verify-in-browser
description: How to check a change in the real app when it needs checking — there is no test suite, so a UI/UX change (or any change only visible by using the app) is verified by Playwright driving the production build in the pinned headless Chrome for Testing against an OPFS-stubbed vault. Covers when a run is needed, installing the pinned browser, preparing and serving a build, seeding notes, boards and PDFs, opening documents, forcing and proving WebGL2 or canvas2d, DPR and themes, waiting for a settled picture, and the traps that make a working change look broken. Load before writing any browser script, before driving the app, and before claiming a UI change works.
---

# Checking a change in the real app

**There is NO test suite, and none is run routinely** (AGENTS.md bans code-based tests). `npm run typecheck` and
`npm run lint` are the static gates for **every** change. A headless run of the real app is done **if and only
when a change needs it**: a UI/UX change, or any change whose correctness is only visible by using the app as a
person would (drawing, rendering, opening, saving, restoring). A change that typechecks is not verified when it is
one of those; a change that is not one of those needs no browser run.

When a run is needed, the bar is: reproduce the bug once the way a person meets it, fix, show it once more the same
way, and look at the screenshots (both themes if it draws; both backends if it renders). For a speed fix, one
before/after pair.

## The pinned toolchain

- **Driver**: `playwright@1.63.0` from the repo's own `node_modules` (`npm ci`), never the npx cache.
- **Browser**: Chrome for Testing **157.0.8103.39** (`verify/browser-pin.json`, pinned with a sha256 for
  `mac-arm64`, `mac-x64`, `linux64` and `win64`), launched by path. Get it once per machine:
  `node verify/install-browser.mjs` — it downloads this platform's archive from Google's Chrome for Testing
  bucket, checks bytes and sha256 against the pin, unpacks it into a per-user cache (`BME_BROWSER_CACHE` moves
  it) and prints the executable; run again, it only prints. `BME_CHROME_PATH` launches another copy of the
  same build. `openBrowser` enforces both pins, gives a fresh context, and when the browser is missing fails
  naming the installer. Never use `channel: 'chrome'` (installed Chrome updates itself mid-run) or Playwright's
  bundled Chromium (it crashed reading a stored folder handle on reload).
- **Scratch**: builds, profiles, screenshots and reports go to `BME_SCRATCH`, by default a per-clone folder under
  the OS temp dir (`scratchDir(...)` in `verify/lib/paths.mjs`), **never the repo**: Vite's `outDir` must sit
  outside the source root, and your own check scripts belong outside it too.
- **Toolbox** (`verify/lib/`, its README has every option): `serve.mjs` (`prepareApp`, `serveApp`),
  `browser.mjs`, `paths.mjs`, `vault.mjs` (`installVault`, `seedVault`, `readVaultFile`, `readWitness`,
  `waitForVault`, `outsideChange`), `identity.mjs` (`bindServedBodies`), `counters.mjs`, `input.mjs`,
  `reload.mjs`, `fast.mjs` (`openDocument`, `treeRow`), `report.mjs`. Fixture generators are in `verify/fixtures/`
  (PDFs via `fixtures/lib/pdf.mjs`). A complete worked example: `verify/guards/toolbox-smoke.mjs`.

## Recipe

Preparing and running are separate steps: the run then measures exactly the build it names, and many runs share
one build. Write both scripts **outside the clone** (your scratch), with `R` set to the clone's path.

1. **Prepare** once per source change: a production `vite build` into scratch, with its identity frozen in
   `prepared.json` (`mode: 'dev'` only to exercise StrictMode; dev refuses to serve if HEAD or sources drifted):

```js
// prepare.mjs — R=/path/to/clone node prepare.mjs
const { prepareApp } = await import(`${process.env.R}/verify/lib/serve.mjs`);
const prepared = await prepareApp({ root: process.env.R });   // scratch defaults to scratchDir('app', mode)
console.log(prepared.distDir);
```

2. **Run** against that build, on a free port you choose (strict: a taken port fails instead of moving). Bound it
   with a hard timeout (`timeout 300 node check.mjs`) so a hung page cannot hold the port; servers stop on exit.

```js
// check.mjs — R=/path/to/clone PORT=5661 node check.mjs
const R = process.env.R, lib = name => import(`${R}/verify/lib/${name}.mjs`);
const { serveApp } = await lib('serve'), { openBrowser } = await lib('browser'), { scratchDir } = await lib('paths');
const { bindServedBodies } = await lib('identity'), { installVault, seedVault } = await lib('vault');
const { openDocument } = await lib('fast'), { editMode, fontsReady } = await lib('input');
const BOARD = '{"format":"board","version":[1,0],"kind":"whiteboard","fence":"compat-1: compatibility fence, holds no content, so that builds of this app from before the guard release refuse to edit this file","document":{"schema":{"schemaVersion":999},"store":{}},"records":[\n{"type":"sheet","id":"Qm3vL8a0Zt","name":"Page 1","order":"a0"},\n{"type":"end","count":1}\n]}\n';
const app = await serveApp({ root: R, port: Number(process.env.PORT), build: false });
const run = await openBrowser({ launchOptions: { args: [] }, contextOptions: { viewport: { width: 1200, height: 800 } } });
try {
  await installVault(run.context, { name: 'Fixture' });               // OPFS picker stub + 'granted' permissions
  await run.context.addInitScript(() => { if (window === window.top) {
    localStorage.setItem('bme.renderAudit', '1');                     // optional: window.__bmeRenderAudit
    localStorage.setItem('theme', 'light');                           // 'light' | 'dark' (absent = dark)
  } });
  const binding = await bindServedBodies(run.context, { identity: app.identity, origin: app.url.slice(0, -1), buildMode: 'production' });
  const page = await run.context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.goto(app.url);
  await seedVault(page, { name: 'Fixture', files: { 'A.md': '# A\n\nHello.\n', 'B.drawing': BOARD } });
  await page.getByRole('button', { name: 'Open Vault', exact: true }).click();
  await openDocument(page, 'A.md');                                   // waits for the editor
  await editMode(page);                                               // notes open in Reading mode
  await openDocument(page, 'B.drawing');                              // waits for the board's canvas
  // ... act as a person would ...
  await fontsReady(page);
  await page.screenshot({ path: scratchDir('shots', 'board.png') });  // then LOOK at it
  await binding.check();                                              // the served bytes were the prepared build
  if (errors.length) throw new Error(errors.join('\n'));
} finally { await run.close(); await app.stop(); }
```

**Fixtures.** Notes are text. A minimal native whiteboard is the one-line-per-record text in `BOARD` above (the app
writes the full form itself on save). Or make one as a person does: the file tree's **New drawing or notebook**
button. PDFs: pdf-lib through `verify/fixtures/lib/pdf.mjs`, or a small file kept in your scratch.

**Selectors.** File rows `.tree-item[data-path="…"]` (`treeRow`; names show without `.md`); the note editor
`.cm-content`; a board's surface `.board-viewer-surface`; a PDF's `.pdf-tiled-surface` (Original) or
`.pdf-reading-scroll` (Text); board tools are buttons named by tool (`getByRole('button', { name: /^Draw/ })`).

## WebGL2 and canvas2d

- **Every pane presents canvas2d first**, then swaps to WebGL2 once the device qualifies (`rendering-platform`). A
  check of "the GPU path" must look after the swap.
- **WebGL2**: headless CfT with no flags uses the machine's real GPU where there is one (measured on macOS:
  `ANGLE Metal Renderer: Apple M4 Pro`).
- **canvas2d**: launch with `args: ['--disable-webgl']`. The audit then counts `context:unavailable:no-webgl2`
  and `pane:fallback:pane-2d:gpu-unavailable`, and the app shows its `gpu-unavailable` notice once.
- **Software WebGL2**: `--use-angle=swiftshader` gives a SwiftShader context; the app refuses it and runs canvas2d,
  counting `context:unavailable:software` and showing the `gpu-unavailable` notice once. A machine with no GPU
  (most CI and Linux containers) lands here by itself: say the WebGL2 path was not exercised.
- **Prove the backend, never assume it**: with the audit on, `window.__bmeRenderAudit.presents().records` carries
  `backend: 'webgl2' | 'canvas2d'` per present, and `snapshot().counters` every `fallback:` count. Record the
  renderer string (`WEBGL_debug_renderer_info` on a throwaway canvas): a software renderer (SwiftShader, llvmpipe,
  "Software"/"Basic Render Driver") is CPU work that looks like WebGL2 and is not GPU evidence.
- **DPR 2** needs a real scale: `args: ['--force-device-scale-factor=2', '--window-size=1200,887']` with
  `contextOptions: { viewport: null }`. An emulated `deviceScaleFactor` lands raw CDP input at half scale and makes a
  WebGL2 PDF pane draw only its top-left half in each direction (an artefact, not an app bug). A
  screenshot is in device pixels: a point picked from it is `x / scale` in CSS.
- Headless Chrome ticks a synthetic 60 Hz whatever the flags: judge per-frame cost against 8.33 ms, not cadence.
  Timing questions need an otherwise idle machine (`verify/lib/bench/`); everything else is proved by counters.

## Waiting for a settled picture

Do not sleep and hope. A board shows `[data-paint-state]` (`loading`, `pending` = "Updating…"/"Waiting for
memory…", `failed`) until its picture is current; a PDF shows `.pdf-tiled-updating` while tiles land. With the audit
on, wait until the present count stops moving (`presents().records.length`, or an init-script
`window.__bmePresentHook = info => …` that sees each present, canvas included), and check `slowFrames()` and the
`fallback:` counters for what happened on the way.

## Traps, each one cost a wrong verdict

- **OPFS, not disk.** The native picker cannot open headless; `installVault` stubs it with a NAMED OPFS folder
  (the OPFS root's name is `''`, which hides the vault name and disables Trash) and patches
  `queryPermission`/`requestPermission`. Install it (and `installCounters`) before the page; they skip opaque
  frames. Real-disk FSEvents and `.crswap` cannot be driven headless: say so rather than claim them.
- **Seed after `goto`**: `navigator.storage.getDirectory` is undefined on `about:blank`. OPFS is per context:
  re-seed every run.
- **Notes open in Reading mode**: press ⌘E (`input.mjs` `editMode`) before typing or caret checks.
- **Welcome screen**: up to two `.welcome-btn`s; match `{ name: 'Open Vault', exact: true }`, never a loose
  `'Open'`. `.vault-switcher` exists only once a vault is open.
- **Reload**: a `goto` that changes only the `#hash` does not reload; use `page.reload()` and prove it with a
  `window` marker. The pinned CfT survives stored-handle reloads natively; `reload.mjs`'s `idb-shim` arm (dev
  only) replaces structured cloning and then cannot test it. Record which arm you took.
- **Fonts**: `await document.fonts.ready` (`input.mjs` `fontsReady`) before a width or screenshot; KaTeX faces
  and a chosen Google text font re-fit tables when they land.
- **Async waits**: use `waitForVault`, never `page.waitForFunction(async …)` (a returned Promise is truthy at
  once). `readWitness` retries only `NotReadableError`; never retry `NotFoundError`.
- **Outside changes** are simulated from a separate `page.evaluate` with fresh OPFS handles (`outsideChange`);
  `handle.move()` gives real `moved` records, copy+delete does not. `delete window.FileSystemObserver` in an init
  script forces the polling fallback.
- **Context menus** are asserted (`defaultPrevented` on `contextmenu`), not screenshotted; tooltips are `.tooltip`
  after ~400 ms hover.
- **What the user sees**: read colour off the text node's own parent, not a wrapper (a CodeMirror mark wraps the
  highlighter's span), or look at the screenshot.
- **EPUB** runs must not use Playwright's `serviceWorkers: 'block'` (its blocker throws in the opaque frame).
- **Workers**: `targets.mjs` instruments dedicated workers via raw CDP (functional runs only); never read
  `WorkerLocation` before resume (it crashed CfT 157's renderer). See `verify/lib/TARGETS.md`.
- **Terminal** checks need the real helper (`npm run helper:dev`, `VAULTAGENT_TERMINAL_SHELL=/bin/sh`); type into
  `.xterm-helper-textarea` and assert through the shell's side effects (`integrated-terminal`).
- **Leave the machine as you found it**: stop your server when the run ends (`app.stop()` in a `finally`), never
  take a port another server holds (5173 is Vite's default, likely someone's dev server), and delete builds and
  screenshots in scratch once their evidence is no longer needed.

## Beyond the change

Be picky about what is on screen. Anything visibly wrong — misaligned, clipped, flickering, a stale notice — is
fixed or reported even when it is not what you were sent to do.
