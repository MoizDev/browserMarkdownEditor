import type { BoardDoc } from './model/doc';
import type { NodeId } from './model/ids';
import { SpatialQuery } from './scene/query';
import type { SpatialQuerySource, QueryStatus } from './scene/query';
import { selectableAtFocus, SelectionState } from './selection';
import type { Vec2 } from './geom/path';

export type Direction = 'left' | 'right' | 'up' | 'down';
export interface NavigationCandidate { readonly id: NodeId; readonly centre: Vec2; readonly rank: number }
export interface NavigationServices {
    readonly source: SpatialQuerySource;
    /** Resolve presented/clipped, layout-ready geometry; never return a paper backdrop. */
    candidate(slot: number, generation: number): NavigationCandidate | null;
    reveal(id: NodeId): void;
}

// The spatial strip supplies an admissible lower bound on centre distance. No
// fixed candidate cap is safe when many nodes overlap the same coordinate.
export class DirectionalSelection {
    private readonly query: SpatialQuery;
    private readonly before: ReturnType<SelectionState['getSnapshot']>;
    private best: NavigationCandidate | null = null;
    private bestDistance = Infinity;
    private settled = false;
    constructor(private readonly doc: BoardDoc, private readonly selection: SelectionState,
        private readonly services: NavigationServices, origin: Vec2, direction: Direction) {
        if (!Number.isFinite(origin.x) || !Number.isFinite(origin.y)) throw new RangeError('Invalid navigation origin');
        this.before = selection.getSnapshot();
        const horizontal = direction === 'left' || direction === 'right', sign = direction === 'left' || direction === 'up' ? -1 : 1;
        this.query = new SpatialQuery().begin(services.source,
            { kind: 'strip', axis: horizontal ? 'x' : 'y', value: horizontal ? origin.x : origin.y },
            (slot, generation) => {
                const c = services.candidate(slot, generation);
                if (!c || c.id === this.before.active || !Number.isFinite(c.centre.x) || !Number.isFinite(c.centre.y)) return undefined;
                const id = selectableAtFocus(doc, c.id, this.before.focus, this.before.sheet);
                if (!id || id !== c.id) return undefined;
                const dx = c.centre.x - origin.x, dy = c.centre.y - origin.y;
                if ((horizontal ? dx : dy) * sign <= 0) return undefined;
                const distance = Math.hypot(dx, dy);
                if (!Number.isFinite(distance)) return undefined;
                if (distance < this.bestDistance || (distance === this.bestDistance && (!this.best || c.rank > this.best.rank || (c.rank === this.best.rank && c.id < this.best.id)))) {
                    this.best = c; this.bestDistance = distance;
                }
                return distance;
            });
    }
    cancel(): void { this.settled = true; this.query.cancel(); }
    step(maxVisits: number): QueryStatus {
        if (this.settled) return this.query.status;
        if (this.selection.getSnapshot() !== this.before) { this.cancel(); return 'cancelled'; }
        const status = this.query.step(maxVisits);
        if (status === 'complete') {
            this.settled = true;
            if (this.best && selectableAtFocus(this.doc, this.best.id, this.before.focus, this.before.sheet) === this.best.id) {
                this.selection.replace([this.best.id]); this.services.reveal(this.best.id);
            }
        } else if (status !== 'pending') this.settled = true;
        return status;
    }
}
