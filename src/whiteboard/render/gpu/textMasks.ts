import type { Rgba } from '../../../platform/types';
import type { ByteLease } from '../../../platform/render/gfx/api';
import { auditCount } from '../../../platform/render/renderAudit';
import { colourCss } from '../colour';

// Run masks for the board's GPU text route (solo/whiteboard-text-atlas.md, "Decision after step 2"). A run is one
// PaintFragment; its mask is the same `fillText` paint2d issues, rastered at the exact device size, transform and
// fractional origin the tile draws it at. Nothing here is quantised: a band-scaled mask differed from canvas2d by
// 80–233 levels (b2's test), so the key carries the exact numbers.

/** Padding around a run's ink, in device px: antialiasing and overhang (italics, accents). */
export const MASK_PAD = 2;
/** A mask is rastered in cells this wide and MASK_MAX_HEIGHT tall. A wider or taller run is a grid of such cells, each its own key. */
export const MASK_SLICE = 1024;
/** Cell height. Equal to the atlas page height (textAtlas ATLAS_PAGE), so every cell fits a page whole. */
export const MASK_MAX_HEIGHT = 2048;
/** Most cells one run may take. Beyond it the run is oversize (an extreme zoom): its item falls back to the CPU path, counted. */
const MASK_MAX_CELLS = 16;
/** The one canvas's bytes, which the route reserves from the CPU pool before its first raster. */
export const MASK_CANVAS_BYTES = MASK_SLICE * MASK_MAX_HEIGHT * 4;
/** Measurements kept per font epoch. Cleared whole when full: a run is measured again on its next use, which is cheap. */
const MEASURE_CACHE_LIMIT = 4096;
/** Bytes charged per memo entry beyond the strings it keeps (the entry object, its bucket slot). */
export const MEMO_ENTRY_BYTES = 192;

export interface MaskRequest {
    /** The board's font epoch. A font change makes new keys, and the measurements of the old epoch are dropped on the next measure. */
    readonly epoch: number;
    /** The face's canvas font (the 64 px reference size, fallbacks included). */
    readonly css: string;
    readonly text: string;
    readonly rtl: boolean;
    /** Whether the run's face is loaded (`Face.loaded`). An unloaded face's css is its fallback family: it is never measured
     * into a memo or rastered, and `measure` answers 'deferred' until the face loads and the paint is rebuilt at the new epoch. */
    readonly loaded: boolean;
    /** Device linear map of the glyph run: the view's pixel map · the item's map · face.size / 64. Canvas order (a b c d). */
    readonly a: number;
    readonly b: number;
    readonly c: number;
    readonly d: number;
    /** Device position of the run origin (fragment.x, line.baseline) in the view's pixels. */
    readonly x: number;
    readonly y: number;
}

/** Where a run's mask sits, relative to the origin's whole pixel (floor of its x and y), so one measurement serves every
 * position that shares the key's fractional origin. The quad of cell `i` lands at floor(x) + left + cell.x, floor(y) + top + cell.y,
 * where `sliceCell(geometry, i)` gives the cell. Cells are row-major: column sx, row sy has index sy · columns + sx. */
export interface MaskGeometry {
    readonly left: number;
    readonly top: number;
    readonly w: number;
    readonly h: number;
    /** The fractional part of the origin: part of the key, since it changes the rasterised pixels. */
    readonly fracX: number;
    readonly fracY: number;
    /** Mask px from the mask's left/top edge to the glyph origin's canvas position. */
    readonly originX: number;
    readonly originY: number;
    readonly columns: number;
    readonly rows: number;
    /** The cell count: `columns * rows`, the `sliceCount` every cell of this mask carries. */
    readonly slices: number;
}

/** A cell's place inside its mask, in mask px: its origin and its size (edge cells are smaller). */
export interface MaskCell {
    x: number;
    y: number;
    w: number;
    h: number;
}

export type MaskMeasure =
    | { readonly status: 'ok'; readonly geometry: MaskGeometry }
    | { readonly status: 'empty' }
    | { readonly status: 'oversize' }
    | { readonly status: 'deferred' }
    | { readonly status: 'unsupported'; readonly why: string };

/** One rastered cell. Mono masks are R8 coverage; a run with colour glyphs is RGBA, premultiplied, in its own colour. */
export interface GlyphMask {
    readonly w: number;
    readonly h: number;
    readonly rgba: boolean;
    /** Set on a mono probe whose pixels were not pure coverage: the run must be rastered again in colour. */
    readonly colourGlyphs: boolean;
    readonly pixels: Uint8Array;
}

/** The cell of `geometry` at `sliceIndex`, written into `into` so a frame that draws every cell allocates nothing. */
export function sliceCell(geometry: MaskGeometry, sliceIndex: number, into: MaskCell): MaskCell {
    if (!Number.isInteger(sliceIndex) || sliceIndex < 0 || sliceIndex >= geometry.slices) {
        throw new RangeError(`Mask cell ${sliceIndex} is outside its ${geometry.slices} cells`);
    }
    const sx = sliceIndex % geometry.columns, sy = (sliceIndex - sx) / geometry.columns;
    into.x = sx * MASK_SLICE; into.y = sy * MASK_MAX_HEIGHT;
    into.w = Math.min(MASK_SLICE, geometry.w - into.x);
    into.h = Math.min(MASK_MAX_HEIGHT, geometry.h - into.y);
    return into;
}

/** One rastered cell as an ImageBitmap, which the GPU copies without a readback. `cell` is where the bitmap sits in its mask (mask px);
 * the bitmap is exactly `cell.w × cell.h`. Alpha is the coverage (mono) or the premultiplied colour alpha (colour). The caller closes it. */
export interface MaskBitmap {
    readonly bitmap: ImageBitmap;
    readonly cell: MaskCell;
}

/** Whether a run may draw colour glyphs, judged from its text alone: a colour font is chosen only for emoji code points and
 * their joiners, selectors, keycaps, flags and tags. A run this says yes to is rastered in its ink colour, which is always
 * correct for a mono run too, only larger. Read from the text, because a pixel check would be a readback. */
const COLOUR_CANDIDATE = /[\p{Extended_Pictographic}\p{Regional_Indicator}‍️⃣\u{e0020}-\u{e007f}]/u;
export function needsColourMask(text: string): boolean { return COLOUR_CANDIDATE.test(text); }

export interface MaskRaster {
    measure(req: MaskRequest): MaskMeasure;
    /** One cell of a measured mask, read back to the CPU as pixels. Kept until the GPU route no longer needs it. */
    rasterise(req: MaskRequest, geometry: MaskGeometry, sliceIndex: number, colour: Rgba | null): GlyphMask;
    /** One cell of a measured mask as an ImageBitmap: no readback. `colour` null is a mono run (R8 once the GPU converts it), and
     * is refused for a run that `needsColourMask`; pass the ink colour for those, so the bitmap is RGBA. */
    rasteriseBitmap(req: MaskRequest, geometry: MaskGeometry, sliceIndex: number, colour: Rgba | null): MaskBitmap;
    /** Frees the offscreen canvas and the memo: the bytes return to the pool, and the next raster creates the canvas again. */
    release(): void;
}

/** Everything a mask's pixels depend on, as numbers and references. A lookup fills one reused probe; an entry keeps its own copy. */
export interface MaskIdentity {
    epoch: number;
    css: string;
    text: string;
    rtl: boolean;
    a: number;
    b: number;
    c: number;
    d: number;
    fracX: number;
    fracY: number;
    slice: number;
    colour: Rgba | null;
}
export function newIdentity(): MaskIdentity {
    return { epoch: 0, css: '', text: '', rtl: false, a: 0, b: 0, c: 0, d: 0, fracX: 0, fracY: 0, slice: 0, colour: null };
}
/** Fills `into` with the exact key of one cell of a run. Nothing is quantised: the numbers are compared exactly. */
export function fillIdentity(into: MaskIdentity, req: MaskRequest, slice: number, colour: Rgba | null): MaskIdentity {
    into.epoch = req.epoch; into.css = req.css; into.text = req.text; into.rtl = req.rtl;
    into.a = req.a; into.b = req.b; into.c = req.c; into.d = req.d;
    into.fracX = req.x - Math.floor(req.x); into.fracY = req.y - Math.floor(req.y);
    into.slice = slice; into.colour = colour;
    return into;
}
export function copyIdentity(from: MaskIdentity): MaskIdentity {
    return { ...from };
}
function mixInt(h: number, v: number): number { return Math.imul(h ^ v, 0x01000193); }
function mixNumber(h: number, v: number): number { return mixInt(h, Math.floor(v * 1048576) | 0); }
function mixString(h: number, s: string): number {
    for (let i = 0; i < s.length; i++) h = mixInt(h, s.charCodeAt(i));
    return h;
}
/** A numeric hash of an identity: a bucket, not a key. Equal identities hash equal; unequal ones may collide, so a lookup
 * compares exactly. No string is built, so a lookup allocates nothing. */
export function identityHash(k: MaskIdentity): number {
    let h = 0x811c9dc5;
    h = mixNumber(h, k.epoch); h = mixString(h, k.css); h = mixString(h, k.text); h = mixInt(h, k.rtl ? 1 : 0);
    h = mixNumber(h, k.a); h = mixNumber(h, k.b); h = mixNumber(h, k.c); h = mixNumber(h, k.d);
    h = mixNumber(h, k.fracX); h = mixNumber(h, k.fracY); h = mixNumber(h, k.slice);
    if (k.colour) for (const channel of k.colour) h = mixNumber(h, channel);
    else h = mixInt(h, -1);
    return h >>> 0;
}
export function sameIdentity(x: MaskIdentity, y: MaskIdentity): boolean {
    if (x.epoch !== y.epoch || x.css !== y.css || x.text !== y.text || x.rtl !== y.rtl || x.a !== y.a || x.b !== y.b ||
        x.c !== y.c || x.d !== y.d || x.fracX !== y.fracX || x.fracY !== y.fracY || x.slice !== y.slice) return false;
    if (x.colour === null || y.colour === null) return x.colour === y.colour;
    return x.colour[0] === y.colour[0] && x.colour[1] === y.colour[1] && x.colour[2] === y.colour[2] && x.colour[3] === y.colour[3];
}

/** A value an index holds by identity: its copy of the identity and that identity's hash. */
export interface Indexed { readonly identity: MaskIdentity; readonly hash: number }
/** Values by exact identity, bucketed by numeric hash. Holds no strings: a lookup hashes the probe and compares fields. */
export class KeyedIndex<V extends Indexed> {
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
    clear(): void { this.buckets.clear(); this.count = 0; }
}

/** The paint2d text state, set exactly as paint2d sets it before each fillText (reference/paint2d.ts). */
function setup(ctx: OffscreenCanvasRenderingContext2D, req: MaskRequest, fill: string): void {
    ctx.font = req.css; ctx.direction = req.rtl ? 'rtl' : 'ltr'; ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic'; ctx.fontKerning = 'normal'; ctx.textRendering = 'geometricPrecision';
    ctx.letterSpacing = '0px'; ctx.wordSpacing = '0px'; ctx.fontVariantCaps = 'normal';
    ctx.fillStyle = fill;
}

/** Whole-pixel mask edges: floor of the ink's near edge, ceil of its far edge, plus the pad. */
function edges(origin: number, lo: number, hi: number): { near: number; far: number } {
    return { near: Math.floor(origin + lo) - MASK_PAD, far: Math.ceil(origin + hi) + MASK_PAD };
}

/** Bytes a CPU-side memo holds, leased from the CPU pool in chunks: a memo that cannot charge simply does not grow. */
export interface CpuAccount {
    /** Charges `bytes` against the leased capacity, leasing another chunk when needed; false when the pool refuses. */
    charge(bytes: number): boolean;
    /** Releases every chunk and forgets the charges: called when the memo it accounts for is cleared. */
    reset(): void;
    /** Bytes currently leased. */
    readonly bytes: number;
}
export function createCpuAccount(allocator: { reserve(bytes: number): ByteLease | null; release(lease: ByteLease): void }, chunk: number): CpuAccount {
    const leases: ByteLease[] = [];
    let used = 0, capacity = 0;
    return {
        get bytes(): number { return capacity; },
        charge(bytes: number): boolean {
            while (used + bytes > capacity) {
                const lease = allocator.reserve(chunk);
                if (!lease) return false;
                leases.push(lease); capacity += chunk;
            }
            used += bytes;
            return true;
        },
        reset(): void {
            for (const lease of leases) allocator.release(lease);
            leases.length = 0; used = 0; capacity = 0;
        },
    };
}

interface MeasureEntry extends Indexed { readonly value: MaskMeasure }

/** `account` charges each memoised measurement; a measurement the pool will not charge is computed and not kept, and each such
 * recomputation is counted as `text:measure-uncached` on `audit`, so a pool at its limit shows as a count, not as a silent cost. */
export function createMaskRaster(account?: CpuAccount, audit?: string): MaskRaster {
    // Created on the first raster only: an 8 MB canvas is not worth holding for a board without text.
    let ctx: OffscreenCanvasRenderingContext2D | null = null;
    const measured = new KeyedIndex<MeasureEntry>();
    let measuredEpoch = Number.NaN;
    // One probe and one cell, reused: a measurement or a raster reads them at once and never keeps them.
    const probe = newIdentity();
    const scratchCell: MaskCell = { x: 0, y: 0, w: 0, h: 0 };
    const context = (): OffscreenCanvasRenderingContext2D => {
        if (ctx) return ctx;
        // Read back on the CPU: an accelerated canvas would make every getImageData a GPU readback.
        const made = new OffscreenCanvas(MASK_SLICE, MASK_MAX_HEIGHT).getContext('2d', { willReadFrequently: true });
        if (!made) throw new Error('Offscreen 2D canvas unavailable');
        ctx = made;
        return made;
    };
    const measureUncached = (req: MaskRequest): MaskMeasure => {
        const measureCtx = context();
        setup(measureCtx, req, '#000');
        const m = measureCtx.measureText(req.text);
        const left = m.actualBoundingBoxLeft, right = m.actualBoundingBoxRight;
        const ascent = m.actualBoundingBoxAscent, descent = m.actualBoundingBoxDescent;
        if (!Number.isFinite(left) || !Number.isFinite(right) || !Number.isFinite(ascent) || !Number.isFinite(descent)) {
            return { status: 'unsupported', why: 'metrics' };
        }
        // Ink in the 64 px font's units: x from -left to right, y from -ascent to descent. `setup` sets the run's own
        // direction before measuring, as paint2d does before its fillText, so the box is the one that fillText draws.
        if (left + right <= 0 || ascent + descent <= 0) return { status: 'empty' };
        // The glyph box's corners, mapped by the device linear map (canvas order: x' = a·x + c·y, y' = b·x + d·y).
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (let corner = 0; corner < 4; corner++) {
            const x = corner & 1 ? right : -left, y = corner & 2 ? descent : -ascent;
            const dx = req.a * x + req.c * y, dy = req.b * x + req.d * y;
            minX = Math.min(minX, dx); maxX = Math.max(maxX, dx);
            minY = Math.min(minY, dy); maxY = Math.max(maxY, dy);
        }
        const fracX = req.x - Math.floor(req.x), fracY = req.y - Math.floor(req.y);
        const horizontal = edges(fracX, minX, maxX), vertical = edges(fracY, minY, maxY);
        const w = horizontal.far - horizontal.near, h = vertical.far - vertical.near;
        const columns = Math.ceil(w / MASK_SLICE), rows = Math.ceil(h / MASK_MAX_HEIGHT);
        if (columns * rows > MASK_MAX_CELLS) return { status: 'oversize' };
        return { status: 'ok', geometry: { left: horizontal.near, top: vertical.near, w, h, fracX, fracY,
            originX: fracX - horizontal.near, originY: fracY - vertical.near, columns, rows, slices: columns * rows } };
    };
    /** Draws one cell with the same chain paint2d draws with: the item's device map, translate to the origin, scale size/64, then
     * fillText at 0,0. The canvas is sized to the cell first: setting a size clears it and resets its state, so no clear is needed
     * and a bitmap taken from it is exactly the cell. The cell's origin is the mask's origin less the cell's offset, so glyphs
     * outside the cell fall off the canvas. Mono runs are opaque white, so the pixels carry coverage; colour runs use their ink. */
    const drawCell = (req: MaskRequest, geometry: MaskGeometry, cell: MaskCell, colour: Rgba | null): OffscreenCanvasRenderingContext2D => {
        // A fallback face's css is its fallback family: rastering it would store the wrong glyphs under the loaded face's key.
        if (!req.loaded) throw new Error('A text mask is rastered only from a loaded face');
        const rasterCtx = context();
        rasterCtx.canvas.width = cell.w; rasterCtx.canvas.height = cell.h;
        rasterCtx.setTransform(req.a, req.b, req.c, req.d, geometry.originX - cell.x, geometry.originY - cell.y);
        setup(rasterCtx, req, colour ? colourCss(colour) : '#ffffff');
        rasterCtx.fillText(req.text, 0, 0);
        return rasterCtx;
    };
    return {
        measure(req: MaskRequest): MaskMeasure {
            // A fallback face is not a measurement of this run: it is deferred, and nothing about it is kept.
            if (!req.loaded) return { status: 'deferred' };
            // A new font epoch makes every key new, so the old epoch's measurements are dropped now, not when the memo fills.
            if (req.epoch !== measuredEpoch) {
                measured.clear(); account?.reset(); measuredEpoch = req.epoch;
            }
            // The ink depends on the font (css), the map and the fractional origin, never on the whole-pixel position.
            const key = fillIdentity(probe, req, 0, null);
            const hit = measured.find(key);
            if (hit) return hit.value;
            const result = measureUncached(req);
            if (measured.size >= MEASURE_CACHE_LIMIT) { measured.clear(); account?.reset(); }
            // The entry keeps its two strings, which the paint also holds; charge them so the memo's bytes are honest.
            if (!account || account.charge(MEMO_ENTRY_BYTES + 2 * (req.css.length + req.text.length))) {
                const identity = copyIdentity(key);
                measured.add({ identity, hash: identityHash(identity), value: result });
            } else if (audit) {
                // Not kept: the next prepare of this run measures it again, which is correct and costs one measureText.
                auditCount(audit, 'text:measure-uncached');
            }
            return result;
        },
        rasterise(req: MaskRequest, geometry: MaskGeometry, sliceIndex: number, colour: Rgba | null): GlyphMask {
            const cell = sliceCell(geometry, sliceIndex, scratchCell);
            const { w, h } = cell;
            const rasterCtx = drawCell(req, geometry, cell, colour);
            const data = rasterCtx.getImageData(0, 0, w, h).data;
            const count = w * h;
            if (colour) {
                // Premultiplied, as the texture is sampled: the shader adds no colour.
                const pixels = new Uint8Array(count * 4);
                for (let i = 0; i < count; i++) {
                    const alpha = data[i * 4 + 3];
                    pixels[i * 4] = Math.round(data[i * 4] * alpha / 255);
                    pixels[i * 4 + 1] = Math.round(data[i * 4 + 1] * alpha / 255);
                    pixels[i * 4 + 2] = Math.round(data[i * 4 + 2] * alpha / 255);
                    pixels[i * 4 + 3] = alpha;
                }
                return { w, h, rgba: true, colourGlyphs: false, pixels };
            }
            // White text unpremultiplies to exactly white at every alpha, so any other inked pixel is a colour glyph
            // (emoji ignore fillStyle). A tolerance of 16 keeps the half-level rounding of small alphas out of it.
            const pixels = new Uint8Array(count);
            let colourGlyphs = false;
            for (let i = 0; i < count; i++) {
                const alpha = data[i * 4 + 3];
                pixels[i] = alpha;
                if (alpha >= 32 && (255 - data[i * 4] > 16 || 255 - data[i * 4 + 1] > 16 || 255 - data[i * 4 + 2] > 16)) colourGlyphs = true;
            }
            return { w, h, rgba: false, colourGlyphs, pixels };
        },
        rasteriseBitmap(req: MaskRequest, geometry: MaskGeometry, sliceIndex: number, colour: Rgba | null): MaskBitmap {
            // A mono bitmap of a run that may draw colour glyphs would hold their colour as coverage: refuse it, so the
            // route passes the ink colour for those runs instead of getting a wrong R8 mask.
            if (colour === null && needsColourMask(req.text)) throw new Error('A run that may draw colour glyphs is rastered with its ink colour');
            const cell: MaskCell = { x: 0, y: 0, w: 0, h: 0 };
            sliceCell(geometry, sliceIndex, cell);
            drawCell(req, geometry, cell, colour);
            // Hands the canvas's buffer to the bitmap: no copy and no readback. The canvas allocates a new buffer on its next draw.
            return { bitmap: context().canvas.transferToImageBitmap(), cell };
        },
        release(): void {
            // Setting the size to zero is what frees a canvas's backing store; dropping the reference alone waits for GC.
            if (ctx) { ctx.canvas.width = 0; ctx.canvas.height = 0; ctx = null; }
            measured.clear(); account?.reset(); measuredEpoch = Number.NaN;
        },
    };
}

/** The atlas key for one cell of a run: everything the rasterised pixels depend on, exactly. */
export function maskKey(req: MaskRequest, geometry: MaskGeometry, sliceIndex: number, colour: Rgba | null): string {
    return JSON.stringify([req.epoch, req.css, req.text, req.rtl, req.a, req.b, req.c, req.d,
        geometry.fracX, geometry.fracY, sliceIndex, colour]);
}
