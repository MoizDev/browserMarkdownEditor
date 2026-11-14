import type { RichSelection } from './rich';

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
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError('Invalid text offset');
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
