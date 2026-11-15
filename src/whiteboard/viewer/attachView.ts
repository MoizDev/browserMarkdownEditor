import type { Rect, ViewState } from '../../platform/types';
import type { RenderToken } from '../../platform/render/types';
import { getBoardRuntime } from '../host/runtime';
import { createNotebookPaperLayer, type NotebookPaperSnapshot } from '../host/notebookPaperLayer';
import type { NodeId } from '../model/ids';
import type { PaintFrame } from '../render/paintStream';
import type { PlatformLayerDefinition } from '../../platform/render/attachPlatformPane.types';
import type { EmbedPresentationPort } from '../../platform/render/embedPresentation.types';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import { createNativeEmbedPresentationProducer, type NativeEmbedPresentationProducer } from '../host/embedPresentationFacts';
import { boardPageStack } from '../model/pages';
import { createBoardLayers, BOARD_BACKEND_PREFERENCE } from '../render/boardLayers';
import type { DensityMode } from '../render/density';
import { createPaintFrameAssembler } from '../render/frameAssembler';
import { LiveNodeUnion } from '../render/nodeSets';
import { DEFAULT_BOARD_PALETTES } from '../render/palette';
import { BoundsQuality } from '../scene/bounds';
import type { SceneSpatial } from '../scene/types';
import { createViewerAccessibility } from './accessibility';
import type { AttachView, ViewerInteractionPorts, ViewerPaintPresentation, ViewerSnapshot, ViewerViewParams } from './types';

class SelectionIds implements ReadonlySet<string> {
    readonly [Symbol.toStringTag] = 'SelectionIds';
    constructor(private readonly ids: readonly NodeId[], private readonly current: () => readonly NodeId[],
        private readonly selected: (id: NodeId) => boolean) {}
    get size(): number { return this.ids.length; }
    has(id: string): boolean { return this.current() === this.ids ? this.selected(id as NodeId) : this.ids.includes(id as NodeId); }
    *values(): SetIterator<string> { yield* this.ids; }
    keys(): SetIterator<string> { return this.values(); }
    *entries(): SetIterator<[string, string]> { for (const id of this.ids) yield [id, id]; }
    [Symbol.iterator](): SetIterator<string> { return this.values(); }
    forEach(fn: (value: string, key: string, set: ReadonlySet<string>) => void, thisArg?: unknown): void {
        for (const id of this.ids) fn.call(thisArg, id, id, this);
    }
}

/** Attaches view resources only. The admitted model, scene, selection/history and
 * journal belong to the exact App-owned runtime and survive this view's disposal. */
export const attachView: AttachView = options => {
    options.signal?.throwIfAborted();
    const acquiredRuntime = getBoardRuntime(options.session);
    if (!acquiredRuntime || acquiredRuntime.session !== options.session) throw new Error('AttachView requires the App-owned board runtime');
    const runtime = acquiredRuntime;
    let view: ViewerViewParams = { ...options.view }, disposed = false, failed: Error | null = null;
    let paintJob: AbortController | null = null, revealJob: AbortController | null = null, request = 0;
    let lastView: ViewState | null = null, drawnFrame: { sceneRevision: number; token: RenderToken; frame: PaintFrame; context?: ViewerPaintPresentation } | null = null;
    let interaction: ViewerInteractionPorts | null = null, embedPort: EmbedPresentationPort | null = null;
    let embedProducer: NativeEmbedPresentationProducer | null = null;
    let lastSensitive: ReadonlySet<string> | undefined;
    // Density mode and the index's candidate count drive which frame kind is requested; both are read
    // by the layers, which never own a frame request of their own.
    let densityMode: DensityMode = 'direct', lastCandidates: number | null = null;
    const unions = new WeakMap<ReadonlySet<string>, WeakMap<ReadonlySet<string>, ReadonlySet<string>>>();
    const union = (a: ReadonlySet<string> | null | undefined, b: ReadonlySet<string> | null | undefined): ReadonlySet<string> | null => {
        if (!a) return b ?? null;
        if (!b || a === b) return a;
        let pairs = unions.get(a); if (!pairs) { pairs = new WeakMap(); unions.set(a, pairs); }
        let result = pairs.get(b); if (!result) { result = new LiveNodeUnion(a, b); pairs.set(b, result); }
        return result;
    };
    let interactionLayers: Readonly<{ underlay: PlatformLayerDefinition; content: PlatformLayerDefinition }> | null = null;
    let previewLayers: Readonly<{ underlay: PlatformLayerDefinition; content: PlatformLayerDefinition }> | null = null;
    let previewCoverage: (() => Readonly<{ frame: PaintFrame; nodeIds: ReadonlySet<string> }> | null) | null = null;
    let clearPreview: (() => void) | null = null;
    const listeners = new Set<() => void>();
    const palettes = options.palette ?? DEFAULT_BOARD_PALETTES;
    const sheet = () => view.sheetId ?? runtime.selection.getSnapshot().sheet;
    let paperSnapshot: NotebookPaperSnapshot | null = null;
    const paper = options.session.doc.host.kind === 'notebook' ? createNotebookPaperLayer({
        read() {
            const doc = options.session.doc, host = doc.host;
            if (host.kind !== 'notebook') throw new Error('Notebook host changed');
            if (paperSnapshot?.revision === doc.rev) return paperSnapshot;
            const stack = boardPageStack(host);
            if (!stack) throw new Error('Notebook page layout unavailable');
            const pages = stack.rects.map((rect, index) => Object.freeze({ index, width: rect.width, height: rect.height,
                rotate: 0 as const, userUnit: 1, toUserSpace: [1, 0, 0, 1, 0, 0] as const }));
            paperSnapshot = Object.freeze({ revision: doc.rev, host: Object.freeze({ ...host, paper: Object.freeze({ ...host.paper }) }), pages: Object.freeze(pages) });
            return paperSnapshot;
        }, palette: () => palettes.light, onError: error => report(error),
    }) : null;
    const report = (error: unknown) => {
        if (disposed || (error instanceof DOMException && error.name === 'AbortError')) return;
        failed = error instanceof Error ? error : new Error(String(error));
        options.onError(failed); publish();
    };
    const scene: SceneSpatial = {
        get revision() { return runtime.scene?.revision ?? options.session.doc.rev; },
        get layout() { return runtime.scene?.layout ?? boardPageStack(options.session.doc.host) ?? null; },
        worldBounds: id => runtime.scene?.worldBounds(id) ?? (options.session.doc.nodes.has(id)
            ? { revision: options.session.doc.rev, quality: BoundsQuality.Pending, ink: null, selectable: null } : null),
        ensureExactBounds: async (id, signal) => (await runtime.ready).ensureExactBounds(id, signal),
        query(...args) { if (!runtime.scene) throw new Error('Scene is still loading'); return runtime.scene.query(...args); },
        spatialCursor(...args) { if (!runtime.scene) throw new Error('Scene is still loading'); return runtime.scene.spatialCursor(...args); },
        pin() { if (!runtime.scene) throw new Error('Scene is still loading'); return runtime.scene.pin(); },
    };
    const images = options.images ?? { acquire: async () => { throw new Error('This board view has no admitted image provider'); } };
    const assembler = createPaintFrameAssembler(() => layers.invalidate('board-paint-ready'), report);
    const frames = options.liveFrames ? options.liveFrames.wrap(assembler) : assembler;
    const previewOmission = (dry: PaintFrame): ReadonlySet<string> | null => {
        if (!previewLayers || !view.visible || disposed) return null;
        const preview = previewCoverage?.();
        if (!preview || preview.frame.sceneRevision !== dry.sceneRevision || dry.sceneRevision !== options.session.doc.rev) return null;
        const a = preview.frame.token, b = dry.token;
        return a.vaultEpoch === b.vaultEpoch && a.documentId === b.documentId && a.bytesGeneration === b.bytesGeneration
            && a.session === b.session ? preview.nodeIds : null;
    };
    const omitPreview = (dry: PaintFrame) => union(previewOmission(dry), view.visible ? embedPort?.inlineNodeIds(dry.sceneRevision) : null);
    const selections = new WeakMap<readonly NodeId[], ReadonlySet<string>>();
    const selectionIds = (): ReadonlySet<string> => {
        const ids = runtime.selection.getSnapshot().selected;
        let result = selections.get(ids);
        if (!result) {
            result = new SelectionIds(ids, () => runtime.selection.getSnapshot().selected, id => runtime.selection.has(id));
            selections.set(ids, result);
        }
        return result;
    };
    const precisionNodeIds = (sensitive: ReadonlySet<string> | undefined) => union(
        selectionIds(), union(union(interaction?.liveNodeIds?.(), view.visible ? embedPort?.inlineNodeIds() : null), sensitive));
    const liveNodeIds = () => precisionNodeIds(interaction?.sensitiveNodeIds?.()) ?? undefined;
    const layers = createBoardLayers({ frames, images, onError: report, requestedRevision: () => options.session.doc.rev, omitNodes: omitPreview,
        liveNodeIds, candidates: () => lastCandidates,
        onDensityMode(mode) { if (densityMode !== mode && !disposed) { densityMode = mode; requestPaint(); } },
        requestFrame: () => { if (!disposed) requestPaint(); },
        onDrawn(revision, frame, context) {
            options.liveFrames?.drawn(frame);
            embedPort?.drawn({ token: context.token, frameId: context.frameId, cameraEpoch: context.view.epoch,
                sceneRevision: revision, omittedNodeIds: context.omittedNodeIds });
        },
        beforePrepare(current, budget) {
            runtime.flushFrame(budget.frameId);
            if (runtime.scene && !runtime.scene.ready) runtime.scene.step(8, budget.prepareDeadline);
            const sensitive = interaction?.sensitiveNodeIds?.();
            const changed = sensitive !== lastSensitive;
            if (!lastView || current.epoch !== lastView.epoch || changed) {
                lastView = { ...current, camera: { ...current.camera }, viewport: { ...current.viewport } };
                requestPaint(sensitive);
            }
        },
        onPresented(revision, token, frame, context) {
            drawnFrame = { sceneRevision: revision, token, frame, context };
            interaction?.presented?.(revision, token, frame, context);
            embedProducer?.presented(revision, token, frame, context);
        },
    });
    // The producer reserves and releases through the layer host's canonical CPU allocator, which exists only once a host has drawn.
    const embedMemory: MemoryAllocator = {
        reserve: bytes => layers.memory()?.reserve(bytes) ?? null,
        release: lease => layers.memory()?.release(lease),
    };
    const accessibility = createViewerAccessibility({ token: options.token, session: options.session, selection: runtime.selection, scene,
        visibleIds: () => options.session.doc.bySheet.get(sheet()) ?? [],
        label: node => {
            if (node.kind === 'frame') return node.name || 'Frame';
            if (node.kind === 'picture' || node.kind === 'clip') return node.alt || (node.kind === 'picture' ? 'Picture' : 'Video');
            if (node.kind === 'linkcard' || node.kind === 'embed') return node.url;
            const rich = node.kind === 'text' || node.kind === 'sticky' ? node.text : node.kind === 'figure' || node.kind === 'connector' ? node.label : null;
            if (!rich) return node.kind;
            let result = '';
            for (const block of rich.blocks) {
                if (result) result += '\n';
                for (const run of block.runs) { result += run.text.slice(0, 256 - result.length); if (result.length >= 256) return result; }
            }
            return result || node.kind;
        } });
    let snapshot: ViewerSnapshot;
    function makeSnapshot(): ViewerSnapshot {
        const palette = palettes[options.session.doc.kind === 'whiteboard' ? view.theme : 'light'];
        const nextLayers = [...view.backdrops ?? [], ...paper ? [paper] : [], layers[0],
            ...previewLayers ? [previewLayers.underlay] : [], ...interactionLayers ? [interactionLayers.underlay] : [],
            layers[1], ...previewLayers ? [previewLayers.content] : [], ...interactionLayers ? [interactionLayers.content] : [],
            ...embedPort ? [embedPort.layer] : []];
        // A new topology seals platform input. Rebuilding the same list on preview cancellation
        // sealed it again during React's layout effect, recursively cancelling until error #185.
        const definitions = snapshot?.layers.length === nextLayers.length && nextLayers.every((layer, i) => snapshot.layers[i] === layer)
            ? snapshot.layers : Object.freeze(nextLayers);
        return { state: failed ? 'failed' : !runtime.scene ? 'loading' : options.session.isReadOnly ? 'read-only' : 'ready',
            readOnlyReason: failed?.message ?? runtime.session.readOnlyReason, sceneRevision: runtime.scene?.revision ?? options.session.doc.rev,
            layout: scene.layout, palette, appearance: { background: palettes[view.theme].background, inverted: view.inverted },
            layers: definitions,
            backendPreference: BOARD_BACKEND_PREFERENCE };
    }
    function publish(): void {
        if (disposed) return;
        snapshot = makeSnapshot(); accessibility.invalidate();
        for (const listener of listeners) listener();
    }
    function requestPaint(sensitive = interaction?.sensitiveNodeIds?.()): void {
        if (disposed || !view.visible || !runtime.scene?.ready) return;
        paintJob?.abort();
        const controller = new AbortController(), sequence = ++request;
        paintJob = controller;
        const pin = runtime.scene.pin(), selectedSheet = sheet();
        const current = lastView;
        // The frame covers the viewport plus two of its sides: a progressive coarse tile may extend one tile
        // beyond the viewport, and every live item it meets must be in the frame to be drawn live.
        const world: Rect | undefined = current ? (() => {
            const width = current.viewport.width / current.camera.z, height = current.viewport.height / current.camera.z;
            const margin = 2 * Math.max(width, height);
            return { x: current.camera.x - margin, y: current.camera.y - margin, width: width + 2 * margin, height: height + 2 * margin };
        })() : undefined;
        lastSensitive = sensitive;
        const deviceScale = current ? current.camera.z * current.viewport.dpr : undefined;
        // The viewport is consumed as a bounded ordered stream: no whole-sheet node array is ever built.
        const open = pin.paintStream;
        if (!open) { pin.release(); report(new Error('Board scene has no bounded paint stream')); return; }
        lastCandidates = world ? pin.countCandidates?.(selectedSheet, world) ?? null : null;
        // Dense mode keeps only the live nodes in its frame: selection, wet ink, embeds and previewed nodes.
        // Their set is the frame's whole sensitivity set, so every barrier a tile meets is present.
        // An absent set is EMPTY here: an unset `only` would stream the whole sheet as the "live" frame.
        const dense = densityMode === 'dense';
        const liveSet = dense ? (union(precisionNodeIds(sensitive), previewCoverage?.()?.nodeIds ?? null) ?? new Set<string>()) as ReadonlySet<NodeId> : null;
        const sensitiveNodes = (dense ? liveSet : precisionNodeIds(sensitive)) as ReadonlySet<NodeId>;
        // Tile streams reopened by the frame share this request's identity (precision, sensitivity), not its world.
        const identity = { sheetId: selectedSheet, theme: view.theme, sensitiveNodes,
            ...(deviceScale ? { deviceScale, allowInkLod: true } : {}) };
        const shape = dense ? { ...identity, only: liveSet! } : { ...identity, ...(world ? { world } : {}) };
        void open.call(pin, shape, controller.signal).then(stream => {
            if (disposed || !view.visible || controller.signal.aborted || sequence !== request) {
                void stream.release().catch(report).finally(() => pin.release());
                return;
            }
            frames.requestStream({ stream, isCurrent: () => pin.isCurrent(), release: () => pin.release(), ...(dense ? { liveOnly: true as const } : {}),
                open: (apron, signal) => open.call(pin, { ...identity, world: apron }, signal) });
            paintJob = null; publish();
        }, error => { pin.release(); if (!controller.signal.aborted) report(error); });
    }
    const cancelReveal = () => { const job = revealJob; revealJob = null; job?.abort(); };
    const reveal = (ids: ReadonlySet<NodeId>) => {
        cancelReveal();
        if (disposed || !view.visible || !ids.size) return;
        const controller = new AbortController(); revealJob = controller;
        void (async () => {
            const ready = await runtime.ready;
            let box: readonly [number, number, number, number] | null = null;
            for (const id of ids) {
                controller.signal.throwIfAborted();
                const bounds = await ready.ensureExactBounds(id, controller.signal), next = bounds?.selectable;
                if (next) box = box ? [Math.min(box[0], next[0]), Math.min(box[1], next[1]), Math.max(box[2], next[2]), Math.max(box[3], next[3])] : next;
            }
            if (!disposed && view.visible && revealJob === controller && !controller.signal.aborted && box) {
                options.reveal({ x: box[0], y: box[1], width: box[2] - box[0], height: box[3] - box[1] });
            }
        })().catch(error => { if (!controller.signal.aborted) report(error); })
            .finally(() => { if (revealJob === controller) revealJob = null; });
    };
    const unbind = runtime.bindView({ visible: () => view.visible, focused: () => view.focused,
        invalidate() { layers.invalidate('board-session'); publish(); },
        finishGesture: () => interaction?.finishGesture(), finishComposition: () => interaction?.finishComposition(), reveal,
        captureText: () => interaction?.captureText?.(), restoreText: text => interaction?.restoreText?.(text),
        beforeHistoryReplay: (step, direction) => interaction?.beforeHistoryReplay?.(step, direction) ?? true });
    let stopScene: (() => void) | undefined;
    void runtime.ready.then(ready => {
        if (disposed) return;
        stopScene = ready.subscribe(() => { publish(); requestPaint(); });
        publish(); requestPaint(); layers.invalidate('board-scene-ready');
    }, report);
    let previousSheet = sheet();
    const stopSelection = runtime.selection.subscribe(() => {
        const currentSheet = sheet();
        if (currentSheet !== previousSheet) { previousSheet = currentSheet; clearPreview?.(); }
        cancelReveal(); publish(); requestPaint();
    });
    let previousRevision = options.session.doc.rev;
    const stopSession = options.session.subscribe(() => {
        if (options.session.doc.rev !== previousRevision) { previousRevision = options.session.doc.rev; clearPreview?.(); }
        publish(); if (runtime.scene?.ready) requestPaint();
    });
    snapshot = makeSnapshot();
    const dispose = () => {
        if (disposed) return;
        clearPreview?.(); clearPreview = null;
        const oldProducer = embedProducer; embedProducer = null; oldProducer?.dispose();
        const oldEmbed = embedPort; embedPort = null;
        if (oldEmbed) { oldEmbed.setVisible(false); void oldEmbed.dispose().catch(report); }
        disposed = true; paintJob?.abort(); cancelReveal(); interaction?.finishGesture(); interaction?.finishComposition();
        unbind(); stopScene?.(); stopSelection(); stopSession(); accessibility.dispose(); frames.dispose(); listeners.clear(); interaction = null;
        options.signal?.removeEventListener('abort', dispose);
    };
    options.signal?.addEventListener('abort', dispose, { once: true });
    return {
        session: options.session, scene, accessibility,
        getSnapshot: () => snapshot,
        wakeAt(deadlineMs) { if (!disposed) layers.wakeAt(deadlineMs); },
        getView: () => ({ ...view }),
        subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        setView(next) {
            if (disposed) return;
            const old = view; view = { ...next }; previousSheet = sheet();
            if (old.visible !== view.visible) embedPort?.setVisible(view.visible);
            if (view.visible && (old.theme !== view.theme || old.sheetId !== view.sheetId)) clearPreview?.();
            if (!view.visible) { clearPreview?.(); paintJob?.abort(); cancelReveal(); frames.clear(); drawnFrame = null; interaction?.finishGesture(); interaction?.finishComposition(); }
            publish();
            if (view.visible && (!old.visible || view.theme !== old.theme || view.sheetId !== old.sheetId)) requestPaint();
            layers.invalidate('board-view');
        },
        focusNode(id) {
            if (disposed || !options.session.doc.nodes.has(id as NodeId)) return;
            runtime.selection.replace([id as NodeId]); reveal(new Set([id as NodeId]));
        },
        cancelReveal,
        connectEmbeds(port) {
            if (disposed) { if (port) void port.dispose().catch(report); return; }
            if (embedPort === port) return;
            const old = embedPort; embedPort = port;
            // One port, one producer: the producer presents only through the same port the per-node Load/Unload uses.
            const oldProducer = embedProducer;
            embedProducer = port ? createNativeEmbedPresentationProducer({ port, images, memory: embedMemory, onError: report }) : null;
            oldProducer?.dispose();
            if (old) { old.setVisible(false); void old.dispose().catch(report); }
            port?.setVisible(view.visible);
            publish(); layers.invalidate('board-embed-port');
        },
        presentationAccepted(presentation) { embedProducer?.onPresentation(presentation); },
        bindInteractions(ports) {
            if (disposed) throw new Error('Board view is disposed');
            interaction?.finishGesture(); interaction?.finishComposition(); interaction = ports;
            if (drawnFrame) ports.presented?.(drawnFrame.sceneRevision, drawnFrame.token, drawnFrame.frame, drawnFrame.context);
            return () => { if (interaction === ports) { ports.finishGesture(); ports.finishComposition(); interaction = null; } };
        },
        readyPaintFrame: () => {
            const frame = disposed ? null : layers.readyFrame();
            if (!frame) return null;
            const omitted = omitPreview(frame);
            return omitted?.size ? { ...frame, occludedInkNodeIds: omitted } : frame;
        },
        setInteractionLayers(next) { if (!disposed && interactionLayers !== next) { interactionLayers = next; publish(); layers.invalidate('board-interaction-layers'); } },
        setPreviewLayers(next, coverage) {
            if (disposed) return;
            previewCoverage = next ? coverage ?? null : null;
            if (previewLayers !== next) { previewLayers = next; publish(); }
            layers.invalidate('board-preview-layers');
        },
        bindPreviewClear(clear) {
            if (disposed) throw new Error('Board view is disposed');
            clearPreview?.(); clearPreview = clear;
            return () => { if (clearPreview === clear) clearPreview = null; };
        },
        dispose,
    };
};
