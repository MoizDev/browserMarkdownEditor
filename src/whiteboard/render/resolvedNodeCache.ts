import type { ByteLease } from '../../platform/render/gfx/api';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { NodeId } from '../model/ids';
import { paintNodeBytes } from './residentBytes';
import type { PaintNode } from './paintStream';

const CHUNK = 64 * 1024;

export class ResolvedNodeCache {
    #variant = '';
    #nodes = new Map<NodeId, { readonly sensitive: boolean; readonly node: PaintNode; readonly bytes: number }>();
    #used = 0;
    #leases: ByteLease[] = [];
    #leased = 0;
    #closed = false;

    constructor(private readonly memory: MemoryAllocator) {}

    get(variant: string, id: NodeId, sensitive: boolean): PaintNode | undefined {
        if (this.#closed || variant !== this.#variant) return undefined;
        const entry = this.#nodes.get(id);
        return entry && entry.sensitive === sensitive ? entry.node : undefined;
    }

    set(variant: string, id: NodeId, sensitive: boolean, node: PaintNode): void {
        if (this.#closed) return;
        if (variant !== this.#variant) { this.#nodes.clear(); this.#used = 0; this.#variant = variant; }
        const bytes = paintNodeBytes(node), old = this.#nodes.get(id);
        const used = this.#used - (old?.bytes ?? 0) + bytes;
        if (used > this.#leased) {
            const lease = this.memory.reserve(Math.max(CHUNK, used - this.#leased), { prefetch: true });
            if (!lease) return;
            this.#leases.push(lease); this.#leased += lease.bytes;
        }
        this.#nodes.delete(id);
        this.#nodes.set(id, { sensitive, node, bytes });
        this.#used = used;
    }

    get chargedBytes(): number { return this.#leased; }

    evict(): number {
        const freed = this.#leased;
        this.#nodes.clear(); this.#used = 0; this.#variant = '';
        const leases = this.#leases.splice(0);
        this.#leased = 0;
        for (const lease of leases) this.memory.release(lease);
        return freed;
    }

    dispose(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#nodes.clear(); this.#used = 0; this.#variant = '';
        const leases = this.#leases.splice(0);
        this.#leased = 0;
        for (const lease of leases) this.memory.release(lease);
    }
}
