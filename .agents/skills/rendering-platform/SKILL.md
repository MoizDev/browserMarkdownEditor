---
name: rendering-platform
description: Shared rendering platform and layer contracts. Load before changing src/platform/render or implementing a PDF, notebook or whiteboard rendering layer.
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
