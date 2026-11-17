import type { Rect, ViewState } from '../../platform/types';
import type { RenderToken } from '../../platform/render/types';
import { getBoardRuntime } from '../host/runtime';
import { createNotebookPaperLayer, type NotebookPaperSnapshot } from '../host/notebookPaperLayer';
import type { NodeId } from '../model/ids';
import type { PaintSource } from '../render/paintStream';
import type { PlatformLayerDefinition } from '../../platform/render/attachPlatformPane.types';
import type { EmbedPresentationPort } from '../../platform/render/embedPresentation.types';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import { createNativeEmbedPresentationProducer, type NativeEmbedPresentationProducer } from '../host/embedPresentationFacts';
import { boardPageStack } from '../model/pages';
import { createBoardLayers, BOARD_BACKEND_PREFERENCE, createDrawnPagesReader, opaqueWorldOf } from '../render/boardLayers';
import { auditCount } from '../../platform/render/renderAudit';
import { RENDER_CONSTANTS } from '../../platform/render/constants';
import type { DensityMode } from '../render/density';
import { createPaintFrameAssembler } from '../render/frameAssembler';
import { LiveNodeUnion } from '../render/nodeSets';
import { DEFAULT_BOARD_PALETTES } from '../render/palette';
import { BoundsQuality } from '../scene/bounds';
import type { SceneSpatial } from '../scene/types';
import { createViewerAccessibility } from './accessibility';
import { createPreviewSlot } from './previewSlot';
import type { AttachView, ViewerInteractionPorts, ViewerPaintPresentation, ViewerReadiness, ViewerSnapshot, ViewerViewParams } from './types';

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
    let lastView: ViewState | null = null, drawnFrame: { sceneRevision: number; token: RenderToken; frame: PaintSource; context?: ViewerPaintPresentation } | null = null;
    let interaction: ViewerInteractionPorts | null = null, embedPort: EmbedPresentationPort | null = null;
    let embedProducer: NativeEmbedPresentationProducer | null = null;
    let lastSensitive: ReadonlySet<string> | undefined;
    // Density mode and the index's candidate count drive which frame kind is requested; both are read
    // by the layers, which never own a frame request of their own.
    let densityMode: DensityMode = 'direct', lastCandidates: number | null = null, paintWhenReady = false;
    // The device's two-stage request (camera invariance, PLAN issue 1). The first picture asks for the view's world; once that
    // frame is up, the whole scene is asked ONCE with no world and no device scale. While the scene is asked for the current
    // key, a camera change asks for nothing: the composer's tiles follow the camera, the scene's item set does not.
    type SceneKey = { readonly revision: number; readonly sheet: string; readonly theme: string; readonly sensitive: unknown };
    const sameSceneKey = (a: SceneKey | null, b: SceneKey): boolean => !!a && a.revision === b.revision && a.sheet === b.sheet
        && a.theme === b.theme && a.sensitive === b.sensitive;
    let viewAsked: SceneKey | null = null, sceneAsked: SceneKey | null = null, sceneDue = false;
    // The key whose whole-scene request was refused for its size: not asked again for that key (sceneRefused stops the stage's re-arming).
    let sceneRefused: SceneKey | null = null;
    // The view request in force: its key, its device scale and the world it covers (1.5 viewports each side).
    let viewWorld: { key: SceneKey; scale: number; world: Rect } | null = null;
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
    let previewCoverage: (() => Readonly<{ frame: PaintSource; nodeIds: ReadonlySet<string> }> | null) | null = null;
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
    const previewOmission = (dry: PaintSource): ReadonlySet<string> | null => {
        if (!previewLayers || !view.visible || disposed) return null;
        const preview = previewCoverage?.();
        if (!preview || preview.frame.sceneRevision !== dry.sceneRevision || dry.sceneRevision !== options.session.doc.rev) return null;
        const a = preview.frame.token, b = dry.token;
        return a.vaultEpoch === b.vaultEpoch && a.documentId === b.documentId && a.bytesGeneration === b.bytesGeneration
            && a.session === b.session ? preview.nodeIds : null;
    };
    const omitPreview = (dry: PaintSource) => union(previewOmission(dry), view.visible ? embedPort?.inlineNodeIds(dry.sceneRevision) : null);
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
    // Requested embeds are live barriers too: a card the user asked for is drawn at its real paint position
    // before its facts exist, so it is never baked into a tile or omitted early.
    const precisionNodeIds = (sensitive: ReadonlySet<string> | undefined) => union(selectionIds(), union(union(union(interaction?.liveNodeIds?.(),
        view.visible ? embedPort?.inlineNodeIds() : null), view.visible ? embedPort?.requestedNodeIds() : null), sensitive));
    const liveNodeIds = () => precisionNodeIds(interaction?.sensitiveNodeIds?.()) ?? undefined;
    // The composer asks for the opaque world once per tile: the page list is rebuilt only when a layer's claim changes.
    const drawnPages = createDrawnPagesReader(), pageLayers: unknown[] = [];
    const opaqueWorld = (): readonly Rect[] => {
        const host = options.session.doc.host;
        if (host.kind === 'whiteboard') return opaqueWorldOf(host, view.inverted);
        pageLayers.length = 0;
        if (view.backdrops) for (const backdrop of view.backdrops) pageLayers.push(backdrop);
        if (paper) pageLayers.push(paper);
        return opaqueWorldOf(host, view.inverted, drawnPages(pageLayers));
    };
    const layers = createBoardLayers({ frames, images, onError: report, requestedRevision: () => options.session.doc.rev, requestedTheme: () => view.theme, omitNodes: omitPreview,
        opaqueWorld,
        liveNodeIds, candidates: () => lastCandidates,
        onDensityMode(mode) { if (densityMode !== mode && !disposed) { densityMode = mode; requestPaint(); } },
        requestFrame: () => { if (!disposed) requestPaint(); },
        onPaintProgress: () => { if (!disposed) publish(); },
        onDrawn(revision, frame, context) {
            options.liveFrames?.drawn(frame);
            embedPort?.drawn({ token: context.token, frameId: context.frameId, cameraEpoch: context.view.epoch,
                sceneRevision: revision, omittedNodeIds: context.omittedNodeIds });
        },
        beforePrepare(current, budget) {
            runtime.flushFrame(budget.frameId);
            // A Scene still behind the document is stepped one slice per frame: without another invalidation
            // nothing would wake the view once the frame that began the work has been drawn.
            if (runtime.scene && !runtime.scene.ready) {
                runtime.scene.step(8, budget.prepareDeadline);
                if (!runtime.scene.ready) layers.invalidate('board-scene-step');
            }
            if (paintWhenReady && runtime.scene?.ready) requestPaint();
            const sensitive = interaction?.sensitiveNodeIds?.();
            const changed = sensitive !== lastSensitive;
            if (!lastView || current.epoch !== lastView.epoch || changed) {
                lastView = { ...current, camera: { ...current.camera }, viewport: { ...current.viewport } };
                requestPaint(sensitive);
            } else if (sceneDue) requestPaint(sensitive);
        },
        onPresented(revision, token, frame, context) {
            drawnFrame = { sceneRevision: revision, token, frame, context };
            // A completed presentation is the layers working again: a failure reported before it no longer stands
            // (the layer's own error clears on the same event, so the view must not keep showing one it does not hold).
            if (failed) { failed = null; publish(); }
            // The view frame of the current key is up: the whole scene may now be asked for (once).
            // The request is made by the next prepare, which a presentation alone does not schedule: ask for that frame.
            if (layers.onDevice() && viewAsked && revision === viewAsked.revision && !sameSceneKey(sceneAsked, viewAsked) && !sameSceneKey(sceneRefused, viewAsked)) { sceneDue = true; layers.invalidate('board-scene-request'); }
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
    const previewUnderlay = createPreviewSlot('board-preview-underlay', layers[0]), previewContent = createPreviewSlot('board-preview-content', layers[1]);
    // Readiness needs a completed, matching paint once; after that a pending revision keeps the last pixels, not a loading screen.
    let paintEverCurrent = false;
    let snapshot: ViewerSnapshot;
    function makeSnapshot(): ViewerSnapshot {
        const palette = palettes[options.session.doc.kind === 'whiteboard' ? view.theme : 'light'];
        const nextLayers = [...view.backdrops ?? [], ...paper ? [paper] : [], layers[0],
            previewUnderlay.definition, ...interactionLayers ? [interactionLayers.underlay] : [],
            layers[1], previewContent.definition, ...interactionLayers ? [interactionLayers.content] : [],
            ...embedPort ? [embedPort.layer] : []];
        // A new topology seals platform input. Rebuilding the same list on preview cancellation
        // sealed it again during React's layout effect, recursively cancelling until error #185.
        const definitions = snapshot?.layers.length === nextLayers.length && nextLayers.every((layer, i) => snapshot.layers[i] === layer)
            ? snapshot.layers : Object.freeze(nextLayers);
        const paint = layers.paintProgress();
        // A presented frame of the current revision is drawn: refinement still pending is 'Updating…', not loading.
        if (paint.kind === 'current' || (paint.kind === 'pending' && paint.drawn)) paintEverCurrent = true;
        const state: ViewerReadiness = failed ? 'failed' : !runtime.scene ? 'loading'
            : !paintEverCurrent ? (paint.kind === 'failed' ? 'failed' : 'loading')
            : options.session.isReadOnly ? 'read-only' : 'ready';
        return { state, paint,
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
    // The whole-sheet world: board coordinates are bounded by the 1e12 world limit (as boardLayers' WHOLE_PLANE).
    const WHOLE_SHEET: Rect = { x: -1e12, y: -1e12, width: 2e12, height: 2e12 };
    const viewportOf = (view: { readonly camera: { readonly x: number; readonly y: number; readonly z: number };
        readonly viewport: { readonly width: number; readonly height: number } }): Rect =>
        ({ x: view.camera.x, y: view.camera.y, width: view.viewport.width / view.camera.z, height: view.viewport.height / view.camera.z });
    const containsRect = (outer: Rect, inner: Rect): boolean => inner.x >= outer.x && inner.y >= outer.y
        && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
    // The whole scene's estimated CPU cost: the owning band's CPU bytes for the current view, scaled from the view's item count
    // to the sheet's. It must fit half the pane's CPU grant: the grant the host reports, or the grant's floor
    // (cpuGrantMinBytes) while the host reports none. The floor is never above the true grant, so it stays the conservative test.
    const sceneFits = (wholeItems: number): boolean => {
        const viewItems = Math.max(1, lastCandidates ?? 1);
        const perItem = layers.cpuMandatoryBytes() / viewItems;
        const grant = layers.cpuGrantBytes() ?? RENDER_CONSTANTS.cpuGrantMinBytes;
        return wholeItems * perItem <= grant / 2;
    };
    function requestPaint(sensitive = interaction?.sensitiveNodeIds?.()): void {
        // A request made while the Scene is still catching up is kept and sent once it is ready: the dense
        // path asks once per missing live set, so a dropped request froze a large board (seen at 3,500 items).
        if (!disposed && view.visible && runtime.scene && !runtime.scene.ready) { paintWhenReady = true; return; }
        if (disposed || !view.visible || !runtime.scene?.ready) return;
        const onDevice = layers.onDevice();
        const key: SceneKey = { revision: runtime.scene.revision, sheet: sheet(), theme: view.theme, sensitive };
        // The whole scene is already asked for this key: a camera change needs no request (checked before the abort below, so the
        // scene asked in flight is not cancelled).
        if (onDevice && sameSceneKey(sceneAsked, key)) return;
        // A view request whose world still holds the viewport, at the same key and scale, stands: a pan inside it asks nothing new.
        const viewNow = lastView;
        if (onDevice && !sceneDue && densityMode !== 'dense' && viewNow && viewWorld && sameSceneKey(viewWorld.key, key)
            && viewWorld.scale === viewNow.camera.z * viewNow.viewport.dpr && containsRect(viewWorld.world, viewportOf(viewNow))) return;
        // The whole scene, once per key, and only when its estimated cost fits (sceneFits). A count not known yet waits: a fresh
        // pin counts nothing until its first stream opens, so the stage stays due. A refusal is latched on this key.
        let scene = onDevice && sceneDue && sameSceneKey(viewAsked, key);
        if (scene) {
            const probe = runtime.scene.pin();
            const whole = probe.countCandidates?.(sheet(), WHOLE_SHEET) ?? null;
            probe.release();
            if (whole === null) return;
            if (!sceneFits(whole)) { sceneRefused = key; sceneDue = false; auditCount('board', 'request:scene-too-large'); scene = false; }
        }
        paintWhenReady = false;
        paintJob?.abort();
        const controller = new AbortController(), sequence = ++request;
        paintJob = controller;
        const pin = runtime.scene.pin(), selectedSheet = sheet();
        const current = lastView;
        // The frame covers the viewport plus two of its sides: a progressive coarse tile may extend one tile
        // beyond the viewport, and every live item it meets must be in the frame to be drawn live.
        const world: Rect | undefined = current ? (() => {
            const width = current.viewport.width / current.camera.z, height = current.viewport.height / current.camera.z;
            // 1.5 viewports each side: a pan inside this world asks nothing new (viewWorld), so the margin is generous.
            const margin = 1.5 * Math.max(width, height);
            return { x: current.camera.x - margin, y: current.camera.y - margin, width: width + 2 * margin, height: height + 2 * margin };
        })() : undefined;
        lastSensitive = sensitive;
        const deviceScale = current ? current.camera.z * current.viewport.dpr : undefined;
        // The viewport is consumed as a bounded ordered stream: no whole-sheet node array is ever built.
        const open = pin.paintStream;
        if (!open) { pin.release(); report(new Error('Board scene has no bounded paint stream')); return; }
        // A pin's cell index is built by its own first stream open, so a fresh pin counts nothing yet: the count is
        // taken again when that stream lands. Keeping the last known count meanwhile (not nulling it) matters, since a
        // null count never releases the dense latch.
        const counted = world ? pin.countCandidates?.(selectedSheet, world) ?? null : null;
        if (counted !== null) lastCandidates = counted;
        // Dense mode keeps only the live nodes in its frame: selection, wet ink, embeds and previewed nodes.
        // Their set is the frame's whole sensitivity set, so every barrier a tile meets is present.
        // An absent set is EMPTY here: an unset `only` would stream the whole sheet as the "live" frame.
        const dense = densityMode === 'dense';
        const liveSet = dense ? (union(precisionNodeIds(sensitive), previewCoverage?.()?.nodeIds ?? null) ?? new Set<string>()) as ReadonlySet<NodeId> : null;
        const sensitiveNodes = (dense ? liveSet : precisionNodeIds(sensitive)) as ReadonlySet<NodeId>;
        // Tile streams reopened by the frame share this request's identity (precision, sensitivity), not its world.
        const identity = { sheetId: selectedSheet, theme: view.theme, sensitiveNodes,
            ...(deviceScale ? { deviceScale, allowInkLod: true } : {}) };
        // The whole-scene stage: asked once per key on a device, after the view frame it follows is up. No world, so the pin
        // does not cull by the camera; no device scale, so the scene's items do not change with the zoom.
        const sceneShape = { sheetId: selectedSheet, theme: view.theme, sensitiveNodes };
        const shape = scene ? sceneShape : dense ? { ...identity, only: liveSet! } : { ...identity, ...(world ? { world } : {}) };
        auditCount('board', scene ? 'request:scene' : 'request:view');
        if (onDevice) { if (scene) sceneAsked = key; else viewAsked = key; }
        // The world this view request asks for, kept until the camera leaves it (the skip at the top of requestPaint).
        viewWorld = onDevice && !scene && !dense && world && deviceScale !== undefined ? { key, scale: deviceScale, world } : null;
        sceneDue = false;
        void open.call(pin, shape, controller.signal).then(stream => {
            if (disposed || !view.visible || controller.signal.aborted || sequence !== request) {
                void stream.release().catch(report).finally(() => pin.release());
                return;
            }
            // The stream's open has built this pin's index for the sheet: the count is current before the frame prepares.
            if (world) { const landed = pin.countCandidates?.(selectedSheet, world) ?? null; if (landed !== null) lastCandidates = landed; }
            frames.requestStream({ stream, isCurrent: () => pin.isCurrent(), release: () => pin.release(), ...(dense ? { liveOnly: true as const } : {}),
                open: (apron, signal, resolved) => open.call(pin, { ...identity, world: apron }, signal, resolved) });
            paintJob = null; publish();
        }, error => { pin.release(); if (!controller.signal.aborted) { viewWorld = null; report(error); } });
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
        disposed = true; previewUnderlay.dispose(); previewContent.dispose(); paintJob?.abort(); cancelReveal(); interaction?.finishGesture(); interaction?.finishComposition();
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
            if (old.theme !== view.theme) interaction?.paletteChanged?.();
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
        embedsChanged() {
            if (disposed) return;
            requestPaint();
        },
        connectEmbeds(port) {
            if (disposed) { if (port) void port.dispose().catch(report); return; }
            if (embedPort === port) return;
            const old = embedPort; embedPort = port;
            // One port, one producer: the producer presents only through the same port the per-node Load/Unload uses.
            const oldProducer = embedProducer;
            embedProducer = port ? createNativeEmbedPresentationProducer({ port, memory: embedMemory, onError: report }) : null;
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
        boardDrawnInk: () => layers.drawnInkNodeIds(),
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
            if (previewLayers !== next) { previewLayers = next; previewUnderlay.set(next?.underlay ?? null); previewContent.set(next?.content ?? null); publish(); }
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
