import type { Rect, ViewState } from '../../platform/types';
import type { RenderToken } from '../../platform/render/types';
import { getBoardRuntime } from '../host/runtime';
import type { NodeId } from '../model/ids';
import { boardPageStack } from '../model/pages';
import { createBoardLayers, BOARD_BACKEND_PREFERENCE } from '../render/boardLayers';
import { createPaintFrameAssembler } from '../render/frameAssembler';
import { DEFAULT_BOARD_PALETTES } from '../render/palette';
import { BoundsQuality } from '../scene/bounds';
import type { SceneSpatial } from '../scene/types';
import { createViewerAccessibility } from './accessibility';
import type { AttachView, ViewerInteractionPorts, ViewerSnapshot, ViewerViewParams } from './types';

/** Attaches view resources only. The admitted model, scene, selection/history and
 * journal belong to the exact App-owned runtime and survive this view's disposal. */
export const attachView: AttachView = options => {
    options.signal?.throwIfAborted();
    const acquiredRuntime = getBoardRuntime(options.session);
    if (!acquiredRuntime || acquiredRuntime.session !== options.session) throw new Error('AttachView requires the App-owned board runtime');
    const runtime = acquiredRuntime;
    let view: ViewerViewParams = { ...options.view }, disposed = false, failed: Error | null = null;
    let paintJob: AbortController | null = null, revealJob: AbortController | null = null, request = 0;
    let lastView: ViewState | null = null, drawnFrame: { sceneRevision: number; token: RenderToken } | null = null;
    let interaction: ViewerInteractionPorts | null = null;
    const listeners = new Set<() => void>();
    const palettes = options.palette ?? DEFAULT_BOARD_PALETTES;
    const sheet = () => view.sheetId ?? runtime.selection.getSnapshot().sheet;
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
    const frames = createPaintFrameAssembler(() => layers.invalidate('board-paint-ready'), report);
    const layers = createBoardLayers({ frames, images, onError: report, requestedRevision: () => options.session.doc.rev,
        beforePrepare(current, budget) {
            runtime.flushFrame(budget.frameId);
            if (runtime.scene && !runtime.scene.ready) runtime.scene.step(8, budget.prepareDeadline);
            if (!lastView || current.epoch !== lastView.epoch) {
                lastView = { ...current, camera: { ...current.camera }, viewport: { ...current.viewport } };
                requestPaint();
            }
        },
        onPresented(revision, token) {
            drawnFrame = { sceneRevision: revision, token };
            interaction?.presented?.(revision, token);
        },
    });
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
        return { state: failed ? 'failed' : !runtime.scene ? 'loading' : options.session.isReadOnly ? 'read-only' : 'ready',
            readOnlyReason: failed?.message ?? runtime.session.readOnlyReason, sceneRevision: runtime.scene?.revision ?? options.session.doc.rev,
            layout: scene.layout, palette, appearance: { background: palettes[view.theme].background, inverted: view.inverted },
            layers: [...view.backdrops ?? [], ...layers], backendPreference: BOARD_BACKEND_PREFERENCE };
    }
    function publish(): void {
        if (disposed) return;
        snapshot = makeSnapshot(); accessibility.invalidate();
        for (const listener of listeners) listener();
    }
    function requestPaint(): void {
        if (disposed || !view.visible || !runtime.scene?.ready) return;
        paintJob?.abort();
        const controller = new AbortController(), sequence = ++request;
        paintJob = controller;
        const pin = runtime.scene.pin(), selectedSheet = sheet();
        const current = lastView;
        const world: Rect | undefined = current ? { x: current.camera.x, y: current.camera.y,
            width: current.viewport.width / current.camera.z, height: current.viewport.height / current.camera.z } : undefined;
        void pin.paintSource({ sheetId: selectedSheet, theme: view.theme, ...(world ? { world } : {}) }, controller.signal).then(source => {
            if (disposed || !view.visible || controller.signal.aborted || sequence !== request) { pin.release(); return; }
            frames.request({ source, release: () => pin.release() });
            paintJob = null; publish();
        }, error => { pin.release(); if (!controller.signal.aborted) report(error); });
    }
    const reveal = (ids: ReadonlySet<NodeId>) => {
        revealJob?.abort();
        const controller = new AbortController(); revealJob = controller;
        if (disposed || !view.visible || !ids.size) return;
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
        })().catch(error => { if (!controller.signal.aborted) report(error); });
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
    const stopSelection = runtime.selection.subscribe(() => { revealJob?.abort(); publish(); requestPaint(); });
    const stopSession = options.session.subscribe(() => { publish(); if (runtime.scene?.ready) requestPaint(); });
    snapshot = makeSnapshot();
    const dispose = () => {
        if (disposed) return;
        disposed = true; paintJob?.abort(); revealJob?.abort(); interaction?.finishGesture(); interaction?.finishComposition();
        unbind(); stopScene?.(); stopSelection(); stopSession(); accessibility.dispose(); frames.dispose(); listeners.clear(); interaction = null;
        options.signal?.removeEventListener('abort', dispose);
    };
    options.signal?.addEventListener('abort', dispose, { once: true });
    return {
        session: options.session, scene, accessibility,
        getSnapshot: () => snapshot,
        subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        setView(next) {
            if (disposed) return;
            const old = view; view = { ...next };
            if (!view.visible) { paintJob?.abort(); revealJob?.abort(); frames.clear(); drawnFrame = null; interaction?.finishGesture(); interaction?.finishComposition(); }
            publish();
            if (view.visible && (!old.visible || view.theme !== old.theme || view.sheetId !== old.sheetId)) requestPaint();
            layers.invalidate('board-view');
        },
        focusNode(id) {
            if (disposed || !options.session.doc.nodes.has(id as NodeId)) return;
            runtime.selection.replace([id as NodeId]); reveal(new Set([id as NodeId]));
        },
        bindInteractions(ports) {
            if (disposed) throw new Error('Board view is disposed');
            interaction?.finishGesture(); interaction?.finishComposition(); interaction = ports;
            if (drawnFrame) ports.presented?.(drawnFrame.sceneRevision, drawnFrame.token);
            return () => { if (interaction === ports) { ports.finishGesture(); ports.finishComposition(); interaction = null; } };
        },
        dispose,
    };
};
