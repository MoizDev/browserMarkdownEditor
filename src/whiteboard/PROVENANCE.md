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

## Ink, scene, rendering and the viewer host (lane w-e)

| Module | Author | Spec ids | Design section | Sources consulted | Third-party code | Date |
|---|---|---|---|---|---|---|
| `ink/samples.ts` | lane w-e | D-13; F-INK-006/007/010; E-DOC-24 | `architecture/ink.md` §2.1; `document-model.md` §10; `native-format.md` §4.2 | Those plans; W-C1 reader contract; first-principles anchored storage, quantization and explicit leases; no tldraw source read | none | 2026-11-13 |
| `ink/canonicalize.ts` | lane w-e | D-13; F-INK-006/007/010 | `architecture/ink.md` §2.1, §3.4; lead rulings R-W9 and E1 certificate scope | Those plans and lead rulings; E1 certifies ONLY axis-aligned exact-collinear constant-pressure windows (zero coverage displacement); all general/slanted/curved candidates retained for W-E1b; bounded whole-control-hull packing certificate; no tldraw source read | none | 2026-11-13 |
| `ink/curve.ts` | lane w-e | D-13; F-INK-006/010 | `architecture/ink.md` §3.2–3.3 | That plan; Bernstein/Hermite identities and convex-hull displacement derived from first principles, no library implementation consulted; exact endpoint and separate prediction publications; no tldraw source read | none | 2026-11-13 |
| `ink/packet.ts` | lane w-e | D-13; F-INK-005/006 | `architecture/ink.md` §6.1–7 | That plan's verbatim packet contract; first-principles Bernstein convexity, largest singular scale and de Casteljau subdivision; no tldraw source read; no dot radius inferred from baseline raster footprints | none | 2026-11-13 |

## Editing lanes (w-f to w-j), export and hosts (w-k, w-l)

Sections are added when these lanes open.
