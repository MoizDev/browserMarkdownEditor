import type { ByteLease } from '../../platform/render/gfx/api';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { NodeId } from '../model/ids';
import { paintNodeBytes } from './residentBytes';
import type { PaintNode } from './paintStream';

/** Leases are taken a chunk at a time, so the charge follows the resolved set rather than each node. */
const CHUNK = 64 * 1024;

/**
 * One dense plan's resolved paint nodes, shared by its tiles and bands. A node resolves to the same items in every
 * tile of one variant (document revision, sheet, theme, precision, fonts), so the plan resolves it once. The cache
 * charges its bytes to the CPU allocator in chunks and keeps nothing a denied charge would not cover. It is disposed
 * when its plan completes or retires, which releases every chunk.
 */
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
            const lease = this.memory.reserve(Math.max(CHUNK, used - this.#leased));
            if (!lease) return;
            this.#leases.push(lease); this.#leased += lease.bytes;
        }
        this.#nodes.delete(id);
        this.#nodes.set(id, { sensitive, node, bytes });
        this.#used = used;
    }

    /** Drops every resolved node and releases its charge; a disposed cache keeps nothing further. */
    dispose(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#nodes.clear(); this.#used = 0; this.#variant = '';
        const leases = this.#leases.splice(0);
        this.#leased = 0;
        for (const lease of leases) this.memory.release(lease);
    }
}
