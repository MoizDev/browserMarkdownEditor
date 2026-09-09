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

## Deliberate module fragmentation is for bundle size — do not collapse it

pdf-lib (~400kB) + pdf.js must stay out of the main bundle for markdown-only sessions. There is no
manual chunk config in `vite.config.ts`; the split is achieved **entirely by source-level import
discipline**, so a single new import undoes it silently:

- `pdfRenderCache.ts` and `pdfFormat.ts` import no PDF libs at all (`pdfFormat` is pure strings).
- `pdfLinks.ts` imports `pdfjs-dist` **for types only**.
- The builder is dynamically `import()`ed only at the two write sites.
- Reader (pdf.js) and writer (pdf-lib) **never import each other** — they share names via `pdfFormat`.
- The writer runs in a **DOM-less Web Worker**, so `pdfBuild.ts` must never reach for the DOM.
- `PdfPane` is `React.lazy` in `EditorPane`, `PdfAnnotateCanvas` is `React.lazy` in `PdfPane`, and
  `DrawingPane` is `React.lazy` in `DocumentPane` — so viewing a PDF never pulls in tldraw.

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
  decision — both trade away ⌘F completeness.** (`content-visibility: auto` on `.pdf-viewer-page`
  looks like the free answer and **is not**: measured 533.8MB → 542.1MB, slightly worse, because Blink
  does not tear down layout structures already built.) The eager pass is keyed on a `hasLayout`
  boolean rather than the `layout` object identity, so a zoom or resize does not restart 300
  iterations.
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
- **Position persistence**: the viewer tracks `{page, offset-into-page}` (+ zoom) on scroll and
  persists it per vault path to localStorage `pdfViewPositions` (debounced); geometry changes (zoom,
  resize, reload, the byte-swap after an annotated save) re-anchor scroll from that record.

## Panes

- **One `PdfPane` is mounted per open PDF tab** (EditorPane maps over PDF tabs), hidden via
  `.pdf-pane-hidden` (visibility) when off screen — so *tab* switches keep the document and reading
  position. Note the limit of that guarantee: `App.tsx` renders
  `mainView === 'graph' ? <GraphView/> : <EditorPane/>`, so opening the Neural Brain view unmounts
  `EditorPane` and with it every pane, every pane's `EditorView`, and the per-path state cache — i.e.
  a graph visit *does* drop per-tab undo history and reload open PDFs. That is existing behaviour, not
  a designed one.
- Panes lazy-activate on first being shown (a restored background PDF touches neither disk nor pdf.js
  until then). Only the annotate canvas is torn down when its tab is backgrounded: unmounting tldraw
  is what flushes pending strokes. The view re-read is driven by **this tab's `dirty` falling edge**,
  not a global `saveEpoch` (which reloaded the view — and its scroll position — whenever *any* file
  autosaved).
- The PDF panes stay **outside** the pane slots on purpose — one is mounted per open PDF tab and
  merely hidden when off screen, which is what keeps a tab switch from reloading the document, and a
  pane that only exists while its tab is shown could never do that. Its column arrives as an inline
  `left`/`width` pair; the offset below the pane headers is CSS (`.pdf-pane-split`), because that
  height is the stylesheet's to know. `isVisible` (drawn, activated, canvas mounted) and `isFocused`
  (the +/− zoom keys) are separate, because two PDFs can be on screen at once. Two consequences of
  floating over a slot rather than sitting in it, both load-bearing:
  - **A surface positioned over a slot has to report focus for that slot itself.** `DocumentPane`
    takes focus from a mousedown anywhere in `.editor-slot`, which a PDF's clicks never reach — so
    clicking a PDF left ⌘E, ⌘S, the top-bar View/Annotate toggle and the +/− zoom keys all acting on
    whichever neighbour was focused before, with the 26px pane header the only way to hand focus over.
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
you have left back to `PAGE_RENDER_SCALE`. It is bounded to visible pages because **every** page is
held rasterized for the canvas's life. It rides a **second, session-scoped** store listener: a pan or
zoom must not mark the file dirty, which is also why the swap goes through `refreshPageAsset`'s
`mergeRemoteChanges`. The pass is serialized behind an in-flight flag — overlapping runs would render
one page at two scales and leak the loser's object URL.

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
  excluded on purpose: no pages, so its whole surface is the drawing surface.

# Drawings (`DrawingPane.tsx`, tldraw)

A `.tldraw` file is a tldraw snapshot **plus an extra `ui` block** (current tool +
`stylesForNextShape`, which tldraw's own snapshots omit). Parsed **once per file, keyed on
`filePath` alone**, not per render (`content` churns on save round-trips but tldraw owns the doc after
mount; re-parsing would clobber in-progress edits — the `exhaustive-deps` disable there is
deliberate). Serialize debounce 400ms → the app's 1s save.

`store.listen` is scoped `{source:'user', scope:'document'}` so programmatic loads and camera moves
don't dirty the file; a separate session-scope listener only reschedules a save when the UI-state
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
