import type { Affine, PathCommand, Rect } from '../../platform/types';
import type { RenderToken } from '../../platform/render/types';
import type { BoardDoc } from '../model/doc';
import type { NodeId, ParentId } from '../model/ids';
import type { Node } from '../model/nodes';
import { boardPageStack, pageOrigin } from '../model/pages';
import type { ScenePaintRequest } from '../scene/types';
import type { PaintClip, PaintItem, PaintNode, PaintNodeSource } from './paintStream';
import { SECURITY_LIMITS } from '../security/limits';

// Provenance: document-model transforms and frame clipping, paint-stream order
// and page-stack contracts; independent traversal, no third-party source.
export interface SceneResolveContext {
    readonly world: Affine;
    readonly clips: readonly PaintClip[];
    readonly opacity: number;
    readonly page: number;
    readonly theme: 'light' | 'dark';
    readonly deviceScale: number | undefined;
    readonly sensitive: boolean;
    readonly allowInkLod: boolean;
}
interface ScenePaintFilters {
    readonly orderedIds?: Iterable<NodeId>;
    intersectsPage?(node: Readonly<Node>, context: SceneResolveContext, page: number): boolean;
    visible?(node: Readonly<Node>, context: SceneResolveContext, world: Readonly<Rect>): boolean;
}
export interface ScenePaintPorts extends ScenePaintFilters {
    resolve(node: Readonly<Node>, context: SceneResolveContext, signal: AbortSignal): Promise<PaintNode>;
    cooperate?(): Promise<void>;
}
export interface ScenePaintSyncPorts extends ScenePaintFilters {
    resolve(node: Readonly<Node>, context: SceneResolveContext, signal: AbortSignal): PaintNode;
}
type Context = SceneResolveContext & { readonly childClips: readonly PaintClip[] };
function compose(parent: Affine, x: number, y: number, angle: number): Affine {
    const c = Math.cos(angle), s = Math.sin(angle), [a, b, d, e, tx, ty] = parent;
    return Object.freeze([a * c + d * s, b * c + e * s, d * c - a * s, e * c - b * s,
        a * x + d * y + tx, b * x + e * y + ty] as const);
}
function frameClip(node: Extract<Node, { kind: 'frame' }>, world: Affine): PaintClip {
    const d: readonly PathCommand[] = [ ['M', 0, 0], ['L', node.w, 0], ['L', node.w, node.h], ['L', 0, node.h], ['Z'] ];
    return { key: `frame:${node.id}`, d, fillRule: 'nonzero', localToWorld: world };
}

type PaintStep = { readonly kind: 'cooperate' } | { readonly kind: 'resolve'; readonly node: Readonly<Node>; readonly context: SceneResolveContext };
function* scenePaintSource(doc: BoardDoc, token: RenderToken, request: ScenePaintRequest,
    ports: ScenePaintFilters, signal: AbortSignal): Generator<PaintStep, PaintNodeSource, PaintNode | undefined> {
    const revision = doc.rev;
    if (!Number.isSafeInteger(revision) || revision < 0 || !Number.isSafeInteger(token.vaultEpoch) || token.vaultEpoch < 0
        || !Number.isSafeInteger(token.bytesGeneration) || token.bytesGeneration < 0 || !Number.isSafeInteger(token.session) || token.session < 0
        || typeof token.documentId !== 'string' || !token.documentId || !doc.sheets.has(request.sheetId)
        || (request.theme !== 'light' && request.theme !== 'dark')
        || (request.deviceScale !== undefined && (!Number.isFinite(request.deviceScale) || request.deviceScale <= 0))) throw new TypeError('Invalid scene paint identity or request');
    if (request.page !== undefined && (!Number.isSafeInteger(request.page) || request.page < 0 || !ports.intersectsPage)) throw new TypeError('Page-filtered paint requires an exact page intersection provider');
    const pinnedToken: RenderToken = Object.freeze({ ...token });
    const scope = { ...request, ...(request.world ? { world: { ...request.world } } : {}),
        sensitiveNodes: new Set(request.sensitiveNodes) };
    const stack = boardPageStack(doc.host), contexts = new Map<NodeId, Context>();
    const nodes: PaintNode[] = [], seen = new Set<NodeId>();
    let steps = 0, started = performance.now();
    const check = () => { signal.throwIfAborted(); if (doc.rev !== revision) throw new Error('Pinned scene document changed during paint preparation'); };
    const reset = () => { check(); steps = 0; started = performance.now(); };
    const due = () => ++steps >= 256 || performance.now() - started >= 3;
    const contextFor = (node: Node): Context => {
        const cached = contexts.get(node.id); if (cached) return cached;
        const path: Node[] = [], ancestors = new Set<NodeId>();
        let current: Node | undefined = node, parent: Context | undefined;
        while (current) {
            const found = contexts.get(current.id);
            if (found) { parent = found; break; }
            if (ancestors.has(current.id) || path.length >= 64) throw new Error('Invalid scene parent chain');
            ancestors.add(current.id); path.push(current);
            if (current.parent === scope.sheetId) break;
            current = doc.nodes.get(current.parent as NodeId);
            if (!current || (current.kind !== 'group' && current.kind !== 'frame')) throw new Error('Scene node is outside the requested sheet');
        }
        for (let i = path.length - 1; i >= 0; i--) {
            const item = path[i], root = !parent;
            if (root && item.parent !== scope.sheetId) throw new Error('Scene node is outside the requested sheet');
            const page = root ? item.page : parent!.page;
            const origin = root && stack ? pageOrigin(stack, page) : undefined;
            if (root && stack && !origin) throw new Error('Paged scene has no page origin');
            const base: Affine = parent?.world ?? [1, 0, 0, 1, origin?.x ?? 0, origin?.y ?? 0];
            const world = compose(base, item.x, item.y, item.rotation);
            const clips = parent?.childClips ?? [];
            const childClips = item.kind === 'frame' ? [...clips, frameClip(item, world)] : clips;
            parent = { world, clips, childClips, opacity: (parent?.opacity ?? 1) * item.opacity, page, theme: scope.theme,
                deviceScale: scope.deviceScale, sensitive: scope.sensitiveNodes.has(item.id), allowInkLod: !!scope.allowInkLod };
            contexts.set(item.id, parent);
        }
        return parent!;
    };
    const visit = function* (id: NodeId): Generator<PaintStep, void, PaintNode | undefined> {
        if (due()) { check(); yield { kind: 'cooperate' }; reset(); }
        if (seen.has(id)) throw new Error('Duplicate node in scene paint order');
        if (seen.size >= SECURITY_LIMITS.records || seen.size >= doc.nodes.size) throw new RangeError('Scene paint node count exceeds bounds');
        seen.add(id);
        const node = doc.nodes.get(id);
        if (!node) throw new Error('Scene paint order names a missing node');
        const ctx = contextFor(node);
        if (scope.page !== undefined && !ports.intersectsPage!(node, ctx, scope.page)) return;
        if (scope.world && ports.visible && !ports.visible(node, ctx, scope.world)) return;
        check();
        const result = yield { kind: 'resolve', node, context: ctx };
        check();
        if (!result || !Array.isArray(result.content) || result.content.length > SECURITY_LIMITS.records
            || (result.underlay !== undefined && (!Array.isArray(result.underlay) || result.underlay.length > SECURITY_LIMITS.records))) throw new TypeError('Invalid resolved paint node');
        const copyItems = function* (items: readonly PaintItem[]): Generator<PaintStep, readonly PaintItem[], PaintNode | undefined> {
            const copy: PaintItem[] = [];
            for (const item of items) { if (due()) { check(); yield { kind: 'cooperate' }; reset(); } copy.push(item); }
            return Object.freeze(copy);
        };
        const underlay = result.underlay ? yield* copyItems(result.underlay) : undefined;
        const content = yield* copyItems(result.content);
        check();
        nodes.push(Object.freeze({ ...(underlay ? { underlay } : {}), content }));
    };
    check();
    if (ports.orderedIds) {
        for (const id of ports.orderedIds) yield* visit(id);
    } else {
        const frames: Iterator<Node>[] = [(doc.children.get(scope.sheetId as ParentId) ?? [])[Symbol.iterator]()];
        while (frames.length) {
            if (due()) { check(); yield { kind: 'cooperate' }; reset(); }
            const next = frames[frames.length - 1].next();
            if (next.done) { frames.pop(); continue; }
            const node = next.value;
            yield* visit(node.id);
            const children = doc.children.get(node.id);
            if (children?.length) frames.push(children[Symbol.iterator]());
        }
    }
    check();
    return { token: pinnedToken, sceneRevision: revision, sensitiveNodes: scope.sensitiveNodes, nodeCount: nodes.length,
        readNode(index) { if (!Number.isSafeInteger(index) || index < 0 || index >= nodes.length) throw new RangeError('Invalid paint node index'); return nodes[index]; },
        isCurrent: () => !signal.aborted && doc.rev === revision };
}

export async function prepareScenePaintSource(doc: BoardDoc, token: RenderToken, request: ScenePaintRequest,
    ports: ScenePaintPorts, signal: AbortSignal): Promise<PaintNodeSource> {
    const job = scenePaintSource(doc, token, request, ports, signal);
    let value: PaintNode | undefined;
    try {
        for (;;) {
            signal.throwIfAborted();
            const next = job.next(value); value = undefined;
            if (next.done) return next.value;
            if (next.value.kind === 'resolve') value = await ports.resolve(next.value.node, next.value.context, signal);
            else await (ports.cooperate?.() ?? new Promise<void>(resolve => setTimeout(resolve, 0)));
            signal.throwIfAborted();
        }
    } finally { job.return(undefined as never); }
}

export function prepareScenePaintSourceNow(doc: BoardDoc, token: RenderToken, request: ScenePaintRequest,
    ports: ScenePaintSyncPorts, signal: AbortSignal): PaintNodeSource {
    const job = scenePaintSource(doc, token, request, ports, signal);
    let value: PaintNode | undefined;
    try {
        for (;;) {
            signal.throwIfAborted();
            const next = job.next(value); value = undefined;
            if (next.done) return next.value;
            if (next.value.kind === 'resolve') value = ports.resolve(next.value.node, next.value.context, signal);
        }
    } finally { job.return(undefined as never); }
}
