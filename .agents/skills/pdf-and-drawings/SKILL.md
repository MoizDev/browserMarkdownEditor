---
name: pdf-and-drawings
description: PDF and canvas documents end to end — the contained PDFium engine and pool, PDF tile layers, the PDF pane's Original/Text/Annotate routes, editable PDF ink and its saved-source rebind, old boards (.tldraw/.notebook/.tldr: read-only, editable copy) and old-annotated PDF conversion, notebook PDF export, writers, print and capture, canvas document sessions, and the lazy-chunk import rules. Load before touching src/pdf/, PdfPane/PdfTiled*/pdfPaneModule, components/whiteboard/Native*Entry, CanvasPane, whiteboard/host/ (sessions, PDF ink, notebook export), utils/paper.ts or utils/pdfBuild*.ts, or anything a PDF or canvas pane imports.
---

# PDF and canvas documents

Drawing pixels is `rendering-platform` (shared) and `board-gpu-path` (boards). Editing a board is
`whiteboard-editing`. This skill is the documents: where bytes come from, who owns them, how they are written back.

## Map

| Area | Where |
|---|---|
| PDFium engine (committed WASM build) | `src/pdf/vendor/pdfium/` (rebuilt by `build/pdfium/`), glue in `pdf/engine/` |
| Opaque frame that spawns engine workers | `pdf/contained/` (`broker.ts`, `bridge.ts`); worker side `pdf/worker/` |
| The one app-wide pool | `pdf/pool/pool.ts`, reached via `pdf/session/startup.ts` (`getSharedPdfPool`) |
| PDF page tiles (a platform layer) | `pdf/layer/` (`tileLayer.ts`, `texturePool.ts`, `tileMirror.ts`, `versionBridge.ts`) |
| Text, find, selection, links, emphasis | `pdf/text/`, `pdf/overlay/`, `pdf/emphasis/` |
| PDF+ink sessions, hosts, conversion | `pdf/session/`, `whiteboard/host/*Pdf*`, `whiteboard/host/pdfInk*` |
| Writers (save, rotate, notebook, unsigned copy) | `pdf/writing/`, `utils/pdfBuild*.ts`, `utils/pdfWrite*.ts` |
| PDF pane (React) | `components/PdfPane.tsx` → lazy `PdfTiledSurface` (Original), `PdfTiledTextSurface` (Text), `whiteboard/NativePdfEntry` (Annotate) |
| Canvas pane | `components/CanvasPane.tsx` → lazy `whiteboard/NativeCanvasEntry` |
| Board format and model | `whiteboard/format/` (binary `.drawing`, `NATIVE_VERSION`), `whiteboard/model/` |

**File kinds** (`utils/fileTypes.ts`): `.drawing` is the native binary board and must never be decoded as text;
`.tldraw`, `.tldr` and `.notebook` may hold legacy JSON, opened through the governed legacy mapping
(`whiteboard/host/legacyAcquisition.ts`) and ALWAYS read-only: an old board is never written (see Legacy boards). A PDF's role (plain, annotated,
notebook export) is read from its attachments, never its name. pdf.js and tldraw are gone; no reader or writer may
come back to either.

## Engine

- A vault that holds PDFs boots the broker frame and one render worker at idle (`pool.warm`, from
  `pdfSurfaceModules.warmPdfOpenPath`); that worker is exempt from the 60 s no-visible-document retirement until a
  document opens on it, for at most 5 min. Measured: ~77 MB (one renderer process) plus ~12 MB elsewhere.
- One engine ships: the committed from-source build, loaded the same way in dev and production.
  `build/pdfiumAssets.ts` serves/emits it at `pdfium/<buildId>/` and fails dev and build on any byte that differs from
  `manifest.json`. Swap engine files and manifest together, never edit them, never add a parser fallback: a load
  failure is `EngineBroken` with a truthful message. Its glue/WASM load only when a PDF first opens.
- Native symbols are lint-checked against `pdf/engine/pdfium/exports.json` (`bme/pdfium-boundaries`).
- The contained frame only creates and watches workers; each page talks to its worker over a direct `MessagePort`.
  Vault teardown invalidates in-flight acquisition before an old worker can publish into the next vault.
- Pool/native replies are privileged input: geometry and affines, text schema, links/outline, attachments and writer
  replies are validated fresh (`pool/validation*.ts`). Events are hints. Only definitive raster failures poison
  raster; cancellation, worker death and `FontPending` do not.
- Share opens, font and region work across waiters; keep priority-zero close and bounded page windows. Recovery is
  bounded; Retry is source-scoped (`retryPdfPool`). Never inflate credits/caps to hide a refusal.
- Fonts are the 14 pinned payloads in `vendor/pdf-fonts` (`pdf/fonts/catalogue.ts`). Profiles hash approved ids plus
  actual SHAs; a font epoch change revokes models, tiles, find, selection and capture. Known charset beats a
  conflicting language; ambiguous Chinese uses SC; mixed/unknown stays unknown.
- `pdf-lib` is allowed only in lazy metadata/writer work, never reader startup.

## PDF tiles (`pdf/layer/`)

- A tile owns its own pooled GPU texture (`texturePool.ts`); its CPU bitmap lease is released once GPU-resident.
  `evictGpu` clears the free pool, then off-view and other-scale tiles, farthest first; a tile on screen or drawn by
  the last prepared frame stays. `releaseGpu` releases every page texture at once.
- An opaque one-colour tile (blank page: the producer scans every raster, `pdfTileUniformColour`) is, on a device, a
  1x1 texture of its own bytes (`Entry.solid`, `tile-upload:solid`): no tile-sized texture or upload (doc12 zoom:
  34.9 → 19.6 Mpx). Opaque only, so it samples what a textured neighbour does; canvas2d, mirrors and bridges keep the bitmap.
- A visible tile reserves its CPU bytes `{ quiet: true }` first, frees the layer's own idle tiles, prefetch and covered
  stand-ins (`evictUnneeded`), and only then asks as need: the governor cannot evict a pane mid-frame, so a first ask
  as need counted the layer's own room as pool pressure and stepped canvas2d quality down on a fast scroll.
- A bitmap waits for the view's mirror only while the mirror can be made: a mirror trimmed and waiting for room
  (`mirrorTrimmed`) releases the uploaded bitmaps, which were that room (the view keeps its older mirror).
- A tile rejected by a cancellation (`isCancellation`: the pool's `'Cancelled'`, e.g. a recycled worker, or an
  `AbortError`) is removed unmarked and asked for again, never failed with "could not be rendered".
- The pane's notice bar offers **Retry** (reloads the document) only for a failed page or an error notice; memory and
  mode notices get Dismiss only, and the post-retry note clears on the next sharp frame (`PASSING_NOTICES`).
- Zoom deliberately holds rasters during the gesture (`ZOOM_GESTURE_HOLD_MAX_MS`, 48 ms): rastering through it cost
  about 10x the PDFium CPU.
- Tiles mirror into the session (`tileMirror.ts`): pixels belong to the document session, not the layer. After a
  byte-generation change, `versionBridge.ts` shows old mirrors as non-current stand-ins; cover "Updating" until a
  current, complete, sharp frame presents. Never replay a raw frame or accept a stale geometry proof. That frame is
  proved on the backend that presented it (`coverage(view, backend !== 'canvas2d')`): a WebGL2 tile drops its bitmap
  once uploaded, so a canvas2d proof never passes there, and a board covered at a bridge's expiry stayed under
  "Updating PDF view…" for good. An expiry over pages already shown sharp covers nothing (`inkBackdrop.ts`).
- Until its first present, `PdfTiledView` lays blank paper (`.pdf-tiled-paper`, `pagePresentation` boxes) under the
  canvas, so the picture lands in place; PDF wait labels (`.is-waiting`) fade in only after 400 ms.
- The wheel (and ctrl+wheel pinch) is taken on `.pdf-tiled-content`, not the surface: links are overlay buttons.
- `drawnPageRects()` lists pages painted at least once at the current source and layout; a board over the PDF claims
  only those as opaque (`board-gpu-path`).
- PDF Text uses the same source and pool without mounting Original's compositor. Word emphasis stays in the original
  page view; Text is an explicit separate action, never OCR.

## Source, authority and lifetime

- The first page is drawn from a nameless `slice()` of the disk snapshot File (the worker envelope refuses a `File`)
  while `stablePdfBlob` copies it beside the open; every worker then adopts the copy (`doc.adoptSource`). A snapshot
  read after the file changed fails rather than returning new bytes, so nothing is ever mixed. The version hashes the
  COPY (one disk read); a copy that fails tells App (`onReaderSourceLost`), which rechecks the file and reloads or
  raises the DiskBar. App also rechecks once when a PDF's late version first sets its baseline.

- The App-owned source/session outlives views. Hiding, graph trips and view aborts release view work, not source
  ownership (`pdf/session/ownedInkAcquisition.ts`). Retain actual bytes and full tokens.
- `acquirePdfInkSource` admits plain/native or explicit read-only. Plain has `board: null`; only a positive plain
  admission permits a canonical empty board. A refusal must never become an empty canvas.
- Roles come from the complete AF/EmbeddedFiles union and Filespec `/Desc`, not a filename, attachment count or
  partial inventory (`utils/pdfRole.ts`, `utils/pdfRoleRead.ts` for lazy inspection). Unknown attachments survive
  every write.
- BOTH the outer and pristine PDFs need write-safety proof (`pdf/writing/` via `pdfWriteSafety`): signatures,
  ByteRange/certification, encryption and unknown policy are refused. Consent, a raw role or a signature count cannot
  mint that proof. Mutation, worker assembly, post-await publication and App's versioned IO all recheck it.
- Render, copy, capture, write, print and high-quality print are independent permissions; unknown is not permission.
- `canWriteSource` excludes ONLY the hosted board's own read-only flag; `canWrite` includes it. Calling full write
  eligibility from the board's read-only predicate recurses.
- A saved byte generation changes a source, not its retained document/undo owner. Later editing checks the live
  owner/session serial, not equality with an old `getSessionIdentity()` object.
- Physical PDF pages cannot be added, deleted, resized or reflowed as notebook sheets.

## Editing a PDF (Annotate) and the saved-source rebind

- `NativeCanvasEditing` promotes only after input, chrome, styles, shortcuts, commands, context menu and paired embed
  presentation all attach. An API existing is not editing readiness.
- Tool/embed services belong to the DOM view, not each platform enable/disable pulse: recreating their layers during
  a topology seal causes a synchronous attach/remove/render loop.
- `PdfPane` keeps an admitted native child mounted through dirty ink and rebind using the actual source slot
  (`whiteboard/host/pdfInkSourceState.ts`). A role refresh, dirty bit or temporary write revocation must not unmount
  it and lose camera, history or unsaved work.
- PDF HOST metadata belongs to `pdf/session/inkHost.ts`: one write id before frozen serialization; preserve opaque
  HOST ext. Every save goes through App's versioned IO (`useSaveFunnel`), never directly from a worker.
- The pane's own autosave does not rebind: the writer builds from pristine + full ink, so the new bytes are what the
  pane already paints, and `pdfInkRebind` skips a same-generation write. A rebind covers with input detached
  (~150 ms of dropped presses), so with a board on screen only outside changes may cause one. The skipped write is
  remembered (`writtenAhead`): once Original/Text shows the document, App advances the generation over it
  (`usePdfActions.adoptSavedPdfInk`, keeping the retained owner) and the owner follows (`adoptWritten`) with no board
  on screen — otherwise Original keeps drawing the generation from before the ink.
- Rebind only to freshly inspected saved bytes with a forward generation and the same pristine. The caller invokes
  `runtime.adoptPaintSource` before publishing ready. Pins retain the WHOLE `capturePaintBinding()` bundle (token,
  factories, retainer); `scene.setPaintBinding` installs it atomically. Updating a token alone retags old work.
- Platform document tokens are immutable: detach old input/platform, transfer the camera, attach a new platform with
  the new token. There is no token-update API.

## Legacy boards (`.tldraw`, `.tldr`, old-app `.notebook`): never written, edited through a copy

- Old is decided from the bytes of EACH load (`sniffCanvas` for a text buffer, the engine's admission for the pane;
  `utils/oldBoards.ts`), never a name or a remembered flag. Every write seam refuses one: the funnel
  (`canUpdateTabContent`/`canFlushTab`/`flushTab` on `representation.oldBoard`/`policy.oldBoard`), the host's
  `writeBlockSource`, `activateEditing` and the agent (`oldBoardReadOnlyReason`, which names the gesture). There is no
  board conversion code left, dormant or otherwise; `conversionPending`/`acceptConvertedSource`/`keepConversionBackup`
  are PDF ink only and throw for a board.
- `prepareNativeRuntime` seals the runtime read-only, makes `pinMedia` a no-op restore (a build's media restore wrote
  pictures beside the board and refused on a sealed session: "Board session ended"), and exposes `oldBoard.copySource`.
  The pane routes to `NativeViewer` (view lease, no editing chunk) with `ReadOnlyBoardChrome`.
- The copy is built from the board ALREADY in memory, never a second read or a second trip through the legacy queue:
  `copySource(signal, view)` → `build(files)` checkpoints the serializer with `encodeMedia` overrides naming each
  picture's stored file (a picture with `file: null` failed its first save with `MediaLocationsChanged`) and, for a
  drawing, an `encodeView` override carrying the camera. App's `writeBoardCopy` (vault-filesystem) writes it under a
  free name; `useEditableCopy` swaps the tab in place (one commit: release, `setTabs`, `renamePath`). Requests (dialog,
  strip, tree row) go through the store in `oldBoards.ts` and are run by the pane that holds the board.

## Legacy conversion (old annotated PDFs only)

- `acquireLegacyPdfInkCandidate().prepare` needs the C5/visual gate, the app's own confirmation, foreign-mark consent
  when applicable, and `NativeCanvasHost.keepConversionBackup` of the EXACT outer bytes; App enforces the backup
  before the first overwrite. A JSON hash is not the outer disk hash.
- `createPreviewHost()` is non-saveable. The final host is `createPdfInkConversionHost(ready, previousFrames)`; pass
  that exact object, the native board and media to `createConvertedPdfInkSource` (branded
  `kind: 'legacy-converted'`). Ownership transfers only on success; the first verified native write and reopen
  completes migration; cancellation leaves the original untouched.
- The legacy importer (`whiteboard/import/`) reads every tldraw generation by each record's own layout and version
  (`records/versions.ts`; stroke layouts in `segments.ts`). An item it cannot represent is left out, preserved raw as a
  `legacy-*` record in the native file, and reported with an `item` noun; it never makes the board read-only. Only a
  file with no readable board fails, through `importFailure`. `importNotice` (items left out, repairs carrying a
  `notice`) is shown once in the board's notice (its closing sentence is the caller's: a board's says the file is
  never changed, the PDF's says where the original is kept); float16 pressure drift below 0 is silent. Never join issue reasons
  raw: use `groupIssueText`. Its `legacy-*` records and node fields are provenance or bookkeeping, never an undrawn visual
  (`format/legacyRecords.ts`, every family's meaning), so the print/PDF/thumbnail/minimap preflight (`host/pdfVisualPreflight.ts`)
  passes them and refuses only what a NEWER app version wrote; a new family is added there, or every old board's export breaks. A legacy load (board, notebook or old annotated PDF) is admitted by `host/legacyLoadQueue.ts`:
  one at a time, a document a visible pane shows first, its working memory the heap of a parse worker of its own
  (`dedicatedBoardWorker`: scan, then import, then ended, so the heap goes back at once) and never the render raster pool;
  only a file over 256 MB is refused, at once. The import never holds a whole board's geometry: bounds are read node by node
  through the renderer's bounded idle cache after the faces are loaded (`loadLegacyFaces`), never under a change-geometry pin. The pane says "Opening drawing…" (or notebook) while it waits or runs, and
  every canvas error offers Try again. Its worker requests use `LEGACY_LOAD_DEADLINE_MS` (a stall is the host watchdog's).
- HOST media projection excludes only validated bookkeeping fields (`pdf/session/inkHostMedia.ts`). Never invent
  media receipts or fall back to the folder's `.Assets` for embedded PDF media.

## Writers, exports, print, capture

- Writers are isolated, serialized, role-sealed and never replay a failed write. Rebuild from pristine + current ink +
  preserved attachments, never from already-stamped pages (`whiteboard/host/pdfInkAssembly.ts` for recovery).
- Opaque workers have no WebCrypto digest: marks use the pure SHA-256 in `utils/pdfWriteArtifacts.ts`.
- Live ink/notebook export uses the incremental sink: one path start, bounded command pieces, one path end/paint.
  Painting each chunk changes joins, winding, fill and alpha.
- Native notebook output is `buildNativeNotebookFromEmittedPdf` with one frozen write id, then independent
  geometry/pointer/union/hash verification. `finishGeneratedNotebookPdf` (`pdf/writing/client.ts`) is the
  generated-only no-engine route, chosen BEFORE work, never a fallback after a failed native one.
- Ruled paper is defined in three places that must agree: geometry and hex colours in `utils/paper.ts`, the board's
  `Rgba` values in `whiteboard/host/notebookPaper.ts` (shared with `proceduralPaper.ts`), and pdf-lib `rgb` in
  `utils/pdfBuild.ts` (main-bundle `paper.ts` must stay free of pdf-lib).
- **Rotation is an incremental update** (`pdf/writing/rotationUpdate.ts`, reader `rotationReader.ts`): the turned
  page dictionaries (copies with a new `/Rotate`) and a new xref section of the file's own kind (table or stream) are
  APPENDED, so the original stays a byte-exact prefix. A section the file still ends with that this writer appended
  (marked `%local-vault-pdf/v1;rotation;base=N`) is REPLACED, not stacked: four turns restore the exact original
  bytes. The planner runs the usual role/write-safety gates; a fresh writer verifies (exact prefix, section shape,
  pdf-lib vs. our reader page by page, PDFium count and a sample of sizes/angles) before App's versioned write.
  Never decode or hash streams to "prove" preservation again: the old inventory took ~9s on a scan and refused 8 of
  11 real files. A notebook's export turns like a plain PDF (its pointer is untouched; re-export asks to replace).
- **An annotated PDF turns with its marks** (`pdf/writing/inkRotation.ts`), as ONE appended section
  (`%local-vault-pdf/v1;ink-rotation;base=N`) redefining the turned page dicts AND the stream objects of
  `original.pdf` (the pristine, turned by `planRotation` over its own bytes), `board.json` and `.vault-write-mark`
  (new write id, sealed over the whole file). The stamped ink is in user space, so `/Rotate` turns it with the page:
  nothing is re-stamped; the next save rebuilds from the turned pristine as always. Every turn is computed FROM THE
  BASE (the prefix before our section) with each page's total quarter turn, so marks go through one transform and
  four turns drop the section (exact original bytes). The board is spliced record by record (`inkBoardTurn.ts`):
  only page-root `x`/`y`/`rot` and every node's `b` change, by exact quarter-turn maps (`quarterTurn.ts`: values
  snapped once onto a grid where `side − v` is exact, ≤ 1 ulp of the page size); the HOST record gets PDFium's
  geometry of the turned pristine (what `inkHost.ts` validHost compares) and swapped `migration.previousFrames`.
  Refused: opaque nodes on a turned page (`newer-annotations`), another geometry engine (`other-engine`), a foreign
  write mark (`foreign-change`), Classic annotations (`legacy-annotations`; converted-but-unsaved asks for one change).
  An inspection that could not decide (too large, ambiguous, nested, failed) is `unverified`, never `missing-attachment`:
  that one tells the person their annotations are damaged.
  The verifier re-inspects the result as acquisition will and recomputes board and pristine byte for byte. App
  saves pending ink first (`saveInkBeforeTurn`), and a retained Annotate owner is replaced (history starts afresh).
- A turn shows at the press (`utils/pdfRotationStandIn.ts`): the view draws its mirrored tiles turned into the turned
  layout (a whole-page thumbnail fills what was off screen), writes the position the turned view opens on, and holds
  its camera. App coalesces presses on the tab's chain and adopts the bytes with a new byte generation (no `diskRev`
  remount); the picture leaves on the pane's first sharp frame of the written hash, or rolls back on failure.
  From press to settle the turn is HELD (`utils/pdfTurnHold.ts`): the pane stays Original, a switch to Annotate is
  queued until release, and the native host refuses writers — the turn replaces the owner, so ink taken meanwhile was lost.
- `prepareUnsignedPdfCopy` is copy-only: a distinct collision-free target, the signed original untouched, no claim of
  signature validation.
- PDF-pane print hands the exact saved bytes to the browser after flushing pending ink, not a raster spool.
- Board print/export share one focused pin in `components/whiteboard/useNativeClipboard.ts`: drawings use
  `whiteboard/export/whiteboardPrint.ts`, notebooks `notebookPrint.ts`, PDF-backed boards `pagedPrintSnapshot`;
  `components/whiteboard/printBoard.ts` is the only print surface. A whiteboard with a selection asks Selection or Sheet in the
  app's dialog (`NativeCanvasEditing` `runPrint` → `clipboard.print(wholeSheet)` → `nativeExport` `wholeSheet`); paged boards
  print all pages. JSON copy/export share
  `whiteboard/clipboard/copyJson.ts` (`buildBoardJson`) and `exportDelivery.ts`.
- PDF+ink PNG composes `PdfInkBackdrop.captureSnapshot` with the board snapshot under ONE parent capture
  (`rendering-platform`, Capture).

## Canvas document sessions

- App owns each canvas document's session (`utils/canvasSessionBridge.ts`, `NativeCanvasHost` in
  `types/nativeCanvas.ts`); StrictMode and extra panes attach to the same engine session. The board runtime (model,
  scene, history, journal) outlives every view (`attachView` attaches view resources only).
- A content source pins one revision synchronously (`whiteboard/session/BoardSession.ts`); a build job never reads
  the live document.

## Module boundaries

- PDF and canvas panes reach the engines only through lazy chunks, rendered through module slots
  (`components/moduleSlot.ts`: `pdfSurfaceModules.ts`, `paneModules.ts`), never `React.lazy` + `Suspense`, whose
  reveal React 19 holds until its fallback has been up 300 ms however early the chunk lands. `prefetchPanes.ts` warms
  them at idle by the kinds the vault holds (markdown-only fetches none); `loadPdfPane` also warms the whole open path
  (surface, source runtime, passwords, startup, `cpuEntry`) and pre-boots the engine. Every `import()` a person waits
  on goes through `platform/chunkLoad.ts` `loadChunk` (bounded, retried once, a 404 = `gone` → the update notice),
  and a slot's failure is thrown to the pane's `ErrorBoundary`, whose Try again re-imports. A static engine import from App or a non-listed component defeats the split; the lint dark zone
  (`rendering-platform`, Boundaries) catches most of them. Filesystem access stays in context; saves in App.
- No PDF or board may depend on a CDN to draw a line: engine, fonts and renderer assets are local and
  integrity-checked.
