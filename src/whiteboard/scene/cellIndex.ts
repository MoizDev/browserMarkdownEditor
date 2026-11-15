import type { Rect } from '../../platform/types';
import type { NodeId } from '../model/ids';
import type { Box } from './bounds';

/** Side of an index cell in world units. Fixed rather than tuned per document: a cell is only a
 * candidate filter, and exact bounds still decide every node, so the choice affects speed only. */
export const CELL_SIDE = 1024;
/** A node covering more cells than this is kept as always-candidate, never partially indexed. */
const MAX_CELLS_PER_NODE = 256;
/** A query covering more cells than this returns every node: conservative, never a miss. */
const MAX_CELLS_PER_QUERY = 4096;

function cover(box: Readonly<Box>): readonly [number, number, number, number] | null {
    const [x0, y0, x1, y1] = box;
    if (![x0, y0, x1, y1].every(Number.isFinite) || x1 < x0 || y1 < y0) return null;
    const cx0 = Math.floor(x0 / CELL_SIDE), cy0 = Math.floor(y0 / CELL_SIDE);
    const cx1 = Math.floor(x1 / CELL_SIDE), cy1 = Math.floor(y1 / CELL_SIDE);
    if (![cx0, cy0, cx1, cy1].every(Number.isSafeInteger)) return null;
    if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > MAX_CELLS_PER_NODE) return null;
    return [cx0, cy0, cx1, cy1];
}
const key = (cx: number, cy: number) => `${cx},${cy}`;

/** A sheet's ordered cell index, built once per pinned revision in canonical preorder.
 * Ordinals (positions in `ids`) ascend within every list, so a query merges sorted lists.
 * Nodes without a usable bound are always candidates, which keeps every query conservative. */
export class SceneCellIndex {
    /** Ordinal to node id, in canonical preorder. */
    readonly ids: NodeId[] = [];
    private readonly cells = new Map<string, number[]>();
    private readonly always: number[] = [];
    private closed = false;

    /** Adds the next node in canonical preorder; `box` is its usable ink bound, if any. */
    add(id: NodeId, box: Readonly<Box> | null): void {
        if (this.closed) throw new Error('Scene cell index is closed');
        const ordinal = this.ids.length;
        this.ids.push(id);
        const range = box ? cover(box) : null;
        if (!range) { this.always.push(ordinal); return; }
        const [cx0, cy0, cx1, cy1] = range;
        for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
            const cell = key(cx, cy);
            const list = this.cells.get(cell);
            if (list) list.push(ordinal); else this.cells.set(cell, [ordinal]);
        }
    }
    /** Every ordinal whose bound may meet `world`, ascending. Absent world means the whole sheet. */
    candidates(world: Readonly<Rect> | undefined): number[] {
        if (this.closed) throw new Error('Scene cell index is closed');
        const all = (): number[] => Array.from({ length: this.ids.length }, (_, ordinal) => ordinal);
        if (!world) return all();
        const x0 = Math.floor(world.x / CELL_SIDE), y0 = Math.floor(world.y / CELL_SIDE);
        const x1 = Math.floor((world.x + world.width) / CELL_SIDE), y1 = Math.floor((world.y + world.height) / CELL_SIDE);
        if (![x0, y0, x1, y1].every(Number.isSafeInteger) || (x1 - x0 + 1) * (y1 - y0 + 1) > MAX_CELLS_PER_QUERY) return all();
        const merged = [...this.always];
        for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
            const list = this.cells.get(key(cx, cy));
            if (list) for (const ordinal of list) merged.push(ordinal);
        }
        merged.sort((a, b) => a - b);
        let write = 0;
        for (let read = 0; read < merged.length; read++) {
            if (write === 0 || merged[write - 1] !== merged[read]) merged[write++] = merged[read];
        }
        merged.length = write;
        return merged;
    }
    /** Upper bound on `candidates(world).length`, read from list lengths without merging: a node
     * spanning k cells is counted k times. Cheap enough to run before every frame. */
    countCandidates(world: Readonly<Rect>): number {
        if (this.closed) throw new Error('Scene cell index is closed');
        const x0 = Math.floor(world.x / CELL_SIDE), y0 = Math.floor(world.y / CELL_SIDE);
        const x1 = Math.floor((world.x + world.width) / CELL_SIDE), y1 = Math.floor((world.y + world.height) / CELL_SIDE);
        if (![x0, y0, x1, y1].every(Number.isSafeInteger) || (x1 - x0 + 1) * (y1 - y0 + 1) > MAX_CELLS_PER_QUERY) return this.ids.length;
        let count = this.always.length;
        for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) count += this.cells.get(key(cx, cy))?.length ?? 0;
        return count;
    }
    /** Occupied cells, for coarse summaries; an always-candidate node is not a cell. */
    get occupiedCells(): number { return this.cells.size; }
    get alwaysCandidates(): number { return this.always.length; }
    close(): void {
        if (this.closed) return;
        this.closed = true; this.ids.length = 0; this.cells.clear(); this.always.length = 0;
    }
}
