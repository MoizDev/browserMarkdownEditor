import type { ByteLease, GfxDevice, TargetHandle, TextureFormat, TextureHandle } from '../../platform/render/gfx/api';
import { auditCount } from '../../platform/render/renderAudit';
import { copyIdentity, identityHash, sameIdentity, type MaskIdentity } from './gpu/textMasks';

export const ATLAS_PAGE = 2048;
export const SHELF_STEP = 8;

export interface Indexed { readonly identity: MaskIdentity; readonly hash: number }
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

export class ShelfPacker {
    private readonly shelves: { y: number; height: number; x: number }[] = [];
    private used = 0;
    constructor(readonly width: number, readonly height: number) {}
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
    reset(): void { this.shelves.length = 0; this.used = 0; }
}

export interface AtlasEntry extends Indexed {
    readonly page: AtlasPage;
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
    pinned: number;
    retired: boolean;
    dropped: boolean;
}

export class AtlasPage {
    readonly packer: ShelfPacker;
    readonly entries = new Set<AtlasEntry>();
    pinned = 0;
    touched = -1;
    /** Set when the atlas is disposed while this page is pinned: its texture is destroyed by the last unpin, never earlier. */
    retiring = false;
    target: TargetHandle | null = null;
    constructor(readonly texture: TextureHandle, readonly lease: ByteLease, readonly format: TextureFormat) {
        this.packer = new ShelfPacker(ATLAS_PAGE, ATLAS_PAGE);
    }
    evictable(frame: number): boolean { return this.pinned === 0 && this.touched < frame; }
    unpinned(): boolean { return this.pinned === 0; }
    touch(frame: number): void { if (frame > this.touched) this.touched = frame; }
}

export interface AtlasHost {
    reserve(bytes: number): ByteLease | null;
    release(lease: ByteLease): void;
}

export interface TextAtlasOptions {
    readonly format: TextureFormat;
    readonly maxPages: number;
    readonly surface: string;
}

export class TextAtlas {
    private readonly index = new IdentityIndex<AtlasEntry>();
    private readonly pages: AtlasPage[] = [];
    private disposed = false;
    constructor(private readonly device: GfxDevice, private readonly host: AtlasHost, private readonly options: TextAtlasOptions) {}

    get pageCount(): number { return this.pages.length; }
    get bytes(): number { return this.pages.reduce((sum, page) => sum + page.lease.bytes, 0); }

    lookup(probe: MaskIdentity, frame: number): AtlasEntry | null {
        const entry = this.index.find(probe);
        if (!entry || entry.retired) return null;
        entry.page.touch(frame);
        auditCount(this.options.surface, 'text:mask-hit');
        return entry;
    }

    place(probe: MaskIdentity, w: number, h: number, frame: number): AtlasEntry | 'oversize' | { readonly denied: number } {
        if (this.disposed) return { denied: this.pageBytes() };
        if (w > ATLAS_PAGE || h > ATLAS_PAGE) return 'oversize';
        const placed = this.findSlot(w, h, frame);
        if (!placed) return { denied: this.pageBytes() };
        const identity = copyIdentity(probe);
        const entry: AtlasEntry = { identity, hash: identityHash(identity), page: placed.page, x: placed.x, y: placed.y, w, h,
            pinned: 0, retired: false, dropped: false };
        placed.page.entries.add(entry);
        placed.page.touch(frame);
        this.index.add(entry);
        return entry;
    }

    upload(entry: AtlasEntry, pixels: Uint8Array, rowBytes: number): void {
        this.device.writeTexture(entry.page.texture, { x: entry.x, y: entry.y, width: entry.w, height: entry.h },
            { source: pixels, rowBytes, premultiplied: true, colorSpace: 'srgb', origin: 'top-left' });
    }

    uploadBitmap(entry: AtlasEntry, bitmap: ImageBitmap): void {
        if (this.options.format !== 'rgba8') throw new RangeError('A bitmap uploads only to an rgba8 atlas page');
        this.device.writeTexture(entry.page.texture, { x: entry.x, y: entry.y, width: entry.w, height: entry.h },
            { source: bitmap, premultiplied: true, colorSpace: 'srgb', origin: 'top-left' });
    }

    pin(entry: AtlasEntry): void { entry.pinned++; entry.page.pinned++; }
    unpin(entry: AtlasEntry): void {
        if (entry.pinned <= 0) throw new RangeError('Unpinning a text atlas entry that is not pinned');
        entry.pinned--; entry.page.pinned--;
        if (entry.pinned === 0 && (entry.retired || this.disposed)) this.forget(entry);
        if (entry.pinned === 0 && entry.page.retiring && entry.page.unpinned()) this.destroyRetired(entry.page);
    }

    retireFace(css: string): number {
        let retired = 0;
        for (const entry of this.index.values()) {
            if (entry.retired || entry.identity.css !== css) continue;
            entry.retired = true; retired++;
            if (entry.pinned === 0) this.forget(entry);
        }
        return retired;
    }

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

    evict(bytes: number, frame: number): number {
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

    private pageBytes(): number { return ATLAS_PAGE * ATLAS_PAGE * (this.options.format === 'r8' ? 1 : 4); }

    private newPage(): AtlasPage | null {
        const bytes = this.pageBytes();
        const lease = this.host.reserve(bytes);
        if (!lease) return null;
        let texture: TextureHandle | null = null;
        try {
            if (this.options.format === 'r8') {
                const pair = this.device.createRenderTexture(ATLAS_PAGE, ATLAS_PAGE, lease, { format: 'r8', copyDst: true });
                texture = pair.texture;
                const page = new AtlasPage(texture, lease, 'r8');
                page.target = pair.target;
                this.pages.push(page);
                return page;
            }
            texture = this.device.createTexture(ATLAS_PAGE, ATLAS_PAGE, this.options.format, ['sample', 'copy-dst'], lease);
            const page = new AtlasPage(texture, lease, this.options.format);
            this.pages.push(page);
            return page;
        } catch (error) {
            if (texture) this.device.destroy(texture);
            this.host.release(lease);
            throw error;
        }
    }

    private evictPage(page: AtlasPage): void {
        for (const entry of page.entries) { this.index.delete(entry); entry.dropped = true; }
        auditCount(this.options.surface, 'text:page-evict', 1, { px: ATLAS_PAGE * ATLAS_PAGE });
        this.pages.splice(this.pages.indexOf(page), 1);
        this.destroyPage(page);
    }

    private destroyPage(page: AtlasPage): void {
        page.entries.clear();
        if (page.target) this.device.destroy(page.target);
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
