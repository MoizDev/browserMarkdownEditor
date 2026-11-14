import type { Affine, PathCommand } from '../../platform/types';
import { worldPose } from '../change/coordinates';
import type { Op } from '../change/ops';
import { sheetOf, type BoardDoc } from '../model/doc';
import type { NodeId, ParentId } from '../model/ids';
import { createNode, type Node } from '../model/nodes';
import { compareOrder } from '../model/orderKey';
import type { BoardRuntime } from '../host/runtime';
import { createBoardLayers, type BoardLayerPair } from '../render/boardLayers';
import { createPaintFrameAssembler } from '../render/frameAssembler';
import type { PaintClip, PaintFrame, PaintNodeSource, PaintTextItem } from '../render/paintStream';
import { textPaintMaterial } from '../render/textGeometry';
import type { FaceTable, TextPaint } from '../text/paint';
import type { PaintImageProvider } from '../render/resources';
import type { ScenePaintRequest, SceneSnapshot } from '../scene/types';
import type { ViewerEngine } from './types';

export interface BoardPreviewOptions {
    readonly engine: ViewerEngine;
    readonly runtime: BoardRuntime;
    readonly render: {
        retainNode(node: Readonly<Node>): { release(): void };
        prepareOverlay(doc: BoardDoc, request: ScenePaintRequest, ids: readonly NodeId[], signal: AbortSignal): Promise<PaintNodeSource>;
    };
    readonly images: PaintImageProvider;
    readonly current: () => boolean;
    readonly onError: (error: unknown) => void;
}
export interface BoardPreview {
    show(nodes: readonly Node[]): void;
    showOps(ops: readonly Op[]): void;
    waitUntilReady(signal: AbortSignal): Promise<void>;
    waitUntilIdle(signal: AbortSignal): Promise<void>;
    armCommit(): void;
    finishCommit(): void;
    cancelCommit(): void;
    presented(revision: number, token: import('../../platform/render/types').RenderToken, frame?: PaintFrame): void;
    showTextPaint(node: Node, paint: TextPaint, faces: FaceTable, localToWorld: Affine): void;
    clear(): void;
    dispose(): void;
}

/** Sparse immutable overlay; untouched model tables and node records stay pinned by Scene. */
class OverlayNodes implements ReadonlyMap<NodeId, Node> {
    readonly [Symbol.toStringTag] = 'OverlayNodes';
    readonly size: number;
    constructor(private readonly base: ReadonlyMap<NodeId, Node>, private readonly changes: ReadonlyMap<NodeId, Node>) {
        let size = base.size;
        for (const id of changes.keys()) if (!base.has(id)) size++;
        this.size = size;
    }
    get(id: NodeId): Node | undefined { return this.changes.get(id) ?? this.base.get(id); }
    has(id: NodeId): boolean { return this.changes.has(id) || this.base.has(id); }
    *entries(): MapIterator<[NodeId, Node]> {
        for (const [id, node] of this.base) yield [id, this.changes.get(id) ?? node];
        for (const [id, node] of this.changes) if (!this.base.has(id)) yield [id, node];
    }
    *keys(): MapIterator<NodeId> { for (const [id] of this.entries()) yield id; }
    *values(): MapIterator<Node> { for (const [, node] of this.entries()) yield node; }
    [Symbol.iterator](): MapIterator<[NodeId, Node]> { return this.entries(); }
    forEach(fn: (value: Node, key: NodeId, map: ReadonlyMap<NodeId, Node>) => void, thisArg?: unknown): void {
        for (const [id, node] of this.entries()) fn.call(thisArg, node, id, this);
    }
}
function copyNode(node: Node): Node { return createNode(structuredClone(node)); }
function operationNodes(doc: BoardDoc, ops: readonly Op[]): { changes: Map<NodeId, Node>; paper?: Readonly<import('../../utils/paper').NotebookPaper> } {
    const changes = new Map<NodeId, Node>();
    let paper: Readonly<import('../../utils/paper').NotebookPaper> | undefined;
    for (const op of ops) {
        if (op.t === 'create') {
            if (doc.nodes.has(op.node.id) || changes.has(op.node.id)) throw new Error('Preview creation already exists');
            changes.set(op.node.id, createNode(structuredClone(op.node)));
        } else if (op.t === 'set') {
            const old = changes.get(op.id) ?? doc.nodes.get(op.id);
            if (!old || old.kind === 'opaque' || !Object.hasOwn(old, op.key) || ['id', 'kind', 'ext', 'raw'].includes(op.key)) {
                throw new Error('Unsupported preview property');
            }
            changes.set(op.id, copyNode({ ...old, [op.key]: structuredClone(op.value) } as Node));
        } else if (op.t === 'board' && op.key === 'host.paper' && doc.host.kind === 'notebook') {
            const before = paper ?? doc.host.paper, next = op.value;
            if (!Number.isSafeInteger(next.pageCount) || next.pageCount < before.pageCount
                || Object.keys(before).some(key => key !== 'pageCount' && !Object.is(before[key as keyof typeof before], next[key as keyof typeof next]))) {
                throw new Error('Preview paper changes must only grow the page stack');
            }
            paper = structuredClone(next);
        } else throw new Error(`Unsupported preview operation: ${op.t}`);
    }
    return { changes, ...(paper ? { paper } : {}) };
}

export function createBoardPreview(options: BoardPreviewOptions): BoardPreview {
    const { runtime, engine, render } = options;
    if (engine.session !== runtime.session) throw new Error('Preview needs the existing board session');
    let disposed = false, generation = 0, pin: SceneSnapshot | null = null, document: Promise<BoardDoc> | null = null;
    let controller: AbortController | null = null, pendingRelease: (() => void) | null = null, pair: BoardLayerPair | null = null;
    let frames: ReturnType<typeof createPaintFrameAssembler> | null = null;
    let requestedIds: ReadonlySet<string> | null = null, requestedGeneration = -1;
    let commitRevision: number | null = null, commitRelease: (() => void) | null = null;
    const frameIds = new WeakMap<PaintFrame, ReadonlySet<string>>(), frameGenerations = new WeakMap<PaintFrame, number>();
    const waiters = new Set<{ generation: number; resolve(): void; reject(error: unknown): void; signal: AbortSignal; abort(): void }>();
    const idleWaiters = new Set<{ resolve(): void; reject(error: unknown): void; signal: AbortSignal; abort(): void }>();
    const settleIdle = () => {
        for (const waiter of [...idleWaiters]) {
            idleWaiters.delete(waiter); waiter.signal.removeEventListener('abort', waiter.abort); waiter.resolve();
        }
    };
    const settle = (error?: unknown) => {
        for (const waiter of [...waiters]) {
            waiters.delete(waiter); waiter.signal.removeEventListener('abort', waiter.abort);
            if (error !== undefined) waiter.reject(error); else waiter.resolve();
        }
    };
    const interrupted = () => new DOMException('Board preview was superseded', 'AbortError');
    const held = new Set<{ release(): void }>();
    const report = (error: unknown) => { try { options.onError(error); } catch { /* reporting must not prevent release */ } };
    const release = (lease: { release(): void }) => { if (held.delete(lease)) { try { lease.release(); } catch (error) { report(error); } } };
    const clearNow = () => {
        generation++; settle(interrupted()); controller?.abort(); controller = null; pendingRelease?.(); pendingRelease = null;
        const releaseCommit = commitRelease; commitRelease = null; commitRevision = null;
        const oldFrames = frames; frames = null; pair = null; requestedIds = null;
        try { oldFrames?.dispose(); } catch (error) { report(error); }
        for (const lease of [...held]) release(lease);
        const oldPin = pin; pin = null; document = null;
        try { oldPin?.release(); } catch (error) { report(error); }
        try { engine.setPreviewLayers(null); } finally { try { releaseCommit?.(); } finally { settleIdle(); } }
    };
    const clear = () => {
        if (commitRevision !== null && options.current() && engine.getView().visible && runtime.session.doc.rev <= commitRevision) return;
        clearNow();
    };
    const unbind = engine.bindPreviewClear(clear);
    const start = (changes: Map<NodeId, Node>, textOverlay?: Readonly<{ node: NodeId; paint: TextPaint; faces: FaceTable; localToWorld: Affine }>,
        paper?: Readonly<import('../../utils/paper').NotebookPaper>) => {
        if (disposed) throw new Error('Preview is disposed');
        if (!changes.size) { clear(); return; }
        if (commitRevision !== null) throw new Error('A committed preview is awaiting presentation');
        if (!options.current() || !engine.getView().visible) throw new Error('Preview view is not current and visible');
        const live = runtime.session.doc, scene = runtime.scene;
        for (const node of changes.values()) {
            const existing = live.nodes.get(node.id);
            if (existing && existing.kind !== node.kind) throw new Error('Preview cannot replace a node kind');
        }
        if (!scene || !scene.ready || scene.revision !== live.rev) throw new Error('Preview scene is not ready');
        if (pin && pin.revision !== live.rev) clear();
        if (!pin) { pin = scene.pin(); document = pin.readDocument(); }
        const pinned = pin, base = document!;
        const view = engine.getView(), selection = runtime.selection.getSnapshot();
        const sheet = view.sheetId ?? selection.sheet;
        const job = new AbortController(), seq = ++generation;
        settle(interrupted()); controller?.abort(); pendingRelease?.(); pendingRelease = null; controller = job;
        const leases: { release(): void }[] = [];
        try {
            for (const node of changes.values()) { const lease = render.retainNode(node); held.add(lease); leases.push(lease); }
        } catch (error) { for (const lease of leases) release(lease); throw error; }
        let handedOff = false;
        const releaseLeases = () => { for (const lease of leases) release(lease); };
        pendingRelease = releaseLeases;
        const check = () => {
            job.signal.throwIfAborted();
            if (disposed || !options.current() || generation !== seq || pin !== pinned
                || (live.rev !== pinned.revision && live.rev !== commitRevision)
                || !engine.getView().visible || (engine.getView().sheetId ?? runtime.selection.getSnapshot().sheet) !== sheet
                || engine.getView().theme !== view.theme) throw new DOMException('Preview superseded', 'AbortError');
        };
        void (async () => {
            try {
                const original = await base; check();
                const nodes = new OverlayNodes(original.nodes, changes);
                if (paper && original.host.kind !== 'notebook') throw new Error('Preview paper target changed');
                const host = paper && original.host.kind === 'notebook' ? { ...original.host, paper } : original.host;
                const doc: BoardDoc = { ...original, nodes, host };
                if (!doc.sheets.has(sheet)) throw new Error('Preview sheet is unavailable');
                const candidates = new Set<NodeId>(), pending = [...changes.keys()];
                const additional = new Map<ParentId, NodeId[]>();
                for (const node of changes.values()) {
                    if (sheetOf(doc, node.id) !== sheet) throw new Error('Preview node is outside the active sheet');
                    if ((node.kind === 'picture' || node.kind === 'clip') && node.media && !doc.media.has(node.media)) {
                        throw new Error('Preview media metadata is unavailable');
                    }
                    const previous = original.nodes.get(node.id);
                    if (!previous || previous.parent !== node.parent) {
                        const siblings = additional.get(node.parent) ?? []; siblings.push(node.id); additional.set(node.parent, siblings);
                    }
                }
                let work = 0;
                while (pending.length) {
                    check();
                    const id = pending.pop()!;
                    if (candidates.has(id)) continue;
                    const node = nodes.get(id); if (!node) throw new Error('Preview node is unavailable');
                    candidates.add(id);
                    if (node.kind === 'group' || node.kind === 'frame') {
                        for (const child of original.children.get(id) ?? []) {
                            if (nodes.get(child.id)?.parent === id) pending.push(child.id);
                            if (++work % 128 === 0) { await new Promise<void>(resolve => setTimeout(resolve, 0)); check(); }
                        }
                        for (const child of additional.get(id) ?? []) {
                            pending.push(child);
                            if (++work % 128 === 0) { await new Promise<void>(resolve => setTimeout(resolve, 0)); check(); }
                        }
                    }
                    for (const connector of original.attachedTo.get(id) ?? []) {
                        pending.push(connector);
                        if (++work % 128 === 0) { await new Promise<void>(resolve => setTimeout(resolve, 0)); check(); }
                    }
                    if (++work % 128 === 0) { await new Promise<void>(resolve => setTimeout(resolve, 0)); check(); }
                }
                const paths = new Map<NodeId, Node[]>();
                for (const id of candidates) {
                    const path: Node[] = [], seen = new Set<NodeId>(); let node = nodes.get(id);
                    while (node) {
                        if (seen.has(node.id) || path.length >= 64) throw new Error('Invalid preview parent chain');
                        seen.add(node.id); path.push(node);
                        if (node.parent === sheet) break;
                        node = nodes.get(node.parent as NodeId);
                    }
                    if (!node || node.parent !== sheet) throw new Error('Preview parent is outside the sheet');
                    paths.set(id, path.reverse());
                    if (++work % 128 === 0) { await new Promise<void>(resolve => setTimeout(resolve, 0)); check(); }
                }
                const compare = (a: NodeId, b: NodeId) => {
                    const x = paths.get(a)!, y = paths.get(b)!;
                    for (let i = 0; i < Math.min(x.length, y.length); i++) {
                        if (x[i].id !== y[i].id) return compareOrder(x[i], y[i]);
                    }
                    return x.length - y.length;
                };
                let ids = [...candidates], scratch = new Array<NodeId>(ids.length);
                // Native Array.sort cannot yield on a large transformed group.
                for (let width = 1; width < ids.length; width *= 2) {
                    for (let from = 0; from < ids.length; from += width * 2) {
                        const mid = Math.min(from + width, ids.length), end = Math.min(from + width * 2, ids.length);
                        let left = from, right = mid;
                        for (let index = from; index < end; index++) {
                            scratch[index] = right >= end || (left < mid && compare(ids[left], ids[right]) <= 0) ? ids[left++] : ids[right++];
                            if (++work % 128 === 0) { await new Promise<void>(resolve => setTimeout(resolve, 0)); check(); }
                        }
                    }
                    [ids, scratch] = [scratch, ids];
                }
                const source = await render.prepareOverlay(doc, { sheetId: sheet, theme: view.theme, sensitiveNodes: new Set(ids) }, ids, job.signal);
                check();
                let textItem: PaintTextItem | null = null, textIndex = -1;
                if (textOverlay) {
                    textIndex = ids.indexOf(textOverlay.node);
                    if (textIndex < 0 || source.nodeCount !== ids.length) throw new Error('Text preview source order changed');
                    const node = nodes.get(textOverlay.node);
                    if (!node || !textOverlay.localToWorld.every(Number.isFinite)) throw new Error('Text preview placement is invalid');
                    let opacity = node.opacity, parent = nodes.get(node.parent as NodeId);
                    const clips: PaintClip[] = [];
                    for (let depth = 0; parent && depth < 64; depth++) {
                        opacity *= parent.opacity;
                        if (parent.kind === 'frame') {
                            const pose = worldPose(doc, parent.id), c = Math.cos(pose.rotation), s = Math.sin(pose.rotation);
                            const d: PathCommand[] = [['M', 0, 0], ['L', parent.w, 0], ['L', parent.w, parent.h], ['L', 0, parent.h], ['Z']];
                            clips.push({ key: `frame:${parent.id}`, d, fillRule: 'nonzero', localToWorld: [c, s, -s, c, pose.x, pose.y] });
                        }
                        parent = nodes.get(parent.parent as NodeId);
                    }
                    clips.reverse();
                    textItem = { kind: 'text', key: `${node.id}:composition:${textOverlay.paint.key}`,
                        nodeId: node.id, geometryKey: `composition:${textOverlay.paint.key}`, localToWorld: textOverlay.localToWorld,
                        clips, paint: textOverlay.paint, faces: textOverlay.faces,
                        material: textPaintMaterial(textOverlay.paint, engine.getSnapshot().palette, opacity) };
                }
                const guarded: PaintNodeSource = { ...source,
                    readNode(index) {
                        const item = source.readNode(index);
                        return textItem && index === textIndex ? { ...item, content: [...item.content.filter(part => part.kind !== 'text'), textItem] } : item;
                    },
                    isCurrent: () => { try { check(); return source.isCurrent(); } catch { return false; } } };
                if (!frames || !pair) {
                    const inner = createPaintFrameAssembler(() => pair?.invalidate('preview-ready'), report);
                    const assembler: typeof inner = { ...inner, prepare(budget) {
                        inner.prepare(budget);
                        const frame = inner.readFrame();
                        if (frame && !frameIds.has(frame) && requestedIds) {
                            frameIds.set(frame, requestedIds); frameGenerations.set(frame, requestedGeneration);
                        }
                    } };
                    const layers = createBoardLayers({ frames: assembler, images: options.images, onError: report, requestedRevision: () => pinned.revision });
                    frames = assembler; pair = layers;
                    engine.setPreviewLayers({ underlay: { ...layers[0], id: 'board-preview-underlay' },
                        content: { ...layers[1], id: 'board-preview-content' } }, () => {
                        const frame = layers.readyFrame();
                        const ids = frame && frameIds.get(frame);
                        if (frame && ids && assembler.isCurrent(frame)) {
                            if (frameGenerations.get(frame) === generation) settle();
                            return { frame, nodeIds: ids };
                        }
                        return null;
                    });
                }
                requestedIds = candidates; requestedGeneration = seq;
                frames.request({ source: guarded, release: releaseLeases }); handedOff = true;
                if (pendingRelease === releaseLeases) pendingRelease = null;
            } catch (error) {
                if (!job.signal.aborted && generation === seq) {
                    clear();
                    if (!(error instanceof DOMException && error.name === 'AbortError')) report(error);
                }
            } finally {
                if (!handedOff) releaseLeases();
                if (pendingRelease === releaseLeases) pendingRelease = null;
            }
        })();
    };
    return {
        show(nodes) {
            try {
                const changes = new Map<NodeId, Node>();
                for (const node of nodes) { if (changes.has(node.id)) throw new Error('Duplicate preview node'); changes.set(node.id, copyNode(node)); }
                start(changes);
            } catch (error) { clear(); report(error); }
        },
        showOps(ops) { try { const projected = operationNodes(runtime.session.doc, ops); start(projected.changes, undefined, projected.paper); } catch (error) { clear(); report(error); } },
        waitUntilReady(signal) {
            if (disposed || signal.aborted || !pin || !controller) return Promise.reject(interrupted());
            const frame = pair?.readyFrame();
            if (frame && frames?.isCurrent(frame) && frameGenerations.get(frame) === generation) return Promise.resolve();
            return new Promise<void>((resolve, reject) => {
                const waiter = { generation, resolve, reject, signal, abort: () => {} };
                waiter.abort = () => { if (waiters.delete(waiter)) reject(interrupted()); };
                waiters.add(waiter); signal.addEventListener('abort', waiter.abort, { once: true });
                if (signal.aborted) waiter.abort();
            });
        },
        waitUntilIdle(signal) {
            if (disposed || signal.aborted) return Promise.reject(interrupted());
            if (commitRevision === null) return Promise.resolve();
            return new Promise<void>((resolve, reject) => {
                const waiter = { resolve, reject, signal, abort: () => {} };
                waiter.abort = () => { if (idleWaiters.delete(waiter)) reject(interrupted()); };
                idleWaiters.add(waiter); signal.addEventListener('abort', waiter.abort, { once: true });
                if (signal.aborted) waiter.abort();
            });
        },
        armCommit() {
            if (disposed || commitRevision !== null || !pin || !options.current()) throw new Error('Preview cannot be committed');
            commitRelease = runtime.session.beginGesture();
            commitRevision = runtime.session.doc.rev + 1;
        },
        finishCommit() { if (commitRevision !== null && runtime.session.doc.rev !== commitRevision) clearNow(); },
        cancelCommit() {
            // An apply can succeed before a later release reports an error; retain its visible preview.
            if (commitRevision !== null && runtime.session.doc.rev === commitRevision) return;
            clearNow();
        },
        presented(revision, token, frame) {
            if (commitRevision === null || revision < commitRevision || !frame || frame.sceneRevision !== revision || !pin) return;
            const expected = pin.token, actual = frame.token;
            if (token.vaultEpoch !== expected.vaultEpoch || token.documentId !== expected.documentId
                || token.bytesGeneration !== expected.bytesGeneration || token.session !== expected.session
                || actual.vaultEpoch !== expected.vaultEpoch || actual.documentId !== expected.documentId
                || actual.bytesGeneration !== expected.bytesGeneration || actual.session !== expected.session) return;
            clearNow();
        },
        showTextPaint(node, paint, faces, localToWorld) {
            try { const copy = copyNode(node); start(new Map([[copy.id, copy]]), { node: copy.id, paint, faces, localToWorld: [...localToWorld] as unknown as Affine }); }
            catch (error) { clear(); report(error); }
        },
        clear,
        dispose() { if (!disposed) { clearNow(); disposed = true; unbind(); } },
    };
}
