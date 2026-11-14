import type { Rect } from '../../platform/types';
import type { ReferenceMeasurer } from './measure';
import type { CaretIndex, CaretLine, CaretPosition, CaretStop, FaceTable, TextCluster, TextLayoutRequest, TextPaint } from './paint';

const indices = new WeakMap<ReferenceMeasurer, { paint: TextPaint; text: TextLayoutRequest['text']; epoch: number; table: FaceTable; index: CaretIndex }>();
export function clearLongAsciiCaretIndex(measurer: ReferenceMeasurer): void { indices.delete(measurer); }

/** Exact canvas-prefix caret queries without materializing every prefix of one long ASCII line. */
export function longAsciiCaretIndex(request: TextLayoutRequest, paint: TextPaint, table: FaceTable, measurer: ReferenceMeasurer): CaretIndex | null {
    const cached = indices.get(measurer);
    if (cached && cached.paint === paint && cached.text === request.text && cached.epoch === request.fontEpoch && cached.table === table) return cached.index;
    if (paint.lines.length !== 1 || request.text.blocks.length !== 1 || request.text.blocks[0].runs.length !== 1) return null;
    const line = paint.lines[0], run = request.text.blocks[0].runs[0], fragment = line.fragments[0];
    if (line.fragments.length !== 1 || !fragment || fragment.rtl || line.direction !== 'ltr' || run.text.length < 8192
        || !/^[\x20-\x7e]+$/u.test(run.text) || fragment.text !== run.text || line.src[0] !== 0 || line.src[1] !== run.text.length
        || fragment.src[0] !== 0 || fragment.src[1] !== run.text.length || !table.faces[fragment.face]) return null;
    const face = table.faces[fragment.face], length = run.text.length;
    if (!(face.size > 0) || !(fragment.width > 0)) return null;
    const positions = new Map<number, number>();
    const xAt = (offset: number): number => {
        const hit = positions.get(offset);
        if (hit !== undefined) { positions.delete(offset); positions.set(offset, hit); return hit; }
        const x = fragment.x + measurer.measure(face, run.text.slice(0, offset), false, request.fontEpoch).width * face.size / 64;
        positions.set(offset, x);
        if (positions.size > 2048) positions.delete(positions.keys().next().value!);
        return x;
    };
    const clamp = (offset: number) => Math.max(0, Math.min(length, Number.isFinite(offset) ? Math.round(offset) : 0));
    const stop = (offset: number): CaretStop => {
        const point = clamp(offset);
        return { offset: point, affinity: point === 0 ? 'downstream' : 'upstream', x: xAt(point), top: line.top, bottom: line.bottom, line: 0 };
    };
    const cluster = (offset: number): TextCluster => {
        const left = xAt(offset), right = xAt(offset + 1);
        return { src: [offset, offset + 1], bounds: { x: Math.min(left, right), y: line.top, width: Math.abs(right - left), height: line.bottom - line.top }, rtl: false, line: 0 };
    };
    let allStops: readonly CaretStop[] | undefined, allClusters: readonly TextCluster[] | undefined;
    const caretLine: CaretLine = {
        top: line.top, bottom: line.bottom,
        get stops() { return allStops ??= Array.from({ length: length + 1 }, (_, offset) => stop(offset)); },
        get clusters() { return allClusters ??= Array.from({ length }, (_, offset) => cluster(offset)); },
    };
    const hitTest = (x: number): CaretStop => {
        let lo = 0, hi = length;
        while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (xAt(mid) < x) lo = mid + 1; else hi = mid; }
        const after = lo, before = Math.max(0, after - 1);
        return stop(Math.abs(xAt(before) - x) <= Math.abs(xAt(after) - x) ? before : after);
    };
    const result: CaretIndex = {
        paintKey: paint.key,
        lines: [caretLine],
        hitTest: x => hitTest(x),
        caret: position => stop(position.offset),
        clusterAt(x, y) {
            if (y < line.top || y > line.bottom) return null;
            const nearest = hitTest(x).offset;
            for (const offset of [nearest - 1, nearest]) {
                if (offset < 0 || offset >= length) continue;
                const item = cluster(offset), box = item.bounds;
                if (x >= box.x && x <= box.x + box.width) return item;
            }
            return null;
        },
        selection(start, end) {
            if (start > end) [start, end] = [end, start];
            const from = clamp(start), to = clamp(end);
            if (from >= to) return [];
            const left = xAt(from), right = xAt(to);
            return [{ x: Math.min(left, right), y: line.top, width: Math.abs(right - left), height: line.bottom - line.top }];
        },
        characterBounds(start, end) {
            const result: Rect[] = [];
            for (let offset = start; offset < end; offset++) {
                if (offset >= 0 && offset < length) result.push(cluster(offset).bounds);
                else { const point = stop(offset); result.push({ x: point.x, y: point.top, width: 0, height: point.bottom - point.top }); }
            }
            return result;
        },
        navigate(position: CaretPosition, direction) {
            const current = stop(position.offset);
            if (direction === 'line-start') return stop(0);
            if (direction === 'line-end') return stop(length);
            if (direction === 'up' || direction === 'down') return current;
            const delta = direction === 'left' ? -1 : 1;
            let offset = current.offset + delta;
            while (offset >= 0 && offset <= length && Math.abs(xAt(offset) - current.x) < 0.001) offset += delta;
            return offset < 0 || offset > length ? current : stop(offset);
        },
    };
    indices.set(measurer, { paint, text: request.text, epoch: request.fontEpoch, table, index: result });
    return result;
}
