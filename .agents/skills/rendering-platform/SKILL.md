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
   `attachPlatformPane(host, options)`. Every pane **starts drawing on canvas2d**.
2. As soon as a frame has a drawable size, `requestGpu` asks the broker for a context, beside the first 2D picture —
   unless `backendPreference: 'canvas2d'`, which never asks. A GPU that qualifies before any picture was presented since
   the pane was shown draws the first picture itself (`shownPresented`, `presentGpu(…, first)`): asked only after the 2D
   picture, a dense board rastered every stroke on the CPU first (measured: 4–8.5 s of main thread). The broker grants one of `maxVisiblePaneContexts` (5)
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
  waiting on a bridge that could not fit the CPU pool left 'Updating' up for good. The GPU's next present on its own display
  gives back what a skipped bridge allocated (`Pane2DPresenter.holdsSurface`/`releaseSurface`, counted `bridge:released`): kept,
  three panes held 18.5 MB of `canvas-working`/`surface-scratch` at rest and the GPU pool never cooled.
  Only a pane whose own size changed is bridged: a backing change at the same size is a quality step, drawn at once from the
  GPU's kept tiles (`bridge:none:quality`); bridged, each raise rastered a dense board on the CPU, was refused, and stepped back down.
- A governor refusal of a resize is pressure, not a fallback: the pane keeps its picture and waits, sized
  (`SurfaceBackingOptions.wake`): a pane behind its 2D picture asks no frame of its own, so unwoken nothing retried it.
- Hiding zeroes the GPU canvas and stages its backing (`GpuPaneCandidate.zeroed`): shown again, the kept GPU rebuilds as
  scratch behind the 2D picture until `selectGpu` promotes it. Left 'displayed', the rebuild was charged as a second
  display, refused, and a PDF stayed on its blurred 2D picture for good after a tab switch.
- canvas2d's own display promotion (`select2D` → `SurfaceBacking.promote(true)`) is the floor and is never refused: its canvas
  is allocated and charged, the GPU display it replaces already zeroed, so a refusal freed nothing and ended the pane in
  "CPU backing promotion was refused". A pool it leaves over target is pressure (`promote-floor:over-target`). No pane ever
  ends in an error for memory a neighbour holds or for a resize: it waits, or degrades visibly.
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
  `drawTexturedQuad(s)` take source texels including gutters and a device-pixel destination, on either backend; in an
  offscreen pass the destination is that pass's pixels (mapped against the surface, a CPU raster laid into a tile shrank).
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
  frame. A layer is acknowledged under the token of the frame it DREW in: canvas2d's inverted picture is drawn band by band
  over several frames, so its composite names that frame per layer (`PresentedLayerRevision.token`), and that job's own
  `2d-*` continuation frames never supersede it (`compositor2d.ts` `encode`). Budget deferrals requeue; external waits wake on completion or a real deadline, never by polling frames.
- **Camera motion is the scheduler's.** `glideTo(target, ms)` is on `PlatformPane` and on the `ScheduledPaneLease`:
  the scheduler's own frame loop moves the camera, and each glide cancels the one before it. `animatePan(delta)` is a
  glide of a pan delta over `GLIDE_MS` (320 ms; the board's Space+arrow paging and its pan use it). Reduced motion, a
  zero duration or a pane that cannot run frames jump at once, so a caller's move (back to content, the minimap)
  still lands. `startFling` and `cancelMotion` are wired the same way (`scheduler.ts`, `attachPlatformPane.ts`).
- Background work (two-phase layers' second call) gets the upload window (1 ms) while anyone interacts, and up to half
  the interval on a quiet frame (`QUIET_BACKGROUND_FRACTION`): held to 1 ms at rest, a dense board's tiles took 20–50 s. The
  window is its floor even in a frame the foreground and the present reserve overran: on a GPU slow enough that presenting takes
  longer than the interval, background work never advanced ('Updating…' for good after a dense zoom to fit).
  A background call passed over for time asks no next frame when the layer says that frame is finished
  (`Layer.backgroundOwed`): the board's bands share one composer, and that mark kept a heavy settling board framing at rest.
  Never read it from `needsFrame`: a composer waiting on a denied part answers false with its draw list still owed.
- An offscreen-only encode that recorded no pass settles its layers as submitted (`offscreenSettled(true)`): told
  "discarded", the board composer asked for the next frame forever at rest. At rest a settled pane runs 0 frames.
- Ask for a frame only for a cause. With the audit on, each present is named `present:<cause>` (`input`, `camera`,
  `wake`, `invalidate:<reason>`, `needsFrame:<layer>`); `none` is a fault. A frame whose picture is unchanged is named
  `skipped:<cause>`: a pane framing at rest with nothing to present shows up only there.
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
- A pane's quality ceiling falls only when the plan grants fewer pixels than the pane asked for at its ceiling (the ask is
  rounded down): taken on rounding, ceilings stuck at 0.99999…, the governor stayed "below full" at quality 1 and ran a recovery
  trim on every charge change (422 per 10 s at rest). `caches().grants` gives each pane's `pixelGrant` and `qualityScale`.
  A lowered pane ceiling arms the recovery wake like a lowered app quality (the state reads 'normal' with ceilings below 1).
  `paneNeedWaiting` counts the asking cache too: a ring's prefetch took the room a parked visible tile of its own pane waited for.
- CPU target: `8 MB·N + 12 B·devicePixels`, raised to `Σ visible cpuMandatoryBytes / 0.8` (the trim line, so a trim never
  cuts into a floor), floor 32 MB, inside the device ceiling. Without it one DPR 2 PDF was refused its own floor.
- **The CPU floor invariant** (what keeps a pane from waiting forever): every visible pane's floor (`cpuMandatoryBytes`, what it
  must hold to present at its current quality, declared before it allocates) is grantable, because the target covers Σ floors /
  0.8 inside the device ceiling; everything a pane holds above its floor is reclaimable, either admitted as `prefetch` or given
  back by its owner before its own refusal counts as pressure (`quiet`, shed, then a normal ask). Bytes that are neither are how
  a pool fills with nothing that can give way, and the next floor request then waits for good. Check it at rest:
  `__bmeRenderAudit.caches()` — `hiddenPanes` is `{ cpu: 0, gpu: 0 }` (a hidden pane's charge is outside every floor, see
  below) and each visible pane's charge is within its `panes[].cpuNeedBytes`. A waiter at rest is not itself a fault:
  `caches[].waiting` gives each one's size (null: any release wakes it; caches holding no bytes are not listed). Known: a
  canvas2d board whose direct-frame estimate exceeds the whole pool (refused without pressure, it draws dense tiles instead)
  leaves a sized wait it can never meet (measured 2.04 GB, a 3 MB `.tldraw`), and its `awaitCpu` latch then parks no later wait.
  A floor that grows with a request (a whole-frame estimate) is re-collected (`refreshDemandNow`) BEFORE that reserve: asked
  against the old grant, the refusal is pool pressure and steps quality (S2000 canvas2d: degraded for good, a raise/drop every
  5 s). `caches().recovery` and the `governor:degrade:*` counters say why a quality has not stepped back up
  (`degrade:unmet:<pool>` names the pool a pressure trim could not bring under its target).
- `ReserveOptions.quiet`: a first ask the owner can answer from its own idle residency; a refusal is not pressure.
- `prefetch` stops at the trim target on the CPU (always) and on the GPU while quality is down: under each pool's cool line, so
  caches admitted ahead of need never hold the pool off cool (stuck 'trimming', quality never stepping back up).
- Pressure is app-wide: refusals trim before quality (`q`) drops; recovery waits for sustained low use and no
  gesture. `trouble()` gives a layer `'slow-gpu'` (timing, never memory: shed per-frame work) or `'pressure'`.
- A cache filling its budget is not a leak: it must plateau under the target and give back everything above the view
  and its ring on a forced trim (`__bmeRenderAudit.trim('gpu')`).
- **A hidden pane holds no working memory, in either pool.** Hide releases every texture, target and buffer in the same task
  (each layer's `releaseGpu('hidden')`, which also gives back the CPU it charged: the board's dense session tiles), then the
  governor asks every other cache of the pane for all it holds (`releaseHiddenPane`, on the pane's visible→hidden demand; a
  layer's `cpuEvict` on a hidden pane keeps nothing). Kept: the broker's context/program reserve and the session mirrors
  (`HIDDEN_KEPT_KINDS`; mirrors belong to the App document session and have their own hidden budget; unmount returns a borrow).
  A kept context's 4 MB is planned off the top of every grant, so a visible pane refused at its own GPU grant revokes hidden
  panes' contexts, oldest first (`revokeHiddenContextsFor`, `governor:reclaim:gpu:hidden-contexts`): ten tabs' contexts took
  28 of a 71 MB pool and the visible board's first visit waited on 17 MB for good.
  A hidden pane's caches are the first any trim takes (`hidden-pane` class). Why: the CPU target counts visible floors only,
  so whatever a hidden pane keeps is room no floor can get (seven hidden dense tabs held 32.1 of 33.6 MB, and every board shown
  after them waited for memory for good). Counted `governor:hidden-release:<pool>` (bytes given back) and
  `governor:hidden-kept:cpu:<cache>` (still held right after the ask; a frame a draw borrows goes a moment later). A hide
  during a trim is deferred to the trim's end (`governor:hidden-release:deferred`), never dropped. Check:
  `caches().hiddenPanes` is `{ cpu: 0, gpu: 0 }` at rest (GPU once its retirement completes).
- Report worker WASM estimates with `reportWorkerMemory` and `releaseWorkerMemory` on stop/crash, and a model derived from an
  open document (a board's stroke geometry) with `reportDerivedModel(owner, bytes)`: both are readout-only, beside the raster
  pools whose ceilings (64/128/256 MB; Chrome caps `deviceMemory` at 8, so 128 MB) are sized for tiles, not documents.

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
- **State stays between the draws of one replay**: a draw marks the device dirty and the baseline (`#reset`, ~45 GL calls)
  is restored once, before a raw write (`gl()`) or at `endReplay` (a thrown replay too). Reset per draw, a settling dense
  notebook spent 55 of 90 s in `#reset`. Buffer creation reads its size back once per device, never per buffer.
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
- Every worker starts through `platform/workers/script.ts` `workerScript(url, { keep })`, its URL from a `?worker&url`
  import (lint bans `Worker` as a value in `src/`). `keep: true` fetches the script once (on the page: at idle when its
  code loads; inside a worker: at its first start) and starts every copy from those bytes, so an open board, PDF or book
  keeps working after a deploy 404s this build's files. Only a script that needs nothing from its own URL can be kept
  (`build/selfContainedWorkers.ts` marks its first and last bytes from the bundle; unmarked, it starts from the
  network). A body cut short is not kept; a kept copy that fails to load is dropped and that script (every script, when
  blob workers are refused) starts from the network after it. A start that fails says why through a `ChunkLoadError` as
  the error's `cause`: `gone` (`isAppReplaced`) gets `PartFailure`'s Reload, `unreachable`/`timeout` a Retry that works.
  A raw client calls `startFailure`/`dropKeptCopy` on an error before the worker's first answer.

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
