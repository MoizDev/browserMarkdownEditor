import type { Rect } from '../../platform/types';
import { boardPageStack } from '../../whiteboard/model/pages';
import { BoundsQuality } from '../../whiteboard/scene/bounds';
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
    const fit = async (selectedOnly: boolean) => {
        const scene = runtime.scene, doc = session.doc, revision = doc.rev, snapshot = runtime.selection.getSnapshot();
        const signal = options.signal, font = runtime.render.text.fonts.epoch;
        const check = () => {
            signal.throwIfAborted();
            if (!options.current() || session.doc !== doc || doc.rev !== revision || runtime.scene !== scene ||
                !scene?.ready || scene.revision !== revision || runtime.render.text.fonts.epoch !== font ||
                runtime.selection.getSnapshot() !== snapshot) throw new DOMException('Board view changed', 'AbortError');
        };
        check();
        let bounds: Rect | null = null;
        const union = (box: Rect) => {
            if (![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width < 0 || box.height < 0) throw new Error('Invalid board bounds');
            if (!bounds) { bounds = { ...box }; return; }
            const x = Math.min(bounds.x, box.x), y = Math.min(bounds.y, box.y);
            bounds = { x, y, width: Math.max(bounds.x + bounds.width, box.x + box.width) - x,
                height: Math.max(bounds.y + bounds.height, box.y + box.height) - y };
        };
        const pages = !selectedOnly ? boardPageStack(doc.host) : null;
        if (pages?.rects.length) for (const page of pages.rects) union(page);
        const ids = selectedOnly ? snapshot.selected : [...(doc.bySheet.get(snapshot.sheet) ?? [])];
        for (const id of ids) {
            check(); const result = await scene!.ensureExactBounds(id, signal); check();
            if (!result || result.revision !== revision || result.quality !== BoundsQuality.Exact || !result.selectable) throw new Error('Exact board bounds are unavailable');
            const b = result.selectable; union({ x: b[0], y: b[1], width: b[2] - b[0], height: b[3] - b[1] });
        }
        check();
        const box = bounds as Rect | null, viewport = lease.camera.viewport;
        if (!box || box.width <= 0 || box.height <= 0 || viewport.width <= 0 || viewport.height <= 0) throw new Error('There is no measurable content to fit');
        // Clearance per side is 64 CSS px on the 1016px canvas camera.md measured, and at most 14% of the axis on a narrow view.
        const padX = Math.min(64, 0.14 * viewport.width), padY = Math.min(64, 0.14 * viewport.height);
        const width = Math.max(1, viewport.width - 2 * padX), height = Math.max(1, viewport.height - 2 * padY);
        const z = lease.camera.clampZoom(Math.min(width / box.width, height / box.height));
        lease.camera.setCamera({ x: box.x + box.width / 2 - viewport.width / (2 * z),
            y: box.y + box.height / 2 - viewport.height / (2 * z), z });
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
        zoomTo100: operation(available, () => lease.zoomBy(1 / lease.getNavigationSnapshot().zoom)),
        zoomToFit: operation(available, () => fit(false)),
        zoomToSelection: operation(selection, () => fit(true)),
        toggleMinimap: operation(() => session.doc.kind === 'whiteboard' ? available() : no('Minimap is available on drawings'),
            () => options.setMinimapVisible(!options.minimapVisible())),
    };
}
