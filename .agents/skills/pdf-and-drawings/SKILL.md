---
name: pdf-and-drawings
description: The canvas documents — the annotated-PDF read/write pipeline, the pdf.js viewer's rendering/windowing/memory strategy, and tldraw drawings. Load before touching any pdf* module, PdfPane/PdfViewer/PdfAnnotateCanvas/DrawingPane, or adding an import to any of them (the module split is load-bearing for bundle size).
---

# PDF annotation pipeline (the subtlest subsystem)

Files: `pdfAnnotation.ts` (read + rasterize, pdf.js), `pdfBuild.ts` (write, pdf-lib),
`pdfBuild.worker.ts` + `pdfBuildClient.ts` (off-main-thread), `pdfFormat.ts` (shared attachment
names), `pdfRenderCache.ts` (canvas↔save handoff), `pdfLinks.ts` (link annotations → boxes +
destinations), `PdfPane.tsx`, `PdfViewer.tsx` (view mode), `PdfAnnotateCanvas.tsx`.

An **annotated PDF (`<name> (annotated).pdf`) is a genuine PDF**: original pages + stamped
transparent stroke overlays + two embedded attachments — `original.pdf` (pristine) and
`tldraw-snapshot.json` (editable strokes). It opens in any viewer *and* reopens here as live tldraw
shapes. A plain PDF is told from an annotated one by **content** (is the `original.pdf` attachment
there), never by filename.

> **THE LOAD-BEARING RULE: every save rebuilds from the embedded pristine original, never the
> currently-stamped pages.** Rebuilding from stamped pages re-stamps strokes over themselves — each
> save darkens/duplicates annotations and inflates the file.

- The annotated tab's `content` buffer is the **tldraw snapshot string** (rides normal autosave).
  Building the PDF *also* needs the original + rasterized overlays, which only the live canvas can
  make — it parks them per-path in `pdfRenderCache` (kept **outside React state**; these are megabytes
  of binary that must never enter a re-render path or localStorage), and `flushTab` picks them up and
  calls `buildAnnotatedPdfAsync`. `movePdfRenderData` must follow a rename, or the tab's next save
  silently no-ops looking under the new path.
- `stampOverlay` handles the `/Rotate` trap: pdf.js *applies* `/Rotate` (canvas is landscape) but
  pdf-lib *ignores* it (`getSize()` returns the portrait MediaBox), so overlays are mapped back into
  user space by hand per rotation angle.
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

The serialize debounce is 1500ms — far longer than a drawing's 400ms — because a PDF export
rasterizes and rebuilds the whole document on the main thread. `flush()` buckets shapes by page
**once** (not a per-page re-filter, which was O(pages × shapes)) and caches each page's exported
overlay PNG by a JSON signature of that page's shapes, so an untouched page is not re-rasterized. On
unmount with unsaved work it calls `onFlushStart()` synchronously (beating the viewer's re-read) and
then flushes immediately.

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

`.tldraw` → `DrawingPane`, `.pdf` → `PdfPane`, everything else textual → CodeMirror. Note the
deliberate split between two predicates: **`isTextFile` (vaultSearch)** = shown/indexed as text;
**`isDrawingFile`/`isPdfFile` (fileTypes)** = which pane. A drawing *is* text on disk (a JSON
snapshot) so it flows through `readFile`/`writeFile`/autosave, but it must **not** be shown or
content-indexed as text.
