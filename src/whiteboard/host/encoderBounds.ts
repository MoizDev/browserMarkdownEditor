import { pageOrigin, worldPose } from '../change/coordinates';
import type { Bounds } from '../format/schema';
import type { ReadSourceRecord } from '../format/readTypes';
import { transformBox, validBox } from '../geom/bounds';
import type { Box } from '../geom/bounds';
import { nextDown, nextUp } from '../geom/numeric';
import type { BoardDoc } from '../model/doc';
import type { NodeId, SheetId } from '../model/ids';
import type { Node } from '../model/nodes';
import type { LocalGeometryBounds } from '../scene/bounds';
import { yieldToHost } from '../../platform/yieldToHost';

type Fields = Readonly<Record<string, unknown>>;
type Realized = { readonly fields: Fields; readonly epoch: unknown; readonly local: LocalGeometryBounds };
function fields(node: Readonly<Node>): Fields {
    const value: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(node)) value[key] = Reflect.get(node, key);
    return value;
}
function matches(node: Readonly<Node>, snapshot: Fields): boolean {
    const keys = Object.keys(snapshot);
    if (Object.keys(node).length !== keys.length) return false;
    return keys.every(key => Object.hasOwn(node, key) && Object.is(Reflect.get(node, key), snapshot[key]));
}
function copyLocal(value: LocalGeometryBounds): LocalGeometryBounds {
    if (!value || !validBox(value.ink) || (value.hit && !validBox(value.hit))) throw new RangeError('Invalid encoder geometry bounds');
    return { ink: [value.ink[0], value.ink[1], value.ink[2], value.ink[3]],
        ...(value.hit ? { hit: [value.hit[0], value.hit[1], value.hit[2], value.hit[3]] as Box } : {}) };
}
function asBounds(box: ArrayLike<number>, origin: { x: number; y: number }): Bounds {
    const x = nextDown(box[0] - origin.x), y = nextDown(box[1] - origin.y);
    const w = nextUp(nextUp(box[2] - origin.x) - x), h = nextUp(nextUp(box[3] - origin.y) - y);
    if (![x, y, w, h].every(Number.isFinite) || w < 0 || h < 0) throw new RangeError('Invalid native geometry bounds');
    return [x, y, w, h];
}

export async function createBoardEncoderBounds(options: {
    doc: BoardDoc; sources: readonly ReadSourceRecord[];
    local: (node: Readonly<Node>) => LocalGeometryBounds | undefined;
    realize: (node: Readonly<Node>, signal: AbortSignal) => Promise<LocalGeometryBounds>;
    cooperate?: () => Promise<void>;
    geometryEpoch?: () => unknown;
}): Promise<{ bounds(node: Node): Bounds; prepare(ids: Iterable<NodeId>, signal: AbortSignal): Promise<void> }> {
    const { doc } = options, originalRevision = doc.rev;
    const originals = new Map<NodeId, Fields>(), hints = new Map<NodeId, Bounds | null>();
    const host = doc.host;
    const hostPaper = host.kind === 'notebook' ? { ...host.paper } : undefined;
    const hostPages = host.kind === 'pdf-ink' ? host.pages : undefined;
    let count = 0, started = performance.now();
    const tick = async (signal?: AbortSignal) => {
        signal?.throwIfAborted();
        await (options.cooperate?.() ?? yieldToHost());
        signal?.throwIfAborted(); count = 0; started = performance.now();
    };
    const due = () => ++count >= 256 || performance.now() - started >= 3;
    const initCheck = () => { if (doc.rev !== originalRevision) throw new Error('Board changed during encoder bounds capture'); };
    await tick(); initCheck();
    for (const node of doc.nodes.values()) {
        if (due()) { await tick(); initCheck(); }
        originals.set(node.id, fields(node));
    }
    for (const source of options.sources) {
        if (due()) { await tick(); initCheck(); }
        if (source.category !== 'node' || source.id === undefined || source.reencode || !source.nodeBounds) continue;
        const b = source.nodeBounds;
        if (b.length !== 4 || !b.every(Number.isFinite) || b[2] < 0 || b[3] < 0) continue;
        const id = source.id as NodeId;
        hints.set(id, hints.has(id) ? null : [b[0], b[1], b[2], b[3]]);
    }
    initCheck();
    const realized = new Map<NodeId, Realized>(), groupWorld = new Map<NodeId, { revision: number; epoch: unknown; box: Box }>();
    const hostUnchanged = () => {
        if (host.kind !== doc.host.kind) return false;
        if (host.kind === 'pdf-ink' && doc.host.kind === 'pdf-ink') return doc.host.pages === hostPages;
        if (host.kind === 'notebook' && doc.host.kind === 'notebook') {
            const paper = doc.host.paper;
            return !!hostPaper && Object.keys(hostPaper).every(key => Object.is(Reflect.get(paper, key), Reflect.get(hostPaper, key)));
        }
        return true;
    };
    const rootPage = (node: Node): number => {
        let current = node;
        for (let depth = 0; depth < 64; depth++) {
            if (doc.sheets.has(current.parent as SheetId)) return current.page;
            const parent = doc.nodes.get(current.parent as NodeId);
            if (!parent) throw new Error('Encoder bounds parent is missing');
            current = parent;
        }
        throw new Error('Encoder bounds parent depth exceeded');
    };
    const origin = (node: Node) => doc.kind === 'whiteboard' ? { x: 0, y: 0 } : pageOrigin(doc, rootPage(node));
    const world = (node: Node, local: LocalGeometryBounds): Box => {
        if (!validBox(local.ink)) throw new RangeError('Invalid encoder local ink bounds');
        const pose = worldPose(doc, node.id), c = Math.cos(pose.rotation), s = Math.sin(pose.rotation), out = new Float64Array(4);
        transformBox(out, 0, local.ink, 0, [c, s, -s, c, pose.x, pose.y]);
        return [out[0], out[1], out[2], out[3]];
    };
    const originalHint = (node: Node): Bounds | undefined => {
        const hint = hints.get(node.id), initial = originals.get(node.id);
        if (!hint || !initial || node.kind === 'group' || !matches(node, initial) || !hostUnchanged()) return undefined;
        let current: Readonly<Node> = node;
        for (let depth = 0; depth < 64; depth++) {
            if (doc.sheets.has(current.parent as SheetId)) return hint;
            const parent = doc.nodes.get(current.parent as NodeId);
            if (!parent) return undefined;
            const before = originals.get(parent.id);
            if (!before || before.parent !== parent.parent || before.page !== parent.page || before.x !== parent.x
                || before.y !== parent.y || before.rotation !== parent.rotation) return undefined;
            current = parent;
        }
        return undefined;
    };
    const groupUnion = (node: Node, depth: number): Bounds => {
        if (depth >= 64) throw new Error('Encoder bounds group depth exceeded');
        const children = doc.children.get(node.id) ?? [];
        if (!children.length) throw new Error(`Empty group ${node.id} has no geometry bounds`);
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const child of children) {
            const [x, y, w, h] = resolve(child, depth + 1);
            minX = Math.min(minX, x); minY = Math.min(minY, y);
            maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h);
        }
        const x = minX, y = minY, w = nextUp(nextUp(maxX) - x), h = nextUp(nextUp(maxY) - y);
        if (![x, y, w, h].every(Number.isFinite) || w < 0 || h < 0) throw new RangeError('Invalid group geometry bounds');
        return [x, y, w, h];
    };
    const resolve = (node: Node, depth = 0): Bounds => {
        if (doc.nodes.get(node.id) !== node) throw new Error('Encoder bounds require the live board record');
        const live = options.local(node);
        if (live) return asBounds(world(node, copyLocal(live)), origin(node));
        const epoch = options.geometryEpoch?.(), prior = realized.get(node.id);
        if (prior && Object.is(prior.epoch, epoch) && matches(node, prior.fields)) return asBounds(world(node, prior.local), origin(node));
        const group = groupWorld.get(node.id);
        if (node.kind === 'group' && group && group.revision === doc.rev && Object.is(group.epoch, epoch)) return asBounds(group.box, origin(node));
        if (node.kind === 'group') return groupUnion(node, depth);
        const hint = originalHint(node);
        if (hint) return hint;
        throw new Error(`Geometry unavailable for native bounds of node ${node.id}`);
    };
    return {
        bounds: node => resolve(node),
        async prepare(ids, signal) {
            const revision = doc.rev, epoch = options.geometryEpoch?.();
            const check = () => {
                signal.throwIfAborted();
                if (doc.rev !== revision || !Object.is(options.geometryEpoch?.(), epoch)) throw new Error('Board geometry changed during bounds preparation');
            };
            const yieldWork = async () => { check(); await tick(signal); check(); };
            const worldBoxes = new Map<NodeId, Box>();
            const obtain = async (node: Node): Promise<Box> => {
                const live = options.local(node);
                if (live) return world(node, copyLocal(live));
                const cached = realized.get(node.id);
                if (cached && Object.is(cached.epoch, epoch) && matches(node, cached.fields)) return world(node, cached.local);
                if (node.kind === 'opaque') {
                    const hint = originalHint(node);
                    if (hint) { const o = origin(node); return [hint[0] + o.x, hint[1] + o.y, hint[0] + hint[2] + o.x, hint[1] + hint[3] + o.y]; }
                }
                const captured = fields(node);
                const value = await options.realize(node, signal);
                check();
                if (!matches(node, captured)) throw new Error('Node changed during bounds preparation');
                const local = copyLocal(value);
                realized.set(node.id, { fields: captured, epoch, local });
                return world(node, local);
            };
            await yieldWork();
            for (const id of ids) {
                if (due()) await yieldWork();
                const root = doc.nodes.get(id);
                if (!root) throw new Error(`Missing node ${id} during bounds preparation`);
                const stack: { node: Node; expanded: boolean }[] = [{ node: root, expanded: false }];
                while (stack.length) {
                    if (due()) await yieldWork();
                    const frame = stack.pop()!, node = frame.node;
                    if (worldBoxes.has(node.id)) continue;
                    if (node.kind !== 'group') { worldBoxes.set(node.id, await obtain(node)); check(); continue; }
                    const children = doc.children.get(node.id) ?? [];
                    if (!frame.expanded) {
                        stack.push({ node, expanded: true });
                        for (let i = children.length - 1; i >= 0; i--) {
                            if (due()) await yieldWork();
                            if (!worldBoxes.has(children[i].id)) stack.push({ node: children[i], expanded: false });
                        }
                    } else {
                        let box: [number, number, number, number] | undefined;
                        for (const child of children) {
                            if (due()) await yieldWork();
                            const b = worldBoxes.get(child.id);
                            if (!b) throw new Error('Group child bounds unavailable');
                            if (!box) box = [b[0], b[1], b[2], b[3]];
                            else { box[0] = Math.min(box[0], b[0]); box[1] = Math.min(box[1], b[1]); box[2] = Math.max(box[2], b[2]); box[3] = Math.max(box[3], b[3]); }
                        }
                        if (!box) throw new Error(`Empty group ${node.id} has no geometry bounds`);
                        worldBoxes.set(node.id, box); groupWorld.set(node.id, { revision, epoch, box });
                    }
                }
            }
            check();
        },
    };
}
