import type { Affine, Rect } from '../../platform/types';
import { worldPose } from '../change/coordinates';
import type { WorldPose } from '../change/coordinates';
import type { Box } from '../geom/bounds';
import { inverse, transformPoint } from '../geom/affine';
import type { AttachmentSurface } from '../geom/connectorTypes';
import { polylineMatrix, polylinePointSteps, POLYLINE_TOLERANCE_WORLD, type AttachedPolyline } from '../geom/polylinePoints';
import { attachedPolylineTargets, isAttachedPolyline, polylineSurface, polylineSurfaceClips, settlePolylineSteps } from '../geom/polylineResolve';
import type { BoardRuntime } from '../host/runtime';
import type { BoardDoc } from '../model/doc';
import type { NodeId, SheetId } from '../model/ids';
import type { Node, Point, PolylineNode } from '../model/nodes';
import { compareOrder } from '../model/orderKey';
import { IDENTITY, logicalAggregateBox, matrix, type LogicalSource } from './logicalGeometry';
import { yieldToHost } from '../../platform/yieldToHost';

type Prepared = Awaited<ReturnType<BoardRuntime['render']['prepareForPick']>>;
export interface BoardGeometryScopeOptions {
    /** The caller owns this immutable candidate through release. */
    readonly doc?: BoardDoc;
    readonly signal?: AbortSignal;
    /** For a candidate, this must fence its base document version and lifetime too. */
    readonly current?: () => boolean;
    readonly cooperate?: () => Promise<void>;
}
/** The scope's semantic geometry: the renderer's connector/box queries plus the resolved polyline tip. */
export type BoardGeometryScopeGeometry = BoardRuntime['render']['changeGeometry'] & {
    resolvedPolylineTip(doc: BoardDoc, polyline: PolylineNode, terminal: 'start' | 'end'): Point;
};
export interface BoardGeometryScope {
    readonly doc: BoardDoc;
    readonly geometry: BoardGeometryScopeGeometry;
    localBounds(id: NodeId): Box;
    logicalBounds(id: NodeId): Readonly<Rect>;
    /** Actual logical geometry in the caller's rigid target space. */
    boundsInSpace(id: NodeId, targetFromWorld: Affine): Promise<Box>;
    worldPose(id: NodeId): WorldPose;
    rank(id: NodeId): number;
    release(): void;
}

/** A read-only projection uses real C5 data/renderers without inventing a session. */
export interface BoardGeometrySource {
    readonly doc: BoardDoc;
    readonly render: BoardRuntime['render'];
    isCurrent(): boolean;
}

/** Geometry and resources stay pinned until release; the input candidate must stay immutable. */
export function acquireBoardGeometryScope(runtime: BoardRuntime, ids: Iterable<NodeId>, options: BoardGeometryScopeOptions = {}): Promise<BoardGeometryScope> {
    const doc = runtime.session.doc, owner = runtime.session.owner, revision = doc.rev;
    return acquireBoardGeometryProjection({ doc, render: runtime.render,
        isCurrent: () => runtime.session.doc === doc && runtime.session.owner === owner && doc.rev === revision }, ids, options);
}

export async function acquireBoardGeometryProjection(source: BoardGeometrySource, ids: Iterable<NodeId>, options: BoardGeometryScopeOptions = {}): Promise<BoardGeometryScope> {
    const { render } = source, doc = options.doc ?? source.doc, signal = options.signal ?? new AbortController().signal;
    const cooperate = options.cooperate ?? yieldToHost;
    const revision = doc.rev, host = doc.host, roots: NodeId[] = [];
    const live = doc === source.doc, fenced = live || options.current !== undefined;
    const captured = new Map<NodeId, Readonly<Node>>(), children = new Map<NodeId, readonly Node[] | undefined>();
    const incidents = new Map<NodeId, ReadonlySet<NodeId> | undefined>(), sheets = new Map<SheetId, BoardDoc['sheetOrder'][number]>();
    const fast = () => {
        signal.throwIfAborted();
        if (!source.isCurrent() || (options.current && !options.current()) || doc.rev !== revision || doc.host !== host)
            throw new DOMException('Board geometry scope became stale', 'AbortError');
    };
    const all = () => {
        for (const [id, node] of captured) if (doc.nodes.get(id) !== node) throw new DOMException('Board geometry node changed', 'AbortError');
        for (const [id, value] of children) if (doc.children.get(id) !== value) throw new DOMException('Board geometry hierarchy changed', 'AbortError');
        for (const [id, value] of incidents) if (doc.attachedTo.get(id) !== value) throw new DOMException('Board geometry attachment changed', 'AbortError');
        for (const [id, value] of sheets) if (doc.sheets.get(id) !== value) throw new DOMException('Board geometry sheet changed', 'AbortError');
    };
    const check = () => { fast(); if (!fenced) all(); };
    const checkNode = (id: NodeId) => {
        let node = captured.get(id);
        if (!node) throw new Error(`Node is outside geometry scope: ${id}`);
        for (let depth = 0; node && depth < 64; depth++) {
            if (doc.nodes.get(node.id) !== node) throw new DOMException('Board geometry ancestor changed', 'AbortError');
            node = captured.get(node.parent as NodeId);
        }
    };
    let released = false, work = 0, started = performance.now();
    const tick = async () => { check(); await cooperate(); check(); work = 0; started = performance.now(); };
    const due = () => ++work >= 256 || performance.now() - started >= 3;
    const capture = (node: Readonly<Node>) => {
        let value: Readonly<Node> | undefined = node;
        for (let depth = 0; value && depth < 64; depth++) { captured.set(value.id, value); value = doc.nodes.get(value.parent as NodeId); }
    };
    check();
    const unique = new Set<NodeId>();
    for (const id of ids) { if (!unique.has(id)) { unique.add(id); roots.push(id); } if (due()) await tick(); }
    const closure = [...roots], visited = new Set<NodeId>(), dependencies = new Set<NodeId>(roots);
    for (let i = 0; i < closure.length; i++) {
        const id = closure[i]; if (visited.has(id)) continue; visited.add(id);
        const node = doc.nodes.get(id); if (!node) throw new Error(`Geometry node not found: ${id}`); capture(node);
        let ancestor: Readonly<Node> = node;
        for (let depth = 0; depth < 64; depth++) {
            const sheet = doc.sheets.get(ancestor.parent as SheetId);
            if (sheet) { sheets.set(sheet.id, sheet); break; }
            const parent = doc.nodes.get(ancestor.parent as NodeId); if (!parent) throw new Error('Geometry ancestor not found'); ancestor = parent;
        }
        incidents.set(id, doc.attachedTo.get(id));
        for (const attached of doc.attachedTo.get(id) ?? []) { closure.push(attached); if (due()) await tick(); }
        if (node.kind === 'group' || node.kind === 'frame') {
            children.set(id, doc.children.get(id));
            for (const child of doc.children.get(id) ?? []) { closure.push(child.id); if (due()) await tick(); }
        }
        if (node.kind === 'connector') for (const end of [node.start, node.end]) if (end.attach) closure.push(end.attach.target);
        // An attached polyline's resolved ends depend on its targets' actual surfaces, so they are pinned too.
        for (const target of attachedPolylineTargets(node)) { closure.push(target); dependencies.add(target); }
        if (due()) await tick();
    }
    const rendererCurrent = fenced ? () => source.isCurrent() && (!options.current || options.current()) : undefined;
    const lease = await render.pinChangeGeometry(dependencies, signal, doc, rendererCurrent);
    try {
        check();
        const font = render.text.fonts.epoch;
        const prepared = new Map<NodeId, Prepared>(), pending = [...roots], seen = new Set<NodeId>();
        const polylinePoints = new Map<NodeId, readonly Point[]>();
        // Attached ends resolve from the renderer's real surfaces: the cooperative crossings run inside this scope.
        const resolveAttached = async (node: Readonly<Node>): Promise<readonly Point[]> => {
            const surfaces = new Map<NodeId, AttachmentSurface>();
            for (const targetId of attachedPolylineTargets(node)) {
                const target = doc.nodes.get(targetId); if (!target) throw new Error('Polyline attachment target disappeared');
                const value = await render.prepareForPick(target, signal, doc); check();
                if (render.text.fonts.epoch !== font) throw new DOMException('Board fonts changed', 'AbortError');
                const attachments = value.vector?.attachments;
                if (!attachments) throw new Error(`Polyline attachment target has no supported surface: ${targetId}`);
                surfaces.set(targetId, polylineSurface(doc, target, attachments, revision, polylineSurfaceClips(doc, target)));
            }
            const points = await settlePolylineSteps(polylinePointSteps(node as AttachedPolyline, doc, surfaces, POLYLINE_TOLERANCE_WORLD, check), signal, cooperate);
            check(); if (render.text.fonts.epoch !== font) throw new DOMException('Board fonts changed', 'AbortError');
            return points;
        };
        while (pending.length) {
            const id = pending.pop()!; if (seen.has(id)) continue; seen.add(id);
            const node = doc.nodes.get(id); if (!node) throw new Error(`Geometry node disappeared: ${id}`);
            capture(node);
            if (node.kind === 'opaque') throw new Error(`Opaque node lacks logical geometry: ${id}`);
            if (node.kind === 'group' || node.kind === 'frame') {
                children.set(id, doc.children.get(id));
                for (const child of doc.children.get(id) ?? []) { pending.push(child.id); if (due()) await tick(); }
            }
            if (node.kind !== 'group') {
                const value = await render.prepareForPick(node, signal, doc);
                check(); checkNode(id); if (render.text.fonts.epoch !== font) throw new DOMException('Board fonts changed', 'AbortError');
                prepared.set(id, value);
                if (isAttachedPolyline(node)) polylinePoints.set(id, await resolveAttached(node));
            }
            if (due()) await tick();
        }
        const poses = new Map<NodeId, WorldPose>();
        const pose = (id: NodeId) => { let value = poses.get(id); if (!value) { value = worldPose(doc, id); poses.set(id, value); } return value; };
        // The same generators serve the synchronous staged reader; `due` only decides where this scope yields.
        const source: LogicalSource = { prepared: id => prepared.get(id), polylinePoints: id => polylinePoints.get(id),
            children: id => doc.children.get(id) ?? [], pose, check };
        const drive = async <T>(work: Generator<void, T, void>): Promise<T> => {
            for (;;) { const step = work.next(); if (step.done) return step.value; await tick(); }
        };
        const aggregate = async (id: NodeId, targetFromWorld: Affine): Promise<Box> => {
            const root = doc.nodes.get(id); if (!root) throw new Error('Geometry root disappeared');
            return drive(logicalAggregateBox(source, root, targetFromWorld, due));
        };
        const local = new Map<NodeId, Box>(), world = new Map<NodeId, Box>();
        for (const id of roots) {
            const back = inverse(matrix(pose(id)), 1e12); if (!back) throw new Error(`Geometry transform is not invertible: ${id}`);
            local.set(id, await aggregate(id, back)); check(); world.set(id, await aggregate(id, IDENTITY)); check();
            if (render.text.fonts.epoch !== font) throw new DOMException('Board fonts changed', 'AbortError');
        }
        type Path = { sheet: { order: string; id: string }; nodes: readonly { order: string; id: string }[] };
        const paths = new Map<NodeId, Path>();
        for (const id of roots) {
            let node = doc.nodes.get(id)!; const chain: { order: string; id: string }[] = [];
            for (let depth = 0; depth < 64; depth++) {
                chain.push({ order: node.order, id: node.id });
                const sheet = doc.sheets.get(node.parent as SheetId);
                if (sheet) { paths.set(id, { sheet, nodes: chain.reverse() }); break; }
                const parent = doc.nodes.get(node.parent as NodeId); if (!parent) throw new Error('Geometry rank ancestor missing'); node = parent;
            }
            if (!paths.has(id)) throw new Error('Geometry rank ancestry exceeds depth limit');
            if (due()) await tick();
        }
        const compare = (a: NodeId, b: NodeId) => {
            const x = paths.get(a)!, y = paths.get(b)!;
            const sheet = compareOrder(x.sheet, y.sheet); if (sheet) return sheet;
            for (let i = 0; i < Math.min(x.nodes.length, y.nodes.length); i++) {
                const order = compareOrder(x.nodes[i], y.nodes[i]); if (order) return order;
            }
            return x.nodes.length - y.nodes.length;
        };
        let ranked: NodeId[] = [], buffer = new Array<NodeId>(roots.length);
        for (const id of roots) { ranked.push(id); if (due()) await tick(); }
        for (let width = 1; width < ranked.length; width *= 2) {
            for (let start = 0; start < ranked.length; start += 2 * width) {
                const end = Math.min(start + 2 * width, ranked.length), middle = Math.min(start + width, end);
                let left = start, right = middle;
                for (let out = start; out < end; out++) {
                    buffer[out] = left < middle && (right >= end || compare(ranked[left], ranked[right]) <= 0) ? ranked[left++] : ranked[right++];
                    if (due()) await tick();
                }
            }
            [ranked, buffer] = [buffer, ranked];
        }
        const ranks = new Map<NodeId, number>();
        for (let i = 0; i < ranked.length; i++) { ranks.set(ranked[i], i); if (due()) await tick(); }
        // A fenced source cannot mutate behind this cooperative final sweep.
        for (const [id, node] of captured) { if (doc.nodes.get(id) !== node) throw new DOMException('Board geometry node changed', 'AbortError'); if (due()) await tick(); }
        for (const [id, value] of children) { if (doc.children.get(id) !== value) throw new DOMException('Board geometry hierarchy changed', 'AbortError'); if (due()) await tick(); }
        for (const [id, value] of incidents) { if (doc.attachedTo.get(id) !== value) throw new DOMException('Board geometry attachment changed', 'AbortError'); if (due()) await tick(); }
        for (const [id, value] of sheets) { if (doc.sheets.get(id) !== value) throw new DOMException('Board geometry sheet changed', 'AbortError'); if (due()) await tick(); }
        const guard = (id?: NodeId) => { if (released) throw new Error('Geometry scope released'); check();
            if (id) checkNode(id);
            if (render.text.fonts.epoch !== font) throw new DOMException('Board fonts changed', 'AbortError'); };
        guard();
        // A bound end is the resolved local point from this scope's own steps, mapped by the polyline's pose.
        const polylineTip = (candidate: BoardDoc, line: PolylineNode, terminal: 'start' | 'end'): Point => {
            guard(line.id); if (candidate !== doc) throw new Error('Geometry scope document mismatch');
            const current = doc.nodes.get(line.id);
            if (!current || current.kind !== 'polyline') throw new Error(`Polyline is outside geometry scope: ${line.id}`);
            const points = polylinePoints.get(current.id) ?? (isAttachedPolyline(current) ? undefined : current.points);
            if (!points) throw new Error(`Attached polyline geometry is unresolved: ${current.id}`);
            const end = points[terminal === 'start' ? 0 : points.length - 1];
            if (!end) throw new Error(`Polyline end is missing: ${current.id}`);
            return transformPoint(polylineMatrix(doc, current.id), end);
        };
        const geometry: BoardGeometryScopeGeometry = {
            resolvedPolylineTip: polylineTip,
            resolvedTip(candidate, connector, terminal) { guard(connector.id); if (candidate !== doc) throw new Error('Geometry scope document mismatch');
                return render.changeGeometry.resolvedTip(candidate, connector, terminal); },
            elbowRoute(candidate, connector) { guard(connector.id); if (candidate !== doc) throw new Error('Geometry scope document mismatch');
                return render.changeGeometry.elbowRoute(candidate, connector); },
            worldBoundsCenter(candidate, node) { guard(node.id); if (candidate !== doc) throw new Error('Geometry scope document mismatch');
                return render.changeGeometry.worldBoundsCenter(candidate, node); },
        };
        return { doc, geometry,
            localBounds(id) { guard(id); const box = local.get(id); if (!box) throw new Error(`Node is outside geometry scope: ${id}`);
                return [box[0], box[1], box[2], box[3]]; },
            logicalBounds(id) { guard(id); const box = world.get(id); if (!box) throw new Error(`Node is outside geometry scope: ${id}`);
                return { x: box[0], y: box[1], width: box[2] - box[0], height: box[3] - box[1] }; },
            async boundsInSpace(id, targetFromWorld) {
                guard(id); if (!local.has(id) || targetFromWorld.length !== 6 || !targetFromWorld.every(Number.isFinite)) throw new Error('Invalid geometry target space');
                const target: Affine = [...targetFromWorld];
                const box = await aggregate(id, target); guard(id); return box;
            },
            worldPose(id) { guard(id); if (!local.has(id)) throw new Error(`Node is outside geometry scope: ${id}`); return { ...pose(id) }; },
            rank(id) { guard(id); const value = ranks.get(id); if (value === undefined) throw new Error(`Node is outside geometry scope: ${id}`); return value; },
            release() { if (!released) { released = true; lease.release(); } },
        };
    } catch (error) { lease.release(); throw error; }
}
