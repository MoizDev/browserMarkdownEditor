import type { Rect } from '../../platform/types';
import { graphemeBoundaries } from './graphemes';
import type { ReferenceMeasurer } from './measure';
import type { CaretIndex, CaretLine, CaretPosition, CaretStop, FaceTable, TextCluster, TextLayoutRequest, TextPaint } from './paint';

/** Prefix measurements use the same face and reference-size canvas as the paint. */
export function makeCaretIndex(request: TextLayoutRequest, paint: TextPaint, table: FaceTable, measurer: ReferenceMeasurer): CaretIndex {
    const lines: CaretLine[] = paint.lines.map((line, lineIndex) => {
        const stops: CaretStop[] = [], clusters: TextCluster[] = [];
        for (const fragment of line.fragments) {
            if (fragment.src[0] === fragment.src[1]) continue;
            const face = table.faces[fragment.face], boundaries = graphemeBoundaries(fragment.text);
            const positions = boundaries.map(offset => {
                const advance = measurer.measure(face, fragment.text.slice(0, offset), fragment.rtl, request.fontEpoch).width * face.size / 64;
                return fragment.rtl ? fragment.x + fragment.width - advance : fragment.x + advance;
            });
            for (let i = 0; i < boundaries.length; i++) {
                stops.push({ offset: fragment.src[0] + boundaries[i], affinity: i === 0 ? 'downstream' : 'upstream', x: positions[i], top: line.top, bottom: line.bottom, line: lineIndex });
                if (i) clusters.push({ src: [fragment.src[0] + boundaries[i - 1], fragment.src[0] + boundaries[i]], bounds: { x: Math.min(positions[i - 1], positions[i]), y: line.top, width: Math.abs(positions[i] - positions[i - 1]), height: line.bottom - line.top }, rtl: fragment.rtl, line: lineIndex });
            }
        }
        if (!stops.length) stops.push({ offset: line.src[0], affinity: 'downstream', x: request.style.padding.left, top: line.top, bottom: line.bottom, line: lineIndex });
        stops.sort((a, b) => a.x - b.x || a.offset - b.offset);
        clusters.sort((a, b) => a.bounds.x - b.bounds.x);
        return { top: line.top, bottom: line.bottom, stops, clusters };
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
    function caret(position: CaretPosition): CaretStop {
        let best: CaretStop | undefined, distance = Infinity;
        for (const line of lines) for (const stop of line.stops) {
            const next = Math.abs(stop.offset - position.offset);
            if (next < distance || (next === distance && position.affinity && stop.affinity === position.affinity && best?.affinity !== position.affinity)) { best = stop; distance = next; }
        }
        return best ?? hitTest(0, 0);
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
            if (start <= paintLine.src[1] && end > paintLine.src[1] && i + 1 < lines.length) {
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
