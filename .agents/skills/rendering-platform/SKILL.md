---
name: rendering-platform
description: The shared rendering platform under src/platform/render — how a pane is attached and picks WebGL2 or canvas2d, the Layer and LayerHost contracts, the scheduler and presents, the memory governor and leases, the WebGL2 frame-path rules, capture, the import zones, and the render audit. Load before changing anything in src/platform/render (gfx/ included), writing or changing a PDF, notebook or whiteboard layer, or writing a browser kit that measures rendering.
---

# Rendering platform

`src/platform/render/` is one app-wide compositor shared by every PDF, notebook and whiteboard pane. It is
demand-driven and owns no document truth: layers draw the session's CPU truth, and everything on the GPU is a
rebuildable cache of it. The board's own route is in `board-gpu-path`; PDF tiles and documents in
`pdf-and-drawings`. The code and its comments are the design record.

## Map

| File | What it owns |
|---|---|
| `cpuEntry.ts` | The lazy entry: registers the canvas2d factory and re-exports `attachPlatformPane`. |
| `attachPlatformPane.ts` | One pane's attach actor: backend choice, the canvas2d→GPU swap, the resize bridge, metrics, trims. |
| `gpuPaneCandidate.ts` | A pane's WebGL2 candidate: prepare, ready, draw-time errors and their retry/latch. |
| `surfaceBroker.ts` | The only code that creates, counts and recovers WebGL2 contexts; the loss circuit. |
| `paneLifecycle.ts`, `backendSwitch.ts` | Visibility, hide/show, `releaseGpu`, which compositor is on screen. |
| `scheduler.ts` | The one app-wide rAF loop: prepare, encode, present for every visible pane. |
| `compositor.ts` / `compositor2d.ts` | The WebGL2 and canvas2d compositors behind one `PaneCompositor`. |
| `gfx/webgl2*.ts` | The WebGL2 device (`gfx/api.ts` is its backend-neutral interface), frames, pools, coverage. |
| `memoryGovernor.ts`, `resourceArena.ts` | Grants, leases, pressure, trims, quality steps. |
| `capture*.ts` | Session-owned capture (thumbnails, PNG/PDF export from a pane). |
| `mirrorSet.ts`, `mirrorBridge.ts` | Session-owned CPU mirrors that outlive panes. |
| `camera.ts`, `pageStack.ts`, `compositorProjection.ts` | Camera, paged layout, `pagePresentation`/`projectPage`. |
| `renderAudit.ts` | `window.__bmeRenderAudit`, off unless `localStorage['bme.renderAudit']='1'`. |
| `../renderStatus.ts` | The app-wide render notices (pinned, reduced quality). |

Constants are in `types.ts` (`RenderConstants`, documented per field) with values in `constants.ts`.

## How a pane gets its backend

1. A React host calls `usePlatformPane` (`components/platformPane/`), which `import()`s `cpuEntry` and calls
   `attachPlatformPane(host, options)`. Every pane **starts on canvas2d**: the first picture is always the 2D
   compositor's.
2. Only after that first CPU picture presents (`cpuPresented`) does `requestGpu` ask the broker for a context —
   unless `backendPreference: 'canvas2d'`, which never asks. The broker grants one of `maxVisiblePaneContexts` (5)
   visible-pane contexts (8 app contexts, 1 always reserved for the terminal even when closed). A sixth visible pane
   stays on canvas2d and upgrades when a slot frees (`onSlotAvailable`); it never evicts a visible neighbour.
3. The broker creates the context with `RENDER_CONSTANTS.contextAttributes` (`powerPreference: 'high-performance'`,
   so a dual-GPU machine gets its discrete GPU, see `constants.ts`; `failIfMajorPerformanceCaveat: true`; no
   antialias/depth/stencil). It refuses a
   **software** context (`softwareRenderer`: the unmasked renderer matches SwiftShader, llvmpipe, softpipe, lavapipe,
   Basic Render Driver, WARP or "software"), at each build and each restore: measured, Chrome 157 with
   `--use-angle=swiftshader` hands out SwiftShader despite `failIfMajorPerformanceCaveat`. Then the device qualifies
   once (`#qualify` in `gfx/webgl2.ts`: a capability shader and a 2x2 readback), and the GPU compositor is staged and
   swapped in (`onReady` → `surfaceHost.stage`).
4. A pane that gets no usable context asks `deviceGpu()` (a probe with the real attributes, then a plain one):
   `'no-webgl2'`, `'software'`, or null (the GPU is fine, this pane just got none). No usable GPU, or a qualification
   that answers `unsupported`, fails the pane as `gpu-unavailable`: counted `context:unavailable:<cause>` and
   `pane:fallback:pane-2d:gpu-unavailable`, never capability pressure and never retried (the device will not change).
   Measured (gpu-h13): reported as pressure, every quality raise dropped quality again.
5. Failures a visible pane recovers from by itself (`requalifies()`: `restore-timeout`, `creation-failed`,
   `out-of-budget`, `pressure`) re-qualify with a fresh context on a back-off of 5 s doubling to 60 s
   (`armRequalify`). Before, a refused promotion at one zoom kept a document on canvas2d until it was hidden and shown.

**Fallbacks, each counted under `fallback:` in the audit** (`pane:` surface):
- A draw-time GPU error demotes the pane (`fallback:pane-2d:gpu-error:<code>`), retried once after
  `GPU_RETRY_QUIET_MS` (1 s) without input; the second error of the attach latches canvas2d
  (`gpu-error-latched`).
- Three context losses in 60 s pin the pane's session on canvas2d (`cpu-pinned`, `reportRenderPinned` notice).
- A resize of a displayed GL canvas is bridged by a detached CPU picture while the same GPU rebuilds
  (`fallback:2d-bridge`, with its pixel count). A bridge that cannot present within `BRIDGE_WAIT_MS` (300 ms) is
  skipped (`fallback:2d-bridge-skipped`): the GPU resizes directly and draws from the textures it kept. Measured:
  waiting on a bridge that could not fit the CPU pool left 'Updating' up for good.
- A governor refusal of a resize is pressure, not a fallback: the pane keeps its picture and waits, sized
  (`SurfaceBackingOptions.wake`): a pane behind its 2D picture asks no frame of its own, so unwoken nothing retried it.
- Hiding zeroes the GPU canvas and stages its backing (`GpuPaneCandidate.zeroed`): shown again, the kept GPU rebuilds as
  scratch behind the 2D picture until `selectGpu` promotes it. Left 'displayed', the rebuild was charged as a second
  display, refused, and a PDF stayed on its blurred 2D picture for good after a tab switch.
- **The person is told** when a pane really runs on canvas2d: `SurfaceCallbacks.onGpuUnavailable(cause)` →
  `options.onNotice('gpu-unavailable', cause)`, cause `no-webgl2 | software | unsupported | gpu-error`, text from
  `gpuUnavailableText` (`platform/renderStatus.ts`). Device causes show once per app session, `gpu-error` (the
  second-error latch) once per document session; never for a bridge, memory or a context loss. A budget fallback
  (`fallback:budget`, no GPU slot) that lasts 1 s raises cause `too-many-panes`, withdrawn through
  `PlatformPaneOptions.onNoticeCleared` at the pane's first GPU frame (unreachable today: the layout stops at five
  panes and the broker gives five visible panes a GPU). Other pane
  notices: `memory-pressure`, `cpu-floor-denied`, `cpu-pinned`. All appear in the app's own UI, never a native
  dialog.
- **Memory notices come from the pane's own grant, never the governor's state** (`PlatformRuntime.reconcileMemoryNotices`):
  `memory-pressure` when that pane's `qualityScale < 1`, `cpu-floor-denied` when its grant is under its
  `cpuMandatoryBytes`, each raised once it has lasted `memoryNoticeDelayMs` (1 s) and withdrawn via `onNoticeCleared`
  when it ends. `trimming` is cache eviction and is silent: announced, every DPR 2 PDF said "quality was reduced" ~1 s
  after opening with every grant at 1, on whichever pane had focus. The status line no longer repeats it.

canvas2d is a complete path, not a placeholder: a machine without a usable GPU runs everything on it, and it never
draws differently because a GPU exists.

## The Layer contract (`types.ts`, `compositor.types.ts`)

- A pane is a set of `PlatformLayerDefinition`s; each creates a `Layer` and borrows a stable `LayerHost`. The pane
  lifecycle owns layers; compositors borrow them and never dispose them.
- Every layer implements BOTH `drawGpu` and a full `draw2d`. Optional GPU hooks: `encodeOffscreen` (draw into the
  layer's own targets before the surface pass), `evictGpu`, `protectFrame`, `atlas`, `twoPhase`, `idle`.
- **Never own an rAF loop.** Ask with `host.invalidate(reason)` for input or ready async data, `host.wakeAt(ms)` for
  a real deadline (`wakeAt(null)` cancels). `needsFrame()` is true only for executable work: waiting on a worker is
  false (the worker's completion invalidates).
- `prepare(view, budget)` does bounded, resumable work: respect `budget.shouldYield()` and `claimUpload(bytes)`;
  create and upload resources only here, never in `drawGpu`/`encodeOffscreen`. Return `false` only when nothing the
  layer draws can differ from its last present; any other answer means changed. A layer the budget skipped counts
  as changed. Because an all-unchanged frame skips encode and submit (`presentUnchanged`), every change a layer
  draws, its chrome included, must be counted or it is hidden.
- Compare what the layer draws (camera, viewport, picture key), **never the view epoch**: the epoch also moves when
  `moving` flips with the camera still. Keyed on it, the PDF answered changed over the same picture and the board
  showed 'Updating…' at rest for good.
- `host.device()` is the GPU preparing this frame, or null; it is null during the first CPU picture and a resize
  bridge even when a candidate exists. Re-read it after a backend or `generation` change. Never import the broker or
  native GL into a layer.
- `host.uniforms(bytes)` / `uniformsInto` are valid only during `drawGpu` (the encoder's fenced ring).
  `drawTexturedQuad(s)` take source texels including gutters and a device-pixel destination, on either backend.
  `paintWorld`/`paintPage` install the common transform and page clip for 2D. `host.imageReady(image)` (2D) says
  whether a draw needs an upload not admitted this frame: draw a stand-in instead, because a canvas2d frame that
  misses an image is not presented at all.
- `host.markIncomplete(reason)` during encode: a critical layer's frame is refused (the old picture stays), others
  present incomplete. `host.reportGpuError(e)` routes a device error to the pane's demotion path.
- `releaseGpu(reason)` is the only GPU teardown: idempotent, never touches CPU truth, undo or session mirrors.
  `evictGpu(bytes, frameId)` is the governor's partial trim: free least-recently-used, never what `frameId` uses,
  return bytes freed. A layer with `evictGpu` is never released whole by a trim; one without it is released whole
  only when its pane was not touched this frame (`trimGpu`).
- `memory()` is cheap byte accounting called every frame.

## Frames and presents

- All layers of all visible panes consume one frozen view per frame. Check the full `RenderToken`/`FrameToken`
  (vault epoch, document id, bytes generation, session; plus view lease and device generation) at every async
  publication: a stale worker reply, a disposed lease or a prior device's resource must never touch the current view.
- Rest snapping (`snapCamera`) is presentation only; never write it back into the semantic camera (that advanced the
  epoch every frame and cancelled CPU colour jobs forever). Use `pagePresentation`/`projectPage` for paint, overlays
  and measurement alike.
- `encode`/`submit` may return null: never acknowledge a present or advance overlays without a complete current
  frame. Budget deferrals requeue; external waits wake on completion or a real deadline, never by polling frames.
- **Camera motion is the scheduler's.** `glideTo(target, ms)` is on `PlatformPane` and on the `ScheduledPaneLease`:
  the scheduler's own frame loop moves the camera, and each glide cancels the one before it. `animatePan(delta)` is a
  glide of a pan delta over `GLIDE_MS` (320 ms; the board's Space+arrow paging and its pan use it). Reduced motion, a
  zero duration or a pane that cannot run frames jump at once, so a caller's move (back to content, the minimap)
  still lands. `startFling` and `cancelMotion` are wired the same way (`scheduler.ts`, `attachPlatformPane.ts`).
- Ask for a frame only for a cause. With the audit on, each present is named `present:<cause>` (`input`, `camera`,
  `wake`, `invalidate:<reason>`, `needsFrame:<layer>`); `none` is a fault.
- A layer passed over by the budget counts as changed. A layer's class (critical/optional) is read once as its
  prepare starts.
- Page, committed ink and live stroke compose as ONE document-colour group, inverted once in dark view; chrome and
  selection stay outside it. Capture/export bypasses view inversion.

## Memory

- Every GPU and CPU raster byte is a lease from the host allocators (`host.allocator.gpu/cpu.reserve`). A refused
  reservation means defer or draw lower quality, never an unaccounted allocation; return a lease to the allocator
  that issued it. GPU retirement stays charged until it completes.
- A resource shared by several layers' kits (the area and path coverage scratches, one per device) is published
  by exactly one layer: the one whose allocator holds its charge. When that layer lets go, the charge is reserved
  on another holder before it is returned (`rehome`); a report that moves without its lease is logged as
  "GPU accounting … published … against … reserved" and charged twice.
- GPU target (`memoryGovernor.ts`, `updatePanes`): `base + perPane·N + 24 B·devicePixels`, floor 64 MB, inside the
  device class ceiling (128/256/512 MB by `navigator.deviceMemory`); fixed terms scale by the largest visible
  `min(DPR,2)²`. Unscaled, a small DPR 2 pane sat at the floor and never drew again after a saturated zoom.
- Grants: a visible pane's pinned positions (`gpuPinnedBytes`) first and never trimmed while visible; the rest by
  focus weight (2:1). A position past its pane's share is composed one level down, never trimmed from the screen.
- CPU target: `8 MB·N + 12 B·devicePixels`, raised to `Σ visible cpuMandatoryBytes / 0.8` (the trim line, so a trim never
  cuts into a floor), floor 32 MB, inside the device ceiling. Without it one DPR 2 PDF was refused its own floor.
- **The CPU floor invariant** (what keeps a pane from waiting forever): every visible pane's floor (`cpuMandatoryBytes`, what it
  must hold to present at its current quality, declared before it allocates) is grantable, because the target covers Σ floors /
  0.8 inside the device ceiling; everything a pane holds above its floor is reclaimable, either admitted as `prefetch` or given
  back by its owner before its own refusal counts as pressure (`quiet`, shed, then a normal ask). Bytes that are neither are how
  a pool fills with nothing that can give way, and the next floor request then waits for good. Check it at rest:
  `__bmeRenderAudit.caches()` — no cache holds a waiter, and each pane's charge is within its `panes[].cpuNeedBytes`.
  A floor that grows with a request (a whole-frame estimate) is re-collected (`refreshDemandNow`) BEFORE that reserve: asked
  against the old grant, the refusal is pool pressure and steps quality (S2000 canvas2d: degraded for good, a raise/drop every
  5 s). `caches().recovery` and the `governor:degrade:*` counters say why a quality has not stepped back up.
- `ReserveOptions.quiet`: a first ask the owner can answer from its own idle residency; a refusal is not pressure.
- `prefetch` stops at the trim target on the CPU (always) and on the GPU while quality is down: under each pool's cool line, so
  caches admitted ahead of need never hold the pool off cool (stuck 'trimming', quality never stepping back up).
- Pressure is app-wide: refusals trim before quality (`q`) drops; recovery waits for sustained low use and no
  gesture. `trouble()` gives a layer `'slow-gpu'` (timing, never memory: shed per-frame work) or `'pressure'`.
- A cache filling its budget is not a leak: it must plateau under the target and give back everything above the view
  and its ring on a forced trim (`__bmeRenderAudit.trim('gpu')`).
- **A hidden pane holds no GPU working memory**: hide releases every texture, target and buffer in the same task;
  only the broker's context/program reserve survives. Session mirrors (`mirrorSet.ts`) belong to the App document
  session, not the pane; unmount returns a borrow. Report worker WASM estimates with `reportWorkerMemory` and
  `releaseWorkerMemory` on stop/crash.

## WebGL2 frame-path rules

- **A frame survives only two refusals**: a full uniform ring (`ArenaError 'out-of-budget'`) and an isolation
  shortfall (`guardIsolation`, an unplanned clip/group target). Any other throw cancels the whole frame and every
  pass recorded before it: work that changed state (an atlas conversion) must not be counted done before submit. A frame
  whose offscreen passes were recorded can still be discarded (a critical draw the uniform ring refused, a later throw, a pane
  gone before submit): `Layer.offscreenSettled(submitted)` says which, once per frame, and a layer takes back what it counted
  (`tileComposer` drops the tiles it marked composed; the text route converts its cells again; measured: 7–9 discarded
  conversions per dense notebook load). A load of a target the layer cannot prove stored asks `orClear`, decided by the device
  from what it stored; a plain load of an unstored target fails the frame (`invalid-input`, audit site `pass:load`).
- **No synchronous GL read on the frame path**: `getError`, `checkFramebufferStatus`, `getParameter`,
  `readPixels`, `getBufferSubData`, a blocking `clientWaitSync` each wait for the GPU process (measured: 17–24 ms
  per LARGE drag start/release from one `checkFramebufferStatus`). They belong at device creation, once per kind of
  target, in capture/export, or behind `__BME_BENCH__`. Fence and query polls stay non-blocking.
- Nothing unchanged is redone and nothing per frame is allocated: no re-raster, re-tessellation, re-upload, per-frame
  string keys or snapshot arrays. On a tiled GPU the cost is render-target switches (`gpu:target-switch`).
- Mask clips and groups need isolation targets planned in prepare (`host.reserveIsolation`).
- **Uploads belong in prepare.** A route's `uploadPrepared()` (`render/gpu/contracts.ts`) runs at the end of every
  prepare, because a device refuses `writeBuffer`/`writeTexture` once a pass is recorded in the frame, and
  `encodeOffscreen` runs after the earlier layers' passes. Anything staged after that upload is a composer bug and
  fails the frame (`routeText.ts`, "staged after its upload"), never a silent draw from rows that lack it.
- Audit-on builds share pipelines per device exactly as production does (`PerDeviceMap`, `auditViewTarget` in
  `renderAudit.ts`); a per-layer copy measures the kit, not the product.

## Capture

- Capture belongs to the session (`captureRuntime.ts`), one queue for all panes (`CaptureQueue`). It uses an idle
  GPU route only when its token matches the snapshot and the scheduler runs; otherwise CPU. Retain content
  synchronously before awaiting; copy the plan's isolation getter AFTER `prepare`.
- `captureBlob` encodes PNG from the same CPU capture target, no second repaint or context. Abort rejects promptly
  but keeps the slot until native encoding settles.
- PDF+ink compose through `PdfInkBackdrop.captureSnapshot` (`pdf/session/inkBackdrop.types.ts`) under ONE parent
  capture, never nested queued `captureRegion` calls: two parents hold both slots and deadlock.

## Boundaries (lint-enforced, `bme/import-zones` in `eslint.config.ts`)

- `src/platform` imports nothing app-specific (no utils, types, whiteboard, pdf, epub); `src/platform`,
  `src/whiteboard` and `src/pdf` import no React and no context/editor/components/App.
- The engines are a **dark zone**: a file outside them that imports them must be listed in `darkExcept` (reached only
  through a lazy chunk) or `darkLazy` (dynamic/type-only imports). Adding an importer is a bundle decision; see
  `pdf-and-drawings` for the lazy routes. No `tldraw`/`perfect-freehand` in the engines.
- The terminal's context reservation goes through the import-free telemetry seam (`platform/terminalContext.ts`);
  never import xterm to count it.

## Audit, benchmark build, kits

- `localStorage['bme.renderAudit']='1'` before load turns on `window.__bmeRenderAudit`: `snapshot()` (counters
  `surface:event`, frames, stages with `sum/count/max/over8`), `presents()` (each present with its cause and every
  layer's reason tape), `slowFrames()`, `gauges()`, `scenes()` (board scene for fidelity kits), `gpuErrors()`,
  `arenaErrors()`, `trim(pool)`, `reset()`. Off, every call is one boolean test.
- `__BME_BENCH__` is true only in `vite build --mode benchmark` (production plus hooks); dev esbuild binds it false
  before dead-code elimination. Benchmark-only code (CPU coverage witnesses, `Layer.benchmarkRaster`,
  `benchmarkDomain`) sits behind it and must never become a dependency of normal rendering.
- Kit traps, each measured: headless Chrome ticks a synthetic 60 Hz whatever the flags (judge per-frame cost against
  8.33 ms, not cadence); DPR > 1 needs a real `--force-device-scale-factor` with `viewport: null` (an emulated
  `deviceScaleFactor` lands raw CDP input at half scale); a screenshot is in device pixels. How to run the app and
  force each backend is in `verify-in-browser`.
