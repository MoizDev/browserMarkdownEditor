import { useCallback, useEffect, useRef } from 'react';
import { pagePresentation, type Rect, type ViewState } from '../platform/render';
import type { OpenTiledDocument, PdfTiledDocumentSession } from '../pdf/session/documentSession';
import { mirrorTextFromReply, PdfTextMirror } from '../pdf/overlay/textMirror';
import type { MirrorPageText, MirrorSelection } from '../pdf/overlay/textMirror';

interface MirrorOptions {
    host: HTMLElement | null;
    visible: boolean;
    fileName: string;
    document: OpenTiledDocument;
    session: PdfTiledDocumentSession;
    pageRects: readonly Readonly<Rect>[];
    focusPage: (page: number) => void;
    selectionChanged: (selection: MirrorSelection) => void;
    openTextView: () => void;
    onError: (error: unknown) => void;
}
interface MirrorController {
    updateView: (view: ViewState) => void;
    setSelection: (selection: MirrorSelection) => boolean;
}

/** A view owns only its window; the pool and canonical selection remain session-owned. */
export function usePdfTextMirror(options: MirrorOptions): MirrorController {
    const latest = useRef(options);
    useEffect(() => { latest.current = options; });
    const controller = useRef<MirrorController | null>(null);
    const { host, visible, fileName, document: pdf, session, pageRects } = options;
    useEffect(() => {
        if (!host || !visible) return;
        const tasks = new Map<number, { controller: AbortController; request: Promise<unknown> }>(), pages = new Map<number, MirrorPageText>();
        const failed = new Set<number>();
        let alive = true, windowPages = new Set<number>(), announced = -1;
        const pageAtY = (y: number) => {
            let lo = 0, hi = pageRects.length;
            while (lo < hi) {
                const mid = (lo + hi) >>> 1;
                if (pageRects[mid].y <= y) lo = mid + 1;
                else hi = mid;
            }
            return Math.max(0, Math.min(pageRects.length - 1, lo - 1));
        };
        const mirror = new PdfTextMirror({ fileName, pageCount: pageRects.length,
            pageBox: page => pageRects[page],
            focusPage: page => {
                failed.delete(page);
                loadWindow(page, page, page);
                latest.current.focusPage(page);
            },
            selectionChanged: selection => latest.current.selectionChanged(selection),
            openTextView: () => latest.current.openTextView(),
        });
        mirror.element.style.transformOrigin = '0 0';
        host.append(mirror.element);

        function loadWindow(first: number, last: number, priorityPage?: number): void {
            const wanted = new Set<number>();
            for (let page = Math.max(0, first - 1); page <= Math.min(pageRects.length - 1, last + 1); page++) wanted.add(page);
            windowPages = wanted;
            for (const [page, task] of tasks) if (!wanted.has(page)) { task.controller.abort(); tasks.delete(page); }
            for (const page of pages.keys()) if (!wanted.has(page)) pages.delete(page);
            mirror.setWindow(pages);
            for (const page of wanted) {
                if (pages.has(page) || tasks.has(page) || failed.has(page)) continue;
                const task = new AbortController();
                const request = pdf.poolDocument.text(page, 'select', { priority: page === priorityPage ? 0 : 2, signal: task.signal });
                tasks.set(page, { controller: task, request });
                void request.then(reply => {
                    if (!alive || task.signal.aborted || !session.isCurrent() || !windowPages.has(page)) return;
                    if (reply.docKey !== pdf.poolDocument.docKey || reply.page !== page || reply.schema !== 2) {
                        throw new Error('The PDF text worker returned a stale page.');
                    }
                    const text = mirrorTextFromReply(reply);
                    if (!text) throw new Error('PDF page text geometry is unavailable.');
                    pages.set(page, text);
                    mirror.setWindow(pages);
                }).catch(error => {
                    if (!alive || task.signal.aborted) return;
                    failed.add(page); latest.current.onError(error);
                }).finally(() => { if (tasks.get(page)?.controller === task) tasks.delete(page); });
            }
            if (priorityPage !== undefined) {
                const task = tasks.get(priorityPage);
                if (task) pdf.poolDocument.reprioritise(task.request, 0);
            }
        }
        controller.current = {
            updateView(view) {
                const { camera, viewport } = view;
                if (!pageRects.length || camera.z <= 0) return;
                mirror.setViewport(camera.x, camera.y, camera.z);
                const first = pageAtY(camera.y), last = pageAtY(camera.y + viewport.height / camera.z);
                for (let page = Math.max(0, first - 1); page <= Math.min(pageRects.length - 1, last + 1); page++) {
                    const rect = pageRects[page], transform = pagePresentation(rect, view).surface;
                    mirror.setPageBox(page, { ...rect,
                        x: camera.x + transform[4] / camera.z, y: camera.y + transform[5] / camera.z });
                }
                if (first !== announced) { announced = first; mirror.announcePage(first); }
                loadWindow(first, last);
            },
            setSelection(selection) { return mirror.setSelection(selection); },
        };
        return () => {
            alive = false;
            for (const task of tasks.values()) task.controller.abort();
            tasks.clear(); pages.clear();
            controller.current = null;
            mirror.destroy();
        };
    }, [host, visible, fileName, pdf, session, pageRects]);
    const updateView = useCallback((view: ViewState) => controller.current?.updateView(view), []);
    const setSelection = useCallback((selection: MirrorSelection) => controller.current?.setSelection(selection) ?? false, []);
    return { updateView, setSelection };
}
