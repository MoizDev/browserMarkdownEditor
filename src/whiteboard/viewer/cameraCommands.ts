import type { CameraController, Point, ViewportInsets } from '../../platform/render/camera';
import type { Camera } from '../../platform/types';
import { getBoardPreferences } from '../../utils/boardPreferences';
import { centredCamera, contentBounds, fitEdges, fitTarget, pageStackBounds, unionRects, type ContentRect } from '../commands/contentBounds';
import type { BoardRuntime } from '../host/runtime';
import { resetBoardZoom, stepBoardZoom } from '../input/cameraZoom';
import type { NodeId } from '../model/ids';
import { yieldToHost } from '../../platform/yieldToHost';

const BACK_TO_CONTENT_MS = 220;

export interface BoardCameraCommandsOptions {
    readonly runtime: BoardRuntime;
    readonly camera: CameraController;
    readonly motion: { glideTo(target: Camera, durationMs: number): void; cancel(): void };
    readonly surface: HTMLElement;
    current(): boolean;
    changed(): void;
    error(error: unknown): void;
    cooperate?(): Promise<void>;
}

export function createBoardCameraCommands(options: BoardCameraCommandsOptions) {
    const { runtime, camera, surface } = options, session = runtime.session, doc = session.doc, owner = session.owner;
    const cooperate = options.cooperate ?? yieldToHost;
    const { motion } = options;
    let disposed = false, serial = 0, pending: AbortController | undefined, cursor: Point | null = null;
    const current = () => !disposed && options.current() && runtime.session === session && session.owner === owner && session.doc === doc;
    const cancel = () => { serial++; pending?.abort(); pending = undefined; cancelGlide(); };
    const cancelGlide = () => motion.cancel();
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
    surface.addEventListener('pointerdown', cancelGlide, { passive: true });
    surface.addEventListener('wheel', cancelGlide, { passive: true });
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
    const centreOn = (box: ContentRect, z: number, edges: ViewportInsets) => {
        if (!current() || ![box.x, box.y, box.width, box.height, z].every(Number.isFinite) || box.width < 0 || box.height < 0 || z <= 0) return;
        camera.setCamera(centredCamera(box, camera.clampZoom(z), viewport(), edges)); notify();
    };
    const fit = (selectionOnly: boolean, natural = false) => {
        cancel(); if (!current()) return;
        const state = runtime.selection.getSnapshot();
        if (selectionOnly && !state.selected.length) return;
        const paper = !selectionOnly && doc.kind !== 'whiteboard';
        const controller = new AbortController(); pending = controller;
        const turn = serial, revision = doc.rev, first = camera.camera, starting = { x: first.x, y: first.y, z: first.z }, view = viewport();
        const dimensions = { width: view.width, height: view.height, dpr: view.dpr };
        const active = () => current() && pending === controller && !controller.signal.aborted && serial === turn && doc.rev === revision
            && runtime.selection.getSnapshot() === state && camera.camera.x === starting.x && camera.camera.y === starting.y && camera.camera.z === starting.z
            && viewport().width === dimensions.width && viewport().height === dimensions.height && viewport().dpr === dimensions.dpr;
        const fence = () => { if (!active()) throw new DOMException('Board view changed', 'AbortError'); };
        void (async () => {
            const roots: NodeId[] = selectionOnly ? [...state.selected] : (doc.children.get(state.sheet) ?? []).map(child => child.id);
            const content = await contentBounds(runtime, roots, { signal: controller.signal, fence, cooperate });
            fence();
            const bounds = unionRects(paper ? pageStackBounds(doc) : null, content);
            if (!bounds) return;
            const toNatural = natural || (selectionOnly && Math.abs(starting.z - 1) > .001);
            const plan = fitTarget(doc, dimensions, bounds, { paper, natural: !paper && toNatural });
            centreOn(bounds, plan.z, plan.edges);
        })().catch(error => { if (active()) options.error(error); }).finally(() => { if (pending === controller) pending = undefined; });
    };
    const backToContent = () => {
        cancel(); if (!current()) return;
        const state = runtime.selection.getSnapshot();
        const controller = new AbortController(); pending = controller;
        const turn = serial, revision = doc.rev, first = camera.camera, starting = { x: first.x, y: first.y, z: first.z }, view = viewport();
        const active = () => current() && pending === controller && !controller.signal.aborted && serial === turn && doc.rev === revision
            && runtime.selection.getSnapshot() === state && camera.camera.x === starting.x && camera.camera.y === starting.y && camera.camera.z === starting.z
            && viewport().width === view.width && viewport().height === view.height && viewport().dpr === view.dpr;
        const fence = () => { if (!active()) throw new DOMException('Board view changed', 'AbortError'); };
        void (async () => {
            const roots: NodeId[] = state.selected.length ? [...state.selected] : (doc.children.get(state.sheet) ?? []).map(child => child.id);
            const content = await contentBounds(runtime, roots, { signal: controller.signal, fence, cooperate });
            fence();
            if (!content) return;
            const target = centredCamera(content, camera.clampZoom(Math.min(1, starting.z)), view, fitEdges(doc, view, false));
            motion.glideTo(target, BACK_TO_CONTENT_MS * getBoardPreferences().animationSpeed);
            notify();
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
            case 'camera.backToContent': backToContent(); return true;
            case 'camera.selection': if (!runtime.selection.getSnapshot().selected.length) return false; fit(true); return true;
            default: return false;
        }
    };
    return { run, cancel, dispose() {
        if (disposed) return; disposed = true; cancel(); cursor = null;
        surface.removeEventListener('pointermove', moved); surface.removeEventListener('pointerleave', left);
        surface.removeEventListener('pointerdown', cancelGlide); surface.removeEventListener('wheel', cancelGlide);
    } };
}
