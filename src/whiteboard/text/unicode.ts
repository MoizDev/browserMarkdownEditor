import { bidiBrackets, unicodeTables } from './unicodeTables';

type Property = 'lineBreak' | 'bidiClass' | 'eastAsianWidth' | 'category' | 'extendedPictographic';

/** Unicode 17.0 properties, independent of the browser's ICU version. */
export function unicodeProperty(property: Property, codePoint: number): string {
    if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) throw new RangeError('Invalid Unicode code point');
    const table = unicodeTables[property];
    const values = table.intervals;
    let lo = 0, hi = values.length / 3 - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1, index = mid * 3;
        if (codePoint < values[index]) hi = mid - 1;
        else if (codePoint > values[index + 1]) lo = mid + 1;
        else return table.names[values[index + 2]];
    }
    throw new Error('Incomplete Unicode property table');
}

/** UAX #9 paired bracket mapping; undefined for non-brackets. */
export function bidiBracket(codePoint: number): { pair: number; open: boolean } | undefined {
    let lo = 0, hi = bidiBrackets.length / 3 - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1, i = mid * 3;
        if (codePoint < bidiBrackets[i]) hi = mid - 1;
        else if (codePoint > bidiBrackets[i]) lo = mid + 1;
        else return { pair: bidiBrackets[i + 1], open: bidiBrackets[i + 2] === 1 };
    }
    return undefined;
}
