import type { Affine, PathCommand, Rect } from '../../platform/types';
import type { RenderToken } from '../../platform/render/types';
import type { BoardDoc } from '../model/doc';
import type { NodeId, ParentId } from '../model/ids';
import type { Node } from '../model/nodes';
import { boardPageStack, pageOrigin } from '../model/pages';
import { compareOrder } from '../model/orderKey';
import type { ScenePaintRequest } from '../scene/types';
import type { PaintClip, PaintItem, PaintNode, PaintNodeSource } from './paintStream';
import type { ScenePaintNodeStream } from './scenePaintStream';
import type { PaintNodeOrder } from './paintOrder';
import { SECURITY_LIMITS } from '../security/limits';
import { yieldToHost } from '../../platform/yieldToHost';

/** The paint source's yield between slices. A chain of setTimeout(0) is clamped to 4 ms from its fifth link, and the streaming source
 * yields every 0.25 ms of work, so a dense tile's read of a sheet waited about 4 ms per slice with the main thread idle (measured,
 * canvas2d DPR 2, the stroke seed fitted at 1% after a hide: one read of 1,024 nodes took 1.26 s, the board 'Loading drawing…' for
 * 2.5 s). The shared yield (utils/yieldToHost.ts) gives input and rendering their turn without the clamp. */

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
    readonly previousDeviceScale?: number;
}
interface ScenePaintFilters {
    readonly orderedIds?: PaintNodeOrder;
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

/** How many nodes the traversal resolves ahead of the one it emits. A stroke resolves through a geometry-worker round trip; one
 * node at a time, a paint stream waited on each in turn with the main thread and the worker mostly idle (measured, WebGL2,
 * Strokes-3 open: main 60% idle and the geometry worker 85% idle for 7 s). Bounded, so only this many resolutions are held. */
const RESOLVE_AHEAD = 16;
/** `resolve` starts a node's resolution (its answer is not awaited); `take` hands back the oldest started one, in canonical order. */
type PaintStep = { readonly kind: 'cooperate' } | { readonly kind: 'resolve'; readonly node: Readonly<Node>; readonly context: SceneResolveContext }
    | { readonly kind: 'take' } | { readonly kind: 'emit'; readonly node: PaintNode };
function* scenePaintSource(doc: BoardDoc, token: RenderToken, request: ScenePaintRequest,
    ports: ScenePaintFilters, signal: AbortSignal, streaming = false): Generator<PaintStep, PaintNodeSource, PaintNode | undefined> {
    const revision = doc.rev;
    if (!Number.isSafeInteger(revision) || revision < 0 || !Number.isSafeInteger(token.vaultEpoch) || token.vaultEpoch < 0
        || !Number.isSafeInteger(token.bytesGeneration) || token.bytesGeneration < 0 || !Number.isSafeInteger(token.session) || token.session < 0
        || typeof token.documentId !== 'string' || !token.documentId || !doc.sheets.has(request.sheetId)
        || (request.theme !== 'light' && request.theme !== 'dark')
        || (request.deviceScale !== undefined && (!Number.isFinite(request.deviceScale) || request.deviceScale <= 0))
        || (request.exactScale !== undefined && (!Number.isFinite(request.exactScale) || request.exactScale <= 0))) throw new TypeError('Invalid scene paint identity or request');
    if (request.page !== undefined && (!Number.isSafeInteger(request.page) || request.page < 0 || !ports.intersectsPage)) throw new TypeError('Page-filtered paint requires an exact page intersection provider');
    const pinnedToken: RenderToken = Object.freeze({ ...token });
    const scope = { ...request, ...(request.world ? { world: { ...request.world } } : {}),
        sensitiveNodes: new Set(request.sensitiveNodes) };
    const stack = boardPageStack(doc.host), contexts = new Map<NodeId, Context>();
    const nodes: PaintNode[] = [], seen = streaming ? null : new Set<NodeId>();
    let visited = 0, previousPath: readonly Node[] | null = null;
    let steps = 0, started = performance.now();
    const check = () => { signal.throwIfAborted(); if (doc.rev !== revision) throw new Error('Pinned scene document changed during paint preparation'); };
    const reset = () => { check(); steps = 0; started = performance.now(); };
    const due = () => ++steps >= 256 || performance.now() - started >= (streaming ? 0.25 : 3);
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
                // A scene-precision request resolves its strokes at its band with no level of detail (the band is the request's device scale).
                deviceScale: scope.deviceScale, sensitive: scope.sensitiveNodes.has(item.id),
                allowInkLod: !scope.scenePrecision && !!scope.allowInkLod, previousDeviceScale: scope.previousDeviceScale };
            contexts.set(item.id, parent);
            if (streaming && contexts.size > 256) contexts.delete(contexts.keys().next().value!);
        }
        return parent!;
    };
    const orderedPath = (node: Node): readonly Node[] => {
        const path: Node[] = [], ancestors = new Set<NodeId>();
        let current: Node | undefined = node;
        while (current) {
            if (ancestors.has(current.id) || path.length >= 64) throw new Error('Invalid scene parent chain');
            ancestors.add(current.id); path.push(current);
            if (current.parent === scope.sheetId) break;
            current = doc.nodes.get(current.parent as NodeId);
            if (!current || (current.kind !== 'group' && current.kind !== 'frame')) throw new Error('Scene node is outside the requested sheet');
        }
        if (!path.length || path[path.length - 1].parent !== scope.sheetId) throw new Error('Scene node is outside the requested sheet');
        path.reverse();
        if (previousPath) {
            let i = 0;
            while (i < path.length && i < previousPath.length && path[i].id === previousPath[i].id) i++;
            if (i === path.length || (i < previousPath.length && compareOrder(previousPath[i], path[i]) >= 0)) {
                throw new Error('Scene paint order is not strictly canonical');
            }
        }
        previousPath = path;
        return path;
    };
    let resolving = 0;
    const take = function* (): Generator<PaintStep, void, PaintNode | undefined> {
        const result = yield { kind: 'take' };
        resolving--;
        check();
        if (!result || !Array.isArray(result.content) || result.content.length > SECURITY_LIMITS.records
            || (result.underlay !== undefined && (!Array.isArray(result.underlay) || result.underlay.length > SECURITY_LIMITS.records))) throw new TypeError('Invalid resolved paint node');
        const copyItems = function* (items: readonly PaintItem[]): Generator<PaintStep, readonly PaintItem[], PaintNode | undefined> {
            const copy: PaintItem[] = [];
            for (const item of items) {
                if (due()) { check(); yield { kind: 'cooperate' }; reset(); }
                copy.push(result.allocationBounds ? Object.freeze({ ...item, allocationBounds: result.allocationBounds }) : item);
            }
            return Object.freeze(copy);
        };
        const underlay = result.underlay ? yield* copyItems(result.underlay) : undefined;
        const content = yield* copyItems(result.content);
        check();
        const frozen = Object.freeze({ ...(underlay ? { underlay } : {}), content });
        if (streaming) yield { kind: 'emit', node: frozen }; else nodes.push(frozen);
    };
    const visit = function* (id: NodeId): Generator<PaintStep, void, PaintNode | undefined> {
        if (due()) { check(); yield { kind: 'cooperate' }; reset(); }
        if (seen?.has(id)) throw new Error('Duplicate node in scene paint order');
        if (visited >= SECURITY_LIMITS.records || visited >= doc.nodes.size) throw new RangeError('Scene paint node count exceeds bounds');
        visited++; seen?.add(id);
        const node = doc.nodes.get(id);
        if (!node) throw new Error('Scene paint order names a missing node');
        if (streaming) orderedPath(node);
        const ctx = contextFor(node);
        if (scope.page !== undefined && !ports.intersectsPage!(node, ctx, scope.page)) return;
        if (scope.world && ports.visible && !ports.visible(node, ctx, scope.world)) return;
        check();
        yield { kind: 'resolve', node, context: ctx };
        if (++resolving >= RESOLVE_AHEAD) yield* take();
    };
    check();
    if (ports.orderedIds) {
        for (const id of ports.orderedIds) {
            if (id === null) { check(); yield { kind: 'cooperate' }; reset(); }
            else yield* visit(id);
        }
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
    while (resolving > 0) yield* take();
    check();
    return { sourceDoc: doc, token: pinnedToken, theme: request.theme, sceneRevision: revision, sensitiveNodes: scope.sensitiveNodes, nodeCount: nodes.length,
        readNode(index) { if (!Number.isSafeInteger(index) || index < 0 || index >= nodes.length) throw new RangeError('Invalid paint node index'); return nodes[index]; },
        isCurrent: () => !signal.aborted && doc.rev === revision };
}

export function createScenePaintNodeStream(doc: BoardDoc, token: RenderToken, request: ScenePaintRequest,
    ports: ScenePaintPorts, signal: AbortSignal): ScenePaintNodeStream {
    const controller = new AbortController(), revision = doc.rev, pinnedToken = Object.freeze({ ...token });
    const sensitiveNodes = new Set(request.sensitiveNodes);
    const scope: ScenePaintRequest = { ...request, sensitiveNodes, ...(request.world ? { world: { ...request.world } } : {}) };
    const job = scenePaintSource(doc, pinnedToken, scope, ports, controller.signal, true);
    const ahead = new ResolveAhead();
    let active: Promise<PaintNode | null> | null = null, releasePromise: Promise<void> | null = null, ended = false;
    const abort = () => { controller.abort(signal.reason); void release().catch(() => {}); };
    const release = (): Promise<void> => {
        if (releasePromise) return releasePromise;
        controller.abort();
        releasePromise = (async () => {
            try { await active?.catch(() => {}); }
            finally {
                ended = true;
                try { job.return(undefined as never); } finally { signal.removeEventListener('abort', abort); }
            }
        })();
        return releasePromise;
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    return {
        token: pinnedToken, theme: request.theme, sceneRevision: revision, sourceDoc: doc, sensitiveNodes,
        isCurrent: () => !controller.signal.aborted && doc.rev === revision,
        next() {
            if (ended || releasePromise) return Promise.resolve(null);
            if (active) return Promise.reject(new Error('Scene paint stream already has an active consumer'));
            const run = async (): Promise<PaintNode | null> => {
                let value: PaintNode | undefined;
                for (;;) {
                    controller.signal.throwIfAborted();
                    if (doc.rev !== revision) throw new Error('Pinned scene document changed during paint preparation');
                    const next = job.next(value); value = undefined;
                    if (next.done) { ended = true; signal.removeEventListener('abort', abort); return null; }
                    if (next.value.kind === 'emit') return next.value.node;
                    if (next.value.kind === 'resolve') ahead.start(ports.resolve(next.value.node, next.value.context, controller.signal));
                    else if (next.value.kind === 'take') value = await ahead.take();
                    else await (ports.cooperate?.() ?? yieldToHost());
                }
            };
            const promise = run();
            active = promise;
            void promise.then(() => { if (active === promise) active = null; }, () => {
                if (active === promise) active = null;
                void release().catch(() => {});
            });
            return promise;
        },
        release,
    };
}

export async function prepareScenePaintSource(doc: BoardDoc, token: RenderToken, request: ScenePaintRequest,
    ports: ScenePaintPorts, signal: AbortSignal): Promise<PaintNodeSource> {
    const job = scenePaintSource(doc, token, request, ports, signal);
    const ahead = new ResolveAhead();
    let value: PaintNode | undefined;
    try {
        for (;;) {
            signal.throwIfAborted();
            const next = job.next(value); value = undefined;
            if (next.done) return next.value;
            if (next.value.kind === 'resolve') ahead.start(ports.resolve(next.value.node, next.value.context, signal));
            else if (next.value.kind === 'take') value = await ahead.take();
            else await (ports.cooperate?.() ?? yieldToHost());
            signal.throwIfAborted();
        }
    } finally { job.return(undefined as never); }
}

export function prepareScenePaintSourceNow(doc: BoardDoc, token: RenderToken, request: ScenePaintRequest,
    ports: ScenePaintSyncPorts, signal: AbortSignal): PaintNodeSource {
    const job = scenePaintSource(doc, token, request, ports, signal);
    const resolved: PaintNode[] = [];
    let value: PaintNode | undefined, head = 0;
    try {
        for (;;) {
            signal.throwIfAborted();
            const next = job.next(value); value = undefined;
            if (next.done) return next.value;
            if (next.value.kind === 'resolve') resolved.push(ports.resolve(next.value.node, next.value.context, signal));
            else if (next.value.kind === 'take') { value = resolved[head]; resolved[head++] = undefined as never; }
        }
    } finally { job.return(undefined as never); }
}

/** The started resolutions of one traversal, oldest first. A rejection is held until its turn (so a later node's failure never
 * surfaces as an unhandled rejection before an earlier node is taken); one left untaken when the traversal ends is let go. */
class ResolveAhead {
    private readonly queue: Promise<PaintNode>[] = [];
    private head = 0;
    start(resolution: Promise<PaintNode>): void {
        resolution.catch(() => { /* Surfaced by take(), in order. */ });
        this.queue.push(resolution);
    }
    take(): Promise<PaintNode> {
        if (this.head >= this.queue.length) return Promise.reject(new Error('Scene paint took a resolution it did not start'));
        const next = this.queue[this.head];
        this.queue[this.head++] = undefined as never;
        if (this.head > 64 && this.head * 2 > this.queue.length) { this.queue.splice(0, this.head); this.head = 0; }
        return next;
    }
}
