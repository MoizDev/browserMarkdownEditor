---
name: pdf-and-drawings
description: Native PDFium reading, editable PDF ink, explicit legacy conversion, native notebook PDF exports and canvas document lifetimes. Load before touching pdf modules, paper.ts, notebook modules, PDF/canvas panes or their imports.
---

# Native PDF and canvas documents

`src/pdf/` owns the contained PDFium engine, pool, canonical text, tiles, fonts and isolated writers.
`src/whiteboard/` owns editable ink and its renderability admission. `PdfPane` uses only the native
reader and native annotation host. The old pdf.js reader/worker and tldraw PDF annotation pane have
been removed. Older PDF annotation DATA remains supported through explicit conversion, not a renderer
fallback. `pdf-lib` is permitted only in lazy metadata/writer operations, never reader startup.

A production build without the owner's qualified shipping artifact reports engine unavailability.
Never relabel the development artifact, fabricate qualification or restore an old parser fallback.
Load `rendering-platform` for shared frame/layer/capture changes and `verify-in-browser` for a real look.

## Source, authority and lifetime

- The App-owned source/session outlives views. Hiding, graph trips and view aborts release view work,
  not transferred source ownership (`session/ownedInkAcquisition.ts`). Retain actual bytes and full tokens.
- `acquirePdfInkSource` admits plain/native or explicit read-only. Plain has `board:null`; only positive
  plain admission permits a canonical empty board. A refusal must never become an empty canvas.
- Roles come from the complete AF/EmbeddedFiles union and Filespec `/Desc`, not a filename, attachment
  count or partial native inventory. Unknown attachments must survive writes. `utils/pdfRoleRead.ts`
  performs lazy metadata inspection without loading a renderer.
- BOTH actual outer and pristine PDFs need safe write proof. `utils/pdfWriteSafety.ts` runs in the
  mature-parser worker and refuses signatures/ByteRange/certification, encryption and unknown policy.
  Foreign-mark consent, a raw role or a native signature count cannot mint that proof. Mutation,
  worker assembly, post-await publication and App's final versioned IO all recheck it.
- Keep render/copy/capture/write/print/high-quality-print independent. Unknown is not permission.
  Source/font changes revoke text, find, selection and queued copy; genuine limitation notices remain.
- `canWriteSource` excludes ONLY the hosted board's own read-only flag from full App write eligibility;
  `canWrite` includes it. Calling full write eligibility from the board's read-only predicate recurses.
- A saved byte generation changes a source, not its retained document/undo owner. Admission completion
  may use strict acquisition identity; later editing activation checks the live owner/session serial,
  not equality with an old `getSessionIdentity()` snapshot object.

## Real editing and saved-source rebind

- `NativeCanvasEditing` promotes only after actual input, chrome, styles, shortcuts, commands, context
  menu and paired embed presentation services attach. An API existing is not editing readiness.
- Tool/embed services belong to the DOM view, not each platform enable/disable pulse. Recreating or
  removing their layers during a topology seal causes a synchronous attach/remove/render loop.
  Dispose on real view retirement; transient input cancellation must not change its own layer topology.
- `PdfPane` keeps an admitted native child mounted through dirty ink and rebind using the actual source
  slot (`host/pdfInkSourceState.ts`). A lazy outer role refresh, dirty bit or temporary write revocation
  must not unmount that child and discard its camera, history or unsaved work.
- PDF HOST metadata belongs to `session/inkHost.ts`. Allocate one write ID before frozen serialization;
  pin without changing live undo/dirty state. Preserve opaque HOST ext. Every document save goes through
  App's versioned IO against the actual disk baseline, never directly from a worker.
- Rebind only to freshly inspected saved bytes and an authoritative forward generation with the same
  pristine source. The real prepare→runtime caller invokes `runtime.adoptPaintSource` before publishing
  ready. Spatial `scene.ready` is not source permission; presentation still needs its real sharp proof.
- Future pins retain the WHOLE immutable `render.capturePaintBinding()` bundle: token, factories and
  renderer retainer. Updating a token alone retags old work. `scene.setPaintBinding` installs the bundle
  atomically; existing pins retain their old factories/token. Current overlays use `runtime.paintBinding`.
- Platform document tokens are immutable. Detach old input/platform, transfer the genuine camera, then
  attach a new platform/view lease with the real new token. There is no token-update API. A retiring
  pane must not checkpoint through its temporarily revoked writer; App retains document and undo.
- Old mirrors are non-current, non-capture stand-ins. Cover Updating opaquely until a genuinely current,
  complete, sharp frame presents. Never replay a raw frame or accept a stale geometry/profile proof.
- Physical PDF pages cannot be added, deleted, resized or reflowed as notebook sheets.

## Explicit legacy conversion

`acquireLegacyPdfInkCandidate().prepare` requires the actual C5/visual gate, custom confirmation,
foreign-mark consent when applicable and `NativeCanvasHost.keepConversionBackup` of EXACT outer bytes.
App independently enforces the backup before first overwrite; a JSON hash is not the outer disk hash.

`createPreviewHost()` is non-saveable. Mint the final host with
`createPdfInkConversionHost(ready, previousFrames)` and pass that EXACT object, actual final native
board and media to `createConvertedPdfInkSource`. It produces branded `kind:'legacy-converted'`, not a
forged native/plain source. Final immutable C5/visual qualification is separate from preview admission.
Ownership transfers only on success; App take detaches preparation cancellation from document lifetime.
The first verified native write/reopen completes migration. Cancellation/refusal leaves the original.

HOST media projection excludes only validated, owned bookkeeping fields (`session/inkHostMedia.ts`).
Preserve unknown keys/raw contents, even identical hashes; invalid schemas full-scan. Never bypass the
missing-media guard, invent media receipts or fall back to folder `.Assets` for embedded PDF media.

## Writers, exports and capture

- Writers are isolated, serialized, role-sealed and never replay failed writes. Rebuild from pristine
  plus current ink and preserved attachments, never already-stamped outer pages. Worker proofs do not
  grant disk authority. Recovery uses `host/pdfInkAssembly.ts`, never JSON disguised as PDF/pristine alone.
- Opaque workers have no WebCrypto digest API. PDF artifacts/write marks use the actual pure SHA-256
  byte digest (`utils/pdfWriteArtifacts.ts`); keep cancellation/yields and exact mark verification.
- Live ink/notebook exports use the incremental sink. One path start, bounded command pieces, one path
  end/paint: painting each chunk changes joins, winding, fill and alpha. Preserve groups/clips/resources;
  use shared governed CPU transport, one in-flight request, physical retirement and cancellation.
- Native notebook output is `buildNativeNotebookFromEmittedPdf` with the actual revision and one frozen
  write ID, followed by independent fresh geometry/corner/pointer/full-union/hash verification.
  `finishGeneratedNotebookPdf` is the explicit generated-only no-engine route, selected BEFORE work,
  never a fallback after a failed eligible native operation. Its worker accepts no imported PDF/ink build.
- PDF+ink PNG composes `PdfInkBackdrop.captureSnapshot` with the genuine board snapshot under ONE C4
  parent capture. Do not nest queued `captureRegion` calls. Pin before awaiting, preserve isolation getters,
  encode from the same CPU target and keep storage/slot charged until physical cleanup settles.
- Embedded-media receipts come only from the real issuer with the actual source and runtime job context.
  Current-byte capture is a retained full checkpoint including unsaved ink/media, not disk/pristine aliases.
  Capture after commit remains inside that SAME running job; no nested jobs/deadlock or forever receipts.
- `prepareUnsignedPdfCopy` is copy-only for its admitted signature/AP subset. Warn and allocate a distinct
  collision-free target, preserve exact signed raw bytes, independently verify safety and refuse unsupported
  graphs. Never overwrite the signed original or claim cryptographic signature validation.
- PDF-pane print hands exact saved original bytes to the browser after flushing pending ink. It is not a
  raster spooler. Keep print policy/stale-handoff checks through awaits; close a stale reserved tab.
- Native board print/export shares one focused pin (`useNativeClipboard.pinFocusedBoard`): drawing sheets
  use `whiteboardPrint`, notebooks `notebookPrint`, PDF-backed boards `pagedPrintSnapshot`. `printBoard.ts`
  is their sole print surface; menus and Mod-P reach that service, never a second pin. JSON copy/export
  likewise shares the chunked `clipboard/copyJson.buildBoardJson` producer and `exportDelivery`.

## Reader, fonts and module boundaries

- Pool/native DTO validation is privileged: geometry/all affines, text schema, links/outline, attachments
  and writer replies need strict fresh data. Events are hints, not authority. Definitive raster failures
  alone poison raster; cancellation, worker death and FontPending do not.
- Share opens/font/region work across waiters, keep priority-zero close and bounded memory/page windows.
  Recovery is bounded; Retry is source-scoped. Do not inflate credits/caps to hide a resource refusal.
- Fonts are the pinned 14 payloads in `vendor/pdf-fonts`. Availability IDs are not used-face evidence;
  profiles hash approved IDs plus actual SHAs. Numeric epochs revoke models/tiles/find/selection/capture.
  Known charset wins conflicting language; ambiguous Chinese uses SC. Mixed/unknown language stays unknown.
- PDF Text uses the same App source/pool, without mounting Original's compositor. Original/Annotate word
  emphasis stays in the original page view; Text is an explicit separate action, never OCR.
- Native canvases and PDF layers import platform only through lazy routes. A static pdf-lib/tldraw/engine
  import in App defeats the bundle split. Keep filesystem access in context and save work in App.
- Existing legacy drawing/notebook panes remain separate lazy consumers of tldraw until their own cutover;
  give tldraw local asset URLs. No PDF reader or writer may depend on tldraw's CDN to draw a line.
- Ruled paper has two active definitions, `utils/paper.ts` and `utils/pdfBuild.ts`; change both.
