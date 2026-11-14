import { useCallback, useLayoutEffect, useRef } from 'react';
import { CLIPBOARD_WRITE_BLOCKED } from '../utils/clipboard';
import { getSessionIdentity } from '../utils/sessionIdentity';
import { getPdfFontEpoch, subscribePdfFontEpoch } from '../pdf/fonts/profiles';
import { closeContextMenu, getContextMenu } from '../utils/contextMenu';
import { cachedSelectionText, COPY_TOO_LARGE, MAX_COPY_UTF16_UNITS, normalizeForClipboard } from '../pdf/text/copy';
import { selectionContains, selectionRange } from '../pdf/text/selection';
import { PdfSelectionGestures } from '../pdf/text/selectionGestures';
import type { PdfSelectionState } from '../pdf/text/selectionState';
import type { PdfSelectionGeometryCache } from '../pdf/text/selectionCache';
import type { PdfPoolDocument } from '../pdf/pool/types';
import { pdfPoolTextSource } from '../pdf/text/poolSource';
import { hitTextPoint } from '../pdf/text/hitTest';
import { beginPdfCopy, bindPdfTextCopy } from '../pdf/overlay/textCopy';
import type { PdfTextCopyBinding } from '../pdf/overlay/textCopy';
import { openPdfTextMenu } from '../pdf/overlay/textMenu';
import type { PdfTextReader } from '../utils/pdfReadingText';

// P5's resident find index may expose canonical text without a worker trip.
function peekText(reader: PdfTextReader | undefined, page: number): string | undefined {
    return reader?.findEngine.peekPageText(page)?.text;
}

export interface PdfTiledCopyMenuOptions {
    /** Common ancestor of the canvas and accessibility mirror. */
    element: HTMLElement | null;
    document: PdfPoolDocument;
    geometry?: PdfSelectionGeometryCache;
    reader?: PdfTextReader;
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
    const staleGeometry = useRef(new WeakSet<PdfSelectionGeometryCache>()), staleReaders = useRef(new WeakSet<PdfTextReader>());
    useLayoutEffect(() => { live.current = options; });
    const { element, document, geometry, selection } = options;
    useLayoutEffect(() => {
        const key = document.docKey;
        let epoch = getPdfFontEpoch(key);
        return subscribePdfFontEpoch(key, () => {
            const next = getPdfFontEpoch(key);
            if (next === epoch) return;
            epoch = next;
            const current = live.current;
            if (current.document !== document || current.selection !== selection) return;
            if (current.geometry) staleGeometry.current.add(current.geometry);
            if (current.reader) staleReaders.current.add(current.reader);
            menuTask.current?.abort(); menuTask.current = null;
            binding.current?.cancel();
            if (selection.getSnapshot().docKey === key) selection.clear();
            const nativeSelection = window.getSelection();
            if (element && nativeSelection && (element.contains(nativeSelection.anchorNode) || element.contains(nativeSelection.focusNode))) {
                nativeSelection.removeAllRanges();
            }
            if (getContextMenu()?.opener === element && getContextMenu()?.label === 'PDF text') closeContextMenu();
        });
    }, [document, selection, element]);
    useLayoutEffect(() => {
        if (!element || !geometry) return;
        const source = pdfPoolTextSource(document), token = { ...document.token }, key = document.docKey;
        const isCurrent = () => {
            const current = live.current, identity = getSessionIdentity(token.documentId);
            return current.isVisible && current.element === element && current.document === document && current.selection === selection &&
                current.geometry === geometry && !staleGeometry.current.has(geometry) && !document.closed && document.docKey === key && document.token.vaultEpoch === token.vaultEpoch &&
                document.token.documentId === token.documentId && document.token.bytesGeneration === token.bytesGeneration &&
                document.token.session === token.session && identity?.serial === token.session && identity.bytesGeneration === token.bytesGeneration;
        };
        const copy = bindPdfTextCopy(element, {
            selection: () => selection.getSnapshot().selection,
            pageCount: () => document.info.pageCount,
            cachedText: page => (staleGeometry.current.has(geometry) ? undefined : geometry.cached(page)?.text) ??
                (live.current.reader && !staleReaders.current.has(live.current.reader) ? peekText(live.current.reader, page) : undefined),
            text: async (page, signal) => (await source.text(page, 1, signal)).text,
            isCurrent, fontEpoch: () => getPdfFontEpoch(key),
            notice: message => { if (isCurrent()) live.current.notice(message); },
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
        if (!cache || staleGeometry.current.has(cache) || !root || !current.isVisible || current.document.closed) return;
        const doc = current.document, token = { ...doc.token }, fontEpoch = getPdfFontEpoch(doc.docKey);
        const valid = () => {
            const now = live.current, identity = getSessionIdentity(token.documentId);
            return !doc.closed && now.isVisible && now.element === root && now.geometry === cache && now.document === doc &&
                now.selection === current.selection && !staleGeometry.current.has(cache) && getPdfFontEpoch(doc.docKey) === fontEpoch &&
                doc.token.vaultEpoch === token.vaultEpoch && doc.token.documentId === token.documentId &&
                doc.token.bytesGeneration === token.bytesGeneration && doc.token.session === token.session &&
                identity?.serial === token.session && identity.bytesGeneration === token.bytesGeneration;
        };
        if (!valid()) return;
        menuTask.current?.abort();
        const task = new AbortController(); menuTask.current = task;
        const source = pdfPoolTextSource(current.document);
        const start = current.selection.getSnapshot();
        if (start.docKey !== current.document.docKey) return;
        void (async () => {
            const anchor = keyboard ? current.keyboardAnchor() : null;
            const location = anchor ? { page: anchor.page, x: 0, y: 0 } : current.locate(x, y);
            if (!location) return;
            if (!keyboard) {
                const reply = await cache.get(location.page, 0, task.signal);
                if (task.signal.aborted || !valid() || current.selection.getSnapshot() !== start) return;
                const size = current.pageSize(location.page);
                const point = size ? hitTextPoint({ text: reply.text, ...reply.sel, ...size }, location.page, location.x, location.y) : null;
                const selected = start.selection;
                if (point && (!selected || !selected.wholeDocument && !selectionContains(selected, point))) {
                    new PdfSelectionGestures({ selection: current.selection, cached: page => cache.cached(page) }).begin(point, 'word', false);
                }
            }
            const selectedSnapshot = current.selection.getSnapshot(), selected = selectedSnapshot.selection;
            const key = selectedSnapshot.docKey;
            const validSelection = () => !task.signal.aborted && valid() && current.selection.getSnapshot() === selectedSnapshot;
            let preview = '', complete = true;
            if (selected) {
                const range = selectionRange(selected), count = current.document.info.pageCount;
                const first = selected.wholeDocument ? 0 : Math.max(0, Math.min(count - 1, range.start.page));
                const last = selected.wholeDocument ? count - 1 : Math.max(first, Math.min(count - 1, range.end.page));
                let previousEndsInLF = false;
                for (let page = first; page <= last; page++) {
                    const reader = live.current.reader;
                    const cached = cache.cached(page)?.text ?? (reader && !staleReaders.current.has(reader) ? peekText(reader, page) : undefined);
                    const text = cached ?? (await source.text(page, 1, task.signal)).text;
                    if (!validSelection()) return;
                    const from = !selected.wholeDocument && page === first ? Math.max(0, Math.min(text.length, range.start.offset)) : 0;
                    const to = !selected.wholeDocument && page === last ? Math.max(from, Math.min(text.length, range.end.offset)) : text.length;
                    const part = text.slice(from, to), piece = (page > first && !previousEndsInLF ? '\n' : '') + part;
                    previousEndsInLF = part.endsWith('\n');
                    if (preview.length + piece.length > 256) { preview += piece.slice(0, 257 - preview.length); complete = false; break; }
                    preview += piece;
                }
            }
            if (!validSelection()) return;
            const page = location.page;
            openPdfTextMenu({ x: anchor?.x ?? x, y: anchor?.y ?? y, opener: root, page,
                hasSelection: !!selected, selectedText: preview, selectedTextComplete: complete,
                copy: () => { if (validSelection()) return binding.current?.copy(); },
                copyQuote: () => { if (validSelection()) return binding.current?.copyQuote(live.current.fileName, live.current.filePath); },
                searchVault: query => { if (validSelection()) live.current.searchVault(query); },
                findPdf: query => { if (validSelection()) live.current.findPdf(query); },
                copyPage: async index => {
                    if (!validSelection()) return;
                    const ticket = beginPdfCopy();
                    try {
                        const reply = await source.text(index, 1, task.signal);
                        if (!validSelection() || current.document.docKey !== key) return;
                        const text = normalizeForClipboard(reply.text);
                        if (text.length > MAX_COPY_UTF16_UNITS) { live.current.notice(COPY_TOO_LARGE); return; }
                        const copied = await ticket.write(text, validSelection);
                        if (validSelection() && copied === false) live.current.notice(CLIPBOARD_WRITE_BLOCKED);
                    } catch (error) {
                        if (validSelection()) live.current.notice(error instanceof Error ? error.message : 'Could not copy PDF page text.');
                    }
                },
                selectAll: () => { if (validSelection()) current.selection.selectAll(current.document.info.pageCount); },
                readText: index => { if (validSelection()) live.current.readText(index); },
            });
        })().catch(error => { if (!task.signal.aborted && valid()) live.current.notice(error instanceof Error ? error.message : 'Could not open PDF text menu.'); });
    }, []);
    const cancelCopy = useCallback(() => binding.current?.cancel() ?? false, []);
    const selectedText = useCallback(() => {
        const current = live.current, selection = current.selection.getSnapshot().selection;
        const token = current.document.token, identity = getSessionIdentity(token.documentId);
        if (!selection || !current.geometry || staleGeometry.current.has(current.geometry) || !current.isVisible || current.document.closed ||
            selection.docKey !== current.document.docKey || identity?.serial !== token.session || identity.bytesGeneration !== token.bytesGeneration) {
            return { text: '', incomplete: false };
        }
        const count = current.document.info.pageCount, range = selectionRange(selection);
        const first = selection.wholeDocument ? 0 : Math.max(0, Math.min(count - 1, range.start.page));
        const last = selection.wholeDocument ? count - 1 : Math.max(first, Math.min(count - 1, range.end.page));
        const pages = new Map(current.geometry.cachedTextPages());
        let available = 0;
        for (let page = first; page <= last && available < 20_000; page++) {
            const text = pages.get(page) ?? (current.reader && !staleReaders.current.has(current.reader) ? peekText(current.reader, page) : undefined);
            if (text !== undefined) {
                pages.set(page, text);
                const from = !selection.wholeDocument && page === first ? Math.max(0, Math.min(text.length, range.start.offset)) : 0;
                const to = !selection.wholeDocument && page === last ? Math.max(from, Math.min(text.length, range.end.offset)) : text.length;
                available += to - from;
            }
        }
        return cachedSelectionText(selection, count, pages);
    }, []);
    return { openMenu, cancelCopy, selectedText };
}
