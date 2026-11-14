import type { Rect } from '../../platform/types';
import type { ReferenceMeasurer } from './measure';
import type { CaretIndex, CaretLine, CaretPosition, CaretStop, Face, FaceTable, PaintFragment, TextCluster, TextLayoutRequest, TextPaint } from './paint';

interface Part {
    readonly fragment: PaintFragment;
    readonly face: Face;
    readonly from: number;
    readonly to: number;
    readonly firstStop: number;
    readonly endStop: number;
}
interface CachedIndex {
    readonly paint: TextPaint;
    readonly text: TextLayoutRequest['text'];
    readonly epoch: number;
    readonly table: FaceTable;
    readonly index: CaretIndex;
}
const indices = new WeakMap<ReferenceMeasurer, CachedIndex>();
export function clearLongAsciiCaretIndex(measurer: ReferenceMeasurer): void { indices.delete(measurer); }

/** Exact canvas-prefix queries over long LTR ASCII without allocating one measured prefix per character. */
export function longAsciiCaretIndex(request: TextLayoutRequest, paint: TextPaint, table: FaceTable, measurer: ReferenceMeasurer): CaretIndex | null {
    const cached = indices.get(measurer);
    if (cached && cached.paint === paint && cached.text === request.text && cached.epoch === request.fontEpoch && cached.table === table) return cached.index;
    if (paint.lines.length !== 1 || request.text.blocks.length !== 1) return null;
    const line = paint.lines[0], block = request.text.blocks[0];
    if (line.direction !== 'ltr' || line.src[0] !== 0) return null;
    let length = 0;
    for (const run of block.runs) {
        if (!/^[\x20-\x7e]*$/u.test(run.text)) return null;
        length += run.text.length;
    }
    if (length < 8192 || line.src[1] !== length || line.fragments.length > 8192) return null;
    const parts: Part[] = [];
    let source = 0, nextStop = 0, previousRight = -Infinity;
    for (const fragment of line.fragments) {
        if (fragment.src[0] === fragment.src[1]) continue;
        const face = table.faces[fragment.face], count = fragment.src[1] - fragment.src[0];
        if (!face || fragment.rtl || !(face.size > 0) || !(fragment.width > 0) || fragment.x < previousRight
            || fragment.src[0] !== source || count !== fragment.text.length || !/^[\x20-\x7e]+$/u.test(fragment.text)) return null;
        const firstStop = nextStop, endStop = firstStop + count;
        parts.push({ fragment, face, from: source, to: source + count, firstStop, endStop });
        nextStop = endStop + 1; source += count; previousRight = fragment.x + fragment.width;
    }
    if (!parts.length || source !== length || parts.length > 4096) return null;
    const positions = new Map<number, number>();
    const partAtStop = (ordinal: number): Part => {
        let lo = 0, hi = parts.length;
        while (lo < hi) { const mid = (lo + hi) >>> 1; if (parts[mid].endStop < ordinal) lo = mid + 1; else hi = mid; }
        return parts[Math.min(lo, parts.length - 1)];
    };
    const partAtCharacter = (offset: number): Part => {
        let lo = 0, hi = parts.length;
        while (lo < hi) { const mid = (lo + hi) >>> 1; if (parts[mid].to <= offset) lo = mid + 1; else hi = mid; }
        return parts[Math.min(lo, parts.length - 1)];
    };
    const xAt = (ordinal: number): number => {
        const hit = positions.get(ordinal);
        if (hit !== undefined) { positions.delete(ordinal); positions.set(ordinal, hit); return hit; }
        const part = partAtStop(ordinal), offset = ordinal - part.firstStop;
        const x = part.fragment.x + measurer.measure(part.face, part.fragment.text.slice(0, offset), false, request.fontEpoch).width * part.face.size / 64;
        positions.set(ordinal, x);
        if (positions.size > 2048) positions.delete(positions.keys().next().value!);
        return x;
    };
    const clamp = (offset: number) => Math.max(0, Math.min(length, Number.isFinite(offset) ? Math.round(offset) : 0));
    const stopAt = (ordinal: number): CaretStop => {
        const part = partAtStop(ordinal), local = ordinal - part.firstStop;
        return { offset: part.from + local, affinity: local === 0 ? 'downstream' : 'upstream',
            x: xAt(ordinal), top: line.top, bottom: line.bottom, line: 0 };
    };
    const stopOrdinals = (offset: number): readonly number[] => {
        const point = clamp(offset), part = partAtCharacter(Math.min(point, length - 1));
        if (point === part.from && part.firstStop > 0) return [part.firstStop - 1, part.firstStop];
        return [part.firstStop + point - part.from];
    };
    const caret = (position: CaretPosition): CaretStop => {
        const choices = stopOrdinals(position.offset).map(stopAt);
        return position.affinity ? choices.find(stop => stop.affinity === position.affinity) ?? choices[0] : choices[0];
    };
    const cluster = (offset: number): TextCluster => {
        const part = partAtCharacter(offset), ordinal = part.firstStop + offset - part.from;
        const left = xAt(ordinal), right = xAt(ordinal + 1);
        return { src: [offset, offset + 1], bounds: { x: Math.min(left, right), y: line.top, width: Math.abs(right - left), height: line.bottom - line.top }, rtl: false, line: 0 };
    };
    let allStops: readonly CaretStop[] | undefined, allClusters: readonly TextCluster[] | undefined;
    const caretLine: CaretLine = {
        top: line.top, bottom: line.bottom,
        get stops() { return allStops ??= Array.from({ length: nextStop }, (_, ordinal) => stopAt(ordinal)); },
        get clusters() { return allClusters ??= Array.from({ length }, (_, offset) => cluster(offset)); },
    };
    const hitTest = (x: number): CaretStop => {
        let lo = 0, hi = nextStop - 1;
        while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (xAt(mid) < x) lo = mid + 1; else hi = mid; }
        const after = lo, before = Math.max(0, after - 1);
        return stopAt(Math.abs(xAt(before) - x) <= Math.abs(xAt(after) - x) ? before : after);
    };
    const result: CaretIndex = {
        paintKey: paint.key,
        lines: [caretLine],
        hitTest: x => hitTest(x),
        caret,
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
            const from = clamp(start), to = clamp(end), result: Rect[] = [];
            if (from >= to) return result;
            let index = parts.indexOf(partAtCharacter(from));
            for (; index < parts.length && parts[index].from < to; index++) {
                const part = parts[index], a = Math.max(from, part.from), b = Math.min(to, part.to);
                if (a >= b) continue;
                const left = xAt(part.firstStop + a - part.from), right = xAt(part.firstStop + b - part.from);
                const rect = { x: Math.min(left, right), y: line.top, width: Math.abs(right - left), height: line.bottom - line.top };
                const previous = result[result.length - 1];
                if (previous && rect.x <= previous.x + previous.width + 0.001)
                    previous.width = Math.max(previous.x + previous.width, rect.x + rect.width) - previous.x;
                else result.push(rect);
            }
            return result;
        },
        characterBounds(start, end) {
            const result: Rect[] = [];
            for (let offset = start; offset < end; offset++) {
                if (offset >= 0 && offset < length) result.push(cluster(offset).bounds);
                else { const point = caret({ offset }); result.push({ x: point.x, y: point.top, width: 0, height: point.bottom - point.top }); }
            }
            return result;
        },
        navigate(position: CaretPosition, direction) {
            const current = caret(position);
            if (direction === 'line-start') return stopAt(0);
            if (direction === 'line-end') return stopAt(nextStop - 1);
            if (direction === 'up' || direction === 'down') return current;
            const delta = direction === 'left' ? -1 : 1;
            const choices = stopOrdinals(current.offset);
            let ordinal = choices.find(value => {
                const candidate = stopAt(value);
                return candidate.affinity === current.affinity && candidate.x === current.x;
            }) ?? choices[0];
            ordinal += delta;
            while (ordinal >= 0 && ordinal < nextStop && Math.abs(xAt(ordinal) - current.x) < 0.001) ordinal += delta;
            return ordinal < 0 || ordinal >= nextStop ? current : stopAt(ordinal);
        },
    };
    indices.set(measurer, { paint, text: request.text, epoch: request.fontEpoch, table, index: result });
    return result;
}
