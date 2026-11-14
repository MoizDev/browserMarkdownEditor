import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import PdfTiledPageField from './PdfTiledPageField';
import PdfTiledRotateControls from './PdfTiledRotateControls';
import PdfCapabilitiesNotice from './PdfCapabilitiesNotice';
import { assertPdfCopyAllowed, PDF_ENCRYPTED_READ_ONLY, tiledPdfCapabilities } from '../utils/pdfCapabilities';
import { cameraForPagedPosition, fitWidthZ, pageAt, pagePresentation, pageStack, pagedConstraint, pagedPosition } from '../platform/render';
import type { Camera, PlatformPaneOptions, Rect, Viewport, ViewState } from '../platform/render';
import { pdfGeometryDigest, type OpenTiledDocument, type PdfTiledDocumentSession } from '../pdf/session/documentSession';
import type { PdfSessionCapturer } from '../pdf/session/sessionCapture';
import { pdfPageLayerDefinition } from '../pdf/layer/definition';
import type { PdfMirrorPixels, PdfSessionMirrors } from '../pdf/layer/tileMirror';
import { pdfMirrorCoverage } from '../pdf/layer/coverage';
import { PdfLinkOverlay } from '../pdf/overlay/links';
import type { PdfLinkTarget } from '../pdf/pdfLinkModel';
import type { PdfSelectionState } from '../pdf/text/selectionState';
import type { PdfHighlightPalette } from '../pdf/overlay/textHighlight';
import type { PdfFindMemory } from '../utils/pdfFindHighlight';
import { requestVaultSearch } from '../utils/searchRequest';
import type { PdfReadingBinding } from '../types/reading';
import { pdfAgentPages } from '../pdf/text/agentText';
import { flushPdfViewPositions, getPdfInverted, readPdfNavigationRevision, readPdfViewPos, readThumbnailsOpen, recordPdfNavigation, subscribePdfInverted,
    writePdfViewPos, writeThumbnailsOpen } from '../utils/pdfViewState';
import PdfInvertToggle from './PdfInvertToggle';
import PdfThumbnails, { ThumbnailsToggle, type PdfThumbnailsHandle } from './PdfThumbnails';
import { usePlatformPane } from './platformPane/usePlatformPane';
import { usePdfTextMirror } from './usePdfTextMirror';
import { usePdfTiledFind } from './usePdfTiledFind';
import { usePdfTiledSelection } from './usePdfTiledSelection';
import { usePdfTiledCopyMenu } from './usePdfTiledCopyMenu';
import { registerView, type PdfViewInfo } from '../utils/viewRegistry';
import '../pdf/overlay/links.css';
import './PdfTiledView.css';

const INSETS = { left: 28, right: 28, top: 16, bottom: 0 };
const LIMITS = { min: 0.4, max: 4 };
const HIGHLIGHTS: PdfHighlightPalette = { find: [1, 0.82, 0.1, 0.35], current: [1, 0.55, 0.05, 0.6], selection: [0.3, 0.5, 1, 0.38] };
let nextViewLease = 0;

async function bitmapPng(bitmap: ImageBitmap): Promise<Blob> {
    try {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('PDF capture canvas is unavailable');
        context.drawImage(bitmap, 0, 0);
        return await canvas.convertToBlob({ type: 'image/png' });
    } finally { bitmap.close(); }
}

function paneBackground(): readonly [number, number, number, number] {
    const value = getComputedStyle(document.documentElement).getPropertyValue('--background-primary').trim();
    const match = /^#([0-9a-f]{6})$/i.exec(value);
    if (!match) return [0.12, 0.12, 0.12, 1];
    const color = Number.parseInt(match[1], 16);
    return [((color >> 16) & 255) / 255, ((color >> 8) & 255) / 255, (color & 255) / 255, 1];
}

interface Props {
    readonly reading: PdfReadingBinding;
    readonly session: PdfTiledDocumentSession;
    readonly document: OpenTiledDocument;
    readonly filePath: string;
    readonly isVisible: boolean;
    readonly isFocused: boolean;
    readonly mirror: PdfSessionMirrors;
    readonly capturer: PdfSessionCapturer;
    readonly onRotate?: (delta: number, pageIndex?: number) => void;
    readonly findMemory: PdfFindMemory;
    readonly selectionState: PdfSelectionState;
    readonly onOpenTextView: (page?: number) => void;
    readonly onNotice: (message: string) => void;
}

/** The pane is a camera and DOM chrome around one shared-platform page layer.
 * The document/pool and CPU mirror belong to App's session, not this mount. */
export default function PdfTiledView({ reading, session, document: pdf, filePath, isVisible, isFocused,
    mirror, capturer, findMemory, selectionState, onRotate, onOpenTextView, onNotice }: Props) {
    const [host, setHost] = useState<HTMLDivElement | null>(null);
    const [contentHost, setContentHost] = useState<HTMLDivElement | null>(null);
    const [overlay, setOverlay] = useState<HTMLDivElement | null>(null);
    const [lease] = useState(() => ++nextViewLease);
    const [page, setPage] = useState(0);
    const [zoom, setZoom] = useState(1);
    const [thumbs, setThumbs] = useState(readThumbnailsOpen);
    const selection = useSyncExternalStore(selectionState.subscribe, selectionState.getSnapshot, selectionState.getSnapshot).selection;
    const inverted = useSyncExternalStore(subscribePdfInverted, getPdfInverted);
    const stack = useMemo(() => pageStack(pdf.pages), [pdf]);
    const geometryDigest = useMemo(() => pdfGeometryDigest(pdf.pages), [pdf]);
    const capabilities = useMemo(() => tiledPdfCapabilities(pdf.poolDocument.info), [pdf]);
    useEffect(() => {
        if (!session.isCurrent()) return;
        reading.onReaderStatus(reading.identity, pdf.poolDocument.info.repairStatus === 'repaired'
            ? { phase: 'partial', message: 'This PDF required repair; editing is unavailable.' } : { phase: 'ready' });
        reading.onReaderCapabilities(reading.identity, { surface: 'pdf-original',
            emphasis: { kind: 'inactive', reason: 'Emphasis is unavailable for this PDF view.' },
            text: capabilities.copy === true ? 'available' : 'none', find: capabilities.copy === true,
            appearance: 'fixed', copy: capabilities.copy === true });
    }, [capabilities, reading, session, pdf]);
    const constraint = useMemo(() => pagedConstraint(stack, LIMITS, INSETS), [stack]);
    const initial = useRef(readPdfViewPos(filePath));
    const camera = useRef<Camera>({ x: 0, y: 0, z: 1 });
    const viewport = useRef<Viewport>({ width: 0, height: 0, dpr: 1 });
    const initialized = useRef(false);
    const interacting = useRef(false);
    const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
    const positionFlush = useRef<ReturnType<typeof setTimeout> | null>(null);
    const paneRef = useRef<ReturnType<typeof usePlatformPane<PdfMirrorPixels>> | null>(null);
    const thumbsRef = useRef<PdfThumbnailsHandle | null>(null);
    const links = useRef<PdfLinkOverlay | null>(null);
    const loadedLinks = useRef(new Set<number>());
    const linkTasks = useRef(new Map<number, AbortController>());
    const thumbnailTasks = useRef(new Set<AbortController>());
    const active = useRef({ isVisible, isFocused });
    active.current = { isVisible, isFocused };
    const velocity = useRef({ x: 0, y: 0 });
    const previousInput = useRef({ x: 0, y: 0, time: 0 });
    const frameView = useRef<ViewState | null>(null);
    const touchHandler = useRef<(phase: 'down' | 'move' | 'up' | 'cancel', event: PointerEvent) => void>(() => {});
    const autoScroll = useRef({ x: 0, y: 0, time: 0 });
    const copyRef = useRef<ReturnType<typeof usePdfTiledCopyMenu> | null>(null);
    const selectedText = useCallback(() => {
        const value = copyRef.current?.selectedText();
        return value ? value.text + (value.incomplete ? '…' : '') : '';
    }, []);
    const revealMotion = useRef<{ from: Camera; to: Camera; start: number; revision: number; correction?: { page: number; box: Readonly<Rect> } } | null>(null);

    const persist = useCallback(() => {
        if (!initialized.current) return;
        const pos = pagedPosition(camera.current, viewport.current, stack, INSETS);
        if (!pos) return;
        writePdfViewPos(filePath, pos, false);
        if (positionFlush.current) clearTimeout(positionFlush.current);
        positionFlush.current = setTimeout(flushPdfViewPositions, 400);
        setPage(previous => previous === pos.page ? previous : pos.page);
        setZoom(previous => Math.abs(previous - pos.zoom) < 0.001 ? previous : pos.zoom);
        thumbsRef.current?.setCurrentPage(pos.page);
    }, [filePath, stack]);

    const clamp = useCallback((next: Camera): Camera => {
        const z = constraint.clampZoom(next.z, viewport.current);
        const provisional = { ...next, z };
        const bounds = constraint.bounds(provisional, viewport.current);
        return { z, x: Math.max(bounds.minX, Math.min(bounds.maxX, provisional.x)),
            y: Math.max(bounds.minY, Math.min(bounds.maxY, provisional.y)) };
    }, [constraint]);

    const updateCamera = useCallback((next: Camera, moving = false) => {
        camera.current = clamp(next);
        interacting.current = moving;
        persist();
        paneRef.current?.current?.invalidate('pdf-camera');
        if (settle.current) clearTimeout(settle.current);
        if (moving) settle.current = setTimeout(() => {
            interacting.current = false; velocity.current = { x: 0, y: 0 };
            paneRef.current?.current?.invalidate('pdf-camera-settled');
        }, 180);
    }, [clamp, persist]);

    const renderThumbnail = useCallback(async (index: number, scale: number): Promise<string> => {
        const page = pdf.pages[index];
        if (!page || !active.current.isVisible || !session.isCurrent()) throw new DOMException('Thumbnail cancelled', 'AbortError');
        const controller = new AbortController(); thumbnailTasks.current.add(controller);
        try {
            const size = Math.max(1, Math.min(512, Math.ceil(Math.max(page.width, page.height) * scale)));
            const bitmap = await pdf.poolDocument.thumbnail(index, size, { variant: 'plain', profileKey: 'plain', signal: controller.signal });
            try {
                if (controller.signal.aborted || !session.isCurrent() || !active.current.isVisible) throw new DOMException('Thumbnail cancelled', 'AbortError');
                const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
                const context = canvas.getContext('2d');
                if (!context) throw new Error('Thumbnail canvas is unavailable');
                context.drawImage(bitmap, 0, 0);
                const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
                if (controller.signal.aborted || !session.isCurrent() || !active.current.isVisible) throw new DOMException('Thumbnail cancelled', 'AbortError');
                return URL.createObjectURL(blob);
            } finally { bitmap.close(); }
        } finally { thumbnailTasks.current.delete(controller); }
    }, [pdf, session]);

    const goPage = useCallback((index: number) => {
        if (!initialized.current) return;
        const target = stack.rects[Math.max(0, Math.min(stack.rects.length - 1, index))];
        if (!target) return;
        recordPdfNavigation(filePath, 'user-navigation');
        updateCamera({ ...camera.current, y: target.y });
    }, [filePath, stack, updateCamera]);

    const navigate = useCallback((target: Exclude<PdfLinkTarget, { kind: 'uri' }>) => {
        const current = Math.max(0, pageAt(stack, camera.current.y));
        if (target.kind === 'destination') {
            const box = stack.rects[target.page];
            if (!box || !target.view || !target.params) { goPage(target.page); return; }
            const old = camera.current, size = viewport.current;
            const availableWidth = Math.max(1, size.width - INSETS.left - INSETS.right);
            const availableHeight = Math.max(1, size.height - INSETS.top - INSETS.bottom);
            let z = old.z, x = box.x, y = box.y;
            const [a, b, c, d] = target.params;
            switch (target.view) {
                case 'XYZ': x += a; y += b; if (target.zoom !== undefined) z = target.zoom; break;
                case 'Fit': case 'FitB': z = Math.min(availableWidth / box.width, availableHeight / box.height); break;
                case 'FitH': case 'FitBH': z = availableWidth / box.width; y += a; break;
                case 'FitV': case 'FitBV': z = availableHeight / box.height; x += a; break;
                case 'FitR': {
                    const left = Math.min(a, c), top = Math.min(b, d), width = Math.abs(c - a), height = Math.abs(d - b);
                    if (!width || !height) { goPage(target.page); return; }
                    x += left; y += top; z = Math.min(availableWidth / width, availableHeight / height);
                    break;
                }
            }
            z = constraint.clampZoom(z, size);
            recordPdfNavigation(filePath, 'link');
            updateCamera({ z, x: x - INSETS.left / z, y: y - INSETS.top / z });
        } else goPage(target.name === 'FirstPage' ? 0 : target.name === 'LastPage' ? stack.rects.length - 1 :
            current + (target.name === 'NextPage' ? 1 : -1));
    }, [constraint, filePath, goPage, stack, updateCamera]);

    useEffect(() => {
        if (!overlay) return;
        const layer = new PdfLinkOverlay(overlay, navigate);
        links.current = layer;
        return () => {
            for (const task of linkTasks.current.values()) task.abort();
            linkTasks.current.clear(); loadedLinks.current.clear();
            layer.destroy(); if (links.current === layer) links.current = null;
        };
    }, [overlay, navigate]);

    const correctReveal = useCallback((index: number, box: Readonly<Rect>, revision: number) => {
        if (readPdfNavigationRevision(filePath) !== revision) return;
        const motion = revealMotion.current;
        if (motion?.revision === revision) { motion.correction = { page: index, box }; return; }
        const page = stack.rects[index];
        if (!page) return;
        const targetY = page.y + box.y, top = camera.current.y, bottom = top + viewport.current.height / camera.current.z;
        if (targetY >= top && targetY + box.height <= bottom) return;
        updateCamera({ ...camera.current, y: Math.max(page.y, targetY - viewport.current.height / (3 * camera.current.z)) });
    }, [filePath, stack, updateCamera]);
    const find = usePdfTiledFind({ session, document: pdf.poolDocument, stack, isVisible: isVisible && capabilities.copy === true, isFocused,
        initialPage: initial.current?.page ?? 0, memory: findMemory,
        palette: HIGHLIGHTS,
        selection, selectedText,
        readingPosition: () => { const index = Math.max(0, pageAt(stack, camera.current.y));
            return { page: index, y: Math.max(0, camera.current.y - (stack.rects[index]?.y ?? 0)) }; },
        reveal: (index, box) => { const target = stack.rects[index]; if (!target) return;
            recordPdfNavigation(filePath, 'search');
            updateCamera({ ...camera.current, y: Math.max(target.y, target.y + box.y - viewport.current.height / (3 * camera.current.z)) }); },
        beginReveal: (index, box) => {
            const target = stack.rects[index];
            const revision = recordPdfNavigation(filePath, 'search');
            if (!target) return revision;
            const to = clamp({ ...camera.current, y: Math.max(target.y, target.y + box.y - viewport.current.height / (3 * camera.current.z)) });
            if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) updateCamera(to);
            else {
                revealMotion.current = { from: { ...camera.current }, to, start: performance.now(), revision };
                paneRef.current?.current?.invalidate('pdf-find-reveal');
            }
            return revision;
        },
        correctReveal,
        closeFind: hit => {
            if (hit) selectionState.set({ docKey: pdf.poolDocument.docKey, wholeDocument: false, granularity: 'char',
                anchor: { page: hit.page, offset: hit.from, affinity: 'before' }, focus: { page: hit.page, offset: hit.to, affinity: 'after' } });
            host?.focus({ preventScroll: true });
        }, notify: onNotice });
    useEffect(() => { if (find.geometry) return selectionState.attachGeometry(find.geometry); }, [find.geometry, selectionState]);
    useEffect(() => { selectionState.setVisible(isVisible && capabilities.copy === true); }, [selectionState, isVisible, capabilities.copy]);
    const locate = useCallback((clientX: number, clientY: number) => {
        if (!contentHost) return null;
        const bounds = contentHost.getBoundingClientRect();
        const view = frameView.current ?? { camera: camera.current, viewport: viewport.current, epoch: 0, moving: interacting.current };
        const sx = clientX - bounds.left, sy = clientY - bounds.top;
        const index = pageAt(stack, view.camera.y + sy / view.camera.z);
        const box = stack.rects[index];
        if (!box) return null;
        const matrix = pagePresentation(box, view).surface;
        const x = (sx - matrix[4]) / matrix[0], y = (sy - matrix[5]) / matrix[3];
        return x >= 0 && y >= 0 && x <= box.width && y <= box.height ? { page: index, x, y } : null;
    }, [contentHost, stack]);
    const copyMenu = usePdfTiledCopyMenu({ element: contentHost, document: pdf.poolDocument, geometry: find.geometry,
        selection: selectionState, fileName: filePath.split('/').at(-1) ?? filePath, filePath,
        isVisible: isVisible && capabilities.copy === true, locate, pageSize: index => pdf.pages[index],
        keyboardAnchor: () => { const box = contentHost?.getBoundingClientRect();
            return { x: (box?.left ?? 0) + (box?.width ?? 0) / 2, y: (box?.top ?? 0) + 24, page }; },
        searchVault: requestVaultSearch, findPdf: query => find.find.current?.openFind(query),
        readText: index => onOpenTextView(index), notice: onNotice });
    copyRef.current = copyMenu;
    const selectionInput = usePdfTiledSelection({ element: contentHost, docKey: pdf.poolDocument.docKey,
        pageCount: pdf.pages.length, selection: selectionState, geometry: find.geometry,
        isVisible: isVisible && capabilities.copy === true, isFocused, locate, pageSize: index => pdf.pages[index],
        isLink: target => target instanceof Element && !!target.closest('.pdf-tiled-link'),
        setSelecting: activeSelection => links.current?.setSelecting(activeSelection),
        autoScroll: (x, y) => { autoScroll.current = { x, y, time: 0 }; if (x || y) paneRef.current?.current?.invalidate('pdf-selection-scroll'); },
        touchPointer: (phase, event) => touchHandler.current(phase, event),
        contextMenu: copyMenu.openMenu, findOpen: () => findMemory.open,
        cancelCopy: copyMenu.cancelCopy, closeFindPreservingHit: () => { find.find.current?.closeFind(); },
        setReaderVisible: () => {}, clearMirrorPages: () => {}, releaseGpu: () => {},
        rebuildVisible: () => paneRef.current?.current?.invalidate('pdf-selection-visible') });
    const mirrorView = useCallback((view: ViewState) => ({ token: session.token, sourceRole: session.source,
        contentRevision: 'plain', colourVersion: 0, geometryDigest, nominalDpr: Math.min(view.viewport.dpr, 2), view }),
        [session, geometryDigest]);
    const textMirror = usePdfTextMirror({ host: overlay, visible: isVisible && capabilities.copy === true, fileName: filePath.split('/').at(-1) ?? filePath,
        document: pdf, session, pageRects: stack.rects, focusPage: goPage,
        selectionChanged: value => selectionState.set({ docKey: pdf.poolDocument.docKey, wholeDocument: false, granularity: 'char',
            anchor: { ...value.anchor, affinity: 'before' }, focus: { ...value.focus, affinity: 'after' } }),
        openTextView: () => onOpenTextView(), onError: () => onNotice('Accessible PDF text is unavailable on this page.') });
    useEffect(() => {
        if (!selection || selection.wholeDocument) return;
        textMirror.setSelection({ anchor: selection.anchor, focus: selection.focus });
    }, [selection, textMirror.setSelection]);
    const pageLayer = useMemo(() => pdfPageLayerDefinition({
        producer: pdf.producer, isCurrent: () => session.isCurrent() && active.current.isVisible,
        mirror: { store: mirror, view: mirrorView },
        onError: () => onNotice('A PDF page could not be rendered. Retry the document.'),
        demand: (view: ViewState) => ({ token: session.token, source: session.source, variant: 'plain', stack,
            geometryDigest,
            viewport: { x: view.camera.x, y: view.camera.y, width: view.viewport.width / view.camera.z, height: view.viewport.height / view.camera.z },
            rasterScale: view.camera.z * Math.min(view.viewport.dpr, 2), fitWidthZoom: fitWidthZ(view.viewport, stack, INSETS),
            nominalDpr: Math.min(view.viewport.dpr, 2), moving: view.moving,
            velocity: velocity.current, direction: velocity.current }),
    }), [pdf, session, stack, geometryDigest, mirror, mirrorView, onNotice]);
    const layers = useMemo(() => find.layer ? [pageLayer.definition, find.layer] : [pageLayer.definition], [pageLayer, find.layer]);

    const services = useMemo<Omit<PlatformPaneOptions<PdfMirrorPixels>, 'documentToken' | 'initialVisible' | 'initialFocused' | 'layers'>>(() => ({
        paneId: `pdf:${session.token.documentId}:${lease}`, viewLease: lease,
        session: { mirrors: mirror.mirrors, checkpoint: () => {}, captureRegion: capturer.captureRegion },
        readMirrorView: mirrorView, mirrorQuad: mirror.mirrorQuad,
        mirrorCoverage: (view, drawn) => pdfMirrorCoverage(stack, view, drawn), layout: stack,
        readAppearance: () => ({ background: [...paneBackground()], inverted: getPdfInverted() }),
        currentToken: () => session.isCurrent() ? session.token : null,
        readCamera: () => camera.current,
        revision: () => String(pageLayer.current()?.revision() ?? 0),
        consumeInput: now => {
            const scroll = autoScroll.current;
            if ((scroll.x || scroll.y) && active.current.isVisible) {
                const elapsed = scroll.time ? Math.min(0.05, Math.max(0, (now - scroll.time) / 1000)) : 0;
                scroll.time = now;
                if (elapsed) {
                    recordPdfNavigation(filePath, 'user-scroll');
                    camera.current = clamp({ ...camera.current, x: camera.current.x + scroll.x * elapsed / camera.current.z,
                        y: camera.current.y + scroll.y * elapsed / camera.current.z });
                    persist(); selectionInput.refreshPointer();
                }
                paneRef.current?.current?.invalidate('pdf-selection-autoscroll');
            }
            const motion = revealMotion.current;
            if (!motion) return;
            if (readPdfNavigationRevision(filePath) !== motion.revision || !active.current.isVisible) { revealMotion.current = null; return; }
            const t = Math.max(0, Math.min(1, (now - motion.start) / 150)), eased = 1 - (1 - t) ** 3;
            camera.current = { x: motion.from.x + (motion.to.x - motion.from.x) * eased,
                y: motion.from.y + (motion.to.y - motion.from.y) * eased, z: motion.from.z + (motion.to.z - motion.from.z) * eased };
            persist();
            if (t < 1) paneRef.current?.current?.invalidate('pdf-find-animation');
            else {
                revealMotion.current = null;
                if (motion.correction) correctReveal(motion.correction.page, motion.correction.box, motion.revision);
            }
        }, isInteracting: () => interacting.current || revealMotion.current !== null,
        setInputEnabled: () => {},
        cancelViewWork: () => {
            for (const task of linkTasks.current.values()) task.abort();
            linkTasks.current.clear();
            for (const task of thumbnailTasks.current) task.abort();
            thumbnailTasks.current.clear();
            for (const index of loadedLinks.current) links.current?.removePage(index);
            loadedLinks.current.clear(); pageLayer.current()?.hide();
        },
        writeOverlays: frame => {
            frameView.current = frame.view;
            links.current?.setView(frame.view, stack.rects);
            textMirror.updateView(frame.view);
            find.onView(frame.view);
            const top = frame.view.camera.y, bottom = top + frame.view.viewport.height / frame.view.camera.z;
            const visible = new Set<number>();
            for (let index = Math.max(0, pageAt(stack, top)); index < stack.rects.length; index++) {
                if (stack.rects[index].y >= bottom) break;
                visible.add(index);
                if (loadedLinks.current.has(index) || linkTasks.current.has(index)) continue;
                const controller = new AbortController(); linkTasks.current.set(index, controller);
                void pdf.links(index, controller.signal).then(result => {
                    if (!controller.signal.aborted && session.isCurrent() && active.current.isVisible) {
                        links.current?.setPage(index, result); loadedLinks.current.add(index);
                    }
                }).catch(error => { if (!controller.signal.aborted) onNotice(error instanceof Error ? error.message : 'PDF links are unavailable.'); })
                    .finally(() => { if (linkTasks.current.get(index) === controller) linkTasks.current.delete(index); });
            }
            for (const index of loadedLinks.current) if (!visible.has(index)) { links.current?.removePage(index); loadedLinks.current.delete(index); }
            for (const [index, task] of linkTasks.current) if (!visible.has(index)) { task.abort(); linkTasks.current.delete(index); }
        },
        onPresentation: () => {}, onError: error => onNotice(error instanceof Error ? error.message : 'PDF viewer is unavailable.'),
        onNotice: message => onNotice(message === 'memory-pressure' ? 'PDF rendering quality was reduced to fit memory.' : 'PDF rendering switched to a compatible mode.'),
    }), [lease, mirror, capturer, mirrorView, onNotice, pageLayer, pdf, session, stack, textMirror.updateView, find.onView, filePath, persist, correctReveal, clamp, selectionInput.refreshPointer]);
    const platformPane = usePlatformPane<PdfMirrorPixels>({ host, isVisible, isFocused, vaultEpoch: session.token.vaultEpoch,
        documentId: session.token.documentId, layers, services });
    paneRef.current = platformPane;

    useEffect(() => {
        if (!host) return;
        const resize = () => {
            const previous = viewport.current;
            const next = { width: host.clientWidth, height: host.clientHeight, dpr: window.devicePixelRatio || 1 };
            viewport.current = next;
            if (!next.width || !next.height) return;
            if (!initialized.current) {
                const pos = initial.current ?? { page: 0, offset: 0, zoom: 1 };
                const restored = cameraForPagedPosition({ ...pos, zoom: pos.zoom ?? 1 }, next, stack, INSETS, LIMITS);
                if (restored) { camera.current = clamp(restored); initialized.current = true; }
            } else camera.current = clamp(constraint.resize(camera.current, previous, next));
            persist(); platformPane.current?.observeSize(); platformPane.current?.invalidate('pdf-resize');
        };
        const observer = new ResizeObserver(resize); observer.observe(host); resize();
        const wheel = (event: WheelEvent) => {
            if (!active.current.isVisible || !initialized.current) return;
            event.preventDefault();
            const old = camera.current;
            if (event.ctrlKey || event.metaKey) {
                recordPdfNavigation(filePath, 'user-navigation');
                const box = host.getBoundingClientRect();
                const x = event.clientX - box.left, y = event.clientY - box.top;
                const z = constraint.clampZoom(old.z * Math.exp(-event.deltaY * 0.002), viewport.current);
                updateCamera({ z, x: old.x + x / old.z - x / z, y: old.y + y / old.z - y / z }, true);
            } else {
                const now = performance.now(), dt = Math.max(1, now - previousInput.current.time) / 1000;
                const dx = event.deltaX / old.z, dy = event.deltaY / old.z;
                velocity.current = { x: dx / dt, y: dy / dt }; previousInput.current = { x: dx, y: dy, time: now };
                recordPdfNavigation(filePath, 'user-scroll');
                updateCamera({ ...old, x: old.x + dx, y: old.y + dy }, true);
            }
        };
        const keydown = (event: KeyboardEvent) => {
            if (!active.current.isVisible || !active.current.isFocused || !initialized.current || event.defaultPrevented || event.isComposing) return;
            if ((event.metaKey || event.ctrlKey) && ['f', 'g'].includes(event.key.toLowerCase())) {
                event.preventDefault();
                if (capabilities.copy !== true) { onNotice('This PDF does not permit text extraction.'); return; }
                if (event.key.toLowerCase() === 'f') find.find.current?.openFind();
                else find.find.current?.nextMatch(event.shiftKey ? -1 : 1);
                return;
            }
            if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
            const old = camera.current;
            if (event.code === 'BracketLeft' || event.code === 'BracketRight') {
                if (!onRotate || capabilities.encrypted) return;
                onRotate(event.code === 'BracketLeft' ? -90 : 90);
            } else if (event.key === '+' || event.key === '=' || event.key === '-') {
                recordPdfNavigation(filePath, 'user-navigation');
                const z = constraint.clampZoom(old.z * (event.key === '-' ? 1 / 1.2 : 1.2), viewport.current);
                const x = viewport.current.width / 2, y = viewport.current.height / 2;
                updateCamera({ z, x: old.x + x / old.z - x / z, y: old.y + y / old.z - y / z });
            } else if (event.key === 'Home' || event.key === 'End') goPage(event.key === 'Home' ? 0 : stack.rects.length - 1);
            else {
                const delta = event.key === 'ArrowDown' ? 48 : event.key === 'ArrowUp' ? -48 :
                    event.key === 'PageDown' ? viewport.current.height * 0.85 : event.key === 'PageUp' ? -viewport.current.height * 0.85 : 0;
                if (!delta) return;
                recordPdfNavigation(filePath, 'user-scroll');
                updateCamera({ ...old, y: old.y + delta / old.z }, true);
            }
            event.preventDefault();
        };
        const pointers = new Map<number, { x: number; y: number }>();
        const pointerDown = (event: PointerEvent) => {
            if (event.pointerType !== 'touch' || !initialized.current || !active.current.isVisible) return;
            pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
            host.setPointerCapture(event.pointerId);
        };
        const pointerMove = (event: PointerEvent) => {
            const previous = pointers.get(event.pointerId);
            if (!previous) return;
            const before = [...pointers.values()];
            pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
            const after = [...pointers.values()];
            const old = camera.current;
            if (before.length >= 2) {
                const box = host.getBoundingClientRect();
                const centre = (points: typeof before) => ({ x: (points[0].x + points[1].x) / 2 - box.left, y: (points[0].y + points[1].y) / 2 - box.top });
                const a = centre(before), b = centre(after);
                const distance = (points: typeof before) => Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
                const start = distance(before), end = distance(after);
                if (start > 0 && end > 0) {
                    const z = constraint.clampZoom(old.z * end / start, viewport.current);
                    updateCamera({ z, x: old.x + a.x / old.z - b.x / z, y: old.y + a.y / old.z - b.y / z }, true);
                }
            } else {
                const dx = (previous.x - event.clientX) / old.z, dy = (previous.y - event.clientY) / old.z;
                velocity.current = { x: dx * 60, y: dy * 60 };
                updateCamera({ ...old, x: old.x + dx, y: old.y + dy }, true);
            }
            recordPdfNavigation(filePath, 'user-scroll');
        };
        const pointerEnd = (event: PointerEvent) => { pointers.delete(event.pointerId); };
        touchHandler.current = (phase, event) => {
            if (phase === 'down') pointerDown(event);
            else if (phase === 'move') pointerMove(event);
            else pointerEnd(event);
        };
        host.addEventListener('wheel', wheel, { passive: false });
        host.addEventListener('keydown', keydown);
        if (capabilities.copy !== true) {
            host.addEventListener('pointerdown', pointerDown); host.addEventListener('pointermove', pointerMove);
            host.addEventListener('pointerup', pointerEnd); host.addEventListener('pointercancel', pointerEnd);
        }
        return () => {
            touchHandler.current = () => {}; pointers.clear();
            observer.disconnect(); host.removeEventListener('wheel', wheel); host.removeEventListener('keydown', keydown);
            host.removeEventListener('pointerdown', pointerDown); host.removeEventListener('pointermove', pointerMove);
            host.removeEventListener('pointerup', pointerEnd); host.removeEventListener('pointercancel', pointerEnd);
        };
    }, [host, clamp, constraint, capabilities, filePath, find.find, goPage, onNotice, onRotate, persist, platformPane, stack, updateCamera]);

    useEffect(() => registerView(filePath, {
        kind: 'pdf',
        describe(): PdfViewInfo {
            const position = pagedPosition(camera.current, viewport.current, stack, INSETS) ?? { page: 0, offset: 0, zoom: 1 };
            const bottom = camera.current.y + viewport.current.height / camera.current.z;
            const visiblePages: number[] = [];
            for (let index = Math.max(0, pageAt(stack, camera.current.y)); index < stack.rects.length; index++) {
                if (stack.rects[index].y >= bottom) break;
                visiblePages.push(index + 1);
            }
            const selected = selectedText().trim();
            return { kind: 'pdf', surface: 'original', pageCount: pdf.pages.length, page: position.page + 1,
                offset: position.offset, zoom: position.zoom, visiblePages,
                selectedText: selected ? selected.length > 20_000 ? `${selected.slice(0, 20_000)}…` : selected : null,
                inverted: getPdfInverted() };
        },
        async capture(maxSide) {
            const pane = platformPane.current, current = camera.current, size = viewport.current;
            if (!pane || !active.current.isVisible || !session.isCurrent() || !Number.isFinite(maxSide) || maxSide <= 0 || !size.width || !size.height) return null;
            const snapshot = { ...current };
            // C4.5 / p-lead: same visible region and layers, but light and uninverted.
            const bitmap = await pane.captureRegion({ x: current.x, y: current.y, width: size.width / current.z, height: size.height / current.z },
                Math.min(maxSide, 1568), { layers: ['pdf-page'], theme: 'light', inverted: false, policy: 'exact' });
            const output = await bitmapPng(bitmap);
            const now = camera.current;
            return session.isCurrent() && active.current.isVisible && snapshot.x === now.x && snapshot.y === now.y && snapshot.z === now.z ? output : null;
        },
        async renderPage(pageNumber, maxSide) {
            const index = pageNumber - 1, page = pdf.pages[index];
            if (!Number.isInteger(pageNumber) || !page) throw new RangeError('PDF page is out of range.');
            if (!Number.isFinite(maxSide) || maxSide <= 0 || !session.isCurrent()) return null;
            const scale = Math.min(maxSide, 1568) / Math.max(page.width, page.height);
            const bitmap = await pdf.poolDocument.renderPage(index, scale, { priority: 0, variant: 'plain', profileKey: 'plain', maxPixels: 1568 * 1568 });
            const output = await bitmapPng(bitmap);
            return session.isCurrent() ? output : null;
        },
        async pdfText(pages) {
            assertPdfCopyAllowed(capabilities);
            const result = await pdfAgentPages(pdf.poolDocument, pages, new AbortController().signal);
            if (!session.isCurrent()) throw new Error('PDF text changed during the request.');
            return result;
        },
    }), [capabilities, filePath, pdf, platformPane, selectedText, session, stack]);
    useEffect(() => { platformPane.current?.invalidate('pdf-invert'); }, [inverted, platformPane]);
    useEffect(() => {
        const observer = new MutationObserver(() => platformPane.current?.invalidate('pdf-theme'));
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme'] });
        return () => observer.disconnect();
    }, [platformPane]);
    useEffect(() => {
        window.addEventListener('pagehide', flushPdfViewPositions);
        return () => {
            window.removeEventListener('pagehide', flushPdfViewPositions);
            if (settle.current) clearTimeout(settle.current);
            if (positionFlush.current) clearTimeout(positionFlush.current);
            flushPdfViewPositions();
        };
    }, []);
    const zoomBy = (factor: number) => {
        if (!initialized.current) return;
        recordPdfNavigation(filePath, 'user-navigation');
        const old = camera.current, z = constraint.clampZoom(old.z * factor, viewport.current);
        const x = viewport.current.width / 2, y = viewport.current.height / 2;
        updateCamera({ z, x: old.x + x / old.z - x / z, y: old.y + y / old.z - y / z });
    };

    return <div className={`pdf-viewer pdf-tiled-view${thumbs ? ' has-thumbs' : ''}`}>
        {find.bar}
        <PdfCapabilitiesNotice capabilities={capabilities} />
        {thumbs && isVisible && <PdfThumbnails ref={thumbsRef} sizes={pdf.pages} renderThumbnail={renderThumbnail} onSelect={goPage} initialPage={page} />}
        <div className="pdf-tiled-content" ref={setContentHost}><div className="pdf-tiled-surface" ref={setHost} tabIndex={0} aria-label="PDF pages" />
            <div className="pdf-tiled-overlays" ref={setOverlay} /></div>
        <div className="pdf-viewer-controls">
            <div className="pdf-viewer-pill"><ThumbnailsToggle open={thumbs} onToggle={() => setThumbs(previous => { writeThumbnailsOpen(!previous); return !previous; })} />
                <PdfInvertToggle />
                {onRotate && <PdfTiledRotateControls path={filePath} page={page} onRotate={onRotate}
                    disabledReason={capabilities.encrypted ? PDF_ENCRYPTED_READ_ONLY : undefined} />}
            </div>
            <PdfTiledPageField page={page} pageCount={pdf.pages.length} onNavigate={goPage} />
            <div className="pdf-viewer-pill"><button aria-label="Zoom out" onClick={() => zoomBy(1 / 1.2)}>−</button><span>{Math.round(zoom * 100)}%</span><button aria-label="Zoom in" onClick={() => zoomBy(1.2)}>+</button></div>
        </div>
    </div>;
}
