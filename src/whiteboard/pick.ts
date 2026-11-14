import type { Affine } from '../platform/types';
import type { BoardDoc } from './model/doc';
import type { NodeId, ParentId, SheetId } from './model/ids';
import { selectableAtFocus } from './selection';
import type { NarrowResult } from './geom/types';
import { SpatialQuery } from './scene/query';
import type { QueryRequest, SpatialQuerySource } from './scene/query';

export interface SpatialRef { readonly slot: number; readonly generation: number; readonly localToWorld: Affine }
export type SpatialQueryStatus = 'pending' | 'complete' | 'stale' | 'cancelled';
export interface SpatialCursor {
    resume(budget: Readonly<{ deadline: number; maxVisits: number }>, visit: (ref: SpatialRef) => void): SpatialQueryStatus;
    cancel(): void;
}
// The scene owns the only index; provisional candidates may be narrowed progressively,
// but they cannot be committed until the whole stamped traversal completes.
export class SceneCursorAdapter implements SpatialCursor {
    private readonly query: SpatialQuery;
    private readonly sceneEpoch: number;
    private readonly indexEpoch: number;
    private emitted = 0;
    private cancelled = false;
    constructor(private readonly source: SpatialQuerySource, request: QueryRequest,
        private readonly transform: (slot: number, generation: number) => Affine | null) {
        this.sceneEpoch = source.epoch(); this.indexEpoch = source.index.epoch;
        this.query = new SpatialQuery().begin(source, { ...request, order: undefined });
    }
    cancel(): void { this.cancelled = true; this.query.cancel(); }
    resume(budget: Readonly<{ deadline: number; maxVisits: number }>, visit: (ref: SpatialRef) => void): SpatialQueryStatus {
        if (this.cancelled) return 'cancelled';
        if (!Number.isSafeInteger(budget.maxVisits) || budget.maxVisits < 1 || !Number.isFinite(budget.deadline)) throw new RangeError('Invalid spatial cursor budget');
        if (this.source.epoch() !== this.sceneEpoch || this.source.index.epoch !== this.indexEpoch) { this.cancel(); return 'stale'; }
        const buffer = this.query.output;
        if (this.emitted < buffer.length) {
            let visits = 0;
            while (this.emitted < buffer.length && visits++ < budget.maxVisits && performance.now() < budget.deadline) {
                const i = this.emitted++, slot = buffer.slots[i], generation = buffer.generations[i];
                if (!this.source.index.alive(slot) || this.source.index.generation(slot) !== generation) { this.cancel(); return 'stale'; }
                const localToWorld = this.transform(slot, generation);
                if (localToWorld) visit({ slot, generation, localToWorld });
                if (this.cancelled) return 'cancelled';
            }
            return this.query.status === 'complete' && this.emitted === buffer.length ? 'complete' : 'pending';
        }
        if (this.query.status === 'pending') {
            const status = this.query.step(Math.min(64, budget.maxVisits));
            return status === 'complete' && this.emitted < buffer.length ? 'pending' : status;
        }
        return this.query.status;
    }
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

// A top-only sweep cannot expose a provisional winner: a later candidate may
// paint above it. Non-top-only sweeps can highlight each certified hit as it arrives.
export function sweptSelectionCursor(job: SpatialPickJob, topOnly: boolean) {
    return {
        step(budget: Readonly<{ deadline: number; maxVisits: number }>) {
            const outcome = job.step(budget);
            const hits = topOnly ? outcome.status === 'complete' ? outcome.hits.slice(0, 1) : [] : outcome.hits;
            return { status: outcome.status, ids: hits.map(hit => hit.id) };
        },
        cancel() { job.cancel(); },
    };
}

// A query owns the scene cursor lease until completion/cancellation. It never turns a
// partial traversal into a miss, and a superseded hover can release all its work.
export class SpatialPickJob {
    private readonly pending: (NarrowWork | null)[] = [];
    private readonly winners = new Map<NodeId, CandidateHit>();
    private cursorDone = false;
    private nextWork = 0;
    private scanNext = true;
    private status: SpatialQueryStatus = 'pending';
    constructor(private readonly cursor: SpatialCursor, private readonly services: PickServices,
        private readonly doc: BoardDoc, private readonly sheet: SheetId, private readonly focus: ParentId,
        private readonly includeLocked = false) { }
    cancel(): void {
        if (this.status !== 'pending') return;
        this.status = 'cancelled'; this.cursor.cancel();
        for (let i = this.nextWork; i < this.pending.length; i++) this.pending[i]?.cancel();
        this.pending.length = 0; this.winners.clear();
    }
    step(budget: Readonly<{ deadline: number; maxVisits: number }>): PickOutcome {
        if (!Number.isSafeInteger(budget.maxVisits) || budget.maxVisits < 1 || !Number.isFinite(budget.deadline)) throw new RangeError('Invalid query budget');
        if (this.status !== 'pending') return { status: this.status, hits: this.status === 'complete' ? this.ordered() : [] };
        if (!this.services.isCurrent()) { this.cancel(); this.status = 'stale'; return { status: 'stale', hits: [] }; }
        if (!this.cursorDone && (this.scanNext || this.nextWork === this.pending.length)) {
            const status = this.cursor.resume(budget, ref => {
                const work = this.services.begin(ref);
                if (work) this.pending.push(work);
            });
            if (status === 'stale' || status === 'cancelled') {
                this.cancel(); this.status = status;
                return { status, hits: [] };
            }
            this.cursorDone = status === 'complete'; this.scanNext = false;
            if (!this.cursorDone) return { status: 'pending', hits: [] };
        }
        const progress: CandidateHit[] = [];
        let visits = 0;
        while (this.nextWork < this.pending.length && visits++ < budget.maxVisits && performance.now() < budget.deadline) {
            const work = this.pending[this.nextWork]!, hit = work.step({ deadline: budget.deadline, maxVisits: 1 });
            if (!hit) break;
            this.pending[this.nextWork++] = null;
            if (!hit.result.hit) continue;
            const id = selectableAtFocus(this.doc, hit.id, this.focus, this.sheet, this.includeLocked);
            if (!id) continue;
            const candidate = { ...hit, id }, previous = this.winners.get(id);
            if (!previous || this.compare(candidate, previous) < 0) { this.winners.set(id, candidate); progress.push(candidate); }
        }
        this.scanNext = true;
        if (this.nextWork >= 1024 && this.nextWork * 2 >= this.pending.length) { this.pending.splice(0, this.nextWork); this.nextWork = 0; }
        if (this.cursorDone && this.nextWork === this.pending.length) { this.pending.length = 0; this.status = 'complete'; return { status: 'complete', hits: this.ordered() }; }
        return { status: 'pending', hits: progress };
    }
    private compare(a: CandidateHit, b: CandidateHit): number {
        return this.services.partPriority(b.result.part) - this.services.partPriority(a.result.part) || b.rank - a.rank;
    }
    private ordered(): readonly CandidateHit[] { return [...this.winners.values()].sort((a, b) => this.compare(a, b)); }
}
