---
name: verify-in-browser
description: How to check a change in the real app — there is no test suite, so verification is Playwright driving the production build in the pinned headless Chrome against an OPFS-stubbed vault. Covers the shared-machine lock, preparing and serving a build, seeding notes, boards and PDFs, opening documents, forcing and proving WebGL2 or canvas2d, DPR and themes, waiting for a settled picture, and the traps that make a working change look broken. Load before writing any browser script, before driving the app, and before claiming a change works.
---

# Checking a change in the real app

**There are no code-based tests** (AGENTS.md). `npm run typecheck` and `npm run lint` are the static gates;
everything behavioural is checked by driving the real app in headless Chrome. A change is not verified because it
typechecks. The bar for a change: reproduce the bug once the way a person meets it, fix, show it once more the same
way, and look at the screenshots (both themes if it draws; both backends if it renders). For a speed fix, one
before/after pair.

## The pinned toolchain

- **Driver**: `playwright@1.63.0` from the repo's own `node_modules`, never the npx cache.
- **Browser**: Chrome for Testing **157.0.8103.39** (`verify/browser-pin.json`), launched by path. The default path is
  `/Users/adham/Developer/bme-impl/scratch/browsers/<version>/<executable>`; `BME_CHROME_PATH` overrides it.
  `verify/lib/browser.mjs`'s `openBrowser` enforces both pins and gives a fresh context. Never use `channel:
  'chrome'` (installed Chrome updates itself mid-run) or the bundled Chromium (it crashed reading a stored folder
  handle on reload).
- **Toolbox** (`verify/lib/`, README there has every option): `serve.mjs` (`prepareApp`, `serveApp`),
  `browser.mjs`, `vault.mjs` (`installVault`, `seedVault`, `readVaultFile`, `readWitness`, `waitForVault`,
  `outsideChange`), `identity.mjs` (`bindServedBodies`), `counters.mjs`, `input.mjs`, `reload.mjs`,
  `fast.mjs` (`openDocument`, `treeRow`), `report.mjs`. Fixture generators are in `verify/fixtures/` (PDFs via
  `fixtures/lib/pdf.mjs`); generated files live in scratch, never in the repo.

## The shared machine (`bme-lock`)

On this machine every build, static check, server and browser run goes through
`/Users/adham/Developer/bme-impl/scratch/bin/bme-lock` (`build`, `static`, `serve`, `run [-w N]`; `status` shows
holders). It frees the grant when the command exits. **Never nest grants**: a script holding `run` must not build;
`prepareApp` refuses under `run`. Start slow commands in `hc run --bg` and `hc wait` them, wrap browser runs in a
hard `timeout 300`, stop your server when the run ends, use your own port with `--strictPort` (never 5173 or the
developer's 5199), and delete a build as soon as its evidence is no longer needed.

## Recipe

1. **Prepare** once per source change, under `build` — it writes a scratch Vite config, the production `dist`
   and a frozen identity (`prepared.json`) outside the worktree:
   `bme-lock build -- node prepare.mjs` with
   `await prepareApp({ root: WORKTREE, scratch: SCRATCH + '/app', mode: 'production' })`.
   Use `mode: 'dev'` only to exercise StrictMode; dev refuses to serve if HEAD or sources drifted since preparing.
2. **Run** under `run`: `bme-lock run -w 2 -- timeout 300 node check.mjs` (weight 2 for a PDF, a large board or
   several panes; 1 otherwise).

```js
const R = '/abs/path/to/worktree';
const { openBrowser } = await import(R + '/verify/lib/browser.mjs');
const { serveApp } = await import(R + '/verify/lib/serve.mjs');
const { bindServedBodies } = await import(R + '/verify/lib/identity.mjs');
const { installVault, seedVault } = await import(R + '/verify/lib/vault.mjs');
const { openDocument } = await import(R + '/verify/lib/fast.mjs');
const app = await serveApp({ root: R, scratch: SCRATCH + '/app', mode: 'production', build: false, port: PORT });
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
  await seedVault(page, { name: 'Fixture', files: { 'A.md': '# A\n', 'B.drawing': BOARD, 'P.pdf': pdfBytes } });
  await page.getByRole('button', { name: 'Open Vault', exact: true }).click();
  await openDocument(page, 'B.drawing');                              // waits for the pane's canvas
  // ... act as a person would, then screenshot and LOOK at it ...
  await binding.check();                                              // the served bytes were the prepared build
} finally { await run.close(); await app.stop(); }
```

**Fixtures.** Notes are text. A minimal native whiteboard is one text file (the app writes the full form itself on
save):

```
{"format":"board","version":[1,0],"kind":"whiteboard","fence":"compat-1: compatibility fence, holds no content, so that builds of this app from before the guard release refuse to edit this file","document":{"schema":{"schemaVersion":999},"store":{}},"records":[
{"type":"sheet","id":"Qm3vL8a0Zt","name":"Page 1","order":"a0"},
{"type":"end","count":1}
]}
```

Or make one as a person does: the file tree's **New drawing or notebook** button. PDFs: pdf-lib through
`verify/fixtures/lib/pdf.mjs`, or a small file kept in your scratch.

**Selectors.** File rows `.tree-item[data-path="…"]` (`treeRow`; names show without `.md`); the note editor
`.cm-content`; a board's surface `.board-viewer-surface`; a PDF's `.pdf-tiled-surface` (Original) or
`.pdf-reading-scroll` (Text); board tools are buttons named by tool (`getByRole('button', { name: /^Draw/ })`).

## WebGL2 and canvas2d

- **Every pane presents canvas2d first**, then swaps to WebGL2 once the device qualifies (`rendering-platform`). A
  check of "the GPU path" must look after the swap.
- **WebGL2**: headless CfT on this Mac with no flags uses the real GPU (`ANGLE Metal Renderer: Apple M4 Pro`).
- **canvas2d**: launch with `args: ['--disable-webgl']`. The audit then counts `context:unavailable:no-webgl2`
  and `pane:fallback:pane-2d:gpu-unavailable`, and the app shows its `gpu-unavailable` notice once.
- **Software WebGL2**: `--use-angle=swiftshader` gives a SwiftShader context; the app refuses it and runs canvas2d,
  counting `context:unavailable:software` and showing the `gpu-unavailable` notice once.
- **Prove the backend, never assume it**: with the audit on, `window.__bmeRenderAudit.presents().records` carries
  `backend: 'webgl2' | 'canvas2d'` per present, and `snapshot().counters` every `fallback:` count. Record the
  renderer string (`WEBGL_debug_renderer_info` on a throwaway canvas): a software renderer (SwiftShader, llvmpipe,
  "Software"/"Basic Render Driver") is CPU work that looks like WebGL2 and is not GPU evidence.
- **DPR 2** needs a real scale: `args: ['--force-device-scale-factor=2', '--window-size=1200,887']` with
  `contextOptions: { viewport: null }`. An emulated `deviceScaleFactor` lands raw CDP input at half scale. A
  screenshot is in device pixels: a point picked from it is `x / scale` in CSS.
- Headless Chrome ticks a synthetic 60 Hz whatever the flags: judge per-frame cost against 8.33 ms, not cadence.
  Time questions run alone (`run -w 8`, an exclusive slot); everything else is proved by counters.

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

## Beyond the change

Be picky about what is on screen. Anything visibly wrong — misaligned, clipped, flickering, a stale notice — is
fixed or reported even when it is not what you were sent to do.
