import { CameraController, cameraForPagedPosition, fitWidthZ, freeConstraint, pagedConstraint, pagedPosition } from '../../platform/render/camera';
import type { CameraAnchor, ViewportInsets, ZoomLimits } from '../../platform/render/camera';
import type { Viewport } from '../../platform/types';
import { flushCanvasViewPositions, readCanvasViewPos, readNativeDrawingViewPos, writeCanvasViewPos, writeNativeDrawingViewPos } from '../../utils/canvasViewState';
import { flushPdfViewPositions, readPdfViewPos, writePdfViewPos } from '../../utils/pdfViewState';
import { subscribeDocumentViewRetarget } from '../../utils/documentViewRetarget';
import { boardPageStack } from '../model/pages';
import { centredCamera, contentBounds, fitTarget } from '../commands/contentBounds';
import type { BoardRuntime } from './runtime';
import { yieldToHost } from '../../platform/yieldToHost';

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
    const knownSheet = (id: string) => [...doc.sheets.values()].find(value => value.id === id)
        ?? [...doc.sheets.values()].find(value => value.id === options.mapLegacyPage?.(id));
    const remembered0 = drawing && knownSheet(drawing.pageId);
    // A drawing opened here for the first time has no remembered position; the view its file carries (a converted old board's
    // camera, as it was left in the old app) is honoured exactly. Neither, the content is framed once its bounds are known
    // (fitFirstView): a fixed top-left at 100% cut a converted board's strokes off at the top, or showed nothing at all.
    const saved = doc.kind === 'whiteboard' && !remembered0 ? runtime.encoder.savedView?.() : undefined;
    const savedSheet = saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) && Number.isFinite(saved.zoom) && saved.zoom > 0
        ? knownSheet(saved.sheet) : undefined;
    const sheet = remembered0 || savedSheet;
    if (sheet) runtime.selection.setSheet(sheet.id);
    const remembered = doc.kind === 'notebook' && path ? readCanvasViewPos(path) : undefined;
    const pdfPosition = doc.kind === 'pdf-ink' && path ? readPdfViewPos(path) : undefined;
    let pending = remembered?.kind === 'notebook' ? { page: remembered.page, offset: remembered.offset, zoom: remembered.zoom ?? 1 }
        : pdfPosition ? { page: pdfPosition.page, offset: pdfPosition.offset, zoom: pdfPosition.zoom ?? 1 }
        : doc.kind !== 'whiteboard' ? { page: 0, offset: 0, zoom: 1 } : undefined;
    const initialCamera = drawing && remembered0 ? { x: drawing.x, y: drawing.y, z: drawing.z }
        : saved && savedSheet ? { x: saved.x, y: saved.y, z: Math.min(limits.max, Math.max(limits.min, saved.zoom)) } : { x: 0, y: 0, z: 1 };
    const camera = new CameraController(initialCamera, options.initialViewport,
        stack ? pagedConstraint(stack, limits, insets) : freeConstraint(limits));
    // A saved view is framed only if it shows none of the sheet's content: honoured, it must never open on an empty view.
    let fitFirstView: 'always' | 'if-empty' | null = doc.kind !== 'whiteboard' || remembered0 ? null : savedSheet ? 'if-empty' : 'always';
    const fitting = new AbortController();
    // The default top-left needs the same re-apply: without it every drawing with no remembered
    // position opened shifted by half a pane (a legacy board's content sat in the bottom-right).
    let pendingDrawing = doc.kind === 'whiteboard' ? initialCamera : undefined;
    let timer: ReturnType<typeof setTimeout> | undefined, dirty = false, disposed = false;
    const restore = () => {
        // The first 0→measured resize preserves the old viewport's centre.
        // Reapply the stored top-left afterwards, or reopening shifts by half a pane.
        if (pendingDrawing && camera.viewport.width > 0 && camera.viewport.height > 0) {
            camera.setCamera(pendingDrawing); pendingDrawing = undefined;
            if (fitFirstView) { const mode = fitFirstView; fitFirstView = null; void frameContent(mode); }
        }
        if (!pending || !stack) return;
        const next = cameraForPagedPosition(pending, camera.viewport, stack, insets, limits);
        if (!next) return;
        camera.setCamera(next);
        pending = undefined;
    };
    /** Frames the current sheet's content, as Zoom to fit does but never past 100% (a small drawing is shown at its size, not
     * blown up). Only a camera choice: nothing in the document moves and nothing is written. Skipped if the person has moved the
     * view meanwhile, or the board changed under the measurement; a sheet with no content stays at the top-left. */
    async function frameContent(mode: 'always' | 'if-empty'): Promise<void> {
        const from = { ...camera.camera }, sheetId = runtime.selection.getSnapshot().sheet;
        const moved = () => camera.camera.x !== from.x || camera.camera.y !== from.y || camera.camera.z !== from.z;
        // A converted board's scene is still settling as it opens, and the measurement it cancels ("Scene geometry changed") is
        // not the person's doing: measured once, the far-off saved view of a converted board stayed empty. Measured again, a few
        // times, while nobody has moved the view and the document is the one it opened with.
        for (let attempt = 0; attempt < 6; attempt++) {
            const revision = doc.rev;
            const fence = () => {
                fitting.signal.throwIfAborted();
                if (disposed || runtime.session.doc !== doc || doc.rev !== revision || runtime.selection.getSnapshot().sheet !== sheetId || moved())
                    throw new DOMException('Board view changed', 'AbortError');
            };
            try {
                const roots = (doc.children.get(sheetId) ?? []).map(child => child.id);
                const bounds = await contentBounds(runtime, roots, { signal: fitting.signal, fence,
                    cooperate: yieldToHost });
                fence();
                const view = camera.viewport, now = camera.camera;
                if (!bounds || view.width <= 0 || view.height <= 0) return;
                const right = now.x + view.width / now.z, bottom = now.y + view.height / now.z;
                const shown = bounds.x <= right && bounds.x + bounds.width >= now.x && bounds.y <= bottom && bounds.y + bounds.height >= now.y;
                if (mode === 'if-empty' && shown) return;
                const plan = fitTarget(doc, view, bounds, { paper: false, natural: false });
                camera.setCamera(centredCamera(bounds, camera.clampZoom(Math.min(1, plan.z)), view, plan.edges));
                changed();
                return;
            } catch (error) {
                if (!(error instanceof DOMException && error.name === 'AbortError')) { ports?.onError(error); return; }
                if (fitting.signal.aborted || disposed || runtime.session.doc !== doc || runtime.selection.getSnapshot().sheet !== sheetId || moved()) return;
                await new Promise<void>(resolve => setTimeout(resolve, 100));
            }
        }
    }
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
            flush(); disposed = true; ports = null; fitting.abort();
            stopSelection(); stopDocument(); stopRetarget();
            if (typeof window !== 'undefined') window.removeEventListener('pagehide', onPageHide);
        },
    };
}
