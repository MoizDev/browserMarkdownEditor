# Provenance of the whiteboard engine

The whiteboard engine is greenfield: it contains no tldraw code, nothing copied, adapted or
transcribed from tldraw, and it imports no tldraw package, `perfect-freehand` or any library by
tldraw's authors. This ledger records where every module's requirements came from.

One row per module (file), added or updated in the same change as the module. Each lane appends rows
only inside its own section, so that lanes never edit the same lines.

Columns: module path · author (lane) · spec ids implemented · design document section · sources
consulted while writing (tldraw files read, if any, and the fact taken; literature; packages) ·
third-party code included (normally "none") · date.

## Chrome and style controls (lane w-j)

| Module | Author | Spec ids | Design section | Sources consulted | Third-party code | Date |
|---|---|---|---|---|---|---|
| `chrome/penWidth.ts` | w-j | F-STYLE-006/008, R-2 | integration §6; geometry §3.2 | Style specification endpoints and w-h's public StyleGeometryMetrics; no tldraw or old canvas source | none | 2026-11-13 |
| `chrome/theme.ts` | w-j | F-THEME-001/002/003/006, R-26, WB-D28 | integration §6; rendering §5 | Theme specification and host scope ruling; no tldraw or old canvas source | none | 2026-11-13 |

## Model, changes, history and text (lane w-c)

| Module | Author | Spec ids | Design section | Sources consulted | Third-party code | Date |
|---|---|---|---|---|---|---|
| `model/ids.ts` | lane w-c | M-2 | document-model §2 | Design only; Web Crypto API; no tldraw source | none | 2026-11-13 |
| `model/orderKey.ts` | lane w-c | M-4, E-DOC-4/5/6 | document-model §4; rulings R-W7/R-W12 | Literature via document-model §4/Sources: E. Wallace, Realtime editing of ordered sequences (Figma, 2017); D. Greenspan, Implementing Fractional Indexing (2020); neither original article read by coder; independent base62 arithmetic from design/rulings | none | 2026-11-13 |
| `model/styles.ts` | lane w-c | M-7, R-W19 | document-model §7; 00-frame §1; ruling R-W19 | Design; spec/styles named value inventory; preserved pen-record fields; no tldraw source | none | 2026-11-13 |
| `model/json.ts` | lane w-c | M-3, R-W17/20/21/23 | document-model §9.3 | Design and lead rulings; reader-branded values, decoded keys, native-token raw maps, no path keys | none | 2026-11-13 |
| `model/media.ts` | lane w-c | M-9, SEC-4, R-W14b/19/32 | document-model §8; native-format §5; security §4 | Design and lead rulings; authoritative MIME data incl AVIF, nullable duration and preserved fields | none | 2026-11-13 |
| `model/nodes.ts` | lane w-c | M-3, M-6/7/8/10, R-W17 | document-model §§3/9.3/10; ink §4; rulings R-W8/R-W13/R-W17 | Design and lead rulings only; explicit fixed-order constructors, shared defaults, opaque raw lexeme | none | 2026-11-13 |
| `model/defaults.ts` | lane w-c | M-3/7/9, R-W13/28/35 | document-model §§3.1–3.2/7; native-format §§3.2/5; spec/styles F-STYLE-010 | Lead-confirmed UI/view/media defaults; penStyle constant via lead citation; provisional initial pen/yellow selection | none | 2026-11-13 |
| `model/fileFields.ts` | lane w-c | M-3, H-2, R-W23 | document-model §9.3; native-format §§3.3–3.4; change-and-history §2 | Design/ruling; node and board property-to-native-token mapping for transactional raw invalidation and encoder | none | 2026-11-13 |
| `model/samples.ts` | lane w-c | M-10, V-10, CH-1 | ink §2.1; document-model §10.2 | Design and interface agreement with w-e; sealed pressure-mode metadata, no chunk read/decode | none | 2026-11-13 |
| `model/validate.ts` | lane w-c | DM-3, V-1..V-12, M-11, H-3, R-W25/30/32/40 | document-model §§3/5/6/9; change-and-history §2; text §4; security §§4/8.1 | Design/rulings; staged pressure consistency, internal inverse ext/whole-block/missing-media forms, shared text caps and live/preserved drop guards; no tldraw source | none | 2026-11-13 |
| `model/textOffsets.ts` | lane w-c | V-11, H-2, R-W18/21 | text §4.1; UTF-16 projection | Design and approved allocation-free UTF-16 scan, block-aligned inverse ranges and splice block counts | none | 2026-11-13 |
| `model/textLimits.ts` | lane w-c | V-11, H-2 | text §4; document-model §9 | Design/rulings; shared one-million UTF-16 and hundred-thousand block caps | none | 2026-11-13 |
| `model/rawMedia.ts` | lane w-c | M-3/9, R-W25/30/37 | document-model §9.3; preserved-media rulings | Independent escaped-string/key scan; 64-hex runs plus first/last candidates in longer runs, bounded ring and per-raw dedup; no parse, upstream read or registry | none | 2026-11-13 |
| `model/doc.ts` | lane w-c | M-1/3/4/6/8/10, C2.2, R-W17/18/19/20/21/23/25/30 | document-model §§1/3/5/6/8/9.3/10; native-format §6 | Design/lead rulings; C2.2 v4.5; app-owned paper type; live refs and reader-supplied preserved-ref counts; preserved fields/version/end; no tldraw source | none | 2026-11-13 |
| `model/applyOnly.ts` | lane w-c | M-1/4/5/6/8/10, H-1/2/3, R-W18/19/21/23/25/26 | document-model §§5/6/10; change-and-history §2 | Design/rulings; prepared binary sibling/live-index edits, explicit ext restoration, preserved-count/revision writes; fallible planning before commit primitives | none | 2026-11-13 |
| `change/ops.ts` | lane w-c | H-1/2/3/4/6, M-11, R-W19/21/23/26/40 | change-and-history §§2–3 | Design/rulings; exhaustive op/key policies, scene masks, inverse metadata forms and receipt sample leases; no tldraw source | none | 2026-11-13 |
| `change/apply.ts` | lane w-c | CH-1(a), H-1/2/3/4/6, V-10, D-10, R-W23/25/26/27/40 | change-and-history §§2–3; document-model §§9.3/10 | Design/rulings; sequential validation, explicit inverse replay, private savepoints, staged/live/receipt sample ownership, guarded fixed-order publication and unsafe-state sealing; no upstream implementation | none | 2026-11-13 |
| `change/rawChanges.ts` | lane w-c | H-2/3, M-3/9, R-W23/25/37/40 | document-model §9.3; change-and-history §2 | Design/rulings; diff RawJson carrier multiplicities, scan entering/leaving values, omit only owning media self-reference | none | 2026-11-13 |
| `session/BoardSession.ts` | lane w-c | H-1/3/4, C7.0/5/6 | change-and-history §§2–4; contracts C7 | Design; core save-funnel §2; no tldraw source | none | 2026-11-13 |
| `text/richText.ts` | lane w-c | M-3, V-11, H-2/3, R-W19/21/25 | text §4.1; change-and-history §2 | Design/rulings only; minimal immutable normalize/slice/splice, opaque carrier preservation and exact boundary-block inverse splices, not whole-value undo snapshots | none | 2026-11-13 |

## Agent adapter (lane w-p)

| Module | Author | Spec ids | Design section | Sources consulted | Third-party code | Date |
|---|---|---|---|---|---|---|
| `agent/shapes.ts` | w-p | F-AGENT-001, WB-D11, WB-D12, C8 | integration §9 | Agent specification, C8, public model interfaces; authoritative geometry supplied by shared projection; no tldraw or old canvas source | none | 2026-11-13 |
| `agent/transaction.ts` | w-p | F-AGENT-002/003/004/005/012/013, C8 | integration §9; change and history §3 | Agent specification and model/apply public interfaces; no tldraw or old canvas source | none | 2026-11-13 |
| `agent/validate.ts` | w-p | F-AGENT-002/012/013/015, C8 | integration §9 | Agent specification and public model style vocabulary; no tldraw or old canvas source | none | 2026-11-13 |
| `agent/create.ts` | w-p | F-AGENT-002/012/013, C8 | integration §9, document-model §§3–4 | Agent spec and public model/change/page APIs; no tldraw or old canvas source | none | 2026-11-13 |
| `agent/createInk.ts` | w-p | F-AGENT-002/003/013/015, C8 | integration §9, ink §2 | Agent spec, sample store and public geometry/model APIs; no tldraw or old canvas source | none | 2026-11-13 |
| `agent/update.ts` | w-p | F-AGENT-004/012, WB-D10, C8 | integration §9, document-model §§3/7 | Agent specification and model/change/style metrics APIs; placement delegated to authoritative staged geometry; no tldraw or old canvas source | none | 2026-11-13 |
| `agent/stage.ts` | w-p | F-AGENT-002/003/004/005/012, R-11, C8 | integration §9 | Agent specification and public model/change APIs, delegates protected deletion and authoritative geometry; no tldraw or old canvas source | none | 2026-11-13 |
| `agent/errors.ts` | w-p | F-AGENT-012/013, C8 | integration §9 | Agent specification; no tldraw or old canvas source | none | 2026-11-13 |

## Formats, importer, save and agent adapter (lane w-d)

| Module | Author | Spec ids | Design section | Sources consulted | Third-party code | Date |
|---|---|---|---|---|---|---|
| `format/schema.ts` | w-d | FMT-1, F-1, F-5, F-6, F-8; R-W4/5/6/8/11/13/17/20/30/32/35 | native-format §§3,5,6,10; document-model §§1–4,7–9; text §4; security §§1,3–4 | The named greenfield specifications; w-c's public model types and shared defaults (no implementation copied); lead's recorded rulings; R-W17/20 replace source-sidecar types with model-owned raw lexemes; no tldraw source/packages | none | 2026-11-13 |
| `format/points.ts` | w-d | FMT-2, F-3, F-9, E-FMT-7/18/21; R-W2/3/28/29/31/36/39 | native-format §4; ink §2.2 | The named greenfield specifications; arithmetic LEB128, zig-zag and second differences described there; lead's recorded arithmetic/inspection/run rulings; full validation without coordinate arrays, scale-aware precision, local quantized bounds/pressure summaries; no tldraw source/packages | none | 2026-11-13 |
| `format/fence.ts` | w-d | F-10, FC-7; R-W15 | native-format §3.6; independence-protocol §3 conditions 1–5 | Native specification's exact inert bytes; its fact source is `formats/corpus/received/failure-results.json` (newer-schema/newer-sequences, empty-object/malformed); lead's W-D1 house-style review and R-W15's exact plain-word purpose label; no corpus source, old canvas code or tldraw package opened | none | 2026-11-13 |
| `format/encode.ts` | w-d | FMT-3, F-1/5/6/7/8/10; R-W13/14/15/16/17/19/20/22/23/25/30/34/35/36 | native-format §§3,11; document-model §§3,7,8; text §4.2 | Those greenfield plans; w-c's public model/defaults/fileFields types and data; model-owned live/preserved media index contract; lead's recorded rulings; w-e's sample-coordinate/run contract (no ink implementation read); no tldraw source/packages | none | 2026-11-13 |
| `format/lineTable.ts` | w-d | FMT-3, F-6/7; R-W16/30 | native-format §§3.2,11 | Those greenfield plans; TouchedSet public type; lead-approved commutative four-lane consistency digest, using independently seeded 32-bit FNV-style arithmetic (not a security hash); immutable shared-line revision forks and canonical recovery positions; no third-party implementation consulted | none | 2026-11-13 |
| `format/writeJson.ts` | w-d | FMT-3, F-5/6; R-W16/17/20/22/23 | native-format §§3.3,6,10,11; text §4.2 | Those greenfield plans and raw-lexeme rulings; model RawJson/ExtBag public types; JSON token/string rules implemented independently; no tldraw source/packages | none | 2026-11-13 |
| `format/writeTypes.ts` | w-d | FMT-3, F-6/7 | native-format §§3.1–3.3,10,11 | Those greenfield plans; JSON identity tuples and UTF-8 byte-length rules implemented independently; no tldraw source/packages | none | 2026-11-13 |
| `format/jsonRead.ts` | w-d | FMT-4, F-5/8/9; R-W16/20/22/30/33 | native-format §§3.3/6/7/10; security §3 | Independent bounded lexical JSON walk; validated raw spans and decoded-key duplicate rejection; no third-party parser implementation or tldraw source | none | 2026-11-13 |
| `format/readTypes.ts` | w-d | FMT-4, F-4/8/9; R-W28/29/38/39 | native-format §§6–8; document-model §5 | Public ordered-draft/source-position/host-lease contract agreed with w-c, w-e and w-b; immutable stroke inspection metadata, not graph admission | none | 2026-11-13 |
| `format/readModel.ts` | w-d | FMT-4, F-4/5/8/9; R-W25/28/29/30/33/35/38/39 | native-format §§3/5–8; text §4; document-model §§3/7–9 | Plans, shared model defaults/types, pure app-owned paper.ts; required pdf-and-drawings skill read in full (describes old integration names/behaviour), no old canvas implementation or tldraw source/package opened | none | 2026-11-13 |
| `format/read.ts` | w-d | FMT-4, F-4/5/8/9, E-FMT-1/2/3/4/8/9/10/11/12/13/14; R-W25/28/29/33/37/38/39/40 | native-format §§6–8/10; security §3 | Independent bounded byte/UTF-8/line admission and no-record-lines fallback; model-owned raw visitors/scanner for every retained carrier; original retention/read-only and lease ownership delegated explicitly to host; no third-party or tldraw code | none | 2026-11-13 |

| `format/serializerProtocol.ts` | w-d | CH-3, F-7 | native-format §11; change-and-history §5 | Greenfield plans and platform worker host plain-data contract; parsed bytes and durable Blob/index baseline, revision-pinned delta/build envelopes | none | 2026-11-13 |
| `format/serializer.worker.ts` | w-d | CH-3, F-7 | native-format §11; change-and-history §5 | Platform serve/CPU cooperation; independently built per-revision line snapshots and Blob recovery index; app-owned pure utils/sha256.ts incremental FIPS implementation; no tldraw source/package | none | 2026-11-13 |
| `format/serializerClient.ts` | w-d | CH-3, F-7, C7.5 | native-format §11; change-and-history §5 | Platform worker client/governor; session-owned parsed-byte/durable-Blob recovery and pinned version branches; no tldraw source/package | none | 2026-11-13 |
| `format/recordChanges.ts` | w-d | CH-3, F-7 | native-format §11; change-and-history §5 | Model Applied/TouchedSet and encoder public seams, changed-record UTF-8 plus incremental record revision digest; no tldraw source/package | none | 2026-11-13 |
| `session/saveScheduler.ts` | w-d | CH-3, H-4/7 | change-and-history §5 | Session-owned 150ms debounce, gesture/composition hold, serialized pinned 500ms journal capture; no tldraw source/package | none | 2026-11-13 |
| `session/contentSource.ts` | w-d | CH-3, C7.5 | change-and-history §5; contracts C7 | Synchronous immutable revision-pinned BuildJob interface; PDF host composes pinned lists/bytes without an independent write; no tldraw source/package | none | 2026-11-13 |
| `security/limits.ts` | w-d | SEC-W1, SEC-8 | security §3 | Independently implemented inclusive encoded-byte/pixel limits and checked aggregate arithmetic, before allocation/decoding; no tldraw source/package | none | 2026-11-13 |
| `security/urlPolicy.ts` | w-d | SEC-W1, SEC-5/6/7 | security §8 | Independent URL parser policy and literal IPv4/IPv6 special-address classification; no DNS-rebinding claim, no automatic requests; no third-party matcher code | none | 2026-11-13 |
| `security/admission.ts` | w-d | SEC-W1, SEC-8 | security §3 | Fixed immutable session/epoch/generation/request jobs, bounded serialized queue and cancellation/current checks; no tldraw source/package | none | 2026-11-13 |
| `security/validatedImport.ts` | w-d | SEC-W1, SEC-8 | security §3 | Issuer-private one-shot WeakMap brand, trusted schema-validator seam and bounded owned inert data projection; no executable values, accessors or foreign prototypes; no tldraw source/package | none | 2026-11-13 |

## Ink, scene, rendering and the viewer host (lane w-e)

| Module | Author | Spec ids | Design section | Sources consulted | Third-party code | Date |
|---|---|---|---|---|---|---|
| `ink/samples.ts` | lane w-e | D-13; F-INK-006/007/010; E-DOC-24; FMT-2; V-10; CH-1; R-W26/28/29/31/34/39 | `architecture/ink.md` §2.1; `document-model.md` §10; `native-format.md` §4.2, §7.2 | Those plans; W-C1 reader types; w-d's greenfield public point decoder and agreed PointHeader shape; owned immutable chunks, lazy encoded native backing, exact native grid packing and explicit leases; readEncoded borrows the original native payload without materialization; pressureMode reads record metadata in O(1) without a view or decode; R-W39 keeps inspected local bounds/maximum pressure frozen on the record; authored encoding caches deferred (never canonical backing); lease allocation precedes owner increment; one native outgoing-to-storage-incoming translation; no tldraw source read | none | 2026-11-13 |
| `ink/canonicalize.ts` | lane w-e | D-13; F-INK-006/007/010 | `architecture/ink.md` §2.1, §3.4; lead rulings R-W9 and E1 certificate scope | Those plans and lead rulings; E1 certifies ONLY axis-aligned exact-collinear constant-pressure windows (zero coverage displacement); all general/slanted/curved candidates retained for W-E1b; bounded whole-control-hull packing certificate; formatting follow-up only (4 spaces, semicolons); no tldraw source read | none | 2026-11-13 |
| `ink/curve.ts` | lane w-e | D-13; F-INK-006/010 | `architecture/ink.md` §3.2–3.3 | That plan; Bernstein/Hermite identities and convex-hull displacement derived from first principles, no library implementation consulted; exact endpoint, validated positive scale/DPR envelope and separate prediction publications; formatting follow-up only (4 spaces, semicolons); no tldraw source read | none | 2026-11-13 |
| `ink/packet.ts` | lane w-e | D-13; F-INK-005/006/007 | `architecture/ink.md` §6.1–7 | That plan's verbatim packet contract; W-C1 WidthModel; W-E2's shared coverage/radii, calibrated-or-explicitly-provisional dot discs and arc-length evaluator; own bounded packing and rebasing; no tldraw source read | none | 2026-11-13 |
| `ink/width.ts` | lane w-e | D-13; F-INK-006/007; E-INK-1/2/12/13; WB-D20 | `architecture/ink.md` §4; `geometry.md` §3.2 | Actual stored width only (no duplicate StyleGeometryMetrics factors); W-C1 WidthModel; lead's W-E2 dot ruling selects DOT-M1 z1/DPR1 equivalent-diameter rows as an explicitly provisional product table, not a recovered continuous radius; own pressure/arc interpolation and point-only resize; no tldraw source read | none | 2026-11-13 |
| `ink/flatten.ts` | lane w-e | D-13; F-INK-005; E-INK-4/9/10/11 | `architecture/ink.md` §5–6 | M. Breuß, Numerical Algorithms for Visual Computing I (Saarland, 2008) §5.3 Theorem 7, https://www.mia.uni-saarland.de/Teaching/NAVC08/NAVC2008.pdf (convexity/subdivision mathematics); J. Gravesen, The Length of Bézier Curves, Graphics Gems IV IV.7 (bibliographic/search excerpt only); own finite-segment hull tube, length enclosures and typed work-stack derivation; no library code | none | 2026-11-13 |
| `ink/outline.ts` | lane w-e | D-13; R-20; F-INK-005/006; E-INK-7/8/12/13; R-W24 | `architecture/ink.md` §4–6 | Own swept endpoint-disc convex hull/external tangents and positive nonzero-union paths; CGAL Minkowski Sum manual https://doc.cgal.org/latest/Minkowski_sum_2/index.html (offset mathematics only, no package code); own cubic-circle radial error identity; lead R-W24 half-open/right-continuous dash rule and separate explicit point motifs; resumable per-command/refinement outline emission shares cap math with the synchronous wrapper for cooperative Layer.prepare; no tldraw source read | none | 2026-11-13 |
| `ink/pick.ts` | lane w-e | R-13; WB-D24; R-20; E-INK-7/8 | `architecture/ink.md` §6.2; `geometry.md` §5.1 | Gilbert, Johnson, Keerthi (1988), IEEE JRA 4(2):193–203, §III support-set mathematics, https://graphics.stanford.edu/courses/cs164-09-spring/Handouts/paper_GJKoriginal.pdf; own 2D simplex reduction, affine ellipse/capsule support and certified distance intervals; no package implementation or tldraw source read | none | 2026-11-13 |
| `scene/bounds.ts` | lane w-e | WIP W-E3; R-W38/39 | rendering §§2,6; document-model §§6.1,10.2 | Greenfield model/ink public types and R-W38/39; own Float64 affine and conservative source-summary bounds; injected exact-layout metrics; no tldraw source | none | 2026-11-13 |
| `scene/index.ts` | lane w-e | WIP W-E3 | rendering §6 | Kamel/Faloutsos, On Packing R-trees, CIKM1993, https://www.cs.cmu.edu/~christos/PUBLICATIONS.OLDER/cikm93.pdf (search/abstract ideas only); own Hilbert quadrant construction and standard AVL height rotations, no library implementation | none | 2026-11-13 |
| `scene/order.ts` | lane w-e | WIP W-E3 | rendering §§2,3.1,6 | Own fixed-size chunk sequence and Fenwick rank counts; public model stable-slot/order requirements; no library or tldraw code | none | 2026-11-13 |
| `render/colour.ts` | lane w-e | W-E4 shared contract | rendering §5.2; C2.4 | Public Rgba/RgbaP contracts; encoded-sRGB premultiplication and W3C source-over/multiply algebra from design; injected theme palettes, no legacy palette implementation | none | 2026-11-13 |
| `render/material.ts` | lane w-e | W-E4 shared contract; R-20 | rendering §§3.1,4,5.2 | Design's non-isolated inherited opacity and two highlighter bands0.82/0.35; public stroke metrics; own resolved material construction | none | 2026-11-13 |
| `render/paintStream.ts` | lane w-e | W-E4 shared contract | rendering §§2–5,11,12 | Shared platform/ink public types; direct v-b consumer agreement; own ordered two-band resumable command emission and clip/image transform contract, no second scene or stroker | none | 2026-11-13 |
| `render/resources.ts` | lane w-e | W-E4 shared contract | rendering §§7,10,11; C4 | Public render tokens and direct v-b preparation/asset-lease agreement; injected origin-clean async decoder ownership, immutable frame source and existing-host invalidation, no private scheduler/context | none | 2026-11-13 |

## Canvas 2D path (lane v-b)

| Module | Author | Spec ids | Design section | Sources consulted | Third-party code | Date |
|---|---|---|---|---|---|---|
| `render/reference/canvasPaintAdapter.ts` | lane v-b | C2.4, C4.3; R-20; F-INK-005/006/007 | rendering §§2–5,10–13; ink §6 | Those greenfield plans; platform frame budget and w-e's public paint/resource contracts; bounded path work, async lease ownership and complete-frame publication; no tldraw source | none | 2026-11-13 |
| `render/reference/paint2d.ts` | lane v-b | C2.4, C4.3; R-20; F-INK-005/006/007 | rendering §§2–5,10–13; ink §6 | Those greenfield plans; w-e's public paint stream/material/colour contract; Canvas 2D API for clips, paths, images and compositing; no tldraw source | none | 2026-11-13 |
| `render/reference/coverage2d.ts` | lane v-b | C2.4, C4.3; F-INK-005/006/007; E-INK-7/8 | rendering §§2–5,10–13; ink §6.1 | Those greenfield plans; platform PathCommand and w-e's canonical InkCoverage/InkOutlineJob public interfaces; bounded work for ink, clips and ordinary paths, unpublished-path lifetime and double-precision origin rebasing from the design; native Path2D command methods; no tldraw source | none | 2026-11-13 |

## Importer and conversion (lane w-o)

| Module | Author | Spec ids | Design section | Sources consulted | Third-party code | Date |
|---|---|---|---|---|---|---|
| `import/segments.ts` | w-o | IMP-2, E-IMP-15 | import §3; current-format §2.3 | Documented legacy point layout and corpus facts; no old canvas or tldraw source | none | 2026-11-13 |
| `import/pages.ts` | w-o | IMP-3, E-IMP-7/9 | import §3.1 | Page-local mapping, geometry-preparation port, notebook layout and saved PDF backdrop layout contract | none | 2026-11-13 |
| `import/report.ts` | w-o | IMP-5 | import §§1,6 | Import report and notice contract | none | 2026-11-13 |
| `import/records/envelope.ts` | w-o | IMP-1, E-IMP-1/2/4 | import §§2,6; current-format §§1–3 | Observed envelopes, schema counters and mismatched-record recovery | none | 2026-11-13 |
| `import/records/storeFields.ts` | w-o | IMP-1, E-IMP-4 | import §6; document-model §9.2 | JSON format and duplicate-record preservation requirement | none | 2026-11-13 |
| `import/records/common.ts` | w-o | IMP-1, IMP-3 | import §§2–3; current-format §2 | Observed shape and backdrop layout | none | 2026-11-13 |
| `import/records/sheets.ts` | w-o | IMP-1 | import §3; current-format §2 | Observed page and metadata fields | none | 2026-11-13 |
| `import/records/stroke.ts` | w-o | IMP-1/2, E-IMP-15 | import §3; geometry §3.2 | Observed segment/style fields; shared style metrics and public sample model | none | 2026-11-13 |
| `import/records/basic.ts` | w-o | IMP-1 | import §3; current-format §2 | Documented group, frame, embed and line records; shared style metrics | none | 2026-11-13 |
| `import/records/bindings.ts` | w-o | IMP-1, E-IMP-5 | import §§3,6 | Documented connector bindings and dangling-target rule | none | 2026-11-13 |
| `import/records/fields.ts` | w-o | IMP-1, E-IMP-3 | import §§2–3,6 | Observed properties and unknown-field refusal | none | 2026-11-13 |
| `import/records/labelled.ts` | w-o | IMP-1 | import §3; geometry §3.2 | Documented figure, text, note and connector fields; shared style metrics; rich reader injected | none | 2026-11-13 |
| `import/records/media.ts` | w-o | IMP-1, E-IMP-6 | import §3; security §4 | Inline asset format and w-q SEC-W4 admission seam | none | 2026-11-13 |
| `import/records/pictures.ts` | w-o | IMP-1 | import §3; current-format §2 | Observed picture, video and bookmark fields | none | 2026-11-13 |
| `import/records/view.ts` | w-o | IMP-1 | import §3; current-format §§2,6 | Documented session, camera and UI fields | none | 2026-11-13 |
| `import/scale.ts` | w-o | IMP-3, E-IMP-9 | import §3.1; contracts C2.3 | Uniform page-local transformation of public model records | none | 2026-11-13 |
| `import/repair.ts` | w-o | IMP-1, E-IMP-4/5 | document-model §9.2; import §6 | Load-only parent, group, id, order and attachment repair rules | none | 2026-11-13 |
| `import/sheets.ts` | w-o | IMP-1, E-IMP-4 | document-model §§4,9.2 | Sheet naming and key model | none | 2026-11-13 |
| `import/admit.ts` | w-o | IMP-1, IMP-5 | document-model §§9–10; import §§1,6 | Public model validation and apply controller | none | 2026-11-13 |
| `import/records/read.ts` | w-o | IMP-1/3/5, E-IMP-7 | import §§1–3,6 | Documented record families; page bounds prepared after node mapping; report and host admission contracts | none | 2026-11-13 |
| `import/import.ts` | w-o | IMP-1/3/5 | import §§1–3,6 | In-memory source retention, failure reporting, ordered draft and model admission | none | 2026-11-13 |

## Export and whiteboard host (lane w-k)

| Module | Author | Spec ids | Design section | Sources consulted | Third-party code | Date |
|---|---|---|---|---|---|---|
| `export/png.ts` | lane w-k | F-EXPORT-002/006; E-EXP-4; EX-5/7 | export §§2–3, 7; clipboard §2.4 | Export design; PNG chunk layout, sRGB and pHYs; browser CompressionStream; independent CRC arithmetic and per-row PNG filter choice; no tldraw source | none | 2026-11-13 |
| `export/tiles.ts` | lane w-k | F-EXPORT-002/006; E-EXP-4; EX-5/7 | export §§2–3, 7 | Export design; bounded bands and a renderer-supplied RGBA tile; no tldraw source | none | 2026-11-13 |
| `export/rasterTile.ts` | lane w-k | F-EXPORT-002/006; EX-5/7 | export §§2–3, 7 | Export design; shared reference painter and capture-pinned resources, per-tile world projection; no tldraw source | none | 2026-11-13 |
| `export/displayList.ts` | lane w-k | F-EXPORT-001/003; EX-2/3/4 | export §§2, 4–5; rendering §3 | Shared paint frame, world-space clip geometry, source-pixel image crop, shared ink outline and PDF display contract; no tldraw source | none | 2026-11-13 |
| `export/svg.ts` | lane w-k | F-EXPORT-001/003; EX-2/3/4 | export §§2, 4–5 | Resolution-free shared display-list serialization, self-contained embedded images and local clip paths; no tldraw source | none | 2026-11-13 |
| `export/pngWorkerProtocol.ts` | lane w-k | F-EXPORT-002/006; EX-5/7 | export §§2–3, 7 | Export design; row backpressure protocol; no tldraw source | none | 2026-11-13 |
| `export/png.worker.ts` | lane w-k | F-EXPORT-002/006; EX-5/7 | export §§2–3, 7 | Export design; dedicated streaming encoder and cancellation; no tldraw source | none | 2026-11-13 |
| `export/pngWorkerClient.ts` | lane w-k | F-EXPORT-002/006; EX-5/7 | export §§2–3, 7 | Export design; bounded-band producer and transferable owned rows; no tldraw source | none | 2026-11-13 |
| `export/prepareRaster.ts` | lane w-k | F-EXPORT-002/006; EX-5/7 | export §§2–3, 7; rendering §3 | Shared reference geometry jobs and image lease contract; pinned capture resources; no tldraw source | none | 2026-11-13 |
| `export/capturePng.ts` | lane w-k | F-EXPORT-002/006; EX-5/7 | export §§2–3, 7 | Export design; pinned capture preparation, worker encoding and lease cleanup; no tldraw source | none | 2026-11-13 |

## Text (lane w-n)

| Module | Author | Spec ids | Design section | Sources consulted | Third-party code | Date |
|---|---|---|---|---|---|---|
| `text/graphemes.ts` | lane w-n | T-1, T-5 | text §§2, 4, 9 | Design; Intl.Segmenter browser API; no tldraw source | none | 2026-11-13 |
| `text/unicode.ts` | lane w-n | T-1 | text §2 | Unicode 17.0.0 property and paired-bracket tables; no tldraw source | none | 2026-11-13 |
| `text/lineBreak.ts` | lane w-n | T-1 | text §2 | UAX #14 revision 55, Unicode 17.0.0 tables, Intl.Segmenter for SA words; independently implemented | none | 2026-11-13 |
| `text/bidi.ts` | lane w-n | T-1 | text §2 | UAX #9 revision 51 and Unicode 17.0.0 tables; independently implemented | none | 2026-11-13 |
| `text/unicodeTables.ts` | lane w-n | T-1 | text §§2, 9, 13 | Generated from Unicode 17.0.0 UCD, Unicode License v3; hashes and full notice under tools/whiteboard-unicode/data/17.0.0 | Unicode data | 2026-11-13 |
| `tools/whiteboard-unicode/generate.mjs` | lane w-n | T-1 | text §§2, 9, 13 | UCD data format; no tldraw source | none | 2026-11-13 |
| `tools/whiteboard-unicode/data/17.0.0/*` | lane w-n | T-1 | text §§2, 9, 13 | unicode.org/Public/17.0.0/ucd; exact file hashes and Unicode License v3 notice alongside | Unicode data | 2026-11-13 |
| `text/paint.ts` | lane w-n | T-1, T-2, T-4, T-5 | text §§3, 5.5–5.6, 6 | Design's renderer contract and caret-index geometry; shared platform/model types; no tldraw source | none | 2026-11-13 |
| `text/measure.ts` | lane w-n | T-1, T-2 | text §§2–3, 7.2 | Canvas TextMetrics API and fixed-size draw recipe; bounded epoch-aware cache | none | 2026-11-13 |
| `text/itemize.ts` | lane w-n | T-1, T-2 | text §§2–3 | Rich-text runs and independently implemented Unicode line, bidi and grapheme APIs | none | 2026-11-13 |
| `text/wrap.ts` | lane w-n | T-1, T-2 | text §§2, 6 | Greedy Unicode line opportunities and grapheme emergency breaks, own implementation | none | 2026-11-13 |
| `text/layout.ts` | lane w-n | T-1, T-2, T-6 | text §§2–3, 6–7 | Unicode itemizer and bidi reordering, face metrics and canvas measurement, heading sizes from spec/text F-TEXT-012; own layout implementation | none | 2026-11-13 |
| `text/caretIndex.ts` | lane w-n | T-4, T-5 | text §§5.3–5.6 | Independent reference-size prefix measurement and grapheme-index geometry | none | 2026-11-13 |
| `text/layout.worker.ts` | lane w-n | T-1, T-2, T-6 | text §§2–3, 7.2 | OffscreenCanvas, worker-local FontFaceSet and platform worker protocol | none | 2026-11-13 |
| `text/fonts.ts` | lane w-n | T-6 | text §7 | FontFace API; lazy per-context registration and epoch, no tldraw source | none | 2026-11-13 |
| `text/fontMetrics.json` | lane w-n | T-6 | text §7 | Generated directly from pinned upstream WOFF2 metrics tables | font metrics | 2026-11-13 |
| `text/fonts/*.woff2` | lane w-n | T-6 | text §7.1; IR-4 | Arrow Type Shantell Sans 1.011 release ZIP matches tagged tree; IBM Plex Sans/Serif/Mono 1.1.0 tags; exact per-file URLs, tags and SHA-256 in `tools/whiteboard-fonts/manifest.json` and G-TXT-FONTPIN | upstream unmodified fonts, SIL OFL 1.1, Plex Reserved Font Name | 2026-11-13 |
| `tools/whiteboard-fonts/manifest.json` | lane w-n | T-6 | text §7.1 | Upstream release and tag URLs and SHA-256 for each font | font metadata | 2026-11-13 |
| `tools/whiteboard-fonts/generate.mjs` | lane w-n | T-6 | text §§7.1–7.2 | W3C WOFF2 directory and Brotli format; own metrics extraction and pinned-hash gate | none | 2026-11-13 |
| `tools/whiteboard-fonts/{Shantell-OFL,IBM-Plex-OFL}.txt` | lane w-n | T-6 | text §7.1 | Exact upstream licences including copyright and Reserved Font Name | SIL OFL 1.1 notices | 2026-11-13 |

## Geometry and selection (lane w-g)

| Module | Author | Spec ids | Design section | Sources consulted | Third-party code | Date |
|---|---|---|---|---|---|---|
| `geom/bounds.ts` | lane w-g | GE-1, W-E3 | geometry §2.3; rendering §6 | Generic box helpers moved with w-e's agreement; independent interval-filtered cubic and arc extrema | none | 2026-11-13 |
| `scene/bounds.ts` | lane w-g | GE-1, W-E3 | geometry §2.3; rendering §6 | Re-export generic helpers from geom/bounds.ts to retain the scene API | none | 2026-11-13 |
| `geom/numeric.ts` | lane w-g | GE-1 | geometry §2.1–2.2 | Design; IEEE 754 binary64; independent dyadic arithmetic | none | 2026-11-13 |
| `geom/predicates.ts` | lane w-g | GE-1 | geometry §2.2 | Design; interval-filtered exact dyadic predicates | none | 2026-11-13 |
| `geom/affine.ts` | lane w-g | GE-1 | geometry §2.3 | Design; shared affine helpers and singular value identity | none | 2026-11-13 |
| `geom/flatten.ts` | lane w-g | GE-1 | geometry §2.4 | Design; w-e's bounded ink cubic flattening job and circular sagitta bound | none | 2026-11-13 |
| `geom/path.ts` | lane w-g | GE-1 | geometry §§1–2 | Design path and curve types; interval Bernstein radial error for tangent-matched arc cubics | none | 2026-11-13 |
| `geom/types.ts` | lane w-g | GE-1 | geometry §§1,5 | Design; platform affine/rect and model node contracts; provider-owned types injected | none | 2026-11-13 |

## Figures and geometry providers (lane w-h)

| Module | Author | Spec ids | Design section | Sources consulted | Third-party code | Date |
|---|---|---|---|---|---|---|
| `geom/styleMetrics.ts` | lane w-h | WB-D20 | geometry §3.2 | Geometry design and its provisional measurement table; finite metric admission; no tldraw source | none | 2026-11-13 |
| `geom/figures.ts` | lane w-h | F-FIG-001/002/003/004 | geometry §3 | Independent shape recipes and local semantic bounds from the design; FIG creation ratios and seed-centred gestures; analytic ellipse/stadium/cloud and fourth-derivative Hermite error bound; no tldraw source | none | 2026-11-13 |
| `geom/variants.ts` | lane w-h | WB-D20 | geometry §3.1 | Design's bounded deterministic displacement recipe and continuous dash phase; no tldraw source | none | 2026-11-13 |

## Media and clipboard (lane w-q)

| Module | Author | Spec ids | Design section | Sources consulted | Third-party code | Date |
|---|---|---|---|---|---|---|
| `media/sha256.ts` | lane w-q | F-MEDIA-003/004; SEC-4 | media §1.2; security §3.2 | FIPS 180-4 §6.2 algorithm as specified in the design; independently implemented; no tldraw source | none | 2026-11-13 |
| `media/sniff.ts` | lane w-q | F-MEDIA-001/003; SEC-4 | media §1; security §6 | Format signatures from security §6, independent implementation | none | 2026-11-13 |
| `media/headers.ts` | lane w-q | F-MEDIA-001/003/011; SEC-4 | media §1; security §6 | Image container header structures, independently implemented; no tldraw source | none | 2026-11-13 |
| `media/isoHeaders.ts` | lane w-q | F-MEDIA-001/003; SEC-4 | security §6 | ISO-BMFF bounded boxes and AVIF primary-property association, independently implemented | none | 2026-11-13 |
| `media/webmHeader.ts` | lane w-q | F-MEDIA-001/003; SEC-4 | security §6 | EBML bounded element encoding and WebM track fields, independently implemented | none | 2026-11-13 |
| `media/decode.worker.ts` | lane w-q | F-MEDIA-001/003/004; SEC-4 | media §1; threading §2; security §6 | Platform worker contract and browser bitmap API; no tldraw source | none | 2026-11-13 |
| `media/inspect.ts` | lane w-q | F-MEDIA-001/003; SEC-4 | media §1; security §§3/6 | SEC-W1 budgets; platform worker and memory allocator contracts; isolated SVG profile injection | none | 2026-11-13 |
| `media/ingest.ts` | lane w-q | F-MEDIA-001/002/003/004/008; SEC-4 | media §§1–3; security §3 | SEC-W1 budgets and shared session job authority; board model/apply contracts | none | 2026-11-13 |
| `media/store.ts` | lane w-q | F-MEDIA-004; SEC-4 | media §3–4; security §4 | Session ownership, history and clipboard lifetime requirements | none | 2026-11-13 |
| `media/svgProfile.ts` | lane w-q | F-MEDIA-001/003; SEC-3/4 | security §§5–6 | Separate opaque XML/image profiles and fixed-shape response requirements | none | 2026-11-13 |
| `media/svgXmlRuntime.ts` | lane w-q | F-MEDIA-001/003; SEC-3/4 | security §6 | Worker XML preflight; SVG parsing and dimensions in isolated realm only | none | 2026-11-13 |
| `media/svgImageRuntime.ts` | lane w-q | F-MEDIA-001/003; SEC-3/4 | security §6 | Browser image-context rasterization, isolated image profile only | none | 2026-11-13 |
| `media/svgFrameRuntime.ts` | lane w-q | SEC-3/4 | security §§5–6 | Token-bound sequential bounded transfer within opaque profile | none | 2026-11-13 |
| `media/svgXmlEntry.ts` | lane w-q | SEC-3/4 | security §6 | Network-denied XML profile entry | none | 2026-11-13 |
| `media/svgImageEntry.ts` | lane w-q | SEC-3/4 | security §6 | Network-denied blob-image profile entry | none | 2026-11-13 |
| `media/svgFrameHost.ts` | lane w-q | SEC-3/4 | security §§5–6 | SEC-W2 frame API, token validation, bounded acknowledged transfer | none | 2026-11-13 |
| `media/svgFrames.d.ts` | lane w-q | SEC-3/4 | security §6 | Build-time virtual fixed-frame declarations | none | 2026-11-13 |
| `build/whiteboardSvgFrames.mjs` | lane w-q | SEC-3/4 | security §§5–6 | SEC-W2 exact-byte hashing/bundling helper; strict separate profile CSPs | none | 2026-11-13 |

## Text editing and spelling (lane w-i)

| Module | Author | Spec ids | Design section | Sources consulted | Third-party code | Date |
|---|---|---|---|---|---|---|
| `text/edit/window.ts` | w-i | T-4, E-TXT-21 | text §5.3 | Design and Unicode grapheme boundary API; no tldraw source | none | 2026-11-13 |
| `text/edit/host.ts` | w-i | T-4, F-TEXT-016, E-TXT-2/12/15/21/22 | text §§5.1–5.3, 5.10 | Design, browser EditContext and textarea APIs, window-relative IME format ranges | none | 2026-11-13 |
| `text/edit/session.ts` | w-i | T-4, F-TEXT-006/011/015/016/018, WB-D26, E-TXT-2/5/12/15 | text §§5.1–5.7, 5.9–5.10 | Design and TX-3 public paint/caret types; injected model, history and view services; caret, selection, IME chrome and formatting dispatch | none | 2026-11-13 |
| `text/edit/controller.ts` | w-i | T-5, WB-D26 | text §§4–5 | Design and public change operation types | none | 2026-11-13 |
| `text/edit/format.ts` | w-i | WB-D26, E-TXT-14 | text §§4.1, 5.9 | Design and URL platform API | none | 2026-11-13 |
| `text/edit/keys.ts` | w-i | F-TEXT-006/011, WB-D14 | text §5.4 | Design and Intl.Segmenter through TX-1 | none | 2026-11-13 |
| `text/edit/pointer.ts` | w-i | F-TEXT-006 | text §5.6 | Design, pointer and timer APIs | none | 2026-11-13 |
| `text/edit/selection.ts` | w-i | F-TEXT-006/018 | text §5.6 | Design and Intl.Segmenter | none | 2026-11-13 |
| `text/edit/caret.ts` | w-i | F-TEXT-006/018 | text §§5.4–5.5, 9 | TX-3 public caret index and design | none | 2026-11-13 |
| `text/edit/geometry.ts` | w-i | E-TXT-5 | text §5.3 | Design, platform Rect and affine rectangle bounds | none | 2026-11-13 |
| `text/edit/rules.ts` | w-i | F-TEXT-011/012/015 | text §5.4 | Design and TX-2 rich splice types | none | 2026-11-13 |
| `text/edit/tool.ts` | w-i | F-TEXT-001/002 | text §5.6; spec/text | Design and w-f public Tool interface | none | 2026-11-13 |
| `text/spell/words.ts` | w-i | COV-34 | text §5.8 | Design and Intl.Segmenter | none | 2026-11-13 |

## Editing lanes (w-f to w-j)

### Input (lane w-f)

| Module | Author | Spec ids | Design section | Sources consulted | Third-party code | Date |
|---|---|---|---|---|---|---|
| `input/tool.ts` | lane w-f | F-INPUT-001/004/005; R-19 | input §§2,7 | Input architecture and behavioural spec; no tldraw source | none | 2026-11-13 |
| `input/router.ts` | lane w-f | F-INPUT-001/004/005; R-19 | input §§2,7,9 | Input architecture and behavioural spec; no tldraw source | none | 2026-11-13 |
| `input/gesture.ts` | lane w-f | F-TOOL-002/003/004 | input §7; toolbar §§2–4 | Tool and input behavioural specifications; no tldraw source | none | 2026-11-13 |
| `input/pointer.ts` | lane w-f | F-INPUT-001/005/008; R-19 | input §§3–4 | Input architecture; browser Pointer Events APIs; no tldraw source | none | 2026-11-13 |
| `input/prediction.ts` | lane w-f | F-INPUT-001; R-19 | input §4 | Input architecture; browser Pointer Events and Ink APIs; no tldraw source | none | 2026-11-13 |
| `input/frame.ts` | lane w-f | F-INPUT-001; R-19 | input §4 | Input architecture and shared scheduler contract; no tldraw source | none | 2026-11-13 |
| `input/navigation.ts` | lane w-f | F-INPUT-002/003/004/005; F-CAM-001/009 | input §§5–6 | Input design and public platform CameraController; no tldraw source | none | 2026-11-13 |

## Pages and paged hosts (lane w-l)

| Module | Author | Spec ids | Design section | Sources consulted | Third-party code | Date |
|---|---|---|---|---|---|---|
| `model/pages.ts` | lane w-l | M-6, E-DOC-12/13/14, C1.5, C2.3 | document-model §6 | Design; platform pageStack and geometry contract; no tldraw source | none | 2026-11-13 |
| `commands/pagesAndSheets.ts` | lane w-l | F-SHEET-002/003/004/005/006, F-NB-002/003/004/006/007/008, R-11, R-24 | document-model §6; change-and-history §2 | Specs and own model/apply interfaces; no tldraw source | none | 2026-11-13 |
| `host/notebookPaper.ts` | lane w-l | F-NB-002/003/004/014, C2.4 | notebook §F-NB-004 | Specs, platform display-list contract and paper.ts; no tldraw source | none | 2026-11-13 |
| `host/notebookExport.ts` | lane w-l | F-NB-014, F-SHEET-008, R-12, C2.4 | notebook §F-NB-014; sheets §F-SHEET-008 | Specs, platform display-list contract; no tldraw source | none | 2026-11-13 |
| `host/pageDisplay.ts` | lane w-l | F-NB-014, F-SHEET-008, C2.4 | notebook §F-NB-014; contracts C2.4 | Specs, platform display list and paint-frame export; no tldraw source | none | 2026-11-13 |
