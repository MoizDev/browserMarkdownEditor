import { validBox, type Box } from '../geom/bounds';
import type { NodeId } from '../model/ids';
import type { LocalGeometryBounds } from './bounds';

type Build = (signal: AbortSignal) => Promise<LocalGeometryBounds>;
interface Entry { readonly generation: number; readonly bounds: LocalGeometryBounds }
interface Job { readonly controller: AbortController; readonly promise: Promise<LocalGeometryBounds>; waiters: number }

function checkedGeneration(generation: number): void {
    if (!Number.isSafeInteger(generation) || generation < 0) throw new RangeError('Invalid geometry generation');
}
function copyBounds(bounds: LocalGeometryBounds): LocalGeometryBounds {
    const copy = (box: Box): Box => {
        if (!box || box.length !== 4 || !validBox(box)) throw new RangeError('Invalid local geometry bounds');
        return Object.freeze([box[0], box[1], box[2], box[3]]) as Box;
    };
    if (!bounds || typeof bounds !== 'object') throw new RangeError('Invalid local geometry bounds');
    return Object.freeze({ ink: copy(bounds.ink), ...(bounds.hit === undefined ? {} : { hit: copy(bounds.hit) }) });
}

/** Geometry generations are caller-owned; no live document or renderer is retained here. */
export class SceneGeometryCache {
    private readonly entries = new Map<NodeId, Entry>();
    private readonly latest = new Map<NodeId, number>();
    private readonly jobs = new Map<NodeId, Map<number, Job>>();
    private disposed = false;
    private guard(): void { if (this.disposed) throw new Error('Geometry cache is disposed'); }
    private note(id: NodeId, generation: number): void {
        if (generation > (this.latest.get(id) ?? -1)) this.latest.set(id, generation);
    }
    get(id: NodeId, generation: number): LocalGeometryBounds | undefined {
        this.guard(); checkedGeneration(generation);
        const entry = this.entries.get(id);
        return entry?.generation === generation ? entry.bounds : undefined;
    }
    put(id: NodeId, generation: number, bounds: LocalGeometryBounds): void {
        this.guard(); checkedGeneration(generation);
        const value = copyBounds(bounds);
        if (generation < (this.latest.get(id) ?? -1)) return;
        this.note(id, generation);
        this.entries.set(id, { generation, bounds: value });
    }
    private forget(id: NodeId, generation: number, job: Job): void {
        const byGeneration = this.jobs.get(id);
        if (byGeneration?.get(generation) !== job) return;
        byGeneration.delete(generation);
        if (!byGeneration.size) this.jobs.delete(id);
    }
    ensure(id: NodeId, generation: number, signal: AbortSignal, build: Build): Promise<LocalGeometryBounds> {
        this.guard(); checkedGeneration(generation);
        if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('Geometry request cancelled', 'AbortError'));
        this.note(id, generation);
        const cached = this.get(id, generation);
        if (cached) return Promise.resolve(cached);
        let byGeneration = this.jobs.get(id);
        if (!byGeneration) this.jobs.set(id, byGeneration = new Map());
        let job = byGeneration.get(generation);
        if (!job) {
            const controller = new AbortController();
            const created: Job = { controller, waiters: 0, promise: Promise.resolve().then(() => {
                controller.signal.throwIfAborted();
                return build(controller.signal);
            }).then(result => {
                controller.signal.throwIfAborted();
                const bounds = copyBounds(result);
                if (!this.disposed && this.jobs.get(id)?.get(generation) === created && this.latest.get(id) === generation
                    && this.entries.get(id)?.generation !== generation) this.entries.set(id, { generation, bounds });
                return bounds;
            }).finally(() => this.forget(id, generation, created)) };
            byGeneration.set(generation, created); job = created;
        }
        const active = job;
        active.waiters++;
        return new Promise<LocalGeometryBounds>((resolve, reject) => {
            let settled = false;
            const finish = (ok: boolean, result: unknown) => {
                if (settled) return;
                settled = true;
                signal.removeEventListener('abort', callerAbort);
                active.controller.signal.removeEventListener('abort', jobAbort);
                active.waiters--;
                if (!active.waiters) {
                    this.forget(id, generation, active);
                    active.controller.abort();
                }
                if (ok) resolve(result as LocalGeometryBounds); else reject(result);
            };
            const callerAbort = () => finish(false, signal.reason ?? new DOMException('Geometry request cancelled', 'AbortError'));
            const jobAbort = () => finish(false, active.controller.signal.reason ?? new DOMException('Geometry job cancelled', 'AbortError'));
            signal.addEventListener('abort', callerAbort, { once: true });
            active.controller.signal.addEventListener('abort', jobAbort, { once: true });
            active.promise.then(value => finish(true, value), error => finish(false, error));
            if (signal.aborted) callerAbort();
            else if (active.controller.signal.aborted) jobAbort();
        });
    }
    delete(id: NodeId): void {
        this.guard();
        this.entries.delete(id); this.latest.delete(id);
        const jobs = this.jobs.get(id);
        this.jobs.delete(id);
        if (jobs) for (const job of jobs.values()) job.controller.abort();
    }
    clear(): void {
        this.guard();
        this.entries.clear(); this.latest.clear();
        const jobs = [...this.jobs.values()]; this.jobs.clear();
        for (const group of jobs) for (const job of group.values()) job.controller.abort();
    }
    dispose(): void { if (!this.disposed) { this.clear(); this.disposed = true; } }
}
