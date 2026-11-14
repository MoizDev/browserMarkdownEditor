import type { Rect } from '../../platform/types';
import { graphemeBoundaries } from './graphemes';
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
    const projection = request.text.blocks.map(block => block.runs.map(run => run.text).join('')).join('\n');
    const lines: CaretLine[] = paint.lines.map((line, lineIndex) => {
        const content = projection.slice(line.src[0], line.src[1]);
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
        const validBoundaries = new Set(graphemeBoundaries(content));
        const stops: CaretStop[] = [], clusters: TextCluster[] = [];
        for (const fragment of line.fragments) {
            if (fragment.src[0] === fragment.src[1]) continue;
            const face = table.faces[fragment.face], boundaries = graphemeBoundaries(fragment.text);
            const positions = boundaries.map(offset => {
                const advance = measurer.measure(face, fragment.text.slice(0, offset), fragment.rtl, request.fontEpoch).width * face.size / 64;
                return fragment.rtl ? fragment.x + fragment.width - advance : fragment.x + advance;
            });
            for (let i = 0; i < boundaries.length; i++) {
                const offset = fragment.src[0] + boundaries[i];
                if (validBoundaries.has(offset - line.src[0])) stops.push({ offset, affinity: i === 0 ? 'downstream' : 'upstream', x: positions[i], top: line.top, bottom: line.bottom, line: lineIndex });
                if (i) clusters.push({ src: [fragment.src[0] + boundaries[i - 1], fragment.src[0] + boundaries[i]], bounds: { x: Math.min(positions[i - 1], positions[i]), y: line.top, width: Math.abs(positions[i] - positions[i - 1]), height: line.bottom - line.top }, rtl: fragment.rtl, line: lineIndex });
            }
        }
        if (!stops.length) stops.push({ offset: line.src[0], affinity: 'downstream', x: line.x, top: line.top, bottom: line.bottom, line: lineIndex });
        stops.sort((a, b) => a.x - b.x || a.offset - b.offset);
        clusters.sort((a, b) => a.bounds.x - b.bounds.x);
        const result = { top: line.top, bottom: line.bottom, stops, clusters };
        cache?.set(key, { line: result, start: line.src[0], top: line.top, index: lineIndex });
        return result;
    });
    function hitTest(x: number, y: number): CaretStop {
        if (!lines.length) return { offset: 0, affinity: 'downstream', x: 0, top: 0, bottom: 0, line: 0 };
        let line = lines[0];
        for (const candidate of lines) {
            if (y < (line.bottom + candidate.top) / 2) break;
            line = candidate;
            if (y <= line.bottom) break;
        }
        return line.stops.reduce((best, stop) => Math.abs(stop.x - x) < Math.abs(best.x - x) ? stop : best);
    }
    const byOffset = new Map<number, CaretStop[]>();
    for (const line of lines) for (const stop of line.stops) {
        const stops = byOffset.get(stop.offset);
        if (stops) stops.push(stop); else byOffset.set(stop.offset, [stop]);
    }
    const offsets = [...byOffset.keys()].sort((a, b) => a - b);
    function caret(position: CaretPosition): CaretStop {
        if (!offsets.length) return hitTest(0, 0);
        let lo = 0, hi = offsets.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (offsets[mid] < position.offset) lo = mid + 1;
            else hi = mid;
        }
        const before = offsets[Math.max(0, lo - 1)], after = offsets[Math.min(lo, offsets.length - 1)];
        const offset = position.offset - before <= after - position.offset ? before : after;
        const candidates = byOffset.get(offset)!;
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
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i], paintLine = paint.lines[i];
            let current: Rect | undefined;
            for (const cluster of line.clusters) {
                if (cluster.src[1] <= start || cluster.src[0] >= end) continue;
                const rect = cluster.bounds;
                if (current && rect.x <= current.x + current.width + 0.001) current.width = Math.max(current.x + current.width, rect.x + rect.width) - current.x;
                else { current = { ...rect }; result.push(current); }
            }
            const boundary = paintLine.src[1];
            const consumedBreak = boundary > paintLine.src[0] && /[\r\n\u0085\u2028\u2029]/u.test(projection[boundary - 1]);
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
        for (const line of lines) for (const cluster of line.clusters) {
            const from = Math.max(start, cluster.src[0]), to = Math.min(end, cluster.src[1]);
            for (let offset = from; offset < to; offset++) byOffset.set(offset, cluster.bounds);
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
