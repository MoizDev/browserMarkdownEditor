import type { PlatformPresentation } from '../../platform/render/attachPlatformPane.types';
import type { EmbedClippedCoverage, EmbedCoveragePath, EmbedLaterPaint, EmbedPresentationFrame, EmbedPresentationPort,
    EmbedPresentedNode } from '../../platform/render/embedPresentation.types';
import type { ByteLease } from '../../platform/render/gfx/api';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { RenderToken } from '../../platform/render/types';
import type { Affine, PathCommand, Rect } from '../../platform/types';
import type { AlphaTraceReply, AlphaTraceRequest } from '../export/alphaWorkerHandler';
import { createStreamingExportTextPieces } from '../export/textStreamResolver';
import { compose, transformPoint } from '../geom/affine';
import { coverageOutline } from '../ink/outline';
import { isSheetParent, type BoardDoc } from '../model/doc';
import type { NodeId } from '../model/ids';
import type { EmbedNode } from '../model/nodes';
import type { PathMaterial, StrokeMaterial } from '../render/material';
import type { ViewerPaintPresentation } from '../render/paintPresentation';
import { inkCoverageChunks, type PaintClip, type PaintFrame, type PaintImageItem, type PaintItem, type PaintNodeSource,
    type PaintTextItem } from '../render/paintStream';
import type { PaintImageLease, PaintImageProvider } from '../render/resources';
import { boardWorker } from '../workers/client';
import type { BoardJobIdentity } from '../workers/protocol';

// Provenance: embed presentation facts from this repository's own paint stream,
// canonical ink, glyph, raster and path coverage and compositor contracts; independent composition.

export type NativeEmbedPresented = (revision: number, token: RenderToken, frame?: PaintFrame, context?: ViewerPaintPresentation) => void;

export interface NativeEmbedPresentationOptions {
    readonly port: EmbedPresentationPort;
    /** Decodes the exact image keys of the accepted paint. Each lease is held until the port retires the packet. */
    readonly images: PaintImageProvider;
    /** The canonical allocator: every owned copy and worker buffer is reserved here before it is made. */
    readonly memory: MemoryAllocator;
    readonly onError: (error: unknown) => void;
}
export interface NativeEmbedPresentationProducer {
    /** Drawn callback: the band has painted this frame. Retains it; it is not presented until the pane accepts it. */
    readonly presented: NativeEmbedPresented;
    /** Platform acceptance observer. Only a matching acceptance presents the pending frame. */
    onPresentation(presentation: PlatformPresentation | null): void;
    /** Releases the pending frame and aborts any build in flight. */
    dispose(): void;
}

interface Pending {
    readonly revision: number;
    readonly token: RenderToken;
    readonly frame: PaintFrame;
    readonly context: ViewerPaintPresentation;
    readonly releaseRaw: () => void;
}
interface Building {
    readonly pending: Pending;
    readonly controller: AbortController;
}

/** Budgets chosen, not measured. A trace result is at most this many rectangles per selection. */
const MAX_COVERAGE_RECTS = 1 << 16;
/** Bytes charged per rectangle of a trace result: four numbers, eight bytes each. */
const RESULT_BYTES = 2 * MAX_COVERAGE_RECTS * 4 * 8;
/** A raster fallback tile is at most 1024 px on a side (outlineRaster TILE_SIDE): RGBA plus alpha, charged in full. */
const RASTER_TILE_BYTES = 1024 * 1024 * 5;

const sameRender = (a: RenderToken, b: RenderToken) => a.vaultEpoch === b.vaultEpoch && a.documentId === b.documentId
    && a.bytesGeneration === b.bytesGeneration && a.session === b.session;

/** Everything one embed presentation has borrowed or reserved. Released only after every request has retired. */
interface Holds {
    readonly leases: PaintImageLease[];
    readonly reservations: ByteLease[];
    readonly requests: Promise<unknown>[];
}
interface Coverage {
    readonly frame: PaintFrame;
    readonly pane: Affine;
    readonly signal: AbortSignal;
    readonly images: PaintImageProvider;
    readonly memory: MemoryAllocator;
    readonly owner: BoardJobIdentity;
    readonly holds: Holds;
    readonly live: () => boolean;
    /** Device pixels per world unit: the presented scale that sizes one device pixel of cover inset. */
    readonly deviceScale: number;
}
/** One later paint item's contribution: exact opaque coverage, and the world regions it may paint non-occluding alpha in,
 * already cut by its real clips. A translucent entry is emitted only for a region that reaches an embed. */
interface LaterCoverage {
    readonly opaque: EmbedLaterPaint[];
    readonly partial: Rect[];
}
const emptyCoverage = (): LaterCoverage => ({ opaque: [], partial: [] });

function quadBounds(localToWorld: Affine, w: number, h: number): Rect {
    return rectWorld(0, 0, w, h, localToWorld);
}
/** World bounds of a local rectangle through a local-to-world affine. */
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
/** World envelope of a path's control points, with its local bounds padded first. Over-approximates, never under. */
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
/** The region cut by an item's real clips. A clip's envelope only ever removes what provably lies outside it. */
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
/** Opacity inherited through the model's own parent chain. */
function inheritedOpacity(doc: BoardDoc, node: EmbedNode): number {
    let value = node.opacity, parent = node.parent;
    for (let depth = 0; depth <= 64 && !isSheetParent(doc, parent); depth++) {
        const ancestor = doc.nodes.get(parent as NodeId); if (!ancestor) throw new Error(`Embed ancestor is missing: ${node.id}`);
        value *= ancestor.opacity; parent = ancestor.parent;
    }
    return value;
}

interface EmbedCard { readonly nodeId: string; readonly index: number; readonly node: EmbedNode; readonly world: Rect }
/** The first paint item of each live embed is its card: the quad every later item is tested against. */
function embedCards(doc: BoardDoc, items: readonly PaintItem[]): readonly EmbedCard[] {
    const first = new Map<string, number>();
    items.forEach((item, index) => {
        if (!first.has(item.nodeId) && doc.nodes.get(item.nodeId as NodeId)?.kind === 'embed') first.set(item.nodeId, index);
    });
    return [...first].map(([nodeId, index]) => {
        const node = doc.nodes.get(nodeId as NodeId) as EmbedNode;
        return { nodeId, index, node, world: quadBounds(items[index].localToWorld, node.w, node.h) };
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
/** Fill and stroke of one path are one coverage: Render paints the same centreline path with fill?/stroke? in the path's
 * own local units, as the reference painter does (lineWidth and dash on the local transform). A width of 0 paints nothing,
 * so it is no stroke at all; a path with neither paints nothing. Translucent paint claims no occlusion, so its region is
 * the path's envelope, padded by the stroke's furthest miter reach. */
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
/** Coverage of an ink or path item, which needs no decode: the canonical outline the CPU paint fills. */
function syncCoverage(item: PaintItem, embedId: string, pane: Affine, deviceScale: number): LaterCoverage {
    const acc = emptyCoverage();
    if (item.kind === 'ink') {
        // The same canonical outline the CPU paint fills: one nonzero path per coverage chunk, at the presented device scale.
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

/** The pixel-to-local matrix of a traced mask. `origin` is the mask's first source pixel, and `crop` is the source rectangle
 * that `rect` depicts: the mask may read whole pixels around a fractional crop, so the scale comes from the crop itself. */
function maskMatrix(rect: Rect, crop: Rect, origin: { x: number; y: number }): Affine {
    const kx = rect.width / crop.width, ky = rect.height / crop.height;
    return [kx, 0, 0, ky, rect.x + (origin.x - crop.x) * kx, rect.y + (origin.y - crop.y) * ky];
}
/** The whole source pixels a crop touches, clamped to the source: a fractional crop reads its enclosing pixels. */
function enclosing(crop: Rect, width: number, height: number): Rect {
    const x0 = Math.max(0, Math.floor(crop.x)), y0 = Math.max(0, Math.floor(crop.y));
    const x1 = Math.min(width, Math.ceil(crop.x + crop.width)), y1 = Math.min(height, Math.ceil(crop.y + crop.height));
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
/** Which edges of a picture's crop are seams that bilinear sampling can read across. A fractional edge is never texel-aligned.
 * A dense tile's aligned edge is covered by its apron of at least one texel; a text raster tile has no apron, so every edge is a seam. */
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
/** The certified opaque cover of a bilinear picture, in its local frame. Each seam edge is inset by the larger of one device
 * pixel and one source texel, mapped to the local frame; the edge band that remains is not covering, and it is not translucent.
 * Default, bilinear support of one texel. */
function pictureCover(rect: Rect, texel: { x: number; y: number }, device: { x: number; y: number }, seams: Seams): Rect | null {
    const dx = Math.max(device.x, texel.x), dy = Math.max(device.y, texel.y);
    const left = seams.left ? dx : 0, right = seams.right ? dx : 0, top = seams.top ? dy : 0, bottom = seams.bottom ? dy : 0;
    const width = rect.width - left - right, height = rect.height - top - bottom;
    return width > 0 && height > 0 ? { x: rect.x + left, y: rect.y + top, width, height } : null;
}
/** Local size of one device pixel along each axis of the picture, at the presented device scale. */
function devicePixel(localToWorld: Affine, deviceScale: number): { x: number; y: number } {
    return { x: 1 / (Math.hypot(localToWorld[0], localToWorld[1]) * deviceScale), y: 1 / (Math.hypot(localToWorld[2], localToWorld[3]) * deviceScale) };
}
function wholePixels(crop: Rect, width: number, height: number): boolean {
    return [crop.x, crop.y, crop.width, crop.height].every(Number.isFinite) && crop.x >= 0 && crop.y >= 0
        && crop.width > 0 && crop.height > 0 && crop.x + crop.width <= width && crop.y + crop.height <= height;
}
/** Sends one owned source to the export worker lane. The request is recorded so its lease and charge outlive it. */
function send(cx: Coverage, payload: Omit<AlphaTraceRequest, 'maxRects'>, transfer: Transferable[]): Promise<AlphaTraceReply> {
    const request = boardWorker('export').request<AlphaTraceReply>('alphaTrace', { ...payload, maxRects: MAX_COVERAGE_RECTS }, cx.owner,
        { priority: 0, signal: cx.signal, cpu: 'governed', transfer }, () => cx.live());
    cx.holds.requests.push(request);
    return request;
}
/** A copy of the enclosing pixels of a held decoded frame, so the worker only ever owns the copy and the lease never leaves the producer. */
async function traceImage(cx: Coverage, lease: PaintImageLease, region: Rect, opaqueAlpha: boolean): Promise<AlphaTraceReply | null> {
    const reservation = cx.memory.reserve(region.width * region.height * 5 + RESULT_BYTES);
    if (!reservation) return null;
    cx.holds.reservations.push(reservation);
    const copy = await createImageBitmap(lease.source, region.x, region.y, region.width, region.height);
    return send(cx, { bitmap: copy, opaqueAlpha }, [copy]);
}
async function traceRaster(cx: Coverage, png: Uint8Array): Promise<AlphaTraceReply | null> {
    const reservation = cx.memory.reserve(RASTER_TILE_BYTES + png.byteLength + RESULT_BYTES);
    if (!reservation) return null;
    cx.holds.reservations.push(reservation);
    return send(cx, { png, opaqueAlpha: true }, []);
}
/** Maps a traced reply into coverage. Opaque pixels are certified only inside `cover`; partial pixels are real translucency
 * wherever they fall inside the presented rectangle. A refused budget, or no reply, makes the whole picture partial: its opaque
 * pixels are then unknown, so nothing may be claimed opaque. */
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

/** An image's decoded alpha, traced in the worker from the frame's own imageKey. Opaque coverage is certified by the bilinear
 * cover rule; partial alpha is real translucency. A non-normal blend is translucent over the whole picture. */
async function imageCoverage(item: PaintImageItem, cx: Coverage): Promise<LaterCoverage> {
    const acc = emptyCoverage(), rect = item.rect;
    const whole = rectWorld(rect.x, rect.y, rect.x + rect.width, rect.y + rect.height, item.localToWorld);
    if (item.blend !== 'normal') { pushPartial(acc, whole, item.clips); return acc; }
    const lease = await cx.images.acquire(item.imageKey, cx.frame.token, cx.signal);
    cx.holds.leases.push(lease);
    cx.signal.throwIfAborted();
    const crop = item.sourceRect ?? { x: 0, y: 0, width: lease.width, height: lease.height };
    if (!wholePixels(crop, lease.width, lease.height)) return acc;
    const kind = item.retainedTile ? 'dense' : 'picture';
    const region = enclosing(crop, lease.width, lease.height);
    const reply = await traceImage(cx, lease, region, item.opacity >= 1);
    const texel = { x: rect.width / crop.width, y: rect.height / crop.height };
    const cover = pictureCover(rect, texel, devicePixel(item.localToWorld, cx.deviceScale), imageSeams(crop, lease.width, lease.height, kind));
    addTraced(acc, reply, maskMatrix(rect, crop, region), cover, rect, item.localToWorld, cx, item.clips, whole);
    return acc;
}

/** Glyph coverage: each streamed glyph path is one canonical fill, each stroked path its exact stroke, and each raster
 * fallback tile its traced alpha, all in the item's own local frame and in the stream's paint order. */
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
            // The tile's own pixels span its rect; every edge is a seam, since adjacent text tiles carry no apron.
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
                // The text stream never states a miter limit: its envelope is padded by the widest reach the SVG default allows.
                pushPartial(acc, pathWorldBounds(piece.d, item.localToWorld, stroke.width * 4 / 2), item.clips);
            } else pathCoverage(acc, piece.d, piece.fillRule ?? 'nonzero', material, item.localToWorld, cx.pane, item.clips);
        } else throw new Error(`Text item ${item.nodeId} produced an unexpected ${piece.kind} piece`);
    }
    if (open) throw new Error('Glyph stream ended inside a glyph path');
    return acc;
}

function presentedEmbeds(doc: BoardDoc, frame: PaintFrame, omitted: ReadonlySet<string> | null, pane: Affine,
    later: ReadonlyMap<number, LaterCoverage>): readonly EmbedPresentedNode[] {
    const items: readonly PaintItem[] = [...frame.underlay, ...frame.content];
    const presented: EmbedPresentedNode[] = [];
    for (const card of embedCards(doc, items)) {
        const laterPaint: EmbedLaterPaint[] = [];
        for (let j = card.index + 1; j < items.length; j++) {
            const item = items[j];
            if (item.nodeId === card.nodeId) continue;
            if (!overlaps(laterItemBounds(item, card.nodeId), card.world)) continue;
            const coverage = later.get(j);
            if (!coverage) throw new Error(`Later coverage for ${item.nodeId} was not prepared`);
            laterPaint.push(...coverage.opaque);
            if (coverage.partial.some(region => overlaps(region, card.world))) laterPaint.push({ opacity: 'translucent' });
        }
        const cardItem = items[card.index];
        presented.push({ nodeId: card.nodeId, source: card.node.url, order: card.index, rect: { x: 0, y: 0, width: card.node.w, height: card.node.h },
            toPane: compose(pane, cardItem.localToWorld), clips: clipsOf(cardItem.clips, pane), opacity: inheritedOpacity(doc, card.node),
            poster: omitted?.has(card.nodeId) ? 'omitted' : 'painted', laterPaint: Object.freeze(laterPaint) });
    }
    return Object.freeze(presented);
}

/** Coverage for every later item that overlaps an embed is prepared before the synchronous node build. Glyph, raster and
 * image items resolve asynchronously; each item is resolved once for all the embeds it overlaps. */
async function prepareLater(doc: BoardDoc, frame: PaintFrame, source: PaintNodeSource, cx: Coverage,
    deviceScale: number): Promise<ReadonlyMap<number, LaterCoverage>> {
    const items: readonly PaintItem[] = [...frame.underlay, ...frame.content];
    const cards = embedCards(doc, items), later = new Map<number, LaterCoverage>();
    for (let j = 0; j < items.length; j++) {
        const item = items[j];
        if (!cards.some(card => card.nodeId !== item.nodeId && card.index < j)) continue;
        const bounds = laterItemBounds(item, item.nodeId);
        if (!cards.some(card => card.nodeId !== item.nodeId && card.index < j && overlaps(bounds, card.world))) continue;
        const coverage = item.kind === 'text' ? await glyphCoverage(item, source, cx, deviceScale)
            : item.kind === 'image' ? await imageCoverage(item, cx)
            : syncCoverage(item, item.nodeId, cx.pane, deviceScale);
        cx.signal.throwIfAborted();
        later.set(j, coverage);
    }
    return later;
}

/** The raw frame as a pinned PaintNodeSource: the export text resolver reads only its identity and liveness guard. */
function frameSource(frame: PaintFrame, live: () => boolean): PaintNodeSource {
    return { sourceDoc: frame.sourceDoc, token: frame.token, sceneRevision: frame.sceneRevision, nodeCount: 1,
        readNode: () => ({ underlay: frame.underlay, content: frame.content }), isCurrent: live };
}

/**
 * Two-phase producer. The drawn callback can run before the platform accepts the presentation, so
 * the latest drawn frame is held, retain included, and built only when the matching acceptance
 * arrives. A newer draw supersedes a held frame and releases it at once, since it never reached the
 * port; a newer draw also aborts a build in flight, whose retain is released only after its glyph
 * streams have settled. dispose releases the held frame and aborts the build. A presented packet
 * holds the raw frame until the port retires it; decoded leases and budget reservations are released
 * only after every worker request they served has physically retired.
 */
export function createNativeEmbedPresentationProducer(options: NativeEmbedPresentationOptions): NativeEmbedPresentationProducer {
    let pending: Pending | null = null, building: Building | null = null, accepted: PlatformPresentation | null = null, disposed = false;
    const releaseQuietly = (value: Pending) => { try { value.releaseRaw(); } catch (error) { options.onError(error); } };
    const run = async (value: Pending, presentation: PlatformPresentation, controller: AbortController): Promise<void> => {
        const { frame, context } = value, signal = controller.signal;
        const holds: Holds = { leases: [], reservations: [], requests: [] };
        const releaseHeld = () => {
            releaseQuietly(value);
            void Promise.allSettled(holds.requests).then(() => {
                for (const lease of holds.leases) { try { lease.release(); } catch (error) { options.onError(error); } }
                for (const reservation of holds.reservations) options.memory.release(reservation);
            });
        };
        let handed = false;
        try {
            const doc = frame.sourceDoc;
            if (!doc) throw new Error('Embed presentation needs the pinned source document of the presented frame');
            // The retained draw's own matrix: the exact world-to-pane transform the band painted, never a later camera lookup.
            const pane = context.paneTransform;
            if (!pane) throw new Error('Embed presentation needs the pane transform of the retained draw');
            const deviceScale = context.view.camera.z * context.view.viewport.dpr;
            const source = frameSource(frame, () => !signal.aborted && !disposed);
            const cx: Coverage = { frame, pane, signal, images: options.images, memory: options.memory, holds,
                owner: { session: crypto.randomUUID(), epoch: frame.token.vaultEpoch, revision: frame.sceneRevision },
                live: () => !signal.aborted && !disposed, deviceScale };
            const later = await prepareLater(doc, frame, source, cx, deviceScale);
            signal.throwIfAborted();
            const packet: EmbedPresentationFrame = { presentation, sceneRevision: frame.sceneRevision,
                viewport: Object.freeze({ width: context.view.viewport.width, height: context.view.viewport.height }),
                nodes: presentedEmbeds(doc, frame, context.omittedNodeIds, pane, later), release: releaseHeld };
            handed = true;
            options.port.present(packet);
        } catch (error) {
            if (!handed) {
                releaseHeld();
                if (!signal.aborted) options.onError(error);
            }
        } finally {
            if (building?.controller === controller) building = null;
        }
    };
    const pair = () => {
        const value = pending, presentation = accepted;
        if (!presentation || !value || disposed || presentation.frameId !== value.context.frameId
            || presentation.viewEpoch !== value.context.view.epoch || !sameRender(presentation.token, value.token)) return;
        pending = null;
        const controller = new AbortController();
        building = { pending: value, controller };
        void run(value, presentation, controller);
    };
    return {
        presented(revision, token, frame, context) {
            if (!frame || !context || disposed) return;
            const releaseRaw = context.retain();
            if (frame.sceneRevision !== revision || !sameRender(frame.token, token)) { releaseRaw(); return; }
            const next: Pending = { revision, token, frame, context, releaseRaw };
            if (pending) releaseQuietly(pending);
            pending = next;
            building?.controller.abort();
            pair();
        },
        onPresentation(presentation) {
            if (disposed) return;
            accepted = presentation;
            if (!presentation) {
                const value = pending; pending = null;
                if (value) releaseQuietly(value);
                building?.controller.abort();
                return;
            }
            if (building && (building.pending.context.frameId !== presentation.frameId
                || building.pending.context.view.epoch !== presentation.viewEpoch || !sameRender(building.pending.token, presentation.token))) {
                building.controller.abort();
            }
            pair();
        },
        dispose() {
            disposed = true; accepted = null;
            const value = pending; pending = null;
            if (value) releaseQuietly(value);
            building?.controller.abort();
        },
    };
}
