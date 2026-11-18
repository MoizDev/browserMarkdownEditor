import type { Affine, PathCommand } from '../../platform/types';
import { yieldToHost } from '../text/cooperative';
import { worldPose } from '../change/coordinates';
import type { Op } from '../change/ops';
import { sheetOf, type BoardDoc } from '../model/doc';
import type { NodeId, ParentId } from '../model/ids';
import { createNode, type Node } from '../model/nodes';
import { compareOrder } from '../model/orderKey';
import type { BoardRuntime } from '../host/runtime';
import { createBoardLayers, type BoardLayerPair } from '../render/boardLayers';
import { createPaintFrameAssembler } from '../render/frameAssembler';
import type { PaintClip, PaintSource, PaintNodeSource, PaintTextItem } from '../render/paintStream';
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
    };
    readonly images: PaintImageProvider;
    readonly current: () => boolean;
    readonly onError: (error: unknown) => void;
}
export interface BoardPreview {
    show(nodes: readonly Node[]): void;
    /** `live`: a pointer move of a transform (the picture is moved, not rebuilt); absent, the picture is built for the ops. */
    showOps(ops: readonly Op[], live?: boolean): void;
    waitUntilReady(signal: AbortSignal): Promise<void>;
    waitUntilIdle(signal: AbortSignal): Promise<void>;
    armCommit(): void;
    finishCommit(): void;
    cancelCommit(): void;
    presented(revision: number, token: import('../../platform/render/types').RenderToken, frame?: PaintSource): void;
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

/** The largest overlay built synchronously at the hand-off (a gesture's few items); a larger one keeps the yielding build. */
const SYNC_OVERLAY_NODES = 16;

export function createBoardPreview(options: BoardPreviewOptions): BoardPreview {
    const { runtime, engine, render } = options;
    if (engine.session !== runtime.session) throw new Error('Preview needs the existing board session');
    let disposed = false, generation = 0, pin: SceneSnapshot | null = null, document: Promise<BoardDoc> | null = null;
    let controller: AbortController | null = null, pendingRelease: (() => void) | null = null, pair: BoardLayerPair | null = null;
    // A handed-off job's paint is the one on screen until its replacement is presented, and its source reads its own
    // abort signal: aborting it at the next launch hid the picture (measured: base omission off in 216 of 392 checks).
    let controllerHandedOff = false;
    let frames: ReturnType<typeof createPaintFrameAssembler> | null = null;
    let requestedIds: ReadonlySet<string> | null = null, requestedGeneration = -1, handedOffGeneration = -1;
    // The overlay's own nodes, refilled at each request: its layers index and draw these items only, never the pinned page.
    const overlayNodes = new Set<string>();
    let commitRevision: number | null = null, commitRelease: (() => void) | null = null;
    const frameIds = new WeakMap<PaintSource, ReadonlySet<string>>(), frameGenerations = new WeakMap<PaintSource, number>();
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
    // A gesture's preview arrives while the Scene is still absorbing the previous edit (each
    // keystroke/composition step bumps doc.rev). Rather than failing the preview, the latest
    // request waits for the Scene to catch up, driven cooperatively like pointQuery/frameDrop.
    type StartArgs = Parameters<typeof start>;
    let deferred: StartArgs | null = null, driving = false, resuming = false;
    // One overlay is in flight at a time: a newer request is held (latest wins) until the layer presents the last one.
    let inFlight = false, inFlightSeq = -1, queued: StartArgs | null = null;
    // A translation's picture is built once, at its committed place, and moved at draw time. A build's `baked` offset is
    // what its picture already includes; a frame is drawn at its build's `offset - baked`. Each build keeps its own offset,
    // so a superseded picture stays where it was last shown until its replacement presents.
    type Shift = { x: number; y: number };
    interface TranslationMeta { baked: Shift; offset: Shift }
    // `ids` are the nodes the translation moves: a later move of the same nodes keeps the built picture.
    let translation: { ids: ReadonlySet<NodeId>; meta: TranslationMeta; ops: readonly Op[] } | null = null;
    const metaBySeq = new Map<number, TranslationMeta>();
    let offsetVersion = 0;
    const NO_SHIFT: Shift = Object.freeze({ x: 0, y: 0 });
    const drawOffset = (frame: PaintSource): Shift => {
        const seq = frameGenerations.get(frame), meta = seq === undefined ? undefined : metaBySeq.get(seq);
        return meta ? { x: meta.offset.x - meta.baked.x, y: meta.offset.y - meta.baked.y } : NO_SHIFT;
    };
    const driveScene = async () => {
        if (driving) return;
        driving = true;
        try {
            while (!disposed && deferred) {
                const scene = runtime.scene;
                if (!scene) { deferred = null; break; }
                if (scene.ready && scene.revision === runtime.session.doc.rev) {
                    const args = deferred; deferred = null;
                    // A commit awaiting presentation owns the overlay; a request deferred before it is superseded by it.
                    // The waiters of the superseded request are settled here: nothing else would settle them (a hang otherwise).
                    if (commitRevision !== null) { settle(interrupted()); break; }
                    resuming = true;
                    try { start(...args); } catch (error) { settle(error ?? interrupted()); clear(); report(error); } finally { resuming = false; }
                    break;
                }
                scene.step(64, performance.now() + 3);
                await yieldToHost();
            }
        } catch (error) { deferred = null; settle(error ?? interrupted()); clear(); report(error); } finally { driving = false; }
    };
    const clearNow = () => {
        deferred = null; queued = null; inFlight = false; inFlightSeq = -1; translation = null; metaBySeq.clear();
        generation++; if (!resuming) settle(interrupted()); controller?.abort(); controller = null; controllerHandedOff = false; pendingRelease?.(); pendingRelease = null;
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
    // The layer presented the overlay in flight: the held request, if any, is the next one built.
    // Only the in-flight job's own frame releases the gate. The layer acknowledges every drawn frame, and a frame of an
    // older request released it at once: each new start then replaced the staging before the frame was built (measured:
    // no overlay frame ever built while the pointer moved; the screencast showed the old spot until release).
    // The layers' ready frame is a wrapper (ink set attached) that the assembler never tagged, so lookups go through the
    // assembler's own frame, matched to the wrapper by revision, theme and token.
    const assemblerFrameOf = (shown: PaintSource | null): PaintSource | null => {
        const own = frames?.readFrame() ?? null;
        return shown && own && own.sceneRevision === shown.sceneRevision && own.theme === shown.theme && own.token === shown.token ? own : null;
    };
    const presentedOverlay = () => {
        if (disposed || !inFlight || !pair) return;
        const ready = assemblerFrameOf(pair.readyFrame());
        if (!ready || frameGenerations.get(ready) !== inFlightSeq) return;
        inFlight = false;
        const next = queued; queued = null;
        // A commit awaiting presentation owns the overlay: a held request made before it is superseded by it.
        if (!next || commitRevision !== null) return;
        // The drained request supersedes nothing: the overlay in flight was already presented. Its start must not
        // reject the waiters of the request that queued it (a shape commit waits on exactly that overlay); measured:
        // the commit was rejected as "Board preview was superseded" and the tool fell back to Select, with no shape.
        resuming = true;
        try { start(...next); } catch (error) { settle(error ?? interrupted()); clear(); report(error); } finally { resuming = false; }
    };
    // The overlay's layers are made when a request starts, not when its build finishes. Measured (gpu-h9, first shape on a PDF):
    // the layers were created 47 ms after the first frame that needed them, so that frame drew a hole and the stand-ins after it.
    // They hold no picture until a request is handed to them, so making them early changes nothing else.
    const ensureLayers = (): { frames: ReturnType<typeof createPaintFrameAssembler>; pair: BoardLayerPair } => {
        if (frames && pair) return { frames, pair };
        // A frame is tagged with the request it was staged for, both when it is published and when a prepare reads it.
        const tag = (frame: PaintSource) => {
            if (!frameIds.has(frame) && requestedIds) { frameIds.set(frame, requestedIds); frameGenerations.set(frame, requestedGeneration); }
        };
        const inner = createPaintFrameAssembler(() => pair?.invalidate('preview-ready'), report, {
            isActive: () => !!engine.getView().visible && (typeof globalThis.document === 'undefined' || !globalThis.document.hidden),
            onPublished: tag,
        });
        const assembler: typeof inner = { ...inner, prepare(budget) {
            inner.prepare(budget);
            const frame = inner.readFrame();
            if (frame) tag(frame);
        } };
        // The layers draw the pinned revision of the request they hold: one pin lives as long as its layers do.
        const layers = createBoardLayers({ frames: assembler, images: options.images, onError: report, requestedRevision: () => pin?.revision ?? -1,
            requestedTheme: () => engine.getView().theme, optional: true, onPresented: presentedOverlay, auditSurface: 'board-preview',
            // Built is enough to take the next request: the built frame is drawn by the next compositor frame, and
            // a request made after a draw is one frame late (measured: the ink trailed the pointer by three frames).
            onPrepared: () => queueMicrotask(presentedOverlay),
            drawOffset, drawVersion: () => offsetVersion,
            onOffsetUnsupported: () => queueMicrotask(rebuildTranslation),
            // The overlay's few nodes are drawn live at the view: a refused tile store cannot stall the drag's preview.
            liveOverlay: true, liveNodes: overlayNodes,
            // An overlay is requested only once it has drawn a node of the hand-off: until then the base draws that node itself and
            // the overlay declares nothing, so a refused admission costs latency and never a hole (gpu's rule).
            requested: () => requestedIds !== null && layers.drawnLiveNodeIds().size > 0 });
        frames = assembler; pair = layers;
        engine.setPreviewLayers({ underlay: { ...layers[0], id: 'board-preview-underlay' },
            content: { ...layers[1], id: 'board-preview-content' } }, () => {
            // Keyed on the layers' wrapper the lookup missed on every drag of an ink node (measured: 84 of 84 calls).
            const frame = assemblerFrameOf(layers.readyFrame());
            const ids = frame && frameIds.get(frame);
            if (frame && ids && assembler.isCurrent(frame)) {
                if (frameGenerations.get(frame) === generation) settle();
                // The base omits a node only from the frame after the overlay drew it: the overlay declares just the nodes it drew.
                const drawn = layers.drawnLiveNodeIds(), declared = new Set<string>();
                for (const id of ids) if (drawn.has(id)) declared.add(id);
                return declared.size ? { frame, nodeIds: declared } : null;
            }
            return null;
        });
        return { frames: assembler, pair: layers };
    };
    const start = (changes: Map<NodeId, Node>, textOverlay?: Readonly<{ node: NodeId; paint: TextPaint; faces: FaceTable; localToWorld: Affine }>,
        paper?: Readonly<import('../../utils/paper').NotebookPaper>, meta: TranslationMeta | null = null) => {
        if (disposed) throw new Error('Preview is disposed');
        if (!changes.size) { clear(); return; }
        if (commitRevision !== null) throw new Error('A committed preview is awaiting presentation');
        if (!options.current() || !engine.getView().visible) throw new Error('Preview view is not current and visible');
        const live = runtime.session.doc, scene = runtime.scene;
        for (const node of changes.values()) {
            const existing = live.nodes.get(node.id);
            if (existing && existing.kind !== node.kind) throw new Error('Preview cannot replace a node kind');
        }
        if (!scene) throw new Error('Preview scene is not available');
        if (!scene.ready || scene.revision !== live.rev) { deferred = [changes, textOverlay, paper, meta]; void driveScene(); return; }
        deferred = null;
        // One overlay is built and presented at a time: a request made meanwhile is held (latest wins).
        if (inFlight) { queued = [changes, textOverlay, paper, meta]; return; }
        if (pin && pin.revision !== live.rev) clear();
        if (!pin) { pin = scene.pin(); document = pin.readDocument(); }
        // Captured before any await: this job's overlay uses the paint binding of its own start,
        // never a binding adopted later by a source rebind (new work only).
        const pinned = pin, base = document!, binding = runtime.paintBinding;
        const view = engine.getView(), selection = runtime.selection.getSnapshot();
        const sheet = view.sheetId ?? selection.sheet;
        const job = new AbortController(), seq = ++generation;
        if (meta) metaBySeq.set(seq, meta);
        if (!resuming) settle(interrupted()); if (!controllerHandedOff) controller?.abort(); pendingRelease?.(); pendingRelease = null;
        controller = job; controllerHandedOff = false; inFlight = true; inFlightSeq = seq;
        // Made now, before the build: a build that ends in a frame must find its layers already in the pane.
        const overlay = ensureLayers();
        const leases: { release(): void }[] = [];
        try {
            for (const node of changes.values()) { const lease = render.retainNode(node); held.add(lease); leases.push(lease); }
        } catch (error) { for (const lease of leases) release(lease); throw error; }
        let handedOff = false;
        const releaseLeases = () => { for (const lease of leases) release(lease); };
        pendingRelease = releaseLeases;
        // The overlay's own validity: its document, view and sheet are still the ones it was built for. Being
        // superseded by a newer request is not invalidity; a presented frame stays drawable until its replacement is.
        const valid = () => {
            if (disposed || !options.current() || pin !== pinned
                || (live.rev !== pinned.revision && live.rev !== commitRevision)
                || !engine.getView().visible || (engine.getView().sheetId ?? runtime.selection.getSnapshot().sheet) !== sheet
                || engine.getView().theme !== view.theme) throw new DOMException('Preview superseded', 'AbortError');
        };
        const check = () => {
            job.signal.throwIfAborted();
            if (generation !== seq) throw new DOMException('Preview superseded', 'AbortError');
            valid();
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
                const overlayRequest = { sheetId: sheet, theme: view.theme, sensitiveNodes: new Set(ids) };
                // A few nodes are built synchronously, so the hand-off follows the pointer-down with no worker round trip: the first
                // frame's prepare finds the overlay built. A larger overlay keeps the async build (it yields between its items).
                // Ink and media are not built synchronously: one stroke of thousands of points would hold the input task for frames.
                const syncable = ids.length <= SYNC_OVERLAY_NODES && ids.every(id => {
                    const kind = nodes.get(id)?.kind;
                    return kind !== 'stroke' && kind !== 'picture' && kind !== 'clip';
                });
                const source = syncable ? binding.prepareOverlayNow(doc, overlayRequest, ids, job.signal)
                    : await binding.prepareOverlay(doc, overlayRequest, ids, job.signal);
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
                    isCurrent: () => { try { valid(); return source.isCurrent(); } catch { return false; } } };
                requestedIds = candidates; requestedGeneration = seq;
                overlayNodes.clear(); for (const id of candidates) overlayNodes.add(id);
                overlay.frames.request({ source: guarded, release: releaseLeases }); handedOff = true;
                // Ready means this generation's source is handed to its layer. Drawing it is the platform's
                // later step, and the commit must not wait on a compositor cycle that a gesture may not trigger.
                if (controller === job) controllerHandedOff = true;
                handedOffGeneration = seq; settle();
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
    // The uniform offset of a plain x/y translation of existing nodes, or null for anything else (a rotate, a resize, an
    // opacity change, a node that is missing, or nodes that do not move together).
    function translationOf(ops: readonly Op[]): Shift | null {
        if (!ops.length) return null;
        const doc = runtime.session.doc;
        const moved = new Map<NodeId, Shift>();
        for (const op of ops) {
            if (op.t !== 'set' || (op.key !== 'x' && op.key !== 'y') || typeof op.value !== 'number') return null;
            const node = doc.nodes.get(op.id); if (!node) return null;
            const delta = moved.get(op.id) ?? { x: 0, y: 0 };
            if (op.key === 'x') delta.x = op.value - node.x; else delta.y = op.value - node.y;
            moved.set(op.id, delta);
        }
        let shift: Shift | null = null;
        for (const delta of moved.values()) {
            if (!shift) { shift = delta; continue; }
            if (Math.abs(delta.x - shift.x) > 1e-6 || Math.abs(delta.y - shift.y) > 1e-6) return null;
        }
        return shift;
    }
    // A translation is drawn from the committed picture only when no overlay of it depends on where it lands: no node is a
    // connector and nothing attaches to the moved nodes or their children (their routes would not move as a whole).
    function translatable(ops: readonly Op[]): boolean {
        const doc = runtime.session.doc;
        const stack = ops.map(op => op.t === 'set' ? op.id : null).filter((id): id is NodeId => id !== null), seen = new Set<NodeId>();
        while (stack.length) {
            const id = stack.pop()!;
            if (seen.has(id)) continue;
            seen.add(id);
            const node = doc.nodes.get(id);
            if (!node || node.kind === 'connector' || (doc.attachedTo.get(id)?.size ?? 0) > 0) return false;
            if (node.kind === 'group' || node.kind === 'frame') for (const child of doc.children.get(id) ?? []) stack.push(child.id);
        }
        return true;
    }
    // The moved nodes of a translation's ops. Compared by membership, not by a sorted string key built on every move (by
    // reading: a large selection sorted and joined all its ids at every pointer event).
    function movedIds(ops: readonly Op[]): Set<NodeId> {
        const ids = new Set<NodeId>();
        for (const op of ops) if (op.t === 'set') ids.add(op.id);
        return ids;
    }
    function sameMovedIds(ops: readonly Op[], ids: ReadonlySet<NodeId>): boolean {
        const seen = new Set<NodeId>();
        for (const op of ops) {
            if (op.t !== 'set') return false;
            if (!ids.has(op.id)) return false;
            seen.add(op.id);
        }
        return seen.size === ids.size;
    }
    // A live move of the translation in hand moves the built picture; the first move of a translation builds it at rest.
    function moveTranslation(ops: readonly Op[], shift: Shift): void {
        if (translation && sameMovedIds(ops, translation.ids)) {
            translation.meta.offset = shift; translation.ops = ops;
        } else {
            const doc = runtime.session.doc;
            const changes = new Map<NodeId, Node>();
            for (const op of ops) if (op.t === 'set' && !changes.has(op.id)) changes.set(op.id, copyNode(doc.nodes.get(op.id)!));
            const meta: TranslationMeta = { baked: { x: 0, y: 0 }, offset: shift };
            translation = { ids: movedIds(ops), meta, ops };
            start(changes, undefined, undefined, meta);
        }
        offsetVersion++;
        pair?.invalidate('preview-offset');
    }
    // A dense frame cannot be drawn at an offset: the translation's picture is built again at its place instead.
    function rebuildTranslation(): void {
        if (disposed || !translation) return;
        const current = translation; translation = null;
        try {
            const projected = operationNodes(runtime.session.doc, current.ops);
            start(projected.changes, undefined, projected.paper, { baked: current.meta.offset, offset: current.meta.offset });
        } catch (error) { clear(); report(error); }
    }
    return {
        show(nodes) {
            try {
                const changes = new Map<NodeId, Node>();
                for (const node of nodes) { if (changes.has(node.id)) throw new Error('Duplicate preview node'); changes.set(node.id, copyNode(node)); }
                start(changes);
            } catch (error) { clear(); report(error); }
        },
        showOps(ops, live = false) {
            try {
                const shift = translationOf(ops);
                // A later move of the translation in hand needs no re-check: its nodes and their attachments did not change.
                if (shift && live && ((translation && sameMovedIds(ops, translation.ids)) || translatable(ops))) { moveTranslation(ops, shift); return; }
                // Anything else is built for its ops; a translation's commit is built at its moved place, shown unshifted.
                translation = null;
                const projected = operationNodes(runtime.session.doc, ops);
                start(projected.changes, undefined, projected.paper, shift ? { baked: shift, offset: shift } : null);
            } catch (error) { clear(); report(error); }
        },
        waitUntilReady(signal) {
            if (disposed || signal.aborted || ((!pin || !controller) && !deferred && !queued)) return Promise.reject(interrupted());
            if (handedOffGeneration === generation && frames && !queued) return Promise.resolve();
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
