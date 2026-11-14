import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { bindPdfTextInput } from '../pdf/overlay/textInput';
import type { PdfTextInputBinding } from '../pdf/overlay/textInput';
import { bindPdfTextKeyboard } from '../pdf/overlay/textKeyboard';
import { PdfTextVisibility } from '../pdf/overlay/textVisibility';
import { hitTextPoint } from '../pdf/text/hitTest';
import { PdfSelectionGestures } from '../pdf/text/selectionGestures';
import type { PdfSelectionGeometryCache } from '../pdf/text/selectionCache';
import type { PdfSelectionState } from '../pdf/text/selectionState';

export interface PdfTiledSelectionOptions {
    element: HTMLElement | null;
    docKey: string;
    pageCount: number;
    selection: PdfSelectionState;
    geometry: PdfSelectionGeometryCache;
    isVisible: boolean;
    isFocused: boolean;
    /** Convert client coordinates using the current camera, not a captured one. */
    locate(clientX: number, clientY: number): { page: number; x: number; y: number } | null;
    pageSize(page: number): { width: number; height: number } | undefined;
    isLink(target: EventTarget | null): boolean;
    setSelecting(active: boolean): void;
    autoScroll(x: number, y: number): void;
    touchPointer?(phase: 'down' | 'move' | 'up' | 'cancel', event: PointerEvent): void;
    contextMenu(x: number, y: number, keyboard: boolean): void;
    findOpen(): boolean;
    closeFindPreservingHit(): void;
    setReaderVisible(visible: boolean): void;
    clearMirrorPages(): void;
    releaseGpu(reason: 'hidden'): void;
    rebuildVisible(): void;
    locale?(page: number, line: number): string | undefined;
}

/** Pane-owned state is supplied by the caller and survives unmounting this
 * surface. Geometry/worker requests are always owned by this mounted pane. */
export function usePdfTiledSelection(options: PdfTiledSelectionOptions) {
    const live = useRef(options); live.current = options;
    const input = useRef<PdfTextInputBinding | null>(null);
    const visibility = useRef<PdfTextVisibility | null>(null);
    const snapshot = useSyncExternalStore(options.selection.subscribe, options.selection.getSnapshot, options.selection.getSnapshot);
    const refreshPointer = useCallback(() => input.current?.refreshPointer(), []);
    useLayoutEffect(() => { options.selection.setDocument(options.docKey); }, [options.selection, options.docKey]);
    useLayoutEffect(() => {
        const { element, selection, geometry } = options;
        if (!element) return;
        const detach = selection.attachGeometry(geometry);
        const gestures = new PdfSelectionGestures({ selection, cached: page => geometry.cached(page),
            locale: (page, line) => live.current.locale?.(page, line) });
        const textInput = bindPdfTextInput(element, {
            async hit(x, y, priority, signal) {
                const point = live.current.locate(x, y);
                if (!point || !live.current.isVisible) return null;
                const key = selection.getSnapshot().docKey;
                const page = await geometry.get(point.page, priority, signal);
                if (signal.aborted || !live.current.isVisible || selection.getSnapshot().docKey !== key) return null;
                const size = live.current.pageSize(point.page);
                return size ? hitTextPoint({ text: page.text, ...page.sel, ...size }, point.page, point.x, point.y) : null;
            },
            isLink: target => live.current.isLink(target),
            hasSelection: () => !!selection.getSnapshot().selection,
            async overText(x, y, signal) {
                const point = live.current.locate(x, y);
                if (!point || !live.current.isVisible) return false;
                const page = await geometry.get(point.page, 2, signal);
                const boxes = page.sel.lineBox;
                for (let i = 0; i + 3 < boxes.length; i += 4) {
                    if (point.x >= boxes[i] && point.x <= boxes[i + 2] && point.y >= boxes[i + 1] && point.y <= boxes[i + 3]) return true;
                }
                return false;
            },
            setSelecting: active => live.current.setSelecting(active),
            begin: (point, granularity, extend) => gestures.begin(point, granularity, extend),
            extend: point => gestures.extend(point),
            clear: () => selection.clear(),
            contextMenu: (x, y, keyboard) => live.current.contextMenu(x, y, keyboard),
            autoScroll: (x, y) => live.current.autoScroll(x, y),
            touchPointer: (phase, event) => live.current.touchPointer?.(phase, event),
        });
        const keyboard = bindPdfTextKeyboard(element, {
            selection,
            pageCount: () => live.current.pageCount,
            isFocused: () => live.current.isFocused,
            page: (page, signal) => geometry.get(page, 0, signal),
            findOpen: () => live.current.findOpen(),
            closeFindPreservingHit: () => live.current.closeFindPreservingHit(),
        });
        const lifecycle = new PdfTextVisibility({
            setReaderVisible: visible => live.current.setReaderVisible(visible),
            clearMirrorPages: () => live.current.clearMirrorPages(),
            releaseGpu: reason => live.current.releaseGpu(reason),
            rebuildVisible: () => live.current.rebuildVisible(),
        }, selection, textInput, keyboard);
        input.current = textInput; visibility.current = lifecycle;
        selection.setVisible(true);
        lifecycle.setVisible(live.current.isVisible);
        return () => {
            lifecycle.dispose(); keyboard.dispose(); textInput.dispose(); detach();
            if (input.current === textInput) input.current = null;
            if (visibility.current === lifecycle) visibility.current = null;
        };
    }, [options.element, options.selection, options.geometry]);
    useLayoutEffect(() => { visibility.current?.setVisible(options.isVisible); }, [options.isVisible, options.element, options.geometry]);
    return { selection: snapshot.selection, refreshPointer };
}
