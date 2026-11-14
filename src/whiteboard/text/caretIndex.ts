import type { Rect } from '../../platform/types';
import { graphemeBoundaries } from './graphemes';
import { projectionSlice } from './projection';
import type { ReferenceMeasurer } from './measure';
import type { CaretIndex, CaretLine, CaretPosition, CaretStop, FaceTable, TextCluster, TextLayoutRequest, TextPaint } from './paint';

interface CachedLine { readonly line: CaretLine; readonly start: number; readonly top: number; readonly index: number }
/** Unchanged wrapped lines retain their prefix measurements across text revisions. */
export class CaretLineCache {
    private readonly entries = new Map<string, CachedLine>();
    get(key: string): CachedLine | undefined {
        const hit = this.entries.get(key);
        if (hit) { this.entries.delete(key); this.entries.set(key, hit); }
        return hit;
    }
    set(key: string, line: CachedLine): void {
        this.entries.set(key, line);
        if (this.entries.size > 4096) this.entries.delete(this.entries.keys().next().value!);
    }
}

/** Prefix measurements use the same face and reference-size canvas as the paint. */
export function makeCaretIndex(request: TextLayoutRequest, paint: TextPaint, table: FaceTable, measurer: ReferenceMeasurer, cache?: CaretLineCache): CaretIndex {
    const buildLine = (lineIndex: number): CaretLine => {
        const line = paint.lines[lineIndex];
        const content = projectionSlice(request.text, line.src[0], line.src[1]);
        const key = JSON.stringify([paint.fontEpoch, content, line.x, line.bottom - line.top, line.direction,
            line.fragments.map(fragment => [fragment.text, fragment.x, fragment.width, fragment.rtl, table.faces[fragment.face].css,
                table.faces[fragment.face].size, fragment.src[0] - line.src[0], fragment.src[1] - line.src[0]])]);
        const previous = cache?.get(key);
        if (previous) {
            const shiftOffset = line.src[0] - previous.start, shiftY = line.top - previous.top;
            if (!shiftOffset && !shiftY && lineIndex === previous.index) return previous.line;
            return {
                top: line.top, bottom: line.bottom,
                stops: previous.line.stops.map(stop => ({ ...stop, offset: stop.offset + shiftOffset, top: stop.top + shiftY, bottom: stop.bottom + shiftY, line: lineIndex })),
                clusters: previous.line.clusters.map(cluster => ({ ...cluster, src: [cluster.src[0] + shiftOffset, cluster.src[1] + shiftOffset] as const, bounds: { ...cluster.bounds, y: cluster.bounds.y + shiftY }, line: lineIndex })),
            };
        }
        const lineBoundaries = graphemeBoundaries(content), validBoundaries = new Set(lineBoundaries);
        const boundaryAfter = (offset: number) => {
            let lo = 0, hi = lineBoundaries.length;
            while (lo < hi) { const mid = (lo + hi) >>> 1; if (lineBoundaries[mid] <= offset) lo = mid + 1; else hi = mid; }
            return lo;
        };
        const stops: CaretStop[] = [], pieces: TextCluster[] = [];
        for (const fragment of line.fragments) {
            if (fragment.src[0] === fragment.src[1]) continue;
            const face = table.faces[fragment.face], boundaries = [...new Set([
                ...graphemeBoundaries(fragment.text),
                ...lineBoundaries.slice(boundaryAfter(fragment.src[0] - line.src[0]), boundaryAfter(fragment.src[1] - line.src[0] - 1))
                    .map(offset => line.src[0] + offset - fragment.src[0]),
            ])].sort((a, b) => a - b);
            const positions = boundaries.map(offset => {
                const advance = measurer.measure(face, fragment.text.slice(0, offset), fragment.rtl, request.fontEpoch).width * face.size / 64;
                return fragment.rtl ? fragment.x + fragment.width - advance : fragment.x + advance;
            });
            for (let i = 0; i < boundaries.length; i++) {
                const offset = fragment.src[0] + boundaries[i];
                if (validBoundaries.has(offset - line.src[0])) stops.push({ offset, affinity: i === 0 ? 'downstream' : 'upstream', x: positions[i], top: line.top, bottom: line.bottom, line: lineIndex });
                if (i) pieces.push({ src: [fragment.src[0] + boundaries[i - 1], fragment.src[0] + boundaries[i]], bounds: { x: Math.min(positions[i - 1], positions[i]), y: line.top, width: Math.abs(positions[i] - positions[i - 1]), height: line.bottom - line.top }, rtl: fragment.rtl, line: lineIndex });
            }
        }
        // Mark and bidi boundaries can split one Unicode grapheme into several painted fragments.
        // Its UTF-16 code units must all report the same selection/IME rectangle.
        const graphemes = new Map<number, TextCluster>();
        for (const piece of pieces) {
            const relative = piece.src[0] - line.src[0];
            const index = Math.max(0, boundaryAfter(relative) - 1), from = line.src[0] + lineBoundaries[index], to = line.src[0] + (lineBoundaries[index + 1] ?? lineBoundaries[index]);
            const previous = graphemes.get(from);
            if (!previous) graphemes.set(from, { ...piece, src: [from, to] });
            else {
                const left = Math.min(previous.bounds.x, piece.bounds.x), right = Math.max(previous.bounds.x + previous.bounds.width, piece.bounds.x + piece.bounds.width);
                graphemes.set(from, { ...previous, bounds: { ...previous.bounds, x: left, width: right - left } });
            }
        }
        const clusters = [...graphemes.values()];
        if (!stops.length) stops.push({ offset: line.src[0], affinity: 'downstream', x: line.x, top: line.top, bottom: line.bottom, line: lineIndex });
        stops.sort((a, b) => a.x - b.x || a.offset - b.offset);
        clusters.sort((a, b) => a.bounds.x - b.bounds.x);
        const result = { top: line.top, bottom: line.bottom, stops, clusters };
        cache?.set(key, { line: result, start: line.src[0], top: line.top, index: lineIndex });
        return result;
    };
    const built = new Map<number, CaretLine>();
    const getLine = (index: number): CaretLine => {
        let line = built.get(index);
        if (!line) { line = buildLine(index); built.set(index, line); }
        return line;
    };
    const lines: CaretLine[] = paint.lines.map((line, index) => ({
        top: line.top, bottom: line.bottom,
        get stops() { return getLine(index).stops; },
        get clusters() { return getLine(index).clusters; },
    }));
    function hitTest(x: number, y: number): CaretStop {
        if (!lines.length) return { offset: 0, affinity: 'downstream', x: 0, top: 0, bottom: 0, line: 0 };
        let lo = 0, hi = lines.length - 1;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (y < (lines[mid].bottom + lines[mid + 1].top) / 2) hi = mid; else lo = mid + 1;
        }
        const stops = lines[lo].stops;
        let left = 0, right = stops.length;
        while (left < right) { const mid = (left + right) >>> 1; if (stops[mid].x < x) left = mid + 1; else right = mid; }
        const before = stops[Math.max(0, left - 1)], after = stops[Math.min(left, stops.length - 1)];
        return Math.abs(before.x - x) <= Math.abs(after.x - x) ? before : after;
    }
    const firstLine = (offset: number): number => {
        let lo = 0, hi = paint.lines.length;
        while (lo < hi) { const mid = (lo + hi) >>> 1; if (paint.lines[mid].src[1] < offset) lo = mid + 1; else hi = mid; }
        return lo;
    };
    const logicalStops = new Map<number, { offsets: readonly number[]; byOffset: ReadonlyMap<number, readonly CaretStop[]> }>();
    const stopsByOffset = (index: number) => {
        let cached = logicalStops.get(index);
        if (cached) return cached;
        const byOffset = new Map<number, CaretStop[]>();
        for (const stop of lines[index].stops) {
            const stops = byOffset.get(stop.offset);
            if (stops) stops.push(stop); else byOffset.set(stop.offset, [stop]);
        }
        cached = { offsets: [...byOffset.keys()].sort((a, b) => a - b), byOffset };
        logicalStops.set(index, cached);
        return cached;
    };
    function caret(position: CaretPosition): CaretStop {
        if (!lines.length) return hitTest(0, 0);
        const first = firstLine(position.offset), indices: number[] = [];
        if (first > 0) indices.push(first - 1);
        if (first < lines.length) {
            indices.push(first);
            for (let i = first + 1; i < lines.length && paint.lines[i].src[0] <= position.offset; i++) indices.push(i);
        }
        let bestOffset = 0, distance = Infinity;
        let candidates: readonly CaretStop[] = [];
        for (const index of indices) {
            const { offsets, byOffset } = stopsByOffset(index);
            if (!offsets.length) continue;
            let lo = 0, hi = offsets.length;
            while (lo < hi) { const mid = (lo + hi) >>> 1; if (offsets[mid] < position.offset) lo = mid + 1; else hi = mid; }
            for (const offset of [offsets[Math.max(0, lo - 1)], offsets[Math.min(lo, offsets.length - 1)]]) {
                const delta = Math.abs(position.offset - offset);
                if (delta < distance || (delta === distance && offset < bestOffset)) {
                    distance = delta; bestOffset = offset; candidates = byOffset.get(offset)!;
                } else if (delta === distance && offset === bestOffset && !candidates.some(stop => stop.line === index)) {
                    candidates = [...candidates, ...byOffset.get(offset)!];
                }
            }
        }
        if (!candidates.length) return hitTest(0, 0);
        if (position.affinity) return candidates.find(stop => stop.affinity === position.affinity) ?? candidates[0];
        const primary = candidates.find(stop => lines[stop.line].clusters.some(cluster =>
            cluster.rtl === (paint.lines[stop.line].direction === 'rtl')
            && (cluster.src[0] === stop.offset || cluster.src[1] === stop.offset)
            && (Math.abs(cluster.bounds.x - stop.x) < 0.001 || Math.abs(cluster.bounds.x + cluster.bounds.width - stop.x) < 0.001)));
        return primary ?? candidates[0];
    }
    function selection(start: number, end: number): readonly Rect[] {
        if (start > end) [start, end] = [end, start];
        const result: Rect[] = [];
        for (let i = firstLine(start); i < lines.length && paint.lines[i].src[0] <= end; i++) {
            const line = lines[i], paintLine = paint.lines[i];
            let current: Rect | undefined;
            for (const cluster of line.clusters) {
                if (cluster.src[1] <= start || cluster.src[0] >= end) continue;
                const rect = cluster.bounds;
                if (current && rect.x <= current.x + current.width + 0.001) current.width = Math.max(current.x + current.width, rect.x + rect.width) - current.x;
                else { current = { ...rect }; result.push(current); }
            }
            const boundary = paintLine.src[1];
            const consumedBreak = boundary > paintLine.src[0] && /[\r\n\u0085\u2028\u2029]/u.test(projectionSlice(request.text, boundary - 1, boundary));
            const crossesLine = consumedBreak ? start < boundary && end >= boundary : start <= boundary && end > boundary;
            if (crossesLine && i + 1 < lines.length) {
                const edge = line.stops[line.stops.length - 1].x;
                const x = paintLine.direction === 'rtl' ? 0 : edge;
                result.push({ x, y: line.top, width: paintLine.direction === 'rtl' ? edge : Math.max(0, paint.box.w - edge), height: line.bottom - line.top });
            }
        }
        return result;
    }
    function characterBounds(start: number, end: number): readonly Rect[] {
        const byOffset = new Map<number, Rect>();
        for (let index = firstLine(start); index < lines.length && paint.lines[index].src[0] < end; index++) {
            for (const cluster of lines[index].clusters) {
                const from = Math.max(start, cluster.src[0]), to = Math.min(end, cluster.src[1]);
                for (let offset = from; offset < to; offset++) byOffset.set(offset, cluster.bounds);
            }
        }
        const result: Rect[] = [];
        for (let offset = start; offset < end; offset++) {
            const rect = byOffset.get(offset);
            if (rect) result.push(rect);
            else {
                const stop = caret({ offset });
                result.push({ x: stop.x, y: stop.top, width: 0, height: stop.bottom - stop.top });
            }
        }
        return result;
    }
    return { paintKey: paint.key, lines, hitTest, caret, selection, characterBounds };
}
