// The board's retained tile cache. One entry per tile position (band, scale, x, y, slice), each holding at most one
// render target (platform/render/tileTarget.ts) charged to the GPU governor through its lease. This file is bookkeeping
// only: the composer (tileComposer.ts) decides what to draw; the store decides what to keep, what to reuse and what to
// give back. Design: planning/60-implementation/gpu-handoff/PLAN.md §3.1–3.2.
import type { Rect, ViewState } from '../../../platform/types';
import type { LayerHost } from '../../../platform/render/compositor.types';
import type { GfxDevice } from '../../../platform/render/gfx/api';
import type { MemoryAllocator } from '../../../platform/render/memoryGovernor';
import { auditCount, renderAuditEnabled } from '../../../platform/render/renderAudit';
import { ArenaError } from '../../../platform/render/resourceArena';
import { createTileTarget, destroyTileTarget, tileTargetBytes, type TileTarget } from '../../../platform/render/tileTarget';
import type { PaintBand } from '../material';
import { TILE_EDGE, TILE_GUTTER, TILE_SIZE } from '../imageSampling';
import type { Blend, TileEntry, TileIdFn, TileKey, TileStore, TileWorldFn } from './contracts';
import { TILE_KEY_REACH, TILE_KEY_SCALES, TILE_KEY_SLICES, TileKeyMap, tileKeyNum } from './tileKeys';

/** The numeric face of the store, beside the TileStore contract. The composer and adapter reach entries through it, so a
 * frame builds no string id: a key packs to one integer (tileKeyNum) once its scale has a registry index. */
export interface NumericTileStore extends TileStore {
    /** The entry at a packed key, or undefined. Allocates nothing. */
    getByNum(num: number): TileEntry | undefined;
    /** The packed key of `key`, or −1 when the key cannot be stored (outside the packed range) or its scale holds no entry. */
    numOf(key: TileKey): number;
    /** The registry index of a scale that holds entries, or −1. A scale's index is valid while it holds entries. */
    scaleIndexOf(scale: number): number;
    /** Composed entries (a target held) of `band` at the scale of `scaleIndex`, over the inclusive tile range
     * [x0, x1] × [y0, y1]. A span larger than the positions held at that scale walks those positions with a Map iterator (one
     * small allocation per call); the common span allocates nothing. A scale index of −1 or one with no entries counts zero. */
    countComposed(band: PaintBand, scaleIndex: number, x0: number, y0: number, x1: number, y1: number): number;
    /** Removes one entry; see removeTile. */
    remove(key: TileKey): boolean;
    /** The idle trim: releases free targets down to the reserve once the store has been idle for the idle period. `now` is
     * performance.now(). Returns the number of targets released. */
    trimIdle(now: number): number;
}

/** Scales that may hold entries at once: the packed key's scale field. A scale past this count takes the index of the least
 * recently used scale, whose entries are evicted first (tile:evict:scale-cap), so no frame path throws. */
const SCALE_SLOTS = TILE_KEY_SCALES;
/** A tile id as `tileId` writes it: `${band}/${slice}/${scale}/${x},${y}`. Parsed only by the compatibility `get(id)`. */
const TILE_ID = /^(underlay|content)\/(\d+)\/([^/]+)\/(-?\d+),(-?\d+)$/;

/** Packed position keys hold (x, y) exactly while both stay within ±2^25 tiles: far past any board, and a lookup outside
 * that range returns NaN, which no stored key can equal, so it misses instead of aliasing a different tile. */
const POS_LIMIT = 2 ** 25;
const POS_STRIDE = 2 ** 26;

/** Targets kept for reuse. A zoom drops one scale's positions at once and the next scale's are the same size, so the free
 * list holds about one scale's visible positions (PLAN §6, risk 4: about 30 at DPR 2). Past the limit a target is destroyed,
 * because a kept target still holds its bytes against the governor. Gpu measures the limit in wave 3. */
const FREE_TARGET_LIMIT = 32;
/** The idle trim: once the store has seen no acquire for FREE_IDLE_MS, the free list is cut down to FREE_TARGET_RESERVE (the
 * oldest first), so a zoom that dropped its scales hands their bytes back instead of holding them until releaseAll. */
const FREE_IDLE_MS = 2000;
const FREE_TARGET_RESERVE = 4;
/** The bytes of every target the store makes: the ledger check compares against it. */
const TARGET_BYTES = tileTargetBytes(TILE_SIZE);

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

/** How far apart two scales are on the multiplicative ladder: 0 for the same scale, ln 2 for one √2 step twice over. */
function standsNearer(a: number, b: number, scale: number): boolean {
    const da = ratioDistance(a, scale), db = ratioDistance(b, scale);
    return da !== db ? da < db : a < b;
}

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

/** Whether a key's position and slice pack: a position outside the packed reach is never stored, and the store says so. */
function inReach(key: TileKey): boolean {
    return key.x >= -TILE_KEY_REACH && key.x < TILE_KEY_REACH && key.y >= -TILE_KEY_REACH && key.y < TILE_KEY_REACH
        && key.slice >= 0 && key.slice < TILE_KEY_SLICES;
}

/** Whether a tile's world span (the same arithmetic as tileWorld, with no rect built) overlaps `b`. */
function overlapsKey(key: TileKey, b: Readonly<Rect>): boolean {
    const x = key.x * TILE_EDGE / key.scale, y = key.y * TILE_EDGE / key.scale, size = TILE_EDGE / key.scale;
    return x < b.x + b.width && b.x < x + size && y < b.y + b.height && b.y < y + size;
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
    /** The packed key while the slot is linked, −1 for a detached slot the store does not hold. */
    num = -1;
    /** The scale-registry index its packed key uses while linked. */
    scaleIdx = -1;
    blend: Blend;
    target: TileTarget | null = null;
    revision = 0;
    dirty = true;
    composed = false;
    usedFrame = 0;

    constructor(key: TileKey, blend: Blend) {
        this.key = { band: key.band, scale: key.scale, x: key.x, y: key.y, slice: key.slice };
        this.blend = blend;
    }

    /** The string id, built on demand: nothing on the frame path asks for it, the numeric index serves every lookup. */
    get id(): string { return tileId(this.key); }
}

class GpuTileStore implements NumericTileStore {
    /** The numeric index: packed tile key → its entry. Every lookup by key, number or id lands here. */
    private readonly byNum = new TileKeyMap<Slot>();
    /** Scale registry: a scale with entries → its index, the scale each index names, and how many entries use it. */
    private readonly scaleIndexes = new Map<number, number>();
    private readonly scaleValue = new Float64Array(SCALE_SLOTS).fill(NaN);
    private readonly scaleRefs = new Int32Array(SCALE_SLOTS);
    /** Scratch for recycling: the newest frame each scale index was touched in. Reused, so a recycle allocates nothing. */
    private readonly scaleNewest = new Float64Array(SCALE_SLOTS);
    /** Scratch for the range walks (markDirty, standIns) and the standIns scale order: reused, so a walk allocates nothing. */
    private readonly rangeScratch: Slot[] = [];
    private readonly standFound: Slot[] = [];
    private readonly standOrder = new Float64Array(SCALE_SLOTS);
    /** Scratch for evict's three candidate tiers, scanned once per call and reused. */
    private readonly evictStaleOff: Slot[] = [];
    private readonly evictCurrentOff: Slot[] = [];
    private readonly evictStaleOn: Slot[] = [];
    /** band → scale → packed position → slots there (one per slice). Queries arrive as world rects at one scale. */
    private readonly byBand = new Map<PaintBand, Map<number, Map<number, Slot[]>>>();
    private readonly allocator: MemoryAllocator;
    private readonly audit: string;
    private readonly free: TileTarget[] = [];
    /** Bytes of every target this store holds, in entries or on the free list. The governor charges the same bytes through
     * each target's lease; this readout drops to zero the moment the store gives a target up. */
    private gpuBytes = 0;
    /** Targets the store has made and not yet forgotten: each one is a lease it holds. Audit-only check, see checkLedger. */
    private targetsHeld = 0;
    /** The device generation whose targets the store holds; see adopt. */
    private current: GfxDevice | null = null;
    /** The last acquire's clock reading (performance.now), which the idle trim measures from. */
    private lastAcquireAt = 0;
    private readonly host: LayerHost;

    constructor(host: LayerHost, audit: string) {
        this.host = host;
        this.allocator = host.allocator.gpu;
        this.audit = audit;
    }

    /** Compatibility lookup by string id: the id is parsed and looked up in the numeric index. Not for the frame path. */
    get(id: string): TileEntry | undefined {
        const match = TILE_ID.exec(id);
        if (!match) return undefined;
        const key: TileKey = { band: match[1] as PaintBand, slice: Number(match[2]), scale: Number(match[3]),
            x: Number(match[4]), y: Number(match[5]) };
        return inReach(key) ? this.find(key) : undefined;
    }

    getByNum(num: number): TileEntry | undefined {
        return this.byNum.get(num);
    }

    numOf(key: TileKey): number {
        if (!inReach(key)) return -1;
        const index = this.scaleIndexes.get(key.scale);
        return index === undefined ? -1 : tileKeyNum(key.band, index, key.x, key.y, key.slice);
    }

    scaleIndexOf(scale: number): number {
        return this.scaleIndexes.get(scale) ?? -1;
    }

    touch(entry: TileEntry, frameId: number): void {
        entry.usedFrame = frameId;
    }

    /** An empty position: it keeps no target, and a target it gives up goes to the free list. A position the store cannot
     * name is returned detached: it holds nothing, so the next call finds nothing and asks again. */
    putEmpty(key: TileKey): TileEntry {
        checkKey(key);
        if (!inReach(key)) {
            const detached = new Slot(key, 'over');
            detached.composed = true;
            detached.dirty = false;
            return detached;
        }
        let slot = this.find(key);
        if (!slot) {
            slot = new Slot(key, 'over');
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
        checkKey(key);
        if (!inReach(key)) return false;
        const slot = this.find(key);
        if (!slot) return false;
        const target = this.unlink(slot);
        if (target) this.keepFree(target);
        return true;
    }

    /** Composed entries of `band` at the scale `scaleIndex` names, over the inclusive tile range. Walks the range when it is
     * smaller than the positions held at that scale, the positions otherwise (one Map iterator, see NumericTileStore). */
    countComposed(band: PaintBand, scaleIndex: number, x0: number, y0: number, x1: number, y1: number): number {
        if (scaleIndex < 0 || scaleIndex >= SCALE_SLOTS || this.scaleRefs[scaleIndex] === 0 || x1 < x0 || y1 < y0) return 0;
        const scale = this.scaleValue[scaleIndex];
        const positions = this.byBand.get(band)?.get(scale);
        if (!positions) return 0;
        let count = 0;
        if ((x1 - x0 + 1) * (y1 - y0 + 1) > positions.size) {
            // The span is larger than the positions stored at this scale: walk those positions, not the whole index.
            for (const slots of positions.values()) {
                for (const slot of slots) {
                    if (slot.key.x >= x0 && slot.key.x <= x1 && slot.key.y >= y0 && slot.key.y <= y1 && slot.composed && slot.target !== null) count++;
                }
            }
            return count;
        }
        for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) {
                const slots = positions.get(posKey(x, y));
                if (slots) for (const slot of slots) if (slot.composed && slot.target !== null) count++;
            }
        }
        return count;
    }

    /** The slot at `key`, through the numeric index. The caller has checked that the key is in reach. */
    private find(key: TileKey): Slot | undefined {
        const index = this.scaleIndexes.get(key.scale);
        return index === undefined ? undefined : this.byNum.get(tileKeyNum(key.band, index, key.x, key.y, key.slice));
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
                for (const slot of this.inRange(scale, positions, grown, this.rangeScratch)) {
                    slot.dirty = true;
                    count++;
                }
            }
        }
        return count;
    }

    /** Composed entries (with a target) of other scales covering `world`, nearest scale first. The array is the store's own
     * and is valid until the next standIns call: a caller that keeps the entries copies them. */
    standIns(band: PaintBand, world: Readonly<Rect>, scale: number): readonly TileEntry[] {
        const found = this.standFound;
        found.length = 0;
        const scales = this.byBand.get(band);
        if (!scales) return found;
        // The band's other scales in the registry, nearest first, placed by insertion: at most SCALE_SLOTS of them, so this
        // beats the sort it replaces and allocates nothing.
        const order = this.standOrder;
        let count = 0;
        for (let index = 0; index < SCALE_SLOTS; index++) {
            const other = this.scaleValue[index];
            if (Number.isNaN(other) || other === scale || !scales.has(other)) continue;
            let at = count++;
            while (at > 0 && standsNearer(other, order[at - 1], scale)) {
                order[at] = order[at - 1];
                at--;
            }
            order[at] = other;
        }
        for (let i = 0; i < count; i++) {
            const other = order[i];
            for (const slot of this.inRange(other, scales.get(other)!, world, this.rangeScratch)) {
                if (slot.composed && slot.target) found.push(slot);
            }
        }
        return found;
    }

    /** A target for `key`: the entry's own if it has one, else a free-list target, else a new lease. Null when the governor
     * refuses; the caller keeps its stand-in and waits. */
    acquire(key: TileKey, blend: Blend, device: GfxDevice): TileEntry | null {
        checkKey(key);
        this.lastAcquireAt = performance.now();
        // A position the packed key cannot name is refused here, counted as its own cause, never stored.
        if (!inReach(key)) {
            auditCount(this.audit, 'tile:out-of-reach');
            return null;
        }
        this.adopt(device);
        let slot = this.find(key);
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
            slot = new Slot(key, blend);
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
        // The free list holds only the current generation's targets (adopt drops the rest), so its top is reusable as it is.
        const kept = this.free.pop();
        if (kept) {
            auditCount(this.audit, 'tile:target-reuse');
            return kept;
        }
        const made = createTileTarget(device, this.allocator, TILE_SIZE);
        if (!made) return null;
        this.gpuBytes += made.bytes;
        this.targetsHeld++;
        this.checkLedger('take');
        auditCount(this.audit, 'tile:target-new');
        return made;
    }

    /** A target that leaves its entry keeps its lease and waits on the free list; past the limit it is destroyed. Above the
     * reserve, the store asks the host for a frame at the idle deadline, so trimIdle runs then rather than never. */
    private keepFree(target: TileTarget): void {
        if (this.free.length < FREE_TARGET_LIMIT) {
            this.free.push(target);
            this.checkFree('keep');
            if (this.free.length > FREE_TARGET_RESERVE) this.host.wakeAt(this.lastAcquireAt + FREE_IDLE_MS);
            return;
        }
        this.retire(target);
        auditCount(this.audit, 'tile:evict:free-overflow');
    }

    /** Releases free targets down to the reserve once no acquire has come for FREE_IDLE_MS, oldest first. Not yet idle: asks
     * the host for a frame at the deadline and releases nothing. Returns the number released. Driven by the composer's
     * the composer's prepare, once it calls trimIdle (the TileStore contract has no such call yet), and by the frame that the
     * deadline keepFree schedules. */
    trimIdle(now: number): number {
        const excess = this.free.length - FREE_TARGET_RESERVE;
        if (excess <= 0) return 0;
        const due = this.lastAcquireAt + FREE_IDLE_MS;
        if (now < due) {
            this.host.wakeAt(due);
            return 0;
        }
        const released = this.free.splice(0, excess);
        for (const target of released) {
            this.retire(target);
            auditCount('store', 'free:trim');
        }
        return released.length;
    }

    /** Drops the count of a target whose device generation is gone. The arena returned its bytes at abandonment. */
    private forget(target: TileTarget, path: string): void {
        this.gpuBytes -= target.bytes;
        this.targetsHeld--;
        this.checkLedger(path);
    }

    /** Audit only, never throws: the bytes the store reports are exactly the targets it holds, each one tile-sized. Counted as
     * store:ledger:mismatch:<path>, where path is the move that broke it. Both sides move together, so this holds mid-sweep. */
    private checkLedger(path: string): void {
        if (!renderAuditEnabled()) return;
        if (this.gpuBytes !== this.targetsHeld * TARGET_BYTES) auditCount('store', 'ledger:mismatch:' + path);
    }

    /** Audit only: a free target is a held target, so the free list never outgrows the targets the store holds. */
    private checkFree(path: string): void {
        if (renderAuditEnabled() && this.free.length > this.targetsHeld) auditCount('store', 'ledger:mismatch:' + path);
    }

    /** Makes `device` the generation the store holds targets of. When it changes, every target of the old generation is
     * stale: its lease was returned when the arena abandoned that generation, so the store forgets its bytes now, and
     * unlinks it from its entry (no later call forgets it again). Destroying it is not attempted: its handles are gone.
     * Runs at the change, not at the next acquire, so the readout never counts a lease the arena no longer holds. */
    private adopt(device: GfxDevice): void {
        if (device === this.current) return;
        this.current = device;
        let stale = 0;
        for (const slot of this.byNum.values()) {
            const target = slot.target;
            if (!target || target.device === device) continue;
            this.forget(target, 'adopt-slot');
            slot.target = null;
            slot.composed = false;
            slot.dirty = true;
            stale++;
        }
        let kept = 0;
        for (const target of this.free) {
            if (target.device === device) this.free[kept++] = target;
            else { this.forget(target, 'adopt-free'); stale++; }
        }
        this.free.length = kept;
        if (stale > 0) auditCount(this.audit, 'tile:target-stale', stale);
    }

    /** Destroys a target and returns its bytes. ResourceArena.abandon drops every record of a lost generation, so a
     * destroy of one of its handles throws invalid-resource; its bytes are already back. Any other failure is real. */
    private retire(target: TileTarget): void {
        this.forget(target, 'retire');
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
        // One scan into scratch lists. Each tier is sorted only when the bytes still needed reach it, so a call that frees
        // enough from the first tier never sorts the others; no tile rect is built for an entry the scan only reads.
        const staleOff = this.evictStaleOff, currentOff = this.evictCurrentOff, staleOn = this.evictStaleOn;
        staleOff.length = 0;
        currentOff.length = 0;
        staleOn.length = 0;
        for (const slot of this.byNum.values()) {
            if (!slot.target || slot.usedFrame === frameId) continue;
            const on = overlapsKey(slot.key, shown);
            if (slot.key.scale !== scale) (on ? staleOn : staleOff).push(slot);
            else if (!on) currentOff.push(slot);
        }
        staleOff.sort((a, b) => a.usedFrame - b.usedFrame || ratioDistance(b.key.scale, scale) - ratioDistance(a.key.scale, scale));
        for (const slot of staleOff) {
            if (freed >= bytes) return freed;
            freed += this.evictSlot(slot, 'other-scale');
        }
        const distance = (slot: Slot): number => {
            const size = TILE_EDGE / slot.key.scale;
            return Math.hypot(slot.key.x * TILE_EDGE / slot.key.scale + size / 2 - centreX, slot.key.y * TILE_EDGE / slot.key.scale + size / 2 - centreY);
        };
        currentOff.sort((a, b) => distance(b) - distance(a) || a.usedFrame - b.usedFrame);
        for (const slot of currentOff) {
            if (freed >= bytes) return freed;
            freed += this.evictSlot(slot, 'same-scale');
        }
        let covered = 0;
        for (const slot of staleOn) if (this.coveredAt(scale, slot)) staleOn[covered++] = slot;
        staleOn.length = covered;
        staleOn.sort((a, b) => a.usedFrame - b.usedFrame);
        for (const slot of staleOn) {
            if (freed >= bytes) return freed;
            freed += this.evictSlot(slot, 'covered');
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

    /** The GPU bytes of the targets held on the current device, and no CPU bytes: composed content lives in GPU targets only.
     * With no device the store reports zero and keeps its ledger, so a device that returns resumes the same count. */
    memory(): { gpuBytes: number; cpuBytes: number } {
        const device = this.host.device();
        if (device === null) return { gpuBytes: 0, cpuBytes: 0 };
        this.adopt(device);
        return { gpuBytes: this.gpuBytes, cpuBytes: 0 };
    }

    private link(slot: Slot): void {
        // The scale is registered first: a registry that is full throws before anything is indexed.
        slot.scaleIdx = this.registerScale(slot.key.scale);
        slot.num = tileKeyNum(slot.key.band, slot.scaleIdx, slot.key.x, slot.key.y, slot.key.slice);
        this.byNum.set(slot.num, slot);
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
    private inRange(scale: number, positions: Map<number, Slot[]>, rect: Readonly<Rect>, found: Slot[]): Slot[] {
        found.length = 0;
        if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y) || !Number.isFinite(rect.width) || !Number.isFinite(rect.height)) {
            throw new RangeError('Invalid tile span');
        }
        // The inclusive tile range the half-open span touches at `scale`; first > last when it is empty.
        const x0 = Math.floor(rect.x * scale / TILE_EDGE), x1 = Math.ceil((rect.x + rect.width) * scale / TILE_EDGE) - 1;
        const y0 = Math.floor(rect.y * scale / TILE_EDGE), y1 = Math.ceil((rect.y + rect.height) * scale / TILE_EDGE) - 1;
        if (x1 < x0 || y1 < y0) return found;
        if ((x1 - x0 + 1) * (y1 - y0 + 1) > positions.size) {
            // The span is larger than the positions stored at this scale: walk those positions, not the whole index.
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
        this.byNum.delete(slot.num);
        this.releaseScale(slot.scaleIdx);
        slot.num = -1;
        slot.scaleIdx = -1;
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

    /** The registry index of `scale`, taking one reference: a new scale takes the lowest free index. */
    private registerScale(scale: number): number {
        const known = this.scaleIndexes.get(scale);
        if (known !== undefined) {
            this.scaleRefs[known]++;
            return known;
        }
        let free = this.scaleRefs.indexOf(0);
        if (free < 0) free = this.recycleScaleIndex();
        this.scaleIndexes.set(scale, free);
        this.scaleValue[free] = scale;
        this.scaleRefs[free] = 1;
        return free;
    }

    /** Takes the index of the least recently used scale when every index is in use: that scale's entries are evicted, each
     * counted as tile:evict:scale-cap, and its index is returned with no references. The scale being registered holds no
     * entry yet, so it can never be the victim. Recency is the newest frame any of a scale's entries was touched in. */
    private recycleScaleIndex(): number {
        const newest = this.scaleNewest.fill(-Infinity);
        for (const slot of this.byNum.values()) {
            if (slot.scaleIdx >= 0 && slot.usedFrame > newest[slot.scaleIdx]) newest[slot.scaleIdx] = slot.usedFrame;
        }
        let victim = -1;
        for (let index = 0; index < SCALE_SLOTS; index++) {
            if (this.scaleRefs[index] > 0 && (victim < 0 || newest[index] < newest[victim])) victim = index;
        }
        // The scan above read every entry before anything is evicted: an eviction unlinks, and unlinking releases the scale.
        for (const slot of this.byNum.values()) {
            if (slot.scaleIdx === victim) this.evictSlot(slot, 'scale-cap');
        }
        return victim;
    }

    /** Drops one reference to a registry index; the last one frees the index for the next scale. */
    private releaseScale(index: number): void {
        if (index < 0 || this.scaleRefs[index] === 0) return;
        if (--this.scaleRefs[index] > 0) return;
        this.scaleIndexes.delete(this.scaleValue[index]);
        this.scaleValue[index] = NaN;
    }

    /** Whether a composed target of the same band and slice at `scale` covers the centre of `slot`'s tile. */
    private coveredAt(scale: number, slot: Slot): boolean {
        const size = TILE_EDGE / slot.key.scale;
        const x = Math.floor((slot.key.x * TILE_EDGE / slot.key.scale + size / 2) * scale / TILE_EDGE);
        const y = Math.floor((slot.key.y * TILE_EDGE / slot.key.scale + size / 2) * scale / TILE_EDGE);
        const slots = this.byBand.get(slot.key.band)?.get(scale)?.get(posKey(x, y));
        return slots?.some(other => other.key.slice === slot.key.slice && other.composed && other.target !== null) ?? false;
    }
}

/** Creates the board's tile store, with its numeric index. Assignable to the contract's CreateTileStore. */
export const createTileStore: (host: LayerHost, audit: string) => NumericTileStore = (host, audit) => new GpuTileStore(host, audit);

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
