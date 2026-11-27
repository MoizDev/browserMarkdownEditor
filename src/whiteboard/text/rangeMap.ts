import type { RichSelection } from './rich';
import type { RichText } from './richText';
import { projectionLength } from './projection';
import { textBoundaries } from './boundaries';
import { finishTextSteps, finishTextStepsCooperative } from './cooperative';
import { deriveRichTextChangeSteps, type RichTextChange, type RichTextDiffOptions } from './richDiff';
import { deriveRichTextChangesSteps } from './richMultiDiff';
import type { PlainTextOptions } from './plainText';

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

export function mapTextSelectionThrough(selection: RichSelection, maps: readonly TextSpliceMap[]): RichSelection {
    return maps.reduce(mapTextSelection, selection);
}

function validateSelection(text: RichText, selection: RichSelection): void {
    const length = projectionLength(text);
    if (!Number.isSafeInteger(selection.anchor) || !Number.isSafeInteger(selection.focus)
        || selection.anchor < 0 || selection.focus < 0 || selection.anchor > length || selection.focus > length)
        throw new RangeError('Text selection exceeds projection');
}

export function* normalizeTextSelectionSteps(text: RichText, selection: RichSelection, affinity: TextAffinity = 'after'): Generator<void, RichSelection> {
    validateSelection(text, selection);
    if (affinity !== 'before' && affinity !== 'after') throw new RangeError('Invalid text affinity');
    if (selection.anchor === selection.focus) {
        const offset = yield* textBoundaries.snapSteps(text, selection.anchor, affinity === 'before' ? -1 : 1);
        return { anchor: offset, focus: offset };
    }
    const forward = selection.anchor < selection.focus;
    const low = yield* textBoundaries.snapSteps(text, Math.min(selection.anchor, selection.focus), -1);
    const high = yield* textBoundaries.snapSteps(text, Math.max(selection.anchor, selection.focus), 1);
    return forward ? { anchor: low, focus: high } : { anchor: high, focus: low };
}
export function normalizeTextSelection(text: RichText, selection: RichSelection, affinity: TextAffinity = 'after'): RichSelection {
    return finishTextSteps(normalizeTextSelectionSteps(text, selection, affinity));
}
export function normalizeTextSelectionCooperative(text: RichText, selection: RichSelection, options: PlainTextOptions,
    affinity: TextAffinity = 'after'): Promise<RichSelection> {
    return finishTextStepsCooperative(normalizeTextSelectionSteps(text, selection, affinity), options);
}

export function* mapTextSelectionToSteps(selection: RichSelection, map: TextSpliceMap, after: RichText,
    affinity: TextAffinity = 'after'): Generator<void, RichSelection> {
    if (selection.anchor === selection.focus) {
        const offset = mapTextOffset(selection.anchor, map, affinity);
        return yield* normalizeTextSelectionSteps(after, { anchor: offset, focus: offset }, affinity);
    }
    return yield* normalizeTextSelectionSteps(after, mapTextSelection(selection, map), affinity);
}
export function mapTextSelectionTo(selection: RichSelection, map: TextSpliceMap, after: RichText,
    affinity: TextAffinity = 'after'): RichSelection {
    return finishTextSteps(mapTextSelectionToSteps(selection, map, after, affinity));
}
export function mapTextSelectionToCooperative(selection: RichSelection, map: TextSpliceMap, after: RichText,
    options: PlainTextOptions, affinity: TextAffinity = 'after'): Promise<RichSelection> {
    return finishTextStepsCooperative(mapTextSelectionToSteps(selection, map, after, affinity), options);
}

export interface MappedRichTextChange {
    readonly change: RichTextChange | null;
    readonly selection: RichSelection;
}

function* mappedChangeSteps(before: RichText, after: RichText, selection: RichSelection,
    change: RichTextChange | null, affinity: TextAffinity): Generator<void, MappedRichTextChange> {
    validateSelection(before, selection);
    return { change, selection: change ? yield* mapTextSelectionToSteps(selection, change.map, after, affinity)
        : yield* normalizeTextSelectionSteps(after, selection, affinity) };
}

function* mapRichTextChangeSteps(before: RichText, after: RichText, selection: RichSelection,
    affinity: TextAffinity): Generator<void, MappedRichTextChange> {
    validateSelection(before, selection);
    const change = yield* deriveRichTextChangeSteps(before, after);
    return yield* mappedChangeSteps(before, after, selection, change, affinity);
}

export function mapRichTextChange(before: RichText, after: RichText, selection: RichSelection,
    affinity: TextAffinity = 'after'): MappedRichTextChange {
    return finishTextSteps(mapRichTextChangeSteps(before, after, selection, affinity));
}

export function mapRichTextChangeCooperative(before: RichText, after: RichText, selection: RichSelection,
    options: RichTextDiffOptions, affinity: TextAffinity = 'after'): Promise<MappedRichTextChange> {
    return finishTextStepsCooperative(mapRichTextChangeSteps(before, after, selection, affinity), options);
}

export interface MappedRichTextChanges {
    readonly changes: readonly TextSpliceMap[];
    readonly selection: RichSelection;
}
function* mappedChangesSteps(after: RichText, selection: RichSelection, changes: readonly TextSpliceMap[],
    affinity: TextAffinity): Generator<void, MappedRichTextChanges> {
    let current = selection;
    for (const map of changes) {
        if (current.anchor === current.focus) {
            const offset = mapTextOffset(current.anchor, map, affinity);
            current = { anchor: offset, focus: offset };
        } else current = mapTextSelection(current, map);
    }
    return { changes, selection: yield* normalizeTextSelectionSteps(after, current, affinity) };
}

function* mapRichTextChangesSteps(before: RichText, after: RichText, selection: RichSelection,
    affinity: TextAffinity): Generator<void, MappedRichTextChanges> {
    validateSelection(before, selection);
    const changes = yield* deriveRichTextChangesSteps(before, after);
    return yield* mappedChangesSteps(after, selection, changes, affinity);
}

export function mapRichTextChanges(before: RichText, after: RichText, selection: RichSelection,
    affinity: TextAffinity = 'after'): MappedRichTextChanges {
    return finishTextSteps(mapRichTextChangesSteps(before, after, selection, affinity));
}
export function mapRichTextChangesCooperative(before: RichText, after: RichText, selection: RichSelection,
    options: RichTextDiffOptions, affinity: TextAffinity = 'after'): Promise<MappedRichTextChanges> {
    return finishTextStepsCooperative(mapRichTextChangesSteps(before, after, selection, affinity), options);
}
