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
| `chrome/penPanel.ts` | w-j | F-STYLE-001/002/003/006/008/009, WB-D25 | integration §6; rendering §5 | Renderer-owned PaintPalette, authoritative active tool, shared geometry metrics and sRGB luminance for contrasting indicator; no tldraw or old canvas source | none | 2026-11-13 |
| `chrome/theme.ts` | w-j | F-THEME-001/002/003/006, R-26, WB-D28 | integration §6; rendering §5 | Theme specification and host scope ruling; no tldraw or old canvas source | none | 2026-11-13 |
| `chrome/preferences.ts` | w-j | F-PREF-002/003/005/006/008/012, WB-D30 | integration §§6–7 | Preference specification and public model view flags; session/view changes delegated to host persistence; no tldraw or old canvas source | none | 2026-11-13 |
| `chrome/viewFlags.ts` | w-j | F-PREF-002/003/005/012, WB-D30 | integration §§6–7; change-and-history §2 | Model's public session/apply and per-kind dirty policies, PDF browser-record callback and dirtying result; no tldraw or old canvas source | none | 2026-11-13 |
| `chrome/styleCommands.ts` | w-j | F-STYLE-002/004/005/006/007/008/010/011, R-2/R-9/R-20 | integration §6; geometry §3.2; change-and-history §2 | Style specification, authoritative active tool callback, public model operations, explicit isolated history groups and shared StyleGeometryMetrics; no tldraw or old canvas source | none | 2026-11-13 |
| `chrome/language.ts` | w-j | F-LANG-001/002/003/004/005 | integration §6.2 | Own English keys and ready locale manifest, Intl plural rules, input validation and latest-choice async ordering; no tldraw or old canvas source | none | 2026-11-13 |

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
| `model/validate.ts` | lane w-c | DM-3, V-1..V-12, M-11, H-3, RV-22, R-W25/30/32/40 | document-model §§3/5/6/9; change-and-history §2; text §4; security §§4/8.1 | Design/rulings; final pressure checks, inverse forms, shared caps, media guards and O(1) opaque-descendant query for group normal form; no tldraw source | none | 2026-11-13 |
| `model/textOffsets.ts` | lane w-c | V-11, H-2, R-W18/21 | text §4.1; UTF-16 projection | Design and approved allocation-free UTF-16 scan, block-aligned inverse ranges and splice block counts | none | 2026-11-13 |
| `model/textLimits.ts` | lane w-c | V-11, H-2 | text §4; document-model §9 | Design/rulings; shared one-million UTF-16 and hundred-thousand block caps | none | 2026-11-13 |
| `model/rawMedia.ts` | lane w-c | M-3/9, R-W25/30/37 | document-model §9.3; preserved-media rulings | Independent escaped-string/key scan; 64-hex runs plus first/last candidates in longer runs, bounded ring and per-raw dedup; no parse, upstream read or registry | none | 2026-11-13 |
| `model/doc.ts` | lane w-c | M-1/3/4/6/8/10, C2.2, RV-22, R-W17/18/19/20/21/23/25/30 | document-model §§1/3/5/6/8/9.3/10; native-format §6 | Design/rulings; live/preserved reference indices; private strict opaque-descendant counts with public boolean query, no file field or exposed map; no tldraw source | none | 2026-11-13 |
| `model/applyOnly.ts` | lane w-c | M-1/4/5/6/8/10, H-1/2/3, RV-22, R-W18/19/21/23/25/26 | document-model §§5/6/10; change-and-history §2 | Design/rulings; prepared sibling/live-index edits, raw/count/revision writes, strict opaque ancestry counts maintained O(depth) on create/delete/reparent and inverse replay; zero counts deleted | none | 2026-11-13 |
| `change/ops.ts` | lane w-c | H-1/2/3/4/6, M-11, R-W19/21/23/26/40 | change-and-history §§2–3 | Design/rulings; exhaustive policies, inverse forms, receipt leases and restricted command/normalization push capabilities; no tldraw source | none | 2026-11-13 |
| `change/apply.ts` | lane w-c | CH-1, H-1/2/3/4/6, V-10, D-10, R-W23/25/26/27/40 | change-and-history §§2–3; document-model §§9.3/10 | Design/rulings; one staged path including real normalization, pre-mutation exact geometry capture, guarded private follow-on sink, inverse replay/savepoints and sample ownership; no upstream implementation | none | 2026-11-13 |
| `change/errors.ts` | lane w-c | H-1/3 | change-and-history §2.3 | Design; shared typed validation refusal/internal failure identity for apply, commands and agent adapter | none | 2026-11-13 |
| `change/coordinates.ts` | lane w-c | M-5/6/8, H-2, WB-D18 | document-model §§5–6; geometry §8.5 | Independent Float64 rigid-transform composition; canonical w-l page layout/origin and platform pageAt; injected exact staged tips/unclipped bounds, never AABB attachment guesses | none | 2026-11-13 |
| `change/commands.ts` | lane w-c | M-4/5, H-2/3, WB-D18, RV-22 | change-and-history §2.4; document-model §§4–6 | Design; outermost locked-subtree promotion, paint-order keys, deepest-first delete, opaque pins, same-world sheet moves, sheet-parent narrowing and command savepoints | none | 2026-11-13 |
| `change/normalize.ts` | lane w-c | CH-1, M-4/5/8, RV-22 | change-and-history §2.3; geometry §8.5; document-model §5 | Design; incremental group dissolve/rekey worklists, final-sheet attachment decisions and exact pre-delete world-tip captures owned by staged entries | none | 2026-11-13 |
| `change/agentBatch.ts` | lane w-c | H-3/5, C8, CH-5 | change-and-history §2.5 | Documented wire semantics only; at most 200 synchronous commands, per-op savepoints, successful original-number aliases, expected refusal skip and whole-batch unexpected/normalization rollback | none | 2026-11-13 |
| `change/rawChanges.ts` | lane w-c | H-2/3, M-3/9, R-W23/25/37/40 | document-model §9.3; change-and-history §2 | Design/rulings; diff RawJson carrier multiplicities, scan entering/leaving values, omit only owning media self-reference | none | 2026-11-13 |
| `session/BoardSession.ts` | lane w-c | H-1/3/4, C7.0/2/5/6, D-10 | change-and-history §§2–4; integration §§2/9 | Design; source ownership, read-only safety and session-owned gesture queue public contract; no tldraw source | none | 2026-11-13 |
| `session/gestureQueue.ts` | lanes w-c/w-e | C7.2, WB-D17 | integration §§2/9 | Design/ruling; one session FIFO, idempotent gesture leases, cancellation and final owner/readiness/read-only checks; factory and viewer class delegate to the same queue | none | 2026-11-13 |
| `text/rich.ts` | lane w-l | TX-2, R-W32 | text §4; change-and-history §2.1 | Design-only public rich text operations, import contract and replace-blocks semantics; no tldraw source | none | 2026-11-13 |
| `text/richText.ts` | lane w-c | M-3, V-11, H-2/3, R-W19/21/25 | text §4.1; change-and-history §2 | Design/rulings only; minimal immutable normalize/slice/splice, opaque carrier preservation and exact boundary-block inverse splices, not whole-value undo snapshots | none | 2026-11-13 |

## Agent adapter (lane w-p)

| Module | Author | Spec ids | Design section | Sources consulted | Third-party code | Date |
|---|---|---|---|---|---|---|
| `agent/shapes.ts` | w-p | F-AGENT-001, WB-D11, WB-D12, C8 | integration §9 | Agent specification, public model and disk revision interfaces; authoritative geometry supplied by shared projection; no tldraw or old canvas source | none | 2026-11-13 |
| `agent/transaction.ts` | w-p | F-AGENT-002/003/004/005/012/013, C8 | integration §9; change and history §3 | Agent specification and shared session queue/agent batch runner; no tldraw or old canvas source | none | 2026-11-13 |
| `agent/validate.ts` | w-p | F-AGENT-002/012/013/015, C8 | integration §9 | Agent specification and public model style vocabulary; no tldraw or old canvas source | none | 2026-11-13 |
| `agent/create.ts` | w-p | F-AGENT-002/012/013, C8 | integration §9, document-model §§3–4 | Agent spec and public model/change/page APIs; no tldraw or old canvas source | none | 2026-11-13 |
| `agent/createInk.ts` | w-p | F-AGENT-002/003/013/015, C8 | integration §9, ink §2 | Agent spec, sample store and public geometry/model APIs; no tldraw or old canvas source | none | 2026-11-13 |
| `agent/update.ts` | w-p | F-AGENT-004/012, WB-D10, C8 | integration §9, document-model §§3/7 | Agent specification and model/change/style metrics APIs; placement delegated to authoritative staged geometry; no tldraw or old canvas source | none | 2026-11-13 |
| `agent/stage.ts` | w-p | F-AGENT-002/003/004/005/012, R-11, C8 | integration §9 | Agent specification and public model/change APIs, delegates protected deletion and authoritative geometry; no tldraw or old canvas source | none | 2026-11-13 |
| `agent/closed.ts` | w-p | F-AGENT-001/011, WB-D11, C8 | integration §9, native-format read | Agent specification and native reader/sample lease APIs; C5 admission supplied by session host; no tldraw or old canvas source | none | 2026-11-13 |
| `agent/adapter.ts` | w-p | F-AGENT-001/002/003/004/005/012/013, WB-D11/12, C8 | integration §9 | Agent specification and session, change and scene provider contracts; no tldraw or old canvas source | none | 2026-11-13 |
| `agent/camera.ts` | w-p | F-AGENT-010, C8, C1 | integration §9; platform camera contract | Agent and platform camera conventions; no tldraw or old canvas source | none | 2026-11-13 |
| `agent/placement.ts` | w-p | F-AGENT-004/013, WB-D10, C8 | integration §9; document-model transform | C8 centre-based rectangle semantics and public model/page APIs; local box supplied by shared geometry; no tldraw or old canvas source | none | 2026-11-13 |
| `agent/reanchor.ts` | w-p | F-AGENT-007/013, C8 | integration §9; document-model pages | Staged world-centre reanchor via shared geometry/page stack; no tldraw or old canvas source | none | 2026-11-13 |
| `agent/errors.ts` | w-p | F-AGENT-012/013, C8 | integration §9 | Agent specification; no tldraw or old canvas source | none | 2026-11-13 |

## Formats, importer, save and agent adapter (lane w-d)

| Module | Author | Spec ids | Design section | Sources consulted | Third-party code | Date |
|---|---|---|---|---|---|---|
| `format/identity.ts` | w-d | FMT-1, P8 | native-format §3; PDF attachment marker contract | Stable app-owned native format identifier shared with PDF attachment marker role metadata; no tldraw source/package | none | 2026-11-13 |
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
| `workers/protocol.ts`, `workers/client.ts` | w-d | THR-1, THR-3 | threading §§2–3, platform C5 | App-owned identity envelopes, stale-result disposal, governed host requests and deadlines; no tldraw source/package | none | 2026-11-13 |
| `workers/pointHandlers.ts` | w-d | THR-1, FMT-2 | threading §2; native-format §4 | Sliced point inspection/decode in the parse worker, explicit owned transfers and cancellation cooperation; no tldraw source/package | none | 2026-11-13 |
| `workers/parse.worker.ts`, `workers/geometry.worker.ts`, `workers/export.worker.ts` | w-d | THR-1 | threading §2 | App-owned worker-host entrypoints; text layout and PNG handlers remain owned by their lanes, geometry operations registered as slab work lands; no tldraw source/package | none | 2026-11-13 |
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
| `scene/index.ts` | lane w-e | WIP W-E3 | rendering §6 | Kamel/Faloutsos, On Packing R-trees, CIKM1993, https://www.cs.cmu.edu/~christos/PUBLICATIONS.OLDER/cikm93.pdf (search/abstract ideas only); own Hilbert quadrant construction and standard AVL height rotations; direct cold packed seeding, generation/version replay, unique dirty-slot bits, monotonic packed epoch publication and cooperative cleanup; no library implementation | none | 2026-11-13 |
| `scene/order.ts` | lane w-e | WIP W-E3 | rendering §§2,3.1,6 | Own fixed-size chunk sequence and linear Fenwick header rebuild; borrowed stable chunks and linear range copy; public model stable-slot/order requirements; no library or tldraw code | none | 2026-11-13 |
| `scene/query.ts` | lane w-e | W-E3 incremental queries | rendering §6 | Own typed best-first frontier over both trees, conservative point/strip bounds, strict-greater pruning and resumable heap order; reusable generation-tagged output and cursor leases, no library code | none | 2026-11-13 |
| `render/reference/coverage2d.ts` export budget seam | lane w-e | Shared outline export | rendering §§5,12 | Existing greenfield v-b adapter and owned InkOutlineJob; optional command ceiling forwarded unchanged so export can choose its own allocation budget without truncation | none | 2026-11-13 |
| `render/colour.ts` | lane w-e | W-E4 shared contract | rendering §5.2; C2.4 | Public Rgba/RgbaP contracts; encoded-sRGB premultiplication and W3C source-over/multiply algebra from design; injected theme palettes, no legacy palette implementation | none | 2026-11-13 |
| `render/material.ts` | lane w-e | W-E4 shared contract; R-20 | rendering §§3.1,4,5.2 | Design's non-isolated inherited opacity and two highlighter bands0.82/0.35; public stroke metrics; own resolved material construction | none | 2026-11-13 |
| `render/paintStream.ts` | lane w-e | W-E4 shared contract | rendering §§2–5,11,12 | Shared platform/ink public types; direct v-b consumer agreement; own ordered two-band resumable command emission and clip/image transform contract, no second scene or stroker | none | 2026-11-13 |
| `render/resources.ts` | lane w-e | W-E4 shared contract | rendering §§7,10,11; C4 | Public render tokens and direct v-b preparation/asset-lease agreement; injected origin-clean async decoder ownership, immutable frame source and existing-host invalidation, no private scheduler/context | none | 2026-11-13 |
| `viewer/types.ts` | lane w-e | Viewer host; INT-11; C4 | rendering §§2,10,12; integration §2 | Public LayerHost and model kinds; w-b accessibility source agreement; host-only pages/backdrops, lifecycle-owned layer disposal and React-free open contract | none | 2026-11-13 |

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
| `import/pages.ts` | w-o | IMP-3, E-IMP-7/9 | import §3.1 | Page-local mapping, bounds-error ambiguity refusal, notebook and saved PDF backdrop layout | none | 2026-11-13 |
| `import/worldBounds.ts` | w-o | IMP-3, E-IMP-4/7/9 | import §3.1; text §6 | Public text layout/geometry scale contract; w-h world-space figure provider and certified error, orphan roots and group bounds | none | 2026-11-13 |
| `import/report.ts` | w-o | IMP-5 | import §§1,6 | Import report and notice contract | none | 2026-11-13 |
| `import/records/envelope.ts` | w-o | IMP-1, E-IMP-1/2/4 | import §§2,6; current-format §§1–3 | Observed envelopes, bounded admission, schema counters and metadata retention | none | 2026-11-13 |
| `import/preflight.ts` | w-o | IMP-1, E-IMP-1, SEC-W1 | security §§3–4 | Independent UTF-8 byte counting and JSON nesting budget | none | 2026-11-13 |
| `import/records/storeFields.ts` | w-o | IMP-1, E-IMP-4 | import §6; document-model §9.2 | JSON format and duplicate-record preservation requirement | none | 2026-11-13 |
| `import/records/common.ts` | w-o | IMP-1, IMP-3 | import §§2–3; current-format §2 | Observed shape/backdrop layout; source records retained for unsupported content | none | 2026-11-13 |
| `import/records/sheets.ts` | w-o | IMP-1 | import §3; current-format §2 | Observed page and metadata fields | none | 2026-11-13 |
| `import/records/stroke.ts` | w-o | IMP-1/2, E-IMP-15 | import §3; geometry §3.2 | Observed segment/style fields; shared style metrics and public sample model | none | 2026-11-13 |
| `import/records/basic.ts` | w-o | IMP-1 | import §3; current-format §2 | Documented group, frame, embed and line records; shared style metrics | none | 2026-11-13 |
| `import/records/bindings.ts` | w-o | IMP-1, E-IMP-5 | import §§3,6 | Documented connector bindings and dangling-target rule | none | 2026-11-13 |
| `import/records/fields.ts` | w-o | IMP-1, E-IMP-3 | import §§2–3,6 | Observed common/shape properties and unknown-field refusal | none | 2026-11-13 |
| `import/records/labelled.ts` | w-o | IMP-1 | import §3; geometry §3.2 | Documented figure, text, note and connector fields; shared style metrics; rich reader injected | none | 2026-11-13 |
| `import/records/media.ts` | w-o | IMP-1, E-IMP-6 | import §3; security §4 | Inline asset format, retained original non-source metadata and w-q SEC-W4 admission seam | none | 2026-11-13 |
| `import/records/pictures.ts` | w-o | IMP-1 | import §3; current-format §2; media §11 | Observed picture, video and bookmark fields; inert remote preview URLs never fetched on import | none | 2026-11-13 |
| `import/records/view.ts` | w-o | IMP-1 | import §3; current-format §§2,6 | Documented session, camera and UI fields | none | 2026-11-13 |
| `import/scale.ts` | w-o | IMP-3, E-IMP-9 | import §3.1; contracts C2.3 | Uniform page-local transformation of public model records, text/sticky scale applied once | none | 2026-11-13 |
| `import/repair.ts` | w-o | IMP-1, E-IMP-4/5 | document-model §9.2; import §6 | Load-only parent, group, id, order and attachment repair rules | none | 2026-11-13 |
| `import/sheets.ts` | w-o | IMP-1, E-IMP-4 | document-model §§4,9.2 | Sheet naming and key model | none | 2026-11-13 |
| `import/admit.ts` | w-o | IMP-1, IMP-5 | document-model §§9–10; import §§1,6 | Public model validation and apply controller | none | 2026-11-13 |
| `import/records/read.ts` | w-o | IMP-1/3/5, E-IMP-4/7 | import §§1–3,6 | Documented record families; media admission/orphan retention, inert records and paper-aware duplicate/orphan page bounds | none | 2026-11-13 |
| `import/import.ts` | w-o | IMP-1/3/5 | import §§1–3,6; current-format §4; security SEC-W1 | Source/metadata retention, model raw-media indexing, shared paper normalization API (`utils/paper.ts` read), orphan pages and injected admission | none | 2026-11-13 |
| `import/basicGeometry.ts` | w-o | IMP-3, E-IMP-7/9 | import §3.1; ink §3 | Public ink curve/sample interfaces and own cubic world bounds; connectors delegated to their provider | none | 2026-11-13 |
| `import/sampleWire.ts` | w-o | IMP-1/2, E-IMP-15, SEC-W1 | import §§1–3; native-format §4 | Public sample sequence and native point encoder; outgoing runs and pressure retained for host re-admission | none | 2026-11-13 |
| `import/conversion.ts` | w-o | IMP-6, E-IMP-10/11/16, E-DEL-11/12 | import §4; delivery M4 | Conversion ordering, versioned host callbacks, SHA-256 backup reuse, durable digest and collision-safe restore contracts | none | 2026-11-13 |
| `import/conversionMetadata.ts` | w-o | IMP-6, E-IMP-16 | import §4; delivery M4 | Native header extension stores original-byte digest so restore survives rename/move | none | 2026-11-13 |

## Export and whiteboard host (lane w-k)

| Module | Author | Spec ids | Design section | Sources consulted | Third-party code | Date |
|---|---|---|---|---|---|---|
| `export/png.ts` | lane w-k | F-EXPORT-002/006; E-EXP-4; EX-5/7 | export §§2–3, 7; clipboard §2.4 | Export design; PNG chunk layout, sRGB and pHYs; browser CompressionStream; independent CRC arithmetic and per-row PNG filter choice; no tldraw source | none | 2026-11-13 |
| `export/tiles.ts` | lane w-k | F-EXPORT-002/006; E-EXP-4; EX-5/7 | export §§2–3, 7 | Export design; bounded bands and a renderer-supplied RGBA tile; no tldraw source | none | 2026-11-13 |
| `export/rasterTile.ts` | lane w-k | F-EXPORT-002/006; EX-5/7 | export §§2–3, 7 | Export design; shared painter, two-pixel tile apron, cancellable pinned resources; no tldraw source | none | 2026-11-13 |
| `export/displayList.ts` | lane w-k | F-EXPORT-001/003; EX-2/3/4 | export §§2, 4–5; rendering §3 | Sliced paint-frame and per-item conversion, world-space clips, source-pixel crop and shared cancellable ink outline; no tldraw source | none | 2026-11-13 |
| `export/svg.ts` | lane w-k | F-EXPORT-001/003; EX-2/3/4 | export §§2, 4–5, 7 | Chunkable size-admitted serialization, four-decimal coordinates, self-contained images and clip paths; no tldraw source | none | 2026-11-13 |
| `export/svgWorkerHandler.ts` | lane w-k | F-EXPORT-001/003; EX-2/3/4 | export §§2, 4–5; platform C5 | Shared worker SVG stream with bounded sliced chunks and abandoned-stream cleanup; no tldraw source | none | 2026-11-13 |
| `export/pngWorkerHandler.ts` | lane w-k | F-EXPORT-002/006; EX-5/7 | export §§2–3, 7; platform C5 | Platform-hosted pull-stream encoder handlers, bounded row transfer and abort propagation; no tldraw source | none | 2026-11-13 |
| `export/pngWorkerClient.ts` | lane w-k | F-EXPORT-002/006; EX-5/7 | export §§2–3, 7; platform C5 | Shared governed export worker, pinned identity and bounded-band row backpressure; no tldraw source | none | 2026-11-13 |
| `export/prepareRaster.ts` | lane w-k | F-EXPORT-002/006; EX-5/7 | export §§2–3, 7; rendering §3 | Shared reference geometry jobs without export command cap and image leases; cancellable pinned resources; no tldraw source | none | 2026-11-13 |
| `export/capturePng.ts` | lane w-k | F-EXPORT-002/006; EX-5/7 | export §§2–3, 7 | Export design; pinned capture preparation, worker identity and lease cleanup; no tldraw source | none | 2026-11-13 |
| `export/exportImage.ts` | lane w-k | F-EXPORT-001/003; EX-2/3/4 | export §§2, 4–5; rendering §5 | Export design; admitted origin-clean image leases, embedded source or normalized PNG, baked inversion; no tldraw source | none | 2026-11-13 |
| `export/captureSvg.ts` | lane w-k | F-EXPORT-001/003; EX-2/3/4 | export §§2, 4–5 | Pinned frame, optional opaque background and self-contained SVG serialization; no tldraw source | none | 2026-11-13 |
| `export/capturePdf.ts` | lane w-k | F-EXPORT-004/005; EX-2/3/4 | export §§2, 6; PDF writing §3 | One pinned revision across all pages, page-local projection and injected PDF domain writer; no tldraw source | none | 2026-11-13 |
| `export/captureFrame.ts` | lane w-k | F-EXPORT-001/002/003/004; EX-2/3/5 | export §§2–3; rendering §3 | Shared paint stream, immutable scene capture, sliced admission and stale/cancelled partial-frame rejection; no tldraw source | none | 2026-11-13 |
| `export/streamPage.ts` | lane w-k | F-EXPORT-003/004/005; EX-2/3/4 | export §§2, 6; rendering §3 | Bounded paint-stream chunks, page-local clipping and ordered one-page output; no tldraw source | none | 2026-11-13 |
| `export/streamSvg.ts` | lane w-k | F-EXPORT-001/003; EX-2/3/4 | export §§2, 4–5; platform C5 | Bounded paint-stream conversion, transferable image copies, stale and cancellation cleanup; no tldraw source | none | 2026-11-13 |
| `export/streamPdf.ts` | lane w-k | F-EXPORT-004/005; EX-2/3/4 | export §§2, 6; PDF writing §3 | One pinned revision, incrementally assembled page display lists and injected PDF writer; no tldraw source | none | 2026-11-13 |
| `export/snapshot.ts` | lane w-k | F-EXPORT-001/002/003/004; EX-2/3/5 | export §2 | One revision/media lease, identity validation and cleanup across asynchronous capture; no tldraw source | none | 2026-11-13 |
| `export/snapshotExport.ts` | lane w-k | F-EXPORT-001/002/003; EX-2/3/5 | export §§2–5 | Pinned snapshot to shared-worker raster PNG and streamed SVG; no tldraw source | none | 2026-11-13 |
| `export/scope.ts` | lane w-k | F-EXPORT-001/002/003/005/006; EX-2/3 | export §§1–2, 8 | Menu versus selection scope, paged backdrop choice and deterministic timestamped download names; no tldraw source | none | 2026-11-13 |
| `export/rasterWire.ts` | lane w-k | F-EXPORT-002/006; EX-5/7 | export §§2–3; platform C5 | Cloneable shared-painter geometry and owned bitmap transfer contract; no tldraw source | none | 2026-11-13 |
| `export/rasterWorkerHandler.ts` | lane w-k | F-EXPORT-002/006; EX-5/7 | export §§2–3, 7; platform C5 | Sliced worker-safe OffscreenCanvas shared painter, padded tiles and streaming PNG; no tldraw source | none | 2026-11-13 |
| `export/streamRaster.ts` | lane w-k | F-EXPORT-002/006; EX-5/7 | export §§2–3; platform C5 | Pinned paint stream, shared ink outline, chunked geometry and owned bitmap transfers; no tldraw source | none | 2026-11-13 |
| `host/notebookCommands.ts` | lane w-k | F-EXPORT-004/005; C7.2 | export §6; integration §4 | Pinned notebook command, App-authorized staged write and user-clicked print handoff; no tldraw source | none | 2026-11-13 |

## Text and history (lane w-n)

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
| `text/layout.ts` | lane w-n | T-1, T-2, T-6 | text §§2–3, 6–7 | Unicode itemizer and bidi reordering, face metrics and canvas measurement, heading sizes from spec/text F-TEXT-012, shared SHA-256 for paint keys; own layout implementation | none | 2026-11-13 |
| `text/caretIndex.ts` | lane w-n | T-4, T-5 | text §§5.3–5.6 | Independent reference-size prefix measurement and grapheme-index geometry | none | 2026-11-13 |
| `text/layoutWorkerHandler.ts` | lane w-n | T-1, T-2, T-6 | text §§2–3, 7.2 | OffscreenCanvas, worker-local FontFaceSet and platform shared-worker protocol; w-d coordinated parse-worker integration | none | 2026-11-13 |
| `text/layoutClient.ts` | lane w-n | T-1, T-2, T-4 | text §§2–3, 7.2; threading §§2–3 | Main/worker layout compatibility selection, worker-host interface, vault/session and node-revision stale reply rejection | none | 2026-11-13 |
| `change/historyTypes.ts` | lane w-n | H-5, H-6, CH-2 | change-and-history §§3–4; text §5.7 | Published session, selection, media/sample lease and camera-controller reveal ports; w-architect's history rulings | none | 2026-11-13 |
| `change/historyCoalesce.ts` | lane w-n | H-5, CH-2 | change-and-history §4.3 | Independent per-property coalescing, rich-splice block snapshots and dependency-safe transient-node cancellation | none | 2026-11-13 |
| `change/history.ts` | lane w-n | H-5, H-6, CH-2 | change-and-history §§3–4; text §5.7 | Session-only inverse steps, exact receipt rollback, selection and reveal ports, media/sample retention, 256 MiB byte cap; w-architect's R-19/media rulings | none | 2026-11-13 |
| `change/notices.ts` | lane w-n | H-4, CH-4 | change-and-history §§1, 3; C4.6 | r-a's platform scheduler integration guidance, one frame accumulator per session, hidden timer and reentrant delivery barrier | none | 2026-11-13 |
| `change/apply.ts`, `change/ops.ts`, `model/validate.ts` (W-C6 additions) | lane w-n | H-2, H-3, H-5, CH-2 | change-and-history §§2–4; w-architect revert ruling | Index-aligned immutable inverse groups and private receipt-verified latest-commit revert; guarded replay origins | none | 2026-11-13 |
| `text/fonts.ts` | lane w-n | T-6 | text §7 | FontFace API; lazy per-context registration and epoch, no tldraw source | none | 2026-11-13 |
| `text/fontMetrics.json` | lane w-n | T-6 | text §7 | Generated directly from pinned upstream WOFF2 metrics tables | font metrics | 2026-11-13 |
| `text/fontCoverage.json` | lane w-n | T-2, T-6 | text §§3, 7 | Unicode cmap intervals generated from pinned upstream WOFF2 faces | font coverage | 2026-11-13 |
| `text/fonts/*.woff2` | lane w-n | T-6 | text §7.1; IR-4 | Arrow Type Shantell Sans 1.011 release ZIP matches tagged tree; IBM Plex Sans/Serif/Mono 1.1.0 tags; exact per-file URLs, tags and SHA-256 in `tools/whiteboard-fonts/manifest.json` and G-TXT-FONTPIN | upstream unmodified fonts, SIL OFL 1.1, Plex Reserved Font Name | 2026-11-13 |
| `tools/whiteboard-fonts/manifest.json` | lane w-n | T-6 | text §7.1 | Upstream release and tag URLs and SHA-256 for each font | font metadata | 2026-11-13 |
| `tools/whiteboard-fonts/generate.mjs` | lane w-n | T-6 | text §§7.1–7.2 | W3C WOFF2 and OpenType cmap formats; own metrics/coverage extraction and pinned-hash gate | none | 2026-11-13 |
| `tools/whiteboard-fonts/{Shantell-OFL,IBM-Plex-OFL}.txt` | lane w-n | T-6 | text §7.1 | Exact upstream licences including copyright and Reserved Font Name | SIL OFL 1.1 notices | 2026-11-13 |

## Geometry and selection (lane w-g)

| Module | Author | Spec ids | Design section | Sources consulted | Third-party code | Date |
|---|---|---|---|---|---|---|
| `geom/bounds.ts` | lane w-g | GE-1, W-E3 | geometry §2.3; rendering §6 | Generic box helpers moved with w-e's agreement; independent interval-filtered cubic and arc extrema | none | 2026-11-13 |
| `scene/bounds.ts` | lane w-g | GE-1, W-E3 | geometry §2.3; rendering §6 | Re-export generic helpers from geom/bounds.ts to retain the scene API | none | 2026-11-13 |
| `geom/numeric.ts` | lane w-g | GE-1 | geometry §2.1–2.2 | Design; IEEE 754 binary64; independent dyadic arithmetic | none | 2026-11-13 |
| `geom/predicates.ts` | lane w-g | GE-1 | geometry §2.2 | Design; interval-filtered exact dyadic predicates and intersection-coordinate enclosures | none | 2026-11-13 |
| `geom/affine.ts` | lane w-g | GE-1 | geometry §2.3 | Design; shared affine helpers and singular value identity | none | 2026-11-13 |
| `geom/flatten.ts` | lane w-g | GE-1 | geometry §2.4 | Design; w-e's bounded ink cubic flattening job, de Casteljau splitting and circular sagitta bound | none | 2026-11-13 |
| `geom/metrics.ts` | lane w-g | GE-1 | geometry §2.4 | Design; chord/control-polygon length enclosure, greatest-uncertainty heap and bounded prefix inversion | none | 2026-11-13 |
| `geom/transforms.ts` | lane w-g | GE-4; F-XFORM-001/003/004/005/006/007/008/010/011 | geometry §6.2–6.4 | Design; oriented-frame resize, signed crossings, rotation and parent-local translation | none | 2026-11-13 |
| `geom/crop.ts` | lane w-g | GE-4; F-XFORM-009; F-MEDIA crop | geometry §6.5 | Design; source-normalized crop and reflected intervals, model dimension limits | none | 2026-11-13 |
| `geom/arrange.ts` | lane w-g | GE-4; F-ARR-006/007/008/009/010 | geometry §6.6–6.7; arrange spec | Design; world bounds, equal edge gaps, stable shelf pack with max-capacity tree | none | 2026-11-13 |
| `geom/path.ts` | lane w-g | GE-1 | geometry §§1–2 | Design path and curve types; interval Bernstein radial error for tangent-matched arc cubics | none | 2026-11-13 |
| `geom/types.ts` | lane w-g | GE-1 | geometry §§1,5 | Design; platform affine/rect and model node contracts; provider-owned types injected | none | 2026-11-13 |
| `ink/pick.ts` | lane w-g | GE-3 | geometry §5.2; ink §6.2 | Export existing w-e affine capsule-distance primitive for shared path picking | none | 2026-11-13 |
| `geom/pick.ts` | lane w-g | GE-3; F-SEL-001/003/004 | geometry §5.1–5.4 | Design; shared ink affine-distance, exact line topology, w-h contour clipper and semantic-interior region geometry | none | 2026-11-13 |
| `pick.ts` | lane w-g | GE-3; F-SEL-001/003/004/005/006 | geometry §§4–5 | Design; streamed w-e SpatialQuery candidates, revision stamps and resumable narrow phase, no second index | none | 2026-11-13 |
| `selection.ts` | lane w-g | GE-3; F-SEL-002/005/006/007/010/011 | geometry §5.3; selection spec | Design; model child and sheet indexes; selection, history restore, locked reconciliation and keyboard/group navigation | none | 2026-11-13 |
| `selectionNavigation.ts` | lane w-g | GE-3; F-SEL-010; WB-D33 | geometry §§4–5; input §8.4 | Design; w-e shared spatial strip cursor, caller-owned reveal and eligible-node geometry | none | 2026-11-13 |
| `accessibility/selection.ts` | lane w-g | GE-3; INT-11 | integration §6.1; selection spec | Bounded viewport and selection mirror source with names, kinds, order and lock state; structural host contract | none | 2026-11-13 |
| `commands/delete.ts` | lane w-g | GE-4; WB-D18; F-SEL-009; RV-22 | geometry §6.2; selection spec | Design; model indexed opaque guard and w-c's shared locked-descendant deletion command | none | 2026-11-13 |
| `tools/select.ts` | lane w-g | GE-3; F-SEL-001/002/003/004 | geometry §§4–5; selection spec; input | Design; input Tool, shared swept queue and exception-safe pending-gesture lifetime | none | 2026-11-13 |

## Figures and geometry providers (lane w-h)

| Module | Author | Spec ids | Design section | Sources consulted | Third-party code | Date |
|---|---|---|---|---|---|---|
| `geom/styleMetrics.ts` | lane w-h | WB-D20 | geometry §§3.2, 5.2 | Geometry design and provisional dash, sticky-corner and frame-border metrics; finite metric admission; no tldraw source | none | 2026-11-13 |
| `geom/figures.ts` | lane w-h | F-FIG-001/002/003/004 | geometry §3 | Independent shape recipes and local semantic bounds; FIG creation ratios and seed-centred gestures; kernel-certified arc conversion and analytic cloud with fourth-derivative Hermite error bound; no tldraw source | none | 2026-11-13 |
| `geom/variants.ts` | lane w-h | WB-D20 | geometry §3.1 | Design's bounded deterministic displacement recipe, shared cubic length/splitting kernel, and continuous dash/dot phase; no tldraw source | none | 2026-11-13 |
| `geom/clip.ts` | lane w-h | WB-D20, E-GEO-7 | geometry §§3.1, 8.2 | Cubic monotone intervals and exact-orientation predicates from the shared kernel; scale-aware boundary membership, node-local hatch clipping and reflected phase; no tldraw source | none | 2026-11-13 |
| `geom/providers.ts` | lane w-h | F-FIG-001, F-STICKY-001, F-FRAME-001, WB-D20/24, E-GEO-8/35 | geometry §§1, 3, 5; text §6 | Figure and container geometry, font-epoch pending geometry, transformed contour bounds with approximation enclosure, text-owned layout, ink-owned resumable picking, node-local hatch, platform path conversion and scene bounds; no tldraw source | none | 2026-11-13 |

## Media and clipboard (lane w-q)

| Module | Author | Spec ids | Design section | Sources consulted | Third-party code | Date |
|---|---|---|---|---|---|---|
| `media/sha256.ts` | lane w-q | F-MEDIA-003/004; SEC-4 | media §1.2; security §3.2 | FIPS 180-4 §6.2 algorithm as specified in the design; independently implemented; no tldraw source | none | 2026-11-13 |
| `media/sniff.ts` | lane w-q | F-MEDIA-001/003; SEC-4 | media §1; security §6 | Format signatures from security §6, independent implementation | none | 2026-11-13 |
| `media/headers.ts` | lane w-q | F-MEDIA-001/003/011; SEC-4 | media §1; security §6 | Image container header structures, independently implemented; no tldraw source | none | 2026-11-13 |
| `media/isoHeaders.ts` | lane w-q | F-MEDIA-001/003; SEC-4 | security §6 | ISO-BMFF bounded boxes and AVIF primary-property association, independently implemented | none | 2026-11-13 |
| `media/webmHeader.ts` | lane w-q | F-MEDIA-001/003; SEC-4 | security §6 | EBML bounded element encoding and WebM track fields, independently implemented | none | 2026-11-13 |
| `media/decode.worker.ts` | lane w-q | F-MEDIA-001/003/004; SEC-4 | media §1; threading §2; security §6 | Shared identity-enveloped board worker and browser bitmap API; no tldraw source | none | 2026-11-13 |
| `media/inspect.ts` | lane w-q | F-MEDIA-001/003; SEC-4 | media §1; security §§3/6 | SEC-W1 budgets; platform worker and memory allocator contracts; isolated SVG profile injection | none | 2026-11-13 |
| `media/ingest.ts` | lane w-q | F-MEDIA-001/002/003/004/008; SEC-4 | media §§1–3; security §3 | SEC-W1 budgets and shared session job authority; board model/apply contracts | none | 2026-11-13 |
| `media/store.ts` | lane w-q | F-MEDIA-004; SEC-4 | media §3–4; security §4 | Session-owned bytes, history/clipboard holders and collision-safe file location ledger | none | 2026-11-13 |
| `media/svgProfile.ts` | lane w-q | F-MEDIA-001/003; SEC-3/4 | security §§5–6 | Separate opaque XML/image profiles and fixed-shape response requirements | none | 2026-11-13 |
| `media/svgXmlRuntime.ts` | lane w-q | F-MEDIA-001/003; SEC-3/4 | security §6 | Worker XML preflight; isolated XML, nested inline data and pixel accounting | none | 2026-11-13 |
| `media/svgImageRuntime.ts` | lane w-q | F-MEDIA-001/003; SEC-3/4 | security §6 | Browser image-context rasterization, isolated image profile only | none | 2026-11-13 |
| `media/svgFrameRuntime.ts` | lane w-q | SEC-3/4 | security §§5–6 | Identity- and token-bound sequential bounded transfer within opaque profile | none | 2026-11-13 |
| `media/svgXmlEntry.ts` | lane w-q | SEC-3/4 | security §6 | Network-denied XML profile entry | none | 2026-11-13 |
| `media/svgImageEntry.ts` | lane w-q | SEC-3/4 | security §6 | Network-denied blob-image profile entry | none | 2026-11-13 |
| `media/svgFrameHost.ts` | lane w-q | SEC-3/4 | security §§5–6 | SEC-W2 frame API, token validation, bounded acknowledged transfer | none | 2026-11-13 |
| `media/svgFrames.d.ts` | lane w-q | SEC-3/4 | security §6 | Build-time virtual fixed-frame declarations | none | 2026-11-13 |
| `build/whiteboardSvgFrames.mjs` | lane w-q | SEC-3/4 | security §§5–6 | SEC-W2 exact-byte hashing/bundling helper; strict separate profile CSPs | none | 2026-11-13 |
| `build/whiteboardSvgFrames.d.mts` | lane w-q | SEC-3/4 | security §§5–6 | Vite plugin declaration for fixed-frame build | none | 2026-11-13 |

## Text editing and spelling (lane w-i)

| Module | Author | Spec ids | Design section | Sources consulted | Third-party code | Date |
|---|---|---|---|---|---|---|
| `text/edit/window.ts` | w-i | T-4, E-TXT-21 | text §5.3 | Design, windowed rich projection and Intl.Segmenter grapheme boundaries; no tldraw source | none | 2026-11-13 |
| `text/edit/host.ts` | w-i | T-4, F-TEXT-006/016/018, WB-D15, E-TXT-2/10/12/15/21/22 | text §§5.1–5.3, 5.6, 5.10 | Design, browser EditContext and textarea APIs, windowed projection, grapheme-safe updates and IME formats, fallback selection and app-menu forwarding | none | 2026-11-13 |
| `text/edit/session.ts` | w-i | T-4, F-TEXT-003/006/011/015/016/018, WB-D15/16/26, E-TXT-1/2/4/5/10/12/15/21 | text §§5.1–5.7, 5.9–5.10; clipboard §3 | Design, TX-2/TX-3 and HistoryController public types; empty deletion, links, formatting announcements, caret blink, edge scroll, typing/cut/paste snapshots and IME chrome | none | 2026-11-13 |
| `text/edit/controller.ts` | w-i | T-5, F-TEXT-011/012/015/016, WB-D26 | text §§4–5; change-and-history §4.3 | Design, public change operations and history-marked input transformations, explicit burst completion | none | 2026-11-13 |
| `text/edit/typingHistory.ts` | w-i | F-TEXT-005/011/016, H-5 | text §§5.4/5.7; change-and-history §4.3 | Design and w-n HistoryController; time and adjacency burst boundaries, IME, rule savepoints and owned-step tokens | none | 2026-11-13 |
| `text/edit/format.ts` | w-i | WB-D26, E-TXT-14, SEC-5 | text §§4.1, 5.9 | Design, model URL constraints and URL platform API | none | 2026-11-13 |
| `text/edit/keys.ts` | w-i | F-TEXT-006/011, WB-D14 | text §5.4 | Design, Intl.Segmenter through TX-1, visual selection collapse and transformation undo service | none | 2026-11-13 |
| `text/edit/pointer.ts` | w-i | F-TEXT-006/015 | text §§4.1/5.6 | Design, pointer and timer APIs; accelerator-click links and edge-scroll lifecycle | none | 2026-11-13 |
| `text/edit/selection.ts` | w-i | F-TEXT-006/018 | text §5.6 | Design and Intl.Segmenter | none | 2026-11-13 |
| `text/edit/caret.ts` | w-i | F-TEXT-006/018, E-TXT-4 | text §§5.4–5.5, 9 | TX-3 public caret index and design; skips coincident visual stops | none | 2026-11-13 |
| `text/edit/geometry.ts` | w-i | E-TXT-5 | text §5.3 | Design, platform Rect and affine rectangle bounds | none | 2026-11-13 |
| `text/edit/rules.ts` | w-i | F-TEXT-011/012/015 | text §5.4 | Design and TX-2 rich splice types; typed delimiters, finite list starts and autolink | none | 2026-11-13 |
| `text/edit/tool.ts` | w-i | F-TEXT-001/002 | text §5.6; spec/text | Design and w-f public Tool interface | none | 2026-11-13 |
| `text/spell/words.ts` | w-i | COV-34 | text §5.8 | Design, Intl.Segmenter and punctuation-aware URL exclusion | none | 2026-11-13 |
| `text/spell/menu.ts` | w-i | COV-29/39, E-TXT-26/28 | text §5.8 | Design; revision capture, stale menu fallback and deadline scheduling | none | 2026-11-13 |

## Editing lanes (w-f to w-j)

### Input (lane w-f)

| Module | Author | Spec ids | Design section | Sources consulted | Third-party code | Date |
|---|---|---|---|---|---|---|
| `input/tool.ts` | lane w-f | F-INPUT-001/004/005; R-19 | input §§2,7 | Input architecture and behavioural spec; no tldraw source | none | 2026-11-13 |
| `input/router.ts` | lane w-f | F-INPUT-001/004/005; R-19 | input §§2,7,9 | Input architecture and behavioural spec; no tldraw source | none | 2026-11-13 |
| `input/keyboard.ts` | lane w-f | F-TOOL-003/004; R-19 | input §8; toolbar §3 | Input and toolbar behavioural specifications; no tldraw source | none | 2026-11-13 |
| `input/gesture.ts` | lane w-f | F-TOOL-002/003/004 | input §7; toolbar §§2–4 | Tool and input behavioural specifications; no tldraw source | none | 2026-11-13 |
| `input/pointer.ts` | lane w-f | F-INPUT-001/005/008; R-19 | input §§3–4 | Input architecture; browser Pointer Events APIs; no tldraw source | none | 2026-11-13 |
| `input/prediction.ts` | lane w-f | F-INPUT-001; R-19 | input §4 | Input architecture; browser Pointer Events and Ink APIs; no tldraw source | none | 2026-11-13 |
| `input/frame.ts` | lane w-f | F-INPUT-001; R-19 | input §4 | Input architecture and shared scheduler contract; no tldraw source | none | 2026-11-13 |
| `input/liveInk.ts` | lane w-f | F-INK-001/006/007; R-19 | ink §§3,7; input §§4,9 | Ink design and public SampleBuilder; no tldraw source | none | 2026-11-13 |
| `input/sessionInk.ts` | lane w-f | F-INK-006/007; R-19 | ink §§3,7; input §9 | Public model, session transaction and sample admission APIs; no tldraw source | none | 2026-11-13 |
| `input/continueInk.ts` | lane w-f | F-INK-010 | ink spec; ink architecture §3 | Public immutable sample and transaction APIs; no tldraw source | none | 2026-11-13 |
| `input/basicTools.ts` | lane w-f | F-INK-008/009; F-INPUT-010 | input §§6–7; ink spec | Input and ink behavioural specifications; injected hierarchy and transaction services; no tldraw source | none | 2026-11-13 |
| `input/laserTrail.ts` | lane w-f | F-INK-009 | input §7; ink spec | Input and ink behavioural specifications; shared scheduler deadline seam; no tldraw source | none | 2026-11-13 |
| `input/zoomBrush.ts` | lane w-f | F-CAM-013 | input §6; camera spec | Independent gesture recipe with injected camera operations; no tldraw source | none | 2026-11-13 |
| `input/attach.ts` | lane w-f | F-INPUT-001/002/004/005; R-19 | input §§2–9 | Input architecture and public session, camera, tool and compositor seams; no tldraw source | none | 2026-11-13 |
| `input/pointerRouter.ts` | lane w-f | F-INPUT-001/004/005 | input §§2–3,9 | Input architecture and public pointer/router interfaces; no tldraw source | none | 2026-11-13 |
| `input/sweepQueue.ts` | lane w-f | F-INK-008; F-SEL-003 | geometry §§4,5.4; input §7 | Independent bounded, cancellable cursor orchestration; no tldraw source | none | 2026-11-13 |
| `input/navigation.ts` | lane w-f | F-INPUT-002/003/004/005; F-CAM-001/009 | input §§5–6 | Input design and public platform CameraController; no tldraw source | none | 2026-11-13 |

## Pages and paged hosts (lane w-l)

| Module | Author | Spec ids | Design section | Sources consulted | Third-party code | Date |
|---|---|---|---|---|---|---|
| `model/pages.ts` | lane w-l | M-6, E-DOC-12/13/14, C1.5, C2.3 | document-model §6 | Design; platform pageStack and geometry contract, cached by paper/page-list identity; no tldraw source | none | 2026-11-13 |
| `commands/pagesAndSheets.ts` | lane w-l | F-SHEET-002/003/004/005/006, F-NB-002/003/004/006/007/008, R-11, R-24, WB-D29, M-6 | document-model §6; change-and-history §2 | Specs and owned model/apply/locked-deletion interfaces, structured counts for localized confirmation; no tldraw source | none | 2026-11-13 |
| `host/notebookController.ts` | lane w-l | F-NB-002/003/004/006/007/008, C7 | notebook; change-and-history §2 | Owned notebook commands, session gesture queue and revision-guarded confirmation; no tldraw source | none | 2026-11-13 |
| `host/sheetController.ts` | lane w-l | F-SHEET-002/003/004/005/006, C7 | sheets; change-and-history §2 | Owned sheet commands, session gesture queue and revision-guarded confirmation; no tldraw source | none | 2026-11-13 |
| `host/notebookPaper.ts` | lane w-l | F-NB-002/003/004/014, C2.4 | notebook §F-NB-004 | Specs, platform display-list contract and paper.ts; no tldraw source | none | 2026-11-13 |
| `host/notebookBackdrop.ts` | lane w-l | F-NB-004/005, C2.1 | notebook §F-NB-004; contracts C2.1 | Procedural paper and own paint-stream contracts; no tldraw source | none | 2026-11-13 |
| `host/notebookExport.ts` | lane w-l | F-NB-011/014, F-SHEET-008, R-12, C2.4 | notebook §§F-NB-011/014; sheets §F-SHEET-008 | Specs, platform display-list contract; no tldraw source | none | 2026-11-13 |
| `host/pageDisplay.ts` | lane w-l | F-NB-014, F-SHEET-008, C2.4 | notebook §F-NB-014; contracts C2.4 | Specs, platform display list and paint-frame export; no tldraw source | none | 2026-11-13 |
| `host/pagedView.ts` | lane w-l | F-NB-003/005/009/013, C1.2/1.4/1.5 | notebook §§F-NB-003/005/009/013 | Specs and platform camera/page-stack contracts; no tldraw source | none | 2026-11-13 |
| `host/conversionInfo.ts` | lane w-l | I-2, D-WB-convert-backup, C7 | import §4; contracts C7 | Owned conversion metadata interface; no tldraw source | none | 2026-11-13 |
| `host/pdfAttachments.ts` | lane w-l | F-PINK-008, C2.4, R-W15 | pdf-ink §F-PINK-008; native-format §3.6 | Specs, PDF writer attachment/reserved-name contract, owned fence and media hash APIs; no tldraw source | none | 2026-11-13 |
| `host/pdfInkExport.ts` | lane w-l | F-PINK-008, F-SHEET-008, R-12, C2.4 | pdf-ink §F-PINK-008; sheets §F-SHEET-008 | Specs, platform page geometry/display-list and PDF writer contracts; no tldraw source | none | 2026-11-13 |
