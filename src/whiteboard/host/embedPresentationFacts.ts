import type { PlatformPresentation } from '../../platform/render/attachPlatformPane.types';
import type { EmbedCoveragePath, EmbedLaterPaint, EmbedPresentationFrame, EmbedPresentationPort,
    EmbedPresentedNode } from '../../platform/render/embedPresentation.types';
import type { RenderToken } from '../../platform/render/types';
import type { Affine, PathCommand, Rect, ViewState } from '../../platform/types';
import { createStreamingExportTextPieces } from '../export/textStreamResolver';
import { compose, transformPoint } from '../geom/affine';
import { coverageOutline } from '../ink/outline';
import { isSheetParent, type BoardDoc } from '../model/doc';
import type { NodeId } from '../model/ids';
import type { EmbedNode } from '../model/nodes';
import type { ViewerPaintPresentation } from '../render/paintPresentation';
import { inkCoverageChunks, type PaintClip, type PaintFrame, type PaintItem, type PaintNodeSource, type PaintTextItem } from '../render/paintStream';

// Provenance: embed presentation facts from this repository's own paint stream,
// canonical ink, glyph and path coverage and compositor contracts; independent composition.

export type NativeEmbedPresented = (revision: number, token: RenderToken, frame?: PaintFrame, context?: ViewerPaintPresentation) => void;

export interface NativeEmbedPresentationOptions {
    readonly port: EmbedPresentationPort;
    /** The compositor's snapped view-to-pane transform for a presented view, from the pane's own state; null until the pane has it. */
    readonly paneTransform: (view: ViewState, frameId: number) => Affine | null;
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

const sameRender = (a: RenderToken, b: RenderToken) => a.vaultEpoch === b.vaultEpoch && a.documentId === b.documentId
    && a.bytesGeneration === b.bytesGeneration && a.session === b.session;

function quadBounds(localToWorld: Affine, w: number, h: number): Rect {
    const corners = [[0, 0], [w, 0], [0, h], [w, h]].map(([x, y]) => transformPoint(localToWorld, { x, y }));
    const minX = Math.min(...corners.map(p => p.x)), maxX = Math.max(...corners.map(p => p.x));
    const minY = Math.min(...corners.map(p => p.y)), maxY = Math.max(...corners.map(p => p.y));
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
function overlaps(a: Rect, b: Rect): boolean {
    return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
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
/** Glyph coverage: each streamed glyph path is one canonical nonzero fill, in the item's own local frame. */
async function glyphCoverage(item: PaintTextItem, source: PaintNodeSource, signal: AbortSignal, pageScale: number,
    pane: Affine): Promise<readonly EmbedLaterPaint[]> {
    const resolve = createStreamingExportTextPieces(source, signal), out: EmbedLaterPaint[] = [], toPane = compose(pane, item.localToWorld);
    let open: { fill: readonly [number, number, number, number]; blend: string; d: PathCommand[] } | null = null;
    const clips = clipsOf(item.clips, pane);
    for await (const piece of resolve(item, pageScale, signal)) {
        if (piece.kind === 'textPathStart') {
            if (open) throw new Error('Glyph path started inside another glyph path');
            open = { fill: piece.fill, blend: piece.blend, d: [] };
        } else if (piece.kind === 'textPathChunk') {
            if (!open) throw new Error('Glyph chunk arrived outside a glyph path');
            for (const command of piece.commands) open.d.push(command);
        } else if (piece.kind === 'textPathEnd') {
            if (!open) throw new Error('Glyph path ended without a start');
            const finished = open; open = null;
            out.push(finished.blend !== 'normal' || finished.fill[3] < 1 ? { opacity: 'translucent' }
                : { opacity: 'opaque', coverage: { path: { d: finished.d, fillRule: 'nonzero', toPane }, clips } });
        } else throw new Error(`Text item ${item.nodeId} fell back to raster outlines; its canonical glyph path is unavailable`);
    }
    if (open) throw new Error('Glyph stream ended inside a glyph path');
    return Object.freeze(out);
}
/** The one later-paint coverage an item contributes, or refusal when its canonical producer is not available. */
function laterCoverage(item: PaintItem, embedId: string, pane: Affine, deviceScale: number): readonly EmbedLaterPaint[] {
    if (item.kind === 'ink') {
        // The same canonical outline the CPU paint fills: one nonzero path per coverage chunk, at the presented device scale.
        if (item.material.blend !== 'normal' || item.material.color[3] < 1) return [{ opacity: 'translucent' }];
        const toPane = compose(pane, item.localToWorld), clips = clipsOf(item.clips, pane);
        return inkCoverageChunks(item.coverage).map(chunk => ({ opacity: 'opaque' as const,
            coverage: { path: { d: coverageOutline(chunk, deviceScale), fillRule: 'nonzero' as const, toPane }, clips } }));
    }
    if (item.kind !== 'path') throw new Error(`Later ${item.kind} paint over embed ${embedId} needs its canonical coverage producer`);
    if (item.material.stroke) throw new Error(`Later stroked path over embed ${embedId} needs its expanded stroke outline`);
    const fill = item.material.fill;
    if (!fill || fill[3] < 1 || item.material.blend !== 'normal') return [{ opacity: 'translucent' }];
    return [{ opacity: 'opaque', coverage: { path: { d: item.d, fillRule: item.fillRule, toPane: compose(pane, item.localToWorld) },
        clips: clipsOf(item.clips, pane) } }];
}

function presentedEmbeds(doc: BoardDoc, frame: PaintFrame, omitted: ReadonlySet<string> | null, pane: Affine, deviceScale: number,
    glyphs: ReadonlyMap<number, readonly EmbedLaterPaint[]>): readonly EmbedPresentedNode[] {
    const items: readonly PaintItem[] = [...frame.underlay, ...frame.content];
    const presented: EmbedPresentedNode[] = [];
    for (const card of embedCards(doc, items)) {
        const laterPaint: EmbedLaterPaint[] = [];
        for (let j = card.index + 1; j < items.length; j++) {
            const item = items[j];
            if (item.nodeId === card.nodeId) continue;
            if (!overlaps(laterItemBounds(item, card.nodeId), card.world)) continue;
            if (item.kind === 'text') {
                const coverage = glyphs.get(j);
                if (!coverage) throw new Error(`Glyph coverage for ${item.nodeId} was not prepared`);
                laterPaint.push(...coverage);
            } else laterPaint.push(...laterCoverage(item, card.nodeId, pane, deviceScale));
        }
        const cardItem = items[card.index];
        presented.push({ nodeId: card.nodeId, source: card.node.url, order: card.index, rect: { x: 0, y: 0, width: card.node.w, height: card.node.h },
            toPane: compose(pane, cardItem.localToWorld), clips: clipsOf(cardItem.clips, pane), opacity: inheritedOpacity(doc, card.node),
            poster: omitted?.has(card.nodeId) ? 'omitted' : 'painted', laterPaint: Object.freeze(laterPaint) });
    }
    return Object.freeze(presented);
}

/** Glyph coverage is prepared before the synchronous node build, so every text item that overlaps an embed is resolved first. */
async function prepareGlyphs(doc: BoardDoc, frame: PaintFrame, source: PaintNodeSource, signal: AbortSignal, pageScale: number,
    pane: Affine): Promise<ReadonlyMap<number, readonly EmbedLaterPaint[]>> {
    const items: readonly PaintItem[] = [...frame.underlay, ...frame.content];
    const cards = embedCards(doc, items), glyphs = new Map<number, readonly EmbedLaterPaint[]>();
    for (let j = 0; j < items.length; j++) {
        const item = items[j];
        if (item.kind !== 'text') continue;
        const bounds = laterItemBounds(item, item.nodeId);
        if (!cards.some(card => card.nodeId !== item.nodeId && card.index < j && overlaps(bounds, card.world))) continue;
        glyphs.set(j, await glyphCoverage(item, source, signal, pageScale, pane));
        signal.throwIfAborted();
    }
    return glyphs;
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
 * streams have settled. dispose releases the held frame and aborts the build.
 */
export function createNativeEmbedPresentationProducer(options: NativeEmbedPresentationOptions): NativeEmbedPresentationProducer {
    let pending: Pending | null = null, building: Building | null = null, disposed = false;
    const releaseQuietly = (value: Pending) => { try { value.releaseRaw(); } catch (error) { options.onError(error); } };
    const run = async (value: Pending, presentation: PlatformPresentation, controller: AbortController): Promise<void> => {
        const { frame, context } = value, signal = controller.signal;
        let handed = false;
        try {
            const doc = frame.sourceDoc;
            if (!doc) throw new Error('Embed presentation needs the pinned source document of the presented frame');
            const pane = options.paneTransform(context.view, context.frameId);
            if (!pane) throw new Error('Embed presentation needs the snapped pane transform of the accepted frame');
            const deviceScale = context.view.camera.z * context.view.viewport.dpr;
            const source = frameSource(frame, () => !signal.aborted && !disposed);
            const glyphs = await prepareGlyphs(doc, frame, source, signal, deviceScale, pane);
            signal.throwIfAborted();
            const packet: EmbedPresentationFrame = { presentation, sceneRevision: frame.sceneRevision,
                viewport: Object.freeze({ width: context.view.viewport.width, height: context.view.viewport.height }),
                nodes: presentedEmbeds(doc, frame, context.omittedNodeIds, pane, deviceScale, glyphs), release: () => releaseQuietly(value) };
            handed = true;
            options.port.present(packet);
        } catch (error) {
            if (!handed) {
                releaseQuietly(value);
                if (!signal.aborted) options.onError(error);
            }
        } finally {
            if (building?.controller === controller) building = null;
        }
    };
    return {
        presented(revision, token, frame, context) {
            if (!frame || !context) return;
            const releaseRaw = context.retain();
            if (frame.sceneRevision !== revision || !sameRender(frame.token, token)) { releaseRaw(); return; }
            const next: Pending = { revision, token, frame, context, releaseRaw };
            if (pending) releaseQuietly(pending);
            pending = next;
            building?.controller.abort();
        },
        onPresentation(presentation) {
            const value = pending;
            if (!presentation || !value || disposed) return;
            if (presentation.frameId !== value.context.frameId || presentation.viewEpoch !== value.context.view.epoch
                || !sameRender(presentation.token, value.token)) return;
            pending = null;
            const controller = new AbortController();
            building = { pending: value, controller };
            void run(value, presentation, controller);
        },
        dispose() {
            disposed = true;
            const value = pending; pending = null;
            if (value) releaseQuietly(value);
            building?.controller.abort();
        },
    };
}
