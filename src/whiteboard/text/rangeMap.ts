import type { RichSelection } from './rich';
import type { RichText } from './richText';
import { projectionLength } from './projection';
import { textBoundaries } from './boundaries';
import { deriveRichTextChange, deriveRichTextChangeCooperative, type RichTextChange, type RichTextDiffOptions } from './richDiff';
import { deriveRichTextChanges, deriveRichTextChangesCooperative } from './richMultiDiff';

export type TextAffinity = 'before' | 'after';
export interface TextSpliceMap {
    readonly from: number;
    readonly to: number;
    readonly insertedLength: number;
}

function validate(map: TextSpliceMap): void {
    if (![map.from, map.to, map.insertedLength].every(Number.isSafeInteger)
        || map.from < 0 || map.to < map.from || map.insertedLength < 0
        || !Number.isSafeInteger(map.from + map.insertedLength)) throw new RangeError('Invalid text splice map');
}

/** Maps a UTF-16 boundary across one splice; affinity controls insertions at that boundary. */
export function mapTextOffset(offset: number, map: TextSpliceMap, affinity: TextAffinity = 'after'): number {
    validate(map);
    if (!Number.isSafeInteger(offset) || offset < 0 || (affinity !== 'before' && affinity !== 'after')) throw new RangeError('Invalid text offset or affinity');
    if (offset < map.from) return offset;
    if (offset > map.to) {
        const result = offset + map.insertedLength - (map.to - map.from);
        if (!Number.isSafeInteger(result)) throw new RangeError('Mapped text offset exceeds limits');
        return result;
    }
    if (offset === map.to && map.to !== map.from) return map.from + map.insertedLength;
    return affinity === 'before' ? map.from : map.from + map.insertedLength;
}

/** A collapsed cursor sticks after insertion; a nonempty selection keeps its original direction. */
export function mapTextSelection(selection: RichSelection, map: TextSpliceMap): RichSelection {
    if (selection.anchor === selection.focus) {
        const offset = mapTextOffset(selection.anchor, map, 'after');
        return { anchor: offset, focus: offset };
    }
    const forward = selection.anchor < selection.focus;
    const low = mapTextOffset(Math.min(selection.anchor, selection.focus), map, 'before');
    const high = mapTextOffset(Math.max(selection.anchor, selection.focus), map, 'after');
    return forward ? { anchor: low, focus: high } : { anchor: high, focus: low };
}

/** Maps are applied in transaction order: every later map is in its preceding result's coordinates. */
export function mapTextSelectionThrough(selection: RichSelection, maps: readonly TextSpliceMap[]): RichSelection {
    return maps.reduce(mapTextSelection, selection);
}

function validateSelection(text: RichText, selection: RichSelection): void {
    const length = projectionLength(text);
    if (!Number.isSafeInteger(selection.anchor) || !Number.isSafeInteger(selection.focus)
        || selection.anchor < 0 || selection.focus < 0 || selection.anchor > length || selection.focus > length)
        throw new RangeError('Text selection exceeds projection');
}

/**
 * A selection never cuts a grapheme, even if the edit joins characters across
 * a former run or block boundary. Expanded selections keep their direction;
 * a collapsed caret uses the requested insertion affinity.
 */
export function normalizeTextSelection(text: RichText, selection: RichSelection, affinity: TextAffinity = 'after'): RichSelection {
    validateSelection(text, selection);
    if (affinity !== 'before' && affinity !== 'after') throw new RangeError('Invalid text affinity');
    if (selection.anchor === selection.focus) {
        const offset = textBoundaries.snap(text, selection.anchor, affinity === 'before' ? -1 : 1);
        return { anchor: offset, focus: offset };
    }
    const forward = selection.anchor < selection.focus;
    const low = textBoundaries.snap(text, Math.min(selection.anchor, selection.focus), -1);
    const high = textBoundaries.snap(text, Math.max(selection.anchor, selection.focus), 1);
    return forward ? { anchor: low, focus: high } : { anchor: high, focus: low };
}

/** Map an old selection through a known splice and normalize in the new value. */
export function mapTextSelectionTo(selection: RichSelection, map: TextSpliceMap, after: RichText,
    affinity: TextAffinity = 'after'): RichSelection {
    if (selection.anchor === selection.focus) {
        const offset = mapTextOffset(selection.anchor, map, affinity);
        return normalizeTextSelection(after, { anchor: offset, focus: offset }, affinity);
    }
    return normalizeTextSelection(after, mapTextSelection(selection, map), affinity);
}

export interface MappedRichTextChange {
    readonly change: RichTextChange | null;
    readonly selection: RichSelection;
}

function mappedChange(before: RichText, after: RichText, selection: RichSelection,
    change: RichTextChange | null, affinity: TextAffinity): MappedRichTextChange {
    validateSelection(before, selection);
    return { change, selection: change ? mapTextSelectionTo(selection, change.map, after, affinity)
        : normalizeTextSelection(after, selection, affinity) };
}

/** Derive an external text change and preserve a valid directional selection. */
export function mapRichTextChange(before: RichText, after: RichText, selection: RichSelection,
    affinity: TextAffinity = 'after'): MappedRichTextChange {
    validateSelection(before, selection);
    return mappedChange(before, after, selection, deriveRichTextChange(before, after), affinity);
}

export async function mapRichTextChangeCooperative(before: RichText, after: RichText, selection: RichSelection,
    options: RichTextDiffOptions, affinity: TextAffinity = 'after'): Promise<MappedRichTextChange> {
    validateSelection(before, selection);
    const change = await deriveRichTextChangeCooperative(before, after, options);
    return mappedChange(before, after, selection, change, affinity);
}

export interface MappedRichTextChanges {
    readonly changes: readonly TextSpliceMap[];
    readonly selection: RichSelection;
}
function mappedChanges(after: RichText, selection: RichSelection, changes: readonly TextSpliceMap[], affinity: TextAffinity): MappedRichTextChanges {
    let current = selection;
    for (const map of changes) {
        if (current.anchor === current.focus) {
            const offset = mapTextOffset(current.anchor, map, affinity);
            current = { anchor: offset, focus: offset };
        } else current = mapTextSelection(current, map);
    }
    return { changes, selection: normalizeTextSelection(after, current, affinity) };
}

/** Preserve selection through distinct changes when a bounded diff can identify them. */
export function mapRichTextChanges(before: RichText, after: RichText, selection: RichSelection,
    affinity: TextAffinity = 'after'): MappedRichTextChanges {
    validateSelection(before, selection);
    return mappedChanges(after, selection, deriveRichTextChanges(before, after), affinity);
}
export async function mapRichTextChangesCooperative(before: RichText, after: RichText, selection: RichSelection,
    options: RichTextDiffOptions, affinity: TextAffinity = 'after'): Promise<MappedRichTextChanges> {
    validateSelection(before, selection);
    const changes = await deriveRichTextChangesCooperative(before, after, options);
    return mappedChanges(after, selection, changes, affinity);
}
