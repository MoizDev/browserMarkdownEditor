import type { CameraController } from '../../platform/render/camera';
import type { ScheduledFrame } from '../../platform/render/scheduler';
import type { RenderToken } from '../../platform/render/types';
import type { ViewState } from '../../platform/types';
import { acquireBoardGeometryScope } from '../commands/geometryScope';
import type { BoardRuntime } from '../host/runtime';
import { createSelectionNavigation } from '../input/selectionNavigation';
import { createSelectionReveal } from '../input/reveal';
import type { InputToken } from '../input/tool';
import type { NodeId } from '../model/ids';

export interface BoardSelectionNavigationOptions {
    readonly runtime: BoardRuntime;
    readonly camera: CameraController;
    readonly surface: HTMLElement;
    readonly token: RenderToken;
    readonly inputToken: InputToken;
    readonly current: () => boolean;
    readonly changed: () => void;
    readonly error: (error: unknown) => void;
    readonly cooperate?: () => Promise<void>;
}

export function createBoardSelectionNavigation(options: BoardSelectionNavigationOptions) {
    const { runtime } = options, session = runtime.session, doc = session.doc, owner = session.owner;
    let disposed = false, view: ViewState | null = null, geometry: AbortController | undefined;
    const active = () => !disposed && options.current() && session.owner === owner && session.doc === doc;
    const reveal = createSelectionReveal({
        camera: options.camera,
        current(identity) {
            const a = identity.token, b = options.inputToken;
            return active() && !!view && a.vaultEpoch === b.vaultEpoch && a.tabId === b.tabId
                && a.sessionGeneration === b.sessionGeneration && a.viewGeneration === b.viewGeneration
                && runtime.selection.getSnapshot().active === identity.selection;
        },
        presented() {
            const shown = view!;
            return { camera: shown.camera, usable: { x: 0, y: 0, width: shown.viewport.width, height: shown.viewport.height },
                direction: getComputedStyle(options.surface).direction === 'rtl' ? 'rtl' : 'ltr' };
        },
        async bounds(identity) {
            const id = identity.selection as NodeId | null;
            if (!id || !active()) return null;
            geometry?.abort(); const controller = new AbortController(); geometry = controller;
            const selection = runtime.selection.getSnapshot(), revision = doc.rev, font = runtime.render.text.fonts.epoch;
            const current = () => !controller.signal.aborted && active() && doc.rev === revision && runtime.render.text.fonts.epoch === font
                && runtime.selection.getSnapshot() === selection && selection.active === id;
            const scope = await acquireBoardGeometryScope(runtime, [id], { signal: controller.signal, current, cooperate: options.cooperate });
            try { return current() ? scope.logicalBounds(id) : null; }
            finally { scope.release(); if (geometry === controller) geometry = undefined; }
        },
        changed: options.changed,
        error: options.error,
    });
    const request = (id: NodeId | null) => {
        geometry?.abort(); geometry = undefined;
        reveal.request({ token: options.inputToken, selection: id });
    };
    const navigation = createSelectionNavigation({ runtime, current: active, reveal: request, error: options.error, cooperate: options.cooperate });
    const stopSelection = runtime.selection.subscribe(() => { geometry?.abort(); geometry = undefined; reveal.cancel(); });
    return {
        navigation,
        reveal: request,
        present(frame: ScheduledFrame) {
            const a = frame.token, b = options.token;
            if (!active() || a.vaultEpoch !== b.vaultEpoch || a.documentId !== b.documentId
                || a.bytesGeneration !== b.bytesGeneration || a.session !== b.session) return;
            const prior = view;
            view = { ...frame.view, camera: { ...frame.view.camera }, viewport: { ...frame.view.viewport } };
            if (!prior || prior.viewport.width !== view.viewport.width || prior.viewport.height !== view.viewport.height) reveal.refresh();
        },
        cancel() { geometry?.abort(); geometry = undefined; navigation.cancel(); reveal.cancel(); },
        dispose() {
            if (disposed) return;
            disposed = true; geometry?.abort(); geometry = undefined; stopSelection(); navigation.dispose(); reveal.dispose(); view = null;
        },
    };
}
