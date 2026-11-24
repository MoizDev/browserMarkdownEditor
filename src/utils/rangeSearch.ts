/** Searches over source ranges sorted by position and disjoint (touching is OK). */
export interface CharRange { from: number; to: number }

export function firstRangeEndingAfter(ranges: readonly CharRange[], from: number): number {
    let lo = 0, hi = ranges.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (ranges[mid].to <= from) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

export function overlapsRange(ranges: readonly CharRange[], from: number, to: number): boolean {
    const range = ranges[firstRangeEndingAfter(ranges, from)];
    return !!range && range.from < to;
}

/** Containment includes the edges; a table containing inline code is not code. */
export function containsRange(ranges: readonly CharRange[], from: number, to: number): boolean {
    let lo = 0, hi = ranges.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (ranges[mid].from <= from) lo = mid + 1;
        else hi = mid;
    }
    const range = ranges[lo - 1];
    return !!range && range.to >= to;
}

/** Keystroke pairing excludes both delimiters, unlike range containment. */
export function straddlesPoint(ranges: readonly CharRange[], pos: number): boolean {
    const range = ranges[firstRangeEndingAfter(ranges, pos)];
    return !!range && range.from < pos;
}
