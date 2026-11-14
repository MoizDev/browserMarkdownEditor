import type { ItemizedBlock } from './itemize';

export interface LogicalLine { readonly from: number; readonly to: number }
/**
 * Greedy UAX #14 wrapping. `advance` measures a whole candidate, preserving shaping
 * across word boundaries; the host excludes trailing hard-break characters from paint.
 */
export function wrapBlock(block: ItemizedBlock, available: number | null, emergency: boolean, advance: (from: number, to: number) => number): LogicalLine[] {
    const lines: LogicalLine[] = [];
    const breaks = block.breaks;
    const nextMandatory = new Array<number>(breaks.length);
    let next = breaks.length - 1;
    for (let i = breaks.length - 1; i >= 0; i--) {
        if (breaks[i].mandatory) next = i;
        nextMandatory[i] = next;
    }
    let from = 0, first = 0;
    while (from < block.text.length) {
        while (first < breaks.length && breaks[first].offset <= from) first++;
        const mandatory = nextMandatory[first] ?? breaks.length - 1;
        let chosen = mandatory;
        if (available !== null) {
            // Probe from this line, not the end of a potentially million-unit paragraph.
            let probe = first, step = 1, lastFit = first - 1;
            while (probe <= mandatory && advance(from, breaks[probe].offset) <= available) {
                lastFit = probe;
                if (probe === mandatory) break;
                probe = Math.min(mandatory, probe + step);
                step *= 2;
            }
            let lo = lastFit + 1, hi = Math.min(mandatory, probe - 1);
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                if (advance(from, breaks[mid].offset) <= available) { lastFit = mid; lo = mid + 1; }
                else hi = mid - 1;
            }
            chosen = lastFit < first ? first : lastFit;
        }
        let to = breaks[chosen].offset;
        if (available !== null && emergency && advance(from, to) > available) {
            const candidates = block.graphemes;
            let lo = 0, hi = candidates.length;
            while (lo < hi) { const mid = (lo + hi) >> 1; if (candidates[mid] <= from) lo = mid + 1; else hi = mid; }
            const start = lo;
            hi = candidates.length - 1;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                if (candidates[mid] <= to && advance(from, candidates[mid]) <= available) lo = mid + 1;
                else hi = mid - 1;
            }
            to = candidates[Math.max(start, hi)] ?? to;
        }
        if (to <= from) to = block.text.length;
        lines.push({ from, to });
        from = to;
    }
    if (!lines.length || /[\n\r\u0085\u2028\u2029]$/u.test(block.text)) lines.push({ from, to: from });
    return lines;
}
