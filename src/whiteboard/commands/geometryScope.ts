import type { Affine, Rect } from '../../platform/types';
import { worldPose } from '../change/coordinates';
import type { WorldPose } from '../change/coordinates';
import { transformBox, validBox, type Box } from '../geom/bounds';
import { compose, inverse } from '../geom/affine';
import { polylinePath } from '../geom/polylines';
import { transformedPathBounds } from '../geom/providers';
import type { BoardRuntime } from '../host/runtime';
import type { BoardDoc } from '../model/doc';
import type { NodeId, SheetId } from '../model/ids';
import type { Node } from '../model/nodes';
import { compareOrder } from '../model/orderKey';

type Prepared = Awaited<ReturnType<BoardRuntime['render']['prepareForPick']>>;
export interface BoardGeometryScopeOptions {
    /** The caller owns this immutable candidate through release. */
    readonly doc?: BoardDoc;
    readonly signal?: AbortSignal;
    /** For a candidate, this must fence its base document version and lifetime too. */
    readonly current?: () => boolean;
    readonly cooperate?: () => Promise<void>;
}
export interface BoardGeometryScope {
    readonly doc: BoardDoc;
    readonly geometry: BoardRuntime['render']['changeGeometry'];
    localBounds(id: NodeId): Box;
    logicalBounds(id: NodeId): Readonly<Rect>;
    /** Actual logical geometry in the caller's rigid target space. */
    boundsInSpace(id: NodeId, targetFromWorld: Affine): Promise<Box>;
    worldPose(id: NodeId): WorldPose;
    rank(id: NodeId): number;
    release(): void;
}
const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];
function matrix(p: WorldPose): Affine { const c = Math.cos(p.rotation), s = Math.sin(p.rotation); return [c, s, -s, c, p.x, p.y]; }
function union(a: Box | null, b: Box): Box {
    if (!validBox(b)) throw new Error('Invalid prepared logical geometry');
    return a ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])] : b;
}
function transformed(box: Box, m: Affine): Box {
    const out = new Float64Array(4); transformBox(out, 0, box, 0, m, 0); return [out[0], out[1], out[2], out[3]];
}
function rectBox(rect: Rect): Box { return [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height]; }

/** Geometry and resources stay pinned until release; the input candidate must stay immutable. */
export async function acquireBoardGeometryScope(runtime: BoardRuntime, ids: Iterable<NodeId>, options: BoardGeometryScopeOptions = {}): Promise<BoardGeometryScope> {
    const doc = options.doc ?? runtime.session.doc, signal = options.signal ?? new AbortController().signal;
    const cooperate = options.cooperate ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
    const revision = doc.rev, host = doc.host, owner = runtime.session.owner, roots: NodeId[] = [];
    const live = doc === runtime.session.doc, fenced = live || options.current !== undefined;
    const captured = new Map<NodeId, Readonly<Node>>(), children = new Map<NodeId, readonly Node[] | undefined>();
    const incidents = new Map<NodeId, ReadonlySet<NodeId> | undefined>(), sheets = new Map<SheetId, BoardDoc['sheetOrder'][number]>();
    const fast = () => {
        signal.throwIfAborted();
        if ((options.current && !options.current()) || runtime.session.owner !== owner || doc.rev !== revision || doc.host !== host
            || (live && runtime.session.doc !== doc)) throw new DOMException('Board geometry scope became stale', 'AbortError');
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
    const closure = [...roots], visited = new Set<NodeId>();
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
        if (due()) await tick();
    }
    const rendererCurrent = fenced ? () => (!options.current || options.current()) && runtime.session.owner === owner && (!live || runtime.session.doc === doc) : undefined;
    const lease = await runtime.render.pinChangeGeometry(roots, signal, doc, rendererCurrent);
    try {
        check();
        const font = runtime.render.text.fonts.epoch;
        const prepared = new Map<NodeId, Prepared>(), pending = [...roots], seen = new Set<NodeId>();
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
                const value = await runtime.render.prepareForPick(node, signal, doc);
                check(); checkNode(id); if (runtime.render.text.fonts.epoch !== font) throw new DOMException('Board fonts changed', 'AbortError');
                prepared.set(id, value);
            }
            if (due()) await tick();
        }
        const poses = new Map<NodeId, WorldPose>();
        const pose = (id: NodeId) => { let value = poses.get(id); if (!value) { value = worldPose(doc, id); poses.set(id, value); } return value; };
        const leaf = async (node: Readonly<Node>, targetFromWorld: Affine): Promise<Box> => {
            const value = prepared.get(node.id); if (!value) throw new Error(`Geometry not prepared: ${node.id}`);
            const nodeToTarget = compose(targetFromWorld, matrix(pose(node.id)));
            let box: Box | null = null;
            if (node.kind === 'connector') {
                if (!value.connector) throw new Error(`Connector geometry unavailable: ${node.id}`);
                for (const path of [value.connector.body, ...value.connector.heads]) {
                    const bounds = transformedPathBounds(path, targetFromWorld);
                    if (bounds) { const r = node.width / 2; box = union(box, [bounds.x - r, bounds.y - r, bounds.x + bounds.width + r, bounds.y + bounds.height + r]); }
                    if (due()) await tick();
                }
                if (value.connector.label) {
                    const label = value.connector.label, ink = label.paint.ink;
                    box = union(box, transformed(rectBox(ink), compose(targetFromWorld, label.localToWorld)));
                }
            } else if (node.kind === 'stroke') {
                if (!value.ink) throw new Error(`Ink geometry unavailable: ${node.id}`);
                const c = nodeToTarget, point = (x: number, y: number, radius: number) => {
                    const px = c[0] * x + c[2] * y + c[4], py = c[1] * x + c[3] * y + c[5];
                    const rx = radius * Math.hypot(c[0], c[2]), ry = radius * Math.hypot(c[1], c[3]);
                    box = union(box, [px - rx, py - ry, px + rx, py + ry]);
                };
                for (const part of value.ink) {
                    for (let i = 0; i < part.segments.length; i += 6) {
                        point(part.segments[i], part.segments[i + 1], part.segments[i + 2]);
                        point(part.segments[i + 3], part.segments[i + 4], part.segments[i + 5]);
                        if (due()) await tick();
                    }
                    for (let i = 0; i < part.discs.length; i += 3) { point(part.discs[i], part.discs[i + 1], part.discs[i + 2]); if (due()) await tick(); }
                }
            } else if (node.kind === 'polyline') {
                const bounds = transformedPathBounds(polylinePath(node), nodeToTarget);
                if (bounds) box = rectBox(bounds);
            } else {
                if (!value.vector) throw new Error(`Vector geometry unavailable: ${node.id}`);
                box = transformed(rectBox(value.vector.boxLocal), nodeToTarget);
            }
            if (!box) throw new Error(`Logical geometry is empty: ${node.id}`);
            return box;
        };
        const aggregate = async (id: NodeId, targetFromWorld: Affine): Promise<Box> => {
            const root = doc.nodes.get(id); if (!root) throw new Error('Geometry root disappeared');
            const stack: Readonly<Node>[] = [root]; let box: Box | null = null;
            while (stack.length) {
                const node = stack.pop()!;
                if (node.kind === 'group' || (root.kind === 'group' && node.kind === 'frame')) {
                    for (const child of doc.children.get(node.id) ?? []) { stack.push(child); if (due()) await tick(); }
                    if (node.kind === 'group') continue;
                }
                box = union(box, await leaf(node, targetFromWorld)); check();
                if (due()) await tick();
            }
            if (!box) throw new Error(`Empty group has no logical geometry: ${id}`);
            return box;
        };
        const local = new Map<NodeId, Box>(), world = new Map<NodeId, Box>();
        for (const id of roots) {
            const back = inverse(matrix(pose(id)), 1e12); if (!back) throw new Error(`Geometry transform is not invertible: ${id}`);
            local.set(id, await aggregate(id, back)); check(); world.set(id, await aggregate(id, IDENTITY)); check();
            if (runtime.render.text.fonts.epoch !== font) throw new DOMException('Board fonts changed', 'AbortError');
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
            if (runtime.render.text.fonts.epoch !== font) throw new DOMException('Board fonts changed', 'AbortError'); };
        guard();
        const geometry: BoardGeometryScope['geometry'] = {
            resolvedTip(candidate, connector, terminal) { guard(connector.id); if (candidate !== doc) throw new Error('Geometry scope document mismatch');
                return runtime.render.changeGeometry.resolvedTip(candidate, connector, terminal); },
            worldBoundsCenter(candidate, node) { guard(node.id); if (candidate !== doc) throw new Error('Geometry scope document mismatch');
                return runtime.render.changeGeometry.worldBoundsCenter(candidate, node); },
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
