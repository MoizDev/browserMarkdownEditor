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
   the tiles follow the camera. While a zoom is still going a request at an equal or one-finer band stands too (a finer
   band's outline draws at a coarser scale, never the reverse) and the camera's band is asked once it settles: wheel
   steps alternating across the band at 100% asked the whole scene every step (40 steps: 40 requests → 2). On canvas2d a request stands while it holds the viewport at the same ink realisation
   (`paintRequestScope.ts`); while a zoom is still going (moving, or a scale change within `ZOOM_SETTLE_MS` 250) it
   stands one ink band across, on a board with pictures only while its picture tiles still cover the screen, and
   the exact scale is asked once the zoom settles. Asked per step, every pan and zoom step presented twice. The 2D
   adapter's next-scale snapshot shares the presented snapshot's picture leases in the same prepare, so a step
   completes in its own frame (video frames still ask, for the newest frame).
3. **Stream** (`paintStream.ts`, `scenePaintStream.ts`): each node yields `underlay` items then `content` items
   (`PaintBand`); every node's underlay is emitted before any content. The source resolves up to `RESOLVE_AHEAD_STROKES`
   (256) strokes and `RESOLVE_AHEAD` (16) other nodes ahead of the one it emits, in canonical order (`sceneSource.ts`). The
   chunks a task asks for with one abort signal go to the geometry workers as ONE `ink.batch` per pool member
   (`workers/inkCoverageClient.ts`: one input buffer, one packed reply; a stream fills 9-15 chunks a task, so the pool's extra
   members, made for 64+ chunks and ended after 5 s idle, are rare). Keyed by signal, a replaced stream cancels its batch whole;
   warm builds share one controller so they still batch. A batch that crashes its worker is asked again chunk by chunk on a
   serial isolation worker: the chunk that crashes there is refused for the page (`INK_GEOMETRY_CRASHED`), and the services leave
   that stroke out of the picture (`realize` answers a box from its samples) and say so; a member that failed for good is skipped
   and its queued chunks re-sent to a live one. The services build a node once per band
   and signature at a time (`building`), reuse geometry a frame still holds after its idle entry went (`surviving`, a `WeakRef`
   to the coverage), and `realize` (bounds only) builds at the band the paint last asked for.
   - **A chunk's coverage is one buffer** (`ink/packedCoverage.ts`): its segment, disc and centreline rows and run starts. The
     curve, radii and arc maps stay in the job that built them (`InkCoverageJob.result` vs `.coverage`); nothing on the main
     thread reads them. Measured (WebGL2, after forced GC, over idle): 57 ArrayBuffers per stroke before; a 10,060-stroke drawing +692 → +315 MB at rest, +671 → +190 MB hidden.
4. **Assembler** (`frameAssembler.ts`): builds the stream into a `PaintSource` frame under CPU leases.
5. **Board layers** (`boardLayers.ts`, `createBoardLayers`): two platform layers, one per band, sharing one state.
   - With a device (`host.device()`): the frame goes to the GPU adapter (`gpuPaintAdapter.ts`) and its tile
     composer. No density latch, estimate walk or reservation before the build (`onDeviceRoute`). The reference
     CPU adapter (`direct`, `reference/canvasPaintAdapter.ts`) is still built: the composer borrows its prepared
     frame and clips, but no path or ink outlines (`prepare(view, budget, vectors=false)`; the GPU CPU route builds
     its own), which held 110 MB at rest on a 450-stroke notebook. A 2D bridge frame asks again with outlines.
   - On canvas2d: the reference adapter draws directly (`direct` mode), or, past the density hysteresis
     (`density.ts`), CPU tiles (`dense` mode: `densePlan.ts`, `streamingDenseTile.ts`). The dense adapter is built
     the first time a board enters dense mode (`ensureDense`), so a device never builds one. A route change resets
     the other route's state. A board hidden while dense reports `direct` via `onDensityMode`. A direct frame is
     admitted on its estimate (an upper bound, ~10x the built outlines on ink) and, once presented, trued up to the
     adapter's measured bytes in DIRECT_CHUNK leases (`trueUpDirect`, then `chargeDirect` as on a device).

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
- **One tile scale**: a view's tiles are keyed at `exactTileScale(z·dpr)` (`tileKeys.ts`, 12 digits) by the composer AND the
  store; the store judging "current scale" from the raw product took every tile a settling board composed after a divider drag
  as another scale's, and trims evicted them as fast as they were composed (3,550 per 10 s at rest).
- A GPU route admits a run whole or defers it, so runs hold at most `RUN_MAX_ITEMS` (256) items: a slice resumes run by run.
  Unbounded, a 5,000-stroke union-ink run never fit one frame and deferred for good. A union-ink run deferred part way resumes at
  the stroke it stopped at, its admitted strokes kept (`routeInk.ts` `pendingRuns`; the composer's `cancel` and `toCpu` call
  `ItemRoute.abandon`): started over, a slow GPU's frames never reached a run's last strokes ('Updating…' for good).
- `prepare(view, budget, prepared, omit?)`: `omit` is the nodes a drag previews elsewhere; their tiles compose
  without them. The draw never takes an omit set.
- Every upload belongs to prepare: each route's `uploadPrepared()` runs at its end, and `encodeOffscreen` (the text
  route's glyph-to-atlas conversion) only encodes what it staged. A device refuses a write after a pass is recorded
  in the frame (`rendering-platform`, "Uploads belong in prepare").
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
  A moving view may hold a FINER band's outline; a coarser one only while its own band's edges are still uploading (the stroke's
  outgoing outline is kept for that, `ink:area:band-stand-in`), and the run is then inexact (`exact()`), so the rest recomposes it.
  Dropped instead, a zoom crossing a band left every stroke in view out of its frame. The area shader's per-column share comes from
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
- A pending region's cover is laid whole in a frame or not at all, so a position whose cover reaches more than
  `ZOOM_DIRECT_MAX_PARTS` parts lets its regions go (`live:region:dropped-dense`) and its dirty tile draws stale until composed:
  a paged-in scene's regions over thousands of strokes were laid every frame and starved the compose that clears them.
- A frame composes at most one dirty tile a pending region covers (`DIRTY_COVERED_PER_FRAME`), except one the last
  draw failed to cover. A covered position, and one whose tile replaced its cover, signs as its position
  (`coverSignature`), so the swap presents nothing.
- **A frame never takes an item off the screen.** Each visible position draws its own tile; else the other scales' picture of it
  (`standInPicture`: nearest scale first, each farther scale only where the nearer ones leave it bare, every cell clipped to what it
  fills; a cell composed empty covers its part unless an edit has since dirtied it); else its parts live (`fillLive`, at most
  `LIVE_FILL_MAX_PARTS` a frame, all or none); else it is a hole. A live frame (zoom-direct, a pan, settling) that could not admit a
  part draws the frame from tiles instead (`live:fallback:tiles`). A hole whose bare world the last drawn frame showed is a
  regression: the board's `critical()` holds the frame (`holding()`, the previous picture stays) for up to `HOLE_HOLD_MS`, then
  presents it. A draw refused on the surface holds the same way. Counted: `hole:<why>`, `hold:<why>`, `fill:live*`, and every frame
  laid with an item missing, `present:missing:<hold-expired|revealed|loading|draw-refused>` (revealed: world the move uncovered that
  no tile or live part shows yet; loading: at rest, the board says it is working). Kit: per-present cameras are in
  `presents()` (`view`), so each present can be scored against `scenes()` geometry.
- Coverage (`coverage(view)`): incomplete while the draw list holds a hole or a refused draw; at rest also while a visible
  position has no tile and no stand-in. `sharp` needs the drawn scale to be the demanded one and every position `ok`.

## Zoom

- A zoom holds a position at its nearest composed tiles (stand-ins drawn scaled) when those tiles hold raster content
  only, or CPU raster (`heldByZoom`). Geometry (path, ink) composes at the exact scale each frame; mixed content
  composes exact with the text route scaling its cached masks. A CPU raster is never recomposed during a zoom.
- Text (`ZoomRoute.setZoom`): while zooming, a missing exact mask draws from its cached stand-in, never rasters; the
  run is marked `exact: false` and recomposes at rest. At rest an exact encode supersedes other scales
  (`dropScalesExcept`).
- **The floor** (`FLOOR_VIEWS`): at rest, after the ring's first tile each side, the view's neighbourhood (three viewports each
  side) is composed at the power-of-two scale at which it spans two tiles, as prefetch. It is kept through zooms and pans
  (`dropScalesExcept` and `dropSuperseded` skip its scale) as the last stand-in: a zoom out reveals far more than the ring. A region
  of more than `FLOOR_MAX_PARTS` parts has none (`floor:off:dense`): a dense board's floor never finished composing.
- `freeOwn` never drops other scales' tiles the last frame laid (the picture of positions not yet composed), nor cancels the
  position it frees for; `cancel` resets a position's admission to its first run (driven past a cancel, it was encoded partial).
- While a GPU wait stands, a parked position is passed over and so is any work that would take new room (missing, ring, floor);
  dirty and held positions keep recomposing into the targets they hold, so an erase still shows.
- The rest ring (a viewport each side, one tile while zooming; `ringMargin`) is prefetch, reserved with
  `reserve(bytes, { prefetch: true })`: admitted only if it fits, never reclaiming tiles. Two composers' rings that
  reclaimed each other's undrawn tiles recomposed them every frame at rest. Keep the still-wanted test on the same
  margin, or ring positions are cancelled and begun again each frame.
- A position the governor refuses is composed one level down (half scale, four positions); a second refusal waits.
  At rest a refused position first frees its own tiles and is admitted in the same frame (`freeOwn`). Refused at rest, it
  first lets go of what holds its room: the pending regions' live covers (`live:region:dropped-memory`), the other positions in
  progress (`compose:cancel-others`) and the routes' admission caches from before the last frame (`compose:free-own:routes`).
  It frees and retries until nothing of its own is left that frame (`FREE_RETRY_ROUNDS`).
  Still refused with nothing of its own left, its slice is rastered by the CPU route (`compose:cpu-for-memory:<pass>`, counted
  `fallback:item-cpu:…:memory`), which needs the tile target alone; its pictures stay on the image route (their bitmaps are
  released once uploaded). The visible work a refusal parks is the pane's pinned demand (`mandatoryBytes`: its missing tiles and
  denied bytes), granted before any share; counted from composed tiles only, a pane rested on a stand-in under its own grant. A lowered position is
  driven each frame (no pass walks its scale) and dropped once the visible cells above it are exact; a position in progress
  that a whole compose at rest neither advanced nor left on a governor wait is counted `building:orphan`.

## Drag, wet ink and handover

- A node that leaves the omit set while its tiles lack it is drawn live (`heldNodes`) until an entry encoded since
  holds it (`heldLive`). Positions under a held node compose first.
- **`drawnLive` is cleared where the draw happens** (`tileComposer.ts` `drawGpu`), not at prepare. The base layer
  reads `drawnLiveNodeIds(band)` between the overlay's prepare and its draw; cleared at prepare it read an empty set
  on every frame of a drag, so the dragged node's original stayed on screen until release (measured: drawn=0 at each
  base read). It is the composer's truth for what the composite laid live.
- A cached picture is used only when its scene revision and render token both match the frame (`sameToken`,
  `render/boardLayers.ts`, which the preview layers import too); a source that fails it is not reused.
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

- The image route draws a picture under ANY invertible affine: axis-aligned unflipped in its exact device-rect mode,
  any rotation, flip or skew in its transformed mode (local rect, local-to-device matrix, per-edge device distance
  for the antialiased edge). Never hand a transform to the CPU raster: it cannot draw a live part (a drag, an edit),
  and a rotated picture was missing on WebGL2 (5-65% of pixels off canvas2d; now under 0.5%). Only a broken
  transformed picture's placeholder still goes there (`transform-placeholder`, counted).
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
- A finer tile whose bitmap goes mid-upload (a CPU trim, a new snapshot) is asked for again at once by the upload
  pump (`reacquireImage`, counted `image:tile:upload-lost`). Left to the next compose, at rest none came: a drawing
  shown again after a tab switch kept its picture's stand-in for good.

## Memory and waits

- GPU bytes are leases on the GPU pool. The adapter's `evictGpu(bytes, frameId)` frees path coverage sets, then image
  and text textures, then composed tiles, each only what `frameId` did not use. Only the band owning the GPU adapter
  forwards `evictGpu`.
- **A canvas2d bridge keeps the board's GPU work.** A frame prepared with no device but the same paint (the first
  CPU picture, a resize bridge) keeps the composer's tiles and picture textures and their ledger, so the governor
  still counts and can trim them through `evictGpu`; only a lost/released device (the pane's `releaseGpu`) or a
  paint of another document drops them. Released per bridge frame, a resize dropped and rebuilt every tile
  (measured: 540 tile releases and 8 picture re-uploads over 8 bridges → 0 and 0).
- A bridge's 2D draw builds outlines; the device frames after it build the snapshot again without them
  (`CanvasPaintAdapter.outlined`, `direct:shed-outlines`) and drop the outline LRU, or a resize left a notebook's floor 9 → 22 MB
  for good. `chargeDirect` charges the adapter's whole `memory()` ONCE (other frames' charges move onto the one charged) and
  gives back what the build no longer holds: per-frame and grow-only, it charged a kept presented frame a second copy.
- CPU bytes on a device are the direct build's leases in 64 KiB chunks (`DIRECT_CHUNK`).
- A refused reservation waits once, sized: `awaitSizedCapacity(host, wake, { pool, bytes })`
  (`budgetRefusal.ts`); the governor wakes it only when the bytes fit. The composer's GPU retry after a visible
  refusal also arms a 250 ms deadline (`GPU_RETRY_MS`, backing off; reset only by a compose that lands, never by a capacity
  wake, which its own frees can cause) that only invalidates, only while the wait stands, and a deadline that
  passes is cleared whether or not the wait is (the adapter's one wake slot re-sent a stale one with every store deadline: a
  frame per vsync at rest). `needsFrame` is false while a GPU
  admission is refused (no per-frame retry). The size waited for is the reservation that was refused, never the item's own
  bytes: the text atlas reports the page it was refused (`place` → `{ denied }`); a 2.9 KB glyph standing for a 4 MB page was
  woken by every unrelated release and framed at every vsync at rest.
- **What the view draws is not trim fodder.** `store.evict` takes on-view tiles of the current scale only while the composer
  draws live because the view MOVES (`liveEviction()`: `'moving'`); a settling view draws live only until those tiles land, and
  evicting them (as `live-covered`) cycled recovery trims and recomposes at rest for good (2,663 evictions per 10 s).
- Admission caches keep what the route's previous frame used, as well as this frame's: the union ink outlines over
  `AREA_CACHE_BYTES` (`routeInk.ts`) and the area kit's idle edge sets over `IDLE_EDGE_BYTES` (`areaCoverage.ts`). Kept for the
  current frame only, a deferred admission rebuilt and re-uploaded its outlines every frame (the 10,000-stroke old board after a
  zoom reset: ~105 outlines per frame, 'Updating…' for good). Both are pool leases; a refused lease still reclaims them.
- **What only saves later work is admitted as `prefetch` and charged once**: a dense plan's node buffer and resolved nodes
  (`planNodeBuffer.ts`, `resolvedNodeCache.ts`; the buffer's own read resolves into no cache, `openTile(…, null)`) and the
  session's idle geometry (`services.ts` `admit`). The plan reports them in `memory()`, never in its floor, and sheds them before
  any of its own reservations is refused as pressure (`reserveNeed`, the tile job's `shed`). Charged twice and as pressure, a
  454-stroke notebook held 29 MB of the 33.6 MB pool in them, every tile run was refused and it waited for memory for good.
- **The dense session tiles (`sessionDenseRasters.ts`) outlive the pane but are charged to the pane that rastered them**
  (`bindMemory`). The dense adapter gives exactly those back (`releaseCharged`, counted `board-dense:charged-release`) at hide,
  on dispose and when the board moves to the device route, which draws none of them: kept, a hidden board's tiles sat outside
  every visible floor and a WebGL2 board's sat pinned by its view, never reclaimable. A return re-rasters its view's tiles.
- **Geometry is a document model, not raster**: the services count every live coverage (built, not yet collected) and report it
  through `governor.reportDerivedModel` (readout `derivedModelBytes`), never into a pane's CPU pool: charged as the board's
  working set, a 10,060-stroke drawing's 122 MB held the 128 MB pool over target and the app reduced its quality at rest.
  When no view of the document has been visible for 2 s (`RELEASE_HIDDEN_MS`; a graph-view visit detaches every view, a tab
  moved to another pane does not) the runtime releases the session's derived caches (`render.releaseDerived`), and the
  hide drops everything that names a paint: frames, the composer's part index (`TileParts.release`), the adapter's memos, the
  routes' paint resources (re-handed at the next prepare: `tileComposer` resets `resourcesSeen`), the 2D picture records and
  the audit's scene. Check: `__bmeRenderAudit.memory().derivedModelBytes` is 0 a few seconds after a hide and a forced GC.
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
