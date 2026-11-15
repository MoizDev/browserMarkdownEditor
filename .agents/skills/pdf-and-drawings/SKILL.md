---
name: pdf-and-drawings
description: The canvas documents — the native PDFium PDF pipeline and in-house PDF ink, the remaining Classic pdf.js viewer route, and native boards (drawings, notebooks, print/export, agent access). Load before touching any pdf* module, paper.ts, notebook*, PdfPane/PdfViewer/CanvasPane, components/whiteboard or src/whiteboard, or adding an import to any of them (the module split is load-bearing for bundle size).
---

# Native PDFium and in-house PDF ink

`src/pdf/` owns the contained native engine, pool, canonical text, tiles, fonts and writers;
`src/whiteboard/` owns the editable board and its renderability admission. Classic remains an
explicit separate route, never an automatic parser fallback. A production build without a qualified
ship artifact must keep the engine unavailable; development artifacts are never relabelled shipping.
Do not enable NativePdfPane merely because its acquisition API exists: its actual full tools must exist.

- App-owned source/session lifetime outlives a view. Hide/dispose releases view work, not transferred
  native source ownership (`session/ownedInkAcquisition.ts`). Match the full token/source and actual bytes.
- `acquirePdfInkSource` admits only plain/native or explicit read-only. Full AF/EmbeddedFiles union and
  Filespec `/Desc` determine roles; partial native attachment inventory or a filename cannot authorize
  editing. Never turn a refusal into an empty board or use `.Assets` for embedded PDF media.
- Legacy conversion is SEPARATE: `acquireLegacyPdfInkCandidate().prepare` requires Core's actual visual
  renderability gate, foreign-mark dialog and `NativeCanvasHost.keepConversionBackup` of the exact outer
  bytes. Carry its actual `legacyOriginalSha256` into readiness/build; App independently enforces the
  backup before first overwrite. `createPdfInkConversionHost` records validated old/new physical frames.
- PDF owns HOST metadata (`session/inkHost.ts`). Allocate one save write ID before frozen serialization;
  pin without mutating live undo/dirty state, preserve opaque HOST ext, and rebind only after verified
  versioned IO to an authoritative forward generation with the same pristine source.
- **Classic and native edit authority requires actual write safety of BOTH outer and pristine.**
  `utils/pdfWriteSafety.ts` runs only in the mature-parser worker; signatures/ByteRange/certification,
  encryption or unknown policy refuse in-place writes. A raw attachment role, foreign-mark approval,
  native signature count zero or a read-only banner cannot mint this proof. Classic capability gates,
  canvas admission/export, independent worker builds and App's final post-await disk/closing checks
  all enforce it. Unsigned copies must remove proven obsolete OUTER signature objects and independently
  pass the same whole-graph safety check; their exact signed raw attachment stays untouched.
- Writers are isolated, serial, role-sealed and never replay failed writes. Rebuild from pristine plus
  current ink and preserved attachments; worker proofs never grant disk authority. Complete orphan
  recovery uses `whiteboard/host/pdfInkAssembly.ts`, not JSON disguised as PDF or pristine alone.
- Native notebook export is `writing/notebookClient.buildNativeNotebookPdf(input,{revision,signal})`:
  use the actual captured revision, one frozen write ID and independent fresh-writer output inspection.
  `buildDisplayPdf` is a distinct v1 path, not that native writer.
- `prepareUnsignedPdfCopy` returns a COPY-ONLY result for its strictly admitted signed subset; other
  cases refuse. Core must warn and allocate a distinct collision-free target. Never overwrite the signed
  source or claim cryptographic validation; its exact raw bytes remain embedded in the unsigned copy.
- Fonts are the actual pinned 14 payloads under `vendor/pdf-fonts`, not host/OS fonts. Worker availability
  IDs are NOT evidence of used faces. Mirror font identity hashes approved IDs plus their real pinned
  SHAs; numeric epochs still revoke tiles/models/find/selection/captures. Page-language hints use bounded
  uniform inherited structure language, zero annotations/forms and full native reopen before publication.
- Retained old mirrors are non-current, non-capture stand-ins only. Preserve full geometry/profile proof;
  `onUpdating` requires an opaque cover, and only an actual current frame commit calls `notePresentation`.
  Captures bind actual requested-page emphasis, permission, source and font identity through PNG encoding.

The sections below describe the remaining **Classic (pdf.js/pdf-lib) PDF** route, retired by the PDF owner; the board sections are native.

# Classic PDF annotation pipeline (the subtlest subsystem)

> The tldraw annotate canvas is gone: a Classic annotated PDF (`tldraw-snapshot.json` role) is now a
> LEGACY input, converted to native PDF ink through `acquireLegacyPdfInkCandidate` above. The format
> notes below stay true for reading such files and for the remaining Classic writer.

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
  CONTENT, in the existing build worker (`pdfBuild.worker.ts`, a read-only union inventory of every
  attachment name tree; never the classic renderer), never from one attachment's presence:
  `utils/pdfRole.ts` returns one of six tags. `plain` (no attachments of ours: the file's own bytes
  are the pristine original) and `annotated` (the supported legacy pair, `original.pdf` + a valid
  `tldraw-snapshot.json`) are the only potentially EDITABLE roles, additionally requiring actual outer
  and pristine `writeSafety.kind === 'safe'`; `notebookExport`, `unreadable`, `ambiguous`
  and `newer` open Annotate read-only with `pdfRoleNotice`'s text in the outer view. A role-passing
  snapshot is loaded into an isolated legacy store before mounting; a library rejection or render
  error revokes its exact source and replaces the editor with a read-only notice. An `original.pdf`
  alone does NOT make a file ours. A failed or partial read never falls back to `plain`; the outer
  pages stay readable. Marked legacy pairs and notebook pointers require exact compatible markers;
  unknown namespace markers refuse editing. `pdfAttachmentTree` traverses mixed branches and
  associated files, forks a sorted name tree and checks attachment hashes; current outer bytes stay
  bound to the pristine capability so outer-only attachments survive rebuild. The first save of a
  `plain` PDF adds the attachments. Only `plain` may be rotated (`canRotatePdfRole`).
- **Save authority is the exact source, not the path.** `authorizePdfRole` admits an editable role's
  `original` bytes; `canRebuildAnnotatedPdf(original)` is checked in `flushTab` before the build AND
  again after every await, directly before `writeFileVersioned`, so a revoked role cannot write.
  A refused save returns `skipped` (the revision stays dirty); `failed` is only for IO that threw.
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
  PNG, and the builder draws that **first** so ink lands on top. Each physical page carries an
  ordered layer per tldraw sheet, stamped bottom to top. `svgToVectorOps` returning null
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
- PDF annotations carry each page's inverse pdf.js viewport with the overlay. Raster and vector
  ink are drawn on a clipped page-sized Form and placed with that same transform, including crop,
  origin, rotation and UserUnit. The source page's resource dictionaries are forked before adding
  the Form; pdf-lib otherwise mutates inherited/shared dictionaries. Notebook pages use their own
  generated zero-origin geometry.
- `withPdf` is gone: role inventory uses the build worker, while `openPdfPages` keeps a guarded
  classic task alive until its caller closes it. Only the classic adapter copies renderer bytes
  (pdf.js detaches its input); a display/Retry never mutates the original.
- `pdfBuildClient` keeps one warm `Worker` for the app's life; errors or a build deadline reject
  in-flight requests and replace it on the next call. Its bounded 30-second-idle artifact cache holds
  compressed source bytes and standalone ink PDFs, never PDFRefs or a mutated document. The canvas
  waits for pen-up and 250ms quiet, discards exports overtaken by an edit, then awaits the immediate
  versioned save before exporting the latest queued revision.

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
  stays out of the main bundle. The worker accepts only finite quarter-turn deltas and valid page
  indices; existing non-quarter rotations are refused rather than rounded into a destructive write.
  Multiples such as 450 and -90 are normalized modulo 360.
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
- **Refused on a PDF this app has annotated**, in App and again at the worker's role gate, with a notice that says why: the strokes are authored
  against the pages as they are and `/Rotate` would turn the paper out from under every mark.
  The role read that decides it happens in the HANDLER, at the moment of the gesture — doing it on
  open would undo `needsSource`'s whole point (an attachment read for every PDF merely read).
- UI: two buttons in the reader's first pill, `[` / `]` on the keyboard (by `e.code`, since ⌥] is
  not `]`), and **⌥-click** to turn the page being read rather than the document. The keys have no
  one-page form on purpose: the modifier that would say so is the one that changes what the key
  produces. Annotate mode has no rotate control — the refusal above is why there would be nothing
  for it to do.

## One pdf.js worker for the whole app — `utils/pdfWorker.ts`

**Only `openClassicPdf` calls pdf.js `getDocument`.** It copies renderer input and obtains the
shared native module worker through a transferable ready/test handshake and pinned bootstrap.
No fake/main-thread worker is permitted. `loadClassicPdf` and `closeClassicPdf` own guarded
acquisition and bounded dead-port teardown of the REAL loading task; never replace task/proxy
methods. `pdfWorker()` is compatibility for an already-ready port, not a startup entry point.
`prefetchPanes` calls `prefetchClassicPdf` dynamically only under `kinds.pdf`, retaining lazy
font/decoder warming. Idle failure stays silent until a document is demanded; no retry loop.

Every asynchronous render/stream consumer uses `session.health.guard` (or
`classicPdfHealth(doc).guard`) so a dead native port cannot retain a document/page/reader permit.
Cancel streams without awaiting dead-port RPCs during cleanup, then release reader locks/leases.
Publish render failures with `recordClassicRenderFailure(health, error, zeroBasedPage)`;
cancellation is not a render failure. Assert page completeness before returning a raster capture,
including after asynchronous encoding/composition. Available partial pages can still DISPLAY,
with persistent app notices and **Thumbnail unavailable**; they are not clean tool captures.

Worker message shapes, runtime assets, bootstrap and native-emphasis internals stay pinned to
pdf.js 6.1.200 together. Fetch/XHR/WASM observation preserves exact results/throws. A JS fallback
that fully renders is complete: a dependency failure taints the worker for the next explicit
open/Retry, but must not falsely mark its successful page incomplete. No PDF text/URLs enter
health diagnostics. Native worker errors are fatal; silent closure only becomes a soft demanded-
work no-progress notice (about ten seconds), never a timeout kill or image-size refusal.
Progress/completion clears that notice. Healthy Retry reopens only its document; explicit Retry
of an unresponsive/tainted/failed worker creates one replacement. Other affected PDFs retry
separately. Chrome worker crashes can take the renderer down too; do not promise crash isolation.

Each `openPdfPages` acquisition owns independent `source.health` and publishes it through
`onRenderHealth` BEFORE awaiting startup. Pane subscribes to that actual source and never closes
its health; only the source's close does. A byte-keyed memo/shared health races StrictMode's late
cancelled acquisition. Captures and thumbnails use the same actual-source health. Refused Annotate
uses the outer viewer's session health; renderer Retry cannot clear a tagged role refusal.
Never remount an annotation canvas or replace its snapshot to retry: preserve unflushed ink and
direct the reader to View until an in-place source/image replacement transaction exists.

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
- `PdfPane` uses the demand/idle-shared resolved-component cache in `pdfPaneModule`; `CanvasPane`
  remains `React.lazy` in `EditorPane` and is the only way into the native board runtime — viewing a
  PDF never pulls in the board editor. `utils/pdfText.ts` (closed-PDF text/render for the agent) imports pdf.js
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
- Ordinary selection/copy come from pdf.js **`TextLayer`** spans; app-owned find searches every
  canonical page through the session reader, independently of those spans. The `.textLayer` CSS in `index.css` is the
  library's contract — percent positions + `--scale-factor`/`--total-scale-factor` sizing, **plus the
  three `[data-main-rotation]` rules**: pdf.js sizes a text layer from the page's *unrotated* box and
  leaves the turn to the host's CSS, so without them a `/Rotate 90` page's selection lands nowhere
  near its glyphs. Zoom therefore rescales text layers without rebuilding them. Keep
  `br::selection` transparent: positioned line breaks otherwise paint a stray box at the page edge.
  `pdfTextLayerSelection.ts` anchors blank-margin drags to the nearest line/span and extends only
  within this viewer; drags beginning on text remain native. Its capture ⌘/Ctrl+A handler selects
  this viewer's built layers, not the app chrome, and stands down in inputs/editable content.
  It also marks that selection as **whole document**: ⌘C uses `pdfDocumentCopy.ts` to gather the
  reader's canonical pages in physical order joined LF, normalize them and write via `copyText`.
  Progress/blocked writes show in the viewer; text beyond the 16 MiB UTF-8 cap is refused rather
  than silently truncated. Selection changes revoke the mark and cancel an outstanding copy;
  hide/session teardown does too. Ordinary selections retain native synchronous normalized copy.
  Extend this binding, never install a second capture ⌘A handler. The classic reader's native
  right-click menu remains a documented exception until its app-owned text overlay/menu lands.
- **Text layers follow `CLEANUP_BEYOND` (12), with no eager pass.** Far-page cleanup cancels the
  TextLayer, empties its container, clears offsets/divs/promises and find ranges, then releases the
  session lease after outstanding work settles. A layer intersecting live selection or holding
  the current find hit is pinned. A per-build token prevents late completion from republishing
  released text, and `ensureText` rebuilds on approach or find reveal. Memory follows the window
  plus these deliberate pins, not document length (~4.3KB per positioned span was the old cost).
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
  and pages further than `CLEANUP_BEYOND` (12) release the viewer's page lease after text/link work
  settles. Zero users makes a parsed page eligible for the shared bounded PDF cache, not immediate
  cleanup; eviction never cleans under a thumbnail, Text, annotation or agent lease. The cache uses
  conservative reservations, not claimed worker-heap measurements. A visible surface handoff keeps
  the current page leased for at most five seconds; matching plain annotations reuse the reader's
  session, while stamped/pristine bytes always use distinct sessions. Re-rendering from a retained
  operator list avoids an expensive worker re-parse.
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
  never the page box, so text selection and links keep their colours. Native annotation and
  notebooks invert pages AND ink together through the board renderer (inverting only the pages leaves
  default black ink invisible), with the same toggle and store. Nothing is re-rendered on a toggle, and exports render shapes themselves, so a saved PDF
  never sees it: a notebook exported while dark is still printed on white paper.

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

## Board print and export: one pin, three consumers
A native board's print, PDF export and Mod-P all pin the open board once, then hand that pin to a single consumer:
- `whiteboard/export/whiteboardPrint.ts` (`pinNativeWhiteboardPrint`) prints a drawing's sheet ink; `notebookPrint.ts` (`pinNativeNotebookPrint`) prints a notebook's pages; `pagedPrintSnapshot.ts` (`pinPagedPrintSource`) prints every page of a PDF-backed board with its real backdrop.
- `components/whiteboard/useNativeClipboard.ts` owns the focused pin (`pinFocusedBoard`), the single-flight `print()`/`exportPdf()` on the clipboard service, and the Mod-P handler in the view's keydown. Its `printFocusedBoard` hands the PDF to `components/whiteboard/printBoard.ts` (`printBoard`, the only print surface).
- Exporting JSON goes through `whiteboard/clipboard/copyJson.ts` (`buildBoardJson`), the same chunked producer copy uses; copy writes it to the clipboard, export saves it under `exportFileName`.
Print, PDF and PNG/SVG save through `downloadBoardExport` (`components/whiteboard/exportDelivery.ts`), and the menu rows call the service rather than a second pin. Do not add a second print path: the menu and Mod-P must keep reaching the same pin.

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

- **evicts offscreen page bitmaps, retaining the last visible pages as resume pixels.** The hide
  effect reads `onScreenRef` and keeps that range; render-ahead and eviction-margin bitmaps go.
  The older blanket-eviction fix reduced 62MB to 3MB, but is not today's policy: freeing the visible
  scan forced a JPEG decode and repaint on every return. Do not cite that old number as the memory
  retained by the current resume-pixel policy.
- **stops canonical find and pending whole-document copy.** There is no eager TextLayer pass;
  nearby built layers remain for quick return, and far layers were released by the window pass.
- **stops committing resizes.** The slot is a percentage of its column, so every sidebar toggle and
  window resize re-fit and re-rastered the hidden panes too. The last width is applied on the way in.

What is KEPT: the last visible page bitmaps, nearby text layers and the scroll position. Find
completeness comes from the canonical index, not retained DOM. Coming back runs the normal window
pass: compatible resume pixels stay, missing/incompatible bands render and prefetch refills.
P06 retains only on-screen DOM resume pixels under D1's policy: hide cancels visual work and
releases hidden viewer leases, frees other canvases/URLs/refined JPEGs, evicts heavy parsed pages
immediately and small idle parsed state within five seconds, but never cancels save/export work.

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
  session with five canvases in the background touches neither disk, nor pdf.js, nor the board chunk
  for the four nobody is looking at. Only the annotate canvas is torn down when its tab is
  backgrounded.
- **A float has to be handed the keyboard explicitly.** It outlives the tab switch, so nothing
  re-focuses it the way a remount used to: `CanvasPane` registers a `registerKeyboardTarget` that
  focuses the board's own view, and without it a board returned to from the tab bar took no
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

# Native boards: drawings, notebooks and PDF ink (`src/whiteboard/`)

There is ONE canvas engine, the in-house board (`CanvasEngine = 'board'`). tldraw, the old drawing/
notebook/annotate panes and their packages are gone; never reintroduce them or read their sources.
A legacy `.tldraw` file is converted on open (exact-original backup + consent before the first
overwrite; refusal leaves the original untouched); new drawings are always `.drawing`.

- **App owns the canonical runtime** — session, buffer, history, selection, samples, media, tools,
  jobs, camera and clipboard live in `whiteboard/host/runtime` + `utils/documentBuffers`/
  `documentSessions`. Views (`components/whiteboard/NativeCanvasEntry`, `NativePdfViewer`) never
  dispose document services; hide/dispose releases view work only (`nativeViewLease`,
  `nativeEditingLease`, `nativePdfEditingLease`).
- **Services/controller/embed layers are per DOM view**, never re-created on platform input pulses
  (that looped React to max update depth). Pausing seals `cancelViewWork`; only teardown disposes.
  A reused connection must call `accessible.refresh()`, and a refresh replaces its queued sync.
- **`inputPermitted` + source currentness + visibility dominate** resume, tool and clipboard
  editability: covered/stale PDF input never unlocks when layers resume. Actual lease/admission checks
  are authoritative; the editing shell never depends on a transient `canWriteSource` at mount, and its
  stable `onUnavailable` reads the latest notice through a ref.
- **Save skips clean ledger checkpoints** (`!documentBuffers.isDirty(tab.id)` → `'skipped'`); a pending
  rebind is not new content. A PDF source adoption gets a fresh immutable paint binding; old pins keep
  the old source. Same-owner strictly newer `rebinding` transfers the SAME CameraOwner.
- Stroke page default is **-1**, not 0 (0 caused nested-node rejection). The drawing camera re-applies
  its stored top-left after the 0→measured resize and blocks premature position persistence.
- **Notebooks** are boards on generated paper (`whiteboard/host/notebookPaper*`, `utils/paper.ts`, which
  imports nothing). Ruled paper exists twice — keep `paper.ts` and the PDF writer in step. Export is
  `pdf/writing/notebookClient.buildNativeNotebookPdf`; sibling export keeps consent, collision/root/
  baseline rechecks and Trash preservation. Native creation encodes a real R0 before IO; an error
  never authorizes a blank or truncating replacement.
- **Print/export**: see "Board print and export" below; the canonical producer is
  `prepareNativeExport` (`whiteboard/host/nativeExport`), one job authority, no nested capture jobs.
- **The AI agent** reads and edits boards only through native sessions (`utils/nativeCanvasAgentRead`,
  `nativeCanvasAgentMutation`, `whiteboard/host/nativeAgentView`). A mounted view's `ViewReporter`
  supplies real camera/pages/selection and withdraws on dispose; hidden or closed files use the
  last-real/whole-sheet fallback, never invented readiness. Agent edits commit through the same
  history/save path as a pen stroke. A closed legacy `.tldraw` reached only by the agent still goes
  through canonical `ensureNativeAgentRuntime` consent/backup — no null return or fallback on refusal.
- **Lazy imports are bundle discipline**: native runtimes, worker clients and rendering services stay
  behind `CanvasPane`/`pdfPaneModule` lazy hosts and `prefetchPanes` idle warmers; markdown-only
  sessions fetch none. Check the chunk before adding an import.
- Positions: `utils/canvasViewState.ts` (`canvasViewPositions`, per-vault `scopedKey`, never pruned,
  does not follow renames).

# File-type routing (`utils/fileTypes.ts`)

`.drawing`/`.tldraw` (converted) and `.notebook` → `CanvasPane` (native board), `.pdf` → `PdfPane`,
everything else textual → CodeMirror. **`isTextFile` (vaultSearch)** = shown/indexed as text;
**`isCanvasFile`/`isPdfFile` (fileTypes)** = which pane. Board files are JSON on disk and flow through
the versioned write path, but must not be shown or content-indexed as text.


Original and extracted Text share PdfDocumentSession with document/page leases; release, never direct page.cleanup while another consumer can use it. pdf-page-v1 replaces three old trim/collapse reporters with exact returned strings/order/EOL. PdfPane consumes the central PdfReadingBinding: displayed version, full-token surface controller, shared preferences and validated synchronous Text records. Original camera memory updates precede header actions; Text→annotation maps through Original before mounting the canvas. The actual Text reporter has no image-capture fallback. Word emphasis paints original glyph ink in Viewer/pristine annotation backdrops; no Text transition. The display-list adapter and native glyph/font/paint hooks are pinned to pdf.js 6.1.200; re-audit on upgrade. A single independent, canonical white-background whole-page OFF/ON proof (≤2^20 pixels) checks final composition; it is not per-zoom verification. Off paints first without hooks, and cached verdicts survive page cleanup; immutable plans are bounded and invalidated at cleanup. Only current-page results publish capability; unknown stays inactive. Annotation refresh chooses one visible/near stale backdrop at a time and cancels stale raster work without cancelling another consumer's proof. Text is manual and emphasis-inactive; readerViewState presents unmarked legacy Text records as Original without rewriting storage and stamps new explicit Text writes with textChoice:manual. No source/annotation/history changes from preference painting.
The PDF read wrapper retains stored schema/version; pdfTextRecords accepts schemas 1/2 and returns only camera/surface for future records. pdfTextAnchors shares find's projection and matcher, using context to resolve repeated quotes. PdfPane protects cross/future records until the Text or Original navigation counter advances; layout/hide/unmount cannot convert them.

PDF Text native Copy, custom Copy and selected-text reporting share page-model selection extraction.
Only page bodies contribute text; page controls/quality notices never enter that canonical slice.
