import type { Rect, ViewState } from '../types';
import { isEmbedContainmentApproved } from '../embedContainment';
import { RENDER_CONSTANTS } from './constants';
import { auditCount, renderAuditEnabled } from './renderAudit';
import type { EmbedContainment } from '../embedContainment.types';
import type { ByteLease } from './gfx/api';
import type { FrameBudget, FrameToken, Layer } from './types';
import { createEmbedClipJob, type EmbedClipDom } from './embedClipDom';
import type { EmbedClippedCoverage, EmbedCoveragePath, EmbedDrawnPaint, EmbedHostingLease, EmbedHostingSnapshot, EmbedPresentationFrame,
    EmbedPresentationOptions, EmbedPresentationPort, EmbedPresentedNode } from './embedPresentation.types';
import type { LayerHost } from './compositor.types';

const SLOT_BYTES = 65_536;
const CLIP_NEVER_FITS_BYTES = RENDER_CONSTANTS.memoryCeilings.low.cpuRasterBytes;
class InlineIds implements ReadonlySet<string> {
    readonly #values: Set<string>;
    readonly [Symbol.toStringTag] = 'InlineIds';
    constructor(values: Iterable<string> = []) { this.#values = new Set(values); Object.freeze(this); }
    get size(): number { return this.#values.size; }
    has(value: string): boolean { return this.#values.has(value); }
    entries(): SetIterator<[string, string]> { return this.#values.entries(); }
    keys(): SetIterator<string> { return this.#values.keys(); }
    values(): SetIterator<string> { return this.#values.values(); }
    [Symbol.iterator](): SetIterator<string> { return this.#values[Symbol.iterator](); }
    forEach(callback: (value: string, key: string, set: ReadonlySet<string>) => void, thisArg?: unknown): void {
        for (const value of this.#values) callback.call(thisArg, value, value, this);
    }
}
const EMPTY_INLINE: ReadonlySet<string> = new InlineIds();
function sameToken(a: FrameToken, b: FrameToken): boolean {
    return a.vaultEpoch === b.vaultEpoch && a.documentId === b.documentId && a.bytesGeneration === b.bytesGeneration &&
        a.session === b.session && a.viewLease === b.viewLease && a.deviceGeneration === b.deviceGeneration;
}
function sameDocument(a: FrameToken, b: FrameToken): boolean {
    return a.vaultEpoch === b.vaultEpoch && a.documentId === b.documentId && a.bytesGeneration === b.bytesGeneration && a.session === b.session;
}
function sameRectOrNull(a: Rect | null, b: Rect | null): boolean {
    if (a === null || b === null) return a === b;
    return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
type DrawnView = { epoch: number; x: number; y: number; z: number; width: number; height: number; dpr: number };
function drawnViewOf(view: ViewState): DrawnView {
    return { epoch: view.epoch, x: view.camera.x, y: view.camera.y, z: view.camera.z, width: view.viewport.width, height: view.viewport.height, dpr: view.viewport.dpr };
}
function sameDrawnView(view: ViewState, drawn: DrawnView | null, shown: boolean): boolean {
    return !!drawn && (!shown || view.epoch === drawn.epoch) && view.camera.x === drawn.x && view.camera.y === drawn.y && view.camera.z === drawn.z &&
        view.viewport.width === drawn.width && view.viewport.height === drawn.height && view.viewport.dpr === drawn.dpr;
}
function sameNumbers(a: readonly number[], b: readonly number[]): boolean {
    return a === b || a.length === b.length && a.every((value, i) => value === b[i]);
}
function samePath(a: EmbedCoveragePath, b: EmbedCoveragePath): boolean {
    return a === b || a.d === b.d && a.fillRule === b.fillRule && sameNumbers(a.toPane, b.toPane);
}
function samePaths(a: readonly EmbedCoveragePath[], b: readonly EmbedCoveragePath[]): boolean {
    return a === b || a.length === b.length && a.every((path, i) => samePath(path, b[i]));
}
function sameCoverage(a: EmbedClippedCoverage, b: EmbedClippedCoverage): boolean {
    const x = a.stroke, y = b.stroke;
    return (a.fill !== false) === (b.fill !== false) && samePath(a.path, b.path) && samePaths(a.clips, b.clips)
        && (x === y || !!x && !!y && x.width === y.width && x.cap === y.cap && x.join === y.join
            && x.miterLimit === y.miterLimit && (x.dashPhase ?? 0) === (y.dashPhase ?? 0)
            && sameNumbers(x.dash ?? [], y.dash ?? []));
}
function sameGeometry(a: EmbedPresentedNode, b: EmbedPresentedNode): boolean {
    const x = a.rect, y = b.rect;
    if (a.source !== b.source || x.x !== y.x || x.y !== y.y || x.width !== y.width || x.height !== y.height ||
        !sameNumbers(a.toPane, b.toPane) || !samePaths(a.clips, b.clips)) return false;
    if (a.laterPaint === b.laterPaint) return true;
    return a.laterPaint.length === b.laterPaint.length && a.laterPaint.every((item, i) => {
        const other = b.laterPaint[i];
        if (item.opacity !== other.opacity) return false;
        if (item.opacity !== 'opaque' || other.opacity !== 'opaque') return true;
        return sameCoverage(item.coverage, other.coverage);
    });
}
function* estimates(node: EmbedPresentedNode): Generator<number> {
    const path = (value: EmbedCoveragePath) => 4096 + value.d.length * 640;
    for (const clip of node.clips) yield path(clip);
    yield 8192;
    for (const later of node.laterPaint) {
        if (later.opacity !== 'opaque') continue;
        yield path(later.coverage.path) * 2 + (later.coverage.stroke?.dash?.length ?? 0) * 640;
        for (const clip of later.coverage.clips) yield path(clip) * 2;
    }
}
type Request = { id: string; signal?: AbortSignal; waitingForFacts: boolean; abort: () => void; resolve(value: EmbedHostingLease): void; reject(error: unknown): void };
type Slot = {
    id: string; source: string; root: HTMLDivElement; plane: HTMLDivElement; container: HTMLDivElement; chrome: HTMLDivElement;
    controller: AbortController; containment: EmbedContainment | null; base: ByteLease; allocator: LayerHost['allocator']['cpu'];
    node: EmbedPresentedNode | null; snapshot: EmbedHostingSnapshot; listeners: Set<() => void>; interaction: Rect | null;
    estimate: Generator<number> | null; estimated: number; job: Generator<void, EmbedClipDom> | null; clips: EmbedClipDom | null;
    clipLease: ByteLease | null; blocked: boolean; closed: boolean; estimateDone: boolean; unfit: boolean; lease: EmbedHostingLease;
    externalSignal?: AbortSignal; externalAbort?: () => void;
};

export function createEmbedPresentationPort(options: EmbedPresentationOptions): EmbedPresentationPort {
    let host: LayerHost | null = null, layer: Layer | null = null, packet: EmbedPresentationFrame | null = null;
    let visible = true, disposed = false, requestBlocked = false, revision = 0;
    let prepared: { token: FrameToken; epoch: number; cameraEpoch: number; frameId: number } | null = null;
    let witness: EmbedDrawnPaint | null = null;
    let mutations = 0, drawnAt = -1;
    let drawnView: DrawnView | null = null;
    const touch = () => { mutations++; };
    let inlineRevision: number | null = null, inlineCache: ReadonlySet<string> = EMPTY_INLINE;
    const slots = new Map<string, Slot>(), requests = new Set<Request>(), retiring = new Set<Promise<void>>();
    const report = (error: unknown) => { try { options.onError?.(error); } catch { /* reporting cannot break teardown */ } };
    const wake = () => host?.invalidate('embed-presentation');
    let memoryWaiting = false, memoryWaitBytes = 0;
    const awaitMemory = (bytes: number): void => {
        if (memoryWaiting || !host?.allocator.cpu.whenAvailable) return;
        memoryWaiting = true; memoryWaitBytes = bytes;
        host.allocator.cpu.whenAvailable(() => { memoryWaiting = false; wake(); }, bytes);
    };
    const parkedFor = (bytes: number): boolean => memoryWaiting && bytes >= memoryWaitBytes;
    const requestsChanged = () => {
        touch(); wake();
        try { options.invalidate?.(); } catch (error) { report(error); }
    };
    const releasePacket = (value: EmbedPresentationFrame | null) => {
        if (!value) return;
        let promise: Promise<void>;
        try { promise = Promise.resolve(value.release()); } catch (error) { report(error); return; }
        retiring.add(promise); void promise.catch(report).finally(() => retiring.delete(promise));
    };
    const notify = (slot: Slot, mode: EmbedHostingSnapshot['mode'], shown: boolean) => {
        if (slot.snapshot.mode === mode && slot.snapshot.visible === shown && slot.snapshot.node === slot.node && slot.snapshot.presentation === (packet?.presentation ?? null)) return;
        slot.snapshot = Object.freeze({ mode, visible: shown, node: slot.node, presentation: packet?.presentation ?? null });
        for (const callback of slot.listeners) { try { callback(); } catch (error) { report(error); } }
    };
    const clearClip = (slot: Slot) => {
        touch();
        slot.job?.return(undefined as never); slot.job = null; slot.estimate?.return(undefined as never); slot.estimate = null;
        slot.clips?.dispose(); slot.clips = null;
        if (slot.clipLease) { slot.allocator.release(slot.clipLease); slot.clipLease = null; }
        slot.estimated = 0; slot.blocked = false; slot.estimateDone = false; slot.unfit = false;
    };
    const hide = (slot: Slot) => {
        if (slot.root.style.visibility !== 'hidden') touch();
        slot.root.style.visibility = 'hidden'; notify(slot, slot.closed ? 'closed' : 'pending', false);
    };
    const close = (slot: Slot) => {
        if (slot.closed) return;
        touch();
        slot.closed = true; slot.externalSignal?.removeEventListener('abort', slot.externalAbort!); slot.controller.abort();
        try { slot.containment?.dispose(); } catch (error) { report(error); }
        slot.containment = null; clearClip(slot); slot.node = null; hide(slot); slot.root.remove();
        slot.allocator.release(slot.base); slots.delete(slot.id); slot.listeners.clear();
    };
    const validFrame = (view: ViewState, token: FrameToken): boolean => !!packet && visible && !disposed &&
        sameToken(packet.presentation.token, token) && (packet.presentation.viewEpoch === view.epoch ||
            packet.camera.x === view.camera.x && packet.camera.y === view.camera.y && packet.camera.z === view.camera.z) &&
        packet.viewport.width === view.viewport.width && packet.viewport.height === view.viewport.height;
    const createSlot = (request: Request, node: EmbedPresentedNode, base: ByteLease): Slot => {
        const root = document.createElement('div'), plane = document.createElement('div'), container = document.createElement('div'), chrome = document.createElement('div');
        for (const element of [root, plane]) { element.style.position = 'absolute'; element.style.inset = '0'; element.style.pointerEvents = 'none'; }
        root.style.visibility = 'hidden'; container.style.position = 'absolute'; container.style.transformOrigin = '0 0'; container.style.pointerEvents = 'auto';
        chrome.style.position = 'absolute'; chrome.style.inset = '0'; chrome.style.pointerEvents = 'none';
        plane.append(container); root.append(plane, chrome); options.overlay.append(root);
        const controller = new AbortController();
        const slot = { id: node.nodeId, source: node.source, root, plane, container, chrome, controller, containment: null,
            base, allocator: host!.allocator.cpu, node, snapshot: Object.freeze({ mode: 'pending', visible: false, node, presentation: packet?.presentation ?? null }),
            listeners: new Set<() => void>(), interaction: null, estimate: null, estimated: 0, job: null, clips: null, clipLease: null,
            blocked: false, closed: false, estimateDone: false, unfit: false, lease: null } as unknown as Slot;
        slot.lease = {
            nodeId: slot.id, container, chrome, signal: controller.signal,
            bind(value) {
                if (slot.closed || !isEmbedContainmentApproved(value) || value.element.parentElement !== container || !container.isConnected) throw new Error('Invalid embed containment binding');
                if (slot.containment && slot.containment !== value) throw new Error('Embed containment already bound');
                value.element.style.display = 'block'; value.element.style.width = '100%';
                value.element.style.height = '100%'; value.element.style.border = '0';
                slot.containment = value; slot.estimate = estimates(slot.node!); touch(); wake();
            },
            getSnapshot: () => slot.snapshot,
            subscribe(callback) { slot.listeners.add(callback); return () => { slot.listeners.delete(callback); }; },
            setInteractionRect(rect) {
                if (slot.closed) return;
                if (rect && (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0)) throw new RangeError('Invalid interaction rectangle');
                if (sameRectOrNull(slot.interaction, rect)) return;
                slot.interaction = rect ? { ...rect } : null; touch(); hide(slot); wake();
            },
            async dispose() { close(slot); },
        };
        touch(); slots.set(slot.id, slot); requests.delete(request); request.signal?.removeEventListener('abort', request.abort);
        if (request.signal) {
            slot.externalSignal = request.signal; slot.externalAbort = () => close(slot);
            request.signal.addEventListener('abort', slot.externalAbort, { once: true });
            if (request.signal.aborted) { close(slot); request.reject(request.signal.reason); return slot; }
        }
        request.resolve(slot.lease);
        return slot;
    };
    const prepare = (view: ViewState, budget: FrameBudget): boolean => {
        prepared = null;
        let whole = true;
        const yielded = (): boolean => { if (budget.shouldYield()) { whole = false; return true; } return false; };
        const answer = (): boolean => !(whole && mutations === drawnAt && sameDrawnView(view, drawnView, slots.size > 0));
        if (!host || !validFrame(view, budget.token)) {
            if ((slots.size || requests.size) && renderAuditEnabled()) auditCount('embed', 'prepare-invalid:' + (!host ? 'host' : !packet ? 'no-packet' : !visible ? 'hidden' : !sameToken(packet.presentation.token, budget.token) ? 'token'
                : packet.presentation.viewEpoch !== view.epoch ? 'view-epoch' : 'viewport'));
            for (const slot of slots.values()) hide(slot);
            for (const request of requests) request.waitingForFacts = true;
            return answer();
        }
        prepared = { token: { ...budget.token }, epoch: view.epoch, cameraEpoch: budget.cameraEpoch, frameId: budget.frameId }; requestBlocked = false;
        for (const request of requests) {
            if (yielded()) break;
            const node = packet!.nodes.find(item => item.nodeId === request.id);
            if (!node || !options.overlay.isConnected) { request.waitingForFacts = true; continue; }
            request.waitingForFacts = false;
            if (parkedFor(SLOT_BYTES)) { requestBlocked = true; break; }
            const base = host.allocator.cpu.reserve(SLOT_BYTES);
            if (!base) { requestBlocked = true; awaitMemory(SLOT_BYTES); break; }
            try { createSlot(request, node, base); } catch (error) { host.allocator.cpu.release(base); touch(); requests.delete(request); request.signal?.removeEventListener('abort', request.abort); requestsChanged(); request.reject(error); }
        }
        for (const slot of slots.values()) {
            if (yielded()) break;
            if (!slot.containment || !slot.node || slot.closed) continue;
            if (!isEmbedContainmentApproved(slot.containment)) { close(slot); continue; }
            slot.blocked = false;
            try {
                if (!slot.clips && !slot.job) {
                    if (!slot.estimateDone) {
                        slot.estimate ??= estimates(slot.node);
                        while (!yielded()) {
                            const next = slot.estimate.next();
                            touch();
                            if (next.done) { slot.estimate = null; slot.estimateDone = true; break; }
                            slot.estimated += next.value;
                            if (!Number.isSafeInteger(slot.estimated)) throw new RangeError('Embed clip estimate overflow');
                        }
                        continue;
                    }
                    const need = Math.max(1, slot.estimated);
                    if (need > CLIP_NEVER_FITS_BYTES) {
                        slot.blocked = true;
                        if (!slot.unfit) { slot.unfit = true; auditCount('embed', 'fallback:embed:clip-never-fits', 1, { bytes: need }); }
                        continue;
                    }
                    slot.unfit = false;
                    if (parkedFor(need)) { slot.blocked = true; continue; }
                    const lease = slot.allocator.reserve(need);
                    if (!lease) { slot.blocked = true; awaitMemory(need); continue; }
                    touch(); slot.clipLease = lease; slot.job = createEmbedClipJob(slot.node, packet!.viewport);
                }
                if (slot.job) {
                    while (!yielded()) {
                        touch();
                        const step = slot.job.next();
                        if (step.done) {
                            slot.job = null; slot.clips = step.value; slot.root.prepend(step.value.definitions); slot.root.append(step.value.shield);
                            requestsChanged();
                            break;
                        }
                    }
                }
            } catch (error) { clearClip(slot); slot.blocked = true; report(error); }
        }
        return answer();
    };
    const paintOverlay = (view: ViewState) => {
        const stale = !prepared ? 'unprepared' : !validFrame(view, prepared.token) ? 'invalid-frame' : prepared.epoch !== view.epoch ? 'view-epoch'
            : !witness ? 'no-witness' : !sameToken(witness.token, prepared.token) ? 'witness-token' : witness.frameId !== prepared.frameId ? 'witness-frame'
            : witness.cameraEpoch !== prepared.cameraEpoch ? 'witness-camera' : witness.sceneRevision !== packet!.sceneRevision ? 'witness-revision' : null;
        if (stale || !witness) { if (slots.size && renderAuditEnabled()) auditCount('embed', 'overlay-hidden:' + (stale ?? 'no-witness')); for (const slot of slots.values()) hide(slot); return; }
        for (const slot of slots.values()) {
            const node = slot.node, cap = slot.containment;
            if (!node || !cap || !isEmbedContainmentApproved(cap) || !slot.clips) { if (renderAuditEnabled()) auditCount('embed', 'slot-hidden:' + (!node ? 'no-node' : !cap ? 'no-containment' : !slot.clips ? 'no-clips' : 'unapproved')); hide(slot); continue; }
            if (node.laterPaint.some(item => item.opacity === 'unknown')) { if (renderAuditEnabled()) auditCount('embed', 'slot-hidden:unknown-later'); hide(slot); continue; }
            const interaction = node.laterPaint.some(item => item.opacity === 'translucent');
            const omitted = witness.omittedNodeIds?.has(slot.id) ?? false;
            const shown = interaction ? node.poster === 'painted' && !omitted && !!slot.interaction : node.poster === 'omitted' && omitted;
            if (!shown) { if (renderAuditEnabled()) auditCount('embed', 'slot-hidden:' + (interaction ? 'interaction' : node.poster !== 'omitted' ? 'poster-' + node.poster : 'not-omitted')); hide(slot); continue; }
            slot.root.style.zIndex = String(node.order);
            slot.plane.style.clipPath = interaction ? '' : slot.clips.clipUrl ?? '';
            slot.plane.style.mask = interaction ? '' : slot.clips.maskUrl;
            slot.clips.shield.style.display = interaction ? 'none' : '';
            slot.chrome.style.display = interaction ? '' : 'none';
            if (interaction) {
                const rect = slot.interaction!;
                slot.container.style.width = `${rect.width}px`; slot.container.style.height = `${rect.height}px`;
                slot.container.style.transform = `translate(${rect.x}px, ${rect.y}px)`; slot.container.style.opacity = '1';
            } else {
                const [a, b, c, d, e, f] = node.toPane, r = node.rect;
                slot.container.style.width = `${r.width}px`; slot.container.style.height = `${r.height}px`;
                slot.container.style.transform = `matrix(${a},${b},${c},${d},${e + a * r.x + c * r.y},${f + b * r.x + d * r.y})`;
                slot.container.style.opacity = String(node.opacity);
            }
            slot.root.style.visibility = 'visible'; notify(slot, interaction ? 'interaction' : 'inline', true);
        }
    };
    const draw = (view: ViewState) => { paintOverlay(view); drawnAt = mutations; drawnView = drawnViewOf(view); };
    const definition: EmbedPresentationPort['layer'] = {
        id: 'embed-presentation', group: 'chrome',
        create(value) {
            if (host || disposed) throw new Error('Embed presentation already attached');
            host = value;
            layer = { prepare, drawGpu: (_pass, view) => draw(view), draw2d: (_ctx, view) => draw(view),
                releaseGpu(reason) { prepared = null; touch(); if (reason === 'hidden') for (const slot of [...slots.values()]) close(slot); else for (const slot of slots.values()) hide(slot); },
                memory() { let cpuBytes = 0; for (const slot of slots.values()) cpuBytes += slot.base.bytes + (slot.clipLease?.bytes ?? 0); return { gpuBytes: 0, cpuBytes }; },
                needsFrame() {
                    if (disposed || !visible) return false;
                    if (!requestBlocked && prepared) for (const request of requests) if (!request.waitingForFacts) return true;
                    for (const slot of slots.values()) if (slot.containment && !slot.blocked && !slot.clips) return true;
                    return false;
                },
                dispose() { for (const slot of [...slots.values()]) close(slot); host = null; layer = null; },
            };
            return layer;
        },
        revision: () => revision,
        cpuWorkingSet: () => {
            let mandatoryBytes = requests.size * SLOT_BYTES;
            for (const slot of slots.values()) mandatoryBytes += slot.base.bytes + (slot.clipLease?.bytes ?? (slot.containment ? Math.max(1, slot.estimated) : 0));
            return { mandatoryBytes, prefetchBytes: 0 };
        },
        critical: () => false,
        coverage: () => ({ complete: true, sharp: true }),
    };
    return {
        layer: definition,
        present(frame) {
            if (disposed || !visible) { releasePacket(frame); return; }
            if (packet === frame) return;
            const old = packet; packet = frame;
            let changed = false;
            for (const request of requests) {
                if (request.waitingForFacts && frame.nodes.some(item => item.nodeId === request.id)) changed = true;
                request.waitingForFacts = false;
            }
            for (const slot of [...slots.values()]) {
                const node = frame.nodes.find(item => item.nodeId === slot.id);
                if (!node || node.source !== slot.source || (old && !sameDocument(old.presentation.token, frame.presentation.token))) { close(slot); changed = true; continue; }
                const equivalent = !!slot.node && sameGeometry(slot.node, node) && old?.viewport.width === frame.viewport.width && old.viewport.height === frame.viewport.height;
                const preserve = equivalent && !!slot.clips;
                const oldPoster = slot.node?.poster, oldOrder = slot.node?.order, oldOpacity = slot.node?.opacity;
                if (!preserve) clearClip(slot);
                slot.node = node;
                if (!preserve || !old || !sameToken(old.presentation.token, frame.presentation.token) || oldOrder !== node.order || oldOpacity !== node.opacity ||
                    old.presentation.viewEpoch !== frame.presentation.viewEpoch || old.sceneRevision !== frame.sceneRevision || oldPoster !== node.poster) {
                    hide(slot); changed = true;
                } else notify(slot, slot.snapshot.mode, slot.snapshot.visible);
                if (!preserve && slot.containment) slot.estimate = estimates(node);
            }
            releasePacket(old);
            revision++;
            if (!changed) return;
            touch();
            prepared = null;
            wake();
        },
        drawn(paint) {
            for (const slot of slots.values()) {
                if ((witness?.omittedNodeIds?.has(slot.id) ?? false) !== (paint.omittedNodeIds?.has(slot.id) ?? false)) { touch(); break; }
            }
            witness = paint;
        },
        acquire(id, signal) {
            if (disposed || !visible) return Promise.reject(new Error('Embed presentation unavailable'));
            if (signal?.aborted) return Promise.reject(signal.reason);
            if (slots.has(id) || [...requests].some(item => item.id === id)) return Promise.reject(new Error('Embed already acquired'));
            return new Promise((resolve, reject) => {
                const request: Request = { id, signal, waitingForFacts: false, resolve, reject, abort: () => { requests.delete(request); requestsChanged(); reject(signal?.reason ?? new DOMException('Embed cancelled', 'AbortError')); } };
                requests.add(request); signal?.addEventListener('abort', request.abort, { once: true }); requestsChanged();
            });
        },
        requestedNodeIds() {
            if (disposed || (slots.size === 0 && requests.size === 0)) return EMPTY_INLINE;
            const ids = new Set<string>(slots.keys());
            for (const request of requests) ids.add(request.id);
            return ids.size ? new InlineIds(ids) : EMPTY_INLINE;
        },
        inlineNodeIds(sceneRevision) {
            if (!packet || (sceneRevision !== undefined && packet.sceneRevision !== sceneRevision)) return EMPTY_INLINE;
            const eligible = (slot: Slot) => !!slot.node && !!slot.clips && !!slot.containment && isEmbedContainmentApproved(slot.containment) &&
                !slot.node.laterPaint.some(item => item.opacity === 'translucent' || item.opacity === 'unknown');
            let count = 0, unchanged = inlineRevision === packet.sceneRevision;
            for (const slot of slots.values()) if (eligible(slot)) { count++; if (!inlineCache.has(slot.id)) unchanged = false; }
            if (unchanged && count === inlineCache.size) return inlineCache;
            inlineRevision = packet.sceneRevision;
            if (!count) return inlineCache = EMPTY_INLINE;
            const ids: string[] = [];
            for (const slot of slots.values()) if (eligible(slot)) ids.push(slot.id);
            return inlineCache = new InlineIds(ids);
        },
        setVisible(value) {
            if (disposed || visible === value) return;
            visible = value; prepared = null; witness = null; touch();
            if (!value) {
                for (const slot of [...slots.values()]) close(slot);
                for (const request of requests) { request.signal?.removeEventListener('abort', request.abort); request.reject(new Error('Embed hidden')); }
                requests.clear(); releasePacket(packet); packet = null;
            }
            revision++; wake();
        },
        async dispose() {
            if (!disposed) {
                disposed = true; prepared = null; witness = null;
                for (const slot of [...slots.values()]) close(slot);
                for (const request of requests) { request.signal?.removeEventListener('abort', request.abort); request.reject(new Error('Embed presentation disposed')); }
                requests.clear(); releasePacket(packet); packet = null;
            }
            await Promise.all([...retiring]);
        },
    };
}
