import type { PlatformPresentation } from '../../platform/render/attachPlatformPane.types';
import type { EmbedCoveragePath, EmbedLaterPaint, EmbedPresentationFrame, EmbedPresentationPort,
    EmbedPresentedNode } from '../../platform/render/embedPresentation.types';
import type { FrameToken, RenderToken } from '../../platform/render/types';
import type { Affine, Rect, ViewState } from '../../platform/types';
import { compose, transformPoint } from '../geom/affine';
import { coverageOutline } from '../ink/outline';
import { isSheetParent, type BoardDoc } from '../model/doc';
import type { NodeId } from '../model/ids';
import type { EmbedNode } from '../model/nodes';
import type { ViewerPaintPresentation } from '../render/paintPresentation';
import { inkCoverageChunks, type PaintClip, type PaintFrame, type PaintItem } from '../render/paintStream';

// Provenance: embed presentation facts from this repository's own paint stream,
// canonical path coverage and compositor contracts; independent composition, no third-party source.

export type NativeEmbedPresented = (revision: number, token: RenderToken, frame?: PaintFrame, context?: ViewerPaintPresentation) => void;

export interface NativeEmbedPresentationOptions {
    readonly port: EmbedPresentationPort;
    /** The compositor's view-to-pane transform for this presented view: the snapping the pane drew with. Null until the pane has it. */
    readonly paneTransform: (view: ViewState, frameId: number) => Affine | null;
    /** The compositor presentation that accepted this frame. Null until accepted, so nothing is claimed. */
    readonly presentation: (frameId: number, token: FrameToken) => PlatformPresentation | null;
    readonly onError: (error: unknown) => void;
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
/** Opacity inherited through the model's own parent chain; the card's paint already carries no separate group alpha. */
function inheritedOpacity(doc: BoardDoc, node: EmbedNode): number {
    let value = node.opacity, parent = node.parent;
    for (let depth = 0; depth <= 64 && !isSheetParent(doc, parent); depth++) {
        const ancestor = doc.nodes.get(parent as NodeId); if (!ancestor) throw new Error(`Embed ancestor is missing: ${node.id}`);
        value *= ancestor.opacity; parent = ancestor.parent;
    }
    return value;
}
/**
 * Coverage a later item contributes over the embed. Only what can be proven exact is returned: a
 * solid fill is its path, a translucent fill is reported as translucent. A stroke needs its expanded
 * outline and ink/text/image need canonical coverage; those are refused rather than approximated.
 */
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

function presentedEmbeds(doc: BoardDoc, frame: PaintFrame, omitted: ReadonlySet<string> | null, pane: Affine, deviceScale: number): readonly EmbedPresentedNode[] {
    const items: readonly PaintItem[] = [...frame.underlay, ...frame.content];
    const first = new Map<string, number>();
    items.forEach((item, index) => {
        if (!first.has(item.nodeId) && doc.nodes.get(item.nodeId as NodeId)?.kind === 'embed') first.set(item.nodeId, index);
    });
    const presented: EmbedPresentedNode[] = [];
    for (const [nodeId, index] of first) {
        const node = doc.nodes.get(nodeId as NodeId) as EmbedNode;
        const card = items[index];
        const world = quadBounds(card.localToWorld, node.w, node.h);
        const laterPaint: EmbedLaterPaint[] = [];
        for (let j = index + 1; j < items.length; j++) {
            const item = items[j];
            if (item.nodeId === nodeId) continue;
            if (!item.allocationBounds) throw new Error(`Later paint over embed ${nodeId} has no allocation bounds`);
            if (!overlaps(item.allocationBounds, world)) continue;
            laterPaint.push(...laterCoverage(item, nodeId, pane, deviceScale));
        }
        presented.push({ nodeId, source: node.url, order: index, rect: { x: 0, y: 0, width: node.w, height: node.h },
            toPane: compose(pane, card.localToWorld), clips: clipsOf(card.clips, pane), opacity: inheritedOpacity(doc, node),
            poster: omitted?.has(nodeId) ? 'omitted' : 'painted', laterPaint: Object.freeze(laterPaint) });
    }
    return Object.freeze(presented);
}

/**
 * Builds one owned embed presentation packet from the actual presented frame and hands it to the
 * presentation port. It is a composable callback: the owner forwards each presented frame to it,
 * and it never registers its own viewer interaction. The raw frame is retained synchronously before
 * any work, and the retain is released only when the packet is released, never on a logical abort.
 */
export function createNativeEmbedPresentationProducer(options: NativeEmbedPresentationOptions): NativeEmbedPresented {
    return (revision, token, frame, context) => {
        if (!frame || !context) return;
        const releaseRaw = context.retain();
        let handed = false;
        try {
            if (frame.sceneRevision !== revision || !sameRender(frame.token, token)) return void releaseRaw();
            const doc = frame.sourceDoc;
            if (!doc) throw new Error('Embed presentation needs the pinned source document of the presented frame');
            const pane = options.paneTransform(context.view, context.frameId), presentation = options.presentation(context.frameId, context.token);
            if (!pane || !presentation) return void releaseRaw();
            const packet: EmbedPresentationFrame = { presentation, sceneRevision: frame.sceneRevision,
                viewport: Object.freeze({ width: context.view.viewport.width, height: context.view.viewport.height }),
                nodes: presentedEmbeds(doc, frame, context.omittedNodeIds, pane, context.view.camera.z * context.view.viewport.dpr), release: () => releaseRaw() };
            handed = true;
            options.port.present(packet);
        } catch (error) {
            if (!handed) releaseRaw();
            options.onError(error);
        }
    };
}
