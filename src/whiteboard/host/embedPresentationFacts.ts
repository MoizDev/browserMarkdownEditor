import type { PlatformPresentation } from '../../platform/render/attachPlatformPane.types';
import type { EmbedClippedCoverage, EmbedCoveragePath, EmbedLaterPaint, EmbedPresentationFrame, EmbedPresentationPort,
    EmbedPresentedNode } from '../../platform/render/embedPresentation.types';
import type { ByteLease } from '../../platform/render/gfx/api';
import { auditCount, renderAuditEnabled } from '../../platform/render/renderAudit';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { FrameToken, RenderToken } from '../../platform/render/types';
import type { Affine, PathCommand, Rect } from '../../platform/types';
import type { AlphaTraceReply, AlphaTraceRequest } from '../export/alphaWorkerHandler';
import { createStreamingExportTextPieces } from '../export/textStreamResolver';
import { compose, transformPoint } from '../geom/affine';
import { coverageOutline } from '../ink/outline';
import { isSheetParent, type BoardDoc } from '../model/doc';
import type { NodeId } from '../model/ids';
import type { EmbedNode } from '../model/nodes';
import type { PathMaterial, StrokeMaterial } from '../render/material';
import { inkCoverageChunks, type PaintClip, type PaintImageItem, type PaintItem, type PaintNodeSource,
    type PaintSource, type PaintTextItem } from '../render/paintStream';
import { paintItemsOf } from '../render/paintWindows';
import type { PresentedImage, PresentedImageLease, ViewerPaintPresentation as Presentation } from '../render/paintPresentation';
import { imageLaterPaint } from '../render/presentedImageFacts';
import { readAlphaPlane, type DeviceRect } from '../render/imageSampling';
import { boardWorker } from '../workers/client';
import type { BoardJobIdentity } from '../workers/protocol';

export type NativeEmbedPresented = (revision: number, token: RenderToken, frame?: PaintSource, context?: Presentation) => void;

export interface NativeEmbedPresentationOptions {
    readonly port: EmbedPresentationPort;
    readonly memory: MemoryAllocator;
    readonly onError: (error: unknown) => void;
}
export interface NativeEmbedPresentationProducer {
    readonly presented: NativeEmbedPresented;
    onPresentation(presentation: PlatformPresentation | null): void;
    dispose(): void;
}

interface Pending {
    readonly revision: number;
    readonly token: RenderToken;
    readonly frame: PaintSource;
    readonly context: Presentation;
    readonly releaseRaw: () => void;
    readonly drawn: PresentedImageLease | null;
}
interface Building {
    readonly pending: Pending;
    readonly controller: AbortController;
    readonly key: BuildKey;
    readonly presentation: PlatformPresentation;
}

const MAX_COVERAGE_RECTS = 1 << 16;
const RESULT_BYTES = 2 * MAX_COVERAGE_RECTS * 4 * 8;
const RASTER_TILE_BYTES = 1024 * 1024 * 5;

const sameRender = (a: RenderToken, b: RenderToken) => a.vaultEpoch === b.vaultEpoch && a.documentId === b.documentId
    && a.bytesGeneration === b.bytesGeneration && a.session === b.session;

interface Holds {
    readonly reservations: ByteLease[];
    readonly requests: Promise<unknown>[];
}
interface Coverage {
    readonly pane: Affine;
    readonly dpr: number;
    readonly signal: AbortSignal;
    readonly memory: MemoryAllocator;
    readonly owner: BoardJobIdentity;
    readonly holds: Holds;
    readonly live: () => boolean;
    readonly deviceScale: number;
    readonly drawn: ReadonlyMap<PaintItem, PresentedImage>;
}
interface LaterCoverage {
    readonly opaque: EmbedLaterPaint[];
    readonly partial: Rect[];
}
const emptyCoverage = (): LaterCoverage => ({ opaque: [], partial: [] });
const UNKNOWN_LATER: EmbedLaterPaint = Object.freeze({ opacity: 'unknown' });

function quadBounds(localToWorld: Affine, w: number, h: number): Rect {
    return rectWorld(0, 0, w, h, localToWorld);
}
function rectWorld(x0: number, y0: number, x1: number, y1: number, matrix: Affine): Rect {
    const corners = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => transformPoint(matrix, { x, y }));
    const minX = Math.min(...corners.map(p => p.x)), maxX = Math.max(...corners.map(p => p.x));
    const minY = Math.min(...corners.map(p => p.y)), maxY = Math.max(...corners.map(p => p.y));
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
function overlaps(a: Rect, b: Rect): boolean {
    return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}
function intersect(a: Rect, b: Rect): Rect | null {
    const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
    const x1 = Math.min(a.x + a.width, b.x + b.width), y1 = Math.min(a.y + a.height, b.y + b.height);
    return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}
function pathWorldBounds(d: readonly Readonly<PathCommand>[], localToWorld: Affine, pad: number): Rect | null {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const take = (x: number, y: number) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
    for (const command of d) {
        if (command[0] === 'M' || command[0] === 'L') take(command[1], command[2]);
        else if (command[0] === 'C') { take(command[1], command[2]); take(command[3], command[4]); take(command[5], command[6]); }
    }
    if (x0 > x1) return null;
    return rectWorld(x0 - pad, y0 - pad, x1 + pad, y1 + pad, localToWorld);
}
function clipped(region: Rect, clips: readonly PaintClip[]): Rect | null {
    let out: Rect | null = region;
    for (const clip of clips) {
        const bounds = pathWorldBounds(clip.d, clip.localToWorld, 0);
        out = out && bounds ? intersect(out, bounds) : null;
    }
    return out;
}
function pushPartial(acc: LaterCoverage, region: Rect | null, clips: readonly PaintClip[]): void {
    const cut = region && clipped(region, clips);
    if (cut) acc.partial.push(cut);
}
function clipsOf(clips: readonly PaintClip[], pane: Affine): readonly EmbedCoveragePath[] {
    return clips.map(clip => ({ d: clip.d, fillRule: clip.fillRule, toPane: compose(pane, clip.localToWorld) }));
}
function inheritedOpacity(doc: BoardDoc, node: EmbedNode): number {
    let value = node.opacity, parent = node.parent;
    for (let depth = 0; depth <= 64 && !isSheetParent(doc, parent); depth++) {
        const ancestor = doc.nodes.get(parent as NodeId); if (!ancestor) throw new Error(`Embed ancestor is missing: ${node.id}`);
        value *= ancestor.opacity; parent = ancestor.parent;
    }
    return value;
}

interface EmbedCard { readonly nodeId: string; readonly index: number; readonly item: PaintItem; readonly node: EmbedNode; readonly world: Rect }
function embedCards(doc: BoardDoc, source: PaintSource): readonly EmbedCard[] {
    const first = new Map<string, { index: number; item: PaintItem }>();
    let index = 0;
    for (const item of paintItemsOf(source)) {
        if (!first.has(item.nodeId) && doc.nodes.get(item.nodeId as NodeId)?.kind === 'embed') first.set(item.nodeId, { index, item });
        index++;
    }
    return [...first].map(([nodeId, { index: at, item }]) => {
        const node = doc.nodes.get(nodeId as NodeId) as EmbedNode;
        return { nodeId, index: at, item, node, world: quadBounds(item.localToWorld, node.w, node.h) };
    });
}
function laterItemBounds(item: PaintItem, nodeId: string): Rect {
    if (!item.allocationBounds) throw new Error(`Later paint over embed ${nodeId} has no allocation bounds`);
    return item.allocationBounds;
}

function strokeParams(stroke: StrokeMaterial): NonNullable<EmbedClippedCoverage['stroke']> {
    return Object.freeze({ width: stroke.width, cap: stroke.cap, join: stroke.join, miterLimit: stroke.miterLimit,
        ...(stroke.dash ? { dash: stroke.dash.array, dashPhase: stroke.dash.phase } : {}) });
}
function pathCoverage(acc: LaterCoverage, d: readonly Readonly<PathCommand>[], fillRule: 'nonzero' | 'evenodd', material: PathMaterial,
    localToWorld: Affine, pane: Affine, clips: readonly PaintClip[]): void {
    const { fill, stroke } = material, strokeOn = !!stroke && stroke.width > 0;
    if (!fill && !strokeOn) return;
    if ((fill && fill[3] < 1) || (strokeOn && stroke.color[3] < 1) || material.blend !== 'normal') {
        const pad = strokeOn ? stroke.width * Math.max(1, stroke.miterLimit) / 2 : 0;
        pushPartial(acc, pathWorldBounds(d, localToWorld, pad), clips);
        return;
    }
    acc.opaque.push({ opacity: 'opaque', coverage: { path: { d, fillRule, toPane: compose(pane, localToWorld) }, fill: !!fill,
        ...(strokeOn ? { stroke: strokeParams(stroke) } : {}), clips: clipsOf(clips, pane) } });
}
function syncCoverage(item: PaintItem, embedId: string, pane: Affine, deviceScale: number): LaterCoverage {
    const acc = emptyCoverage();
    if (item.kind === 'ink') {
        if (item.material.blend !== 'normal' || item.material.color[3] < 1) {
            pushPartial(acc, laterItemBounds(item, embedId), item.clips);
            return acc;
        }
        const toPane = compose(pane, item.localToWorld), clips = clipsOf(item.clips, pane);
        for (const chunk of inkCoverageChunks(item.coverage)) {
            acc.opaque.push({ opacity: 'opaque', coverage: { path: { d: coverageOutline(chunk, deviceScale), fillRule: 'nonzero', toPane }, clips } });
        }
        return acc;
    }
    if (item.kind !== 'path') throw new Error(`Later ${item.kind} paint over embed ${embedId} needs its canonical coverage producer`);
    pathCoverage(acc, item.d, item.fillRule, item.material, item.localToWorld, pane, item.clips);
    return acc;
}

function maskMatrix(rect: Rect, crop: Rect, origin: { x: number; y: number }): Affine {
    const kx = rect.width / crop.width, ky = rect.height / crop.height;
    return [kx, 0, 0, ky, rect.x + (origin.x - crop.x) * kx, rect.y + (origin.y - crop.y) * ky];
}
function enclosing(crop: Rect, width: number, height: number): Rect {
    const x0 = Math.max(0, Math.floor(crop.x)), y0 = Math.max(0, Math.floor(crop.y));
    const x1 = Math.min(width, Math.ceil(crop.x + crop.width)), y1 = Math.min(height, Math.ceil(crop.y + crop.height));
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
type Seams = Readonly<{ left: boolean; right: boolean; top: boolean; bottom: boolean }>;
function imageSeams(crop: Rect, width: number, height: number, kind: 'picture' | 'dense' | 'raster'): Seams {
    if (kind === 'raster') return { left: true, right: true, top: true, bottom: true };
    const right = crop.x + crop.width, bottom = crop.y + crop.height;
    const apron = kind === 'dense';
    return {
        left: !Number.isInteger(crop.x) || (apron && crop.x < 1),
        right: !Number.isInteger(right) || (apron && width - right < 1),
        top: !Number.isInteger(crop.y) || (apron && crop.y < 1),
        bottom: !Number.isInteger(bottom) || (apron && height - bottom < 1),
    };
}
function pictureCover(rect: Rect, texel: { x: number; y: number }, device: { x: number; y: number }, seams: Seams): Rect | null {
    const dx = Math.max(device.x, texel.x), dy = Math.max(device.y, texel.y);
    const left = seams.left ? dx : 0, right = seams.right ? dx : 0, top = seams.top ? dy : 0, bottom = seams.bottom ? dy : 0;
    const width = rect.width - left - right, height = rect.height - top - bottom;
    return width > 0 && height > 0 ? { x: rect.x + left, y: rect.y + top, width, height } : null;
}
function devicePixel(localToWorld: Affine, deviceScale: number): { x: number; y: number } {
    return { x: 1 / (Math.hypot(localToWorld[0], localToWorld[1]) * deviceScale), y: 1 / (Math.hypot(localToWorld[2], localToWorld[3]) * deviceScale) };
}
function wholePixels(crop: Rect, width: number, height: number): boolean {
    return [crop.x, crop.y, crop.width, crop.height].every(Number.isFinite) && crop.x >= 0 && crop.y >= 0
        && crop.width > 0 && crop.height > 0 && crop.x + crop.width <= width && crop.y + crop.height <= height;
}
function send(cx: Coverage, payload: Omit<AlphaTraceRequest, 'maxRects'>, transfer: Transferable[]): Promise<AlphaTraceReply> {
    const request = boardWorker('export').request<AlphaTraceReply>('alphaTrace', { ...payload, maxRects: MAX_COVERAGE_RECTS }, cx.owner,
        { priority: 0, signal: cx.signal, cpu: 'governed', transfer }, () => cx.live());
    cx.holds.requests.push(request);
    return request;
}
async function traceImage(cx: Coverage, source: ImageBitmap, region: Rect, opaqueAlpha: boolean): Promise<AlphaTraceReply | null> {
    const reservation = cx.memory.reserve(region.width * region.height * 5 + RESULT_BYTES);
    if (!reservation) return null;
    cx.holds.reservations.push(reservation);
    auditCount('embed', 'facts:copy', 1, { bytes: region.width * region.height * 4 });
    const copy = await createImageBitmap(source, region.x, region.y, region.width, region.height);
    return send(cx, { bitmap: copy, opaqueAlpha }, [copy]);
}
async function traceRaster(cx: Coverage, png: Uint8Array): Promise<AlphaTraceReply | null> {
    const reservation = cx.memory.reserve(RASTER_TILE_BYTES + png.byteLength + RESULT_BYTES);
    if (!reservation) return null;
    cx.holds.reservations.push(reservation);
    auditCount('embed', 'facts:trace-raster', 1, { bytes: png.byteLength });
    return send(cx, { png, opaqueAlpha: true }, []);
}
function addTraced(acc: LaterCoverage, reply: AlphaTraceReply | null, pixelToLocal: Affine, cover: Rect | null, rect: Rect,
    localToWorld: Affine, cx: Coverage, clips: readonly PaintClip[], whole: Rect): void {
    if (!reply || !reply.opaque || !reply.partial) { pushPartial(acc, whole, clips); return; }
    const toPane = compose(cx.pane, localToWorld), local = (x0: number, y0: number, x1: number, y1: number): Rect => ({
        x: pixelToLocal[0] * x0 + pixelToLocal[4], y: pixelToLocal[3] * y0 + pixelToLocal[5],
        width: pixelToLocal[0] * (x1 - x0), height: pixelToLocal[3] * (y1 - y0) });
    const d: PathCommand[] = [];
    for (let i = 0; i < reply.opaque.length && cover; i += 4) {
        const piece = intersect(local(reply.opaque[i], reply.opaque[i + 1], reply.opaque[i + 2], reply.opaque[i + 3]), cover);
        if (!piece) continue;
        const x0 = piece.x, y0 = piece.y, x1 = piece.x + piece.width, y1 = piece.y + piece.height;
        d.push(['M', x0, y0], ['L', x1, y0], ['L', x1, y1], ['L', x0, y1], ['Z']);
    }
    if (d.length) acc.opaque.push({ opacity: 'opaque', coverage: { path: { d, fillRule: 'nonzero', toPane }, clips: clipsOf(clips, cx.pane) } });
    for (let i = 0; i < reply.partial.length; i += 4) {
        const piece = intersect(local(reply.partial[i], reply.partial[i + 1], reply.partial[i + 2], reply.partial[i + 3]), rect);
        if (piece) pushPartial(acc, rectWorld(piece.x, piece.y, piece.x + piece.width, piece.y + piece.height, localToWorld), clips);
    }
}

async function imageCoverage(item: PaintImageItem, drawn: PresentedImage, cx: Coverage): Promise<LaterCoverage> {
    const acc = emptyCoverage(), rect = item.rect, source = drawn.source;
    const whole = rectWorld(rect.x, rect.y, rect.x + rect.width, rect.y + rect.height, item.localToWorld);
    if (item.blend !== 'normal') { pushPartial(acc, whole, item.clips); return acc; }
    const crop = item.sourceRect ?? { x: 0, y: 0, width: source.width, height: source.height };
    if (!wholePixels(crop, source.width, source.height)) return unknownCoverage();
    const kind = item.retainedTile ? 'dense' : 'picture';
    const region = enclosing(crop, source.width, source.height);
    const reply = await traceImage(cx, source, region, item.opacity >= 1);
    const texel = { x: rect.width / crop.width, y: rect.height / crop.height };
    const cover = pictureCover(rect, texel, devicePixel(item.localToWorld, cx.deviceScale), imageSeams(crop, source.width, source.height, kind));
    addTraced(acc, reply, maskMatrix(rect, crop, region), cover, rect, item.localToWorld, cx, item.clips, whole);
    return acc;
}

async function glyphCoverage(item: PaintTextItem, source: PaintNodeSource, cx: Coverage, pageScale: number): Promise<LaterCoverage> {
    const acc = emptyCoverage(), resolve = createStreamingExportTextPieces(source, cx.signal);
    let open: { fill: NonNullable<PathMaterial['fill']>; blend: PathMaterial['blend']; d: PathCommand[] } | null = null;
    for await (const piece of resolve(item, pageScale, cx.signal)) {
        if (piece.kind === 'textPathStart') {
            if (open) throw new Error('Glyph path started inside another glyph path');
            open = { fill: piece.fill, blend: piece.blend, d: [] };
        } else if (piece.kind === 'textPathChunk') {
            if (!open) throw new Error('Glyph chunk arrived outside a glyph path');
            for (const command of piece.commands) open.d.push(command);
        } else if (piece.kind === 'textPathEnd') {
            if (!open) throw new Error('Glyph path ended without a start');
            const finished = open; open = null;
            pathCoverage(acc, finished.d, 'nonzero', { fill: finished.fill, blend: finished.blend }, item.localToWorld, cx.pane, item.clips);
        } else if (open) {
            throw new Error(`Text item ${item.nodeId} produced a ${piece.kind} piece inside a glyph path`);
        } else if (piece.kind === 'raster') {
            const whole = rectWorld(piece.rect.x, piece.rect.y, piece.rect.x + piece.rect.width, piece.rect.y + piece.rect.height, item.localToWorld);
            if (piece.blend !== 'normal') { pushPartial(acc, whole, item.clips); continue; }
            const reply = await traceRaster(cx, piece.png);
            const crop = { x: 0, y: 0, width: reply?.width ?? 1, height: reply?.height ?? 1 }, rect = piece.rect;
            const cover = reply ? pictureCover(rect, { x: rect.width / crop.width, y: rect.height / crop.height },
                devicePixel(item.localToWorld, cx.deviceScale), imageSeams(crop, crop.width, crop.height, 'raster')) : null;
            addTraced(acc, reply, maskMatrix(rect, crop, { x: 0, y: 0 }), cover, rect, item.localToWorld, cx, item.clips, whole);
        } else if (piece.kind === 'path') {
            const stroke = piece.stroke;
            const material: PathMaterial = { fill: piece.fill, blend: piece.blend ?? 'normal', stroke: stroke && stroke.miterLimit !== undefined
                ? { color: stroke.color, width: stroke.width, cap: stroke.cap, join: stroke.join, miterLimit: stroke.miterLimit,
                    dash: stroke.dash ? { array: stroke.dash, phase: stroke.dashPhase ?? 0 } : undefined } : undefined };
            if (stroke && stroke.miterLimit === undefined) {
                pushPartial(acc, pathWorldBounds(piece.d, item.localToWorld, stroke.width * 4 / 2), item.clips);
            } else pathCoverage(acc, piece.d, piece.fillRule ?? 'nonzero', material, item.localToWorld, cx.pane, item.clips);
        } else throw new Error(`Text item ${item.nodeId} produced an unexpected ${piece.kind} piece`);
    }
    if (open) throw new Error('Glyph stream ended inside a glyph path');
    return acc;
}

function presentedEmbeds(doc: BoardDoc, frame: PaintSource, omitted: ReadonlySet<string> | null, pane: Affine,
    later: ReadonlyMap<number | string, LaterCoverage>): readonly EmbedPresentedNode[] {
    const cards = embedCards(doc, frame), laterPaint = cards.map((): EmbedLaterPaint[] => []);
    let j = -1;
    for (const item of paintItemsOf(frame)) {
        j++;
        if (omitted?.has(item.nodeId)) continue;
        cards.forEach((card, c) => {
            if (j <= card.index || item.nodeId === card.nodeId) return;
            if (!overlaps(laterItemBounds(item, card.nodeId), card.world)) return;
            const coverage = later.get(j) ?? later.get(`${j}|${card.nodeId}`);
            if (!coverage) throw new Error(`Later coverage for ${item.nodeId} was not prepared`);
            laterPaint[c].push(...coverage.opaque);
            if (coverage.partial.some(region => overlaps(region, card.world))) laterPaint[c].push({ opacity: 'translucent' });
        });
    }
    const presented: EmbedPresentedNode[] = [];
    cards.forEach((card, c) => {
        const cardItem = card.item;
        presented.push({ nodeId: card.nodeId, source: card.node.url, order: card.index, rect: { x: 0, y: 0, width: card.node.w, height: card.node.h },
            toPane: compose(pane, cardItem.localToWorld), clips: clipsOf(cardItem.clips, pane), opacity: inheritedOpacity(doc, card.node),
            poster: omitted?.has(card.nodeId) ? 'omitted' : 'painted', laterPaint: Object.freeze(laterPaint[c]) });
    });
    return Object.freeze(presented);
}

async function prepareLater(doc: BoardDoc, frame: PaintSource, source: PaintNodeSource, cx: Coverage,
    deviceScale: number, omitted: ReadonlySet<string> | null): Promise<ReadonlyMap<number | string, LaterCoverage>> {
    const cards = embedCards(doc, frame), later = new Map<number | string, LaterCoverage>();
    let j = -1;
    for (const item of paintItemsOf(frame)) {
        j++;
        if (omitted?.has(item.nodeId)) continue;
        if (!cards.some(card => card.nodeId !== item.nodeId && card.index < j)) continue;
        const bounds = laterItemBounds(item, item.nodeId);
        const overlapping = cards.filter(card => card.nodeId !== item.nodeId && card.index < j && overlaps(bounds, card.world));
        if (!overlapping.length) continue;
        if (item.kind === 'image' && item.retainedTile) {
            const drawn = cx.drawn.get(item);
            if (drawn) auditCount('embed', 'facts:readback', 1, { bytes: drawn.source.width * drawn.source.height * 4 });
            const read = drawn ? readAlphaPlane(drawn.source, drawn.source.width, drawn.source.height, cx.memory) : null;
            if (read) cx.holds.reservations.push(read.lease);
            for (const card of overlapping) {
                const entries = !drawn || !read ? [UNKNOWN_LATER] : [imageLaterPaint(drawn, cx.pane, cx.dpr, deviceRect(card.world, cx), read.plane) ?? null];
                const acc = emptyCoverage();
                for (const entry of entries) if (entry) acc.opaque.push(entry);
                later.set(`${j}|${card.nodeId}`, acc);
            }
            cx.signal.throwIfAborted();
            continue;
        }
        const drawn = item.kind === 'image' ? cx.drawn.get(item) : undefined;
        const coverage = item.kind === 'text' ? await glyphCoverage(item, source, cx, deviceScale)
            : item.kind === 'image' ? (drawn ? await imageCoverage(item, drawn, cx) : unknownCoverage())
            : syncCoverage(item, item.nodeId, cx.pane, deviceScale);
        cx.signal.throwIfAborted();
        later.set(j, coverage);
    }
    return later;
}
function unknownCoverage(): LaterCoverage { return { opaque: [UNKNOWN_LATER], partial: [] }; }
function deviceRect(world: Rect, cx: Coverage): DeviceRect {
    const pane = rectWorld(world.x, world.y, world.x + world.width, world.y + world.height, cx.pane);
    return { x0: pane.x * cx.dpr, y0: pane.y * cx.dpr, x1: (pane.x + pane.width) * cx.dpr, y1: (pane.y + pane.height) * cx.dpr };
}

interface BuildKey {
    readonly doc: PaintSource['sourceDoc'];
    readonly revision: number;
    readonly token: FrameToken;
    readonly epoch: number;
    readonly width: number;
    readonly height: number;
    readonly dpr: number;
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly pane: Affine | null;
    readonly omitted: ReadonlySet<string> | null;
    readonly images: readonly PresentedImage[] | null;
}
function buildKeyOf(pending: Pending, presentation: PlatformPresentation): BuildKey {
    const view = pending.context.view;
    return {
        doc: pending.frame.sourceDoc, revision: pending.revision, token: presentation.token, epoch: view.epoch,
        width: view.viewport.width, height: view.viewport.height, dpr: view.viewport.dpr,
        x: view.camera.x, y: view.camera.y, z: view.camera.z,
        pane: pending.context.paneTransform, omitted: pending.context.omittedNodeIds, images: pending.drawn?.images ?? null,
    };
}
function sameFrameToken(a: FrameToken, b: FrameToken): boolean {
    return a.vaultEpoch === b.vaultEpoch && a.documentId === b.documentId && a.bytesGeneration === b.bytesGeneration &&
        a.session === b.session && a.viewLease === b.viewLease && a.deviceGeneration === b.deviceGeneration;
}
function sameBuild(a: BuildKey, b: BuildKey): boolean {
    if (a.doc !== b.doc || a.revision !== b.revision || !sameFrameToken(a.token, b.token) || a.epoch !== b.epoch ||
        a.width !== b.width || a.height !== b.height || a.dpr !== b.dpr || a.x !== b.x || a.y !== b.y || a.z !== b.z) return false;
    if (a.pane !== b.pane && (!a.pane || !b.pane || a.pane.some((value, i) => value !== b.pane![i]))) return false;
    if (a.omitted !== b.omitted) {
        if (!a.omitted || !b.omitted || a.omitted.size !== b.omitted.size) return false;
        for (const id of a.omitted) if (!b.omitted.has(id)) return false;
    }
    if (a.images !== b.images) {
        if (!a.images || !b.images || a.images.length !== b.images.length) return false;
        for (let i = 0; i < a.images.length; i++) {
            if (a.images[i].item !== b.images[i].item || a.images[i].source !== b.images[i].source) return false;
        }
    }
    return true;
}

function frameSource(frame: PaintSource, live: () => boolean): PaintNodeSource {
    return { sourceDoc: frame.sourceDoc, token: frame.token, sceneRevision: frame.sceneRevision,
        nodeCount: frame.liveOnly ? frame.windows.length : 1,
        readNode: index => {
            if (!frame.liveOnly) return { underlay: frame.underlay, content: frame.content };
            const window = frame.windows[index];
            return window.band === 'underlay' ? { underlay: window.items, content: [] } : { content: window.items };
        }, isCurrent: live };
}

function drawnFrameOf(presentation: PlatformPresentation): number { return presentation.drawnFrameId ?? presentation.frameId; }
function showsDraw(presentation: PlatformPresentation, frameId: number, epoch: number): boolean {
    if (drawnFrameOf(presentation) !== frameId) return false;
    return presentation.frameId !== frameId || presentation.viewEpoch === epoch;
}
export function createNativeEmbedPresentationProducer(options: NativeEmbedPresentationOptions): NativeEmbedPresentationProducer {
    let pending: Pending | null = null, building: Building | null = null, accepted: PlatformPresentation | null = null, disposed = false;
    let handedKey: BuildKey | null = null;
    const releaseQuietly = (value: Pending) => {
        try { value.releaseRaw(); } catch (error) { options.onError(error); }
        try { value.drawn?.release(); } catch (error) { options.onError(error); }
    };
    const run = async (value: Pending, presentation: PlatformPresentation, controller: AbortController, key: BuildKey): Promise<void> => {
        const { frame, context, drawn } = value, signal = controller.signal;
        auditCount('embed', 'facts:build');
        const holds: Holds = { reservations: [], requests: [] };
        const releaseHeld = () => {
            releaseQuietly(value);
            void Promise.allSettled(holds.requests).then(() => {
                for (const reservation of holds.reservations) options.memory.release(reservation);
            });
        };
        let handed = false;
        try {
            const doc = frame.sourceDoc;
            if (!doc) throw new Error('Embed presentation needs the pinned source document of the presented frame');
            const pane = context.paneTransform;
            if (!pane) throw new Error('Embed presentation needs the pane transform of the retained draw');
            if (!drawn) { releaseHeld(); if (renderAuditEnabled()) auditCount('embed', 'facts:no-drawn'); return; }
            const drawnFrame = drawn.frame, dpr = context.view.viewport.dpr;
            const deviceScale = context.view.camera.z * dpr;
            const source = frameSource(drawnFrame, () => !signal.aborted && !disposed);
            const cx: Coverage = { pane, dpr, signal, memory: options.memory, holds, drawn: new Map(drawn.images.map(image => [image.item, image])),
                owner: { session: crypto.randomUUID(), epoch: frame.token.vaultEpoch, revision: frame.sceneRevision },
                live: () => !signal.aborted && !disposed, deviceScale };
            const later = await prepareLater(doc, drawnFrame, source, cx, deviceScale, context.omittedNodeIds);
            signal.throwIfAborted();
            const packet: EmbedPresentationFrame = { presentation, sceneRevision: frame.sceneRevision,
                viewport: Object.freeze({ width: context.view.viewport.width, height: context.view.viewport.height }),
                camera: Object.freeze({ x: context.view.camera.x, y: context.view.camera.y, z: context.view.camera.z }),
                nodes: presentedEmbeds(doc, drawnFrame, context.omittedNodeIds, pane, later), release: releaseHeld };
            handed = true;
            handedKey = key;
            options.port.present(packet);
        } catch (error) {
            if (!handed) {
                releaseHeld();
                if (renderAuditEnabled()) auditCount('embed', 'facts:failed:' + (signal.aborted ? 'aborted' : String((error as Error)?.message ?? error).slice(0, 50)));
                if (!signal.aborted) options.onError(error);
            }
        } finally {
            if (building?.controller === controller) building = null;
        }
    };
    const pair = () => {
        const value = pending, presentation = accepted;
        if (!presentation || !value || disposed || !showsDraw(presentation, value.context.frameId, value.context.view.epoch) || !sameRender(presentation.token, value.token)) {
            if (renderAuditEnabled()) auditCount('embed', 'facts:unpaired:' + (!presentation ? 'no-presentation' : !value ? 'no-draw' : disposed ? 'disposed'
                : drawnFrameOf(presentation) < value.context.frameId ? 'presentation-older' : drawnFrameOf(presentation) > value.context.frameId ? 'draw-older'
                : !showsDraw(presentation, value.context.frameId, value.context.view.epoch) ? 'epoch' : 'token'));
            return;
        }
        pending = null;
        const key = buildKeyOf(value, presentation);
        if (handedKey && sameBuild(handedKey, key)) { releaseQuietly(value); auditCount('embed', 'facts:reuse'); return; }
        const controller = new AbortController();
        building = { pending: value, controller, key, presentation };
        setTimeout(() => {
            if (controller.signal.aborted) {
                releaseQuietly(value);
                if (building?.controller === controller) building = null;
                return;
            }
            void run(value, presentation, controller, key);
        }, 0);
    };
    return {
        presented(revision, token, frame, context) {
            if (!frame || !context || disposed) return;
            const releaseRaw = context.retain();
            const drawn = context.retainImages();
            if (frame.sceneRevision !== revision || !sameRender(frame.token, token)) {
                releaseRaw(); drawn?.release(); return;
            }
            const next: Pending = { revision, token, frame, context, releaseRaw, drawn };
            if (building && !building.controller.signal.aborted && sameBuild(building.key, buildKeyOf(next, building.presentation))) {
                releaseQuietly(next); if (renderAuditEnabled()) auditCount('embed', 'facts:same-as-building'); return;
            }
            if (pending) releaseQuietly(pending);
            pending = next;
            building?.controller.abort();
            pair();
        },
        onPresentation(presentation) {
            if (disposed) return;
            accepted = presentation;
            if (!presentation) {
                handedKey = null;
                const value = pending; pending = null;
                if (value) releaseQuietly(value);
                building?.controller.abort();
                return;
            }
            if (building && !sameRender(building.pending.token, presentation.token)) {
                building.controller.abort();
            }
            pair();
        },
        dispose() {
            disposed = true; accepted = null; handedKey = null;
            const value = pending; pending = null;
            if (value) releaseQuietly(value);
            building?.controller.abort();
        },
    };
}
