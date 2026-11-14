# Provenance of the whiteboard engine

The whiteboard engine is greenfield: it contains no tldraw code, nothing copied, adapted or
transcribed from tldraw, and it imports no tldraw package, `perfect-freehand` or any library by
tldraw's authors. This ledger records where every module's requirements came from.

One row per module (file), added or updated in the same change as the module. Each lane appends rows
only inside its own section, so that lanes never edit the same lines.

Columns: module path · author (lane) · spec ids implemented · design document section · sources
consulted while writing (tldraw files read, if any, and the fact taken; literature; packages) ·
third-party code included (normally "none") · date.

## Model, changes, history and text (lane w-c)

| Module | Author | Spec ids | Design section | Sources consulted | Third-party code | Date |
|---|---|---|---|---|---|---|
| `model/ids.ts` | lane w-c | M-2 | document-model §2 | Design only; Web Crypto API; no tldraw source | none | 2026-11-13 |
| `model/orderKey.ts` | lane w-c | M-4, E-DOC-4/5/6 | document-model §4; rulings R-W7/R-W12 | Literature via document-model §4/Sources: E. Wallace, Realtime editing of ordered sequences (Figma, 2017); D. Greenspan, Implementing Fractional Indexing (2020); neither original article read by coder; independent base62 arithmetic from design/rulings | none | 2026-11-13 |
| `model/styles.ts` | lane w-c | M-7, R-W19 | document-model §7; 00-frame §1; ruling R-W19 | Design; spec/styles named value inventory; preserved pen-record fields; no tldraw source | none | 2026-11-13 |
| `model/json.ts` | lane w-c | M-3, R-W17/20/21/23 | document-model §9.3 | Design and lead rulings; reader-branded values, decoded keys, native-token raw maps, no path keys | none | 2026-11-13 |
| `model/media.ts` | lane w-c | M-9, SEC-4, R-W14b/19/32 | document-model §8; native-format §5; security §4 | Design and lead rulings; authoritative MIME data incl AVIF, nullable duration and preserved fields | none | 2026-11-13 |
| `model/nodes.ts` | lane w-c | M-3, M-6/7/8/10, R-W17 | document-model §§3/9.3/10; ink §4; rulings R-W8/R-W13/R-W17 | Design and lead rulings only; explicit fixed-order constructors, shared defaults, opaque raw lexeme | none | 2026-11-13 |
| `model/defaults.ts` | lane w-c | M-3/7/9, R-W13/28/35 | document-model §§3.1–3.2/7; native-format §§3.2/5; spec/styles F-STYLE-010 | Lead-confirmed UI/view/media defaults; penStyle constant via lead citation; initial tool/highlighter pending M1 | none | 2026-11-13 |
| `model/fileFields.ts` | lane w-c | M-3, R-W23 | document-model §9.3; native-format §§3.3–3.4; ruling R-W23 | Design and lead ruling; shared model-property to native-token mapping for encoder and CH-1 | none | 2026-11-13 |
| `model/samples.ts` | lane w-c | M-10, V-10 | ink §2.1; document-model §10.2 | Design and interface agreement with lane w-e only | none | 2026-11-13 |
| `model/validate.ts` | lane w-c | DM-3, V-1..V-12, M-11, H-3, R-W25/30/32 | document-model §§3/5/6/9; change-and-history §2; text §4; security §§4/8.1 | Design/range/two-phase rulings; authoritative normalizePaper; shared model-owned MIME list incl AVIF; opaque marks, block cap and preserved-reference drop guard; no tldraw source | none | 2026-11-13 |
| `model/textOffsets.ts` | lane w-c | V-11, R-W18/21 | text §4.1; UTF-16 projection | Design and lead-approved temporary allocation-free scan, cached offsets/graphemes owed to TX-2/TX-1 | none | 2026-11-13 |
| `model/rawMedia.ts` | lane w-c | M-3/9, R-W25/30/37 | document-model §9.3; preserved-media rulings | Independent escaped-string/key scan; 64-hex runs plus first/last candidates in longer runs, bounded ring and per-raw dedup; no parse, upstream read or registry | none | 2026-11-13 |
| `model/doc.ts` | lane w-c | M-1/3/4/6/8/10, C2.2, R-W17/18/19/20/21/23/25/30 | document-model §§1/3/5/6/8/9.3/10; native-format §6 | Design/lead rulings; C2.2 v4.5; app-owned paper type; live refs and reader-supplied preserved-ref counts; preserved fields/version/end; no tldraw source | none | 2026-11-13 |
| `model/applyOnly.ts` | lane w-c | M-1/4/5/6/8/10, H-1, R-W18/19/21/23/25 | document-model §§5/6/10; change-and-history §2 | Design; readonly ownership incl preserved-ref count table; binary sibling/live-index edits; sheet/host ext retained; raw maintenance is CH-1 | none | 2026-11-13 |
| `change/ops.ts` | lane w-c | H-1/2/3, M-11, R-W19/21/23 | change-and-history §2; rulings R-W5/R-W19/R-W21/R-W23 | Design; app-owned paper.ts type; PDF lexeme value and native-token transactional invalidation contract; no tldraw source | none | 2026-11-13 |
| `session/BoardSession.ts` | lane w-c | H-1/3/4, C7.0/5/6 | change-and-history §§2–4; contracts C7 | Design; core save-funnel §2; no tldraw source | none | 2026-11-13 |
| `text/richText.ts` | lane w-c | M-3, V-11, R-W19/21/25 | text §4.1; preserved-data rulings | Design only; immutable types, raw JSON-array block/run tails and opaque unknown marks, not text operations | none | 2026-11-13 |

## Formats, importer, save and agent adapter (lane w-d)

| Module | Author | Spec ids | Design section | Sources consulted | Third-party code | Date |
|---|---|---|---|---|---|---|
| `format/schema.ts` | w-d | FMT-1, F-1, F-5, F-6, F-8; R-W4/5/6/8/11/13/17/20 | native-format §§3,5,6,10; document-model §§1–4,7–9; text §4; security §§1,3–4 | The named greenfield specifications; w-c's public model types and shared defaults (no implementation copied); lead's recorded rulings; R-W17/20 replace source-sidecar types with model-owned raw lexemes; no tldraw source/packages | none | 2026-11-13 |
| `format/points.ts` | w-d | FMT-2, F-3, F-9, E-FMT-7/18/21; R-W2/3 | native-format §4; ink §2.2 | The named greenfield specifications; arithmetic LEB128, zig-zag and second differences described there; lead's recorded rulings and W-D1 RangeError/house-style review; no tldraw source/packages | none | 2026-11-13 |
| `format/fence.ts` | w-d | F-10, FC-7; R-W15 | native-format §3.6; independence-protocol §3 conditions 1–5 | Native specification's exact inert bytes; its fact source is `formats/corpus/received/failure-results.json` (newer-schema/newer-sequences, empty-object/malformed); lead's W-D1 house-style review and R-W15's exact plain-word purpose label; no corpus source, old canvas code or tldraw package opened | none | 2026-11-13 |
| `format/encode.ts` | w-d | FMT-3, F-1/5/6/7/8/10; R-W13/14/15/16/17/19/20/22/23/25 | native-format §§3,11; document-model §§3,7,8; text §4.2 | Those greenfield plans; w-c's public model/defaults/fileFields types and data; model-owned live/preserved media index contract; lead's recorded rulings; w-e's sample-coordinate/run contract (no ink implementation read); no tldraw source/packages | none | 2026-11-13 |
| `format/lineTable.ts` | w-d | FMT-3, F-6/7; R-W16 | native-format §§3.2,11 | Those greenfield plans; TouchedSet public type; lead-approved commutative four-lane consistency digest, using independently seeded 32-bit FNV-style arithmetic (not a security hash); no third-party implementation consulted | none | 2026-11-13 |
| `format/writeJson.ts` | w-d | FMT-3, F-5/6; R-W16/17/20/22/23 | native-format §§3.3,6,10,11; text §4.2 | Those greenfield plans and raw-lexeme rulings; model RawJson/ExtBag public types; JSON token/string rules implemented independently; no tldraw source/packages | none | 2026-11-13 |
| `format/writeTypes.ts` | w-d | FMT-3, F-6/7 | native-format §§3.1–3.3,10,11 | Those greenfield plans; JSON identity tuples and UTF-8 byte-length rules implemented independently; no tldraw source/packages | none | 2026-11-13 |

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

## Editing lanes (w-f to w-j), export and hosts (w-k, w-l)

Sections are added when these lanes open.
