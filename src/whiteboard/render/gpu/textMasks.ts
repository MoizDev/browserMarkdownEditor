import type { Rgba } from '../../../platform/types';
import type { ByteLease } from '../../../platform/render/gfx/api';
import { auditCount } from '../../../platform/render/renderAudit';
import { colourCss } from '../colour';

export const MASK_PAD = 2;
export const MASK_SLICE = 1024;
export const MASK_MAX_HEIGHT = 2048;
const MASK_MAX_CELLS = 16;
const MEASURE_CACHE_LIMIT = 4096;
export const MEMO_ENTRY_BYTES = 192;

export interface MaskRequest {
    readonly epoch: number;
    readonly css: string;
    readonly text: string;
    readonly rtl: boolean;
    readonly loaded: boolean;
    readonly a: number;
    readonly b: number;
    readonly c: number;
    readonly d: number;
    readonly x: number;
    readonly y: number;
}

export interface MaskGeometry {
    readonly left: number;
    readonly top: number;
    readonly w: number;
    readonly h: number;
    readonly fracX: number;
    readonly fracY: number;
    readonly originX: number;
    readonly originY: number;
    readonly columns: number;
    readonly rows: number;
    readonly slices: number;
}

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

export interface GlyphMask {
    readonly w: number;
    readonly h: number;
    readonly rgba: boolean;
    readonly colourGlyphs: boolean;
    readonly pixels: Uint8Array;
}

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

export interface MaskBitmap {
    readonly bitmap: ImageBitmap;
    readonly cell: MaskCell;
}

const COLOUR_CANDIDATE = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u{e0020}-\u{e007f}]|\u200D|\uFE0F|\u20E3/u;
export function needsColourMask(text: string): boolean { return COLOUR_CANDIDATE.test(text); }

export interface MaskRaster {
    measure(req: MaskRequest): MaskMeasure;
    rasterise(req: MaskRequest, geometry: MaskGeometry, sliceIndex: number, colour: Rgba | null): GlyphMask;
    rasteriseBitmap(req: MaskRequest, geometry: MaskGeometry, sliceIndex: number, colour: Rgba | null): MaskBitmap;
    release(): void;
}

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

export interface Indexed { readonly identity: MaskIdentity; readonly hash: number }
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

function setup(ctx: OffscreenCanvasRenderingContext2D, req: MaskRequest, fill: string): void {
    ctx.font = req.css; ctx.direction = req.rtl ? 'rtl' : 'ltr'; ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic'; ctx.fontKerning = 'normal'; ctx.textRendering = 'geometricPrecision';
    ctx.letterSpacing = '0px'; ctx.wordSpacing = '0px'; ctx.fontVariantCaps = 'normal';
    ctx.fillStyle = fill;
}

function edges(origin: number, lo: number, hi: number): { near: number; far: number } {
    return { near: Math.floor(origin + lo) - MASK_PAD, far: Math.ceil(origin + hi) + MASK_PAD };
}

export interface CpuAccount {
    charge(bytes: number): boolean;
    reset(): void;
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

export function createMaskRaster(account?: CpuAccount, audit?: string): MaskRaster {
    let ctx: OffscreenCanvasRenderingContext2D | null = null;
    const measured = new KeyedIndex<MeasureEntry>();
    let measuredEpoch = Number.NaN;
    const probe = newIdentity();
    const scratchCell: MaskCell = { x: 0, y: 0, w: 0, h: 0 };
    const context = (): OffscreenCanvasRenderingContext2D => {
        if (ctx) return ctx;
        const made = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
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
        if (left + right <= 0 || ascent + descent <= 0) return { status: 'empty' };
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
            if (!req.loaded) return { status: 'deferred' };
            if (req.epoch !== measuredEpoch) {
                measured.clear(); account?.reset(); measuredEpoch = req.epoch;
            }
            const key = fillIdentity(probe, req, 0, null);
            const hit = measured.find(key);
            if (hit) return hit.value;
            const result = measureUncached(req);
            if (measured.size >= MEASURE_CACHE_LIMIT) { measured.clear(); account?.reset(); }
            if (!account || account.charge(MEMO_ENTRY_BYTES + 2 * (req.css.length + req.text.length))) {
                const identity = copyIdentity(key);
                measured.add({ identity, hash: identityHash(identity), value: result });
            } else if (audit) {
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
            if (colour === null && needsColourMask(req.text)) throw new Error('A run that may draw colour glyphs is rastered with its ink colour');
            const cell: MaskCell = { x: 0, y: 0, w: 0, h: 0 };
            sliceCell(geometry, sliceIndex, cell);
            drawCell(req, geometry, cell, colour);
            return { bitmap: context().canvas.transferToImageBitmap(), cell };
        },
        release(): void {
            // Setting the size to zero is what frees a canvas's backing store; dropping the reference alone waits for GC.
            if (ctx) { ctx.canvas.width = 0; ctx.canvas.height = 0; ctx = null; }
            measured.clear(); account?.reset(); measuredEpoch = Number.NaN;
        },
    };
}

export function maskKey(req: MaskRequest, geometry: MaskGeometry, sliceIndex: number, colour: Rgba | null): string {
    return JSON.stringify([req.epoch, req.css, req.text, req.rtl, req.a, req.b, req.c, req.d,
        geometry.fracX, geometry.fracY, sliceIndex, colour]);
}
