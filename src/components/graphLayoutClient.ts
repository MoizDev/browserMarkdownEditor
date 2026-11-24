import { createWorkerClient } from '../platform/workers';
import type { WorkerClient } from '../platform/workers';
import { GraphLayout } from '../utils/graphLayout';
import type { GraphLink } from '../types';
import { graphReheat, graphTopology, graphTopologySignature, parseGraphTopology } from '../utils/graphLayoutStore';
import type { GraphTopology, StoredGraphLayout } from '../utils/graphLayoutStore';

export interface GraphFrame {
    gen: number; frame: number; buffer: Float64Array<ArrayBuffer>; alpha: number; steps: number;
    moved: boolean; working: boolean; stepMs: number;
}
let nextClient = 0;

/** Main-thread positions are the last displayed snapshot, never the simulation. */
export class GraphLayoutClient extends GraphLayout {
    private client: WorkerClient;
    private links: GraphLink[] = [];
    private gen = 0;
    private frame = 0;
    private buffer = new Float64Array(0);
    private reheat = 0;
    private disposed = false;
    private ticking = false;
    private topology: GraphTopology | null;
    private initial: StoredGraphLayout | undefined;

    constructor(initial?: StoredGraphLayout) {
        super();
        this.initial = initial;
        this.topology = initial ? parseGraphTopology(initial.topologySignature) : null;
        this.client = createWorkerClient({
            name: `graph-layout-${++nextClient}`,
            protocol: 1,
            spawn: () => new Worker(new URL('./graphLayout.worker.ts', import.meta.url), { type: 'module' }),
            onStart: async client => {
                const positions = new Float64Array(this.ids.length * 2);
                for (let i = 0; i < this.ids.length; i++) { positions[2 * i] = this.x[i]; positions[2 * i + 1] = this.y[i]; }
                await client.request('topology', { gen: this.gen, ids: this.ids, links: this.links, positions, alpha: this.alpha },
                    { priority: 1, transfer: [positions.buffer] });
            },
        });
    }

    override update(ids: readonly string[], links: readonly GraphLink[]): void {
        const previousIds = new Set(this.ids);
        const saved = new Map(this.initial?.positions.map(p => [p.path, p]) ?? []);
        const next = graphTopology(ids, links);
        const heat = graphReheat(this.topology, next);
        const oldAlpha = this.alpha;
        super.update(ids, links);
        const positions = new Float64Array(ids.length * 2);
        positions.fill(NaN);
        const placed = new Set(previousIds);
        for (let i = 0; i < ids.length; i++) {
            const point = saved.get(ids[i]);
            if (!previousIds.has(ids[i]) && point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
                this.x[i] = point.x; this.y[i] = point.y; placed.add(ids[i]);
                positions[i * 2] = point.x; positions[i * 2 + 1] = point.y;
            }
        }
        const neighbours = new Map<string, string[]>();
        for (const link of links) {
            if (!neighbours.has(link.source)) neighbours.set(link.source, []);
            if (!neighbours.has(link.target)) neighbours.set(link.target, []);
            neighbours.get(link.source)!.push(link.target); neighbours.get(link.target)!.push(link.source);
        }
        for (let i = 0; i < ids.length; i++) {
            if (placed.has(ids[i])) continue;
            let x = 0, y = 0, count = 0;
            for (const id of neighbours.get(ids[i]) ?? []) {
                const j = this.index.get(id);
                if (j !== undefined && placed.has(id)) { x += this.x[j]; y += this.y[j]; count++; }
            }
            if (count) { this.x[i] = x / count + this.x[i] * 0.1; this.y[i] = y / count + this.y[i] * 0.1; }
            positions[i * 2] = this.x[i]; positions[i * 2 + 1] = this.y[i];
            placed.add(ids[i]);
        }
        this.alpha = this.topology && heat === 0 ? (previousIds.size ? oldAlpha : this.initial?.alpha ?? 0) : heat;
        this.topology = next; this.initial = undefined; this.links = [...links];
        const gen = ++this.gen;
        void this.client.request('topology', { gen, ids: this.ids, links: this.links, positions, alpha: this.alpha },
            { priority: 1, transfer: [positions.buffer] }).catch(() => {});
    }

    snapshot(): StoredGraphLayout {
        return { positions: this.ids.map((path, i) => ({ path, x: this.x[i], y: this.y[i] })),
            topologySignature: graphTopologySignature(this.topology ?? graphTopology([], [])), alpha: this.alpha };
    }

    get failed(): boolean { return this.client.state === 'failed'; }

    wake(alpha: number): void {
        if (this.failed) this.client.reset();
        this.alpha = Math.max(this.alpha, alpha); this.reheat = Math.max(this.reheat, alpha);
    }

    async tick(pin: { id: string; x: number; y: number } | null): Promise<GraphFrame | null> {
        if (this.disposed || this.ticking) return null;
        this.ticking = true;
        const gen = this.gen;
        if (this.buffer.length !== this.ids.length * 2) this.buffer = new Float64Array(this.ids.length * 2);
        const buffer = this.buffer;
        const reheat = this.reheat; this.reheat = 0;
        try {
            const result = await this.client.request<GraphFrame>('tick', { gen, frame: ++this.frame, buffer, pin, reheat },
                { priority: 1, transfer: [buffer.buffer] });
            this.buffer = result.buffer;
            if (this.disposed || gen !== this.gen || result.gen !== this.gen) return null;
            this.alpha = result.alpha;
            for (let i = 0; i < this.ids.length; i++) {
                this.x[i] = result.buffer[2 * i]; this.y[i] = result.buffer[2 * i + 1];
            }
            return result;
        } catch {
            // The host respawns from the latest displayed coordinates. A detached
            // transfer buffer from the dead worker cannot be reused.
            this.buffer = new Float64Array(0);
            this.reheat = Math.max(this.reheat, reheat);
            return null;
        } finally {
            this.ticking = false;
        }
    }

    dispose(): void { this.disposed = true; this.client.dispose(); }
}
