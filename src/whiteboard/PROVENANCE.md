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

## Formats, importer, save and agent adapter (lane w-d)

| Module | Author | Spec ids | Design section | Sources consulted | Third-party code | Date |
|---|---|---|---|---|---|---|
| `format/schema.ts` | w-d | FMT-1, F-1, F-5, F-6, F-8; R-W4/5/6/8/11/13 | native-format §§3,5,6,10; document-model §§1–4,7–9; text §4; security §§1,3–4 | The named greenfield specifications; w-c's public model types (no code reused); lead's recorded rulings and W-D1 house-style review; no tldraw source/packages | none | 2026-11-13 |
| `format/points.ts` | w-d | FMT-2, F-3, F-9, E-FMT-7/18/21; R-W2/3 | native-format §4; ink §2.2 | The named greenfield specifications; arithmetic LEB128, zig-zag and second differences described there; lead's recorded rulings and W-D1 RangeError/house-style review; no tldraw source/packages | none | 2026-11-13 |
| `format/fence.ts` | w-d | F-10, FC-7 | native-format §3.6; independence-protocol §3 conditions 1–5 | Native specification's exact inert bytes; its fact source is `formats/corpus/received/failure-results.json` (newer-schema/newer-sequences, empty-object/malformed); lead's W-D1 house-style review; no corpus source, old canvas code or tldraw package opened | none | 2026-11-13 |

## Ink, scene, rendering and the viewer host (lane w-e)

| Module | Author | Spec ids | Design section | Sources consulted | Third-party code | Date |
|---|---|---|---|---|---|---|

## Editing lanes (w-f to w-j), export and hosts (w-k, w-l)

Sections are added when these lanes open.
