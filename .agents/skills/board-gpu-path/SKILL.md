---
name: board-gpu-path
description: How a whiteboard, notebook or PDF-ink board is drawn — the paint pipeline (scene, paint stream, frame assembler, board layers), the layer stack, the GPU tile composer and its item routes, exact-area coverage, zoom stand-ins, held nodes during a drag, opacity and modulate, the notebook paper's adapter, large pictures, canvas2d's direct and dense modes, sized capacity waits and the no-silent-fallback rule. Load before touching src/whiteboard/render/ (gpu/ and reference/ included), src/whiteboard/viewer/attachView.ts or wetLayer.ts, src/whiteboard/host/notebookPaperLayer.ts or proceduralPaper.ts, or src/whiteboard/media/tilePlan.ts.
---

# Drawing a board

Shared rules (Layer contract, frames, governor, WebGL2 frame path) are in `rendering-platform`; load it first.
This is the board's own route. Editing (tools, selection, text) is `whiteboard-editing`.

## Pipeline

1. **Scene** (`scene/`): the App-owned runtime's indexed, packed copy of the document (`sessionScene.ts`).
2. **Request** (`viewer/attachView.ts`, `requestPaint`): asks the paint services for a stream of the view. On a
   device the first request is the view's world; once that is up, the whole sheet is asked ONCE with no world, keyed
   by revision, sheet, theme, sensitivity and ink band (`SceneKey`). A camera change inside one band asks nothing:
   the tiles follow the camera. On canvas2d a request stands while it holds the viewport at the same ink realisation
   (`paintRequestScope.ts`); while a zoom is still going (moving, or a scale change within `ZOOM_SETTLE_MS` 250) it
   stands one ink band across, on a board with pictures only while its picture tiles still cover the screen, and
   the exact scale is asked once the zoom settles. Asked per step, every pan and zoom step presented twice. The 2D
   adapter's next-scale snapshot shares the presented snapshot's picture leases in the same prepare, so a step
   completes in its own frame (video frames still ask, for the newest frame).
3. **Stream** (`paintStream.ts`, `scenePaintStream.ts`): each node yields `underlay` items then `content` items
   (`PaintBand`); every node's underlay is emitted before any content.
4. **Assembler** (`frameAssembler.ts`): builds the stream into a `PaintSource` frame under CPU leases.
5. **Board layers** (`boardLayers.ts`, `createBoardLayers`): two platform layers, one per band, sharing one state.
   - With a device (`host.device()`): the frame goes to the GPU adapter (`gpuPaintAdapter.ts`) and its tile
     composer. No density latch, estimate walk or reservation before the build (`onDeviceRoute`). The reference
     CPU adapter (`direct`, `reference/canvasPaintAdapter.ts`) is still built: the composer borrows its prepared
     paths and clips.
   - On canvas2d: the reference adapter draws directly (`direct` mode), or, past the density hysteresis
     (`density.ts`), CPU tiles (`dense` mode: `densePlan.ts`, `streamingDenseTile.ts`). The dense adapter is built
     the first time a board enters dense mode (`ensureDense`), so a device never builds one. A route change resets
     the other route's state. A board hidden while dense reports `direct` via `onDensityMode`.

**Layer stack** (bottom up, `makeSnapshot` in `attachView.ts`): backdrops (a PDF's page layers) → notebook paper →
board underlay band → preview underlay → interaction underlay (wet ink) → board content band → preview content →
interaction content → embed port. Rebuilding an identical list must return the same frozen array: a new topology
seals platform input, and resealing during layout recursed until React error #185.

The board's `backendPreference` is `'auto'` (`BOARD_BACKEND_PREFERENCE`): both routes draw the same prepared paint
and the platform alone picks the device.

## The tile composer (`render/gpu/`)

- `tileComposer.ts`: per visible position, one tile per blend-coherent slice (a slice ends where the blend changes
  or a live part sits). Positions are admitted over frames within the frame budget, acquired from `tileStore.ts`,
  encoded in `encodeOffscreen` (per band), then drawn. `tileParts.ts` indexes parts by position: a change marks the
  positions under its bounds dirty, and a dirty position is recomposed into the target it already has.
- `prepare(view, budget, prepared, omit?)`: `omit` is the nodes a drag previews elsewhere; their tiles compose
  without them. The draw never takes an omit set.
- **Routes**: `routePath` (fills, strokes, clips), `routeInk`, `routeImage`, `routeText` (glyph masks,
  `textMasks.ts`), and `cpu`. A run no GPU route takes is counted `fallback:item-cpu:<kind>:<why>`.
- **Exact area** is the bar for shapes and ink: the exact coverage of the item's own geometry, not canvas2d (which
  is the inexact one: measured 44–96 levels off on diagonals). `routePath` draws a fill or stroke by exact area
  (`platform/render/areaCoverage.ts`, contours from `gpu/areaOutlines.ts`) when its outline is exact — simple
  contours, nesting only with opposite signs, groups of separated opaque fills as one area, and a stroke under one
  even-odd cut clip (`cutClipOf`: convex outer minus convex holes, a connector around its label). Otherwise the 4x
  MSAA coverage kit, counted `area:fallback:<why>` (dash, non-simple outline, nesting).
- Union ink is exact area too: `ink/unionOutline.ts` builds a stroke's union boundary; a refusal goes to the grid,
  counted `ink:area:fallback:<why>`. Wet and committed ink share the route, so pen-up hands over identical coverage.
  A moving view may hold a FINER band's outline, never a coarser one. The area shader's per-column share comes from
  the run's own width (`tb = ta + d`): two separate differences of pixel-sized coordinates streaked rows on Apple GPUs.
- Edges are cached per content and band and moved by a uniform: a pan or zoom inside a band uploads nothing. A run's
  areas share one accumulation pass, then composite from their scratch regions.
- While a zoom is live an area over a quarter tile takes the coverage route and reports inexact (`exact()`); its tile
  recomposes exact at rest. A live draw that admitted an inexact run invalidates `live-inexact` and the settling
  frame answers changed, or the zoom's last step stays on screen at rest.
- A live path or ink part is signed by its item (`EXACT_LIVE_ROUTES`), not counted as new content each frame; image
  and text parts still are. The board compares the drag offset it presented, not any offset.
- **Cost on a tiled GPU is render-target switches** (`gpu:target-switch`). Lined, grid and blank notebook paper is
  ONE procedural pass (`host/proceduralPaper.ts`; dotted keeps the composed route, counted `procedural:off:<why>`);
  a live frame draws each part once over the view, never per tile position. Measured: notebook zoom 848 switches
  → 51, 14.6 → 3.3 ms.
- **Mask clips need planned isolation targets.** The composer learns a shortfall from a refused encode or live draw
  (`noteShortfall`) and reserves it at each prepare that encodes or draws live (`reserveIsolation`); unplanned, an
  arrow's label cut was refused every frame and the label never drew.
- A frame composes at most one dirty tile a pending region covers (`DIRTY_COVERED_PER_FRAME`), except one the last
  draw failed to cover. A covered position, and one whose tile replaced its cover, signs as its position
  (`coverSignature`), so the swap presents nothing.
- Coverage (`coverage(view)`): a position is `ok`, `dirty` or `missing`; any picture (its tile, a dirty one, a
  stand-in of another scale) makes it complete. `sharp` needs the drawn scale to be the demanded one and every
  position `ok`. While zooming, a hole does not hold the frame.

## Zoom

- A zoom holds a position at its nearest composed tiles (stand-ins drawn scaled) when those tiles hold raster content
  only, or CPU raster (`heldByZoom`). Geometry (path, ink) composes at the exact scale each frame; mixed content
  composes exact with the text route scaling its cached masks. A CPU raster is never recomposed during a zoom.
- Text (`ZoomRoute.setZoom`): while zooming, a missing exact mask draws from its cached stand-in, never rasters; the
  run is marked `exact: false` and recomposes at rest. At rest an exact encode supersedes other scales
  (`dropScalesExcept`).
- The rest ring (a viewport each side, one tile while zooming; `ringMargin`) is prefetch, reserved with
  `reserve(bytes, { prefetch: true })`: admitted only if it fits, never reclaiming tiles. Two composers' rings that
  reclaimed each other's undrawn tiles recomposed them every frame at rest. Keep the still-wanted test on the same
  margin, or ring positions are cancelled and begun again each frame.
- A position the governor refuses is composed one level down (half scale, four positions); a second refusal waits.
  At rest a refused position first frees its own tiles and is admitted in the same frame (`freeOwn`).

## Drag, wet ink and handover

- A node that leaves the omit set while its tiles lack it is drawn live (`heldNodes`) until an entry encoded since
  holds it (`heldLive`). Positions under a held node compose first.
- The wet layer (`viewer/wetLayer.ts`) lets go of a stroke when the board reports it in `drawnInkNodeIds`, read in
  the wet layer's own prepare. A node goes in only once every live part of it was admitted this frame: reported
  earlier, a deferred re-admission at pen-up left the stroke on neither layer for a frame.
- The wet bands answer unchanged from a fingerprint of what they draw: on a device the runs each stroke was admitted
  as, after a draw2d the pending strokes' sources (canvas2d admits no runs; keyed by runs, a live stroke showed only
  at pen-up).
- With no stroke in flight the wet layer's routes are `evictGpu`-able (16.8 MB measured): a layer the frame touched
  is never released whole, so without it the governor's trim fell short.

## Opacity and modulate (C1)

- A multiply slice is laid by fixed-function `modulate` only where the surface beneath is opaque (`opaqueWorld()`);
  elsewhere it is isolated (an over-composed copy laid by a multiply group).
- A whiteboard claims the whole plane (`WHOLE_PLANE`) unless the view is inverted, where it claims nothing. A
  notebook's paper and a PDF's page layers report `drawnPageRects()` (pages painted at least once at the current
  layout); the board claims only those (`createDrawnPagesReader`). The claim resets with the layout.
- The paper's revision is its own (paper properties, page count), never `doc.rev`: a stroke must not re-stage it.

## Notebook paper (`host/notebookPaperLayer.ts`)

Its own GPU adapter (`createGpuPaintAdapter`, audit surface `notebook-paper`); its `evictGpu` forwards to it. Its
refusals wait once, sized (`awaitSizedCapacity`). Ruled paper also has a PDF writer definition: see `pdf-and-drawings`.

## Large pictures (`media/tilePlan.ts`, `gpu/routeImage.ts`)

- A tiled picture's whole-mip item carries `picture` facts; the image route plans the finer tiles of each tile it
  composes (`planPictureTiles`, the screen's byte share via `setScreen`, canvas2d's keys) and skips the stream's
  `underlaid` tiles. Tile interior is `mediaTileInteriorPixels` (1024) on both backends.
- A tile still decoding is left out (the stand-in shows); its entry waits in `awaitingDecode` asking no frames and
  recomposes once the decode settles. Only the resting scale's entries are asked; tiles a zoom composed on its way
  wait for their scale. The tile demand never aborts an acquire someone still waits for.
- On a device, a picture whose texture this device already holds (`textureHeld`: texture ready, not a video, no item
  of it drawn on the CPU) starts a new snapshot released, as the image route leaves it; a CPU draw that needs the
  bitmap (`reacquireReleased`) or a gone texture (`reacquireImage`) fetches it again. Each new snapshot otherwise
  decoded every picture on screen once more, only for the route to drop it unread.
- A picture is hashed and verification-decoded once: the residency source (`media/residencySource.ts`) admits a Blob
  once and inspection skips the decode for content already verified in this page. Re-inspecting per raster job
  queued whole-picture decodes ahead of the tiles (measured: first tile raster 215 → 150 ms).

## Memory and waits

- GPU bytes are leases on the GPU pool. The adapter's `evictGpu(bytes, frameId)` frees path coverage sets, then image
  and text textures, then composed tiles, each only what `frameId` did not use. Only the band owning the GPU adapter
  forwards `evictGpu`.
- **A canvas2d bridge keeps the board's GPU work.** A frame prepared with no device but the same paint (the first
  CPU picture, a resize bridge) keeps the composer's tiles and picture textures and their ledger, so the governor
  still counts and can trim them through `evictGpu`; only a lost/released device (the pane's `releaseGpu`) or a
  paint of another document drops them. Released per bridge frame, a resize dropped and rebuilt every tile
  (measured: 540 tile releases and 8 picture re-uploads over 8 bridges → 0 and 0).
- CPU bytes on a device are the direct build's leases in 64 KiB chunks (`DIRECT_CHUNK`).
- A refused reservation waits once, sized: `awaitSizedCapacity(host, wake, { pool, bytes })`
  (`budgetRefusal.ts`); the governor wakes it only when the bytes fit. The composer's GPU retry after a visible
  refusal also arms a 250 ms deadline (`GPU_RETRY_MS`) that only invalidates. `needsFrame` is false while a GPU
  admission is refused (no per-frame retry).
- **Unsized waits still exist** (`grep -rn whenAvailable src/whiteboard`): `boardLayers.ts` (per-pool refusal waiter),
  `densePlan.ts` (four CPU sites), `streamingDenseTile.ts`, `analyticInkBatch.ts` and `gpu/imageTextures.ts` (both
  pools), `frameAssembler.ts`, and `gpu/tileStore.ts`. Sizing one needs its thrower to report the bytes refused.

## No silent fallback

- Every CPU raster on a device is counted under a `fallback:` name: `fallback:item-cpu:<kind>:<why>`
  (`tileComposer.ts`), `fallback:cpu-failed` (`gpuPaintAdapter.ts`), `fallback:offset-rebuild` (`boardLayers.ts`).
  A silent CPU path is a fault.
- On a device, errors go to `host.reportGpuError` (the pane demotes); a budget refusal and canvas2d errors go to
  `onError`. A budget refusal with no size is reported, never a silent wait.

## Evidence

With `bme.renderAudit=1`: `present:` causes, `fallback:`, `area:fallback:`, `trim:`, `evict-partial:` counters;
`__bmeRenderAudit.slowFrames()` names each frame over 8.33 ms GPU with its tape and counter deltas;
`__bmeRenderAudit.scenes()` gives each board's last presented items and pane matrix (`sceneAudit.ts`) for fidelity
kits that rasterise the exact coverage and score a screenshot against it. Running the app on each backend:
`verify-in-browser`.
