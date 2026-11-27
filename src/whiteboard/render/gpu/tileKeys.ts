import type { PaintBand } from '../material';

const BAND_BITS = 1, SCALE_BITS = 6, SLICE_BITS = 6, XY_BITS = 20;
const SCALE_MAX = (1 << SCALE_BITS) - 1, SLICE_MAX = (1 << SLICE_BITS) - 1;
const XY_BIAS = 1 << (XY_BITS - 1), XY_SPAN = 1 << XY_BITS;
const XY_MIN = -XY_BIAS, XY_MAX = XY_BIAS - 1;
const TWO_XY = 2 ** XY_BITS;
export const TILE_KEY_REACH = XY_BIAS;
export const TILE_KEY_SLICES = SLICE_MAX + 1;
export const TILE_KEY_SCALES = SCALE_MAX + 1;

/** The scale a tile of a view is composed and keyed at: device pixels per world unit, rounded so a return to a zoom reuses its
 * tiles. The composer and the store both name the view's scale through this one function: the store compared keys against the
 * raw product, so after a divider drag left a camera at a long fraction every tile the composer made was "another scale" to the
 * store, and a trim evicted the tiles a settling board was composing for its view (measured, three dense panes on WebGL2:
 * 3,550 visible tiles evicted and composed again per 10 s at rest, the pane on 'Updating…' for good). */
export function exactTileScale(demand: number): number {
    return Number(demand.toPrecision(12));
}

function bandIndex(band: PaintBand): number {
    if (band === 'underlay') return 0;
    if (band === 'content') return 1;
    throw new RangeError(`Unknown paint band: ${String(band)}`);
}
function field(name: string, value: number, min: number, max: number): number {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new RangeError(`Tile key ${name} out of range [${min}, ${max}]: ${value}`);
    }
    return value;
}

export function tileKeyNum(band: PaintBand, scaleIndex: number, x: number, y: number, slice: number): number {
    const b = bandIndex(band);
    const s = field('scaleIndex', scaleIndex, 0, SCALE_MAX);
    const l = field('slice', slice, 0, SLICE_MAX);
    const tx = field('x', x, XY_MIN, XY_MAX) + XY_BIAS;
    const ty = field('y', y, XY_MIN, XY_MAX) + XY_BIAS;
    return ((((b << SCALE_BITS) | s) << SLICE_BITS | l) * TWO_XY + tx) * TWO_XY + ty;
}

const EMPTY = -1;
function hashOf(k: number): number {
    const lo = k % 4294967296, hi = (k - lo) / 4294967296;
    let h = Math.imul((lo | 0) ^ Math.imul(hi | 0, 0x85ebca6b), 0xc2b2ae35);
    h ^= h >>> 15;
    return h;
}

export class TileKeyMap<V> {
    #keys: Float64Array;
    #values: (V | undefined)[];
    #mask: number;
    #size = 0;
    readonly #valueScratch: V[] = [];

    constructor(initialCapacity = 16) {
        let capacity = 16;
        while (capacity < initialCapacity) capacity *= 2;
        this.#keys = new Float64Array(capacity).fill(EMPTY);
        this.#values = new Array<V | undefined>(capacity);
        this.#mask = capacity - 1;
    }

    get size(): number { return this.#size; }

    #find(k: number): number {
        if (k === EMPTY) return -1;
        const keys = this.#keys, mask = this.#mask;
        for (let i = hashOf(k) & mask; ; i = (i + 1) & mask) {
            const at = keys[i];
            if (at === k) return i;
            if (at === EMPTY) return -1;
        }
    }

    get(k: number): V | undefined {
        const i = this.#find(k);
        return i < 0 ? undefined : this.#values[i];
    }

    has(k: number): boolean { return this.#find(k) >= 0; }

    set(k: number, v: V): void {
        if (!Number.isSafeInteger(k) || k < 0) throw new RangeError(`Tile key must be a non-negative integer: ${k}`);
        const keys = this.#keys, mask = this.#mask;
        for (let i = hashOf(k) & mask; ; i = (i + 1) & mask) {
            const at = keys[i];
            if (at === k) { this.#values[i] = v; return; }
            if (at === EMPTY) break;
        }
        if ((this.#size + 1) * 2 > keys.length) this.#grow();
        this.#insertNew(k, v);
        this.#size++;
    }

    #insertNew(k: number, v: V): void {
        const keys = this.#keys, mask = this.#mask;
        let i = hashOf(k) & mask;
        while (keys[i] !== EMPTY) i = (i + 1) & mask;
        keys[i] = k;
        this.#values[i] = v;
    }

    #grow(): void {
        const oldKeys = this.#keys, oldValues = this.#values;
        const capacity = oldKeys.length * 2;
        this.#keys = new Float64Array(capacity).fill(EMPTY);
        this.#values = new Array<V | undefined>(capacity);
        this.#mask = capacity - 1;
        for (let i = 0; i < oldKeys.length; i++) {
            const k = oldKeys[i];
            if (k !== EMPTY) this.#insertNew(k, oldValues[i] as V);
        }
    }

    delete(k: number): boolean {
        let i = this.#find(k);
        if (i < 0) return false;
        const keys = this.#keys, values = this.#values, mask = this.#mask;
        for (let j = (i + 1) & mask; keys[j] !== EMPTY; j = (j + 1) & mask) {
            const home = hashOf(keys[j]) & mask;
            const stays = i <= j ? (home > i && home <= j) : (home > i || home <= j);
            if (stays) continue;
            keys[i] = keys[j]; values[i] = values[j];
            i = j;
        }
        keys[i] = EMPTY; values[i] = undefined;
        this.#size--;
        return true;
    }

    clear(): void {
        this.#keys.fill(EMPTY);
        this.#values.fill(undefined);
        this.#size = 0;
    }

    /** The live values, in table order, in a scratch array this map reuses: the next call overwrites it, so copy it to
     * keep it. Do not call values() again while still reading a result from it. */
    values(): readonly V[] {
        const out = this.#valueScratch, keys = this.#keys, values = this.#values;
        out.length = 0;
        for (let i = 0; i < keys.length; i++) if (keys[i] !== EMPTY) out.push(values[i] as V);
        return out;
    }
}
