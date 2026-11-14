import { OUTSIDE, strongRtl } from './types';
import { pointForCharacter } from './selection';
import type { TextPoint } from './selection';

export interface HitGeometry {
    text: string;
    charU16: Uint32Array;
    loose: Float32Array;
    flags: Uint8Array;
    lines: Uint32Array;
    lineBox: Float32Array;
    lineDir: Float32Array;
    lineBidi: Uint8Array;
    width: number;
    height: number;
}
export interface CharacterHit { charIndex: number; side: 'before' | 'after' }
const GRID = 32;
const grids = new WeakMap<HitGeometry, number[][]>();
function gridFor(g: HitGeometry): number[][] {
    const cached = grids.get(g);
    if (cached) return cached;
    const cells: number[][] = Array.from({ length: GRID * GRID }, () => []);
    if (!(g.width > 0 && g.height > 0)) return cells;
    const cell = (v: number, size: number) => Math.max(0, Math.min(GRID - 1, Math.floor(v / size * GRID)));
    let memberships = 0;
    for (let line = 0; line * 2 + 1 < g.lines.length; line++) {
        const p = line * 4, x0 = cell(g.lineBox[p], g.width), x1 = cell(g.lineBox[p + 2], g.width);
        const y0 = cell(g.lineBox[p + 1], g.height), y1 = cell(g.lineBox[p + 3], g.height);
        memberships += (x1 - x0 + 1) * (y1 - y0 + 1);
        if (memberships > 1_000_000) {
            const fallback: number[][] = Array.from({ length: GRID * GRID }, () => []);
            grids.set(g, fallback);
            return fallback;
        }
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) cells[y * GRID + x].push(line);
    }
    grids.set(g, cells);
    return cells;
}
const boundsProjection = (x0: number, y0: number, x1: number, y1: number, dx: number, dy: number): [number, number] => {
    const values = [x0 * dx + y0 * dy, x0 * dx + y1 * dy, x1 * dx + y0 * dy, x1 * dx + y1 * dy];
    return [Math.min(...values), Math.max(...values)];
};
const distanceTo = (v: number, min: number, max: number) => v < min ? min - v : v > max ? v - max : 0;

/** Point and boxes are in page space; the margin clamps to the line ends. */
export function positionAt(g: HitGeometry, x: number, y: number): CharacterHit | null {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !(g.width > 0 && g.height > 0)) return null;
    const count = Math.floor(g.lines.length / 2);
    if (!count) return null;
    const cx = Math.max(0, Math.min(GRID - 1, Math.floor(x / g.width * GRID)));
    const cy = Math.max(0, Math.min(GRID - 1, Math.floor(y / g.height * GRID)));
    const nearby = gridFor(g)[cy * GRID + cx];
    // A populated cell can contain non-containing boxes; only actual
    // containment is conclusive. Otherwise compare every line by distance.
    const containing = nearby.filter(i => {
        const p = i * 4;
        return x >= g.lineBox[p] && x <= g.lineBox[p + 2] && y >= g.lineBox[p + 1] && y <= g.lineBox[p + 3];
    });
    const candidates = containing.length ? containing : Array.from({ length: count }, (_, i) => i);
    let chosen = -1, bestAcross = Infinity, bestAlong = Infinity;
    for (const i of candidates) {
        const p = i * 4, q = i * 2, dx = g.lineDir[q] || 0, dy = g.lineDir[q + 1] || 0;
        const norm = Math.hypot(dx, dy) || 1, ux = (dx || (dy ? 0 : 1)) / norm, uy = dy / norm;
        const along = boundsProjection(g.lineBox[p], g.lineBox[p + 1], g.lineBox[p + 2], g.lineBox[p + 3], ux, uy);
        const across = boundsProjection(g.lineBox[p], g.lineBox[p + 1], g.lineBox[p + 2], g.lineBox[p + 3], -uy, ux);
        const da = distanceTo(-uy * x + ux * y, across[0], across[1]);
        const dl = distanceTo(ux * x + uy * y, along[0], along[1]);
        if (da < bestAcross || da === bestAcross && dl < bestAlong) { chosen = i; bestAcross = da; bestAlong = dl; }
    }
    if (chosen < 0) return null;
    const q = chosen * 2, dx = g.lineDir[q] || 0, dy = g.lineDir[q + 1] || 0;
    const norm = Math.hypot(dx, dy) || 1, ux = (dx || (dy ? 0 : 1)) / norm, uy = dy / norm;
    const coordinate = ux * x + uy * y, first = g.lines[q], end = Math.min(g.lines[q + 1], g.flags.length);
    let nearest: CharacterHit | null = null, nearestDistance = Infinity;
    for (let i = first; i < end;) {
        const p = i * 4, x0 = g.loose[p], y0 = g.loose[p + 1], x1 = g.loose[p + 2], y1 = g.loose[p + 3];
        if ((g.flags[i] & OUTSIDE) || ![x0, y0, x1, y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) { i++; continue; }
        let last = i + 1;
        while (last < end && !(g.flags[last] & OUTSIDE)) {
            const k = last * 4, a = g.loose[k], b = g.loose[k + 1], c = g.loose[k + 2], d = g.loose[k + 3];
            const same = a === x0 && b === y0 && c === x1 && d === y1;
            const empty = Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c) && Number.isFinite(d) && (c <= a || d <= b);
            if (!same && !empty) break;
            last++;
        }
        const [min, max] = boundsProjection(x0, y0, x1, y1, ux, uy), width = (max - min) / (last - i);
        for (let j = i; j < last; j++) {
            const center = min + (j - i + .5) * width, dist = Math.abs(coordinate - center);
            if (dist < nearestDistance) {
                const cp = g.text.codePointAt(g.charU16[j]) ?? 0;
                const char = cp ? String.fromCodePoint(cp) : '';
                const rtl = strongRtl(cp) || (!/\p{Letter}/u.test(char) && !!g.lineBidi[chosen]);
                const after = coordinate >= center;
                nearestDistance = dist;
                const reverse = rtl !== !!g.lineBidi[chosen];
                nearest = { charIndex: j, side: after !== reverse ? 'after' : 'before' };
            }
        }
        i = last;
    }
    return nearest;
}
export function hitTextPoint(g: HitGeometry, page: number, x: number, y: number): TextPoint | null {
    const hit = positionAt(g, x, y);
    return hit ? pointForCharacter(page, g.charU16, hit.charIndex, hit.side, g.text) : null;
}
/** First and last character indices whose canonical intervals overlap [from,to). */
export function characterRange(charU16: Uint32Array, from: number, to: number): { first: number; end: number } {
    const find = (value: number, upper: boolean) => {
        let lo = 0, hi = charU16.length;
        while (lo < hi) { const mid = (lo + hi) >>> 1; if (charU16[mid] < value || upper && charU16[mid] === value) lo = mid + 1; else hi = mid; }
        return lo;
    };
    const n = Math.max(0, charU16.length - 1);
    return { first: Math.min(n, Math.max(0, find(from, true) - 1)), end: Math.min(n, find(Math.max(from, to), false)) };
}
