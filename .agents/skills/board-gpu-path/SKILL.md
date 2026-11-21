---
name: board-gpu-path
description: The board's GPU route — the tile composer and its item routes, zoom (stand-ins, exact tiles, text masks), held nodes during a drag, opaque worlds and modulate, the paper's own adapter, dense (CPU tile) mode on canvas2d only, sized capacity waits, present causes and the no-silent-fallback rule. Load before touching boardLayers.ts, src/whiteboard/render/gpu/, gpuPaintAdapter.ts, src/whiteboard/host/notebookPaperLayer.ts, budgetRefusal.ts, or the board/paper hooks in src/whiteboard/viewer/attachView.ts.
---

# The board GPU path

Shared rules (layers, frames, the governor) are in `rendering-platform`. This file is the board's own route.

## Route
- A pane with a device (`host.device()`) draws the direct paint through the GPU composer. `boardLayers.prepare`'s device branch
  has no density latch, no estimate walk and no reservation before the build (`boardLayers.ts`, `onDeviceRoute`).
- Dense (CPU tile) mode is canvas2d's. The dense adapter is built the first time a board enters dense mode (`ensureDense`), so a
  device never builds one. A route change resets the other route's state.
- The reference CPU adapter (`direct`) stays on a device: the composer borrows its prepared paths and clips.
- A board hidden while dense reports `direct` through `onDensityMode`; otherwise the owner keeps asking for live-only frames.

## Tiles (`src/whiteboard/render/gpu/`)
- `tileComposer.ts`: per visible position, one tile per blend-coherent slice (a slice ends where the blend changes or a live
  part sits). A position is admitted over frames within the frame's budget, acquired from `tileStore`, encoded in
  `encodeOffscreen` (per band), then drawn.
- `prepare(view, budget, prepared, omit?)`: `omit` is the nodes a drag previews elsewhere. Their tiles are composed without them;
  the draw never takes an omit set.
- Routes: `routePath` (clips admitted through its coverage kit), `routeInk` (analytic and union), `routeImage`, `routeText`
  (with text masks), and `cpu`. A run no GPU route takes is counted `fallback:item-cpu:<kind>:<why>`.
- `routePath` draws a fill or stroke by EXACT AREA (`areaCoverage.ts`, contours from `areaOutlines.ts`) when its outline is exact
  (simple contours, nesting only with opposite signs; groups of separated opaque fills as one area), else by the 4x MSAA
  coverage kit, counted `area:fallback:<why>` (dash, non-simple outline, nesting). The bar for shapes and ink is the exact
  coverage of the item's own geometry, not canvas2d (which is the inexact one: measured 44-96 levels off on diagonals).
  Edges are cached per content and band and moved by a uniform (a pan or zoom inside a band uploads nothing); a run's areas
  share one accumulation pass, then composite from their scratch regions. While a zoom is live an area over a quarter tile takes
  the coverage route and its run reports inexact (`exact()`), so its tile recomposes exact at rest, as text stand-ins do.
  A LIVE draw that admitted an inexact run owes the next frame: the composer invalidates `live-inexact`, and that settling
  frame is not a repeat and answers changed (the paper reads only prepare's answer, never `contentKey`). Else the zoom's last
  step stays on screen at rest.
- **Cost on a tiled GPU is render-target switches** (`gpu:target-switch`, audit): each loads and stores an attachment. Lined,
  grid and blank notebook paper is ONE procedural pass (`host/proceduralPaper.ts`, exact box coverage per item; dotted keeps the
  composed route, counted `procedural:off:<why>`); a live frame draws each part once over the view, never per tile position; the
  grid-4 coverage scratch is 8 MiB (a band is a switch and a resolve). Measured: notebook zoom-sat 848 switches -> 51, 14.6 -> 3.3 ms.
- Union ink is EXACT AREA too: `ink/unionOutline.ts` builds a stroke's union boundary (one offset contour per run, cut by an
  arrangement where contours cross, kept where the outer winding is zero); a refusal goes to the grid, counted
  `ink:area:fallback:<why>`. Wet and committed ink share the route, so pen-up hands over identical coverage. A moving view may hold
  a FINER band's outline, never a coarser one (the board rests on its last live picture). Measured, real DPR 2: notebook draw
  13.2 -> 1.3 ms per frame. The area shader's per-column share is taken from the run's own width (`tb = ta + d`): two separate
  differences of pixel-sized coordinates streaked rows on Apple's GPU.
- **Hitches are named by the slow-frame log** (`__bmeRenderAudit.slowFrames()`: each frame over 1000/120 ms GPU with its tape and
  counter deltas). A frame composes at most one dirty tile a pending region covers (`DIRTY_COVERED_PER_FRAME`); a covered position,
  and one whose tile replaced its cover, signs as its position (`coverSignature`), so the swap presents nothing.
- The wet layer lets go of a stroke when the board reports its node in `drawnInkNodeIds`, which the wet layer reads in its own
  prepare. A node goes in only once every live part of it was admitted this frame: reported before admission, a deferred
  re-admission at pen-up left the stroke on neither layer for a frame. With no stroke in flight the wet layer's routes are
  `evictGpu`-able (16.8 MB): a layer the frame has touched is never released whole, so without it the governor's trim fell short.
- Fidelity evidence: with `bme.renderAudit=1`, `__bmeRenderAudit.scenes()` gives each board's last presented items and pane
  matrix (`sceneAudit.ts`): the fidelity kit rasterises the exact coverage of those items and scores the shot against it.
- A change marks the positions under its bounds dirty (`tileParts.ts` parts index). A dirty position is recomposed into the
  target it already has.
- Coverage (`coverage(view)`): a position is `ok`, `dirty` or `missing`. A position with any picture (its tile, a dirty one, a
  finished one, or a stand-in of another scale) is complete. `sharp` needs the drawn scale to be the demanded one and every
  position `ok` there. While zooming, a hole does not hold the frame.

## Zoom
- A zoom holds a position at its nearest composed tiles (stand-ins, drawn scaled) when those tiles hold raster content only, or
  CPU raster (`heldByZoom`). Geometry (path and ink tiles) is composed at the exact scale each frame. Mixed GPU content composes
  exact: its text route scales its cached masks.
- A CPU raster is never composed again during a zoom: the CPU route would raster it afresh each frame.
- Text route (`ZoomRoute.setZoom`): while zooming, a missing exact mask is drawn from its cached stand-in, never rastered. A run
  that drew one is marked `exact: false`, and its tile recomposes exact once the camera rests.
- At rest, a position encoded exact supersedes its stand-ins at other scales (`dropScalesExcept`).
- The rest ring (a viewport each side, one tile while zooming; `ringMargin`) is prefetch: its targets are reserved first with
  `reserve(bytes, { prefetch: true })`, admitted only if they fit as the pool and grant stand, never reclaiming or freeing own tiles.
  Two composers' rings that reclaimed each other's undrawn tiles recomposed them every frame at rest. Keep the still-wanted test on the
  same margin, or ring positions are cancelled and begun again each frame.
- The notebook paper's revision is its own (paper properties, page count), never `doc.rev`: a stroke must not re-stage the paper.
- A position the governor refuses is composed one level down (half the scale), which covers four positions; a second refusal
  waits. At rest a refused position first frees its own composer tiles and is admitted in the same frame (`freeOwn`).

## Held nodes (drag)
- A node that leaves the omit set while its tiles lack it is drawn live (`heldNodes`). A position stops drawing that node live
  once an entry encoded since the node left holds it (`heldLive`): the tiles under it are composed by then.
- Positions under a held node are composed first, so the live draw ends sooner.

## Opacity and modulate (C1)
- A multiply slice is laid by fixed-function `modulate` only where the surface beneath is opaque, as `opaqueWorld()` reports.
  Elsewhere it is isolated (an over-composed copy laid by a multiply group).
- A whiteboard claims the whole plane (`WHOLE_PLANE`) unless the view is inverted, where it claims nothing.
- A notebook's paper and a PDF's page layers report `drawnPageRects()`: the pages painted at least once at the current layout.
  The board claims those pages only (`createDrawnPagesReader`, `attachView.ts`). A page claim resets with the layout, because
  the paper's record is keyed by stack-rect identity.

## Paper (`src/whiteboard/host/notebookPaperLayer.ts`)
- The paper has its own GPU adapter (`createGpuPaintAdapter`, audit surface `notebook-paper`). Its `evictGpu` forwards to it.
- Its refusals wait once, sized (`deny` → `awaitSizedCapacity`), and clear when the waiter fires.

## Memory
- GPU bytes are leases on the GPU pool. `evictGpu(bytes, frameId)` is the governor's trim: the adapter frees path coverage sets,
  then image and text textures, then composed tiles, each only what the frame `frameId` did not use (`gpuPaintAdapter.ts`).
- Only the band that owns the GPU adapter forwards `evictGpu` (`boardLayers.ts`); the other band's trim has nothing of it.
- CPU bytes on a device are the direct build's leases, in 64 KiB chunks (`DIRECT_CHUNK`), through `allocator.cpu.reserve`.
- A refused reservation waits once, sized: `awaitSizedCapacity(host, wake, { pool, bytes })` (`budgetRefusal.ts`). The governor
  drops a sized waiter when it fires, and wakes it only when the bytes fit.
- The GPU retry after a visible refusal arms a 250 ms deadline (`GPU_RETRY_MS`) as well: the pool can change with no release
  that reaches the waiter. The deadline only invalidates.

## Frames and presents
- A layer asks for a frame only for a cause: `host.invalidate(reason)`, or `needsFrame()` true. The composer's `needsFrame` is
  false while a GPU admission is refused (no per-frame retry), and true while it is indexing, building, or holds finished
  positions awaiting encode.
- The scheduler names each present `present:<cause>` (`scheduler.ts`, `presentCause`): `input`, `camera`, `wake`,
  `invalidate:<reason>`, `needsFrame:<layer>`, `none`. `none` is a fault: nothing requested that frame.

## No silent fallback
- A CPU raster on a device is counted under its `fallback:` name (`fallback:item-cpu:<kind>:<why>` in `tileComposer.ts`;
  `fallback:cpu-failed` and `fallback:offset-rebuild` in the board). A silent CPU path is a fault.
- A budget refusal with no size is reported, never a silent wait. On a device, other errors go to the pane's `reportGpuError`;
  a budget refusal and canvas2d errors go to `onError`.

## Known gaps (unsized waits)
These still wait with no byte count, so their refusal cannot be sized (check with `grep -rn whenAvailable src/whiteboard`):
- `boardLayers.ts` (the per-pool refusal waiter), `densePlan.ts` (four CPU sites), `streamingDenseTile.ts`, `analyticInkBatch.ts`
  (both pools), `gpu/imageTextures.ts` (both pools), `frameAssembler.ts`.
Sizing one needs its thrower to report the bytes it refused.

## Verification
- Typecheck and lint are the static gates. Behaviour is checked only in the browser (`verify-in-browser`); the counters above
  (`present:`, `fallback:`, `trim:`, `evict-partial:`) are the evidence.
