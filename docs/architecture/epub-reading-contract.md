# Browser reading integration

EPUB is a native binary read-only kind. `OpenTab.representation` records the loaded kind,
generation, availability and buffer authority; `documentReading` gates text reads, content
updates, mode changes and flushes before a sentinel can reach a writer. Extension changes
reclassify; strict UTF-8 decoding rejects ZIP/PDF signatures and NUL bytes even with text names.

`FileSystemContext.readFileSnapshot` is the only new acquisition seam. It returns an immutable
File/Blob and stat, not a handle. The snapshot fingerprint worker uses the EPUB owner's FIPS
180-4 incremental SHA-256 implementation over at most 4 MiB slices. Abort/dispose terminates
its worker. The displayed bytes and raw fingerprint share the same Blob. App accepts reports
only for the current vault id/epoch/document id/byte generation; rename/reload/retry invalidate
old reports. No Blob is stored in tabs or browser records.

`DocumentPane` mounts the visible EPUB host; it acquires through App and lazy-loads EpubPane.
Unmount aborts/disposes the frame/session/snapshot and flushes compact state. Existing retained
PDF/canvas floats remain separate. Idle prefetch uses tree kinds and never parses a book.
The opaque reader frame, vendored sources, policy, ZIP worker and emitted CSP runtime belong
to the EPUB owner. Source inventory and licenses are in `src/epub/vendor/`.

`readerViewState` and `pdfTextViewState` each have one cached writer. Keys capture explicit
vault id plus NUL plus path; writes update memory synchronously and coalesce disk persistence.
Records are validated and unpruned. No .appearance.json key, vault file or session schema bump.
`readingPreferences` is one browser-wide immutable external store; no per-document emphasis.
CM installs one singleton emphasis plugin and compartment in fresh/adopted states; latest mode
and preference changes defer through composition and restore canonical word/selection anchors.
Preference-only changes do not recreate livePreview. Tables use their owner's safe DOM adapter.

PDF Original and Text share one displayed-byte session with document/page leases. PdfPane
consumes PdfReadingBinding, publishes the version of those exact bytes and registers a full-token
surface controller; retained callbacks read the latest binding. Global emphasis and Aa preferences
use the sole readingPreferences store. Original's header action opens only that PDF's Text surface;
turning emphasis Off keeps Text open. Annotation entry maps the Text physical page/word before
mounting the canvas; dirty/flushing annotation bytes block Text entry until the save lands.

PDF Text records carry a raw fingerprint, extraction schema, page digest, canonical anchor and
Original camera checkpoint/navigation revisions. Restore validates the fingerprint and schema,
then resolves page bounds/quote and detects digest drift. Surface and location writes update the
central record synchronously, with flushes on hide/unmount/pagehide. Original updates its legacy
camera in memory before a header action. No new PDF proxy is created for a surface switch.
The Text agent reporter supplies actual bounded visible/selected canonical text and physical-page
extraction. Text image capture is explicitly unsupported; it never substitutes an Original PNG.

Agent text paths refuse EPUB and unavailable representations independently of UI routing.
An open EPUB reporter supplies bounded canonical selection/visible text with no line numbers;
unopened extraction and raster capture return precise unsupported responses. Raw book bytes
stay out of vault search, graph and Markdown backlinks. Normal CLI/terminal policy is unchanged.


Vite's `contained-epub-frame` plugin runs `node src/epub/build-frame.mjs` at
`buildStart` in dev and build, and regenerates/reloads on contained source changes in dev.
Generation removes previous outputs before bundling, rejects inline script terminators and
hashes the exact inline script. Generated HTML/integrity are ignored, never checked-in fallbacks.
Preview serves the already-built dist; it does not rewrite a production artifact at startup.
The lazy bridge imports HTML as raw text into srcdoc: no root-relative frame URL, remote runtime
script or publisher resource URL depends on Vite base. Archive and hash worker URLs use Vite's
`new URL(..., import.meta.url)` transform. A note-only tree does not prefetch any EPUB chunk.
Static dist includes root THIRD_PARTY_NOTICES, vendor licenses/source-lock and frame integrity.

The shared document header is the sole EPUB Word emphasis button. Its More menu also offers
Contents, Find, Appearance and requested Scroll/Pages; the body toolbar exposes the same reader
actions. Full-token ReadingSurfaceController registration owns those commands, keyboard Find,
focus and a bounded canonical checkpoint before tab close/selection or Graph. Cleanup unregisters
only its own instance. Resize and typography retain source anchors; requested flow remains
per-document, shared typography/emphasis browser-wide, fixed fit/spreads pane-local.
Metadata title/author and bounded canonical text reach the actual live agent reporter.
Snapshot cancellation is per fingerprint consumer: StrictMode's cancelled first session cannot
poison the immutable snapshot reused by its replay. App publishes tabs/vault id in layout effects
before passive child acquisition; production's synchronous chunk cache must obey this ordering.

Support limits are deliberate, explicit profiles: static ZIP32 EPUB 2/3, reflow plus fixed XHTML,
SVG or raster pages and mixed overrides; IDPF/Adobe-obfuscated fonts. ZIP64, encrypted ZIP/DRM,
script-dependent prose, media and remote assets are unsupported. PNG/JPEG/static WebP, sanitized
SVG and WOFF/WOFF2/TTF/OpenType are supported. GIF/AVIF/APNG/animated WebP images are refused
with warnings while keeping prose readable. Unknown CSS is removed with warnings. A section
above 1,048,576 UTF-16 units or 20,000 generated prefix ranges keeps full canonical reading but
reports emphasis unavailable. Metadata/Contents has a 256 KiB transport cap (192 KiB metadata
projection); exceptionally large TOCs receive a bounded error rather than silent truncation.
Canonical CFI is app-local over the sanitized projection, never exported as publisher CFI.

License provenance: source-lock records immutable Foliate source URLs/hashes, exact npm pins,
registry integrity and git heads, plus hashes/entry strings/build options for the two prebuilt
vendor ESM bundles. Rebuild those in a separate scratch npm project with exactly the listed pins
and esbuild 0.25.12, `bundle:true,format:esm,platform:browser,minify:true,legalComments:inline`.
No source modifications were made to Foliate or the dependency bundles. DOMPurify is distributed
under its Apache-2.0 option, so the MPL alternative's source offer is not invoked. MIT/ISC/Zlib/
BSD/CC0 and Python notices are retained in full and shipped in dist. The installed lock supplies
esbuild 0.27.3 for subsequent frame builds; no dependency upgrade is required.

Opaque keyboard commands pass App's full-token/focus validation before using EditorPane's
existing all-column navigation and keyboard registry. Requested focus survives lazy adapter
startup and StrictMode replay; panel Escape restores its opener. Cmd/Ctrl+S is consumed inside
the read-only frame as well as refused at the central save funnel.
