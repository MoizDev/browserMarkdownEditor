import { centredCamera, contentBounds, fitTarget, pageStackBounds, unionRects } from '../../whiteboard/commands/contentBounds';
import type { NodeId } from '../../whiteboard/model/ids';
import type { BoardRuntime } from '../../whiteboard/host/runtime';
import type { CommandState } from './chrome/boardCommands';
import type { NativeCommandOperation } from './nativeCommandSource';
import type { NativeViewLease } from './nativeViewLease';

const yes: CommandState = Object.freeze({ enabled: true });
const no = (reason: string): CommandState => ({ enabled: false, reason });

/** Zoom-to-content measures the current Scene's exact bounds, never saved headers or a minimap bitmap. */
export function createNativeCameraOperations(options: {
    readonly runtime: BoardRuntime;
    readonly lease: NativeViewLease;
    readonly current: () => boolean;
    readonly signal: AbortSignal;
    readonly minimapVisible: () => boolean;
    readonly setMinimapVisible: (visible: boolean) => void;
}) {
    const { runtime, lease } = options, session = runtime.session;
    if (lease.runtime !== runtime) throw new Error('Camera actions need the attached board session');
    const available = (): CommandState => options.current() && lease.camera.viewport.width > 0 && lease.camera.viewport.height > 0
        ? yes : no('The board view is unavailable');
    const selection = (): CommandState => {
        const state = available(); return state.enabled && !runtime.selection.getSnapshot().selected.length ? no('Select content first') : state;
    };
    const operation = (state: () => CommandState, run: () => void | Promise<void>): NativeCommandOperation => ({ state, run });
    /** The View menu and the shortcuts share one fit (contentBounds.ts), so the two cannot diverge. */
    const fit = async (selectedOnly: boolean) => {
        const doc = session.doc, revision = doc.rev, snapshot = runtime.selection.getSnapshot(), scene = runtime.scene;
        const signal = options.signal, font = runtime.render.text.fonts.epoch;
        const check = () => {
            signal.throwIfAborted();
            if (!options.current() || session.doc !== doc || doc.rev !== revision || runtime.scene !== scene ||
                !scene?.ready || scene.revision !== revision || runtime.render.text.fonts.epoch !== font ||
                runtime.selection.getSnapshot() !== snapshot) throw new DOMException('Board view changed', 'AbortError');
        };
        check();
        const paper = !selectedOnly && doc.kind !== 'whiteboard';
        const roots: NodeId[] = selectedOnly ? [...snapshot.selected] : (doc.children.get(snapshot.sheet) ?? []).map(child => child.id);
        const content = await contentBounds(runtime, roots, { signal, fence: check, cooperate: () => new Promise<void>(resolve => setTimeout(resolve, 0)) });
        check();
        const bounds = unionRects(paper ? pageStackBounds(doc) : null, content), view = lease.camera.viewport;
        if (!bounds) throw new Error('There is no measurable content to fit');
        if (view.width <= 0 || view.height <= 0) throw new Error('The board view has no size');
        // Selection at any zoom but 1 toggles to natural 1:1, as the shortcut does (F-CAM-007).
        const toNatural = selectedOnly && Math.abs(lease.camera.camera.z - 1) > .001;
        const plan = fitTarget(doc, view, bounds, { paper, natural: !paper && toNatural });
        lease.camera.setCamera(centredCamera(bounds, lease.camera.clampZoom(plan.z), view, plan.edges));
        lease.changed();
    };
    return {
        zoomAtCursor(direction: 1 | -1): boolean {
            const point = lease.editing?.pointerSurface();
            if (!point || !available().enabled) return false;
            lease.zoomStep(direction, point); return true;
        },
        zoomIn: operation(available, () => lease.zoomStep(1)),
        zoomOut: operation(available, () => lease.zoomStep(-1)),
        // Zoom to 100% says nothing at 100%, and fit says nothing about an empty sheet (tldraw's enablement, actions.tsx:1562-1577).
        zoomTo100: operation(() => {
            const state = available();
            return state.enabled && Math.abs(lease.camera.camera.z - 1) <= 1e-3 ? no('The view is already at 100%') : state;
        }, () => lease.resetZoom()),
        zoomToFit: operation(() => {
            const state = available(), doc = session.doc;
            return state.enabled && doc.kind === 'whiteboard' && !doc.bySheet.get(runtime.selection.getSnapshot().sheet)?.size
                ? no('There is no content to fit') : state;
        }, () => fit(false)),
        zoomToSelection: operation(selection, () => fit(true)),
        toggleMinimap: operation(() => session.doc.kind === 'whiteboard' ? available() : no('Minimap is available on drawings'),
            () => options.setMinimapVisible(!options.minimapVisible())),
    };
}
