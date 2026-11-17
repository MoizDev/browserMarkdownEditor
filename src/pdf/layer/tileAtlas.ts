import type { GfxDevice, TextureHandle } from '../../platform/render';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';

/** The page edge in texels: 2048 is the largest 2D texture every WebGL2 device must offer, and the device's own limit
 * wins when it is smaller. */
export const ATLAS_PAGE_EDGE = 2048;
/** The largest tile texture: the 512 interior plus the one-texel gutter on each side. Every tile of the layer fits a slot. */
export const ATLAS_SLOT_EDGE = 514;
/** Slots start 2 texels apart, so a linear sample at a tile's edge reads its own gutter and never a neighbour's texels. */
export const ATLAS_SLOT_PITCH = 516;

export interface AtlasPage<T> {
    readonly id: number;
    readonly device: GfxDevice;
    readonly handle: TextureHandle;
    readonly bytes: number;
    readonly perRow: number;
    /** The owner of each slot, or null while the slot is free. */
    readonly owners: (T | null)[];
    occupied: number;
    lastUsed: number;
}

export interface AtlasSlot<T> {
    readonly page: AtlasPage<T>;
    readonly index: number;
    /** The slot's top-left texel on its page. */
    readonly x: number;
    readonly y: number;
}

/**
 * Tile textures packed into shared rgba8 pages, one slot per tile. A frame then draws each page once rather than each
 * tile (see the draw path in tileLayer): a page is one texture binding. A page is charged to the governor as a whole.
 * One empty page is kept as a spare so a zoom that empties and refills a page does not create it again; a second empty
 * page is destroyed. `unlink` is called for every owner whose slot disappears without the owner releasing it.
 */
export class TileAtlas<T> {
    private readonly pages: AtlasPage<T>[] = [];
    private spare: AtlasPage<T> | null = null;
    private nextId = 0;
    private clock = 0;
    private held = 0;

    constructor(private readonly allocator: MemoryAllocator, private readonly unlink: (owner: T) => void) {}

    /** Bytes charged for every page, live or spare. */
    bytes(): number { return this.held; }

    /**
     * A slot for `owner`, on a page of `device`. A refused new page first asks `reclaim` to free room (it returns whether
     * it freed any); null when there is still no room, and the caller waits for governor capacity.
     */
    place(device: GfxDevice, owner: T, reclaim: () => boolean): AtlasSlot<T> | null {
        let page = this.acquirePage(device);
        if (!page && reclaim()) page = this.acquirePage(device);
        return page ? this.take(page, owner) : null;
    }

    /** Gives a slot back. A page that empties is retired to the spare position, or destroyed when the spare is taken. */
    free(slot: AtlasSlot<T>): void {
        const { page } = slot;
        if (page.owners[slot.index] === null) return;
        page.owners[slot.index] = null;
        page.occupied--;
        if (page.occupied === 0) this.retire(page);
    }

    touch(slot: AtlasSlot<T>): void {
        slot.page.lastUsed = ++this.clock;
    }

    /** Destroys the spare page, if any: the first thing pressure gives back, since it holds no pixels. */
    dropSpare(): number {
        const page = this.spare;
        if (!page) return 0;
        this.spare = null;
        this.destroy(page);
        return page.bytes;
    }

    /**
     * Destroys whole pages, least recently used first, while their owners are all `evictable`, until `bytes` are freed.
     * A page with any owner the predicate refuses stays: its pixels are still on screen or cannot be restored.
     */
    evictPages(bytes: number, evictable: (owner: T) => boolean): number {
        const candidates = this.pages.filter(page => page.owners.every(owner => owner === null || evictable(owner)))
            .sort((a, b) => a.lastUsed - b.lastUsed);
        let freed = 0;
        for (const page of candidates) {
            if (freed >= bytes) break;
            this.pages.splice(this.pages.indexOf(page), 1);
            this.release(page);
            freed += page.bytes;
        }
        return freed;
    }

    /** Drops every page of another device (a device change). Their owners lose their slots, and they are re-uploaded. */
    dropForeign(device: GfxDevice): void {
        for (let index = this.pages.length - 1; index >= 0; index--) {
            const page = this.pages[index];
            if (page.device === device) continue;
            this.pages.splice(index, 1);
            this.release(page);
        }
        if (this.spare && this.spare.device !== device) {
            const spare = this.spare;
            this.spare = null;
            this.release(spare);
        }
    }

    /** Every page goes. A lost device's pages are only forgotten: its handles are no longer valid to destroy. */
    clear(lost: boolean): void {
        for (const page of this.pages.splice(0)) this.release(page, lost);
        if (this.spare) {
            const spare = this.spare;
            this.spare = null;
            this.release(spare, lost);
        }
    }

    private acquirePage(device: GfxDevice): AtlasPage<T> | null {
        for (let index = this.pages.length - 1; index >= 0; index--) {
            const page = this.pages[index];
            if (page.device === device && page.occupied < page.owners.length) return page;
        }
        if (this.spare?.device === device) {
            const page = this.spare;
            this.spare = null;
            this.pages.push(page);
            return page;
        }
        const page = this.createPage(device);
        if (page) this.pages.push(page);
        return page;
    }

    private createPage(device: GfxDevice): AtlasPage<T> | null {
        const edge = Math.min(ATLAS_PAGE_EDGE, device.limits.maxTexture2D);
        const perRow = Math.floor(edge / ATLAS_SLOT_PITCH);
        if (perRow < 1) throw new RangeError('PDF tile atlas: the device texture limit holds no slot');
        const bytes = edge * edge * 4;
        const lease = this.allocator.reserve(bytes);
        if (!lease) return null;
        let handle: TextureHandle;
        try { handle = device.createTexture(edge, edge, 'rgba8', ['sample', 'copy-dst'], lease); }
        catch (error) { this.allocator.release(lease); throw error; }
        this.held += bytes;
        return { id: ++this.nextId, device, handle, bytes, perRow, owners: new Array<T | null>(perRow * perRow).fill(null),
            occupied: 0, lastUsed: ++this.clock };
    }

    private take(page: AtlasPage<T>, owner: T): AtlasSlot<T> {
        const index = page.owners.indexOf(null);
        page.owners[index] = owner;
        page.occupied++;
        page.lastUsed = ++this.clock;
        const column = index % page.perRow, row = Math.floor(index / page.perRow);
        return { page, index, x: column * ATLAS_SLOT_PITCH, y: row * ATLAS_SLOT_PITCH };
    }

    private retire(page: AtlasPage<T>): void {
        const at = this.pages.indexOf(page);
        if (at >= 0) this.pages.splice(at, 1);
        if (!this.spare) { this.spare = page; return; }
        this.release(page);
    }

    /** A page leaves the atlas for good: its owners lose their slots, then its texture goes (unless the device was lost). */
    private release(page: AtlasPage<T>, lost = false): void {
        for (const owner of page.owners) if (owner !== null) this.unlink(owner);
        page.owners.fill(null);
        page.occupied = 0;
        this.destroy(page, lost);
    }

    private destroy(page: AtlasPage<T>, lost = false): void {
        this.held -= page.bytes;
        if (!lost) page.device.destroy(page.handle);
    }
}
