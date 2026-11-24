// What the old-board importer (import/records/read.ts) keeps beside the board it makes, and why none of it is a
// picture this app fails to draw. The importer writes each kept record as `legacy-<family>`, and the node fields below,
// and nothing else writes either: their meaning is this app's own, fixed here, unlike a record or field from a newer
// version of the app, whose meaning this version cannot know (pdfVisualPreflight.ts still refuses those).
//
// Every family is one of three things, none of which the board draws:
// - the record an item was made from, kept as written because the item is a simplified reading of it: `rich-text`
//   (the text is drawn; formatting it cannot hold was simplified), `shape` (an upgraded or extra-property shape is
//   drawn from the props it knows; an empty stroke had nothing to draw), `binding` (the arrow end is drawn where the
//   binding put it), `bookmark-asset` (the link card is drawn from it);
// - old-app bookkeeping that was never drawn: `document`, `user`, `unknown-record` (camera, instance, pointer and
//   presence records), `orphan-asset` (a picture file no shape used);
// - an item the importer left out (`shape` with no node of its id, `unreadable-record`, `unreadable-asset`): it is not
//   on the board on screen either, and the board's notice named it when the board opened (import/report.ts).
// So a print, PDF, thumbnail or minimap of an old board, or of its editable copy, is the board as the screen shows it.
// Measured before: every old-app fixture with text (all of them) kept `legacy-rich-text` for its text's `dir` attribute,
// and every one of them refused Export to PDF, Print and its notebook page thumbnails.
//
// No engine import: the importer, the preflight and the legacy PDF conversion all read this.

export const LEGACY_RECORD_FAMILIES = ['shape', 'binding', 'document', 'user', 'unknown-record', 'unreadable-record',
    'bookmark-asset', 'orphan-asset', 'unreadable-asset', 'rich-text'] as const;
export type LegacyRecordFamily = typeof LEGACY_RECORD_FAMILIES[number];

const recordTypes: ReadonlySet<string> = new Set(LEGACY_RECORD_FAMILIES.map(family => `legacy-${family}`));

/** A preserved record the old-board importer wrote (see above): never a visual the board leaves undrawn. */
export function isImportedLegacyRecord(record: { readonly type: string }): boolean {
    return recordTypes.has(record.type);
}

/** The node fields the importer adds beside an item it drew, none of which changes a pixel: the old shape's `meta`, a
 * sticky note's last editor, a link card's preview picture and favicon addresses (the card is drawn without them, as
 * nothing is fetched), and the name of a picture's file that was missing (the picture is drawn as it is on screen). */
export const IMPORTED_LEGACY_NODE_FIELDS: ReadonlySet<string> = new Set(['legacyMeta', 'legacyTextLastEditedBy',
    'legacyBookmarkPreview', 'legacyMissingAsset']);
