---
name: epub-reader
description: Native binary EPUB acquisition, opaque frame, browser records and reader lifecycle. Load before changing EPUB routing, containment, source resources or reading state.
---

# EPUB reading

Read `docs/architecture/epub-reading-contract.md` and `src/epub/vendor/source-lock.json`.
The core lives behind the lazy visible `EpubPane`, never in the main bundle or a retained hidden
renderer. `EpubReaderHost` acquires an immutable snapshot through App/context; no handle crosses
to the engine/frame/worker. Snapshot fingerprinting reads the same Blob in bounded slices and
terminates on abort. Never put EPUB bytes in OpenTab.content or give its sentinel text authority.
Use loaded representation plus full vault/document/generation tokens for every callback.

Publisher parsing/rendering belongs only in the opaque `sandbox=allow-scripts` frame and neutral
archive worker. Do not add allow-same-origin, host DOM parsing or a third host HTML sink. Runtime
CSP hashes must be regenerated from the exact bundled bytes. Do not edit generated frame HTML
without reproducing it from the pinned source inventory and rebuilding its containment evidence.

One `readingPreferences` store owns global emphasis and reflow defaults. `readerViewState` owns
validated, explicitly vault-scoped EPUB locations; `pdfTextViewState` is separate. No vault files,
.appearance keys or per-file emphasis. Reload/rename/switch must reject old callbacks before state
migration. Retry/Close are the binary disk actions; never save a sentinel or conflict-copy a ZIP
from text. Cross-kind rename preserves pending source first and reacquires/reclassifies.

Inspect EPUB owner's current handoff before claiming fixed/mixed, selection, containment or
resource support. Full integrated browser/static/build and final independent audits are required.

Vite generates the ignored frame at buildStart and on contained dev source changes; preview
serves dist. Do not add a checked-in generated fallback. Production must ship the licenses and
integrity inventory emitted by the plugin. Local raw/srcdoc and Vite worker URLs support base paths.
The EPUB shared header is the sole emphasis button. The registered surface routes More/Find/
Contents/Aa/flow and canonical capture. Snapshot consumer abort must never dispose the snapshot
itself: StrictMode replays against it. App tab refs publish before child acquisition effects.
See the architecture document for explicit ZIP64/media/image/emphasis-size limits; do not claim
universal EPUB support. Keep the source-lock bundle hashes accurate if re-vendoring.

Saved locators resolve href + occurrence before any ordinal/bounds check, including fixed pages.
Removed sections fall back to a valid linear start with a notice; raw fingerprint drift is disclosed.
Generated Contents entries retain their spine ordinal for repeated hrefs. Preserve visible ARIA-hidden
artwork/prose in the clone; computed hidden intervals stay indexed but leave Copy/selected text.
Publisher typography/colors win; Aa font/size/leading are fallback defaults. NativeEmphasis paints
CSS Custom Highlight ranges on original XHTML nodes with metric-preserving glyph ink, including
fixed/mixed sections. No prefix wrappers, section remount or camera reposition on emphasis-only
configure. Image/SVG-only, RTL/vertical and unsupported runs stay original with inactive capability.

Windowing must retain attached section roots: removing even an unchanged root collapses live
Selection/Highlight ranges. Initialize new roots after attachment/styles settle, including visibility
when emphasis is Off. Copy checks current computed visibility; scroll does not rebuild the book.
