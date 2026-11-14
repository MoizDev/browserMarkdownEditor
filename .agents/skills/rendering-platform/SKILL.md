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
- GPU resources are rebuildable caches of session CPU truth. Mirrors and their leases belong to the
  app-level document session, not to a pane/layer; unmount returns a borrow, not the bitmap owner.
  Source reload/session closure, not a path rename or graph trip, ends their ownership (design §6.4).

## Frames, budgets and drawing

- All layers consume the same frozen view/frame. `RenderToken` carries vault epoch, document id,
  bytes generation and session; `FrameToken` also carries view lease and device generation. Check
  the full relevant token, revision and ownership at async publication; stale worker responses,
  disposed leases and prior-device resources must never update the current view (C7, design §7.1).
- Split `prepare(view, budget)` into bounded resumable work, respect `shouldYield()` and
  `claimUpload(bytes)` and never perform resource creation or uploads inside draw. Use the host's
  canonical CPU/GPU allocators; a failed `reserve` means defer or use a lower-quality/2D path, not
  an unaccounted allocation. Return the same lease to the allocator that issued it; GPU retirement
  remains charged until complete (C4.3, design §§5.6, 6, 7.1).
- `host.device()` can be null; reacquire it after backend/generation changes, and never import the
  broker or native GL into a layer. `host.uniforms(bytes)` is valid only during `drawGpu` and uses
  the current encoder's fenced ring. `host.drawTexturedQuad` takes source texels including real
  gutters and a device-pixel destination for either backend. `host.paintWorld` and `host.paintPage`
  install the common transform and page clip for 2D; start from the supplied device-identity context
  (C4.2–C4.3, design §4.1).
- `encode` and `submit` can return null: do not acknowledge presentation or advance overlays without
  a complete current frame. Requeue budget/deadline deferrals and null submit; a worker or other
  external wait instead wakes on completion or a real deadline, never by polling frames.
- Compose page, committed ink and live stroke as one document-colour group; invert that group once,
  not each translucent element. Chrome/selection remains outside it. Capture/export bypasses view
  inversion (C2.5, design §4.2).
- Pressure is app-wide: allocation refusal and device trouble trim before reducing `q`; recovery
  waits for sustained low usage and no gesture. Never bypass a denied reservation. Report worker
  owned/WASM byte estimates (not real JS heap or bytes already leased) with
  `reportWorkerMemory(worker, bytes)`; `releaseWorkerMemory(worker)` on stop/crash/recycle.
  Both are lazy render exports, keyed by the actual worker incarnation and charged to CPU.

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
