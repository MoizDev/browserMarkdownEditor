import { CameraController, cameraForPagedPosition, fitWidthZ, freeConstraint, pagedConstraint, pagedPosition } from '../../platform/render/camera';
import type { CameraAnchor, ViewportInsets, ZoomLimits } from '../../platform/render/camera';
import type { Viewport } from '../../platform/types';
import { flushCanvasViewPositions, readCanvasViewPos, readNativeDrawingViewPos, writeCanvasViewPos, writeNativeDrawingViewPos } from '../../utils/canvasViewState';
import { flushPdfViewPositions, readPdfViewPos, writePdfViewPos } from '../../utils/pdfViewState';
import { subscribeDocumentViewRetarget } from '../../utils/documentViewRetarget';
import { boardPageStack } from '../model/pages';
import type { BoardRuntime } from './runtime';

/** One controller per view lease; input calls changed() after mutating this same camera. */
export function createBoardViewCamera(options: {
    runtime: BoardRuntime;
    currentPath(): string | undefined;
    limits: ZoomLimits;
    insets: ViewportInsets;
    initialViewport: Viewport;
    invalidate(): void;
    onError(error: unknown): void;
    mapLegacyPage?(id: string): string | undefined;
}) {
    const { runtime, limits, insets } = options;
    let ports: Pick<typeof options, 'currentPath' | 'invalidate' | 'onError'> | null = options;
    const doc = runtime.session.doc;
    let stack = boardPageStack(doc.host);
    if (doc.kind !== 'whiteboard' && !stack) throw new Error('Paged canvas layout is unavailable');
    const path = ports.currentPath();
    const drawing = doc.kind === 'whiteboard' && path ? readNativeDrawingViewPos(path, id => {
        const mapped = options.mapLegacyPage?.(id);
        return mapped && [...doc.sheets.values()].some(sheet => sheet.id === mapped) ? mapped : undefined;
    }) : undefined;
    const sheet = drawing && [...doc.sheets.values()].find(value => value.id === drawing.pageId);
    if (sheet) runtime.selection.setSheet(sheet.id);
    const remembered = doc.kind === 'notebook' && path ? readCanvasViewPos(path) : undefined;
    const pdfPosition = doc.kind === 'pdf-ink' && path ? readPdfViewPos(path) : undefined;
    let pending = remembered?.kind === 'notebook' ? { page: remembered.page, offset: remembered.offset, zoom: remembered.zoom ?? 1 }
        : pdfPosition ? { page: pdfPosition.page, offset: pdfPosition.offset, zoom: pdfPosition.zoom ?? 1 }
        : doc.kind !== 'whiteboard' ? { page: 0, offset: 0, zoom: 1 } : undefined;
    const initialCamera = drawing && sheet ? { x: drawing.x, y: drawing.y, z: drawing.z } : { x: 0, y: 0, z: 1 };
    const camera = new CameraController(initialCamera, options.initialViewport,
        stack ? pagedConstraint(stack, limits, insets) : freeConstraint(limits));
    // The default top-left needs the same re-apply: without it every drawing with no remembered
    // position opened shifted by half a pane (a legacy board's content sat in the bottom-right).
    let pendingDrawing = drawing && sheet || doc.kind === 'whiteboard' ? initialCamera : undefined;
    let timer: ReturnType<typeof setTimeout> | undefined, dirty = false, disposed = false;
    const restore = () => {
        // The first 0→measured resize preserves the old viewport's centre.
        // Reapply the stored top-left afterwards, or reopening shifts by half a pane.
        if (pendingDrawing && camera.viewport.width > 0 && camera.viewport.height > 0) {
            camera.setCamera(pendingDrawing); pendingDrawing = undefined;
        }
        if (!pending || !stack) return;
        const next = cameraForPagedPosition(pending, camera.viewport, stack, insets, limits);
        if (!next) return;
        camera.setCamera(next);
        pending = undefined;
    };
    restore();
    const flush = () => {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        if (dirty) {
            dirty = false;
            if (doc.kind === 'pdf-ink') flushPdfViewPositions();
            else flushCanvasViewPositions();
        }
    };
    const changed = () => {
        if (disposed) return;
        try {
            const currentPath = ports?.currentPath();
            if (currentPath && !pending && !pendingDrawing) {
                if (doc.kind === 'whiteboard') {
                    const selected = runtime.selection.getSnapshot().sheet;
                    if (doc.sheets.has(selected)) writeNativeDrawingViewPos(currentPath,
                        { kind: 'drawing', v: 2, pageId: selected, ...camera.camera }, false);
                    else return;
                } else if (stack) {
                    const position = pagedPosition(camera.camera, camera.viewport, stack, insets);
                    if (!position) return;
                    if (doc.kind === 'pdf-ink') writePdfViewPos(currentPath, position, false);
                    else writeCanvasViewPos(currentPath, { kind: 'notebook', ...position }, false);
                }
                dirty = true;
                if (timer !== undefined) clearTimeout(timer);
                timer = setTimeout(flush, 400);
            }
            ports?.invalidate();
        } catch (error) { ports?.onError(error); }
    };
    const refreshLayout = () => {
        if (disposed || doc.kind === 'whiteboard') return;
        try {
            const next = boardPageStack(doc.host);
            if (!next || next === stack) return;
            let position = pending ?? (stack ? pagedPosition(camera.camera, camera.viewport, stack, insets) ?? undefined : undefined);
            const fit = fitWidthZ(camera.viewport, next, insets);
            // Paper changes preserve absolute zoom; a dormant initial restore keeps its saved relative zoom.
            if (!pending && position && fit) position = { ...position, zoom: camera.camera.z / fit };
            stack = next;
            camera.setConstraint(pagedConstraint(next, limits, insets));
            pending = position;
            restore();
            changed();
        } catch (error) { ports?.onError(error); }
    };
    const stopSelection = runtime.selection.subscribe(changed);
    const stopDocument = runtime.session.subscribe(refreshLayout);
    const stopRetarget = subscribeDocumentViewRetarget(from => { if (ports?.currentPath() === from) flush(); });
    const onPageHide = () => flush();
    if (typeof window !== 'undefined') window.addEventListener('pagehide', onPageHide);
    return {
        camera,
        /** Rebinding transfers view callbacks; the camera and document subscriptions stay owned here. */
        bind(next: Pick<typeof options, 'currentPath' | 'invalidate' | 'onError'>) {
            if (disposed || ports) throw new Error('Camera owner is already bound or disposed');
            ports = next;
        },
        unbind() { if (!disposed) { flush(); ports = null; } },
        get viewport() { return camera.viewport; },
        changed,
        resize(viewport: Viewport, anchor?: CameraAnchor, geometryChanged = false) {
            if (disposed) return;
            camera.setViewport(viewport, anchor, geometryChanged);
            restore();
            changed();
        },
        refreshLayout,
        flush,
        dispose() {
            if (disposed) return;
            flush(); disposed = true; ports = null;
            stopSelection(); stopDocument(); stopRetarget();
            if (typeof window !== 'undefined') window.removeEventListener('pagehide', onPageHide);
        },
    };
}
