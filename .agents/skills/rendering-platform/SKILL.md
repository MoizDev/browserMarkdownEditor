---
name: rendering-platform
description: Shared rendering platform and layer contracts, the WebGL2 backend and its frame-path rules, and the render audit. Load before changing src/platform/render (gfx/webgl2.ts included), implementing a PDF, notebook or whiteboard rendering layer, or writing a browser kit that measures rendering.
---

# Rendering platform

The design authority is `planning/40-platform/contracts.md` C4, C7 and
`planning/40-platform/rendering-design.md` §§3–7, 10, 16 (planning lives in the main checkout).
The platform is a shared, demand-driven compositor, not a document engine or another source of truth.

## Layer and lifecycle

- Implement `Layer` in `src/platform/render/types.ts`; create it through a pane's
  `PlatformLayerDefinition` and borrow the stable `LayerHost` in `compositor.types.ts`. A layer
  supplies both `drawGpu` and the complete `draw2d` path, including normal, hidden-show and loss
  fallback; 2D is not a placeholder. Compositors borrow layers; the pane lifecycle owns them.
- `PlatformPaneOptions.backendPreference: 'canvas2d'` fixes an attachment to CPU without requesting a
  GPU context; omitted/`'auto'` permits normal qualification. An optional `camera` shares the same
  `CameraController` instance with the pane scheduler; otherwise attachment creates its own.
- A layer never owns an rAF loop. Call `host.invalidate(reason)` on input or ready async data and
  `host.wakeAt(deadline)` for real delayed work, cancel with `wakeAt(null)`. `needsFrame()` is false
  while merely waiting on a worker. The app-wide scheduler coalesces visible panes and sleeps when
  idle (design §7.1). Import `cpuEntry` from the lazy pane route to register the 2D factory before
  attaching; registration itself allocates nothing.
- `releaseGpu(reason)` is the only GPU teardown route; it is idempotent and does not destroy CPU
  document truth, undo or session-owned mirrors. Only the pane lifecycle calls it and final
  `dispose()`; a compositor never disposes borrowed layers. On hide, synchronously release all GPU
  textures, targets, buffers and drawing backing in the same task; a broker may keep only the
  separately accounted context/program reserve. Hidden panes have no GPU working memory
  (C4.3–C4.4, design §3.3).
- `evictGpu(bytes, frameId)` is the governor's partial trim: it returns the bytes it freed and keeps what frame `frameId`
  uses. A layer with the hook is never released whole by the trim (`trimGpu` in `attachPlatformPane.ts`); one without it is
  released whole only when its pane was not touched this frame. Board and paper details: `board-gpu-path`.
- GPU resources are rebuildable caches of session CPU truth. Mirrors and their leases belong to the
  app-level document session, not to a pane/layer; unmount returns a borrow, not the bitmap owner.
  Source reload/session closure, not a path rename or graph trip, ends their ownership (design §6.4).

## Frames, budgets and drawing

- All layers consume the same frozen view/frame. `RenderToken` carries vault epoch, document id,
  bytes generation and session; `FrameToken` also carries view lease and device generation. Check
  the full relevant token, revision and ownership at async publication; stale worker responses,
  disposed leases and prior-device resources must never update the current view (C7, design §7.1).
  Rest snapping is presentation only: never write its correction back into the semantic camera.
  That advanced the epoch every frame and cancelled CPU colour jobs forever; use the common
  `pagePresentation`/`projectPage` for paint, overlays and measurement geometry.
- Split `prepare(view, budget)` into bounded resumable work, respect `shouldYield()` and
  `claimUpload(bytes)` and never perform resource creation or uploads inside draw. Use the host's
  canonical CPU/GPU allocators; a failed `reserve` means defer or use a lower-quality/2D path, not
  an unaccounted allocation. Return the same lease to the allocator that issued it; GPU retirement
  remains charged until complete (C4.3, design §§5.6, 6, 7.1).
- `host.device()` describes the GPU resources available to the preparing compositor, not a promise
  about the displayed backend; it can be null. A qualified candidate is not the preparing device
  during the first CPU picture or resize bridge. Reacquire it after backend/generation changes, and never import the
  broker or native GL into a layer. `host.uniforms(bytes)` is valid only during `drawGpu` and uses
  the current encoder's fenced ring. `host.drawTexturedQuad` takes source texels including real
  gutters and a device-pixel destination for either backend. `host.paintWorld` and `host.paintPage`
  install the common transform and page clip for 2D; start from the supplied device-identity context
  (C4.2–C4.3, design §4.1).
- `encode` and `submit` can return null: do not acknowledge presentation or advance overlays without
  a complete current frame. Requeue budget/deadline deferrals and null submit; a worker or other
  external wait instead wakes on completion or a real deadline, never by polling frames.
  Regular and mirror CPU attempts share ONE canonical scene key for pending source admissions;
  their back-buffer/presentation keys remain separate. Different pending keys made both attempts
  evict each other's admitted images forever before the first frame, despite complete PDF tiles.
- Compose page, committed ink and live stroke as one document-colour group; invert that group once,
  not each translucent element. Chrome/selection remains outside it. Capture/export bypasses view
  inversion (C2.5, design §4.2).
- Pressure is app-wide: allocation refusal and device trouble trim before reducing `q`; recovery
  waits for sustained low usage and no gesture. Never bypass a denied reservation. Report worker
  owned/WASM byte estimates (not real JS heap or bytes already leased) with
  `reportWorkerMemory(worker, bytes)`; `releaseWorkerMemory(worker)` on stop/crash/recycle.
  Both are lazy render exports keyed by the actual worker incarnation; these estimates are
  report-only, separate from the decoded-raster CPU budget C (design §6.2; worker-host §5.8).
- Governor grants (`memoryGovernor.ts`, `plan`): a pane's pinned visible positions (`gpuPinnedBytes`) are granted first and
  never trimmed while the pane is visible; the rest of the GPU share is split by focus weight. A visible position past its
  pane's share is refused and composed one level down, never trimmed from the screen. Only `maxVisiblePaneContexts` panes
  get a GPU context; a sixth keeps its 2D picture and its floor.
- A slow GPU is timing evidence, not memory. `trouble()` reports `slow-gpu` for a hold after the window; it never trims a
  cache or steps quality. Layers shed per-frame work instead (the board halves its compose limit).
- Capture belongs to the session: select an idle GPU route only if its full document/session token
  matches the immutable snapshot and the scheduler is running/not suspended, otherwise use CPU.
  Retain content/resources synchronously before awaiting. Async `prepare` may publish the frozen
  plan's isolation getter; copy it AFTER prepare, never spread its initial empty value or reuse the
  live viewport inventory. Preserve the getter when composing child snapshots.
- `captureBlob(rect, maxSide, options)` encodes PNG from the SAME CPU capture target before cleanup;
  no second canvas repaint or new GPU context. It shares bitmap capture's queue/deadline/admission.
  Aborting rejects promptly but retains the active slot/storage until native encoding settles.
  Compose PDF+ink through genuine `PdfInkBackdrop.captureSnapshot` (plain, source/session leased),
  not nested queued `captureRegion`: two parent captures would occupy both slots and deadlock.
- CPU coverage witnesses and their helpers are benchmark-only conditional imports. Shadow backing,
  bitmap staging and counting scratch are charged to the canonical allocators as measurement bytes;
  they are not a dependency of normal rendering. Raster identity is explicit (`Layer.benchmarkRaster`
  on canonical PDF layers, declared/assigned only in benchmark builds); procedural notebook paper
  is not raster. Preserve custom `benchmarkDomain` callbacks when freezing compositor bindings.
  Vector current waits for its completed authoritative pass; optional witness failure never skips
  mandatory colour submission. Dev esbuild must bind the false constant BEFORE DCE/import analysis.

## The WebGL2 backend

- **Chosen** for a pane with `backendPreference` `'auto'` when the device can make any WebGL2 context (`deviceHasWebGL2` in
  `surfaceBroker.ts`, only success cached), the broker grants it one of `maxVisiblePaneContexts` (5) slots, and the device
  qualifies once (`#qualify` in `gfx/webgl2.ts`: a capability shader and a 2x2 readback). A device with no WebGL2 is a fallback,
  never memory pressure: reported as pressure, every quality raise dropped quality again (gpu-h13).
- **Falls back** per pane, never per document, to that pane's own `draw2d`: a GPU error demotes it (`fallback:pane-2d:gpu-error:
  <code>`), retried once after `GPU_RETRY_QUIET_MS` of quiet; the second error of the attach latches canvas2d. Three context losses
  in 60 s pin the pane on canvas2d (`cpu-pinned`). A resized GL canvas is bridged by a CPU picture while it rebuilds
  (`fallback:2d-bridge`). Each is counted; canvas2d never changes what it draws because the GPU exists.
- **GPU target** (`memoryGovernor.ts`, `updatePanes`): base + per visible pane + 24 B per device pixel, floor 64 MB; the fixed terms
  scale by the largest visible `min(DPR, 2)²`, inside the device class's ceiling (128/256/512 MB). Unscaled, a small DPR 2 pane sat
  at the floor, a saturated zoom filled it, the trim found nothing more, the surface rebuild was refused every frame and the pane
  never drew again (doc12 and LARGE=11 draw-sat 0/91). A cache filling that budget is not a leak: it must plateau, stay under the
  target, and give back everything above the view and its ring on a forced trim (`__bmeRenderAudit.trim('gpu')`).

## Frame-path rules (WebGL2)

- **No synchronous GL read on the frame path.** `getError`, `checkFramebufferStatus`, `getParameter`, `readPixels`,
  `getBufferSubData` and a blocking `clientWaitSync` are round trips to the GPU process: a frame behind a deep queue waits for all
  of it (measured: `checkFramebufferStatus` per resize, 17-24 ms at each LARGE=11 drag's start and release). They belong at device
  creation, once per device or per kind of target, in capture/export, or behind `__BME_BENCH__`. Query and fence polls stay
  non-blocking (`QUERY_RESULT_AVAILABLE`, `clientWaitSync(fence, 0, 0)`).
- **Nothing unchanged is redone, nothing per frame is allocated:** no re-raster, re-tessellation or re-upload of unchanged
  content, no per-frame string keys or snapshot arrays; every GPU byte is a governor lease; every CPU fallback is counted.
- **A frame presents only a changed picture.** A frame whose layers all answer unchanged is skipped (`presentUnchanged`). So an
  answer compares what the layer draws (camera, viewport, a picture key), never the view epoch: the epoch also moves when the
  moving flag flips at a gesture's start and end with the camera still. Keyed on it, the PDF answered changed over the same
  picture, and the board never saw its view presented and showed 'Updating…' at rest for good.
- A passed-over layer counts as changed (it proved nothing). A layer's class is read once as its prepare starts; one that turned
  critical after the critical pass ran is prepared in the optional pass, not sent to a pass that is over.
- Ask for a frame only for a cause; the scheduler names each present `present:<cause>`, and `none` is a fault.

## Audit and kits

- `localStorage['bme.renderAudit'] = '1'` turns on `window.__bmeRenderAudit`: `snapshot()` (counters `surface:event`, frames,
  stages with `sum/count/max/over8`, over8 = samples over a 120 Hz frame, 8.33 ms), `presents()` (each present with `why`, the
  tape of why every layer answered as it did), `gauges()`, `scenes()`, `trim(pool)`. The audit costs nothing off.
- Kit traps, each measured: headless Chrome ticks a synthetic 60 Hz whatever the flags (the 120 Hz bar is per-frame cost against
  8.33 ms, not cadence); DPR > 1 needs a REAL scale (`--force-device-scale-factor`, `viewport: null`): on an emulated
  `deviceScaleFactor` raw CDP `Input.dispatch*` lands at half scale; a screenshot is in device pixels, so a point picked from one is
  `clip.x + x / scale` in CSS. Time questions (GPU/CPU ms, hitches) run with nothing else on the machine; everything else is proved by counters.

## Boundaries

- `src/platform` cannot import React, context, editor, components, PDF or whiteboard. PDF and
  whiteboard import platform runtime only from lazy routes; do not pull a backend, shaders or a heavy
  engine into App's first chunk for a type. Terminal reservation uses only the tiny import-free
  telemetry seam; never import terminal/xterm to count it. Capture must not import the PDF writer
  (design §16.4, import rules).
- The broker alone allocates/recovers pane contexts; reserve the terminal slot even when closed.
  Five visible panes share one governor and scheduler: a sixth context request falls back to 2D,
  never evicts a visible neighbour; insufficient shared memory lowers resolution, never blanks.
  Respect app visibility separately from focus and window suspension. Rendering and mirror updates
  must be lease/token checked so a late old pane cannot overwrite a replacement (design §3.3).
- The benchmark CPU coverage witness reserves `4P` bytes for its transferred immutable bitmap plus
  `16 * bandArea` for worker scratch (bands of at most 65,536 pixels). Counting yields cooperatively
  between bands. Accepted observations drain after hide as retirement; hide never starts fresh paint.
