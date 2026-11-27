import type { Rect, ViewState } from '../../../platform/types';
import type { LayerHost } from '../../../platform/render/compositor.types';
import type { GfxDevice } from '../../../platform/render/gfx/api';
import type { MemoryAllocator, ReserveOptions } from '../../../platform/render/memoryGovernor';
import { auditCount, renderAuditEnabled } from '../../../platform/render/renderAudit';
import { ArenaError } from '../../../platform/render/resourceArena';
import { createTileTarget, destroyTileTarget, tileTargetBytes, type TileTarget } from '../../../platform/render/tileTarget';
import type { PaintBand } from '../material';
import { TILE_EDGE, TILE_GUTTER, TILE_SIZE } from '../imageSampling';
import type { Blend, LiveEviction, TileEntry, TileIdFn, TileKey, TileStore, TileWorldFn } from './contracts';
import { exactTileScale, TILE_KEY_REACH, TILE_KEY_SCALES, TILE_KEY_SLICES, TileKeyMap, tileKeyNum } from './tileKeys';
const PREFETCH: ReserveOptions = Object.freeze({ prefetch: true });

export interface TileScaleBreakdown {
    scale: number;
    atViewScale: boolean;
    entries: number;
    composed: number;
    targets: number;
    bytes: number;
    onView: number;
    offView: number;
    onViewBytes: number;
    offViewBytes: number;
}

export interface TileStoreBreakdown {
    viewScale: number;
    gpuBytes: number;
    heldTargets: number;
    heldBytes: number;
    freeTargets: number;
    freeBytes: number;
    ledgerOk: boolean;
    scales: TileScaleBreakdown[];
}

export interface NumericTileStore extends TileStore {
    breakdown(view: ViewState): TileStoreBreakdown;
    getByNum(num: number): TileEntry | undefined;
    numOf(key: TileKey): number;
    scaleIndexOf(scale: number): number;
    countComposed(band: PaintBand, scaleIndex: number, x0: number, y0: number, x1: number, y1: number): number;
    remove(key: TileKey): boolean;
    trimIdle(now: number): number;
}

const SCALE_SLOTS = TILE_KEY_SCALES;
const TILE_ID = /^(underlay|content)\/(\d+)\/([^/]+)\/(-?\d+),(-?\d+)$/;

const POS_LIMIT = 2 ** 25;
const POS_STRIDE = 2 ** 26;

const FREE_TARGET_LIMIT = 32;
const FREE_IDLE_MS = 2000;
const FREE_TARGET_RESERVE = 4;
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

function standsNearer(a: number, b: number, scale: number): boolean {
    const da = ratioDistance(a, scale), db = ratioDistance(b, scale);
    return da !== db ? da < db : a < b;
}

function ratioDistance(a: number, b: number): number {
    return Math.abs(Math.log(a / b));
}

function viewScale(view: ViewState): number {
    const scale = exactTileScale(view.camera.z * view.viewport.dpr);
    if (!(scale > 0) || !Number.isFinite(scale)) throw new RangeError('Invalid view scale');
    return scale;
}

function viewWorld(view: ViewState): Rect {
    return { x: view.camera.x, y: view.camera.y, width: view.viewport.width / view.camera.z, height: view.viewport.height / view.camera.z };
}

function inReach(key: TileKey): boolean {
    return key.x >= -TILE_KEY_REACH && key.x < TILE_KEY_REACH && key.y >= -TILE_KEY_REACH && key.y < TILE_KEY_REACH
        && key.slice >= 0 && key.slice < TILE_KEY_SLICES;
}

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

class Slot implements TileEntry {
    readonly key: TileKey;
    num = -1;
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

    get id(): string { return tileId(this.key); }
}

class GpuTileStore implements NumericTileStore {
    private readonly byNum = new TileKeyMap<Slot>();
    private readonly scaleIndexes = new Map<number, number>();
    private readonly scaleValue = new Float64Array(SCALE_SLOTS).fill(NaN);
    private readonly scaleRefs = new Int32Array(SCALE_SLOTS);
    private readonly scaleNewest = new Float64Array(SCALE_SLOTS);
    private readonly rangeScratch: Slot[] = [];
    private readonly standFound: Slot[] = [];
    private readonly standOrder = new Float64Array(SCALE_SLOTS);
    private readonly evictStaleOff: Slot[] = [];
    private readonly evictCurrentOff: Slot[] = [];
    private readonly evictStaleOn: Slot[] = [];
    private readonly evictCurrentOn: Slot[] = [];
    private readonly held = new Set<Slot>();
    private heldRevision = 0;
    private evictDry: { frameId: number; revision: number; view: ViewState; live: LiveEviction } | null = null;
    private readonly dropScratch: Slot[] = [];
    private readonly byBand = new Map<PaintBand, Map<number, Map<number, Slot[]>>>();
    private readonly allocator: MemoryAllocator;
    private readonly audit: string;
    private readonly free: TileTarget[] = [];
    private gpuBytes = 0;
    private targetsHeld = 0;
    private current: GfxDevice | null = null;
    private lastAcquireAt = 0;
    private readonly host: LayerHost;

    constructor(host: LayerHost, audit: string) {
        this.host = host;
        this.allocator = host.allocator.gpu;
        this.audit = audit;
    }

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

    touchVisible(view: ViewState, frameId: number): void {
        const shown = viewWorld(view);
        for (const slot of this.held) if (overlapsKey(slot.key, shown)) slot.usedFrame = frameId;
    }

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
            this.held.delete(slot);
            this.heldRevision++;
            this.keepFree(target);
        }
        slot.composed = true;
        slot.dirty = false;
        return slot;
    }

    remove(key: TileKey): boolean {
        checkKey(key);
        if (!inReach(key)) return false;
        const slot = this.find(key);
        if (!slot) return false;
        const target = this.unlink(slot);
        if (target) this.keepFree(target);
        return true;
    }

    countComposed(band: PaintBand, scaleIndex: number, x0: number, y0: number, x1: number, y1: number): number {
        if (scaleIndex < 0 || scaleIndex >= SCALE_SLOTS || this.scaleRefs[scaleIndex] === 0 || x1 < x0 || y1 < y0) return 0;
        const scale = this.scaleValue[scaleIndex];
        const positions = this.byBand.get(band)?.get(scale);
        if (!positions) return 0;
        let count = 0;
        if ((x1 - x0 + 1) * (y1 - y0 + 1) > positions.size) {
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

    standIns(band: PaintBand, world: Readonly<Rect>, scale: number, empty = false): readonly TileEntry[] {
        const found = this.standFound;
        found.length = 0;
        const scales = this.byBand.get(band);
        if (!scales) return found;
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
                if (slot.composed && (slot.target || empty)) found.push(slot);
            }
        }
        return found;
    }

    acquire(key: TileKey, blend: Blend, device: GfxDevice, prefetch = false): TileEntry | null {
        checkKey(key);
        this.lastAcquireAt = performance.now();
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
        const target = this.takeTarget(device, prefetch);
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
        this.held.add(slot);
        this.heldRevision++;
        slot.composed = false;
        slot.dirty = true;
        return slot;
    }

    private takeTarget(device: GfxDevice, prefetch: boolean): TileTarget | null {
        const kept = this.free.pop();
        if (kept) {
            this.heldRevision++;
            auditCount(this.audit, 'tile:target-reuse');
            return kept;
        }
        const made = createTileTarget(device, this.allocator, TILE_SIZE, prefetch ? PREFETCH : undefined);
        if (!made) return null;
        this.gpuBytes += made.bytes;
        this.targetsHeld++;
        this.checkLedger('take');
        auditCount(this.audit, 'tile:target-new');
        return made;
    }

    private keepFree(target: TileTarget): void {
        if (this.free.length < FREE_TARGET_LIMIT) {
            this.free.push(target);
            this.heldRevision++;
            this.checkFree('keep');
            if (this.free.length > FREE_TARGET_RESERVE) this.host.wakeAt(this.lastAcquireAt + FREE_IDLE_MS);
            return;
        }
        this.retire(target);
        auditCount(this.audit, 'tile:evict:free-overflow');
    }

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

    private forget(target: TileTarget, path: string): void {
        this.gpuBytes -= target.bytes;
        this.targetsHeld--;
        this.checkLedger(path);
    }

    private checkLedger(path: string): void {
        if (!renderAuditEnabled()) return;
        if (this.gpuBytes !== this.targetsHeld * TARGET_BYTES) auditCount('store', 'ledger:mismatch:' + path);
    }

    private checkFree(path: string): void {
        if (renderAuditEnabled() && this.free.length > this.targetsHeld) auditCount('store', 'ledger:mismatch:' + path);
    }

    private adopt(device: GfxDevice): void {
        if (device === this.current) return;
        this.current = device;
        this.heldRevision++;
        let stale = 0;
        for (const slot of this.byNum.values()) {
            const target = slot.target;
            if (!target || target.device === device) continue;
            this.forget(target, 'adopt-slot');
            slot.target = null;
            this.held.delete(slot);
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

    private retire(target: TileTarget): void {
        this.forget(target, 'retire');
        try {
            destroyTileTarget(target);
        } catch (error) {
            if (!(error instanceof ArenaError && error.code === 'invalid-resource')) throw error;
        }
    }

    evict(bytes: number, frameId: number, view: ViewState, live: LiveEviction = false): number {
        if (!Number.isFinite(bytes) || bytes < 0) throw new RangeError('Invalid eviction size');
        const dry = this.evictDry;
        if (dry && dry.frameId === frameId && dry.revision === this.heldRevision && dry.view === view && dry.live === live) return 0;
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
        const staleOff = this.evictStaleOff, currentOff = this.evictCurrentOff, staleOn = this.evictStaleOn, currentOn = this.evictCurrentOn;
        staleOff.length = 0;
        currentOff.length = 0;
        staleOn.length = 0;
        currentOn.length = 0;
        for (const slot of this.held) {
            const on = overlapsKey(slot.key, shown);
            if (live) {
                if (slot.key.scale !== scale) staleOff.push(slot);
                else if (!on) currentOff.push(slot);
                else if (live === 'moving') currentOn.push(slot);
                continue;
            }
            if (slot.usedFrame === frameId && on) continue;
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
        if (live === 'moving') {
            currentOn.sort((a, b) => a.usedFrame - b.usedFrame);
            for (const slot of currentOn) {
                if (freed >= bytes) return freed;
                freed += this.evictSlot(slot, 'live-covered');
            }
        }
        let covered = 0;
        for (const slot of staleOn) if (this.coveredAt(scale, slot)) staleOn[covered++] = slot;
        staleOn.length = covered;
        staleOn.sort((a, b) => a.usedFrame - b.usedFrame);
        for (const slot of staleOn) {
            if (freed >= bytes) return freed;
            freed += this.evictSlot(slot, 'covered');
        }
        this.evictDry = { frameId, revision: this.heldRevision, view, live };
        return freed;
    }

    dropScalesExcept(scale: number, band: PaintBand, keep = Number.NaN, usedSince = Infinity): number {
        const scales = this.byBand.get(band);
        if (!scales) return 0;
        const others = this.dropScratch;
        others.length = 0;
        for (const [other, positions] of scales) {
            if (other === scale || other === keep) continue;
            for (const slots of positions.values()) for (const slot of slots) if (slot.usedFrame < usedSince) others.push(slot);
        }
        const dropped = others.length;
        for (const slot of others) {
            const target = this.unlink(slot);
            if (target) this.keepFree(target);
        }
        others.length = 0;
        return dropped;
    }

    wait(bytes: number, wake: () => void): void {
        if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError('Invalid wait size');
        if (!this.allocator.whenAvailable) throw new Error('GPU allocator cannot wake a waiter');
        this.allocator.whenAvailable(wake, bytes);
    }

    releaseAll(): void {
        for (const slot of this.slotsIn()) {
            const target = this.unlink(slot);
            if (target) {
                this.retire(target);
                auditCount(this.audit, 'tile:evict:release-all');
            }
        }
        this.heldRevision++;
        for (const target of this.free.splice(0)) this.retire(target);
        if (this.gpuBytes !== 0) throw new Error('Tile store byte ledger is out of step after release');
    }

    memory(): { gpuBytes: number; cpuBytes: number } {
        const device = this.host.device();
        if (device !== null) this.adopt(device);
        return { gpuBytes: this.gpuBytes, cpuBytes: 0 };
    }

    breakdown(view: ViewState): TileStoreBreakdown {
        const shown = viewWorld(view), scale = viewScale(view);
        const rows = new Map<number, TileScaleBreakdown>();
        let heldTargets = 0, heldBytes = 0;
        for (const slot of this.byNum.values()) {
            let row = rows.get(slot.key.scale);
            if (!row) {
                row = { scale: slot.key.scale, atViewScale: slot.key.scale === scale, entries: 0, composed: 0, targets: 0,
                    bytes: 0, onView: 0, offView: 0, onViewBytes: 0, offViewBytes: 0 };
                rows.set(slot.key.scale, row);
            }
            const on = overlapsKey(slot.key, shown);
            row.entries++;
            if (slot.composed) row.composed++;
            if (on) row.onView++; else row.offView++;
            const target = slot.target;
            if (!target) continue;
            row.targets++;
            row.bytes += target.bytes;
            heldTargets++;
            heldBytes += target.bytes;
            if (on) row.onViewBytes += target.bytes; else row.offViewBytes += target.bytes;
        }
        let freeBytes = 0;
        for (const target of this.free) freeBytes += target.bytes;
        return {
            viewScale: scale,
            gpuBytes: this.gpuBytes,
            heldTargets,
            heldBytes,
            freeTargets: this.free.length,
            freeBytes,
            ledgerOk: heldBytes + freeBytes === this.gpuBytes && heldTargets + this.free.length === this.targetsHeld,
            scales: [...rows.values()].sort((a, b) => a.scale - b.scale),
        };
    }

    private link(slot: Slot): void {
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

    private inRange(scale: number, positions: Map<number, Slot[]>, rect: Readonly<Rect>, found: Slot[]): Slot[] {
        found.length = 0;
        if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y) || !Number.isFinite(rect.width) || !Number.isFinite(rect.height)) {
            throw new RangeError('Invalid tile span');
        }
        const x0 = Math.floor(rect.x * scale / TILE_EDGE), x1 = Math.ceil((rect.x + rect.width) * scale / TILE_EDGE) - 1;
        const y0 = Math.floor(rect.y * scale / TILE_EDGE), y1 = Math.ceil((rect.y + rect.height) * scale / TILE_EDGE) - 1;
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
        if (target) {
            this.held.delete(slot);
            this.heldRevision++;
        }
        slot.composed = false;
        slot.dirty = true;
        return target;
    }

    private evictSlot(slot: Slot, why: string): number {
        const target = this.unlink(slot);
        if (!target) return 0;
        this.retire(target);
        auditCount(this.audit, `tile:evict:${why}`);
        return target.bytes;
    }

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

    private releaseScale(index: number): void {
        if (index < 0 || this.scaleRefs[index] === 0) return;
        if (--this.scaleRefs[index] > 0) return;
        this.scaleIndexes.delete(this.scaleValue[index]);
        this.scaleValue[index] = NaN;
    }

    private coveredAt(scale: number, slot: Slot): boolean {
        const size = TILE_EDGE / slot.key.scale;
        const x = Math.floor((slot.key.x * TILE_EDGE / slot.key.scale + size / 2) * scale / TILE_EDGE);
        const y = Math.floor((slot.key.y * TILE_EDGE / slot.key.scale + size / 2) * scale / TILE_EDGE);
        const slots = this.byBand.get(slot.key.band)?.get(scale)?.get(posKey(x, y));
        return slots?.some(other => other.key.slice === slot.key.slice && other.composed && other.target !== null) ?? false;
    }
}

export const createTileStore: (host: LayerHost, audit: string) => NumericTileStore = (host, audit) => new GpuTileStore(host, audit);

export function removeTile(store: TileStore, key: TileKey): boolean {
    if (!(store instanceof GpuTileStore)) throw new TypeError('removeTile needs a store from createTileStore');
    return store.remove(key);
}

export function lowerTileKey(key: TileKey): TileKey {
    checkKey(key);
    return { band: key.band, scale: key.scale / 2, x: Math.floor(key.x / 2), y: Math.floor(key.y / 2), slice: key.slice };
}

export type VisibleAcquire = TileEntry | 'lower';

export function acquireVisible(store: TileStore, key: TileKey, blend: Blend, device: GfxDevice): VisibleAcquire {
    return store.acquire(key, blend, device) ?? 'lower';
}
