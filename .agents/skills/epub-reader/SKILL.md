---
name: epub-reader
description: The read-only EPUB reader — how a book is acquired (immutable snapshot, never a handle), the opaque sandboxed reader frame and its generated bootstrap, the archive worker and budgets, reading position and preferences, Word emphasis inside books, and how EPUB tabs refuse every text write. Load before changing EPUB routing, src/epub/, EpubPane/EpubReaderHost, the contained-epub-frame Vite plugin, readerViewState/readingPreferences, or anything that could hand a book's bytes or its placeholder text to a writer.
---

# EPUB reader

An EPUB is a **native binary, read-only** document. Publisher XHTML is hostile input that is parsed,
sanitized and rendered only inside an opaque `sandbox="allow-scripts"` iframe; the host page (which
holds the vault handle and, through the terminal, a shell) never parses it. Long-form contract,
support limits and licence provenance: `docs/architecture/epub-reading-contract.md`.

## Map

| Piece | Where | Role |
|---|---|---|
| Kind + write gates | `utils/documentReading.ts` | `classifyRequestedKind`, `representationFor`, `canReadTabText`/`canUpdateTabContent`/`canFlushTab`/`canChangeTabMode` |
| Acquisition | `FileSystemContext.readFileSnapshot` | immutable `File` + stat + lazy SHA-256 `fingerprint()` (`utils/snapshotFingerprint`) |
| App wiring | `app/useReaderIntegration.ts` | full-token validation, `acquireSnapshot`, status/capability/location/command callbacks |
| Host | `components/EpubReaderHost.tsx` | acquires the snapshot, registers the agent view, lazy-loads `EpubPane` |
| Pane UI | `components/EpubPane.tsx` | toolbar, Contents/Find/Aa panels, footer, error state, external-link confirm |
| Session | `epub/session.ts` (`engineAdapter.ts` is the lazy entry) | archive client, resource streaming to the frame, budgets, find |
| Bridge | `epub/bridge.ts`, `bridgeProtocol.ts` | one `MessagePort` via `platform/containedFrame` (see `contained-frames`); strict envelopes |
| Frame runtime | `epub/readerRuntime.ts` + `policy.ts`, `resources.ts`, `canonicalText.ts`, `locator.ts`, `nativeEmphasis.ts` | runs **inside** the frame |
| Archive worker | `epub/archive.worker.ts`, `archivePreflight.ts`, `archiveClient.ts` | bounded ZIP32 reader, manifest approval, font de-obfuscation |
| Frame build | `epub/build-frame.mjs`, Vite plugin `contained-epub-frame` | generates `reader-frame.html` + `.integrity.json` (gitignored) |
| Records | `utils/readerViewState.ts`, `utils/readingPreferences.ts` | position per vault+path; global emphasis/typography |

## The rules

### A book never becomes text
- `representationFor` gives EPUB `bufferKind:'unavailable'`, `contentWritable:false`; `canUpdateTabContent`
  refuses `loadedKind==='epub'` outright, and `canChangeTabMode` refuses a mode switch (tabs open in
  `read`). Every App tab transition goes through these gates — guarding only the pane would still let a
  clean ⌘S write the placeholder `content: ''` over the ZIP. Never give the tab's `content` authority.
- Openers, restore, outside-change reload and rename all special-case `isEpubFile` to **skip the text
  read** (`useDocumentOpener`, `useSessionRestore`, `useOutsideChanges`, `useRenameMove`,
  `useAgentHostDeps`). A new path that loads a tab must do the same, or it decodes a ZIP as UTF-8.
- `handleCreateFile` refuses `.epub`/`.pdf` names ("must be imported as original binary files").
- Agent: `vault_read` of an EPUB returns only the open reader's bounded canonical text (or a precise
  "not loaded" error); writes, `vault_create`, image capture and `vault_search` refuse/skip EPUB
  (`agentHost.ts`, `vaultAgentTools.ts`). Raw book bytes stay out of search, graph and backlinks.
- Disk bar: for an EPUB, **Retry/Reload** re-acquire (`retryUnreadTab` bumps the generation and
  invalidates the old token) and **Close** closes — never Keep-mine or a conflict copy
  (`diskBarActions.tsx`). The DiskBar is shown `readOnly`.

### Acquisition: a snapshot, never a handle
- `readFileSnapshot(handle)` is the only seam. It returns a `File` (immutable Blob), its stat and a
  memoized `fingerprint()`. No handle crosses into the session, worker or frame; no Blob is stored in
  tabs or browser records. The displayed bytes and the fingerprint come from the same Blob.
- **Consumer abort never disposes the snapshot.** StrictMode replays the session against the SAME
  snapshot; `fingerprint(signal)` cancels only that consumer's hash task. The host disposes the snapshot
  on unmount.
- The fingerprint becomes the document baseline only when the tab is clean and has no disk state
  (`onReaderVersion`); a stale report is ignored.

### Every callback carries the full token
- `ReaderToken = {vaultId, vaultEpoch, documentId, byteGeneration}`. `useReaderIntegration.current()`
  rejects a token whose vault/epoch is not current, whose `documentId|generation` is in
  `invalidReaderTokens`, or whose generation no longer matches the tab. Reload, retry, rename and vault
  switch must invalidate the old token **before** any state migrates.
- `DocumentPane` keys `EpubReaderHost` on `vaultId|vaultEpoch|tab.id|byteGeneration`; `EpubPane`'s main
  effect depends only on the snapshot and those four fields — callback identities are read through a
  `latest` ref and must never reopen or reparse the book.
- App publishes tabs/vault id in layout effects before children's passive acquisition effects; the
  production chunk cache resolves `lazy()` synchronously, so this ordering is load-bearing.
- `registerReadingSurface` keys by `documentId` and unregisters only its own entry;
  `getReadingSurface(token)` re-checks the full token.

### The frame is the security boundary
- The frame is `sandbox="allow-scripts"` with no `allow-same-origin`, loaded as `srcdoc` from the raw
  imported HTML, and its CSP allows exactly one inline script by hash, `blob:` images/fonts, and nothing
  else (`connect-src/frame-src/worker-src 'none'`). Never add `allow-same-origin`, a network origin, or
  parse publisher markup in the host. This is not a third host `innerHTML` sink (AGENTS.md) — keep it so.
- `BookPolicy` (`policy.ts`) rebuilds every element from the worker's token model against fixed HTML/SVG/
  MathML/attribute allowlists, then DOMPurify; resource URLs are assigned afterward from a private
  `WeakMap`, never from author attributes. CSS is parsed, unsafe declarations/at-rules dropped with a
  warning, ids/selectors/font families namespaced per section, `url()` resolved only to approved
  manifest entries.
- Bridge envelopes are validated field by field in both directions (`validateEnvelope`), with an op
  allowlist per direction, a 120 msg/s receiver cap, 192 KiB chunks with per-chunk acks, at most 64
  pending calls and 8 resource streams. Raising any of these is a security change.
- External links reach the host only through `safeExternalLink`, then a confirm dialog in the pane.

### The generated frame
- `build-frame.mjs` bundles `readerRuntime.ts` (via `platform/containedFrameBuild.mjs`), hashes the exact
  inline IIFE into the CSP, and writes `src/epub/reader-frame.html` + `reader-frame.integrity.json`.
  It deletes old outputs first so a failed build leaves nothing usable. Both files are **gitignored —
  never commit a fallback, never hand-edit them.**
- The Vite plugin regenerates at `buildStart` (dev and build) and on dev changes under `src/epub/`,
  `utils/readingEmphasis.ts` or `containedFrameBuild.mjs` (full reload). `generateBundle` emits the
  vendor licences, `source-lock.json` and the integrity file into `dist/`. Preview serves `dist` as built.
- The archive worker is a kept `workerScript` (`?worker&url`, `rendering-platform` Boundaries): a book is re-read each
  time its pane is shown, and must keep opening after a deploy replaced this build's files.
- Vendored Foliate code (`src/epub/vendor/`, metadata/TOC/CFI only — its loader and renderers are never
  called) is pinned in `source-lock.json`. Re-vendoring means rebuilding exactly as that file records
  and updating its hashes.

### Budgets are deliberate
- `EPUB_LIMITS` (`types.ts`): 256 MiB archive, 20,000 entries, 4 MiB text entry, 8 MiB font, 32 MiB
  binary, 128 MiB encoded per book / 256 MiB app-wide, 100k nodes. `EpubBudgets` caps DOM nodes, font
  faces (8/book, 24/app), decoded pixels and font bytes; `reserveDecode` is a 256 MiB / 30 s sliding
  window shared by all books, and the archive client allows 3 worker calls at once.
- Unsupported on purpose: ZIP64, DRM (only IDPF/Adobe font obfuscation is undone), scripts, media,
  remote assets, animated images. `bookErrorMessage` maps each refusal to plain words — add a mapping
  when you add a refusal. Never claim universal EPUB support.

### Position and preferences
- `readerViewState` holds one validated `EpubReadingRecord` per **vault id + NUL + path**, written
  synchronously to memory and coalesced to storage (350 ms, flushed on unmount/`pagehide`). Records are
  never pruned. `moveReaderViewState` carries them across a rename. No vault file, no `.appearance.json`
  key, no session-schema bump.
- A locator resolves **section identity first** (href + occurrence), then bounds and text context
  (`resolveTextLocator`: digest+offset, else a unique quote match, else the section start flagged
  approximate). A removed chapter must never make a book unopenable; fingerprint drift is disclosed.
- `readingPreferences` is ONE browser-wide frozen external store (emphasis on/off + typography), shared
  with Markdown read mode and PDF. Requested flow (scroll/pages) is per document in the record; fixed
  fit/zoom/spreads are pane-local. Publisher typography and colours win; Aa sets fallbacks only.

### Word emphasis inside a book
- The shared document header's Word emphasis row is the only toggle; capability arrives as
  `ReaderCapabilities.emphasis` through the full-token callback, and loading/error states are inactive.
- `NativeEmphasis` paints CSS Custom Highlight ranges over the **original** text nodes with symmetric
  `text-shadow` ink: no wrapper nodes, no font swap, no remount, no camera move on an emphasis-only
  `configure`. Sections over 1 MiB of text or 20,000 ranges, non-Latin, vertical, bold or shadowed text
  stay original with an inactive reason.
- **Windowing must retain attached section roots** — removing even an unchanged root collapses live
  Selection/Highlight ranges. Insert only newcomers; initialize their paint after attach and settle.
- Copy re-checks computed visibility; hidden intervals stay indexed for locators but leave copied text.

## Keyboard, menus, focus
- Keys typed in the frame come back as semantic `command`s (`next-document`, `close-document`, `find`,
  …); `onReaderCommand` acts only if the token is current and the tab is active. ⌘S is consumed in the
  frame and refused at the save funnel anyway.
- The header's More menu adds Book contents / Find in book / Reading appearance / Scroll / Pages layout
  (`DocumentPane`); the body toolbar has the same actions. Panels restore focus to their opener on Esc.
- The right-click menu inside the book is the app's own (`openContextMenu`, see `app-context-menu`).

## Verify
Open a small EPUB (reflowable and fixed) in the real app per `verify-in-browser`: it opens in read
mode, ⌘S changes nothing on disk, position survives reload, emphasis toggles without moving the page,
and a markdown-only vault fetches no EPUB chunk.
