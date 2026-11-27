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
import { chooseTileScale } from '../render/tileHierarchy';
import { auditCount, auditGauge, auditTape, renderAuditEnabled } from '../../platform/render/renderAudit';
import { RENDER_CONSTANTS } from '../../platform/render/constants';
import type { DensityMode } from '../render/density';
import { createPaintFrameAssembler } from '../render/frameAssembler';
import { inkRealisationNear, pictureTileWorld } from '../render/paintRequestScope';
import { LiveNodeUnion } from '../render/nodeSets';
import { DEFAULT_BOARD_PALETTES } from '../render/palette';
import { BoundsQuality } from '../scene/bounds';
import type { SceneSpatial } from '../scene/types';
import { createViewerAccessibility } from './accessibility';
import { createPreviewSlot } from './previewSlot';
import type { AttachView, ViewerInteractionPorts, ViewerPaintPresentation, ViewerReadiness, ViewerSnapshot, ViewerViewParams } from './types';
import { isCancellation } from '../../platform/workers/envelope';

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

export type ViewChange = 'state' | 'paint';

const SCENE_STEP_UNITS = 1_000_000;

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
    let densityMode: DensityMode = 'direct', lastCandidates: number | null = null, paintWhenReady = false;
    type SceneKey = { readonly revision: number; readonly sheet: string; readonly theme: string; readonly sensitive: unknown; readonly band: number | null };
    const sameSceneKey = (a: SceneKey | null, b: SceneKey): boolean => !!a && a.revision === b.revision && a.sheet === b.sheet
        && a.theme === b.theme && a.sensitive === b.sensitive && a.band === b.band;
    let viewAsked: SceneKey | null = null, sceneAsked: SceneKey | null = null, sceneDue = false;
    let streamDense = false;
    const sameSheetState = (a: SceneKey | null, b: SceneKey): boolean => sameSceneKey(a, { ...b, band: a?.band ?? null });
    let liveBand: number | null = null, carriedBand: number | null = null;
    let sceneRefused: SceneKey | null = null, sceneRefusedGrant = 0;
    let wholeCount: { readonly revision: number; readonly sheet: string; readonly count: number } | null = null;
    let viewWorld: { key: SceneKey; world: Rect; z: number } | null = null;
    let view2d: { key: SceneKey; world: Rect; tiles: Readonly<Rect>; scale: number } | null = null;
    let zoom2d: { scale: number; at: number } | null = null, settle2d: ReturnType<typeof setTimeout> | null = null;
    const ZOOM_SETTLE_MS = 250;
    const cancelSettle2d = () => { if (settle2d !== null) { clearTimeout(settle2d); settle2d = null; } };
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
    let previewCoverage: (() => Readonly<{ frame: PaintSource; nodeIds: ReadonlySet<string>; committed?: number }> | null) | null = null;
    let clearPreview: (() => void) | null = null;
    const listeners = new Set<(change?: ViewChange) => void>();
    const palettes = options.palette ?? DEFAULT_BOARD_PALETTES;
    const sheet = () => view.sheetId ?? runtime.selection.getSnapshot().sheet;
    let paperSnapshot: NotebookPaperSnapshot | null = null, paperSource: NotebookPaperSnapshot['host']['paper'] | null = null, paperRevision = 0;
    const paper = options.session.doc.host.kind === 'notebook' ? createNotebookPaperLayer({
        read() {
            const doc = options.session.doc, host = doc.host;
            if (host.kind !== 'notebook') throw new Error('Notebook host changed');
            if (paperSnapshot && host.paper === paperSource) return paperSnapshot;
            const was = paperSnapshot?.host.paper, next = host.paper;
            paperSource = next;
            if (paperSnapshot && was && was.size === next.size && was.orientation === next.orientation && was.ruling === next.ruling
                && was.spacing === next.spacing && was.margin === next.margin && was.pageCount === next.pageCount) return paperSnapshot;
            const stack = boardPageStack(host);
            if (!stack) throw new Error('Notebook page layout unavailable');
            const pages = stack.rects.map((rect, index) => Object.freeze({ index, width: rect.width, height: rect.height,
                rotate: 0 as const, userUnit: 1, toUserSpace: [1, 0, 0, 1, 0, 0] as const }));
            paperSnapshot = Object.freeze({ revision: paperSnapshot ? ++paperRevision : paperRevision,
                host: Object.freeze({ ...host, paper: Object.freeze({ ...next }) }), pages: Object.freeze(pages) });
            return paperSnapshot;
        }, palette: () => palettes.light, onError: error => report(error),
    }) : null;
    const report = (error: unknown) => {
        if (disposed || isCancellation(error)) return;
        failed = error instanceof Error ? error : new Error(String(error));
        options.onError(failed); publish();
    };
    const scene: SceneSpatial = {
        get revision() { return runtime.scene?.revision ?? options.session.doc.rev; },
        get layout() { return runtime.scene?.layout ?? boardPageStack(options.session.doc.host) ?? null; },
        worldBounds: id => runtime.scene?.worldBounds(id) ?? (options.session.doc.nodes.has(id)
            ? { revision: options.session.doc.rev, quality: BoundsQuality.Pending, ink: null, selectable: null } : null),
        ensureExactBounds: async (id, signal) => (await runtime.ready).ensureExactBounds(id, signal),
        ensureExactBoundsMany: async (ids, signal) => (await runtime.ready).ensureExactBoundsMany(ids, signal),
        query(...args) { if (!runtime.scene) throw new Error('Scene is still loading'); return runtime.scene.query(...args); },
        spatialCursor(...args) { if (!runtime.scene) throw new Error('Scene is still loading'); return runtime.scene.spatialCursor(...args); },
        pin() { if (!runtime.scene) throw new Error('Scene is still loading'); return runtime.scene.pin(); },
    };
    const images = options.images ?? { acquire: async () => { throw new Error('This board view has no admitted image provider'); } };
    const assembler = createPaintFrameAssembler(() => layers.invalidate('board-paint-ready'), report, {
        isActive: () => !disposed && view.visible && (typeof document === 'undefined' || !document.hidden),
    });
    const frames = options.liveFrames ? options.liveFrames.wrap(assembler) : assembler;
    const previewOmission = (dry: PaintSource): ReadonlySet<string> | null => {
        if (!previewLayers || !view.visible || disposed) return null;
        const preview = previewCoverage?.();
        const none = (why: string): null => { if (renderAuditEnabled()) auditTape(`preview-omit:none:${why}`); return null; };
        if (!preview) return none('no-coverage');
        if (preview.committed !== undefined && options.session.doc.rev === preview.committed) {
            if (dry.sceneRevision !== preview.frame.sceneRevision && dry.sceneRevision !== preview.committed) return none('committed-dry');
        } else if (preview.frame.sceneRevision !== dry.sceneRevision || dry.sceneRevision !== options.session.doc.rev) {
            return none(preview.committed !== undefined ? `armed-rev:${options.session.doc.rev - preview.committed}` : 'revision');
        }
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
    const precisionNodeIds = (sensitive: ReadonlySet<string> | undefined) => union(selectionIds(), union(union(union(interaction?.liveNodeIds?.(),
        view.visible ? embedPort?.inlineNodeIds() : null), view.visible ? embedPort?.requestedNodeIds() : null), sensitive));
    const liveNodeIds = () => precisionNodeIds(interaction?.sensitiveNodeIds?.()) ?? undefined;
    const drawnPages = createDrawnPagesReader(), pageLayers: unknown[] = [];
    const opaqueWorld = (): readonly Rect[] => {
        const host = options.session.doc.host;
        if (host.kind === 'whiteboard') return opaqueWorldOf(host, view.inverted);
        pageLayers.length = 0;
        if (view.backdrops) for (const backdrop of view.backdrops) pageLayers.push(backdrop);
        if (paper) pageLayers.push(paper);
        return opaqueWorldOf(host, view.inverted, drawnPages(pageLayers));
    };
    const overlayDrawn = () => {
        const preview = previewLayers && view.visible && !disposed ? previewCoverage?.() : null;
        return preview?.committed !== undefined && options.session.doc.rev === preview.committed
            ? { sceneRevision: preview.committed, nodes: preview.nodeIds } : null;
    };
    const layers = createBoardLayers({ frames, images, onError: report, requestedRevision: () => options.session.doc.rev, requestedTheme: () => view.theme, omitNodes: omitPreview,
        overlayDrawn,
        changedNodesSince: (from, to) => runtime.scene?.changedNodesSince(from, to) ?? null,
        opaqueWorld,
        geometryPins: {
            pinVisible: ids => runtime.render.pinVisible(ids as Iterable<NodeId>), releasePins: () => runtime.render.releasePins() },
        inputActive: () => interaction?.pointerDown?.() ?? false,
        liveNodeIds, liveDraws: (nodeId, band, view, canvas) => interaction?.liveDraws?.(nodeId, band, view, canvas) ?? false, candidates: () => lastCandidates,
        onDensityMode(mode) {
            if (densityMode === mode || disposed) return;
            densityMode = mode;
            if (mode === 'direct' && streamDense) { viewWorld = null; view2d = null; viewAsked = null; sceneAsked = null; sceneDue = false; }
            requestPaint();
        },
        requestFrame: () => { if (!disposed) requestPaint(); },
        onPaintProgress: () => { if (!disposed) publish('paint'); },
        onDrawn(revision, frame, context) {
            options.liveFrames?.drawn(frame);
            embedPort?.drawn({ token: context.token, frameId: context.frameId, cameraEpoch: context.view.epoch,
                sceneRevision: revision, omittedNodeIds: context.omittedNodeIds });
        },
        beforePrepare(current, budget) {
            runtime.flushFrame(budget.frameId);
            if (runtime.scene && !runtime.scene.ready) {
                runtime.scene.step(SCENE_STEP_UNITS, budget.prepareDeadline);
                if (!runtime.scene.ready) layers.invalidate('board-scene-step');
            }
            if (paintWhenReady && runtime.scene?.ready) requestPaint();
            const sensitive = interaction?.sensitiveNodeIds?.();
            const changed = sensitive !== lastSensitive;
            if (!lastView || current.epoch !== lastView.epoch || changed || current.moving !== lastView.moving) {
                lastView = { ...current, camera: { ...current.camera }, viewport: { ...current.viewport } };
                requestPaint(sensitive);
            } else if (sceneDue) requestPaint(sensitive);
        },
        onPresented(revision, token, frame, context) {
            drawnFrame = { sceneRevision: revision, token, frame, context };
            if (failed) { failed = null; publish(); }
            const refusedAtThisGrant = !!viewAsked && sceneRefused !== null && sameSheetState(sceneRefused, viewAsked) && grantNow() <= sceneRefusedGrant;
            if (layers.onDevice() && !sceneDue && viewAsked && revision === viewAsked.revision && !sameSceneKey(sceneAsked, viewAsked) && !refusedAtThisGrant) { sceneDue = true; layers.invalidate('board-scene-request'); }
            interaction?.presented?.(revision, token, frame, context);
            embedProducer?.presented(revision, token, frame, context);
        },
    });
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
    function sameSnapshot(a: ViewerSnapshot, b: ViewerSnapshot): boolean {
        return a.state === b.state && a.readOnlyReason === b.readOnlyReason && a.sceneRevision === b.sceneRevision
            && a.layout === b.layout && a.palette === b.palette && a.layers === b.layers && a.backendPreference === b.backendPreference
            && a.appearance.background === b.appearance.background && a.appearance.inverted === b.appearance.inverted
            && JSON.stringify(a.paint) === JSON.stringify(b.paint);
    }
    function publish(change: ViewChange = 'state', force = false): void {
        if (disposed) return;
        const next = makeSnapshot();
        if (change === 'state') accessibility.invalidate();
        if (!force && snapshot && sameSnapshot(snapshot, next)) return;
        snapshot = next;
        for (const listener of listeners) listener(change);
    }
    const WHOLE_SHEET: Rect = { x: -1e12, y: -1e12, width: 2e12, height: 2e12 };
    const viewportOf = (view: { readonly camera: { readonly x: number; readonly y: number; readonly z: number };
        readonly viewport: { readonly width: number; readonly height: number } }): Rect =>
        ({ x: view.camera.x, y: view.camera.y, width: view.viewport.width / view.camera.z, height: view.viewport.height / view.camera.z });
    const containsRect = (outer: Rect, inner: Rect): boolean => inner.x >= outer.x && inner.y >= outer.y
        && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
    const holdsView = (world: Rect, viewport: Rect, samezoom: boolean): boolean => {
        const lead = samezoom ? 0.5 * Math.max(viewport.width, viewport.height) : 0;
        return containsRect(world, { x: viewport.x - lead, y: viewport.y - lead, width: viewport.width + 2 * lead, height: viewport.height + 2 * lead });
    };
    const grantNow = (): number => { const reported = layers.cpuGrantBytes(); return reported > 0 ? reported : RENDER_CONSTANTS.cpuGrantMinBytes; };
    const sceneFits = (wholeItems: number): boolean => {
        const viewItems = Math.max(1, lastCandidates ?? 1);
        const perItem = layers.cpuMandatoryBytes() / viewItems;
        return wholeItems * perItem <= grantNow() / 2;
    };
    function requestPaint(sensitive = interaction?.sensitiveNodeIds?.()): void {
        // A request made while the Scene is still catching up is kept and sent once it is ready: the dense
        // path asks once per missing live set, so a dropped request froze a large board (seen at 3,500 items).
        if (!disposed && view.visible && runtime.scene && !runtime.scene.ready) { paintWhenReady = true; return; }
        if (disposed || !view.visible || !runtime.scene?.ready) return;
        const onDevice = layers.onDevice();
        const viewNow = lastView;
        const band = onDevice && viewNow ? chooseTileScale(viewNow.camera.z * viewNow.viewport.dpr).scale : null;
        const moving = !!viewNow?.moving;
        if (carriedBand !== null && !moving) { carriedBand = null; viewWorld = null; viewAsked = null; sceneAsked = null; sceneDue = false; }
        const key: SceneKey = { revision: runtime.scene.revision, sheet: sheet(), theme: view.theme, sensitive, band };
        if (onDevice && viewNow) { const scale = viewNow.camera.z * viewNow.viewport.dpr; if (zoom2d?.scale !== scale) zoom2d = { scale, at: performance.now() }; }
        if (onDevice && sameSceneKey(sceneAsked, key)) return;
        if (onDevice && viewNow && zoom2d && key.band !== null) {
            const now = performance.now();
            const held = (asked: SceneKey | null): boolean => !!asked && asked.band !== null && sameSceneKey(asked, { ...key, band: asked.band })
                && asked.band >= key.band! && asked.band <= key.band! * Math.SQRT2 * (1 + 1e-9);
            if ((moving || now - zoom2d.at < ZOOM_SETTLE_MS) && (held(sceneAsked) || (!sceneDue && densityMode !== 'dense' && !!viewWorld
                && held(viewWorld.key) && holdsView(viewWorld.world, viewportOf(viewNow), viewWorld.z === viewNow.camera.z)))) {
                cancelSettle2d();
                settle2d = setTimeout(() => { settle2d = null; requestPaint(); }, Math.max(0, zoom2d.at + ZOOM_SETTLE_MS - now) + 1);
                return;
            }
        }
        if (onDevice && !sceneDue && densityMode !== 'dense' && viewNow && viewWorld && sameSceneKey(viewWorld.key, key)
            && holdsView(viewWorld.world, viewportOf(viewNow), viewWorld.z === viewNow.camera.z)) return;
        if (!onDevice && !sceneDue && densityMode !== 'dense' && viewNow && view2d && sameSceneKey(view2d.key, key)) {
            const scale = viewNow.camera.z * viewNow.viewport.dpr, screen = viewportOf(viewNow), now = performance.now();
            if (zoom2d?.scale !== scale) zoom2d = { scale, at: now };
            const pictures = runtime.session.doc.mediaRefs.size > 0;
            if (holdsView(view2d.world, screen, scale === view2d.scale) && (pictures ? scale === view2d.scale && containsRect(view2d.tiles, screen)
                : inkRealisationNear(scale, view2d.scale, 0))) return;
            if (holdsView(view2d.world, screen, scale === view2d.scale) && (!pictures || containsRect(view2d.tiles, screen))
                && (moving || now - zoom2d.at < ZOOM_SETTLE_MS) && inkRealisationNear(scale, view2d.scale, 1)) {
                cancelSettle2d();
                settle2d = setTimeout(() => { settle2d = null; requestPaint(); }, Math.max(0, zoom2d.at + ZOOM_SETTLE_MS - now) + 1);
                return;
            }
        }
        cancelSettle2d();
        let scene = onDevice && sceneDue && sameSceneKey(viewAsked, key);
        if (scene) {
            const whole = wholeCount && wholeCount.revision === key.revision && wholeCount.sheet === key.sheet ? wholeCount.count : null;
            if (whole === null) return;
            if (!sceneFits(whole)) { sceneRefused = key; sceneRefusedGrant = grantNow(); sceneDue = false; auditCount('board', 'request:scene-too-large'); scene = false; }
        }
        paintWhenReady = false;
        paintJob?.abort();
        const controller = new AbortController(), sequence = ++request;
        paintJob = controller;
        const pin = runtime.scene.pin(), selectedSheet = sheet();
        const current = lastView;
        const world: Rect | undefined = current ? (() => {
            const width = current.viewport.width / current.camera.z, height = current.viewport.height / current.camera.z;
            const margin = 1.5 * Math.max(width, height);
            return { x: current.camera.x - margin, y: current.camera.y - margin, width: width + 2 * margin, height: height + 2 * margin };
        })() : undefined;
        lastSensitive = sensitive;
        const deviceScale = current ? band ?? current.camera.z * current.viewport.dpr : undefined;
        if (band !== null && liveBand !== null && band !== liveBand && moving) carriedBand = liveBand;
        liveBand = band;
        const previousDeviceScale = moving && carriedBand !== null ? carriedBand : undefined;
        const exact = band !== null && current ? { exactScale: current.camera.z * current.viewport.dpr } : {};
        const open = pin.paintStream;
        if (!open) { pin.release(); report(new Error('Board scene has no bounded paint stream')); return; }
        const counted = world ? pin.countCandidates?.(selectedSheet, world) ?? null : null;
        if (counted !== null) lastCandidates = counted;
        // An absent set is EMPTY here: an unset `only` would stream the whole sheet as the "live" frame.
        const dense = densityMode === 'dense';
        const liveSet = dense ? (union(precisionNodeIds(sensitive), previewCoverage?.()?.nodeIds ?? null) ?? new Set<string>()) as ReadonlySet<NodeId> : null;
        const sensitiveNodes = (dense ? liveSet : precisionNodeIds(sensitive)) as ReadonlySet<NodeId>;
        const identity = { sheetId: selectedSheet, theme: view.theme, sensitiveNodes, ...exact,
            ...(deviceScale ? { deviceScale, allowInkLod: true } : {}), ...(onDevice ? { scenePrecision: true } : {}),
            ...(previousDeviceScale !== undefined ? { previousDeviceScale } : {}) };
        const sceneShape = { sheetId: selectedSheet, theme: view.theme, sensitiveNodes, ...exact,
            ...(deviceScale !== undefined ? { deviceScale } : {}), ...(previousDeviceScale !== undefined ? { previousDeviceScale } : {}) };
        const screenWorld: Rect | undefined = current ? { x: current.camera.x, y: current.camera.y,
            width: current.viewport.width / current.camera.z, height: current.viewport.height / current.camera.z } : undefined;
        const shape = scene ? sceneShape : dense ? { ...identity, only: liveSet! }
            : { ...identity, ...(world ? { world } : {}), ...(screenWorld ? { viewWorld: screenWorld } : {}) };
        auditCount('board', scene ? 'request:scene' : 'request:view');
        if (onDevice) { if (scene) sceneAsked = key; else viewAsked = key; }
        viewWorld = onDevice && !scene && !dense && world && deviceScale !== undefined && current ? { key, world, z: current.camera.z } : null;
        const tiles = screenWorld ? pictureTileWorld({ viewWorld: screenWorld }) : undefined;
        view2d = !onDevice && !scene && !dense && world && tiles && current ? { key, world, tiles, scale: current.camera.z * current.viewport.dpr } : null;
        sceneDue = false;
        void open.call(pin, shape, controller.signal).then(stream => {
            if (disposed || !view.visible || controller.signal.aborted || sequence !== request) {
                void stream.release().catch(report).finally(() => pin.release());
                return;
            }
            if (world) { const landed = pin.countCandidates?.(selectedSheet, world) ?? null; if (landed !== null) lastCandidates = landed; }
            if (!wholeCount || wholeCount.revision !== key.revision || wholeCount.sheet !== selectedSheet) {
                const total = pin.countCandidates?.(selectedSheet, WHOLE_SHEET) ?? null;
                if (total !== null) wholeCount = { revision: key.revision, sheet: selectedSheet, count: total };
            }
            streamDense = dense;
            frames.requestStream({ stream, isCurrent: () => pin.isCurrent(), release: () => pin.release(), ...(dense ? { liveOnly: true as const } : {}),
                open: (apron, signal, resolved) => open.call(pin, { ...identity, world: apron }, signal, resolved) });
            paintJob = null; publish('paint');
        }, error => { pin.release(); if (!controller.signal.aborted) { viewWorld = null; view2d = null; report(error); } });
    }
    const cancelReveal = () => { const job = revealJob; revealJob = null; job?.abort(); };
    const reveal = (ids: ReadonlySet<NodeId>) => {
        cancelReveal();
        if (disposed || !view.visible || !ids.size) return;
        const controller = new AbortController(); revealJob = controller;
        void (async () => {
            const ready = await runtime.ready;
            let box: readonly [number, number, number, number] | null = null;
            const exact = await ready.ensureExactBoundsMany([...ids], controller.signal);
            for (const id of ids) {
                const next = exact.get(id)?.selectable;
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
        stopScene = ready.subscribe(() => { publish(); view2d = null; requestPaint(); });
        publish(); requestPaint(); layers.invalidate('board-scene-ready');
    }, report);
    let previousSheet = sheet();
    const stopSelection = runtime.selection.subscribe(() => {
        const currentSheet = sheet();
        if (currentSheet !== previousSheet) { previousSheet = currentSheet; clearPreview?.(); }
        cancelReveal(); publish('state', true); requestPaint();
    });
    let previousRevision = options.session.doc.rev;
    const stopSession = options.session.subscribe(() => {
        if (options.session.doc.rev !== previousRevision) { previousRevision = options.session.doc.rev; clearPreview?.(); }
        publish(); if (runtime.scene?.ready) requestPaint();
    });
    snapshot = makeSnapshot();
    const dropNodeGauge = auditGauge(`board:nodes:${options.auditPane ?? options.token.documentId}`, () => options.session.doc.bySheet.get(sheet())?.size ?? 0);
    const dispose = () => {
        if (disposed) return;
        dropNodeGauge();
        clearPreview?.(); clearPreview = null;
        const oldProducer = embedProducer; embedProducer = null; oldProducer?.dispose();
        const oldEmbed = embedPort; embedPort = null;
        if (oldEmbed) { oldEmbed.setVisible(false); void oldEmbed.dispose().catch(report); }
        cancelSettle2d();
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
            if (old.visible !== view.visible) { embedPort?.setVisible(view.visible); runtime.viewVisibilityChanged(); }
            if (view.visible && (old.theme !== view.theme || old.sheetId !== view.sheetId)) clearPreview?.();
            if (!view.visible) { clearPreview?.(); paintJob?.abort(); cancelReveal(); frames.clear(); drawnFrame = null; viewWorld = null; view2d = null; zoom2d = null; cancelSettle2d(); viewAsked = null; sceneAsked = null; liveBand = null; carriedBand = null; interaction?.finishGesture(); interaction?.finishComposition(); }
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
