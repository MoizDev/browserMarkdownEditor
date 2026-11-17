// The board's retained tile cache. One entry per tile position (band, scale, x, y, slice), each holding at most one
// render target (platform/render/tileTarget.ts) charged to the GPU governor through its lease. This file is bookkeeping
// only: the composer (tileComposer.ts) decides what to draw; the store decides what to keep, what to reuse and what to
// give back. Design: planning/60-implementation/gpu-handoff/PLAN.md §3.1–3.2.
import type { Rect, ViewState } from '../../../platform/types';
import type { LayerHost } from '../../../platform/render/compositor.types';
import type { GfxDevice } from '../../../platform/render/gfx/api';
import type { MemoryAllocator } from '../../../platform/render/memoryGovernor';
import { auditCount } from '../../../platform/render/renderAudit';
import { ArenaError } from '../../../platform/render/resourceArena';
import { createTileTarget, destroyTileTarget, type TileTarget } from '../../../platform/render/tileTarget';
import type { PaintBand } from '../material';
import { TILE_EDGE, TILE_GUTTER, TILE_SIZE } from '../imageSampling';
import type { Blend, CreateTileStore, TileEntry, TileIdFn, TileKey, TileStore, TileWorldFn } from './contracts';

/** Packed position keys hold (x, y) exactly while both stay within ±2^25 tiles: far past any board, and a lookup outside
 * that range returns NaN, which no stored key can equal, so it misses instead of aliasing a different tile. */
const POS_LIMIT = 2 ** 25;
const POS_STRIDE = 2 ** 26;

/** Targets kept for reuse. A zoom drops one scale's positions at once and the next scale's are the same size, so the free
 * list holds about one scale's visible positions (PLAN §6, risk 4: about 30 at DPR 2). Past the limit a target is destroyed,
 * because a kept target still holds its bytes against the governor. Gpu measures the limit in wave 3. */
const FREE_TARGET_LIMIT = 32;

function checkKey(key: TileKey): void {
    if (!Number.isSafeInteger(key.x) || !Number.isSafeInteger(key.y) || !Number.isSafeInteger(key.slice) ||
        Math.abs(key.x) >= POS_LIMIT || Math.abs(key.y) >= POS_LIMIT || key.slice < 0 ||
        !(key.scale > 0) || !Number.isFinite(key.scale)) {
        throw new RangeError('Invalid tile key');
    }
}

function posKey(x: number, y: number): number {
    if (Math.abs(x) >= POS_LIMIT || Math.abs(y) >= POS_LIMIT) return NaN;
    return x * POS_STRIDE + y;
}

/** Inclusive tile index range a half-open world span [lo, hi) touches at `scale`; first > last when it is empty. */
function tileRange(lo: number, hi: number, scale: number): readonly [number, number] {
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw new RangeError('Invalid tile span');
    return [Math.floor(lo * scale / TILE_EDGE), Math.ceil(hi * scale / TILE_EDGE) - 1];
}

/** How far apart two scales are on the multiplicative ladder: 0 for the same scale, ln 2 for one √2 step twice over. */
function ratioDistance(a: number, b: number): number {
    return Math.abs(Math.log(a / b));
}

/** The pane's device pixels per world unit: the scale a tile at the current view is composed at. */
function viewScale(view: ViewState): number {
    const scale = view.camera.z * view.viewport.dpr;
    if (!(scale > 0) || !Number.isFinite(scale)) throw new RangeError('Invalid view scale');
    return scale;
}

function viewWorld(view: ViewState): Rect {
    return { x: view.camera.x, y: view.camera.y, width: view.viewport.width / view.camera.z, height: view.viewport.height / view.camera.z };
}

function overlaps(a: Readonly<Rect>, b: Readonly<Rect>): boolean {
    return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

export const tileId: TileIdFn = key => {
    checkKey(key);
    return `${key.band}/${key.slice}/${key.scale}/${key.x},${key.y}`;
};

export const tileWorld: TileWorldFn = key => {
    checkKey(key);
    return {
        x: key.x * TILE_EDGE / key.scale, y: key.y * TILE_EDGE / key.scale,
        width: TILE_EDGE / key.scale, height: TILE_EDGE / key.scale,
    };
};

/** Mutable only inside this file; the interface hands out the same object, read-only. */
class Slot implements TileEntry {
    readonly key: TileKey;
    readonly id: string;
    blend: Blend;
    target: TileTarget | null = null;
    revision = 0;
    dirty = true;
    composed = false;
    usedFrame = 0;

    constructor(key: TileKey, id: string, blend: Blend) {
        this.key = { band: key.band, scale: key.scale, x: key.x, y: key.y, slice: key.slice };
        this.id = id;
        this.blend = blend;
    }
}

class GpuTileStore implements TileStore {
    private readonly byId = new Map<string, Slot>();
    /** band → scale → packed position → slots there (one per slice). Queries arrive as world rects at one scale. */
    private readonly byBand = new Map<PaintBand, Map<number, Map<number, Slot[]>>>();
    private readonly allocator: MemoryAllocator;
    private readonly audit: string;
    private readonly free: TileTarget[] = [];
    /** Bytes of every target this store holds, in entries or on the free list. The governor charges the same bytes through
     * each target's lease; this readout drops to zero the moment the store gives a target up. */
    private gpuBytes = 0;

    constructor(host: LayerHost, audit: string) {
        this.allocator = host.allocator.gpu;
        this.audit = audit;
    }

    get(id: string): TileEntry | undefined {
        return this.byId.get(id);
    }

    touch(entry: TileEntry, frameId: number): void {
        entry.usedFrame = frameId;
    }

    /** An empty position: it keeps no target, and a target it gives up goes to the free list. */
    putEmpty(key: TileKey): TileEntry {
        const id = tileId(key);
        let slot = this.byId.get(id);
        if (!slot) {
            slot = new Slot(key, id, 'over');
            this.link(slot);
        } else if (slot.target) {
            const target = slot.target;
            slot.target = null;
            this.keepFree(target);
        }
        slot.composed = true;
        slot.dirty = false;
        return slot;
    }

    /** Removes the entry at `key` (one slice of a position; the composer removes each slice it no longer needs). Its
     * target goes to the free list, as in putEmpty. Returns whether an entry was there. */
    remove(key: TileKey): boolean {
        const slot = this.byId.get(tileId(key));
        if (!slot) return false;
        const target = this.unlink(slot);
        if (target) this.keepFree(target);
        return true;
    }

    markDirty(world: Readonly<Rect> | 'all', band?: PaintBand): number {
        if (world === 'all') {
            const slots = this.slotsIn(band);
            for (const slot of slots) slot.dirty = true;
            return slots.length;
        }
        let count = 0;
        for (const [bandKey, scales] of this.byBand) {
            if (band !== undefined && bandKey !== band) continue;
            for (const [scale, positions] of scales) {
                // A tile's gutter is its neighbours' interior seen from here, so a change inside the gutter reaches the
                // tile's sampled edge: the test covers the full extent, gutter included, not the interior alone.
                const gutter = TILE_GUTTER / scale;
                const grown = { x: world.x - gutter, y: world.y - gutter, width: world.width + 2 * gutter, height: world.height + 2 * gutter };
                for (const slot of this.inRange(scale, positions, grown)) {
                    slot.dirty = true;
                    count++;
                }
            }
        }
        return count;
    }

    /** Composed entries (with a target) of other scales covering `world`, nearest scale first. */
    standIns(band: PaintBand, world: Readonly<Rect>, scale: number): readonly TileEntry[] {
        const scales = this.byBand.get(band);
        if (!scales) return [];
        const others = [...scales.keys()].filter(other => other !== scale)
            .sort((a, b) => ratioDistance(a, scale) - ratioDistance(b, scale) || a - b);
        const found: TileEntry[] = [];
        for (const other of others) {
            for (const slot of this.inRange(other, scales.get(other)!, world)) {
                if (slot.composed && slot.target) found.push(slot);
            }
        }
        return found;
    }

    /** A target for `key`: the entry's own if it has one, else a free-list target, else a new lease. Null when the governor
     * refuses; the caller keeps its stand-in and waits. */
    acquire(key: TileKey, blend: Blend, device: GfxDevice): TileEntry | null {
        const id = tileId(key);
        let slot = this.byId.get(id);
        if (slot?.target && slot.target.device !== device) {
            // A new device generation: the old one abandoned this target and returned its bytes, so only forget it.
            this.forget(slot.target);
            slot.target = null;
            slot.composed = false;
        }
        if (slot?.target) {
            if (slot.blend !== blend) throw new RangeError('Tile blend changed while its target is live');
            return slot;
        }
        const target = this.takeTarget(device);
        if (!target) {
            if (slot) {
                slot.composed = false;
                slot.dirty = true;
            }
            return null;
        }
        if (!slot) {
            slot = new Slot(key, id, blend);
            this.link(slot);
        }
        slot.blend = blend;
        slot.target = target;
        slot.composed = false;
        slot.dirty = true;
        return slot;
    }

    /** A kept target if one is free, else a new target on the governor's lease. */
    private takeTarget(device: GfxDevice): TileTarget | null {
        let kept = this.free.pop();
        while (kept) {
            if (kept.device === device) {
                auditCount(this.audit, 'tile:target-reuse');
                return kept;
            }
            this.forget(kept);
            kept = this.free.pop();
        }
        const made = createTileTarget(device, this.allocator, TILE_SIZE);
        if (!made) return null;
        this.gpuBytes += made.bytes;
        auditCount(this.audit, 'tile:target-new');
        return made;
    }

    /** A target that leaves its entry keeps its lease and waits on the free list; past the limit it is destroyed. */
    private keepFree(target: TileTarget): void {
        if (this.free.length < FREE_TARGET_LIMIT) {
            this.free.push(target);
            return;
        }
        this.retire(target);
        auditCount(this.audit, 'tile:evict:free-overflow');
    }

    /** Drops the count of a target whose device generation is gone. The arena returned its bytes at abandonment. */
    private forget(target: TileTarget): void {
        this.gpuBytes -= target.bytes;
    }

    /** Destroys a target and returns its bytes. ResourceArena.abandon drops every record of a lost generation, so a
     * destroy of one of its handles throws invalid-resource; its bytes are already back. Any other failure is real. */
    private retire(target: TileTarget): void {
        this.forget(target);
        try {
            destroyTileTarget(target);
        } catch (error) {
            if (!(error instanceof ArenaError && error.code === 'invalid-resource')) throw error;
        }
    }

    /** Frees at least `bytes` when it can, and never an entry touched in `frameId`. Order: the free list; other scales off
     * view (least recently used first); the current scale off view (farthest from the view first); other scales on view
     * that the current scale composes at their centre, so the picture never loses its stand-in. Returns the bytes freed. */
    evict(bytes: number, frameId: number, view: ViewState): number {
        if (!Number.isFinite(bytes) || bytes < 0) throw new RangeError('Invalid eviction size');
        let freed = 0;
        while (freed < bytes && this.free.length) {
            const target = this.free.pop()!;
            freed += target.bytes;
            this.retire(target);
            auditCount(this.audit, 'tile:evict:free-list');
        }
        if (freed >= bytes) return freed;

        const scale = viewScale(view);
        const shown = viewWorld(view);
        const centreX = shown.x + shown.width / 2, centreY = shown.y + shown.height / 2;
        const distance = (slot: Slot): number => {
            const world = tileWorld(slot.key);
            return Math.hypot(world.x + world.width / 2 - centreX, world.y + world.height / 2 - centreY);
        };
        const staleOff: Slot[] = [], currentOff: Slot[] = [], staleOn: Slot[] = [];
        for (const slot of this.slotsIn()) {
            if (!slot.target || slot.usedFrame === frameId) continue;
            const on = overlaps(tileWorld(slot.key), shown);
            if (slot.key.scale !== scale) (on ? staleOn : staleOff).push(slot);
            else if (!on) currentOff.push(slot);
        }
        staleOff.sort((a, b) => a.usedFrame - b.usedFrame || ratioDistance(b.key.scale, scale) - ratioDistance(a.key.scale, scale));
        currentOff.sort((a, b) => distance(b) - distance(a) || a.usedFrame - b.usedFrame);
        const covered = staleOn.filter(slot => this.coveredAt(scale, slot)).sort((a, b) => a.usedFrame - b.usedFrame);
        const tiers: readonly (readonly [readonly Slot[], string])[] = [[staleOff, 'other-scale'], [currentOff, 'same-scale'], [covered, 'covered']];
        for (const [group, why] of tiers) {
            for (const slot of group) {
                if (freed >= bytes) return freed;
                freed += this.evictSlot(slot, why);
            }
        }
        return freed;
    }

    /** Moves every entry of `band` at other scales off the index. Their targets join the free list, where the new scale
     * reuses them, so the bytes stay charged until reuse or eviction. Returns the number of entries dropped. */
    dropScalesExcept(scale: number, band: PaintBand): number {
        let dropped = 0;
        for (const slot of this.slotsIn(band)) {
            if (slot.key.scale === scale) continue;
            const target = this.unlink(slot);
            if (target) this.keepFree(target);
            dropped++;
        }
        return dropped;
    }

    /** Waits until the governor would admit `bytes`: the sized waiter does not wake on unrelated releases. */
    wait(bytes: number, wake: () => void): void {
        if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError('Invalid wait size');
        if (!this.allocator.whenAvailable) throw new Error('GPU allocator cannot wake a waiter');
        this.allocator.whenAvailable(wake, bytes);
    }

    /** Gives every target back and forgets every entry, so the store is empty and its bytes read zero when this returns.
     * The governor's charge follows when the device retires each texture (ResourceArena: a submitted use fences). */
    releaseAll(): void {
        for (const slot of this.slotsIn()) {
            const target = this.unlink(slot);
            if (target) {
                this.retire(target);
                auditCount(this.audit, 'tile:evict:release-all');
            }
        }
        for (const target of this.free.splice(0)) this.retire(target);
        if (this.gpuBytes !== 0) throw new Error('Tile store byte ledger is out of step after release');
    }

    /** The store holds no CPU memory: its composed content lives in GPU targets only. */
    memory(): { gpuBytes: number; cpuBytes: number } {
        return { gpuBytes: this.gpuBytes, cpuBytes: 0 };
    }

    private link(slot: Slot): void {
        this.byId.set(slot.id, slot);
        let scales = this.byBand.get(slot.key.band);
        if (!scales) {
            scales = new Map();
            this.byBand.set(slot.key.band, scales);
        }
        let positions = scales.get(slot.key.scale);
        if (!positions) {
            positions = new Map();
            scales.set(slot.key.scale, positions);
        }
        const pos = posKey(slot.key.x, slot.key.y);
        let slots = positions.get(pos);
        if (!slots) {
            slots = [];
            positions.set(pos, slots);
        }
        slots.push(slot);
    }

    /** Every slot at `scale` whose tile reaches `rect`. Walks the span when it is small, the stored positions when the
     * span is larger than what is stored (a whole-board query at a small scale). */
    private inRange(scale: number, positions: Map<number, Slot[]>, rect: Readonly<Rect>): Slot[] {
        const [x0, x1] = tileRange(rect.x, rect.x + rect.width, scale);
        const [y0, y1] = tileRange(rect.y, rect.y + rect.height, scale);
        const found: Slot[] = [];
        if (x1 < x0 || y1 < y0) return found;
        if ((x1 - x0 + 1) * (y1 - y0 + 1) > positions.size) {
            for (const slots of positions.values()) {
                for (const slot of slots) {
                    if (slot.key.x >= x0 && slot.key.x <= x1 && slot.key.y >= y0 && slot.key.y <= y1) found.push(slot);
                }
            }
            return found;
        }
        for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) {
                const slots = positions.get(posKey(x, y));
                if (slots) for (const slot of slots) found.push(slot);
            }
        }
        return found;
    }

    private slotsIn(band?: PaintBand): Slot[] {
        const found: Slot[] = [];
        for (const [bandKey, scales] of this.byBand) {
            if (band !== undefined && bandKey !== band) continue;
            for (const positions of scales.values()) {
                for (const slots of positions.values()) for (const slot of slots) found.push(slot);
            }
        }
        return found;
    }

    /** Takes an entry out of every index and returns its target for the caller to keep or destroy. A detached entry draws
     * nothing: a reference the composer still holds sees no target, never a target another entry has since reused. */
    private unlink(slot: Slot): TileTarget | null {
        this.byId.delete(slot.id);
        const scales = this.byBand.get(slot.key.band);
        const positions = scales?.get(slot.key.scale);
        const pos = posKey(slot.key.x, slot.key.y);
        const slots = positions?.get(pos);
        if (slots) {
            const at = slots.indexOf(slot);
            if (at >= 0) slots.splice(at, 1);
            if (slots.length === 0) positions?.delete(pos);
        }
        if (positions?.size === 0) scales?.delete(slot.key.scale);
        if (scales?.size === 0) this.byBand.delete(slot.key.band);
        const target = slot.target;
        slot.target = null;
        slot.composed = false;
        slot.dirty = true;
        return target;
    }

    /** Unlinks an entry and destroys its target, returning the bytes it held. */
    private evictSlot(slot: Slot, why: string): number {
        const target = this.unlink(slot);
        if (!target) return 0;
        this.retire(target);
        auditCount(this.audit, `tile:evict:${why}`);
        return target.bytes;
    }

    /** Whether a composed target of the same band and slice at `scale` covers the centre of `slot`'s tile. */
    private coveredAt(scale: number, slot: Slot): boolean {
        const world = tileWorld(slot.key);
        const x = Math.floor((world.x + world.width / 2) * scale / TILE_EDGE);
        const y = Math.floor((world.y + world.height / 2) * scale / TILE_EDGE);
        const slots = this.byBand.get(slot.key.band)?.get(scale)?.get(posKey(x, y));
        return slots?.some(other => other.key.slice === slot.key.slice && other.composed && other.target !== null) ?? false;
    }
}

export const createTileStore: CreateTileStore = (host, audit) => new GpuTileStore(host, audit);

/** Removes one entry from a store made by createTileStore. `remove` is not on the TileStore contract, so the composer reaches
 * it through here; a store of any other origin is refused rather than silently ignored. */
export function removeTile(store: TileStore, key: TileKey): boolean {
    if (!(store instanceof GpuTileStore)) throw new TypeError('removeTile needs a store from createTileStore');
    return store.remove(key);
}

/** The tile one level down that covers `key`'s world at half the scale. Four positions of `key`'s scale share one of these,
 * so a visible position that is lowered costs a quarter of the bytes. It is an ordinary tile: the stand-in rule finds it
 * by world rect, and the composer draws it the same way. */
export function lowerTileKey(key: TileKey): TileKey {
    checkKey(key);
    return { band: key.band, scale: key.scale / 2, x: Math.floor(key.x / 2), y: Math.floor(key.y / 2), slice: key.slice };
}

/** What a position that must be on screen gets: its entry, or `'lower'` when the governor refused it. On `'lower'` the
 * composer composes `lowerTileKey(key)` through this again; a second refusal keeps the stand-in and waits. */
export type VisibleAcquire = TileEntry | 'lower';

/** `store.acquire` for a visible position: a refusal reports `'lower'` instead of `null`. The governor's own refusal is
 * the only source, so a `'lower'` is never a silent fallback to the CPU. */
export function acquireVisible(store: TileStore, key: TileKey, blend: Blend, device: GfxDevice): VisibleAcquire {
    return store.acquire(key, blend, device) ?? 'lower';
}
