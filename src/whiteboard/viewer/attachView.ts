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

/** What a view publish changed: the view's state, or only the paint progress its snapshot reports. */
export type ViewChange = 'state' | 'paint';

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
    // frame is up, the whole scene is asked ONCE with no world (its strokes at the camera's band). While the scene is asked for the current
    // key, a camera change asks for nothing: the composer's tiles follow the camera, the scene's item set does not.
    // The ink band (the tile ladder's band top of the device scale, null off a device) is part of the key: a request is made again
    // only when the camera crosses a band, so a zoom inside one band asks nothing, and the request is never rebuilt per frame.
    type SceneKey = { readonly revision: number; readonly sheet: string; readonly theme: string; readonly sensitive: unknown; readonly band: number | null };
    const sameSceneKey = (a: SceneKey | null, b: SceneKey): boolean => !!a && a.revision === b.revision && a.sheet === b.sheet
        && a.theme === b.theme && a.sensitive === b.sensitive && a.band === b.band;
    let viewAsked: SceneKey | null = null, sceneAsked: SceneKey | null = null, sceneDue = false;
    // A refusal is for the whole sheet's size (revision, sheet, theme, sensitivity), not for the band: it latches across crossings.
    const sameSheetState = (a: SceneKey | null, b: SceneKey): boolean => sameSceneKey(a, { ...b, band: a?.band ?? null });
    // The band the last request was made at, and the band the view held before the last crossing during a live zoom (carriedBand).
    // The carry lasts for the whole move, every request of it: a request made later in the same move keeps the band, since the
    // wanted band may not have built yet. At rest it is dropped and the request is made again, so the strokes settle on the wanted band.
    let liveBand: number | null = null, carriedBand: number | null = null;
    // The key whose whole-scene request was refused for its size: not asked again for that key (sceneRefused stops the stage's re-arming),
    // until the pane's CPU grant grows past the grant it was refused at (sceneRefusedGrant): the size test depends on the grant.
    let sceneRefused: SceneKey | null = null, sceneRefusedGrant = 0;
    // The sheet's whole candidate count at a revision, read from a view pin once its stream has opened: a pin counts
    // nothing before that, so the whole-scene decision waits for it (a probe pin would never answer).
    let wholeCount: { readonly revision: number; readonly sheet: string; readonly count: number } | null = null;
    // The view request in force: its key, its device scale and the world it covers (1.5 viewports each side).
    let viewWorld: { key: SceneKey; world: Rect } | null = null;
    /** canvas2d's standing view request (see requestPaint): its key, its world, the world its picture tiles cover and its exact scale. */
    let view2d: { key: SceneKey; world: Rect; tiles: Readonly<Rect>; scale: number } | null = null;
    // The zoom settling of both routes (see requestPaint): the last device scale seen, when it was first seen, and the wake that asks
    // for the exact ink band once it has held for ZOOM_SETTLE_MS.
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
    /** 'paint': the paint progress moved (see onPaintProgress); anything else is a change to the view's state. */
    const listeners = new Set<(change?: ViewChange) => void>();
    const palettes = options.palette ?? DEFAULT_BOARD_PALETTES;
    const sheet = () => view.sheetId ?? runtime.selection.getSnapshot().sheet;
    // The paper's revision is its own: it moves only when the paper's properties or its page count change. It was the document's
    // revision, so every stroke made the paper a new revision: it re-staged its template and recomposed every paper tile, and until
    // that finished it was not current, so no frame was complete (measured, notebook gesture kit on WebGL2: after the draw phase
    // pan-sat 0/90, zoom-sat 0/77, draw-sat 0/91 complete, paper cov:not-current on every frame; wet ink unprepared 119 of 123
    // draw frames, its budget spent by the paper's staging).
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
        // Audit only: why the base omits nothing while a preview is shown (a release frame's stale picture is traced to it).
        const none = (why: string): null => { if (renderAuditEnabled()) auditTape(`preview-omit:none:${why}`); return null; };
        if (!preview) return none('no-coverage');
        // A committed overlay keeps its nodes until the base has presented the commit revision, and the base omits them until then,
        // from its older paint frame and from the commit's: the picture is the base without them and the overlay with them. Omitting
        // nothing at the commit drew the moved node at its old place and its new one for the frames the base's commit frame took,
        // then twice at the new place (measured: 2 stand-in presents per release, coverage-not:revision).
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
    // What a committed overlay drew, at the commit revision: the base's older picture omits those nodes and is current for them.
    const overlayDrawn = () => {
        const preview = previewLayers && view.visible && !disposed ? previewCoverage?.() : null;
        return preview?.committed !== undefined && options.session.doc.rev === preview.committed
            ? { sceneRevision: preview.committed, nodes: preview.nodeIds } : null;
    };
    const layers = createBoardLayers({ frames, images, onError: report, requestedRevision: () => options.session.doc.rev, requestedTheme: () => view.theme, omitNodes: omitPreview,
        overlayDrawn,
        changedNodesSince: (from, to) => runtime.scene?.changedNodesSince(from, to) ?? null,
        opaqueWorld,
        // The live zoom's geometry pins (the composer holds the visible strokes at the band it draws and the band before it).
        geometryPins: {
            pinVisible: ids => runtime.render.pinVisible(ids as Iterable<NodeId>), releasePins: () => runtime.render.releasePins() },
        inputActive: () => interaction?.pointerDown?.() ?? false,
        liveNodeIds, liveDraws: (nodeId, band, view, canvas) => interaction?.liveDraws?.(nodeId, band, view, canvas) ?? false, candidates: () => lastCandidates,
        onDensityMode(mode) { if (densityMode !== mode && !disposed) { densityMode = mode; requestPaint(); } },
        requestFrame: () => { if (!disposed) requestPaint(); },
        onPaintProgress: () => { if (!disposed) publish('paint'); },
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
            if (!lastView || current.epoch !== lastView.epoch || changed || current.moving !== lastView.moving) {
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
            // Armed once per key: while the stage is already due, a presented frame must not invalidate again (that re-presented forever).
            const refusedAtThisGrant = !!viewAsked && sceneRefused !== null && sameSheetState(sceneRefused, viewAsked) && grantNow() <= sceneRefusedGrant;
            if (layers.onDevice() && !sceneDue && viewAsked && revision === viewAsked.revision && !sameSceneKey(sceneAsked, viewAsked) && !refusedAtThisGrant) { sceneDue = true; layers.invalidate('board-scene-request'); }
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
    function sameSnapshot(a: ViewerSnapshot, b: ViewerSnapshot): boolean {
        return a.state === b.state && a.readOnlyReason === b.readOnlyReason && a.sceneRevision === b.sceneRevision
            && a.layout === b.layout && a.palette === b.palette && a.layers === b.layers && a.backendPreference === b.backendPreference
            && a.appearance.background === b.appearance.background && a.appearance.inverted === b.appearance.inverted
            && JSON.stringify(a.paint) === JSON.stringify(b.paint);
    }
    // The native view repaints on every listener call, so listeners hear only a change the snapshot can show. `force` is for a
    // change the snapshot does not carry (the selection), which the caller has already seen change.
    function publish(change: ViewChange = 'state', force = false): void {
        if (disposed) return;
        const next = makeSnapshot();
        // The accessibility mirror reads selection, session and scene only: a paint-progress change leaves it as it is, and
        // its sync would otherwise request a frame for nothing (measured: 6 and 11 frames in the 3 s after a drag).
        if (change === 'state') accessibility.invalidate();
        if (!force && snapshot && sameSnapshot(snapshot, next)) return;
        snapshot = next;
        for (const listener of listeners) listener(change);
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
        // The live camera's ink band: the tile ladder's band top, the same ladder the services key the strokes by. The band
        // moves only at a crossing, so the request's identity does too.
        const band = onDevice && viewNow ? chooseTileScale(viewNow.camera.z * viewNow.viewport.dpr).scale : null;
        const moving = !!viewNow?.moving;
        if (carriedBand !== null && !moving) { carriedBand = null; viewWorld = null; viewAsked = null; sceneAsked = null; sceneDue = false; }
        const key: SceneKey = { revision: runtime.scene.revision, sheet: sheet(), theme: view.theme, sensitive, band };
        // Every scale the camera shows starts the zoom's settle window, a request that stands included: tracked only past the standing
        // checks, a wheel zoom alternating across a band let the settle wake fire mid-zoom and ask again (measured: 10 of 40 steps).
        if (onDevice && viewNow) { const scale = viewNow.camera.z * viewNow.viewport.dpr; if (zoom2d?.scale !== scale) zoom2d = { scale, at: performance.now() }; }
        // The whole scene is already asked for this key: a camera change needs no request (checked before the abort below, so the
        // scene asked in flight is not cancelled).
        if (onDevice && sameSceneKey(sceneAsked, key)) return;
        // A request at a band up to one finer than the camera's stands while a zoom is still going (moving, or a new scale in the last
        // ZOOM_SETTLE_MS: a wheel's steps never mark the camera moving); the camera's own band is asked once the scale has held that
        // long. The GPU route draws a finer band's outline at a coarser scale (never a coarser one at a finer scale: a zoom in across a
        // band still asks). Asked at each crossing, a paced wheel zoom whose steps alternate across the band at 100% asked the whole
        // scene anew on every step and presented each step three times (measured, WebGL2, DPR 2, a drawing holding a 4000x3000
        // picture: 40 scene requests and 120 presents for 40 steps).
        if (onDevice && viewNow && zoom2d && key.band !== null) {
            const now = performance.now();
            const held = (asked: SceneKey | null): boolean => !!asked && asked.band !== null && sameSceneKey(asked, { ...key, band: asked.band })
                && asked.band >= key.band! && asked.band <= key.band! * Math.SQRT2 * (1 + 1e-9);
            if ((moving || now - zoom2d.at < ZOOM_SETTLE_MS) && (held(sceneAsked) || (!sceneDue && densityMode !== 'dense' && !!viewWorld
                && held(viewWorld.key) && containsRect(viewWorld.world, viewportOf(viewNow))))) {
                cancelSettle2d();
                settle2d = setTimeout(() => { settle2d = null; requestPaint(); }, Math.max(0, zoom2d.at + ZOOM_SETTLE_MS - now) + 1);
                return;
            }
        }
        // A view request whose world still holds the viewport, at the same key (band), stands: a pan or a zoom inside the band asks nothing new.
        if (onDevice && !sceneDue && densityMode !== 'dense' && viewNow && viewWorld && sameSceneKey(viewWorld.key, key)
            && containsRect(viewWorld.world, viewportOf(viewNow))) return;
        // canvas2d: a request stands while a new one would open the same stream. The 2D adapter flattens the frame's paths at the exact
        // scale itself; the stream reads the scale only for its strokes' realisation band and its pictures' tiles (decoded for the screen
        // and an eighth around it, pictureTileWorld). So a pan inside the world asks nothing new, nor, on a board without pictures, a zoom
        // inside the ink bands. A zoom one band across keeps the request too while the zoom is still going (moving, or a new scale in
        // the last ZOOM_SETTLE_MS: a wheel's steps are discrete and never mark the camera moving), as the GPU route carries its band
        // for a move; the exact band is asked for once the scale has held that long.
        // Asked anew on every step, each step built a new frame over two compositor frames and presented the same picture twice, once
        // from the old frame at the new camera, once rebuilt, whichever of the two the step's camera reached first (drawing, forced
        // canvas2d: pan 52 of 113 presents redundant, zoom 39 of 79, its 100%-122% wheel steps crossing a band at 100%; LARGE: 56-59
        // of 60 pan steps).
        if (!onDevice && !sceneDue && densityMode !== 'dense' && viewNow && view2d && sameSceneKey(view2d.key, key)) {
            const scale = viewNow.camera.z * viewNow.viewport.dpr, screen = viewportOf(viewNow), now = performance.now();
            if (zoom2d?.scale !== scale) zoom2d = { scale, at: now };
            const pictures = runtime.session.doc.mediaRefs.size > 0;
            if (containsRect(view2d.world, screen) && (pictures ? scale === view2d.scale && containsRect(view2d.tiles, screen)
                : inkRealisationNear(scale, view2d.scale, 0))) return;
            // A board with pictures stands through a zoom too while its picture tiles still cover the screen (a zoom in): they draw scaled
            // until the exact ask, as its ink does. Asked on every step, canvas2d presented each step twice (measured, a 4000x3000 picture
            // at DPR 2: 40 view requests and 80 presents for 40 wheel steps).
            if (containsRect(view2d.world, screen) && (!pictures || containsRect(view2d.tiles, screen))
                && (moving || now - zoom2d.at < ZOOM_SETTLE_MS) && inkRealisationNear(scale, view2d.scale, 1)) {
                cancelSettle2d();
                settle2d = setTimeout(() => { settle2d = null; requestPaint(); }, Math.max(0, zoom2d.at + ZOOM_SETTLE_MS - now) + 1);
                return;
            }
        }
        cancelSettle2d();
        // The whole scene, once per key, and only when its estimated cost fits (sceneFits). A count not known yet waits: a fresh
        // pin counts nothing until its first stream opens, so the stage stays due. A refusal is latched on this key.
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
        // The frame covers the viewport plus two of its sides: a progressive coarse tile may extend one tile
        // beyond the viewport, and every live item it meets must be in the frame to be drawn live.
        const world: Rect | undefined = current ? (() => {
            const width = current.viewport.width / current.camera.z, height = current.viewport.height / current.camera.z;
            // 1.5 viewports each side: a pan inside this world asks nothing new (viewWorld), so the margin is generous.
            const margin = 1.5 * Math.max(width, height);
            return { x: current.camera.x - margin, y: current.camera.y - margin, width: width + 2 * margin, height: height + 2 * margin };
        })() : undefined;
        lastSensitive = sensitive;
        // On a device the request's device scale is its band's top, so its strokes and tiles change only at a crossing; canvas2d keeps the exact scale.
        const deviceScale = current ? band ?? current.camera.z * current.viewport.dpr : undefined;
        // A crossing while the camera moves carries the band the view held before it, for the rest of the move: a strokes' wanted band
        // draws once it has built (the geometry's band-miss path holds the carried band until then), so a later request in the move keeps it.
        if (band !== null && liveBand !== null && band !== liveBand && moving) carriedBand = liveBand;
        liveBand = band;
        const previousDeviceScale = moving && carriedBand !== null ? carriedBand : undefined;
        // The view's own scale beside its band's top: pictures the GPU route draws plan their tiles at it (PictureTileRequest.exactScale).
        const exact = band !== null && current ? { exactScale: current.camera.z * current.viewport.dpr } : {};
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
        // On a device, the view stage realises its strokes at the whole-scene stage's precision (scenePrecision): the two stages
        // then share one realisation per stroke, and a stage switch re-keys nothing. Canvas2d keeps its request.
        const identity = { sheetId: selectedSheet, theme: view.theme, sensitiveNodes, ...exact,
            ...(deviceScale ? { deviceScale, allowInkLod: true } : {}), ...(onDevice ? { scenePrecision: true } : {}),
            ...(previousDeviceScale !== undefined ? { previousDeviceScale } : {}) };
        // The whole-scene stage: asked once per key on a device, after the view frame it follows is up. No world, so the pin
        // does not cull by the camera, so the scene's items do not change with the zoom; only its strokes' band does (at a crossing).
        const sceneShape = { sheetId: selectedSheet, theme: view.theme, sensitiveNodes, ...exact,
            ...(deviceScale !== undefined ? { deviceScale } : {}), ...(previousDeviceScale !== undefined ? { previousDeviceScale } : {}) };
        // The on-screen rect: picture tiles are decoded for it and a ring, not for the frame's whole margin (the large-picture fix).
        const screenWorld: Rect | undefined = current ? { x: current.camera.x, y: current.camera.y,
            width: current.viewport.width / current.camera.z, height: current.viewport.height / current.camera.z } : undefined;
        const shape = scene ? sceneShape : dense ? { ...identity, only: liveSet! }
            : { ...identity, ...(world ? { world } : {}), ...(screenWorld ? { viewWorld: screenWorld } : {}) };
        auditCount('board', scene ? 'request:scene' : 'request:view');
        if (onDevice) { if (scene) sceneAsked = key; else viewAsked = key; }
        // The world this view request asks for, kept until the camera leaves it (the skip at the top of requestPaint).
        viewWorld = onDevice && !scene && !dense && world && deviceScale !== undefined ? { key, world } : null;
        const tiles = screenWorld ? pictureTileWorld({ viewWorld: screenWorld }) : undefined;
        view2d = !onDevice && !scene && !dense && world && tiles && current ? { key, world, tiles, scale: current.camera.z * current.viewport.dpr } : null;
        sceneDue = false;
        void open.call(pin, shape, controller.signal).then(stream => {
            if (disposed || !view.visible || controller.signal.aborted || sequence !== request) {
                void stream.release().catch(report).finally(() => pin.release());
                return;
            }
            // The stream's open has built this pin's index for the sheet: the count is current before the frame prepares.
            if (world) { const landed = pin.countCandidates?.(selectedSheet, world) ?? null; if (landed !== null) lastCandidates = landed; }
            if (!wholeCount || wholeCount.revision !== key.revision || wholeCount.sheet !== selectedSheet) {
                const total = pin.countCandidates?.(selectedSheet, WHOLE_SHEET) ?? null;
                if (total !== null) wholeCount = { revision: key.revision, sheet: selectedSheet, count: total };
            }
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
        // A published scene can change what a stream resolves at the same revision (a font that loaded re-lays every text node), so
        // canvas2d's standing request ends here (measured: a new frame's title stayed laid out in the fallback font, 2 px narrower).
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
    // The node count on the shown sheet, for the audit's node-count check. Registered only while the audit is on (no-op off).
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
            if (old.visible !== view.visible) embedPort?.setVisible(view.visible);
            if (view.visible && (old.theme !== view.theme || old.sheetId !== view.sheetId)) clearPreview?.();
            // A hidden pane's frames and stream are gone, and its camera may change before it is shown again (a resize, a restored
            // position): the request state that assumes the old stream and camera is dropped, so a show always asks for the current one.
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
