import type { EmphasisCell, EmphasisPoint } from './composite';

export interface GlyphFrame {
    origin: EmphasisPoint;
    /** Full font-em-to-page linear transform: [a,b,c,d], including font size once. */
    basis: readonly [number, number, number, number];
    ascent: number;
    descent: number;
}

/** Construct a single native glyph cell without flattening rotation or shear. */
export function emphasisGlyphCell(frame: GlyphFrame, nextOrigin: EmphasisPoint | null,
    lastInkCorners?: readonly EmphasisPoint[]): EmphasisCell | null {
    const { origin, basis: [a, b, c, d], ascent, descent } = frame;
    if (![origin.x, origin.y, a, b, c, d, ascent, descent].every(Number.isFinite) || ascent <= descent) return null;
    const det = a * d - b * c, norm = Math.max(Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d));
    if (!Number.isFinite(det) || norm === 0 || Math.abs(det) <= 1e-10 * norm * norm) return null;
    const project = (point: EmphasisPoint): EmphasisPoint => {
        const x = point.x - origin.x, y = point.y - origin.y;
        return { x: (d * x - c * y) / det, y: (-b * x + a * y) / det };
    };
    let advance: number;
    if (nextOrigin) {
        const next = project(nextOrigin);
        if (!Number.isFinite(next.x) || !Number.isFinite(next.y) || Math.abs(next.y) > 0.2) return null;
        advance = next.x;
    } else {
        if (!lastInkCorners?.length) return null;
        const projected = lastInkCorners.map(project);
        if (projected.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;
        advance = Math.max(...projected.map(p => p.x));
    }
    if (!Number.isFinite(advance) || advance <= 0) return null;
    const point = (x: number, y: number): EmphasisPoint => ({ x: origin.x + a * x + c * y, y: origin.y + b * x + d * y });
    const cell: EmphasisCell = [point(0, descent), point(advance, descent), point(advance, ascent), point(0, ascent)];
    return cell.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)) ? cell : null;
}
