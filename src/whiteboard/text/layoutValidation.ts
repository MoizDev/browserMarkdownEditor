import type { Face, PaintRect, TextLayoutRequest, TextMeasurement, TextPaint } from './paint';
import { projectionLength } from './projection';
import { MAX_TEXT_BLOCKS, MAX_TEXT_LENGTH } from '../model/textLimits';
import { SWATCHES } from '../model/styles';

export interface ValidLayoutProduct {
    readonly paint: TextPaint;
    readonly measurement: TextMeasurement;
    readonly faces: readonly Face[];
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e12;
const nonnegative = (value: unknown): value is number => finite(value) && value >= 0;
const index = (value: unknown, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;
function box(value: unknown): boolean { return record(value) && nonnegative(value.w) && nonnegative(value.h); }
function rect(value: unknown): boolean {
    return record(value) && finite(value.x) && finite(value.y) && nonnegative(value.width) && nonnegative(value.height);
}
function ink(value: unknown): boolean {
    return record(value) && typeof value.swatch === 'string' && (SWATCHES as readonly string[]).includes(value.swatch)
        && (value.role === 'text' || value.role === 'label' || value.role === 'link' || value.role === 'code');
}
function paintRects(value: unknown, max: number): value is readonly PaintRect[] {
    if (!Array.isArray(value) || value.length > max) return false;
    for (let i = 0; i < value.length; i++) {
        const item = value[i];
        if (!record(item) || !finite(item.x) || !finite(item.y) || !nonnegative(item.w) || !nonnegative(item.h) || !ink(item.ink)) return false;
    }
    return true;
}
function range(value: unknown, length: number): value is readonly [number, number] {
    return Array.isArray(value) && value.length === 2 && index(value[0], length) && index(value[1], length) && value[0] <= value[1];
}
function face(value: unknown): value is Face {
    if (!record(value) || !record(value.key)) return false;
    return ['draw', 'sans', 'serif', 'mono'].includes(value.key.family as string)
        && typeof value.key.bold === 'boolean' && typeof value.key.italic === 'boolean'
        && typeof value.loaded === 'boolean' && typeof value.css === 'string' && value.css.length <= 1024
        && nonnegative(value.size) && finite(value.ascent) && finite(value.descent) && finite(value.xHeight);
}

/** Reject malformed work before font loading or canvas allocation in the shared worker. */
export function validLayoutRequest(value: unknown): value is TextLayoutRequest {
    if (!record(value) || typeof value.revision !== 'string' || value.revision.length > 1024
        || !index(value.fontEpoch, Number.MAX_SAFE_INTEGER) || (value.width !== null && !nonnegative(value.width))
        || !record(value.text) || !Array.isArray(value.text.blocks) || !value.text.blocks.length || value.text.blocks.length > MAX_TEXT_BLOCKS
        || !record(value.style) || !record(value.style.padding) || !ink(value.style.ink)) return false;
    const style = value.style, padding = style.padding as Record<string, unknown>;
    if (!['draw', 'sans', 'serif', 'mono'].includes(style.font as string) || !nonnegative(style.size) || style.size === 0
        || !['start', 'middle', 'end'].includes(style.align as string) || !['start', 'middle', 'end'].includes(style.verticalAlign as string)
        || !['allow', 'grapheme', 'shrink'].includes(style.overflow as string) || !nonnegative(style.minHeight)
        || !nonnegative(padding.top) || !nonnegative(padding.right) || !nonnegative(padding.bottom) || !nonnegative(padding.left)
        || (style.maxLines !== undefined && (!index(style.maxLines, MAX_TEXT_BLOCKS) || style.maxLines === 0))
        || (style.ellipsis !== undefined && typeof style.ellipsis !== 'boolean')) return false;
    let length = value.text.blocks.length - 1, runs = 0;
    for (const block of value.text.blocks) {
        if (!record(block) || !['p', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(block.kind as string)
            || !index(block.level, 7) || !['auto', 'ltr', 'rtl'].includes(block.dir as string) || !Array.isArray(block.runs) || !block.runs.length) return false;
        runs += block.runs.length;
        if (runs > 2 * MAX_TEXT_LENGTH + MAX_TEXT_BLOCKS) return false;
        for (const run of block.runs) {
            if (!record(run) || typeof run.text !== 'string' || !record(run.marks)) return false;
            length += run.text.length;
            if (length > MAX_TEXT_LENGTH) return false;
        }
    }
    return true;
}

/** Worker replies are data, not authority over face indices, source offsets, or allocation sizes. */
export function validLayoutProduct(value: unknown, request: TextLayoutRequest): value is ValidLayoutProduct {
    if (!record(value) || !record(value.paint) || !record(value.measurement) || !Array.isArray(value.faces)) return false;
    const paint = value.paint, measurement = value.measurement, faces = value.faces;
    if (faces.length > 100_000 || typeof paint.key !== 'string' || paint.key.length > 4 * MAX_TEXT_LENGTH
        || !index(paint.fontEpoch, Number.MAX_SAFE_INTEGER) || !box(paint.box) || !rect(paint.ink)
        || !box(measurement.box) || !rect(measurement.ink) || !nonnegative(measurement.requiredHeight)
        || !nonnegative(measurement.fontScale) || !Array.isArray(paint.lines)) return false;
    for (let i = 0; i < faces.length; i++) if (!face(faces[i])) return false;
    const length = projectionLength(request.text), blocks = request.text.blocks.length;
    const maxItems = Math.max(64, 8 * (length + blocks + 1));
    if (paint.lines.length > length + blocks + 1 || !paintRects(paint.backgrounds, maxItems)
        || !paintRects(paint.decorations, maxItems)) return false;
    let items = 0, previousEnd = 0;
    for (const line of paint.lines) {
        if (!record(line) || !finite(line.top) || !finite(line.bottom) || line.bottom < line.top || !finite(line.baseline)
            || !finite(line.x) || !range(line.src, length) || line.src[0] < previousEnd
            || (line.direction !== 'ltr' && line.direction !== 'rtl') || !Array.isArray(line.fragments)) return false;
        previousEnd = line.src[1];
        items += line.fragments.length;
        if (items > maxItems) return false;
        for (const fragment of line.fragments) {
            if (!record(fragment) || typeof fragment.text !== 'string' || fragment.text.length > length + 1024
                || !finite(fragment.x) || !nonnegative(fragment.width) || typeof fragment.rtl !== 'boolean'
                || !index(fragment.face, faces.length - 1) || !ink(fragment.ink) || typeof fragment.systemFallback !== 'boolean'
                || !range(fragment.src, length)) return false;
        }
    }
    return true;
}

function sameBox(a: { w: number; h: number }, b: { w: number; h: number }): boolean { return a.w === b.w && a.h === b.h; }
function sameRect(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean {
    return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
function sameInk(a: { swatch: string; role: string }, b: { swatch: string; role: string }): boolean { return a.swatch === b.swatch && a.role === b.role; }
function samePaintRects(a: readonly PaintRect[], b: readonly PaintRect[]): boolean {
    return a.length === b.length && a.every((item, i) => item.x === b[i].x && item.y === b[i].y && item.w === b[i].w && item.h === b[i].h && sameInk(item.ink, b[i].ink));
}
function sameFace(a: Face, b: Face): boolean {
    return a.key.family === b.key.family && a.key.bold === b.key.bold && a.key.italic === b.key.italic
        && a.loaded === b.loaded && a.css === b.css && a.size === b.size && a.ascent === b.ascent && a.descent === b.descent && a.xHeight === b.xHeight;
}
/** Face-table indices and font epochs are worker-local; their resolved visual values must agree. */
export function sameLayoutProduct(a: ValidLayoutProduct, b: ValidLayoutProduct): boolean {
    const x = a.paint, y = b.paint, am = a.measurement, bm = b.measurement;
    if (!sameBox(x.box, y.box) || !sameRect(x.ink, y.ink) || !samePaintRects(x.backgrounds, y.backgrounds)
        || !samePaintRects(x.decorations, y.decorations) || !sameBox(am.box, bm.box) || !sameRect(am.ink, bm.ink)
        || am.requiredHeight !== bm.requiredHeight || am.fontScale !== bm.fontScale || x.lines.length !== y.lines.length) return false;
    for (let i = 0; i < x.lines.length; i++) {
        const l = x.lines[i], r = y.lines[i];
        if (l.top !== r.top || l.bottom !== r.bottom || l.baseline !== r.baseline || l.x !== r.x || l.direction !== r.direction
            || l.src[0] !== r.src[0] || l.src[1] !== r.src[1] || l.fragments.length !== r.fragments.length) return false;
        for (let j = 0; j < l.fragments.length; j++) {
            const f = l.fragments[j], g = r.fragments[j], ff = a.faces[f.face], gf = b.faces[g.face];
            if (!ff || !gf || !sameFace(ff, gf) || f.text !== g.text || f.rtl !== g.rtl || f.systemFallback !== g.systemFallback
                || f.x !== g.x || f.width !== g.width || f.src[0] !== g.src[0] || f.src[1] !== g.src[1] || !sameInk(f.ink, g.ink)) return false;
        }
    }
    return true;
}
