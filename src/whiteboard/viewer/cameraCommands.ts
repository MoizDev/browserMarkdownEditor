import type { CameraController, Point } from '../../platform/render/camera';
import { acquireBoardGeometryScope } from '../commands/geometryScope';
import type { BoardRuntime } from '../host/runtime';
import { boardCameraInsets, resetBoardZoom, stepBoardZoom } from '../input/cameraZoom';
import type { NodeId } from '../model/ids';
import { boardPageStack } from '../model/pages';

export interface BoardCameraCommandsOptions {
    readonly runtime: BoardRuntime;
    readonly camera: CameraController;
    readonly surface: HTMLElement;
    current(): boolean;
    changed(): void;
    error(error: unknown): void;
    cooperate?(): Promise<void>;
}
interface Bounds { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

/** Commands share the pane camera and its paper constraint. They never change
 * document history; asynchronous fit owns a revision/selection/camera fence. */
export function createBoardCameraCommands(options: BoardCameraCommandsOptions) {
    const { runtime, camera, surface } = options, session = runtime.session, doc = session.doc, owner = session.owner;
    const cooperate = options.cooperate ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
    let disposed = false, serial = 0, pending: AbortController | undefined, cursor: Point | null = null;
    const current = () => !disposed && options.current() && runtime.session === session && session.owner === owner && session.doc === doc;
    const cancel = () => { serial++; pending?.abort(); pending = undefined; };
    const insets = () => boardCameraInsets(doc);
    const viewport = () => camera.viewport;
    const moved = (event: PointerEvent) => {
        if (!current()) return;
        const rect = surface.getBoundingClientRect(), view = viewport();
        if (!(rect.width > 0 && rect.height > 0) || !(view.width > 0 && view.height > 0)) { cursor = null; return; }
        const x = (event.clientX - rect.left) * view.width / rect.width, y = (event.clientY - rect.top) * view.height / rect.height;
        cursor = Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
    };
    const left = () => { cursor = null; };
    surface.addEventListener('pointermove', moved, { passive: true });
    surface.addEventListener('pointerleave', left, { passive: true });
    const centre = (): Point => ({ x: viewport().width / 2, y: viewport().height / 2 });
    const notify = () => { if (current()) options.changed(); };
    const zoom = (value: number, anchor?: Point) => {
        if (!current() || !Number.isFinite(value) || value <= 0 || viewport().width <= 0 || viewport().height <= 0) return;
        camera.zoomTo(value, anchor); notify();
    };
    const stepped = (direction: -1 | 1, atCursor: boolean) => {
        zoom(stepBoardZoom(doc, camera, direction), atCursor ? cursor ?? centre() : centre());
    };
    const reset = () => { zoom(resetBoardZoom(doc, camera), centre()); };
    const setCentered = (bounds: Bounds, z: number, area: Readonly<{ left: number; right: number; top: number; bottom: number }>) => {
        if (!current() || ![bounds.x, bounds.y, bounds.width, bounds.height, z].every(Number.isFinite) || bounds.width < 0 || bounds.height < 0 || z <= 0) return;
        const clamped = camera.clampZoom(z), width = viewport().width, height = viewport().height;
        const sx = (area.left + width - area.right) / 2, sy = (area.top + height - area.bottom) / 2;
        camera.setCamera({ x: bounds.x + bounds.width / 2 - sx / clamped, y: bounds.y + bounds.height / 2 - sy / clamped, z: clamped });
        notify();
    };
    const fitBounds = (bounds: Bounds, paper: boolean) => {
        const view = viewport(); if (!(view.width > 0 && view.height > 0)) return;
        const edges = paper ? insets() : { left: Math.min(64, view.width * .14), right: Math.min(64, view.width * .14),
            top: Math.min(64, view.height * .14), bottom: Math.min(64, view.height * .14) };
        const width = Math.max(1, view.width - edges.left - edges.right), height = Math.max(1, view.height - edges.top - edges.bottom);
        const zx = bounds.width > 0 ? width / bounds.width : Infinity, zy = bounds.height > 0 ? height / bounds.height : Infinity;
        const target = Math.min(zx, zy);
        setCentered(bounds, Number.isFinite(target) && target > 0 ? target : 1, edges);
    };
    const sheetBounds = (): Bounds | null => {
        const stack = boardPageStack(doc.host);
        if (!stack?.rects.length) return null;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const page of stack.rects) {
            x0 = Math.min(x0, page.x); y0 = Math.min(y0, page.y);
            x1 = Math.max(x1, page.x + page.width); y1 = Math.max(y1, page.y + page.height);
        }
        return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    };
    const fit = (selectionOnly: boolean) => {
        cancel(); if (!current()) return;
        const state = runtime.selection.getSnapshot();
        if (selectionOnly && !state.selected.length) return;
        const paper = !selectionOnly && doc.kind !== 'whiteboard';
        if (paper) { const bounds = sheetBounds(); if (bounds) fitBounds(bounds, true); return; }
        const controller = new AbortController(); pending = controller;
        const turn = serial, revision = doc.rev, first = camera.camera, starting = { x: first.x, y: first.y, z: first.z }, view = viewport();
        const dimensions = { width: view.width, height: view.height, dpr: view.dpr };
        const active = () => current() && pending === controller && !controller.signal.aborted && serial === turn && doc.rev === revision
            && runtime.selection.getSnapshot() === state && camera.camera.x === starting.x && camera.camera.y === starting.y && camera.camera.z === starting.z
            && viewport().width === dimensions.width && viewport().height === dimensions.height && viewport().dpr === dimensions.dpr;
        void (async () => {
            const roots: NodeId[] = [];
            if (selectionOnly) {
                for (let i = 0; i < state.selected.length; i++) {
                    if (!active()) return;
                    roots.push(state.selected[i]);
                    if ((i & 255) === 255) { await cooperate(); if (!active()) return; }
                }
            }
            else {
                const children = doc.children.get(state.sheet) ?? [];
                for (let i = 0; i < children.length; i++) {
                    if (!active()) return;
                    roots.push(children[i].id);
                    if ((i & 255) === 255) { await cooperate(); if (!active()) return; }
                }
            }
            if (!roots.length || !active()) return;
            const scope = await acquireBoardGeometryScope(runtime, roots, { signal: controller.signal, current: active, cooperate });
            try {
                let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
                for (let i = 0; i < roots.length; i++) {
                    if (!active()) return;
                    const b = scope.logicalBounds(roots[i]);
                    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height);
                    if ((i & 255) === 255) { await cooperate(); if (!active()) return; }
                }
                if (!active()) return;
                const bounds = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
                if (selectionOnly && Math.abs(starting.z - 1) > .001) setCentered(bounds, 1, { left: 0, right: 0, top: 0, bottom: 0 });
                else fitBounds(bounds, false);
            } finally { scope.release(); }
        })().catch(error => { if (active()) options.error(error); }).finally(() => { if (pending === controller) pending = undefined; });
    };
    const run = (id: string): boolean => {
        if (!current()) return false;
        switch (id) {
            case 'camera.zoomIn': cancel(); stepped(1, false); return true;
            case 'camera.zoomOut': cancel(); stepped(-1, false); return true;
            case 'camera.zoomInCursor': cancel(); stepped(1, true); return true;
            case 'camera.zoomOutCursor': cancel(); stepped(-1, true); return true;
            case 'camera.reset': cancel(); reset(); return true;
            case 'camera.fit': fit(false); return true;
            case 'camera.selection': if (!runtime.selection.getSnapshot().selected.length) return false; fit(true); return true;
            default: return false;
        }
    };
    return { run, cancel, dispose() {
        if (disposed) return; disposed = true; cancel(); cursor = null;
        surface.removeEventListener('pointermove', moved); surface.removeEventListener('pointerleave', left);
    } };
}
