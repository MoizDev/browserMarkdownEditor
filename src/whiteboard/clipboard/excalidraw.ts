import { SWATCHES, type Dash, type Fill, type Font, type Size, type Swatch, type TextAlign } from '../model/styles';
import { DEFAULT_BOARD_PALETTES } from '../render/palette';
import { newNodeId, type NodeId, type SheetId } from '../model/ids';
import { createFigure, createText, type Node } from '../model/nodes';
import { keysBetween } from '../model/orderKey';
import { SECURITY_LIMITS } from '../security/limits';
import type { Block, RichText } from '../text/richText';

// Provenance: clipboard §4.6, CIE 1976 L*a*b* and CIEDE2000 colour-distance
// definitions; independently implemented, no upstream engine source.
type Lab = readonly [number, number, number];
function lab(rgb: readonly [number, number, number]): Lab {
    const linear = (v: number) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    const [r, g, b] = rgb.map(linear);
    const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
    const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
    const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
    const f = (v: number) => v > 216 / 24389 ? Math.cbrt(v) : (24389 / 27 * v + 16) / 116;
    const fx = f(x), fy = f(y), fz = f(z);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
function ciede2000(left: Lab, right: Lab): number {
    const [l1, a1, b1] = left, [l2, a2, b2] = right, rad = Math.PI / 180;
    const c1 = Math.hypot(a1, b1), c2 = Math.hypot(a2, b2), meanC = (c1 + c2) / 2;
    const meanC7 = meanC ** 7, g = (1 - Math.sqrt(meanC7 / (meanC7 + 25 ** 7))) / 2;
    const a1p = (1 + g) * a1, a2p = (1 + g) * a2, c1p = Math.hypot(a1p, b1), c2p = Math.hypot(a2p, b2);
    const hue = (a: number, b: number) => { if (!a && !b) return 0; const h = Math.atan2(b, a) / rad; return h < 0 ? h + 360 : h; };
    const h1 = hue(a1p, b1), h2 = hue(a2p, b2), dl = l2 - l1, dc = c2p - c1p;
    let dh = h2 - h1;
    if (!c1p || !c2p) dh = 0;
    else if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
    const dH = 2 * Math.sqrt(c1p * c2p) * Math.sin(dh * rad / 2), meanL = (l1 + l2) / 2, meanCp = (c1p + c2p) / 2;
    let meanH: number;
    if (!c1p || !c2p) meanH = h1 + h2;
    else if (Math.abs(h1 - h2) <= 180) meanH = (h1 + h2) / 2;
    else meanH = (h1 + h2 + (h1 + h2 < 360 ? 360 : -360)) / 2;
    const t = 1 - 0.17 * Math.cos((meanH - 30) * rad) + 0.24 * Math.cos(2 * meanH * rad)
        + 0.32 * Math.cos((3 * meanH + 6) * rad) - 0.20 * Math.cos((4 * meanH - 63) * rad);
    const dl50 = meanL - 50, sl = 1 + 0.015 * dl50 ** 2 / Math.sqrt(20 + dl50 ** 2);
    const sc = 1 + 0.045 * meanCp, sh = 1 + 0.015 * meanCp * t;
    const c7 = meanCp ** 7, rc = 2 * Math.sqrt(c7 / (c7 + 25 ** 7));
    const rt = -Math.sin(60 * rad * Math.exp(-(((meanH - 275) / 25) ** 2))) * rc;
    const x = dl / sl, y = dc / sc, z = dH / sh;
    return Math.sqrt(Math.max(0, x * x + y * y + z * z + rt * y * z));
}
const PALETTE = SWATCHES.map(swatch => {
    const colour = DEFAULT_BOARD_PALETTES.light.stroke[swatch];
    return { swatch, value: lab([colour[0], colour[1], colour[2]]) };
});
/** Encoded sRGB channels in [0,1]. Black competes normally; exact ties go to lower L*. */
export function nearestExcalidrawSwatch(rgb: readonly [number, number, number]): Swatch {
    if (!rgb || rgb.length !== 3 || !rgb.every(value => Number.isFinite(value) && value >= 0 && value <= 1)) throw new RangeError('Invalid encoded sRGB colour');
    const target = lab(rgb);
    let best = PALETTE[0], distance = ciede2000(target, best.value);
    for (let i = 1; i < PALETTE.length; i++) {
        const candidate = PALETTE[i], next = ciede2000(target, candidate.value);
        if (next < distance || next === distance && candidate.value[0] < best.value[0]) { best = candidate; distance = next; }
    }
    return best.swatch;
}

export interface ExcalidrawShapeDraft {
    readonly nodes: readonly Node[];
    readonly ids: ReadonlyMap<string, NodeId>;
    readonly deferred: readonly Readonly<{ index: number; element: Readonly<Record<string, unknown>> }>[];
    readonly skipped: number;
}
function finite(value: unknown, min: number, max: number): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}
function colour(value: unknown): Swatch | null {
    if (typeof value !== 'string') return null;
    let text = value.trim().toLowerCase();
    if (/^#[0-9a-f]{3}$/.test(text)) text = `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`;
    if (!/^#[0-9a-f]{6}$/.test(text)) return null;
    return nearestExcalidrawSwatch([parseInt(text.slice(1, 3), 16) / 255, parseInt(text.slice(3, 5), 16) / 255, parseInt(text.slice(5, 7), 16) / 255]);
}
function sizeFor(value: number, metrics: readonly number[]): Size {
    const sizes: readonly Size[] = ['s', 'm', 'l', 'xl']; let best = 0;
    for (let i = 1; i < sizes.length; i++) if (Math.abs(metrics[i] - value) < Math.abs(metrics[best] - value)) best = i;
    return sizes[best];
}
function textStyle(value: Readonly<Record<string, unknown>>, label: boolean): { font: Font; size: Size; scale: number; align: TextAlign } | null {
    if (!finite(value.fontSize, 0.18, 4400)) return null;
    const metrics = label ? [18, 22, 26, 32] : [18, 24, 36, 44];
    const size = sizeFor(value.fontSize, metrics), index = ['s', 'm', 'l', 'xl'].indexOf(size), scale = value.fontSize / metrics[index];
    if (!finite(scale, 0.01, 100)) return null;
    const font: Font = value.fontFamily === 1 ? 'draw' : value.fontFamily === 3 ? 'mono' : value.fontFamily === 4 ? 'serif' : 'sans';
    const align: TextAlign = value.textAlign === 'center' ? 'middle' : value.textAlign === 'right' ? 'end' : 'start';
    return { font, size, scale, align };
}
async function plainText(text: string, cooperate: () => Promise<void>, signal: AbortSignal): Promise<RichText> {
    if (text.length > SECURITY_LIMITS.textCharacters) throw new RangeError('Excalidraw text exceeds limits');
    const blocks: Block[] = []; let from = 0, work = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c === 10 || c === 13) {
            if (blocks.length >= 99_999) throw new RangeError('Excalidraw text block count exceeds limits');
            blocks.push({ kind: 'p', level: 0, dir: 'auto', runs: [{ text: text.slice(from, i), marks: {} }] });
            if (c === 13 && text.charCodeAt(i + 1) === 10) i++; from = i + 1;
        }
        if ((++work & 4095) === 0) { signal.throwIfAborted(); await cooperate(); signal.throwIfAborted(); }
    }
    blocks.push({ kind: 'p', level: 0, dir: 'auto', runs: [{ text: text.slice(from), marks: {} }] });
    return { blocks };
}
function elementGeometry(element: Readonly<Record<string, unknown>>): { x: number; y: number; w: number; h: number; rotation: number; opacity: number } | null {
    if (!finite(element.x, -SECURITY_LIMITS.world, SECURITY_LIMITS.world) || !finite(element.y, -SECURITY_LIMITS.world, SECURITY_LIMITS.world)
        || !finite(element.width, 1, 1_000_000) || !finite(element.height, 1, 1_000_000)
        || !finite(element.angle, -1e12, 1e12) || !finite(element.opacity, 0, 100)) return null;
    const rotation = ((element.angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const c = Math.cos(rotation), s = Math.sin(rotation), hx = element.width / 2, hy = element.height / 2;
    const x = element.x + hx - c * hx + s * hy, y = element.y + hy - s * hx - c * hy;
    if (!finite(x, -SECURITY_LIMITS.world, SECURITY_LIMITS.world) || !finite(y, -SECURITY_LIMITS.world, SECURITY_LIMITS.world)) return null;
    return { x, y, w: element.width, h: element.height, rotation, opacity: element.opacity / 100 };
}
/** Converts only figures and standalone/bound text; other wire elements remain explicit deferred input. */
export async function convertExcalidrawShapes(elements: readonly Readonly<Record<string, unknown>>[], options: {
    readonly sheet: SheetId; readonly signal: AbortSignal; cooperate(): Promise<void>;
}): Promise<ExcalidrawShapeDraft> {
    if (elements.length > SECURITY_LIMITS.clipboardNodes) throw new RangeError('Excalidraw element count exceeds limits');
    const check = () => options.signal.throwIfAborted(), yieldHost = async () => { check(); await options.cooperate(); check(); };
    check();
    const ids = new Map<string, NodeId>(), allocated = new Set<NodeId>(), indexed = new Map<string, Readonly<Record<string, unknown>>>();
    const labelsByContainer = new Map<string, string[]>();
    const tables = { nodes: { has: (id: NodeId) => allocated.has(id) }, sheets: { has: (id: SheetId) => id === options.sheet } };
    for (let i = 0; i < elements.length; i++) {
        const item = elements[i], id = item.id;
        if (typeof id === 'string' && id.length > 0 && id.length <= SECURITY_LIMITS.idCharacters) {
            if (indexed.has(id)) throw new TypeError('Duplicate Excalidraw element id');
            indexed.set(id, item);
            if (item.type === 'text' && typeof item.containerId === 'string') {
                let labels = labelsByContainer.get(item.containerId); if (!labels) labelsByContainer.set(item.containerId, labels = []); labels.push(id);
            }
            if (item.isDeleted !== true) { const fresh = newNodeId(tables); allocated.add(fresh); ids.set(id, fresh); }
        }
        if ((i & 255) === 255) await yieldHost();
    }
    const orders = keysBetween(null, null, elements.length), nodes: Node[] = [], deferred: { index: number; element: Readonly<Record<string, unknown>> }[] = [];
    const absorbed = new Set<string>(); let skipped = 0;
    for (let i = 0; i < elements.length; i++) {
        const element = elements[i], sourceId = element.id;
        if (element.isDeleted === true) continue;
        if (typeof sourceId !== 'string' || !ids.has(sourceId)) { skipped++; continue; }
        if (element.type !== 'rectangle' && element.type !== 'ellipse' && element.type !== 'diamond') continue;
        const geometry = elementGeometry(element), stroke = colour(element.strokeColor);
        if (!geometry || !stroke || !finite(element.strokeWidth, 0.05, 500)) { skipped++; ids.delete(sourceId); continue; }
        let label: RichText | null = null, labelColor = stroke, font: Font = 'draw', size: Size = 's', labelScale = 1;
        let align: 'start' | 'middle' | 'end' = 'middle', valign: 'start' | 'middle' | 'end' = 'middle';
        const bound = [...(Array.isArray(element.boundElements) ? element.boundElements : []),
            ...(labelsByContainer.get(sourceId) ?? []).map(id => ({ type: 'text', id }))];
        for (const ref of bound) {
            if (!ref || typeof ref !== 'object' || (ref as Record<string, unknown>).type !== 'text') continue;
            const labelId = (ref as Record<string, unknown>).id, source = typeof labelId === 'string' ? indexed.get(labelId) : undefined;
            if (!source || source.type !== 'text' || source.containerId !== sourceId || source.isDeleted === true || typeof source.text !== 'string') continue;
            const style = textStyle(source, true), textColor = colour(source.strokeColor);
            if (!style || !textColor) continue;
            label = await plainText(source.text, options.cooperate, options.signal); labelColor = textColor; font = style.font; size = style.size; labelScale = style.scale;
            align = style.align; valign = source.verticalAlign === 'top' ? 'start' : source.verticalAlign === 'bottom' ? 'end' : 'middle';
            absorbed.add(labelId as string); ids.set(labelId as string, ids.get(sourceId)!); break;
        }
        const dash: Dash = element.roughness !== 0 ? 'draw' : element.strokeStyle === 'dashed' ? 'dashed' : element.strokeStyle === 'dotted' ? 'dotted' : 'solid';
        const fill: Fill = element.backgroundColor === 'transparent' ? 'none' : element.fillStyle === 'solid' ? 'fill' : 'pattern';
        nodes.push(createFigure({ id: ids.get(sourceId)!, parent: options.sheet, order: orders[i], page: -1,
            x: geometry.x, y: geometry.y, rotation: geometry.rotation, opacity: geometry.opacity, ext: null,
            shape: element.type, w: geometry.w, h: geometry.h, growY: 0, color: stroke, labelColor, fill, dash, size, font,
            align, valign, label, width: element.strokeWidth, labelScale, flipX: false, flipY: false, url: null }));
        if ((i & 63) === 63) await yieldHost();
    }
    for (let i = 0; i < elements.length; i++) {
        const element = elements[i], sourceId = element.id;
        if (element.isDeleted === true || typeof sourceId !== 'string' || absorbed.has(sourceId)) continue;
        if (element.type === 'rectangle' || element.type === 'ellipse' || element.type === 'diamond') continue;
        if (element.type !== 'text') { deferred.push({ index: i, element }); continue; }
        const geometry = elementGeometry(element), stroke = colour(element.strokeColor), style = textStyle(element, false);
        if (!geometry || !stroke || !style || typeof element.text !== 'string' || !ids.has(sourceId)) { skipped++; ids.delete(sourceId); continue; }
        const text = await plainText(element.text, options.cooperate, options.signal), width = geometry.w / style.scale;
        if (!finite(width, 1, 1_000_000)) { skipped++; ids.delete(sourceId); continue; }
        nodes.push(createText({ id: ids.get(sourceId)!, parent: options.sheet, order: orders[i], page: -1, x: geometry.x, y: geometry.y,
            rotation: geometry.rotation, opacity: geometry.opacity, ext: null, text, color: stroke, size: style.size, font: style.font,
            align: style.align, autoSize: false, w: width, scale: style.scale }));
        if ((i & 63) === 63) await yieldHost();
    }
    check();
    return { nodes: Object.freeze(nodes), ids, deferred: Object.freeze(deferred), skipped };
}
