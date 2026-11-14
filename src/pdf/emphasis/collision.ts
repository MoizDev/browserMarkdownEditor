import type { Rect } from '../../platform/types';
import type { EmphasisCell } from './composite';

export interface EmphasisInk {
    glyph: number;
    box: Rect;
    /** Conservative page-space extent of that object's stroke expansion. */
    strokeRadius: number;
}

interface IndexedInk { glyph: number; left: number; top: number; right: number; bottom: number }

/** Bounded spatial index: rejecting a word is safer than painting a suffix or overprint. */
export class EmphasisInkIndex {
    private readonly buckets = new Map<string, IndexedInk[]>();
    private readonly cellSize: number;
    private references = 0;

    constructor(ink: readonly EmphasisInk[], deviceScale: number, cellSize = 32) {
        if (!Number.isFinite(deviceScale) || deviceScale <= 0 || !Number.isFinite(cellSize) || cellSize <= 0) {
            throw new RangeError('Invalid emphasis collision scale');
        }
        this.cellSize = cellSize;
        for (const item of ink) {
            const { box, strokeRadius } = item;
            if (![box.x, box.y, box.width, box.height, strokeRadius].every(Number.isFinite) ||
                box.width < 0 || box.height < 0 || strokeRadius < 0) throw new RangeError('Invalid glyph ink bounds');
            const fringe = strokeRadius + 1 / deviceScale;
            const entry = { glyph: item.glyph, left: box.x - fringe, top: box.y - fringe,
                right: box.x + box.width + fringe, bottom: box.y + box.height + fringe };
            this.visit(entry.left, entry.top, entry.right, entry.bottom, (x, y) => {
                if (++this.references > 2_000_000) throw new RangeError('Emphasis collision index exceeds work limit');
                const key = `${x},${y}`, bucket = this.buckets.get(key);
                if (bucket) bucket.push(entry);
                else this.buckets.set(key, [entry]);
            });
        }
    }

    private visit(left: number, top: number, right: number, bottom: number, callback: (x: number, y: number) => void): void {
        const x0 = Math.floor(left / this.cellSize), y0 = Math.floor(top / this.cellSize);
        const x1 = Math.floor(right / this.cellSize), y1 = Math.floor(bottom / this.cellSize);
        if (![x0, y0, x1, y1].every(Number.isSafeInteger)) throw new RangeError('Invalid emphasis collision bounds');
        const count = (x1 - x0 + 1) * (y1 - y0 + 1);
        if (!Number.isSafeInteger(count) || count <= 0 || count > 2_000_000) {
            throw new RangeError('Emphasis collision index exceeds work limit');
        }
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) callback(x, y);
    }

    /** True means a nonselected glyph can contribute pixels inside the selected cell. */
    overlaps(cell: EmphasisCell, selectedGlyphs: ReadonlySet<number>): boolean {
        if (cell.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) throw new RangeError('Invalid emphasis cell');
        const left = Math.min(...cell.map(p => p.x)), top = Math.min(...cell.map(p => p.y));
        const right = Math.max(...cell.map(p => p.x)), bottom = Math.max(...cell.map(p => p.y));
        const seen = new Set<IndexedInk>();
        let collision = false;
        this.visit(left, top, right, bottom, (x, y) => {
            for (const ink of this.buckets.get(`${x},${y}`) ?? []) {
                if (collision || seen.has(ink) || selectedGlyphs.has(ink.glyph)) continue;
                seen.add(ink);
                if (ink.left > right || ink.right < left || ink.top > bottom || ink.bottom < top) continue;
                const corners = [{ x: ink.left, y: ink.top }, { x: ink.right, y: ink.top },
                    { x: ink.right, y: ink.bottom }, { x: ink.left, y: ink.bottom }];
                let separated = false;
                for (let i = 0; i < 4; i++) {
                    const a = cell[i], b = cell[(i + 1) % 4], nx = a.y - b.y, ny = b.x - a.x;
                    const cellProjection = cell.map(p => p.x * nx + p.y * ny);
                    const inkProjection = corners.map(p => p.x * nx + p.y * ny);
                    if (Math.max(...cellProjection) < Math.min(...inkProjection) || Math.max(...inkProjection) < Math.min(...cellProjection)) {
                        separated = true;
                        break;
                    }
                }
                if (!separated) collision = true;
            }
        });
        return collision;
    }
}
