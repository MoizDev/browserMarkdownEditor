import { useCallback, useLayoutEffect, useRef } from 'react';
import { copyText, CLIPBOARD_WRITE_BLOCKED } from '../utils/clipboard';
import { closeContextMenu, getContextMenu } from '../utils/contextMenu';
import { COPY_TOO_LARGE, MAX_COPY_UTF16_UNITS, normalizeForClipboard } from '../pdf/text/copy';
import { selectionContains, selectionRange } from '../pdf/text/selection';
import { PdfSelectionGestures } from '../pdf/text/selectionGestures';
import type { PdfSelectionState } from '../pdf/text/selectionState';
import type { PdfSelectionGeometryCache } from '../pdf/text/selectionCache';
import type { PdfPoolDocument } from '../pdf/pool/types';
import { hitTextPoint } from '../pdf/text/hitTest';
import { bindPdfTextCopy } from '../pdf/overlay/textCopy';
import type { PdfTextCopyBinding } from '../pdf/overlay/textCopy';
import { openPdfTextMenu } from '../pdf/overlay/textMenu';

export interface PdfTiledCopyMenuOptions {
    /** Common ancestor of the canvas and accessibility mirror. */
    element: HTMLElement | null;
    document: PdfPoolDocument;
    geometry?: PdfSelectionGeometryCache;
    selection: PdfSelectionState;
    fileName: string;
    filePath: string;
    isVisible: boolean;
    locate(x: number, y: number): { page: number; x: number; y: number } | null;
    pageSize(page: number): { width: number; height: number } | undefined;
    keyboardAnchor(): { x: number; y: number; page: number };
    searchVault(query: string): void;
    findPdf(query: string): void;
    readText(page: number): void;
    notice(message: string): void;
}

/** Copy and menu share canonical text, cancellation and the pane's selection. */
export function usePdfTiledCopyMenu(options: PdfTiledCopyMenuOptions) {
    const live = useRef(options), binding = useRef<PdfTextCopyBinding | null>(null), menuTask = useRef<AbortController | null>(null);
    useLayoutEffect(() => { live.current = options; });
    const { element, document, geometry, selection } = options;
    useLayoutEffect(() => {
        if (!element || !geometry) return;
        const copy = bindPdfTextCopy(element, {
            selection: () => selection.getSnapshot().selection,
            pageCount: () => document.info.pageCount,
            cachedText: page => geometry.cached(page)?.text,
            text: async (page, signal) => {
                const reply = await document.text(page, 'text', { priority: 1, signal });
                if (signal.aborted || document.closed || reply.docKey !== document.docKey || reply.page !== page || reply.schema !== 2)
                    throw new DOMException('PDF copy cancelled', 'AbortError');
                return reply.text;
            },
            notice: message => live.current.notice(message),
        });
        binding.current = copy;
        const unsubscribe = selection.subscribe(() => copy.cancel());
        return () => {
            menuTask.current?.abort(); menuTask.current = null;
            unsubscribe(); copy.dispose();
            if (binding.current === copy) binding.current = null;
            if (getContextMenu()?.opener === element && getContextMenu()?.label === 'PDF text') closeContextMenu();
        };
    }, [element, geometry, selection, document]);
    useLayoutEffect(() => {
        if (!options.isVisible) {
            menuTask.current?.abort(); binding.current?.cancel();
            if (getContextMenu()?.opener === element && getContextMenu()?.label === 'PDF text') closeContextMenu();
        }
    }, [options.isVisible, element]);
    const openMenu = useCallback((x: number, y: number, keyboard: boolean) => {
        const current = live.current, cache = current.geometry, root = current.element;
        if (!cache || !root || !current.isVisible || current.document.closed) return;
        menuTask.current?.abort();
        const task = new AbortController(); menuTask.current = task;
        const start = current.selection.getSnapshot();
        void (async () => {
            const anchor = keyboard ? current.keyboardAnchor() : null;
            const location = anchor ? { page: anchor.page, x: 0, y: 0 } : current.locate(x, y);
            if (!location) return;
            if (!keyboard) {
                const reply = await cache.get(location.page, 0, task.signal);
                if (task.signal.aborted || current.selection.getSnapshot() !== start || !live.current.isVisible) return;
                const size = current.pageSize(location.page);
                const point = size ? hitTextPoint({ text: reply.text, ...reply.sel, ...size }, location.page, location.x, location.y) : null;
                const selected = start.selection;
                if (point && (!selected || !selected.wholeDocument && !selectionContains(selected, point))) {
                    new PdfSelectionGestures({ selection: current.selection, cached: page => cache.cached(page) }).begin(point, 'word', false);
                }
            }
            const selected = current.selection.getSnapshot().selection;
            const key = current.selection.getSnapshot().docKey;
            let preview = '', complete = true;
            if (selected) {
                const range = selectionRange(selected), count = current.document.info.pageCount;
                const first = selected.wholeDocument ? 0 : Math.max(0, Math.min(count - 1, range.start.page));
                const last = selected.wholeDocument ? count - 1 : Math.max(first, Math.min(count - 1, range.end.page));
                for (let page = first; page <= last; page++) {
                    const cached = cache.cached(page)?.text;
                    const reply = cached === undefined ? await current.document.text(page, 'text', { priority: 1, signal: task.signal }) : undefined;
                    if (reply && (reply.docKey !== key || reply.page !== page || reply.schema !== 2)) throw new Error('The PDF text worker returned a stale page.');
                    const text = cached ?? reply!.text;
                    if (task.signal.aborted || !live.current.isVisible || current.selection.getSnapshot().selection !== selected || current.selection.getSnapshot().docKey !== key) return;
                    const from = !selected.wholeDocument && page === first ? Math.max(0, Math.min(text.length, range.start.offset)) : 0;
                    const to = !selected.wholeDocument && page === last ? Math.max(from, Math.min(text.length, range.end.offset)) : text.length;
                    const piece = (page > first ? '\n' : '') + text.slice(from, to);
                    if (preview.length + piece.length > 256) { preview += piece.slice(0, 257 - preview.length); complete = false; break; }
                    preview += piece;
                }
            }
            if (task.signal.aborted || !live.current.isVisible || current.selection.getSnapshot().selection !== selected) return;
            const page = location.page;
            openPdfTextMenu({ x: anchor?.x ?? x, y: anchor?.y ?? y, opener: root, page,
                hasSelection: !!selected, selectedText: preview, selectedTextComplete: complete,
                copy: () => binding.current?.copy(), copyQuote: () => binding.current?.copyQuote(live.current.fileName, live.current.filePath),
                searchVault: query => live.current.searchVault(query), findPdf: query => live.current.findPdf(query),
                copyPage: async index => {
                    const reply = await current.document.text(index, 'text', { priority: 1, signal: task.signal });
                    if (task.signal.aborted || !live.current.isVisible || current.document.closed || reply.docKey !== key || reply.page !== index) return;
                    const text = normalizeForClipboard(reply.text);
                    if (text.length > MAX_COPY_UTF16_UNITS) { live.current.notice(COPY_TOO_LARGE); return; }
                    if (!await copyText(text)) live.current.notice(CLIPBOARD_WRITE_BLOCKED);
                },
                selectAll: () => current.selection.selectAll(current.document.info.pageCount),
                readText: index => live.current.readText(index),
            });
        })().catch(error => { if (!task.signal.aborted) live.current.notice(error instanceof Error ? error.message : 'Could not open PDF text menu.'); });
    }, []);
    return { openMenu };
}
