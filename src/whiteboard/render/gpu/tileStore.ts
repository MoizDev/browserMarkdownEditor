// The board's retained tile cache. One entry per tile position (band, scale, x, y, slice), each holding at most one
// render target (platform/render/tileTarget.ts) charged to the GPU governor through its lease. This file is bookkeeping
// only: the composer (tileComposer.ts) decides what to draw; the store decides what to keep, what to reuse and what to
// give back. Design: planning/60-implementation/gpu-handoff/PLAN.md §3.1–3.2.
import type { Rect } from '../../../platform/types';
import type { TileTarget } from '../../../platform/render/tileTarget';
import type { PaintBand } from '../material';
import { TILE_EDGE, TILE_GUTTER } from '../imageSampling';
import type { Blend, CreateTileStore, TileEntry, TileIdFn, TileKey, TileStore, TileWorldFn } from './contracts';

/** Packed position keys hold (x, y) exactly while both stay within ±2^25 tiles: far past any board, and a lookup outside
 * that range returns NaN, which no stored key can equal, so it misses instead of aliasing a different tile. */
const POS_LIMIT = 2 ** 25;
const POS_STRIDE = 2 ** 26;

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

    get(id: string): TileEntry | undefined {
        return this.byId.get(id);
    }

    touch(entry: TileEntry, frameId: number): void {
        entry.usedFrame = frameId;
    }

    /** Placeholder until step (2) of this package: an empty position keeps no target and so needs no free list yet. */
    putEmpty(key: TileKey): TileEntry {
        const id = tileId(key);
        let slot = this.byId.get(id);
        if (!slot) {
            slot = new Slot(key, id, 'over');
            this.link(slot);
        }
        if (slot.target) throw new Error('tile store: putEmpty over a live target lands with the free list');
        slot.composed = true;
        slot.dirty = false;
        return slot;
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

    /** Placeholder until step (2): acquire needs the free list and the governor's target allocation. */
    acquire(): TileEntry | null {
        throw new Error('tile store: acquire lands in the next commit of this package');
    }

    /** Placeholder until step (3): eviction needs the free list, the view order and the retire path. */
    evict(): number {
        throw new Error('tile store: evict lands in the next commit of this package');
    }

    /** Placeholder until step (3). */
    dropScalesExcept(): number {
        throw new Error('tile store: dropScalesExcept lands in the next commit of this package');
    }

    /** Placeholder until step (2). */
    wait(): void {
        throw new Error('tile store: wait lands in the next commit of this package');
    }

    /** Placeholder until step (3). */
    releaseAll(): void {
        throw new Error('tile store: releaseAll lands in the next commit of this package');
    }

    memory(): { gpuBytes: number; cpuBytes: number } {
        return { gpuBytes: 0, cpuBytes: 0 };
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
}

export const createTileStore: CreateTileStore = () => new GpuTileStore();
