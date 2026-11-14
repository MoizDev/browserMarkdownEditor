import type { Affine } from '../platform/types';
import type { BoardDoc } from './model/doc';
import type { NodeId, ParentId, SheetId } from './model/ids';
import { selectableAtFocus } from './selection';
import type { NarrowResult } from './geom/types';

export interface SpatialRef { readonly slot: number; readonly generation: number; readonly localToWorld: Affine }
export type SpatialQueryStatus = 'pending' | 'complete' | 'stale' | 'cancelled';
export interface SpatialCursor {
    resume(budget: Readonly<{ deadline: number; maxVisits: number }>, visit: (ref: SpatialRef) => void): SpatialQueryStatus;
    cancel(): void;
}
export interface CandidateHit {
    readonly id: NodeId;
    /** Larger rank is painted later; never a spatial slot number. */
    readonly rank: number;
    readonly result: NarrowResult;
}
export interface NarrowWork {
    /** null means more work remains; false hits must not be published as misses early. */
    step(budget: Readonly<{ deadline: number; maxVisits: number }>): CandidateHit | null;
    cancel(): void;
}
export interface PickServices {
    /** The query's session, revision, camera and font stamp still match. */
    isCurrent(): boolean;
    /** Validate slot generation, sheet, frame clips and visibility before starting narrow phase. */
    begin(ref: SpatialRef): NarrowWork | null;
    /** Higher priority chrome/part precedes body before paint rank. */
    partPriority(part: NarrowResult['part']): number;
}
export interface PickOutcome { readonly status: SpatialQueryStatus; readonly hits: readonly CandidateHit[] }

// A query owns the scene cursor lease until completion/cancellation. It never turns a
// partial traversal into a miss, and a superseded hover can release all its work.
export class SpatialPickJob {
    private readonly pending: NarrowWork[] = [];
    private readonly winners = new Map<NodeId, CandidateHit>();
    private cursorDone = false;
    private nextWork = 0;
    private status: SpatialQueryStatus = 'pending';
    constructor(private readonly cursor: SpatialCursor, private readonly services: PickServices,
        private readonly doc: BoardDoc, private readonly sheet: SheetId, private readonly focus: ParentId,
        private readonly includeLocked = false) { }
    cancel(): void {
        if (this.status !== 'pending') return;
        this.status = 'cancelled'; this.cursor.cancel();
        for (let i = this.nextWork; i < this.pending.length; i++) this.pending[i].cancel();
        this.pending.length = 0; this.winners.clear();
    }
    step(budget: Readonly<{ deadline: number; maxVisits: number }>): PickOutcome {
        if (!Number.isSafeInteger(budget.maxVisits) || budget.maxVisits < 1 || !Number.isFinite(budget.deadline)) throw new RangeError('Invalid query budget');
        if (this.status !== 'pending') return { status: this.status, hits: this.status === 'complete' ? this.ordered() : [] };
        if (!this.services.isCurrent()) { this.cancel(); this.status = 'stale'; return { status: 'stale', hits: [] }; }
        if (!this.cursorDone) {
            const status = this.cursor.resume(budget, ref => {
                const work = this.services.begin(ref);
                if (work) this.pending.push(work);
            });
            if (status === 'stale' || status === 'cancelled') {
                this.cancel(); this.status = status;
                return { status, hits: [] };
            }
            if (status === 'pending') return { status, hits: [] };
            this.cursorDone = true;
        }
        let visits = 0;
        while (this.nextWork < this.pending.length && visits++ < budget.maxVisits && performance.now() < budget.deadline) {
            const work = this.pending[this.nextWork], hit = work.step({ deadline: budget.deadline, maxVisits: 1 });
            if (!hit) break;
            this.nextWork++;
            if (!hit.result.hit) continue;
            const id = selectableAtFocus(this.doc, hit.id, this.focus, this.sheet, this.includeLocked);
            if (!id) continue;
            const candidate = { ...hit, id }, previous = this.winners.get(id);
            if (!previous || this.compare(candidate, previous) < 0) this.winners.set(id, candidate);
        }
        if (this.nextWork === this.pending.length) { this.pending.length = 0; this.status = 'complete'; return { status: 'complete', hits: this.ordered() }; }
        return { status: 'pending', hits: [] };
    }
    private compare(a: CandidateHit, b: CandidateHit): number {
        return this.services.partPriority(b.result.part) - this.services.partPriority(a.result.part) || b.rank - a.rank;
    }
    private ordered(): readonly CandidateHit[] { return [...this.winners.values()].sort((a, b) => this.compare(a, b)); }
}
