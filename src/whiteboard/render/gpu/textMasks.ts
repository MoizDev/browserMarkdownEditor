import type { Rgba } from '../../../platform/types';
import { colourCss } from '../colour';

// Run masks for the board's GPU text route (solo/whiteboard-text-atlas.md, "Decision after step 2"). A run is one
// PaintFragment; its mask is the same `fillText` paint2d issues, rastered at the exact device size, transform and
// fractional origin the tile draws it at. Nothing here is quantised: a band-scaled mask differed from canvas2d by
// 80–233 levels (b2's test), so the key carries the exact numbers.

/** Padding around a run's ink, in device px: antialiasing and overhang (italics, accents). */
export const MASK_PAD = 2;
/** Widest mask rastered in one piece. A wider run is rastered in x-slices of this width, each slice its own key. */
export const MASK_SLICE = 1024;
/** Tallest mask. A glyph box taller than this is not a mask; its item falls back to the composer's CPU path. */
export const MASK_MAX_HEIGHT = 2048;
/** Widest run that is rastered as slices: beyond this many slices the run is oversize (an extreme zoom). */
const MASK_MAX_SLICES = 8;

export interface MaskRequest {
    /** The board's font epoch. A font change makes new keys; the old masks age out of the atlas. */
    readonly epoch: number;
    /** The face's canvas font (the 64 px reference size, fallbacks included). */
    readonly css: string;
    readonly text: string;
    readonly rtl: boolean;
    /** Device linear map of the glyph run: the view's pixel map · the item's map · face.size / 64. Canvas order (a b c d). */
    readonly a: number;
    readonly b: number;
    readonly c: number;
    readonly d: number;
    /** Device position of the run origin (fragment.x, line.baseline) in the view's pixels. */
    readonly x: number;
    readonly y: number;
}

/** Where a run's mask sits. `x`/`y` are absolute view pixels: whole pixels, so the quad samples the mask 1:1. */
export interface MaskGeometry {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
    /** The fractional part of the origin: part of the key, since it changes the rasterised pixels. */
    readonly fracX: number;
    readonly fracY: number;
    /** Mask px from the mask's left/top edge to the glyph origin's canvas position. */
    readonly originX: number;
    readonly originY: number;
    readonly slices: number;
}

export type MaskMeasure =
    | { readonly status: 'ok'; readonly geometry: MaskGeometry }
    | { readonly status: 'empty' }
    | { readonly status: 'oversize' }
    | { readonly status: 'unsupported'; readonly why: string };

/** One rastered slice. Mono masks are R8 coverage; a run with colour glyphs is RGBA, premultiplied, in its own colour. */
export interface GlyphMask {
    readonly w: number;
    readonly h: number;
    readonly rgba: boolean;
    /** Set on a mono probe whose pixels were not pure coverage: the run must be rastered again in colour. */
    readonly colourGlyphs: boolean;
    readonly pixels: Uint8Array;
}

/** One reusable offscreen canvas, MASK_SLICE × MASK_MAX_HEIGHT, sized once so a raster never reallocates it. */
export interface MaskRaster {
    readonly bytes: number;
    measure(req: MaskRequest): MaskMeasure;
    rasterise(req: MaskRequest, geometry: MaskGeometry, slice: number, colour: Rgba | null): GlyphMask;
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

export function createMaskRaster(): MaskRaster {
    // Created on the first raster only: an 8 MB canvas is not worth holding for a board without text.
    let canvas: OffscreenCanvas | null = null;
    let ctx: OffscreenCanvasRenderingContext2D | null = null;
    const context = (): OffscreenCanvasRenderingContext2D => {
        if (ctx) return ctx;
        canvas = new OffscreenCanvas(MASK_SLICE, MASK_MAX_HEIGHT);
        // Read back on the CPU: an accelerated canvas would make every getImageData a GPU readback.
        const made = canvas.getContext('2d', { willReadFrequently: true });
        if (!made) throw new Error('Offscreen 2D canvas unavailable');
        ctx = made;
        return made;
    };
    return {
        get bytes(): number { return canvas ? MASK_SLICE * MASK_MAX_HEIGHT * 4 : 0; },
        measure(req: MaskRequest): MaskMeasure {
            const measureCtx = context();
            setup(measureCtx, req, '#000');
            const m = measureCtx.measureText(req.text);
            const left = m.actualBoundingBoxLeft, right = m.actualBoundingBoxRight;
            const ascent = m.actualBoundingBoxAscent, descent = m.actualBoundingBoxDescent;
            if (!Number.isFinite(left) || !Number.isFinite(right) || !Number.isFinite(ascent) || !Number.isFinite(descent)) {
                return { status: 'unsupported', why: 'metrics' };
            }
            // Ink in the 64 px font's units: x from -left to right, y from -ascent to descent.
            if (left + right <= 0 || ascent + descent <= 0) return { status: 'empty' };
            // The glyph box's corners, mapped by the device linear map (canvas order: x' = a·x + c·y, y' = b·x + d·y).
            const corners = [[-left, -ascent], [right, -ascent], [-left, descent], [right, descent]];
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            for (const [x, y] of corners) {
                const dx = req.a * x + req.c * y, dy = req.b * x + req.d * y;
                minX = Math.min(minX, dx); maxX = Math.max(maxX, dx);
                minY = Math.min(minY, dy); maxY = Math.max(maxY, dy);
            }
            const fracX = req.x - Math.floor(req.x), fracY = req.y - Math.floor(req.y);
            const horizontal = edges(fracX, minX, maxX), vertical = edges(fracY, minY, maxY);
            const w = horizontal.far - horizontal.near, h = vertical.far - vertical.near;
            if (h > MASK_MAX_HEIGHT || Math.ceil(w / MASK_SLICE) > MASK_MAX_SLICES) return { status: 'oversize' };
            return { status: 'ok', geometry: { x: Math.floor(req.x) + horizontal.near, y: Math.floor(req.y) + vertical.near,
                w, h, fracX, fracY, originX: fracX - horizontal.near, originY: fracY - vertical.near,
                slices: Math.ceil(w / MASK_SLICE) } };
        },
        rasterise(req: MaskRequest, geometry: MaskGeometry, slice: number, colour: Rgba | null): GlyphMask {
            const rasterCtx = context();
            const sliceStart = slice * MASK_SLICE;
            const w = Math.min(MASK_SLICE, geometry.w - sliceStart), h = geometry.h;
            rasterCtx.setTransform(1, 0, 0, 1, 0, 0);
            rasterCtx.clearRect(0, 0, w, h);
            // The same chain paint2d draws with: the item's device map, translate to the origin, scale size/64, then fillText at 0,0.
            rasterCtx.setTransform(req.a, req.b, req.c, req.d, geometry.originX - sliceStart, geometry.originY);
            // Opaque white for coverage, so the probe reads alpha; a colour run is drawn in its own colour, colour glyphs included.
            setup(rasterCtx, req, colour ? colourCss(colour) : '#ffffff');
            rasterCtx.fillText(req.text, 0, 0);
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
    };
}

/** The atlas key for one slice of a run: everything the rasterised pixels depend on, exactly. */
export function maskKey(req: MaskRequest, geometry: MaskGeometry, slice: number, colour: Rgba | null): string {
    return JSON.stringify([req.epoch, req.css, req.text, req.rtl, req.a, req.b, req.c, req.d,
        geometry.fracX, geometry.fracY, slice, colour]);
}
