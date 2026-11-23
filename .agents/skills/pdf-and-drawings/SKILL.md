---
name: pdf-and-drawings
description: The canvas documents — the annotated-PDF read/write pipeline, the pdf.js viewer's rendering/windowing/memory strategy, notebooks (ruled pages + PDF export), and tldraw drawings. Load before touching any pdf* module, paper.ts, notebook*, PdfPane/PdfViewer/PdfAnnotateCanvas/DrawingPane/NotebookPane, or adding an import to any of them (the module split is load-bearing for bundle size).
---

# PDF annotation pipeline (the subtlest subsystem)

Files: `pdfAnnotation.ts` (read + rasterize, pdf.js), `pdfBuild.ts` (write, pdf-lib),
`pdfBuild.worker.ts` + `pdfBuildClient.ts` (off-main-thread), `pdfFormat.ts` (shared attachment
names), `pdfOverlay.ts` (the per-page overlay contract), `pdfVector.ts` (tldraw SVG → path ops),
`pdfRenderCache.ts` (canvas↔save handoff), `pdfLinks.ts` (link annotations → boxes +
destinations), `PdfPane.tsx`, `PdfViewer.tsx` (view mode), `PdfAnnotateCanvas.tsx`.

**Annotating happens IN THE FILE YOU OPENED.** It stays a genuine PDF: its original pages + the
annotations drawn onto them (vector paths, see below) + two embedded attachments — `original.pdf`
(pristine) and `tldraw-snapshot.json` (editable strokes). It opens in any viewer *and* reopens here
as live tldraw shapes.

- **No `(annotated)` sibling, and no name test anywhere.** `readPdfRole` reads a PDF's role from its
  attachments in ONE pdf.js open: an embedded `original.pdf` means it is already one of ours, and its
  ABSENCE means the file's own bytes are the pristine original. That is the whole of the conversion —
  the first save is what adds the attachments. Files made by the old spawn-a-sibling behaviour keep
  working unchanged, because they were always identified by content.
- **The role read is lazy** (`needsSource`, set on first switch to edit and sticky): every PDF can be
  annotated now, so gating it on the filename is gone, and reading every PDF on open just to find out
  would be an N-MB allocation and a disk read for documents only ever read.
- `flushTab`'s PDF branch is now `isPdfFile`, not `isAnnotatedPdf`; `getPdfRenderData` returning
  nothing is what distinguishes a PDF that was only read.

> **THE LOAD-BEARING RULE: every save rebuilds from the embedded pristine original, never the
> currently-stamped pages.** Rebuilding from stamped pages re-stamps strokes over themselves — each
> save darkens/duplicates annotations and inflates the file.

- The annotated tab's `content` buffer is the **tldraw snapshot string** (rides normal autosave).
  Building the PDF *also* needs the original + the exported overlays, which only the live canvas can
  make — it parks them per-path in `pdfRenderCache` (kept **outside React state**; these are megabytes
  of binary that must never enter a re-render path or localStorage), and `flushTab` picks them up and
  calls `buildAnnotatedPdfAsync`. `movePdfRenderData` must follow a rename, or the tab's next save
  silently no-ops looking under the new path.
- **Annotations reach the page as VECTOR paths, not pixels.** `getSvgString` → `svgToVectorOps`
  (`pdfVector.ts`) → `page.drawSvgPath` per op. A `PageOverlay` (`pdfOverlay.ts`) carries `vector`
  and/or `raster`; shapes with no path form (text, images — `RASTER_ONLY_SHAPES`) still export as a
  PNG, and the builder draws that **first** so ink lands on top. `svgToVectorOps` returning null
  (embedded fonts, `<pattern>` fills, clip paths, a non-similarity transform) sends the whole page
  down the raster route, which is the pre-vector behaviour — so a failure is softer output, never
  wrong output.
- ⚠️ **pdf-lib's `drawSvgPath` renders quadratic curves WRONG** — its `appendQuadraticCurve` emits
  the PDF `v` operator, a *cubic* using the current point as first control. tldraw's ink is almost
  entirely `q`/`t`, so every stroke came out a splayed blob. `pdfVector.normalizePathData` therefore
  converts everything to absolute `M`/`L`/`C`/`Z` first, and pdf-lib never sees a Q, T, S, A or a
  relative command. Verified against `getPointAtLength` on 14 path shapes; do not "simplify" it away.
- **Exports pin `darkMode: false` and the canvas pins `colorScheme="light"`.** tldraw resolves colour
  NAMES through the live theme and its dark theme maps `black` → `#f2f2f2`; a PDF page is white in
  either theme, so following the app theme drew near-white ink on white paper, on screen and in the
  saved file. Snapshots store the name, so old files heal themselves.
- `stampRaster`/`stampVector` share `displaySpace()`, which handles the `/Rotate` trap: pdf.js
  *applies* `/Rotate` (canvas is landscape) but pdf-lib *ignores* it (`getSize()` returns the
  portrait MediaBox). The raster half anchors + rotates the image per angle; the vector half
  concatenates the same mapping as a CTM and draws inside it.
- `withPdf` always slices the buffer (pdf.js detaches it) and always destroys the worker.
- `pdfBuildClient` keeps one warm `Worker` for the app's life, and on `worker.onerror` rejects every
  in-flight build and nulls the worker so the next call re-spawns it.

## Rotation (`utils/pdfRotate.ts`, `utils/pdfRotation.ts`, `App.rotatePdf`)

- **It is a real edit, not a view setting** — the angle goes into each page's `/Rotate`, and the file
  is written. Chosen over a view-only rotation (which `PdfInvertToggle` would have been the model
  for) because EVERY consumer here already honours `/Rotate`: pdf.js applies it when it builds a
  viewport, `displaySpace()` undoes it when stamping, the thumbnails and link layer come from the
  same viewports. A view rotation would have been a second coordinate system that all of those, and
  the saved file, would have to be kept in step with.
- `pdfRotation.ts` is pure quarter-turn arithmetic with no imports; `pdfRotate.ts` holds the pdf-lib
  half and is imported **only by `pdfBuild.worker.ts`** — App reaches it through
  `pdfBuildClient.rotatePdfAsync` (dynamically imported; the client imports types only), so pdf-lib
  stays out of the main bundle. A page in the wild can carry 450, -90 or 89.9 — `asQuarter`
  normalizes on the way in as well as out, because pdf-lib throws on a non-multiple of 90.
- **It runs in the build worker, with pdf-lib's ticks OFF — and so does every pdf-lib load/save.**
  By default `PDFDocument.load` stops on a `setTimeout(0)` every 100 objects and `save()` every 50,
  so one rotation scheduled ~3 × objects / 100 zero-delay timers on the MAIN thread, each costing
  whatever the browser decides: ≥4ms focused, ONE SECOND in a hidden or minimized window. Measured
  on a 1,105-page / 7,032-object PDF: 176 timers, 1.3-1.5s click-to-rotated for ~0.3s of real
  pdf-lib work; minimized, still unfinished after 10+ minutes; a ~10k-object textbook ≈ 5 minutes,
  which is what users reported ("does nothing, then turns after 5 minutes"). The cost tracked
  OBJECT COUNT, not bytes. In the worker with `LOAD_WITHOUT_TICKS` / `SAVE_WITHOUT_TICKS`
  (`pdfBuild.ts`): 0 main-thread timers, ~340ms for that book, ~1.07s for a 220MB textbook (was
  2.1s). The same options are on `buildAnnotatedPdf` and `buildNotebookPdf`, which paid the same
  ticks on every save. Never call pdf-lib on the main thread, and pass both options to any new load
  or save.
- **The bytes are TRANSFERRED to the worker, not cloned** (`dispatch`'s transfer list): App read
  them fresh for this one gesture and `readPdfRole` slices its own copy, so a 220MB document is not
  copied to be turned. The annotate path still clones — its `original` lives in `pdfRenderCache`.
- **A pending turn shows on the buttons** (`aria-busy` + `.is-busy`, the icon spins; still under
  `prefers-reduced-motion` it only takes the accent colour). The state is `utils/pdfRotating.ts`,
  an external store holding a per-path COUNT — App begins once a turn is accepted onto the chain and
  ends in a `finally` on every exit, refusals and conflicts included. A count because turns queue:
  two quick clicks are a half turn, and the buttons are never disabled. A store, not a prop: the
  pane remounts on `diskRev` when the turn lands, and a prop would re-render the host.
- **`App.rotatePdf` writes it like any other save**: `writeFileVersioned` against the tab's baseline
  (PDF baselines are hashed in the background — wait the seed out), queued on the same per-tab chain
  as `flushTab` so a rotation cannot interleave with an annotation save, then `setBaseline`,
  `recordFileWritten`, `clearPdfRenderData` (the parked original predates the turn) and a `diskRev`
  bump, which is what remounts the pane on the new bytes. The reader comes back on its page because
  the position record is per path and survives the remount.
- **Refused on a PDF this app has annotated**, with a notice that says why: the strokes are authored
  against the pages as they are and `/Rotate` would turn the paper out from under every mark.
  The role read that decides it happens in the HANDLER, at the moment of the gesture — doing it on
  open would undo `needsSource`'s whole point (an attachment read for every PDF merely read).
- UI: two buttons in the reader's first pill, `[` / `]` on the keyboard (by `e.code`, since ⌥] is
  not `]`), and **⌥-click** to turn the page being read rather than the document. The keys have no
  one-page form on purpose: the modifier that would say so is the one that changes what the key
  produces. Annotate mode has no rotate control — the refusal above is why there would be nothing
  for it to do.

## One pdf.js worker for the whole app — `utils/pdfWorker.ts`

pdf.js spawns a worker **per `getDocument`** unless it is handed one, and a loading task only tears
down a worker it created itself (`task._worker` is set only when the caller passed none) — so passing
a shared one is safe, and is the whole fix. Opening a single PDF used to start two workers: `PdfPane`
probes the file's role via `readPdfRole` before it knows which view to show, then `PdfViewer` opens
the same bytes again; each boot loads and compiles ~1MB of worker script before a byte is read.
**Pass `worker: pdfWorker()` to every `getDocument`.** That module is also the one place that sets
`GlobalWorkerOptions.workerSrc` — importing it is how the PDF modules get the assignment. Verified by
counting `new Worker(...)`: one for the session, zero more per PDF opened. `prefetchPanes` starts it
at idle (dynamically, or pdf.js lands in the main bundle), so the boot is off the first click.

## Deliberate module fragmentation is for bundle size — do not collapse it

pdf-lib (~400kB) + pdf.js must stay out of the main bundle for markdown-only sessions. There is no
manual chunk config in `vite.config.ts`; the split is achieved **entirely by source-level import
discipline**, so a single new import undoes it silently:

- `pdfRenderCache.ts` and `pdfFormat.ts` import no PDF libs at all (`pdfFormat` is pure strings).
- `pdfLinks.ts` imports `pdfjs-dist` **for types only**.
- The builder's client (`pdfBuildClient`, types-only imports) is reached only by dynamic `import()`
  at its write sites; pdf-lib itself (`pdfBuild.ts`, `pdfRotate.ts`) is imported only by the worker.
- Reader (pdf.js) and writer (pdf-lib) **never import each other** — they share names via `pdfFormat`.
- The writer runs in a **DOM-less Web Worker**, so `pdfBuild.ts` must never reach for the DOM.
- `PdfPane` and `CanvasPane` are `React.lazy` in `EditorPane`, `PdfAnnotateCanvas` is `React.lazy` in
  `PdfPane`, and `DrawingPane`/`NotebookPane` are `React.lazy` in `CanvasPane` — so viewing a PDF
  never pulls in tldraw.
- `components/canvasAgentOps.ts` (the AI agent's hands on a canvas) imports tldraw: ONLY the three
  canvas panes may import it. `utils/pdfText.ts` (closed-PDF text/render for the agent) imports pdf.js
  and is reached only through `import('./pdfText')`. `utils/canvasViewState.ts`, like
  `pdfViewState.ts`, imports nothing heavy.

## View mode: `PdfViewer.tsx`

A pdf.js-rendered continuous scroll (fit-width + zoom pill + `+`/`-`/`=` keys on the active tab +
trackpad-pinch/ctrl-wheel zoom, cursor-anchored, via a non-passive native wheel listener whose
`preventDefault` keeps the gesture from browser-zooming the whole app), *not* the browser's viewer in
an iframe: the native viewer is a closed box that can't report its page, and page persistence
requires reading it.

- **While a pinch is in flight the zoom is only a CSS transform** pinned at the cursor; the real
  relayout/re-rasterization commits once, ~180ms after the burst quiets, because doing it per wheel
  tick restyled every text-layer span and restarted every visible rasterization — it stuttered.
- Selection/copy/⌘F come from pdf.js **`TextLayer`** spans. The `.textLayer` CSS in `index.css` is the
  library's contract — percent positions + `--scale-factor`/`--total-scale-factor` sizing, **plus the
  three `[data-main-rotation]` rules**: pdf.js sizes a text layer from the page's *unrotated* box and
  leaves the turn to the host's CSS, so without them a `/Rotate 90` page's selection lands nowhere
  near its glyphs. Zoom therefore rescales text layers without rebuilding them.
- **Text layers are built eagerly for every page of a document up to `TEXT_EAGER_LIMIT` (300 pages),
  and are never released.** That eagerness is what makes ⌘F find text on pages you have never scrolled
  to, and it is the largest single memory item in the app (measured ~4.3KB of renderer memory per
  positioned span, so a dense 300-page book runs to hundreds of MB). Above 300 the *eager* pass is
  skipped, but layers are still built on demand for every page that scrolls into view and still never
  freed. **Do not "fix" this by lowering the limit or windowing the layers without an explicit
  decision — both trade away ⌘F completeness.** The eager pass is keyed on a `hasLayout` boolean rather
  than the `layout` object identity, so a zoom or resize does not restart 300 iterations.
- **`content-visibility: auto` on `.pdf-viewer-page` buys TIME, not MEMORY** — know which problem you
  are measuring before judging it. Memory: it does nothing (measured 533.8MB → 542.1MB, slightly
  *worse*, because Blink does not tear down layout structures already built), so it is no answer to the
  text layers above. Per-frame cost: it is decisive, because every zoom step changes `--scale-factor`
  and so restyles every text-layer span and repaints the whole column — 40 pages of style, layout and
  compositor commit to change what two of them show. Measured on a 40-page document at 4x CPU: blocked
  main thread per zoom step 223ms → 122ms, a 4-step `-` burst 452ms → 177ms, 45fps → 55fps. It needs no
  `contain-intrinsic-size` here: each page div carries explicit inline width/height from the layout, so
  a skipped page still reserves exactly the right box. Verified it does not cost ⌘F: with and without,
  find lands on the same page at the same rect (`window.find` → identical geometry, A/B'd in-page).
- **A page's bitmap is capped at `MAX_CANVAS_PIXELS` (2^24 device px, ~67MB), and past the cap the page
  is rendered ONE BAND AT A TIME.** A canvas used to grow with the zoom even though the viewport only
  ever showed a sliver: measured at 4x zoom, two canvases of 9440x12216 — 231 megapixels, **~923MB** of
  backing store — which is what made zooming out of a 40-page document run at 7fps with 1.3s of blocked
  main thread. `pageRegion` answers with the visible strip grown by as much margin as the budget still
  affords (`rect`), the strictly visible part that must be painted (`need`), and `rect` pulled in by
  half that margin (`trigger`). A re-render is worth doing once `need` escapes `trigger` — deflating is
  what stops a one-pixel scroll from re-rendering, and only deflating sides that are not already a page
  edge is what keeps it from asking to re-render what it just rendered. Band rendering is a translate
  on top of the dpr scale in pdf.js's `transform`; the canvas is then pinned over its band with inline
  `left/top/width/height`, which is why `.pdf-viewer-page > canvas` uses `top/left`, not `inset: 0`.
  **Capping the SCALE instead would have been ~10 lines and is the wrong trade** — zoom exists to read
  fine print, so going soft at high zoom defeats the gesture. Now flat with zoom: 923MB → 63MB.
- **Rasterize off-screen, then blit.** Sizing a canvas wipes it, so rendering in place left the page
  blank white for the length of every zoom step — and, now that a scroll at zoom can re-render, for
  those too. Cold and warm paints both blit: Chromium antialiases a direct first paint differently,
  so a shared route is needed for pixel-exact restoration after native emphasis is switched Off.
- Canvas **bitmaps are windowed**: only pages within `EVICT_BEYOND` (3) of the viewport hold one
  (~25-31MB each at Retina fit-width); scrolled-away canvases are freed and re-rendered on approach,
  and pages further than `CLEANUP_BEYOND` (12) also get `page.cleanup()` so pdf.js releases their
  parsed operator list and decoded images — the canvas is only half of what a page costs. That window
  is deliberately much wider than the eviction one: re-rendering from a retained operator list is
  cheap, re-parsing the page is a worker round-trip.
- **The PDF's own links work** (`pdfLinks.ts` + the `.pdf-link-layer` per page). Hand-rolled over four
  stable public pdf.js calls (`getAnnotations`, `getDestination`, `getPageIndex`,
  `convertToViewportPoint`) rather than pdf.js's `AnnotationLayer`, which needs a `linkService` shim
  against an unexported interface plus a viewer stylesheet that mostly styles form widgets this app
  never renders. Geometry is in **page percentages out of the rotated viewport**, so a layer is built
  once and every zoom rescales it free — and, unlike the text layer, it needs no CSS rotation.
  External URLs are `<a target=_blank rel=noopener>` (pdf.js pre-sanitizes `data.url` to
  http/https/ftp/mailto/tel); in-document jumps are `<button>`s that resolve their destination **on
  click**, not at build time — a table of contents has hundreds and each resolution is a worker
  round-trip. Links sit *above* the text layer or they'd never be clickable, so a text-selection drag
  switches them off via `.pdf-selecting` (the same trick pdf.js's own viewer uses). A link that wraps
  lines carries QuadPoints and becomes one box per line.
- **Page indicator / jump box**, left of the zoom pill. Written straight into an **uncontrolled
  input** on each scroll pass — holding it in React state would re-render the whole page column at
  every page boundary, and the page divs' inline ref callbacks churn on re-render. `scrollToPage` (and
  the position restore) **`Math.ceil` the target**: page tops are fractional but the browser snaps
  `scrollTop` to whole device pixels, so an exact `tops[i]` can land a hair *above* page i and the
  indicator then reads i-1 — the reading that then gets persisted. Blur only commits a number that
  changed *since the box took focus* — the box is deliberately not refreshed while focused, so
  comparing against the live page instead would let a scroll-while-focused yank the view back. At the
  document's bottom the box shows the last *visible* page, not the one under the top edge: a short
  final page can never reach the top edge, so otherwise jumping to it would snap the box back one.
- **Position persistence**: `{page, offset-into-page, zoom}` per vault path, in ONE record shared
  with the annotate canvas (`utils/pdfViewState.ts`) — pressing annotate lands on the page being read,
  and leaving it reopens the reader where writing stopped. Geometry changes (zoom, resize, reload, the
  byte-swap after an annotated save) re-anchor scroll from it. **The reader reads it while RENDERING**,
  in the same commit that unmounts the canvas, so the canvas updates the in-memory record every view
  pass (`writePdfViewPos(…, false)`) and only debounces the flush to storage; a debounced in-memory
  write reopened the reader behind.
- **The air between the tab strip and page 1 is an inset on the scroll BOX**, never content:
  `.pdf-viewer-scroll`/`.pdf-thumbs` take `top: var(--pdf-top-gap)` (16px, = `pagedCanvas.ts`'s
  `PAGE_TOP_GUTTER`, so page 1 opens with the same air in both modes — **only page 1**: Annotate's
  gutter is inside the camera bounds, View's inset is outside the content and holds at every scroll
  position, so deep in a document the annotated page still meets the strip). The viewer's
  own `PAD_V = 20` proves why: it is inside the scrollable content, and the re-anchor effect always
  scrolls *to* `layout.tops[page]`, so it is scrolled straight past on every open and every restore.
  **Do not give page 1 a `margin-top`** — DOM positions would then disagree with `tops[]`, which every
  scroll, window and anchor decision reads, and that drift is what gets persisted. **Do not re-anchor
  to `tops[page] - gap`** either: self-consistent for page 0 only, and for any later page it lands
  above that page's edge, which is the "jump to 9, box reads 8" trap the `Math.ceil` above closes.
- **Page thumbnails** (`components/PdfThumbnails.tsx`, both modes, toggled from the controls, open
  state app-wide in localStorage): **windowed** (rows exist only near view; heights come from page
  aspect ratios, so nothing is measured), **one render at a time** nearest the middle, re-decided after
  each (a scrolled-past row is never rendered), JPEG object URLs capped at 160. The current page is
  pushed through an **imperative handle**, never a prop — a prop would re-render the host, and for the
  reader that is every page div. The reader keys it on `docState.gen` so a reload gets a fresh cache,
  and its renders go straight to the document rather than through the render window's page states.
- **Invert is a view-only CSS filter** (`PdfInvertToggle`, a live store in `pdfViewState.ts` so every PDF
  on screen and both modes flip together). `invert(1) hue-rotate(180deg)`: paper goes black, text white,
  and colours keep roughly their hue. A partial invert (0.88) shipped first and read as washed-out
  grey rather than inverted; keep it full. The reader filters the page `<canvas>` elements only,
  never the page box, so text selection and links keep their colours. Annotating filters tldraw's
  `.tl-shapes` layer, pages AND ink together, because inverting only the pages leaves default black
  ink invisible; the background, selection overlays and tldraw's UI are other layers. **Notebooks use
  the same toggle, the same store and the same `.tl-shapes` filter**, so ruling and writing flip
  together. Nothing is re-rendered on a toggle, and exports render shapes themselves, so a saved PDF
  never sees it: a notebook exported while dark is still printed on white paper.

## `i` inverts a selected picture — `components/invertibleImageShape.tsx`

The second fork in `CANVAS_SHAPE_UTILS` (same `type: 'image'`, so it substitutes as the draw one
does). A screenshot taken out of a dark app is a black rectangle on ruled paper; `i` flips it.

- **The flag is `shape.meta.inverted`**, not an asset edit and not a CSS rule. Meta rides along in
  the document snapshot every canvas file already writes, so it survives a reload, undoes with ⌘Z,
  and leaves the image asset alone — the same picture can be inverted in one place and not another.
- **Two methods, both delegating**: `component` wraps tldraw's own output in a `filter`ed div (GPU
  composited, so an inverted picture costs no more to pan than any other), and `toSvg` wraps it in a
  filtered `<g>` — which is what makes a notebook's PDF export print what the screen showed.
- **The key is bound per editor on its container in the CAPTURE phase** (`bindImageInvertKey`, called
  beside `applyPenDefaults` in all three canvases), never on the window: a second canvas in the next
  column must not answer for this one's selection. It is cancelled only when an image was actually
  inverted, so with nothing selected `i` stays whatever tldraw makes of it, and it stands down while
  a text shape is being edited.

## The pen is a forked draw shape — `components/tightDrawShape.tsx`

All three canvases pass `shapeUtils={CANVAS_SHAPE_UTILS}`, which substitutes tldraw's draw shape (same
`type: 'draw'`, so `mergeArraysAndReplaceDefaults` swaps rather than adds). It exists for ONE number.

- **`streamline` is the only thing that decides how far ink trails the pen**, and tldraw does not
  expose it: `getFreehandOptions` is module-private in `lib/shapes/draw/getPath.js`, called from
  DrawShapeUtil's own methods, taking nothing from the editor. There is no hook. Re-rendering the
  shape is the only route.
- **Measure it on the CENTRELINE, never the rendered outline.** `getStrokePoints` gives the smoothed
  centreline before any width is applied; comparing its last point to the last raw input point is the
  honest number. Measuring the outline's leading edge instead conflates tracking with stroke
  thickness — a fatter stroke reaches nearer the nib while tracking no better, which is exactly how an
  earlier attempt "proved" a 2x win that was not there. Width has *zero* effect on tracking: identical
  lag at 3, 4.6, 6 and 10px.
- Measured at 12px between input points: streamline 0.64 → 7.79px behind the pen, 0.62 → 7.05px,
  0.40 → 2.10px, **0.01 (ours) → 0.00px**.
- **`dash` stays `'solid'`** (pinned in `canvasPen.ts`) because it is what keeps stroke width even.
  tldraw only consults `isPen` when dash is `'draw'`, so a stylus never reaches `realPressureSettings`
  here — that branch buys 0.74px and costs pressure-varying width.
- **Four methods are overridden and every one of them matters**: `component` (the ink), `getGeometry`
  (or clicking a stroke misses it by ~5px), `getIndicatorPath` (or the selection outline floats beside
  the ink), and `toSvg` (or the notebook's PDF export quietly uses tldraw's smoothing and differs from
  the screen). Each delegates to `super` unless `dash === 'solid'`, so what is owned across upgrades is
  one branch, not a renderer.
- **`components/PenDevPanel.tsx` is how this number gets chosen** — dev-only, portalled to `<body>`,
  slider plus presets, applying to the NEXT stroke so a canvas can hold strokes at several settings
  side by side. It is gated on `import.meta.env.DEV` and carries its own CSS in a `<style>` tag rather
  than `index.css`, so markup, logic and styles all leave the production build together (verified by
  grepping `dist`). **Reach for it before touching `PEN_STREAMLINE`**: the arithmetic predicted 0.35-0.45
  would be the floor and drawing on a real tablet disproved it.

## The page list is built once, and its refs never move

A document's page boxes are a `useMemo` over the layout, and each box's three refs come from
`pageRef(kind, i)`, which hands back **the same function** for a slot every time.

**Inline `ref={el => ...}` is a new function on every render, so React detaches and reattaches every
one of them** — 1,200 ref calls on a 400-page document, each detach writing `null` into the very
arrays the render loop reads, plus the reconciliation of 400 boxes. The viewer re-renders for the
page number, the zoom, the native notice and its own visibility, so this was paid constantly, and
the cost tracked PAGE COUNT rather than anything on screen: switching back to a 400-page PDF took
305-757ms, against 128ms for a twelve-page one. With stable refs and the memo it is 44-264ms, and a
400-page document costs about what a small one does.

So: no inline ref callbacks in the page list, and nothing that rebuilds `pageEls` per render.

## A PDF's fingerprint is computed only if a write needs it

`seedPdfBaseline` records the HANDLE; `pdfSeedFor` does the read, at the one moment the answer is
needed (a write, where it is awaited anyway), and not at all when the pane has already supplied the
version through `onReaderVersion` — which for any PDF actually opened is always. Eagerly
fingerprinting at open meant the file was read and SHA-256'd TWICE before its first page appeared:
measured on a 10MB document, 19MB read and 19MB hashed, scaling straight up with the file, so a
100MB scan paid 200MB of it.

## A hidden pane must let go

Panes stay MOUNTED when another tab is shown and are hidden with `visibility` — that is what makes
coming back instant — so **the pane has to be told, or it goes on working for a reader who is not
there.** `PdfViewer` takes `isVisible` (not `isActive`, which is keyboard focus) and on the way out:

- **evicts every page bitmap.** Eviction lived only inside `updateWindow`, which runs on scroll and
  layout, so a hidden pane never reached it and kept the band it had rastered — at dpr, per open
  PDF. Measured with two documents open behind a whiteboard: **322 canvases, 62MB of bitmaps, none
  of it on screen → 3MB**. A scanned book at a real page size is far worse.
- **stops the eager text pass.** Up to `TEXT_EAGER_LIMIT` (300) `TextLayer.render` calls, each with
  a worker round trip, were still running after the reader had switched to a whiteboard — which is
  exactly when tldraw is mounting and wants the main thread. It resumes where it left off.
- **stops committing resizes.** The slot is a percentage of its column, so every sidebar toggle and
  window resize re-fit and re-rastered the hidden panes too. The last width is applied on the way in.

What is KEPT: the pdf.js page objects and the text layers (⌘F still works), and the scroll position.
Coming back re-rasters the band under the viewport, which is the work a scroll already does.

## Tldraw's assets are OURS

`assetUrls={CANVAS_ASSET_URLS}` on every `<Tldraw>` (`canvasPen.ts`), from `@tldraw/assets` pinned
to the same version. By default tldraw fetches fonts, icons and translations from `cdn.tldraw.com`:
measured, **37 off-origin requests to open one whiteboard**. A local-first app holding the vault's
directory handle does not need a third party to be up in order to draw a line. `maxFontsToLoadBeforeRender: 0`
too — tldraw waits for every font before it paints anything, and ink needs no font.
`@tldraw/assets` stays in `optimizeDeps.exclude` (`vite.config.ts`): pre-bundled, its `?url` imports
all come out `undefined` and every canvas throws on open under `npm run dev` — never in a build.

**`colorScheme` is frozen at mount.** It is in `<Tldraw>`'s editor-creation dependency list
(@tldraw/editor 5.2.4, `TldrawEditor.mjs:279`), so changing it DESTROYS the editor and builds a new
one — on every mounted board at once, hidden ones included, losing each one's undo history. The app
theme is global, so a toggle hit all of them: measured, **18 `AtomMap: key not found` page errors per
toggle**. The theme moves through `editor.user.updateUserPreferences` instead, which re-themes in
place. The same applies to `options`, `assetUrls`, `shapeUtils` and `components`: all module
constants, and they must stay that way.

## Panes

- **Every canvas floats over its column, one pane per open tab**: `PdfPane` for PDFs and `CanvasPane`
  (whiteboards and notebooks) — EditorPane maps over both lists — hidden via `.pdf-pane-hidden` /
  `.canvas-pane-hidden` (visibility) when off screen, so a *tab* switch keeps the document, the
  reading position or camera, the selection and the undo history. A canvas that lived in the slot was
  destroyed and rebuilt on every switch, which is what made returning to a board expensive: measured
  on a production build, a 1,200-shape board carrying 12 screenshots cost 150-250ms per return with
  106-185ms of it blocking the main thread, against ~0 once it stopped remounting.
- The behaviour the float buys is **per tab switch, not unconditional**: `App.tsx` renders
  `mainView === 'graph' ? <GraphView/> : <EditorPane/>`, so opening the Neural Brain view unmounts
  `EditorPane` and with it every float. Markdown notes come back intact (their `EditorState` cache is
  App's — undo, selection and search panel survive); every open PDF and board rebuilds. Existing
  behaviour, not a designed one.
- Panes lazy-activate on first being shown — `useActivated` in `floatingSlot.ts` — so a restored
  session with five canvases in the background touches neither disk, nor pdf.js, nor the tldraw chunk
  for the four nobody is looking at. Only the annotate canvas is torn down when its tab is
  backgrounded: unmounting tldraw is what flushes pending strokes.
- **A float has to be handed the keyboard explicitly.** It outlives the tab switch, so nothing
  re-focuses it the way a remount used to: `CanvasPane` registers a `registerKeyboardTarget` that
  focuses tldraw's own container, and without it a board returned to from the tab bar took no
  shortcut, ⌘Z included, until it was clicked. The view re-read is driven by **this tab's `dirty` falling edge**,
  not a global `saveEpoch` (which reloaded the view — and its scroll position — whenever *any* file
  autosaved).
- The PDF panes stay **outside** the pane slots on purpose — one is mounted per open PDF tab and
  merely hidden when off screen, which is what keeps a tab switch from reloading the document, and a
  pane that only exists while its tab is shown could never do that. Its column arrives as an inline
  `left`/`width` pair; the offset below the strip and the pane header is CSS (`.pdf-pane`'s `top`),
  because those heights are the stylesheet's to know — ONE offset, not two, since every pane wears a
  header now, at one pane as at five. `isVisible` (drawn, activated, canvas mounted) and `isFocused`
  (the +/− zoom keys) are separate, because two PDFs can be on screen at once. Two consequences of
  floating over a slot rather than sitting in it, both load-bearing:
  - **A surface positioned over a slot has to report focus for that slot itself.** `DocumentPane`
    takes focus from a mousedown anywhere in `.editor-slot`, which a PDF's clicks never reach — so
    clicking a PDF left ⌘E, ⌘S, the pane header's View/Annotate toggle and the +/− zoom keys all
    acting on whichever neighbour was focused before, with the 32px pane header the only way to hand
    focus over.
    `PdfPane` therefore calls `onFocusPane` from a capture-phase pointerdown on its own root.
    **Anything else EditorPane ever floats over a slot inherits this and must do the same.**
  - **A hidden pane keeps the geometry it was last shown at.** `.pdf-pane-hidden` is only
    `visibility: hidden`, so the box still takes part in layout; letting the pane's column geometry
    collapse to a lone full-width pane when its tab went to the back resized it, which tripped
    `PdfViewer`'s `ResizeObserver` into a full re-fit and a re-rasterization of every windowed page
    for a document nobody could see — on every tab switch, and again on the way back. What is retained
    is the resolved **rectangle**, because a slot index and a pane count no longer determine a width,
    and the *visible* case addresses its column through the split's CSS variables instead. Those two
    are the same decision from both ends: a hidden pane that kept reading the variables would be
    dragged around behind whichever tab replaced it.

## Annotate mode

A tldraw canvas over rasterized pages that are **locked backdrop image shapes, excluded from the
exported overlay** (tracked by id). Two modes rather than one because a rasterized page has no
selectable text.

**The backdrop re-renders to match the zoom.** pdf.js dropped its SVG backend in v4, so a page can
only ever be a bitmap; at 400% a 2x raster is mush under a pen whose ink is vector and stays crisp.
A debounced pass re-rasterizes the pages **inside the viewport** at `zoom x devicePixelRatio`,
stepped and capped at `MAX_PAGE_SCALE` (6x — a Letter page is then ~70MB decoded), and drops pages
you have left back to `PAGE_RENDER_SCALE`. The swap goes through `refreshPageAsset`'s
`mergeRemoteChanges` so it never marks the file dirty. The pass is serialized behind an in-flight flag —
overlapping runs would render one page at two scales and leak the loser's object URL.

**Pages are rasterized only as they come near the view**, nearest the middle first, re-deciding after
each page (so jumping to page 300 renders page 300). It used to render EVERY page in order before the
first was needed, and `zoomToFit()` on a first open — on a long PDF, every page at once, unreadably
small. Now the camera opens on the reader's page at the reader's fit-width size (`cameraFor`), always,
overriding the snapshot's camera, which knows nothing of where the reader has been since.

**The camera is held to the document** (`lockCameraToPages` in `components/pagedCanvas.ts`, shared with
notebooks). `setCameraOptions` constraints with `behavior: 'contain'`,
bounds = the whole page stack, `baseZoom: 'fit-x'` and **no horizontal padding**: below fit-width the
page is pinned centred, above it the camera clamps to the real page edges, so fit-width is edge to edge
and zooming further simply goes further in. **Swipes are vertical-only**: a capture-phase `wheel`
listener on `.paged-canvas` (an ancestor of tldraw's own) swallows every non-ctrl wheel and
applies only `deltaY`; pinches arrive as ctrl+wheel and pass through to tldraw's zoom. Because the
bottom is clamped, the page box shows the last visible page once the view is held against the end of
the document — the reader's rule, or typing the last page reads back an earlier one.

View tracking (`watchPageView`: page box, strip, position record, missing-page and sharpen passes) runs off a
tldraw **`react()` on `getViewportPageBounds()`** — it fires when the view moves, not on every pointer
move while drawing, which is what the session-scope store listener it replaced fired on.

The serialize debounce is 1500ms — far longer than a drawing's 400ms — because a PDF export
rebuilds the whole document on the main thread. `flush()` buckets shapes by page **once** (not a
per-page re-filter, which was O(pages × shapes)) and caches each page's exported `PageOverlay` by a
JSON signature of that page's shapes, so an untouched page is not re-exported. On unmount with
unsaved work it calls `onFlushStart()` synchronously (beating the viewer's re-read) and then flushes
immediately.

# Notebooks (`.notebook`)

Files: `paper.ts` (page stacking + the ruled-paper model, **imports nothing**),
`notebookFile.ts` (the on-disk shape), `notebookRenderCache.ts` (canvas→export handoff),
`NotebookPane.tsx`, `pdfBuild.buildNotebookPdf`.

A notebook is **a drawing on generated pages**: the same tldraw canvas as the PDF annotator, over
locked backdrop image shapes, but the pages come from a `paper` block instead of a document.

- **`paper` is the authority; the pages are reconciled to it BY SHAPE ID on every open**
  (`layOutPages`). Never re-create them — `createShapes` appends to the top of the z-order, so a
  rebuild lays blank pages OVER the writing. Same trap as PdfAnnotateCanvas's backdrops.
- **The page backdrop is a real SVG data URI**, resolved through the asset store from a stable
  `asset:notebook-paper` reference. This is the one backdrop in the app that is genuinely
  resolution-independent — pdf.js has no SVG backend, but `paperSvg` is ours — so a notebook needs
  no zoom-refinement pass and no per-zoom memory. Every page is identical, so ONE asset serves all.
- **`updateAssets` validates the WHOLE record.** Passing only the changed props fails on the ones
  left out (`props.name: expected string, got undefined`), and spreading the existing props hits
  TLAsset being a union. `layOutPages` therefore states every field and picks create-vs-update.
- **A `TLEditorSnapshot` is `{document, session}`** — the store is one level down, inside `document`.
  `parseNotebookFile` tests for `document`; testing for `store` is always false and the failure is
  silent and total (paper restores, every stroke vanishes, file on disk still holds them).
- ⚠️ **The pages are LOCKED, and `updateShape`/`deleteShapes` SILENTLY SKIP locked shapes.** Every
  page mutation therefore runs inside `editor.run(..., { ignoreShapeLock: true })`. Without it the
  paper SVG regenerated at the new size while every page box kept the old one — which is what
  "landscape doesn't rotate the pages" turned out to be.
- **Deleting a page takes the writing on it**, so it asks first through App's own confirm (threaded
  down as `onConfirm` beside `onNotify`). Only the LAST page, and only ever removed — pages are a
  stack, and an "empty" page may be one deliberately left blank.
- **Pages grow as you write** (`growIfNeeded`, run just before each serialize): ink within 20% of the
  last page's bottom appends however many pages the overflow needs. Pages are only ever ADDED —
  removing an "empty" one would discard a page left blank on purpose.
- **It scrolls like a PDF and has the annotator's page strip and page box** (`pagedCanvas.ts`,
  `PageControls`, `PdfThumbnails`). `layOutPages` is the one place the page stack changes, so it is
  where `lockRef.setPages` re-bounds the camera. A thumbnail is the page's region through
  `editor.toImage` with `bounds`, as the PDF export renders it. A document-scope store listener
  collects the pages each changed shape touches (live bounds, plus the record's `y`, which is all a
  removed shape leaves) and calls the strip's `invalidate` 700ms after the pen pauses; the old image
  stays up until its replacement lands. The strip is keyed on the paper's LOOK, not its page count:
  an appended page leaves every existing thumbnail valid. A first open starts at page 1, full width;
  a reopen keeps the snapshot's camera, re-applied so the lock clamps it. The page box is judged just
  under the gutter, not at the view's top edge: a notebook's gutter (56px, to clear its toolbar) is
  wider than the gap between pages, so the edge sits in the page above and "jump to 3" read back 2.
  **The paper toolbar is tldraw's `TopPanel`** (a stable component fed by context), not an overlay
  centred with CSS: that one slid under tldraw's top-left menu the moment the strip narrowed the
  canvas, hiding the ruling picker.
- **Re-papering reaches the store as a `mergeRemoteChanges`**, so the save listener does NOT see it;
  `changePaper` calls `persist()` itself. One `persist` writes paper + snapshot + pickers together,
  because they share a file.
- **Export writes a sibling `.pdf` and deliberately OVERWRITES it** — the app's one exception to
  never-overwrite, since the name is derived from the notebook's and can only be its own export.
  App asks first unless this session already wrote that name. The ruling is drawn with `drawLine`,
  mirroring `paperSvg` by hand: `paper.ts` is in the main bundle and must stay free of pdf-lib.
- Colours in `pdfBuild`'s ruling constants and `paper.ts`'s SVG are **two copies of one palette** —
  change both.
- **An exported PDF carries a pointer back** (`NOTEBOOK_SOURCE_ATTACHMENT`, plus a human-readable
  `Producer`), and `App.handleAnnotatePdf` follows it: pressing the pen on a notebook's export opens
  the NOTEBOOK. Without that it fell into the ordinary PDF flow and forked a third file whose strokes
  the notebook could neither see nor overwrite. Resolution is the stored path first, then a notebook
  beside the PDF answering to its name (which covers renaming either); when neither resolves it says
  so rather than silently forking. Told by CONTENT, never filename — the format's standing rule.

# The pen panel, and chrome vs paper

`CanvasStylePanel.tsx` (the component) + `canvasPen.ts` (`CANVAS_COMPONENTS`,
`applyPenDefaults`) + `utils/penStyle.ts` (the store) replace tldraw's `StylePanel` in **all three**
canvases. Split across two files because `react-refresh/only-export-components` is relaxed for
`src/context/**` only, so a component and a helper cannot share a file.

- **The pen is PER FILE, and per open editor.** `penStyle` keys on the live `Editor` in a WeakMap,
  not one app-wide value, because a split shows two canvases at once and each answers to its own
  file. `canvasPen`'s `CanvasUiState` (`toolId` + `stylesForNextShape` + `penScale`) is the one shape
  all three canvases write into their file's `ui` key — tldraw's own snapshots carry NO styles
  (`TLSessionStateSnapshot` is camera and selection only), which is why an annotated PDF used to
  reopen with the default pen while drawings and notebooks did not. `applyCanvasUi` must run BEFORE
  `applyPenDefaults` (whose shape handler reads the seeded width) and before the save listeners
  attach, or restoring a file marks it dirty. An unseeded file inherits the last width used anywhere
  (localStorage) rather than snapping to the default.
- **Width changes touch no tldraw store**, so the panes also `subscribePenScale` — the session
  listener alone never sees them, and the width was only remembered if you happened to draw after.
  `PdfAnnotateCanvas` deliberately does NOT: its save rebuilds the whole document (~150ms/page), so
  the pen rides the next stroke's flush instead of stalling under a colour click.
- **Width is `props.scale`, NOT the `size` style.** tldraw's thinnest, `s`, is `(2*1 + 1) = 3px`;
  handwriting on ruled paper needs less. `size` is pinned to `s`, `dash` to `solid`, and a
  `registerBeforeCreateHandler` stamps `scale` on every new shape that HAS that prop — `scale` is an
  ordinary prop, not a StyleProp, so `stylesForNextShape` cannot carry it. The slider is logarithmic
  (half its travel is below the default) and `penStyle.ts` is an external store, not per-pane state,
  because a split can show two canvases at once.
- **Swatch colours come from `editor.getCurrentTheme().colors[editor.getColorMode()]`**, never a
  hard-coded list: the same `'black'` is `#1d1d1d` on a pinned-light page canvas and `#f2f2f2` on a
  dark whiteboard, and a swatch has to show the ink you will actually get. (`--tl-color-<name>` does
  not exist; tldraw's CSS vars are semantic — panel, text, low, divider…)
- **CHROME FOLLOWS THE THEME; PAPER NEVER DOES.** The canvases stay `colorScheme="light"` for ink
  correctness, and `index.css` themes everything around the page by remapping tldraw's own
  `--tl-color-*` on `.notebook-pane`/`.pdf-annotate-pane .tl-container` (plus the
  `--canvas-chrome-*` variables). Restyle the variables, not the widgets. A `.tldraw` whiteboard is
  excluded from the *chrome* theming on purpose: no pages, so its whole surface is the drawing
  surface — and that surface takes exactly one remap of its own,
  `--tl-color-background: var(--background-primary)` on
  `.drawing-pane:not(.notebook-pane):not(.pdf-annotate-pane) .tl-container`, because the whiteboard
  IS the page under the active tab and must be the tab's colour. The `:not()`s are load-bearing:
  notebooks and PDF-annotate panes also wear `.drawing-pane`, so **without** them this rule and the
  `--canvas-surround` one below would tie at (0,2,0) on the same element and source order would
  decide. With them the two are disjoint, (0,4,0) against (0,2,0), and order stops mattering.
- **One `tlui-` selector exists, and it is the exception that proves the rule above**:
  `.drawing-pane .tlui-layout__top__left { padding-top }`, because tldraw notches the menu zone into
  the top-left corner with no margin and it butted the tab strip. Padding the layout *column* rather
  than the widget keeps the zone's bottom-right-only radius correct and leaves `__top__right` (the
  style panel, which sets its own margin) and `__top__center` (the notebook toolbar) alone;
  `CenteredTopPanelContainer` measures only `offsetWidth`, so a `padding-top` moves nothing it reads.

# Drawings (`DrawingPane.tsx`, tldraw)

Mounted inside `CanvasPane`, the float that keeps it alive across tab switches (see **Panes**), so a
`DrawingPane` unmount now means the tab closed, the file reloaded from disk, or the graph view opened
— not merely that the reader looked at something else.

A `.tldraw` file is a tldraw snapshot **plus an extra `ui` block** (current tool +
`stylesForNextShape`, which tldraw's own snapshots omit). Parsed **once per file, keyed on
`filePath` alone**, not per render (`content` churns on save round-trips but tldraw owns the doc after
mount; re-parsing would clobber in-progress edits — the `exhaustive-deps` disable there is
deliberate). Serialize debounce 400ms → the app's 1s save, but see `serializeDelay` below.

**All three canvases pass `CANVAS_OPTIONS` (`canvasPen.ts`) to `<Tldraw>`, and must.** tldraw stops
creating shapes at `maxShapesPerPage` (default **4,000**) and does it *silently* — the refusal is a
`max-shapes` event nothing listens to, so a full board just stops taking ink. Measured: at 4,200
shapes, 8 drawn strokes produced 0 new ones. It is 1,000,000 here, finite because the render pass
builds z-indices out of it.

**Saving a canvas is O(document), not O(stroke)** — the whole store is stringified, hashed and
written per change burst (~1.7MB at 4,000 shapes). `serializeDelay(editor, base)` therefore scales
the debounce with the shape count (to 2s), and the drawing/notebook timers re-arm instead of firing
while `editor.inputs.isPointing` — serializing underneath a moving pen is what the lag was. Measured
on a 3,900-shape board, one ~6s stroke: 665ms blocked / longest stall 136ms → 435ms / 75ms. Anything
that lengthens that debounce owes a matching flush: unmount, `flushPending` **and `pagehide`**.

Drawing/notebook `store.listen` is scoped `{source:'user', scope:'document'}`; PDF annotation uses
synchronous user-only shape/asset/binding side effects, because a deferred listener missed immediate
flushes. PDF exports serialize and snapshot before awaiting overlays; App awaits pending export before
leaving annotation. FontManager cleanup waits for in-flight document fonts, avoiding late updates to
its disposed map. Programmatic loads and camera moves don't dirty the file; a separate session-scope listener only reschedules a save when the UI-state
slice actually changed. Unmounting mid-debounce flushes synchronously. `getEfficientZoomLevel` is
patched to defeat tldraw's below-50%-zoom thin-line LOD under `FULL_INK_SHAPE_LIMIT` shapes.

**Env:** `VITE_TLDRAW_LICENSE_KEY` — required in production only. Without it, tldraw (drawings + PDF
annotate) replaces the canvas with an empty gate 5s after load on any non-localhost HTTPS origin.
Localhost counts as development, so a missing key never shows up in `npm run dev`.

# File-type routing (`utils/fileTypes.ts`)

`.tldraw` → `DrawingPane`, `.notebook` → `NotebookPane`, `.pdf` → `PdfPane`, everything else textual
→ CodeMirror. Note the deliberate split between two predicates: **`isTextFile` (vaultSearch)** =
shown/indexed as text; **`isCanvasFile`/`isPdfFile` (fileTypes)** = which pane. A drawing and a
notebook *are* text on disk (JSON snapshots) so they flow through `readFile`/`writeFile`/autosave,
but they must **not** be shown or content-indexed as text — `isCanvasFile` is the predicate that
covers both, and every site that used to say `isDrawingFile` for that purpose now says it.

## The AI agent on a canvas (`components/canvasAgentOps.ts`)

- Each canvas pane (drawing, notebook, PDF annotate) registers a view reporter with `canvas` ops
  (`shapes`/`apply`/`currentPage`) plus `capture(maxSide)` (a viewport PNG via `editor.toImage`, paper
  and PDF pages included, `darkMode: false`); the reader registers `pdfText`/`renderPage`/`capture`
  (visible page canvases stitched, uninverted). Page-relative coordinates for notebooks and PDFs come
  from the same `PageBox`es; a live shape belongs to the page under its vertical centre (a closed file's
  summary, `canvasFileSummary.ts`, uses its top-left).
- **Agent edits must save exactly like a pen stroke** — and do: they go through the editor API inside
  one `markHistoryStoppingPoint` + `editor.run` (one ⌘Z), which `@tldraw/store` records as
  `source: 'user'` (only `mergeRemoteChanges` is `'remote'`), so every pane's existing
  user/document change handler serializes them; a PDF still rebuilds from the pristine
  original. NEVER apply agent ops headless or as a remote merge.
- Page backdrops (ruled paper, PDF page images) are never listed; locked shapes are listed but never
  targetable. Agent shapes get every style set explicitly and `scale` reset to 1 — `applyPenDefaults`
  would otherwise stamp the user's pen onto them.
- `pageText` exists in both `PdfViewer` and `PdfAnnotateCanvas` (and a third in
  `utils/pdfText.ts`): change them together.

## Canvas positions (`utils/canvasViewState.ts`)

Drawings and notebooks now reopen where they were left, like PDFs: localStorage record
`canvasViewPositions` under `scopedKey` — a drawing's `{pageId, x, y, z}` (watched with a tldraw
`react()` on the camera, NOT a session-store listener that fires per pointer move; 400 ms debounce,
flushed on unmount and `pagehide`), a notebook's `{page, offset, zoom}` (from `watchPageView`, restored
through `cameraFor`). A first open with no record behaves as before. Like the other path-keyed
records it does not follow renames and is never pruned.


Original and extracted Text share PdfDocumentSession with document/page leases; release, never direct page.cleanup while another consumer can use it. pdf-page-v1 replaces three old trim/collapse reporters with exact returned strings/order/EOL. PdfPane consumes the central PdfReadingBinding: displayed version, full-token surface controller, shared preferences and validated synchronous Text records. Original camera memory updates precede header actions; Text→annotation maps through Original before mounting the canvas. The actual Text reporter has no image-capture fallback. Word emphasis uses PdfReadingBinding.emphasisEnabled to paint original glyph ink in the retained Viewer/annotation backdrops; no Text transition. pdfNativeEmphasis is exactly pinned to pdf.js 6.1.200 glyph/font/paint contracts; re-audit on upgrade. Completed native renders compare a temporary counterpart pixel-by-pixel before publishing capability (clips/off-page/white/occlusion can hide successful calls). OFF output stays original; the discarded ON probe supplies visibility. High-zoom bands assess the whole page with a bounded probe. Annotation refresh chooses one visible/near stale backdrop at a time, rechecks the viewport after each await and cancels stale renders; distant cached emphasis is refreshed on approach. Only current-page results publish capability. Text is manual and emphasis-inactive; readerViewState migrates unmarked legacy Text records to Original and stamps new explicit Text writes with textChoice:manual. No source/annotation/history changes from preference painting.

PDF Text native Copy, custom Copy and selected-text reporting share page-model selection extraction.
Only page bodies contribute text; page controls/quality notices never enter that canonical slice.
