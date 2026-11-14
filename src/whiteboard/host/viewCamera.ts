import { CameraController, cameraForPagedPosition, freeConstraint, pagedConstraint, pagedPosition } from '../../platform/render/camera';
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
    const doc = runtime.session.doc;
    let stack = boardPageStack(doc.host);
    if (doc.kind !== 'whiteboard' && !stack) throw new Error('Paged canvas layout is unavailable');
    const path = options.currentPath();
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
    let timer: ReturnType<typeof setTimeout> | undefined, dirty = false, disposed = false;
    const restore = () => {
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
            const currentPath = options.currentPath();
            if (currentPath && !pending) {
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
            options.invalidate();
        } catch (error) { options.onError(error); }
    };
    const refreshLayout = () => {
        if (disposed || doc.kind === 'whiteboard') return;
        try {
            const next = boardPageStack(doc.host);
            if (!next || next === stack) return;
            const position = pending ?? (stack ? pagedPosition(camera.camera, camera.viewport, stack, insets) ?? undefined : undefined);
            stack = next;
            camera.setConstraint(pagedConstraint(next, limits, insets));
            pending = position;
            restore();
            changed();
        } catch (error) { options.onError(error); }
    };
    const stopSelection = runtime.selection.subscribe(changed);
    const stopDocument = runtime.session.subscribe(refreshLayout);
    const stopRetarget = subscribeDocumentViewRetarget(from => { if (options.currentPath() === from) flush(); });
    const onPageHide = () => flush();
    if (typeof window !== 'undefined') window.addEventListener('pagehide', onPageHide);
    return {
        camera,
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
            flush(); disposed = true;
            stopSelection(); stopDocument(); stopRetarget();
            if (typeof window !== 'undefined') window.removeEventListener('pagehide', onPageHide);
        },
    };
}
