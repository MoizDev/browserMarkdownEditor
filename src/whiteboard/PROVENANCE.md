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
| `model/styles.ts` | lane w-c | M-7 | document-model §7; 00-frame §1 | Design; spec/styles named value inventory; no tldraw source | none | 2026-11-13 |
| `model/json.ts` | lane w-c | M-3 | document-model §9.3 | Design only | none | 2026-11-13 |
| `model/media.ts` | lane w-c | M-9 | document-model §8 | Design only | none | 2026-11-13 |
| `model/nodes.ts` | lane w-c | M-3, M-6/7/8/10 | document-model §§3/10; ink §4; rulings R-W8/R-W13 | Design and lead rulings only; explicit fixed-order constructors, shared defaults | none | 2026-11-13 |
| `model/defaults.ts` | lane w-c | M-3/7, R-W13 | document-model §§3.1–3.2 | Design and lead ruling only; explicit defaults, no inferred values | none | 2026-11-13 |
| `model/samples.ts` | lane w-c | M-10, V-10 | ink §2.1; document-model §10.2 | Design and interface agreement with lane w-e only | none | 2026-11-13 |
| `model/doc.ts` | lane w-c | M-1/3/4/6/8/10, C2.2 | document-model §§1/3/5/6/8/10; ruling R-W5 | Design; contracts C2.2 v4.5; app-owned paper.ts type; lead-approved sort-once bulk indexing; no tldraw source | none | 2026-11-13 |
| `model/applyOnly.ts` | lane w-c | M-1/4/5/6/8/10, H-1 | document-model §§5/6/10; change-and-history §2 | Design; readonly ownership agreed with lead; binary sibling edits and reverse-index upkeep | none | 2026-11-13 |
| `change/ops.ts` | lane w-c | H-1/2/3, M-11 | change-and-history §2; ruling R-W5 | Design; app-owned paper.ts type; no tldraw source | none | 2026-11-13 |
| `session/BoardSession.ts` | lane w-c | H-1/3/4, C7.0/5/6 | change-and-history §§2–4; contracts C7 | Design; core save-funnel §2; no tldraw source | none | 2026-11-13 |
| `text/richText.ts` | lane w-c | M-3, V-11 | text §4.1 | Design only; types, not text operations | none | 2026-11-13 |

## Formats, importer, save and agent adapter (lane w-d)

| Module | Author | Spec ids | Design section | Sources consulted | Third-party code | Date |
|---|---|---|---|---|---|---|
| `format/schema.ts` | w-d | FMT-1, F-1, F-5, F-6, F-8; R-W4/5/6/8/11/13 | native-format §§3,5,6,10; document-model §§1–4,7–9; text §4; security §§1,3–4 | The named greenfield specifications; w-c's public model types (no code reused); lead's recorded rulings and W-D1 house-style review; no tldraw source/packages | none | 2026-11-13 |
| `format/points.ts` | w-d | FMT-2, F-3, F-9, E-FMT-7/18/21; R-W2/3 | native-format §4; ink §2.2 | The named greenfield specifications; arithmetic LEB128, zig-zag and second differences described there; lead's recorded rulings and W-D1 RangeError/house-style review; no tldraw source/packages | none | 2026-11-13 |
| `format/fence.ts` | w-d | F-10, FC-7; R-W15 | native-format §3.6; independence-protocol §3 conditions 1–5 | Native specification's exact inert bytes; its fact source is `formats/corpus/received/failure-results.json` (newer-schema/newer-sequences, empty-object/malformed); lead's W-D1 house-style review and R-W15's exact plain-word purpose label; no corpus source, old canvas code or tldraw package opened | none | 2026-11-13 |

## Ink, scene, rendering and the viewer host (lane w-e)

| Module | Author | Spec ids | Design section | Sources consulted | Third-party code | Date |
|---|---|---|---|---|---|---|
| `ink/samples.ts` | lane w-e | D-13; F-INK-006/007/010; E-DOC-24 | `architecture/ink.md` §2.1; `document-model.md` §10; `native-format.md` §4.2 | Those plans; W-C1 `model/samples.ts` public types imported directly; first-principles anchored storage, quantization and explicit leases; formatting follow-up only (4 spaces, semicolons); no tldraw source read | none | 2026-11-13 |
| `ink/canonicalize.ts` | lane w-e | D-13; F-INK-006/007/010 | `architecture/ink.md` §2.1, §3.4; lead rulings R-W9 and E1 certificate scope | Those plans and lead rulings; E1 certifies ONLY axis-aligned exact-collinear constant-pressure windows (zero coverage displacement); all general/slanted/curved candidates retained for W-E1b; bounded whole-control-hull packing certificate; formatting follow-up only (4 spaces, semicolons); no tldraw source read | none | 2026-11-13 |
| `ink/curve.ts` | lane w-e | D-13; F-INK-006/010 | `architecture/ink.md` §3.2–3.3 | That plan; Bernstein/Hermite identities and convex-hull displacement derived from first principles, no library implementation consulted; exact endpoint, validated positive scale/DPR envelope and separate prediction publications; formatting follow-up only (4 spaces, semicolons); no tldraw source read | none | 2026-11-13 |
| `ink/packet.ts` | lane w-e | D-13; F-INK-005/006 | `architecture/ink.md` §6.1–7 | That plan's verbatim packet contract; W-C1 `model/nodes.ts` WidthModel type; first-principles Bernstein convexity, largest singular scale and de Casteljau subdivision; formatting follow-up only (4 spaces, semicolons); no tldraw source read; no dot radius inferred from baseline raster footprints | none | 2026-11-13 |

## Editing lanes (w-f to w-j), export and hosts (w-k, w-l)

Sections are added when these lanes open.
