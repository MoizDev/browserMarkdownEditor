import { SWATCHES, type Dash, type Fill, type Font, type Size, type Swatch, type TextAlign } from '../model/styles';
import { DEFAULT_BOARD_PALETTES } from '../render/palette';
import { newNodeId, type NodeId, type SheetId } from '../model/ids';
import { createConnector, createFigure, createGroup, createPicture, createPolyline, createStroke, createText, type Attachment, type ConnectorNode, type Node } from '../model/nodes';
import { createBoardDoc, type BoardDoc } from '../model/doc';
import { UI_DEFAULTS, VIEW_DEFAULTS } from '../model/defaults';
import { NATIVE_VERSION } from '../format/schema';
import { CURVE_VERSION } from '../ink/curve';
import { SampleBuilder, SampleStore } from '../ink/samples';
import type { SampleLease } from '../model/samples';
import type { MediaEntry, MediaId } from '../model/media';
import type { InspectedMedia } from '../media/ingest';
import type { ExcalidrawWireFile } from '../workers/excalidrawClipboard';
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
        const geometry = elementGeometry(element);
        const background = element.backgroundColor === 'transparent' ? null : colour(element.backgroundColor);
        const stroke = element.strokeColor === 'transparent' ? background : colour(element.strokeColor);
        if (!geometry || !stroke || element.backgroundColor !== 'transparent' && !background || !finite(element.strokeWidth, 0.05, 500)) {
            skipped++; ids.delete(sourceId); continue;
        }
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
            label = await plainText(typeof source.originalText === 'string' ? source.originalText : source.text, options.cooperate, options.signal);
            labelColor = textColor; font = style.font; size = style.size; labelScale = style.scale;
            align = style.align; valign = source.verticalAlign === 'top' ? 'start' : source.verticalAlign === 'bottom' ? 'end' : 'middle';
            absorbed.add(labelId as string); ids.set(labelId as string, ids.get(sourceId)!); break;
        }
        const dash: Dash = element.roughness !== 0 ? 'draw' : element.strokeStyle === 'dashed' ? 'dashed' : element.strokeStyle === 'dotted' ? 'dotted' : 'solid';
        const fill: Fill = element.backgroundColor === 'transparent' ? 'none' : element.fillStyle === 'solid' ? 'fill' : 'pattern';
        const figure = createFigure({ id: ids.get(sourceId)!, parent: options.sheet, order: orders[i], page: -1,
            x: geometry.x, y: geometry.y, rotation: geometry.rotation, opacity: geometry.opacity, ext: null,
            shape: element.type, w: geometry.w, h: geometry.h, growY: 0, color: stroke, labelColor, fill, dash, size, font,
            align, valign, label, width: element.strokeWidth, labelScale, flipX: false, flipY: false, url: null });
        if (background && background !== stroke) {
            // A native figure has one paint swatch. A derived group preserves a distinct
            // source fill and outline while keeping the actual foreground binding target.
            const groupId = newNodeId(tables); allocated.add(groupId);
            const backgroundId = newNodeId(tables); allocated.add(backgroundId);
            const childOrders = keysBetween(null, null, 2);
            nodes.push(createGroup({ id: groupId, parent: options.sheet, order: orders[i], page: -1,
                x: geometry.x, y: geometry.y, rotation: geometry.rotation, opacity: geometry.opacity, ext: null }));
            nodes.push(createFigure({ ...figure, id: backgroundId, parent: groupId, order: childOrders[0],
                x: 0, y: 0, rotation: 0, opacity: 1, color: background, label: null, dash: 'solid' }));
            nodes.push(createFigure({ ...figure, parent: groupId, order: childOrders[1],
                x: 0, y: 0, rotation: 0, opacity: 1, fill: 'none' }));
        } else nodes.push(figure);
        if (nodes.length > SECURITY_LIMITS.clipboardNodes) throw new RangeError('Converted Excalidraw node count exceeds limits');
        if ((i & 63) === 63) await yieldHost();
    }
    for (let i = 0; i < elements.length; i++) {
        const element = elements[i], sourceId = element.id;
        if (element.isDeleted === true || typeof sourceId !== 'string' || absorbed.has(sourceId)) continue;
        if (element.type === 'rectangle' || element.type === 'ellipse' || element.type === 'diamond') continue;
        if (element.type !== 'text') { deferred.push({ index: i, element }); continue; }
        const geometry = elementGeometry(element), stroke = colour(element.strokeColor), style = textStyle(element, false);
        if (!geometry || !stroke || !style || typeof element.text !== 'string' || !ids.has(sourceId)) { skipped++; ids.delete(sourceId); continue; }
        const text = await plainText(typeof element.originalText === 'string' ? element.originalText : element.text, options.cooperate, options.signal), width = geometry.w / style.scale;
        if (!finite(width, 1, 1_000_000)) { skipped++; ids.delete(sourceId); continue; }
        nodes.push(createText({ id: ids.get(sourceId)!, parent: options.sheet, order: orders[i], page: -1, x: geometry.x, y: geometry.y,
            rotation: geometry.rotation, opacity: geometry.opacity, ext: null, text, color: stroke, size: style.size, font: style.font,
            align: style.align, autoSize: false, w: width, scale: style.scale }));
        if ((i & 63) === 63) await yieldHost();
    }
    check();
    return { nodes: Object.freeze(nodes), ids, deferred: Object.freeze(deferred), skipped };
}

export interface ExcalidrawBindingRequest {
    readonly targetId: NodeId;
    readonly targetNode: Readonly<Node>;
    readonly endWorld: Readonly<{ x: number; y: number }>;
    readonly nextWorld: Readonly<{ x: number; y: number }>;
    readonly fixedPoint?: readonly [number, number];
    readonly focus?: number;
    readonly gap?: number;
    readonly binding: Readonly<Record<string, unknown>>;
}
export interface FinalExcalidrawDraft {
    readonly sheet: SheetId;
    readonly nodes: readonly Node[];
    readonly samples: SampleStore;
    readonly media: readonly MediaEntry[];
    readonly blobs: ReadonlyMap<MediaId, Blob>;
    readonly skipped: number;
    release(): void;
}
function pointGeometry(element: Readonly<Record<string, unknown>>): { x: number; y: number; rotation: number; opacity: number } | null {
    if (!finite(element.x, -SECURITY_LIMITS.world, SECURITY_LIMITS.world) || !finite(element.y, -SECURITY_LIMITS.world, SECURITY_LIMITS.world)
        || !finite(element.width, 0, 1_000_000) || !finite(element.height, 0, 1_000_000)
        || !finite(element.angle, -1e12, 1e12) || !finite(element.opacity, 0, 100)) return null;
    const rotation = ((element.angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI), c = Math.cos(rotation), s = Math.sin(rotation);
    const hx = element.width / 2, hy = element.height / 2, x = element.x + hx - c * hx + s * hy, y = element.y + hy - s * hx - c * hy;
    return finite(x, -SECURITY_LIMITS.world, SECURITY_LIMITS.world) && finite(y, -SECURITY_LIMITS.world, SECURITY_LIMITS.world)
        ? { x, y, rotation, opacity: element.opacity / 100 } : null;
}
function arrowhead(value: unknown): ConnectorNode['headStart'] | null {
    if (value === null || value === undefined) return 'none';
    if (value === 'arrow' || value === 'triangle' || value === 'diamond' || value === 'dot' || value === 'bar') return value;
    return null;
}
function visibleDash(element: Readonly<Record<string, unknown>>): Dash | null {
    if (!finite(element.roughness, 0, 10) || !['solid', 'dashed', 'dotted'].includes(String(element.strokeStyle))) return null;
    return element.roughness > 0 ? 'draw' : element.strokeStyle === 'dashed' ? 'dashed' : element.strokeStyle === 'dotted' ? 'dotted' : 'solid';
}
/** Both callbacks are real host admission/geometry providers; no image or binding is fabricated here. */
export async function finalizeExcalidrawDraft(draft: ExcalidrawShapeDraft, options: {
    readonly elements: readonly Readonly<Record<string, unknown>>[];
    readonly files: readonly ExcalidrawWireFile[];
    readonly sheet: SheetId;
    readonly signal: AbortSignal;
    current(): boolean;
    cooperate(): Promise<void>;
    inspectImage(file: ExcalidrawWireFile, signal: AbortSignal): Promise<InspectedMedia>;
    resolveBinding(request: ExcalidrawBindingRequest, context: { readonly actualDraftDoc: BoardDoc; readonly signal: AbortSignal }): Promise<Attachment>;
}): Promise<FinalExcalidrawDraft> {
    if (typeof options.inspectImage !== 'function' || typeof options.resolveBinding !== 'function') throw new TypeError('Excalidraw finalization requires real media and binding providers');
    const check = () => { options.signal.throwIfAborted(); if (!options.current()) throw new DOMException('Excalidraw conversion became stale', 'AbortError'); };
    const yieldHost = async () => { check(); await options.cooperate(); check(); };
    const samples = new SampleStore(), leases: SampleLease[] = [], media = new Map<MediaId, MediaEntry>(), blobs = new Map<MediaId, Blob>();
    const ids = new Map(draft.ids), nodes = [...draft.nodes], orders = keysBetween(null, null, options.elements.length);
    const files = new Map(options.files.map(file => [file.fileId, file]));
    const labelsByContainer = new Map<string, Readonly<Record<string, unknown>>[]>(), removed = new Set<NodeId>();
    for (const element of options.elements) if (element.type === 'text' && typeof element.containerId === 'string') {
        let labels = labelsByContainer.get(element.containerId); if (!labels) labelsByContainer.set(element.containerId, labels = []); labels.push(element);
    }
    const bindings: { id: NodeId; terminal: 'start' | 'end'; source: Readonly<Record<string, unknown>> }[] = [];
    let skipped = draft.skipped, held = true;
    const release = () => { if (held) { held = false; for (const lease of leases) lease.release(); leases.length = 0; } };
    try {
        check();
        let work = 0;
        for (const { index, element } of draft.deferred) {
            check(); if ((++work & 63) === 0) await yieldHost();
            const sourceId = element.id;
            if (typeof sourceId !== 'string' || !ids.has(sourceId)) { skipped++; continue; }
            const id = ids.get(sourceId)!, pos = pointGeometry(element), stroke = colour(element.strokeColor);
            if (element.type === 'image') {
                const geometry = elementGeometry(element), file = typeof element.fileId === 'string' ? files.get(element.fileId) : undefined;
                if (!geometry || !file) { skipped++; ids.delete(sourceId); continue; }
                let info: InspectedMedia;
                try { info = await options.inspectImage(file, options.signal); check(); }
                catch { check(); skipped++; ids.delete(sourceId); continue; }
                if (!/^sha256:[0-9a-f]{64}$/.test(info.id) || !info.mime.startsWith('image/') || !finite(info.width, 1, 2 ** 26)
                    || !finite(info.height, 1, 2 ** 26) || info.width * info.height > SECURITY_LIMITS.mediaPixels || info.duration !== null
                    || typeof info.animated !== 'boolean') throw new TypeError('Invalid inspected Excalidraw image');
                const entry: MediaEntry = { id: info.id, mime: info.mime, bytes: file.blob.size, w: info.width, h: info.height,
                    duration: null, animated: info.animated, name: file.fileId, file: null, ext: null };
                const prior = media.get(info.id);
                if (prior && (prior.bytes !== entry.bytes || prior.mime !== entry.mime || prior.w !== entry.w || prior.h !== entry.h || prior.animated !== entry.animated)) throw new Error('Conflicting Excalidraw image metadata');
                const scale = Array.isArray(element.scale) ? element.scale : [1, 1];
                if (scale.length !== 2 || ![1, -1].includes(scale[0] as number) || ![1, -1].includes(scale[1] as number)) { skipped++; ids.delete(sourceId); continue; }
                media.set(info.id, entry); blobs.set(info.id, new Blob([file.blob], { type: info.mime }));
                nodes.push(createPicture({ id, parent: options.sheet, order: orders[index], page: -1, x: geometry.x, y: geometry.y,
                    rotation: geometry.rotation, opacity: geometry.opacity, ext: null, w: geometry.w, h: geometry.h, media: info.id, crop: null,
                    flipX: scale[0] === -1, flipY: scale[1] === -1, alt: '', inverted: false, playing: false, url: null }));
            } else if (element.type === 'arrow' || element.type === 'line' || element.type === 'freedraw') {
                const dash = visibleDash(element), rawPoints = element.points;
                if (!pos || !stroke || !dash || !finite(element.strokeWidth, 0.05, 500) || !Array.isArray(rawPoints)
                    || rawPoints.length < (element.type === 'freedraw' ? 1 : 2) || rawPoints.length > SECURITY_LIMITS.pointsPerStroke) { skipped++; ids.delete(sourceId); continue; }
                const points: { x: number; y: number }[] = [];
                for (let i = 0; i < rawPoints.length; i++) {
                    const item = rawPoints[i];
                    if (!Array.isArray(item) || item.length !== 2 || !finite(item[0], -SECURITY_LIMITS.world, SECURITY_LIMITS.world)
                        || !finite(item[1], -SECURITY_LIMITS.world, SECURITY_LIMITS.world)) throw new TypeError('Invalid Excalidraw point');
                    points.push({ x: item[0], y: item[1] });
                    if ((i & 1023) === 1023) await yieldHost();
                }
                const base = { id, parent: options.sheet, order: orders[index], page: -1, x: pos.x, y: pos.y,
                    rotation: pos.rotation, opacity: pos.opacity, ext: null };
                if (element.type === 'freedraw') {
                    const pressures = element.pressures, real = Array.isArray(pressures) && pressures.length > 0;
                    if (element.simulatePressure === false && !real || real && pressures.length !== points.length) throw new TypeError('Invalid Excalidraw pressure count');
                    const builder = new SampleBuilder({ pressure: real, declaredMaxScale: 1, precision: 'float64' });
                    for (let i = 0; i < points.length; i++) {
                        const pressure = real ? pressures[i] : undefined;
                        if (real && !finite(pressure, 0, 1)) throw new TypeError('Invalid Excalidraw pressure');
                        builder.append(points[i].x, points[i].y, pressure as number | undefined);
                        if ((i & 1023) === 1023) await yieldHost();
                    }
                    const lease = samples.commit(builder); leases.push(lease);
                    nodes.push(createStroke({ ...base, tool: 'pen', samples: lease.ref, pressure: real ? 'real' : 'none',
                        widthModel: real ? { id: 'pressure-linear-v1', rMin: 0, rMax: element.strokeWidth / 2 } : { id: 'uniform' },
                        geomVersion: CURVE_VERSION, fairTol: 0, closed: element.closed === true, width: element.strokeWidth, color: stroke, dash }));
                } else if (points.length > 2) {
                    const line = createPolyline({ ...base, points, spline: 'line', color: stroke, dash,
                        size: sizeFor(element.strokeWidth, [2, 3.5, 5, 10]), width: element.strokeWidth });
                    // Endpoint bindings belong to the native polyline, not a guessed connector replacement.
                    nodes.push({ ...line, startAttach: null, endAttach: null } as typeof line);
                    if (element.startBinding && typeof element.startBinding === 'object' && !Array.isArray(element.startBinding)) bindings.push({ id, terminal: 'start', source: element.startBinding as Record<string, unknown> });
                    if (element.endBinding && typeof element.endBinding === 'object' && !Array.isArray(element.endBinding)) bindings.push({ id, terminal: 'end', source: element.endBinding as Record<string, unknown> });
                } else {
                    const headStart = arrowhead(element.startArrowhead), headEnd = arrowhead(element.endArrowhead);
                    if (!headStart || !headEnd) { skipped++; ids.delete(sourceId); continue; }
                    let label: RichText | null = null, labelColor = stroke, font: Font = 'draw', size: Size = sizeFor(element.strokeWidth, [2, 3.5, 5, 10]), labelScale = 1;
                    for (const entry of labelsByContainer.get(sourceId) ?? []) {
                        if (entry.isDeleted === true || typeof entry.id !== 'string' || typeof entry.text !== 'string') continue;
                        const style = textStyle(entry, true), color = colour(entry.strokeColor);
                        if (!style || !color) continue;
                        label = await plainText(typeof entry.originalText === 'string' ? entry.originalText : entry.text, options.cooperate, options.signal); check();
                        labelColor = color; font = style.font; size = style.size; labelScale = style.scale;
                        const oldId = ids.get(entry.id); if (oldId) removed.add(oldId);
                        ids.set(entry.id, id); break;
                    }
                    nodes.push(createConnector({ ...base, route: 'arc', start: { ...points[0], attach: null }, end: { ...points[1], attach: null },
                        bend: 0, headStart, headEnd, color: stroke, labelColor, fill: 'none', dash, size, font, label, width: element.strokeWidth, labelScale }));
                    if (element.startBinding && typeof element.startBinding === 'object' && !Array.isArray(element.startBinding)) bindings.push({ id, terminal: 'start', source: element.startBinding as Record<string, unknown> });
                    if (element.endBinding && typeof element.endBinding === 'object' && !Array.isArray(element.endBinding)) bindings.push({ id, terminal: 'end', source: element.endBinding as Record<string, unknown> });
                }
            } else { skipped++; ids.delete(sourceId); }
            if (nodes.length - removed.size > SECURITY_LIMITS.clipboardNodes) throw new RangeError('Converted Excalidraw node count exceeds limits');
            if ((index & 63) === 63) await yieldHost();
        }
        const retainedNodes = nodes.filter(node => !removed.has(node.id));
        const actualDraftDoc = createBoardDoc({ kind: 'whiteboard', sheets: [{ id: options.sheet, name: 'External clipboard', order: 'a0', ext: null }],
            nodes: retainedNodes, media: media.values(), host: { kind: 'whiteboard' }, ui: UI_DEFAULTS, view: VIEW_DEFAULTS,
            preserved: { version: NATIVE_VERSION, fields: new Map(), records: [], end: null }, preservedMediaRefs: new Map() });
        const replacements = new Map<NodeId, Node>();
        for (const binding of bindings) {
            check();
            const connector = replacements.get(binding.id) ?? actualDraftDoc.nodes.get(binding.id);
            const targetSource = binding.source.elementId, targetId = typeof targetSource === 'string' ? ids.get(targetSource) : undefined;
            const targetNode = targetId ? actualDraftDoc.nodes.get(targetId) : undefined;
            if (!connector || connector.kind !== 'connector' && connector.kind !== 'polyline' || !targetNode || targetNode.id === connector.id) continue;
            const endpoint = connector.kind === 'connector' ? connector[binding.terminal]
                : connector.points[binding.terminal === 'start' ? 0 : connector.points.length - 1];
            const other = connector.kind === 'connector' ? connector[binding.terminal === 'start' ? 'end' : 'start']
                : connector.points[binding.terminal === 'start' ? 1 : connector.points.length - 2];
            const c = Math.cos(connector.rotation), s = Math.sin(connector.rotation);
            const world = (point: { x: number; y: number }) => ({ x: connector.x + c * point.x - s * point.y, y: connector.y + s * point.x + c * point.y });
            const fixed = binding.source.fixedPoint;
            if (fixed !== undefined && fixed !== null && (!Array.isArray(fixed) || fixed.length !== 2 || !finite(fixed[0], 0, 1) || !finite(fixed[1], 0, 1))) throw new TypeError('Invalid Excalidraw fixed binding point');
            const focus = binding.source.focus, gap = binding.source.gap;
            if (focus !== undefined && !finite(focus, -1, 1) || gap !== undefined && !finite(gap, 0, SECURITY_LIMITS.world)) throw new TypeError('Invalid Excalidraw binding parameters');
            const attachment = await options.resolveBinding({ targetId: targetNode.id, targetNode, endWorld: world(endpoint), nextWorld: world(other),
                ...(Array.isArray(fixed) ? { fixedPoint: [fixed[0] as number, fixed[1] as number] as const } : {}),
                ...(typeof focus === 'number' ? { focus } : {}), ...(typeof gap === 'number' ? { gap } : {}), binding: binding.source },
            { actualDraftDoc, signal: options.signal });
            check();
            if (!attachment || attachment.target !== targetNode.id || !attachment.anchor || !finite(attachment.anchor.x, 0, 1) || !finite(attachment.anchor.y, 0, 1)
                || typeof attachment.exact !== 'boolean' || typeof attachment.precise !== 'boolean' || !['none', 'center', 'edge-point', 'edge'].includes(attachment.snap)) throw new TypeError('Invalid resolved Excalidraw attachment');
            const attached = { ...attachment, anchor: { ...attachment.anchor } };
            replacements.set(connector.id, connector.kind === 'connector'
                ? { ...connector, [binding.terminal]: { ...endpoint, attach: attached } }
                : { ...connector, [binding.terminal === 'start' ? 'startAttach' : 'endAttach']: attached });
        }
        const output = retainedNodes.map(node => replacements.get(node.id) ?? node);
        check();
        return { sheet: options.sheet, nodes: Object.freeze(output), samples, media: Object.freeze([...media.values()]), blobs, skipped, release };
    } catch (error) { release(); throw error; }
}
