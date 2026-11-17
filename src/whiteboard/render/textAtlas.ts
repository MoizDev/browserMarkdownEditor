import type { ByteLease, GfxDevice, TextureFormat, TextureHandle } from '../../platform/render/gfx/api';
import { auditCount } from '../../platform/render/renderAudit';
import { copyIdentity, identityHash, sameIdentity, type MaskIdentity } from './gpu/textMasks';

// The board text atlas (solo/whiteboard-text-atlas.md): pages of run mask cells, a shelf packer per page, LRU by page and
// pins held by the runs that draw from it. Two atlases share this code: R8 for mono coverage masks, RGBA for runs with
// colour glyphs. Built from b2's step-1 module (ba1f43fc); the decision after step 2 dropped the quantised bands, so an
// entry is keyed by its cell's exact identity (textMasks.ts) and nothing here quantises. Keys are numbers: the identity's
// hash finds the bucket and an exact field compare confirms it, so a lookup builds no string and allocates nothing.

/** Pages are square and fixed; a mask cell wider or taller than a page is never placed whole. */
export const ATLAS_PAGE = 2048;
/** Shelves are rounded to whole 8 px rows, so a row of masks shares one height and the packer stays a few integers. */
export const SHELF_STEP = 8;

/** A value an index holds by identity: its own copy of the identity, and that identity's hash. */
export interface Indexed { readonly identity: MaskIdentity; readonly hash: number }
/** Values by exact identity, in buckets by numeric hash. Holds no strings. `values` copies, so a sweep may delete as it goes. */
export class IdentityIndex<V extends Indexed> {
    private readonly buckets = new Map<number, V[]>();
    private count = 0;
    get size(): number { return this.count; }
    find(probe: MaskIdentity): V | undefined {
        const bucket = this.buckets.get(identityHash(probe));
        if (bucket) for (const value of bucket) if (sameIdentity(value.identity, probe)) return value;
        return undefined;
    }
    add(value: V): void {
        const bucket = this.buckets.get(value.hash);
        if (bucket) bucket.push(value); else this.buckets.set(value.hash, [value]);
        this.count++;
    }
    delete(value: V): void {
        const bucket = this.buckets.get(value.hash);
        if (!bucket) return;
        const at = bucket.indexOf(value);
        if (at < 0) return;
        bucket.splice(at, 1); this.count--;
        if (bucket.length === 0) this.buckets.delete(value.hash);
    }
    clear(): void { this.buckets.clear(); this.count = 0; }
    values(): V[] {
        const all: V[] = [];
        for (const bucket of this.buckets.values()) for (const value of bucket) all.push(value);
        return all;
    }
}

/** Left to right within a shelf, and a new shelf below the last when the row is full. Pure bookkeeping. */
export class ShelfPacker {
    private readonly shelves: { y: number; height: number; x: number }[] = [];
    private used = 0;
    constructor(readonly width: number, readonly height: number) {}
    /** A slot for a w x h mask, or null when no shelf and no new row fits. Heights are rounded up to SHELF_STEP. */
    place(w: number, h: number): { x: number; y: number } | null {
        if (w <= 0 || h <= 0 || w > this.width || h > this.height) return null;
        const rowHeight = Math.ceil(h / SHELF_STEP) * SHELF_STEP;
        for (const shelf of this.shelves) {
            if (shelf.height >= rowHeight && shelf.x + w <= this.width) {
                const at = { x: shelf.x, y: shelf.y };
                shelf.x += w;
                return at;
            }
        }
        if (this.used + rowHeight > this.height) return null;
        const shelf = { y: this.used, height: rowHeight, x: w };
        this.shelves.push(shelf);
        this.used += rowHeight;
        return { x: 0, y: shelf.y };
    }
}

/** A placed mask cell. `pinned` counts runs that draw it. `dropped` is set once it has left the atlas for good. */
export interface AtlasEntry extends Indexed {
    readonly page: AtlasPage;
    /** Top-left of the cell's pixels inside the page, in page px. */
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
    pinned: number;
    /** Set when a font change retires the entry: no lookup finds it, its space frees when its last pin drops. */
    retired: boolean;
    dropped: boolean;
}

/** One GPU page: a texture from the layer's grant, its packer and the entries placed on it. */
export class AtlasPage {
    readonly packer: ShelfPacker;
    readonly entries = new Set<AtlasEntry>();
    /** Runs that pin an entry on this page, counted at pin time. Kept here so an eviction test is O(1), not a scan of the page. */
    pinned = 0;
    /** The newest frame that drew any entry on the page: the LRU clock of the page. */
    touched = -1;
    /** Set when the atlas is disposed while this page is pinned: its texture is destroyed by the last unpin, never earlier. */
    retiring = false;
    constructor(readonly texture: TextureHandle, readonly lease: ByteLease, readonly format: TextureFormat) {
        this.packer = new ShelfPacker(ATLAS_PAGE, ATLAS_PAGE);
    }
    /** A page may be evicted when nothing on it is pinned and nothing was drawn in the frame being built. */
    evictable(frame: number): boolean { return this.pinned === 0 && this.touched < frame; }
    /** Nothing on the page is pinned: no run's draw still reads it. Recency is not part of this. */
    unpinned(): boolean { return this.pinned === 0; }
    touch(frame: number): void { if (frame > this.touched) this.touched = frame; }
}

/** The layer's grant. The atlas reserves each page's bytes through it and returns them on destruction. */
export interface AtlasHost {
    reserve(bytes: number): ByteLease | null;
    release(lease: ByteLease): void;
}

export interface TextAtlasOptions {
    readonly format: TextureFormat;
    /** Pages allowed at once. The grant may allow fewer: the atlas stops asking when a reserve is refused. */
    readonly maxPages: number;
    /** The audit surface the counters are filed under (the adapter's surface). */
    readonly surface: string;
}

/** Keyed entries on shelf-packed pages, LRU eviction of whole pages, and pins held by runs until they retire. */
export class TextAtlas {
    private readonly index = new IdentityIndex<AtlasEntry>();
    private readonly pages: AtlasPage[] = [];
    private disposed = false;
    constructor(private readonly device: GfxDevice, private readonly host: AtlasHost, private readonly options: TextAtlasOptions) {}

    get pageCount(): number { return this.pages.length; }
    get bytes(): number { return this.pages.reduce((sum, page) => sum + page.lease.bytes, 0); }

    /** A live entry for the identity, touched to the frame. Counts a hit; a miss is the caller's raster, counted there. */
    lookup(probe: MaskIdentity, frame: number): AtlasEntry | null {
        const entry = this.index.find(probe);
        if (!entry || entry.retired) return null;
        entry.page.touch(frame);
        auditCount(this.options.surface, 'text:mask-hit');
        return entry;
    }

    /** Places a w x h cell under the identity and returns the entry, or 'oversize' when no page can hold it, or 'denied' when
     * the grant refuses a page. The atlas keeps its own copy of the identity. The pixels are written by `upload`; the entry is
     * not drawable before it. */
    place(probe: MaskIdentity, w: number, h: number, frame: number): AtlasEntry | 'oversize' | 'denied' {
        if (this.disposed) return 'denied';
        if (w > ATLAS_PAGE || h > ATLAS_PAGE) return 'oversize';
        const placed = this.findSlot(w, h, frame);
        if (!placed) return 'denied';
        const identity = copyIdentity(probe);
        const entry: AtlasEntry = { identity, hash: identityHash(identity), page: placed.page, x: placed.x, y: placed.y, w, h,
            pinned: 0, retired: false, dropped: false };
        placed.page.entries.add(entry);
        placed.page.touch(frame);
        this.index.add(entry);
        return entry;
    }

    /** Writes an entry's pixels into its page sub-rect. `rowBytes` is one row of `pixels`: w for R8, 4w for RGBA. */
    upload(entry: AtlasEntry, pixels: Uint8Array, rowBytes: number): void {
        this.device.writeTexture(entry.page.texture, { x: entry.x, y: entry.y, width: entry.w, height: entry.h },
            { source: pixels, rowBytes, premultiplied: true, colorSpace: 'srgb', origin: 'top-left' });
    }

    /** Writes a cell's ImageBitmap into its page sub-rect with no readback. The caller closes the bitmap: this only reads it.
     * Colour pages only: an R8 page needs a conversion pass the route cannot begin (see routeText.ts, mono cells). */
    uploadBitmap(entry: AtlasEntry, bitmap: ImageBitmap): void {
        if (this.options.format !== 'rgba8') throw new RangeError('A bitmap uploads only to an rgba8 atlas page');
        this.device.writeTexture(entry.page.texture, { x: entry.x, y: entry.y, width: entry.w, height: entry.h },
            { source: bitmap, premultiplied: true, colorSpace: 'srgb', origin: 'top-left' });
    }

    /** A run pins every entry its draw reads and unpins once it retires. A pinned page is never evicted or trimmed. */
    pin(entry: AtlasEntry): void { entry.pinned++; entry.page.pinned++; }
    unpin(entry: AtlasEntry): void {
        if (entry.pinned <= 0) throw new RangeError('Unpinning a text atlas entry that is not pinned');
        entry.pinned--; entry.page.pinned--;
        if (entry.pinned === 0 && (entry.retired || this.disposed)) this.forget(entry);
        if (entry.pinned === 0 && entry.page.retiring && entry.page.unpinned()) this.destroyRetired(entry.page);
    }

    /** A font changed: retire every entry of that face css. New lookups miss; pinned entries stay valid until their pins drop. */
    retireFace(css: string): number {
        let retired = 0;
        for (const entry of this.index.values()) {
            if (entry.retired || entry.identity.css !== css) continue;
            entry.retired = true; retired++;
            if (entry.pinned === 0) this.forget(entry);
        }
        return retired;
    }

    /** Device loss, DPR change or a release: the atlas stops handing out entries. Unpinned pages are destroyed now; pinned
     * ones are retired and destroyed by their last unpin, so a draw that still reads one never sees it destroyed. */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.index.clear();
        for (const page of this.pages) for (const entry of page.entries) entry.dropped = true;
        for (const page of [...this.pages]) {
            if (page.unpinned()) this.evictPage(page);
            else page.retiring = true;
        }
    }

    /** Governor pressure: frees whole pages that nothing pins and nothing drew this frame, coldest first, until `bytes` are
     * freed. A page pinned or drawn this frame is never a victim, so a refusal here never breaks a frame in progress. */
    evict(bytes: number, frame: number): number {
        // Infinity is a valid request (free everything evictable); NaN and negatives are not.
        if (!(bytes >= 0)) throw new RangeError('Invalid text atlas eviction size');
        let freed = 0;
        while (freed < bytes) {
            let victim: AtlasPage | undefined;
            for (const page of this.pages) if (page.evictable(frame) && (!victim || page.touched < victim.touched)) victim = page;
            if (!victim) break;
            freed += victim.lease.bytes;
            this.evictPage(victim);
        }
        return freed;
    }

    /** True while the entry is the atlas's live mask cell for its identity: not retired, not dropped, not disposed. */
    holds(entry: AtlasEntry): boolean {
        return !this.disposed && !entry.retired && !entry.dropped;
    }

    private findSlot(w: number, h: number, frame: number): { page: AtlasPage; x: number; y: number } | null {
        for (const page of this.pages) {
            const at = page.packer.place(w, h);
            if (at) return { page, ...at };
        }
        if (this.pages.length < this.options.maxPages) {
            const page = this.newPage();
            const at = page?.packer.place(w, h);
            if (page && at) return { page, ...at };
        }
        // No free space and no new page: evict the coldest page nothing holds, then place on its space.
        let victim: AtlasPage | undefined;
        for (const page of this.pages) {
            if (page.evictable(frame) && (!victim || page.touched < victim.touched)) victim = page;
        }
        if (!victim) return null;
        this.evictPage(victim);
        const page = this.newPage();
        const at = page?.packer.place(w, h);
        return page && at ? { page, ...at } : null;
    }

    private newPage(): AtlasPage | null {
        const bytes = ATLAS_PAGE * ATLAS_PAGE * (this.options.format === 'r8' ? 1 : 4);
        const lease = this.host.reserve(bytes);
        if (!lease) return null;
        let texture: TextureHandle;
        try { texture = this.device.createTexture(ATLAS_PAGE, ATLAS_PAGE, this.options.format, ['sample', 'copy-dst'], lease); }
        catch (error) { this.host.release(lease); throw error; }
        const page = new AtlasPage(texture, lease, this.options.format);
        this.pages.push(page);
        return page;
    }

    private evictPage(page: AtlasPage): void {
        for (const entry of page.entries) { this.index.delete(entry); entry.dropped = true; }
        auditCount(this.options.surface, 'text:page-evict', 1, { px: ATLAS_PAGE * ATLAS_PAGE });
        this.pages.splice(this.pages.indexOf(page), 1);
        this.destroyPage(page);
    }

    private destroyPage(page: AtlasPage): void {
        this.device.destroy(page.texture);
        this.host.release(page.lease);
    }

    private destroyRetired(page: AtlasPage): void {
        this.pages.splice(this.pages.indexOf(page), 1);
        this.destroyPage(page);
    }

    private forget(entry: AtlasEntry): void {
        entry.page.entries.delete(entry);
        this.index.delete(entry);
        entry.dropped = true;
    }
}
