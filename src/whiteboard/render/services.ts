import type { Affine, Rect } from '../../platform/types';
import type { RenderToken } from '../../platform/render/types';
import { worldPose } from '../change/coordinates';
import { compose, inverse } from '../geom/affine';
import { geometrySceneBounds, transformedPathBounds } from '../geom/providers';
import { resolveConnectorGeometry } from '../geom/resolveConnector';
import type { AttachmentSurface, ConnectorGeometry } from '../geom/connectorTypes';
import type { PathOp } from '../geom/path';
import type { InkCoverage } from '../ink/outline';
import type { BoardDoc } from '../model/doc';
import type { NodeId } from '../model/ids';
import { createNode, type Node } from '../model/nodes';
import type { SampleStoreReader } from '../model/samples';
import type { MediaStore } from '../media/store';
import { localBounds, BoundsQuality, type BoundsProvider, type Box, type LocalGeometryBounds } from '../scene/bounds';
import type { ScenePaintRequest } from '../scene/types';
import { paintConnector } from './connectorPaint';
import { conservativeConnectorBounds } from './conservativeConnector';
import { buildStrokeCoverage } from './inkGeometry';
import { paintStrokeNode, paintVectorNode } from './nodePaint';
import { DEFAULT_BOARD_PALETTES } from './palette';
import type { PaintPalette } from './colour';
import { retainPaintNodeResources } from './resourceLeases';
import { localGeometrySignature, sameGeometrySignature } from './retainedKeys';
import { prepareScenePaintSource } from './sceneSource';
import { createBoardTextGeometry } from './textGeometry';
import { prepareBoardVectorGeometry, prepareBoardVectorGeometryNow, prepareOpaqueGeometry, type BoardVectorGeometry } from './vectorGeometry';

interface Prepared {
    readonly key: string;
    readonly signature: readonly unknown[];
    readonly bounds: LocalGeometryBounds;
    readonly vector?: BoardVectorGeometry;
    readonly ink?: readonly InkCoverage[];
    readonly connector?: ConnectorGeometry;
}
function matrix(doc: BoardDoc, id: NodeId): Affine {
    const pose = worldPose(doc, id), c = Math.cos(pose.rotation), s = Math.sin(pose.rotation);
    return [c, s, -s, c, pose.x, pose.y];
}
function rectangle(w: number, h: number): readonly PathOp[] {
    return [{ op: 'M', p: { x: 0, y: 0 } }, { op: 'L', p: { x: w, y: 0 } },
        { op: 'L', p: { x: w, y: h } }, { op: 'L', p: { x: 0, y: h } }, { op: 'Z' }];
}
function frameClips(doc: BoardDoc, node: Readonly<Node>): AttachmentSurface['clips'] {
    const result: AttachmentSurface['clips'][number][] = [];
    let current = doc.nodes.get(node.parent as NodeId);
    for (let depth = 0; current && depth < 64; depth++) {
        if (current.kind === 'frame') result.push({ outline: rectangle(current.w, current.h), localToWorld: matrix(doc, current.id) });
        current = doc.nodes.get(current.parent as NodeId);
    }
    result.reverse(); return result;
}
function rectBox(rect: Rect): Box { return [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height]; }
function union(a: Box | null, b: Box): Box {
    return a ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])] : b;
}

/** One session service resolves the same local geometry for Scene, paint and
 * export. Pinned read-side documents are passed explicitly after every await. */
export function createBoardRenderServices(options: {
    readonly doc: BoardDoc;
    readonly samples: SampleStoreReader;
    readonly media: MediaStore;
    readonly token: RenderToken;
    readonly palettes?: Readonly<{ light: PaintPalette; dark: PaintPalette }>;
    readonly deviceScale?: number;
    cooperate?(): Promise<void>;
}) {
    const cached = new Map<NodeId, Prepared>(), listeners = new Set<(ids: ReadonlySet<NodeId>) => void>();
    const textIds = new Set<NodeId>();
    let serial = 0, disposed = false;
    const palettes = options.palettes ?? DEFAULT_BOARD_PALETTES;
    const text = createBoardTextGeometry({ cooperate: options.cooperate, onFontEpoch() {
        for (const id of textIds) cached.delete(id);
        const ids = new Set(textIds);
        for (const listener of listeners) listener(ids);
    } });
    const check = (signal?: AbortSignal) => {
        signal?.throwIfAborted();
        if (disposed) throw new DOMException('Board rendering services disposed', 'AbortError');
    };
    const signature = (node: Readonly<Node>, doc: BoardDoc): readonly unknown[] => {
        const local = localGeometrySignature(node, text.fonts.epoch, 1);
        if (node.kind !== 'connector') return local;
        const result = [...local, ...matrix(doc, node.id)];
        for (const end of [node.start, node.end]) if (end.attach) {
            const target = doc.nodes.get(end.attach.target);
            if (!target) { result.push(null); continue; }
            result.push(...localGeometrySignature(target, text.fonts.epoch, 1), ...matrix(doc, target.id));
            for (const clip of frameClips(doc, target)) result.push(...clip.localToWorld, clip.outline[1].op === 'L' ? clip.outline[1].p.x : 0,
                clip.outline[2].op === 'L' ? clip.outline[2].p.y : 0);
        }
        return result;
    };
    const prepare = async (borrowed: Readonly<Node>, doc: BoardDoc, signal: AbortSignal): Promise<Prepared> => {
        check(signal);
        const node = createNode(borrowed), before = signature(node, doc), old = cached.get(node.id);
        if (old && sameGeometrySignature(old.signature, before)) { cached.delete(node.id); cached.set(node.id, old); return old; }
        const key = `${options.token.session}:${node.id}:geometry:${++serial}`;
        let result: Omit<Prepared, 'signature'>;
        if (node.kind === 'group') throw new TypeError('Groups aggregate child geometry in Scene');
        if (node.kind === 'stroke') {
            const ink = await buildStrokeCoverage(node, options.samples, { deviceScale: options.deviceScale ?? 3, cooperate: options.cooperate, signal });
            let bounds: Box | null = null;
            for (const chunk of ink) bounds = union(bounds, [chunk.boundsLocal.x, chunk.boundsLocal.y,
                chunk.boundsLocal.x + chunk.boundsLocal.w, chunk.boundsLocal.y + chunk.boundsLocal.h]);
            result = { key, ink, bounds: { ink: bounds ?? [0, 0, 0, 0] } };
        } else if (node.kind === 'connector') {
            // Capture every dependency before awaiting fonts/geometry. An export
            // pin never follows a later target move in the live document.
            const world = matrix(doc, node.id), inverseWorld = inverse(world, 1e12);
            if (!inverseWorld) throw new RangeError('Connector transform is not invertible');
            const targets = new Map<NodeId, { node: Node; world: Affine; clips: AttachmentSurface['clips'] }>();
            for (const end of [node.start, node.end]) if (end.attach && !targets.has(end.attach.target)) {
                const target = doc.nodes.get(end.attach.target);
                if (!target) throw new Error(`Connector ${node.id} has a missing target`);
                targets.set(target.id, { node: createNode(target), world: matrix(doc, target.id), clips: frameClips(doc, target) });
            }
            const surfaces = new Map<NodeId, AttachmentSurface>();
            for (const [id, target] of targets) {
                const prepared = await prepare(target.node, doc, signal);
                const surface = prepared.vector?.attachments;
                if (!surface) throw new Error(`Connector ${node.id} target ${id} has no supported attachment surface`);
                surfaces.set(id, { target: id, outline: surface.outline, logicalBox: surface.logicalBox,
                    localToWorld: target.world, clips: target.clips, revision: doc.rev });
            }
            const resolved = await resolveConnectorGeometry({ key, node, localToWorld: world,
                resolveTarget: id => surfaces.get(id), label: null, toleranceWorld: .01, maxPieces: 65_536 }, {
                signal, cooperate: options.cooperate,
                label: node.label ? async (anchor, length, labelSignal) => {
                    const prepared = await text.prepare(node, { revision: key, connectorLength: length, anchor }, labelSignal);
                    return prepared ? { paint: prepared.paint, localToWorld: [1, 0, 0, 1, prepared.placement.x, prepared.placement.y] } : null;
                } : undefined,
            });
            if (resolved.status !== 'ready') throw new Error(resolved.status === 'unroutable' ? resolved.reason : `Connector ${node.id} geometry is pending: ${resolved.reason}`);
            const geometry = resolved.geometry;
            let local: Box | null = null;
            for (const path of [geometry.body, ...geometry.heads]) {
                const bounds = transformedPathBounds(path, inverseWorld); if (bounds) local = union(local, rectBox(bounds));
            }
            if (geometry.label) {
                const bounds = geometry.label.paint.ink, labelMatrix = compose(inverseWorld, geometry.label.localToWorld);
                const path: PathOp[] = [{ op: 'M', p: { x: bounds.x, y: bounds.y } }, { op: 'L', p: { x: bounds.x + bounds.width, y: bounds.y } },
                    { op: 'L', p: { x: bounds.x + bounds.width, y: bounds.y + bounds.height } }, { op: 'L', p: { x: bounds.x, y: bounds.y + bounds.height } }, { op: 'Z' }];
                const box = transformedPathBounds(path, labelMatrix); if (box) local = union(local, rectBox(box));
            }
            local ??= [node.start.x, node.start.y, node.start.x, node.start.y];
            const half = node.width / 2;
            result = { key, connector: geometry, bounds: { ink: [local[0] - half, local[1] - half, local[2] + half, local[3] + half] } };
        } else {
            const vector = node.kind === 'opaque' ? await prepareOpaqueGeometry(node, signal, options.cooperate)
                : await prepareBoardVectorGeometry(node, { text, revision: key, zoom: 1, signal, cooperate: options.cooperate });
            if (vector.text.length) textIds.add(node.id);
            const bounds = geometrySceneBounds(vector);
            result = { key, vector, bounds: { ink: bounds.ink, hit: bounds.hit } };
        }
        check(signal);
        const prepared: Prepared = { ...result, signature: before };
        cached.delete(node.id); cached.set(node.id, prepared);
        // Retained source items own their geometry by reference after eviction.
        // The v1 default bounds idle local-geometry residency to 256 nodes.
        while (cached.size > 256) cached.delete(cached.keys().next().value!);
        return prepared;
    };
    const bounds: BoundsProvider = {
        local(node) {
            const entry = cached.get(node.id);
            return entry && sameGeometrySignature(entry.signature, signature(node, options.doc)) ? entry.bounds : undefined;
        },
        stroke(node) {
            const summary = options.samples.summary?.(node.samples);
            if (!summary) return undefined;
            const [x, y, w, h] = summary.localBounds;
            return { minX: x, minY: y, maxX: x + w, maxY: y + h, maxPressure: summary.maxPressure };
        },
    };
    return {
        text, bounds,
        /** Conservative native b hint only. Current-font TX3 layout is real
         * geometry, but a conservative connector/ink envelope is NOT a Scene
         * exact-bound or page-placement capability. */
        encoderLocal(node: Readonly<Node>): LocalGeometryBounds | undefined {
            check();
            const hit = bounds.local(node);
            if (hit) return hit;
            if (node.kind === 'group' || node.kind === 'opaque') return undefined;
            if (node.kind === 'connector') return conservativeConnectorBounds(node, options.doc, text);
            if (node.kind === 'stroke') {
                const box = new Float64Array(4), quality = localBounds(node, bounds, box);
                return quality === BoundsQuality.Pending || quality === BoundsQuality.ColdLayout ? undefined : { ink: [box[0], box[1], box[2], box[3]] };
            }
            const key = `${options.token.session}:${node.id}:geometry:${++serial}`;
            const vector = prepareBoardVectorGeometryNow(node, { text, revision: key, zoom: 1 });
            const box = geometrySceneBounds(vector), value = { ink: box.ink, hit: box.hit };
            if (vector.text.length) textIds.add(node.id);
            cached.set(node.id, { key, vector, bounds: value, signature: signature(node, options.doc) });
            while (cached.size > 256) cached.delete(cached.keys().next().value!);
            return value;
        },
        retainNode: (node: Readonly<Node>) => retainPaintNodeResources(node, options.samples, options.media),
        async realize(node: Readonly<Node>, signal: AbortSignal) { return (await prepare(node, options.doc, signal)).bounds; },
        async preparePaint(doc: BoardDoc, request: ScenePaintRequest, signal: AbortSignal) {
            const palette = palettes[doc.kind === 'whiteboard' ? request.theme : 'light'];
            return prepareScenePaintSource(doc, options.token, request, {
                cooperate: options.cooperate,
                // The output/capture owner clips to the physical page; retaining
                // cross-page nodes here prevents stored page ownership culling.
                intersectsPage: () => true,
                async resolve(node, context, itemSignal) {
                    if (node.kind === 'group') return { content: [] };
                    const geometry = await prepare(node, doc, itemSignal);
                    if (node.kind === 'stroke') return paintStrokeNode(node, geometry.ink!, geometry.key, context, palette);
                    if (node.kind === 'connector') return paintConnector(node, geometry.connector!, context, palette, text.faces);
                    return paintVectorNode(node, geometry.vector!, context, palette, text.faces,
                        { signal: itemSignal, cooperate: options.cooperate, media: node.kind === 'picture' || node.kind === 'clip' ? doc.media.get(node.media!) : undefined });
                },
            }, signal);
        },
        subscribeInvalidation(listener: (ids: ReadonlySet<NodeId>) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        dispose() { if (!disposed) { disposed = true; text.dispose(); cached.clear(); textIds.clear(); listeners.clear(); } },
    };
}
