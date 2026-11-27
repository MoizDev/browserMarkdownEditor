import type { Affine, Rect } from '../../../platform/types';
import { inverse, transformPoint } from '../../geom/affine';
import type { TextPaint } from '../paint';
import type { Misspelling } from './menu';

interface ViewSize { readonly width: number; readonly height: number }
export interface VisibleSpellingPath { readonly d: string; readonly strokeWidth: number }

export function spellingAtOffset(ranges: readonly Misspelling[], offset: number, includeEnd = false): Misspelling | null {
    let lo = 0, hi = ranges.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (includeEnd ? ranges[mid].to < offset : ranges[mid].to <= offset) lo = mid + 1; else hi = mid;
    }
    const range = ranges[lo];
    return range && range.from <= offset && (includeEnd ? offset <= range.to : offset < range.to) ? range : null;
}

function visibleSpan(matrix: Affine, viewport: ViewSize, left: number, right: number, y: number): readonly [number, number] | null {
    const pad = 3;
    for (const [slope, origin, limit] of [
        [matrix[0], matrix[2] * y + matrix[4], viewport.width],
        [matrix[1], matrix[3] * y + matrix[5], viewport.height],
    ]) {
        if (Math.abs(slope) < 1e-15) {
            if (origin < -pad || origin > limit + pad) return null;
            continue;
        }
        const a = (-pad - origin) / slope, b = (limit + pad - origin) / slope;
        left = Math.max(left, Math.min(a, b)); right = Math.min(right, Math.max(a, b));
        if (left >= right) return null;
    }
    return Number.isFinite(left) && Number.isFinite(right) ? [left, right] : null;
}

export function* visibleSpellingPaths(paint: TextPaint, ranges: readonly Misspelling[], matrix: Affine, viewport: ViewSize,
    rects: (from: number, to: number) => readonly Rect[]): Generator<VisibleSpellingPath> {
    if (!ranges.length || !paint.lines.length || !(viewport.width > 0 && viewport.height > 0)) return;
    const back = inverse(matrix, 1e12), xScale = Math.hypot(matrix[0], matrix[1]), yScale = Math.hypot(matrix[2], matrix[3]);
    if (!back || !(xScale > 0 && yScale > 0) || !Number.isFinite(xScale) || !Number.isFinite(yScale)) return;
    const corners = [transformPoint(back, { x: 0, y: 0 }), transformPoint(back, { x: viewport.width, y: 0 }),
        transformPoint(back, { x: 0, y: viewport.height }), transformPoint(back, { x: viewport.width, y: viewport.height })];
    const top = Math.min(...corners.map(point => point.y)) - 4 / yScale;
    const bottom = Math.max(...corners.map(point => point.y)) + 4 / yScale;
    let lo = 0, hi = paint.lines.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (paint.lines[mid].bottom < top) lo = mid + 1; else hi = mid; }
    const step = 2 / xScale, amplitude = 1 / yScale, strokeWidth = 1 / Math.sqrt(xScale * yScale);
    for (let lineIndex = lo; lineIndex < paint.lines.length && paint.lines[lineIndex].top <= bottom; lineIndex++) {
        const line = paint.lines[lineIndex];
        if ((line.bottom - line.top) * yScale < 1 || line.src[0] === line.src[1]) continue;
        let first = 0, end = ranges.length;
        while (first < end) { const mid = (first + end) >>> 1; if (ranges[mid].to <= line.src[0]) first = mid + 1; else end = mid; }
        for (let index = first; index < ranges.length && ranges[index].from < line.src[1]; index++) {
            const range = ranges[index], from = Math.max(range.from, line.src[0]), to = Math.min(range.to, line.src[1]);
            if (from >= to) continue;
            for (const box of rects(from, to)) {
                if (box.y + box.height <= line.top || box.y >= line.bottom || box.width * xScale < 1) continue;
                const y = box.y + box.height - amplitude, span = visibleSpan(matrix, viewport, box.x, box.x + box.width, y);
                if (!span) continue;
                const start = Math.max(0, Math.floor((span[0] - box.x) / step)), finish = Math.ceil((span[1] - box.x) / step);
                if (!Number.isSafeInteger(start) || !Number.isSafeInteger(finish)) continue;
                let d = `M ${box.x + start * step} ${y + (start % 2 ? amplitude : -amplitude)}`;
                for (let n = start + 1; n <= finish; n++) {
                    const x = Math.min(box.x + box.width, box.x + n * step);
                    d += ` L ${x} ${y + (n % 2 ? amplitude : -amplitude)}`;
                }
                yield { d, strokeWidth };
            }
        }
    }
}
