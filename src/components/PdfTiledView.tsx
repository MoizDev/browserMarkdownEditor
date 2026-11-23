import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
export type { PdfTiledPresentation, PdfTiledSource, PdfTiledSourceFactory } from '../pdf/session/hostTypes';
import PdfTiledPageField from './PdfTiledPageField';
import PdfTiledRotateControls from './PdfTiledRotateControls';
import PdfCapabilitiesNotice from './PdfCapabilitiesNotice';
import { assertPdfCaptureAllowed, assertPdfCopyAllowed, assertPdfRenderAllowed, PDF_ENCRYPTED_READ_ONLY, tiledPdfCapabilities } from '../utils/pdfCapabilities';
import { cameraForPagedPosition, fitWidthZ, pageAt, pagePresentation, pageStack, pagedConstraint, pagedPosition } from '../platform/render';
import type { PageStack } from '../platform/render';
import type { Camera, PlatformPaneOptions, Rect, Viewport, ViewState } from '../platform/render';
import type { PlatformPresentation } from '../platform/render/attachPlatformPane.types';
import type { PdfTiledPresentation } from '../pdf/session/hostTypes';
import { pdfGeometryDigest, type OpenTiledDocument, type PdfTiledDocumentSession } from '../pdf/session/documentSession';
import type { PdfSessionCapturer } from '../pdf/session/sessionCapture';
import { pdfPageLayerDefinition } from '../pdf/layer/definition';
import type { PdfMirrorPixels, PdfSessionMirrors } from '../pdf/layer/tileMirror';
import { pdfMirrorCoverage } from '../pdf/layer/coverage';
import { PdfLinkOverlay } from '../pdf/overlay/links';
import { getPdfFontEpoch, subscribePdfFontEpoch } from '../pdf/fonts/profiles';
import { pdfMirrorRevision } from '../pdf/session/versionOwner';
import type { PdfVersionTransitionOwner } from '../pdf/session/versionOwner';
import type { PdfVersionBridge } from '../pdf/layer/versionBridge';
import { getPdfPageQuality, subscribePdfPageQuality } from '../pdf/quality/store';
import { getPdfPageStatus, subscribePdfPageStatus } from '../pdf/pool/pageStatus';
import type { PdfLinkDestination, PdfLinkTarget } from '../pdf/pdfLinkModel';
import type { PdfSelectionState } from '../pdf/text/selectionState';
import type { PdfHighlightPalette } from '../pdf/overlay/textHighlight';
import type { PdfFindMemory } from '../utils/pdfFindHighlight';
import type { PdfReadingBinding, ReaderCapabilities } from '../types/reading';
import { pdfAgentPages } from '../pdf/text/agentText';
import { addPdfRotationBackdrop, beginPdfRotationTurn, pdfRotationActive, pdfRotationDrawSerial, pdfRotationHasPicture, pdfRotationView,
    pdfRotationWantsBackdrop, pdfStandInFrame, setPdfStandInFrame, subscribePdfRotationStandIn, type PdfPagePicture } from '../utils/pdfRotationStandIn';
import { flushPdfViewPositions, getPdfInverted, readPdfNavigationRevision, readPdfViewPos, readThumbnailsOpen, recordPdfNavigation, subscribePdfInverted,
    writePdfViewPos, writeThumbnailsOpen } from '../utils/pdfViewState';
import PdfInvertToggle from './PdfInvertToggle';
import PdfThumbnails, { ThumbnailsToggle, type PdfThumbnailsHandle } from './PdfThumbnails';
import { usePlatformPane } from './platformPane/usePlatformPane';
import { usePdfTextMirror } from './usePdfTextMirror';
import { usePdfTiledFind } from './usePdfTiledFind';
import { usePdfTiledSelection } from './usePdfTiledSelection';
import { usePdfTiledCopyMenu } from './usePdfTiledCopyMenu';
import { usePdfTiledOutline } from './usePdfTiledOutline';
import { registerView, type PdfViewInfo } from '../utils/viewRegistry';
import { gpuUnavailableText } from '../utils/renderStatus';
import { isCancellation } from '../platform/workers/envelope';
import '../pdf/overlay/links.css';
import './PdfTiledView.css';

const INSETS = { left: 28, right: 28, top: 16, bottom: 0 };
const LIMITS = { min: 0.4, max: 4 };
const HIGHLIGHTS: PdfHighlightPalette = { find: [1, 0.82, 0.1, 0.35], current: [1, 0.55, 0.05, 0.6], selection: [0.3, 0.5, 1, 0.38] };
let nextViewLease = 0;
type RenderNotice = { message: string; error: boolean };
const sessionNotices = new WeakMap<PdfTiledDocumentSession, RenderNotice>();

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
    readonly transition: PdfVersionTransitionOwner;
    readonly bridge: PdfVersionBridge | null;
    readonly capturer: PdfSessionCapturer;
    readonly sourceHash?: string;
    readonly onPresentation?: (presentation: PdfTiledPresentation) => void;
    readonly onRotate?: (delta: number, pageIndex?: number) => void;
    readonly onSearchVault: (query: string) => void;
    readonly findMemory: PdfFindMemory;
    readonly selectionState: PdfSelectionState;
    readonly onOpenTextView: (page?: number) => void;
    readonly onNotice: (message: string) => void;
    readonly onCapabilities: (capabilities: ReaderCapabilities) => void;
    /** App owns this explicit route switch; it must retain the current document and ink. */
}

/** The pane is a camera and DOM chrome around one shared-platform page layer.
 * The document/pool and CPU mirror belong to App's session, not this mount. */
/** The platform's memory notices for this pane: raised once its own grant has kept it below full quality (or refused its CPU floor)
 * for a second, withdrawn when that ends. */
const MEMORY_NOTICES = { 'memory-pressure': 'PDF rendering quality was reduced to fit memory.', 'cpu-floor-denied': 'PDF rendering is limited by available memory.' } as const;
const RETRY_REQUESTED = 'Retry requested. Pages may remain unavailable until rendering completes.';
/** Notices about a state a sharp frame ends, so they clear on the next sharp frame: a sharp frame is full quality. The retry message is
 * one: posted as an error, it stayed over sharp pages for good after a retry (seen at 1440x900, b2). A refused CPU floor is not: it
 * can hold under a sharp frame of tiles already drawn, and cleared by that frame it flashed for one frame; the platform withdraws it. */
const PASSING_NOTICES = new Set<string>([MEMORY_NOTICES['memory-pressure'], RETRY_REQUESTED]);

export default function PdfTiledView({ reading, session, document: pdf, filePath, isVisible, isFocused,
    mirror, transition, bridge, capturer, findMemory, selectionState, sourceHash, onPresentation, onSearchVault, onRotate, onOpenTextView, onNotice, onCapabilities }: Props) {
    const [host, setHost] = useState<HTMLDivElement | null>(null);
    const [contentHost, setContentHost] = useState<HTMLDivElement | null>(null);
    const [overlay, setOverlay] = useState<HTMLDivElement | null>(null);
    const [lease] = useState(() => ++nextViewLease);
    const [page, setPage] = useState(0);
    const [zoom, setZoom] = useState(1);
    const readQuality = useCallback(() => getPdfPageQuality(pdf.poolDocument.docKey, page), [pdf, page]);
    const pageQuality = useSyncExternalStore(subscribePdfPageQuality, readQuality, readQuality);
    const readPageStatus = useCallback(() => getPdfPageStatus(pdf.poolDocument.docKey, page), [pdf, page]);
    const pageStatus = useSyncExternalStore(subscribePdfPageStatus, readPageStatus, readPageStatus);
    const subscribeFont = useCallback((listener: () => void) => subscribePdfFontEpoch(pdf.poolDocument.docKey, listener), [pdf]);
    const readFontEpoch = useCallback(() => getPdfFontEpoch(pdf.poolDocument.docKey), [pdf]);
    const fontEpoch = useSyncExternalStore(subscribeFont, readFontEpoch, () => 0);
    const emphasisRevision = useSyncExternalStore(pdf.emphasis.subscribe, pdf.emphasis.revision, pdf.emphasis.revision);
    const profile = useRef({ fontEpoch, emphasisRevision, enabled: reading.emphasisEnabled });
    profile.current = { fontEpoch, emphasisRevision, enabled: reading.emphasisEnabled };
    useEffect(() => { pdf.emphasis.setEnabled(reading.emphasisEnabled); }, [pdf, reading.emphasisEnabled]);
    useEffect(() => {
        pdf.emphasis.setVisiblePages(isVisible ? [page] : [], isFocused ? page : -1, isVisible);
        return () => pdf.emphasis.setVisiblePages([], -1, false);
    }, [pdf, page, isVisible, isFocused]);
    const [thumbs, setThumbs] = useState(readThumbnailsOpen);
    // Blank pages at their final size and place from the moment the geometry is known until the first frame presents.
    // Without them the pane sat empty and dark between the source opening and the first picture (inv-f cold-small: 400 ->
    // 505 ms); with them the picture lands in the paper it was waiting in, with no layout change.
    const [paper, setPaper] = useState<readonly { left: number; top: number; width: number; height: number }[] | null>(null);
    const paperShown = useRef(false);
    const [noticeState, setNoticeState] = useState<{ session: PdfTiledDocumentSession; notice: RenderNotice | undefined }>(() =>
        ({ session, notice: sessionNotices.get(session) }));
    const [retryBusy, setRetryBusy] = useState<PdfTiledDocumentSession | null>(null);
    const retrying = useRef<PdfTiledDocumentSession | null>(null);
    const [retryGeneration, setRetryGeneration] = useState(0);
    const [updating, setUpdating] = useState(false);
    const currentSharp = useRef(false), updatingRef = useRef(false);
    useLayoutEffect(() => { currentSharp.current = false; updatingRef.current = false; setUpdating(false); }, [session]);
    const mounted = useRef(false);
    const liveSession = useRef(session);
    liveSession.current = session;
    useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const reportRenderNotice = useCallback((message: string, error = false) => {
        if (!mounted.current || liveSession.current !== session || !session.isCurrent()) return;
        if (sessionNotices.get(session)?.error && !error) return;
        const next = { message, error };
        sessionNotices.set(session, next);
        setNoticeState({ session, notice: next });
    }, [session]);
    // A memory notice describes a state, not an event: a sharp frame is full quality, so it goes then. It stayed over a
    // sharp page for the rest of the session (seen after a zoom or resize that only briefly pressed memory).
    const clearQualityNotice = useCallback(() => {
        if (!mounted.current || liveSession.current !== session) return;
        const current = sessionNotices.get(session);
        if (!current || current.error || !PASSING_NOTICES.has(current.message)) return;
        sessionNotices.delete(session);
        setNoticeState({ session, notice: undefined });
    }, [session]);
    /** Withdraws the notice shown only if it is still `message` (another notice since then stays). */
    const clearRenderNotice = useCallback((message: string) => {
        if (!mounted.current || liveSession.current !== session || sessionNotices.get(session)?.message !== message) return;
        sessionNotices.delete(session);
        setNoticeState({ session, notice: undefined });
    }, [session]);
    const notice = noticeState.session === session ? noticeState.notice : sessionNotices.get(session);
    const retryDocument = pdf.poolDocument.retry;
    const retry = useCallback(async () => {
        if (!retryDocument || retrying.current === session || !session.isCurrent()) return;
        retrying.current = session;
        setRetryBusy(session);
        try {
            await retryDocument.call(pdf.poolDocument);
            if (!mounted.current || liveSession.current !== session || !session.isCurrent()) return;
            setRetryGeneration(value => value + 1);
            // The retry answers the error it was asked for: that notice gives way to one the next sharp frame clears.
            sessionNotices.delete(session);
            reportRenderNotice(RETRY_REQUESTED);
        } catch {
            reportRenderNotice('PDF retry failed. The current document and annotations were retained.', true);
        } finally {
            if (retrying.current === session) retrying.current = null;
            if (mounted.current && liveSession.current === session) setRetryBusy(null);
        }
    }, [pdf.poolDocument, reportRenderNotice, retryDocument, session]);
    const selection = useSyncExternalStore(selectionState.subscribe, selectionState.getSnapshot, selectionState.getSnapshot).selection;
    const inverted = useSyncExternalStore(subscribePdfInverted, getPdfInverted);
    const stack = useMemo(() => pageStack(pdf.pages), [pdf]);
    const geometryDigest = useMemo(() => pdfGeometryDigest(pdf.pages), [pdf]);
    const capabilities = useMemo(() => tiledPdfCapabilities(pdf.poolDocument.info), [pdf]);
    useEffect(() => {
        pdf.poolDocument.setVisible(isVisible);
        return () => pdf.poolDocument.setVisible(false);
    }, [pdf.poolDocument, isVisible]);
    useLayoutEffect(() => {
        if (!session.isCurrent() || !isVisible) return;
        reading.onReaderStatus(reading.identity, pageQuality.state === 'degraded'
            ? { phase: 'partial', message: pageQuality.reason ?? 'This page may contain missing image content.' }
            : capabilities.xfa === true
            ? { phase: 'partial', message: 'XFA forms are unsupported; pages or fields may be missing.' }
            : pdf.poolDocument.info.repairStatus === 'repaired'
                ? { phase: 'partial', message: 'This PDF required repair; editing is unavailable.' } : { phase: 'ready' });
        const nativeCapabilities: ReaderCapabilities = { surface: 'pdf-original',
            emphasis: pdf.emphasis.capability(page).kind === 'active' ? { kind: 'toggle' }
                : { kind: 'inactive', reason: pdf.emphasis.capability(page).reason ?? 'Word emphasis is unavailable on this page.' },
            text: capabilities.copy === true ? 'available' : 'none', find: capabilities.copy === true,
            appearance: 'fixed', copy: capabilities.copy === true };
        onCapabilities(nativeCapabilities);
        reading.onReaderCapabilities(reading.identity, nativeCapabilities);
    }, [capabilities, reading, session, pdf, page, emphasisRevision, pageQuality, isVisible, onCapabilities]);
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
    // While a turn's stand-in is up (utils/pdfRotationStandIn.ts) the camera holds still: the picture was laid out for
    // this camera, and the turned view is remounted on the position written for it.
    const documentId = session.token.documentId;
    const turning = useCallback(() => pdfRotationActive(documentId), [documentId]);
    const frameView = useRef<ViewState | null>(null);
    const pendingPresentation = useRef<PlatformPresentation | null>(null);
    const presentationPort = useRef({ sourceHash, onPresentation });
    presentationPort.current = { sourceHash, onPresentation };
    useEffect(() => { if (sourceHash && onPresentation) paneRef.current?.current?.invalidate('pdf-presentation-ready'); }, [sourceHash, onPresentation]);
    const touchHandler = useRef<(phase: 'down' | 'move' | 'up' | 'cancel', event: PointerEvent) => void>(() => {});
    const autoScroll = useRef({ x: 0, y: 0, time: 0 });
    const copyRef = useRef<ReturnType<typeof usePdfTiledCopyMenu> | null>(null);
    const selectedText = useCallback(() => {
        const value = copyRef.current?.selectedText();
        return value ? value.text + (value.incomplete ? '…' : '') : '';
    }, []);
    const revealMotion = useRef<{ from: Camera; to: Camera; start: number; revision: number; correction?: { page: number; box: Readonly<Rect> } } | null>(null);

    const persist = useCallback(() => {
        if (!initialized.current || turning()) return;
        const pos = pagedPosition(camera.current, viewport.current, stack, INSETS);
        if (!pos) return;
        writePdfViewPos(filePath, pos, false);
        if (positionFlush.current) clearTimeout(positionFlush.current);
        positionFlush.current = setTimeout(flushPdfViewPositions, 400);
        setPage(previous => previous === pos.page ? previous : pos.page);
        setZoom(previous => Math.abs(previous - pos.zoom) < 0.001 ? previous : pos.zoom);
        thumbsRef.current?.setCurrentPage(pos.page);
    }, [filePath, stack, turning]);

    const clamp = useCallback((next: Camera): Camera => {
        const z = constraint.clampZoom(next.z, viewport.current);
        const provisional = { ...next, z };
        const bounds = constraint.bounds(provisional, viewport.current);
        return { z, x: Math.max(bounds.minX, Math.min(bounds.maxX, provisional.x)),
            y: Math.max(bounds.minY, Math.min(bounds.maxY, provisional.y)) };
    }, [constraint]);

    const updateCamera = useCallback((next: Camera, moving = false) => {
        if (turning()) return;
        camera.current = clamp(next);
        interacting.current = moving;
        persist();
        paneRef.current?.current?.invalidate('pdf-camera');
        if (settle.current) clearTimeout(settle.current);
        if (moving) settle.current = setTimeout(() => {
            interacting.current = false; velocity.current = { x: 0, y: 0 };
            paneRef.current?.current?.invalidate('pdf-camera-settled');
        }, 180);
    }, [clamp, persist, turning]);

    useEffect(() => {
        if (thumbs && isVisible) return;
        for (const task of thumbnailTasks.current) task.abort();
        thumbnailTasks.current.clear();
    }, [thumbs, isVisible]);

    const renderThumbnail = useCallback(async (index: number, scale: number): Promise<string> => {
        assertPdfRenderAllowed(capabilities);
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
    }, [capabilities, pdf, session]);

    const goPage = useCallback((index: number) => {
        if (!initialized.current) return;
        const target = stack.rects[Math.max(0, Math.min(stack.rects.length - 1, index))];
        if (!target) return;
        recordPdfNavigation(filePath, 'user-navigation');
        updateCamera({ ...camera.current, y: target.y });
    }, [filePath, stack, updateCamera]);

    /** Each wanted page's pixels from the session's tile mirrors, as one page-sized picture (sharpest tiles on top). */
    const capturePictures = useCallback((wanted: ReadonlySet<number>, applied: (page: number) => number): Map<number, PdfPagePicture> => {
        const pictures = new Map<number, PdfPagePicture>(), view = mirror.lastView();
        if (!view || !wanted.size) return pictures;
        const borrow = mirror.mirrors.borrow(view, performance.now());
        try {
            const scale = view.view.camera.z * view.view.viewport.dpr;
            const byPage = new Map<number, ReturnType<typeof borrow.read>[number][]>();
            for (const item of borrow.read(view)) {
                const page = Number(item.entry.key.pageOrRegion);
                if (!wanted.has(page) || String(page) !== item.entry.key.pageOrRegion) continue;
                const list = byPage.get(page) ?? [];
                list.push(item); byPage.set(page, list);
            }
            for (const [page, items] of byPage) {
                const box = items[0].pixels.page, width = Math.max(1, Math.ceil(box.width * scale)), height = Math.max(1, Math.ceil(box.height * scale));
                const draw = (canvas: HTMLCanvasElement, tiles: typeof items) => {
                    const context = canvas.getContext('2d');
                    for (const { pixels } of tiles) {
                        const { bitmap, source, world } = pixels;
                        context?.drawImage(bitmap, source.x, source.y, source.width, source.height,
                            (world.x - box.x) * scale, (world.y - box.y) * scale, world.width * scale, world.height * scale);
                    }
                };
                const sized = () => { const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; return canvas; };
                // Transparent where no tile was. Low-resolution stand-in tiles go under the exact ones, and are what a
                // whole-page backdrop replaces (addPdfRotationBackdrop): only the exact tiles are kept as `top`.
                const exact = items.filter(item => item.entry.tier === 'exact'), low = items.filter(item => item.entry.tier !== 'exact');
                low.sort((a, b) => a.pixels.source.width / a.pixels.world.width - b.pixels.source.width / b.pixels.world.width);
                const top = sized(), image = sized();
                draw(top, exact); draw(image, low); image.getContext('2d')?.drawImage(top, 0, 0);
                pictures.set(page, { image, top, turns: applied(page) });
            }
        } finally { borrow.release(); }
        return pictures;
    }, [mirror]);

    /** Draws this pane's turned picture and writes the position the turned view will open on.
     * Returns the pages it shows, with the device size each is drawn at. */
    const drawStandIn = useCallback((): Array<{ page: number; side: number }> => {
        const root = contentHost?.closest('.pdf-pane'), size = viewport.current;
        const turn = pdfRotationView(documentId, session.token.bytesGeneration, pdf.pages.length);
        if (!turn || !root || !contentHost || !size.width || !size.height) return [];
        const turned: PageStack = pageStack(pdf.pages.map((page, i) => turn.pending(i) % 2 ? { width: page.height, height: page.width } : page));
        const position = pagedPosition(camera.current, size, stack, INSETS) ?? { page: 0, offset: 0, zoom: 1 };
        const fresh = cameraForPagedPosition(position, size, turned, INSETS, LIMITS);
        if (!fresh) return [];
        // Exactly where the turned view will open: the same page, offset and zoom, clamped as its camera is.
        const constraint = pagedConstraint(turned, LIMITS, INSETS), z = constraint.clampZoom(fresh.z, size);
        const bounds = constraint.bounds({ ...fresh, z }, size);
        const next = { z, x: Math.max(bounds.minX, Math.min(bounds.maxX, fresh.x)), y: Math.max(bounds.minY, Math.min(bounds.maxY, fresh.y)) };
        const canvas = document.createElement('canvas'), dpr = size.dpr, scale = next.z * dpr;
        canvas.width = Math.round(size.width * dpr); canvas.height = Math.round(size.height * dpr);
        const context = canvas.getContext('2d'), shown: Array<{ page: number; side: number }> = [];
        if (!context) return [];
        const [r, g, b] = paneBackground();
        context.fillStyle = `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`;
        context.fillRect(0, 0, canvas.width, canvas.height);
        // The page view inverts in encoded sRGB after composition (platform/render/colour.ts): the same filter.
        if (getPdfInverted()) context.filter = 'invert(1) hue-rotate(180deg)';
        const bottom = next.y + size.height / next.z;
        for (let index = Math.max(0, pageAt(turned, next.y)); index < turned.rects.length && turned.rects[index].y < bottom; index++) {
            const rect = turned.rects[index], x = (rect.x - next.x) * scale, y = (rect.y - next.y) * scale;
            const width = rect.width * scale, height = rect.height * scale, picture = turn.picture(index);
            shown.push({ page: index, side: Math.max(width, height) });
            context.save();
            context.fillStyle = '#fff'; context.fillRect(x, y, width, height);
            if (picture) {
                // Clockwise quarter turns from what the picture shows to what the page will show.
                context.translate(x + width / 2, y + height / 2);
                context.rotate(picture.quarter * Math.PI / 2);
                const [w, h] = picture.quarter % 2 ? [height, width] : [width, height];
                context.drawImage(picture.image, -w / 2, -h / 2, w, h);
            }
            context.restore();
        }
        const host = contentHost.getBoundingClientRect(), pane = root.getBoundingClientRect();
        setPdfStandInFrame(documentId, root, { canvas, left: host.left - pane.left, top: host.top - pane.top, width: size.width, height: size.height });
        const turnedPosition = pagedPosition(next, size, turned, INSETS);
        if (turnedPosition) writePdfViewPos(filePath, turnedPosition);
        return shown;
    }, [contentHost, documentId, filePath, pdf, session, stack]);

    // Only what was on screen was captured; the rest of a turned page that comes into view is rendered whole, once,
    // from the bytes on screen, and laid under the capture (measured on a portrait page turned to landscape: the
    // bottom half, off screen before the turn, stayed blank until the written file was drawn sharp).
    const backdrops = useRef(new Map<number, AbortController>());
    useEffect(() => () => { for (const task of backdrops.current.values()) task.abort(); backdrops.current.clear(); }, [session]);
    const fillBackdrops = useCallback((pages: ReadonlyArray<{ page: number; side: number }>) => {
        const generation = session.token.bytesGeneration;
        for (const { page, side } of pages) {
            if (!pdfRotationWantsBackdrop(documentId, page) || backdrops.current.has(page)) continue;
            const turn = pdfRotationView(documentId, generation, pdf.pages.length);
            if (!turn) return;
            const shown = turn.shown(page), controller = new AbortController();
            backdrops.current.set(page, controller);
            void pdf.poolDocument.thumbnail(page, Math.max(64, Math.min(2048, Math.ceil(side))), { variant: 'plain', profileKey: 'plain', signal: controller.signal })
                .then(bitmap => {
                    try { if (!controller.signal.aborted) addPdfRotationBackdrop(documentId, page, bitmap, shown); }
                    finally { bitmap.close(); }
                }, () => { /* A stand-in without a backdrop still turns; the written file follows. */ })
                .finally(() => { if (backdrops.current.get(page) === controller) backdrops.current.delete(page); });
        }
    }, [documentId, pdf, session]);

    const drawnTurn = useRef(pdfRotationDrawSerial(documentId));
    const rotate = useCallback((delta: number, index?: number) => {
        if (!onRotate) return;
        // The buttons are disabled with this reason; a key press says it too rather than doing nothing.
        if (capabilities.encrypted) { onNotice(PDF_ENCRYPTED_READ_ONLY); return; }
        // A file the writer will refuse outright is not turned on screen: App says why, and nothing moves.
        if (capabilities.signed !== true && capabilities.write !== false && initialized.current && isVisible) {
            const size = viewport.current, top = camera.current.y, bottom = top + size.height / camera.current.z;
            const visible = new Set<number>();
            for (let page = Math.max(0, pageAt(stack, top)); page < stack.rects.length && stack.rects[page].y < bottom; page++) {
                if (!pdfRotationHasPicture(documentId, page)) visible.add(page);
            }
            const before = readPdfViewPos(filePath);
            beginPdfRotationTurn(documentId, { generation: session.token.bytesGeneration, pageCount: pdf.pages.length, delta, page: index,
                capture: applied => capturePictures(visible, applied),
                restore: () => { if (before) writePdfViewPos(filePath, before); } });
            drawnTurn.current = pdfRotationDrawSerial(documentId);
            fillBackdrops(drawStandIn());
        }
        onRotate(delta, index);
    }, [capabilities.encrypted, capabilities.signed, capabilities.write, capturePictures, documentId, drawStandIn, fillBackdrops, filePath, isVisible, onNotice, onRotate, pdf, session, stack]);
    // A turn remounts this view on the written bytes, and the old view's surface took keyboard focus away with it:
    // the next `]` then reached nothing (measured: the fifth of five quick presses, after the first write, was lost).
    useEffect(() => {
        if (host && isFocused && pdfRotationActive(documentId) && (!document.activeElement || document.activeElement === document.body)) host.focus({ preventScroll: true });
    }, [host, isFocused, documentId]);
    // Another pane of the same document turned it, or a page's picture improved: draw this pane's picture again.
    useEffect(() => {
        if (!isVisible) return;
        drawnTurn.current = pdfRotationDrawSerial(documentId);
        // Back on screen while the file is still being written (its picture went when the pane hid): draw it again.
        const root = contentHost?.closest('.pdf-pane');
        if (initialized.current && root && pdfRotationActive(documentId) && !pdfStandInFrame(documentId, root)) fillBackdrops(drawStandIn());
        return subscribePdfRotationStandIn(() => {
            const serial = pdfRotationDrawSerial(documentId);
            if (!serial || serial === drawnTurn.current || !initialized.current) return;
            drawnTurn.current = serial;
            fillBackdrops(drawStandIn());
        });
    }, [contentHost, documentId, drawStandIn, fillBackdrops, isVisible]);

    const navigate = useCallback((target: Exclude<PdfLinkTarget, { kind: 'uri' }>) => {
        const current = Math.max(0, pageAt(stack, camera.current.y));
        if (target.kind === 'destination') {
            const box = stack.rects[target.page];
            const count = target.view === 'XYZ' ? 2 : target.view === 'FitR' ? 4 :
                target.view === 'FitH' || target.view === 'FitBH' || target.view === 'FitV' || target.view === 'FitBV' ? 1 : 0;
            if (!box || !target.view || !target.params || target.params.length !== count) { goPage(target.page); return; }
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

    const outlineTask = useRef<AbortController | null>(null);
    useEffect(() => () => { outlineTask.current?.abort(); outlineTask.current = null; }, [session, isVisible]);
    const navigateOutline = useCallback((dest: PdfLinkDestination) => {
        outlineTask.current?.abort();
        const controller = new AbortController(), revision = readPdfNavigationRevision(filePath);
        outlineTask.current = controller;
        void pdf.poolDocument.resolveGeometry(dest.page, { priority: 0, signal: controller.signal }).then(geometry => {
            if (controller.signal.aborted || !active.current.isVisible || !session.isCurrent() || readPdfNavigationRevision(filePath) !== revision) return;
            const extent = stack.rects[dest.page];
            if (!extent || extent.width !== geometry.width || extent.height !== geometry.height) throw new Error('PDF geometry changed');
            navigate({ kind: 'destination', ...dest });
        }).catch(() => { if (!controller.signal.aborted && session.isCurrent()) onNotice('PDF contents destination is unavailable.'); })
            .finally(() => { if (outlineTask.current === controller) outlineTask.current = null; });
    }, [filePath, pdf, session, stack, navigate, onNotice]);
    const outline = usePdfTiledOutline({ document: pdf.poolDocument, isVisible, onNavigate: navigateOutline, onNotice });

    useEffect(() => {
        if (!overlay) return;
        const layer = new PdfLinkOverlay(overlay, navigate);
        links.current = layer;
        // Both refs are never reassigned: these are the same collections the page loop fills.
        const tasks = linkTasks.current, loaded = loadedLinks.current;
        return () => {
            for (const task of tasks.values()) task.abort();
            tasks.clear(); loaded.clear();
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
        searchVault: onSearchVault, findPdf: query => find.find.current?.openFind(query),
        readText: index => onOpenTextView(index), notice: onNotice });
    copyRef.current = copyMenu;
    const { cancelCopy } = copyMenu;
    useEffect(() => {
        selectionState.clear();
        cancelCopy();
    }, [fontEpoch, selectionState, cancelCopy]);
    useEffect(() => { paneRef.current?.current?.invalidate('pdf-paint-profile'); }, [fontEpoch, emphasisRevision, reading.emphasisEnabled]);
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
        contentRevision: pdfMirrorRevision(profile.current.enabled, pdf.poolDocument.docKey, pdf.emphasis.revision()),
        colourVersion: 0, geometryDigest, nominalDpr: Math.min(view.viewport.dpr, 2), view }),
        [session, geometryDigest, pdf]);
    const textMirror = usePdfTextMirror({ host: overlay, visible: isVisible && capabilities.copy === true, fileName: filePath.split('/').at(-1) ?? filePath,
        document: pdf, session, pageRects: stack.rects, focusPage: goPage,
        selectionChanged: value => selectionState.set({ docKey: pdf.poolDocument.docKey, wholeDocument: false, granularity: 'char',
            anchor: { ...value.anchor, affinity: 'before' }, focus: { ...value.focus, affinity: 'after' } }),
        openTextView: () => onOpenTextView(), onError: () => onNotice('Accessible PDF text is unavailable on this page.') });
    const { updateView: updateTextMirrorView } = textMirror;
    const { onView: onFindView } = find;
    const { refreshPointer: refreshSelectionPointer } = selectionInput;
    const { setSelection: setTextMirrorSelection } = textMirror;
    useEffect(() => {
        if (!selection || selection.wholeDocument) return;
        setTextMirrorSelection({ anchor: selection.anchor, focus: selection.focus });
    }, [selection, setTextMirrorSelection]);
    const pageLayer = useMemo(() => {
        // Retry must replace the layer's failed-tile set while retaining its mirror.
        void retryGeneration;
        return pdfPageLayerDefinition({
        producer: { render: (request, signal) => { assertPdfRenderAllowed(capabilities); return pdf.producer.render(request, signal); } },
        isCurrent: () => session.isCurrent() && active.current.isVisible,
        mirror: { store: mirror, view: mirrorView }, bridge,
        onError: () => reportRenderNotice('A PDF page could not be rendered. Retry the document.', true),
        demand: (view: ViewState) => ({ token: session.token, source: session.source, variant: profile.current.enabled ? 'emphasis' : 'plain', stack,
            pageVariant: index => pdf.emphasis.variant(index).variant, fontEpoch: profile.current.fontEpoch, geometryDigest,
            viewport: { x: view.camera.x, y: view.camera.y, width: view.viewport.width / view.camera.z, height: view.viewport.height / view.camera.z },
            rasterScale: view.camera.z * Math.min(view.viewport.dpr, 2), fitWidthZoom: fitWidthZ(view.viewport, stack, INSETS),
            nominalDpr: Math.min(view.viewport.dpr, 2), moving: view.moving,
            velocity: velocity.current, direction: velocity.current }),
        });
    }, [pdf, session, stack, geometryDigest, mirror, mirrorView, bridge, capabilities, reportRenderNotice, retryGeneration]);
    useEffect(() => {
        if (!isVisible || !bridge) return;
        const changed = () => {
            if (transition.isActive(bridge)) return;
            pageLayer.current()?.expireBridge();
            if (!currentSharp.current) { updatingRef.current = true; setUpdating(true); }
        };
        const unsubscribe = transition.subscribe(changed); changed();
        return unsubscribe;
    }, [isVisible, bridge, transition, pageLayer]);
    const layers = useMemo(() => find.layer ? [pageLayer.definition, find.layer] : [pageLayer.definition], [pageLayer, find.layer]);

    const services = useMemo<Omit<PlatformPaneOptions<PdfMirrorPixels>, 'documentToken' | 'initialVisible' | 'initialFocused' | 'layers'>>(() => ({
        paneId: `pdf:${session.token.documentId}:${lease}`, viewLease: lease,
        session: { mirrors: mirror.mirrors, checkpoint: () => {}, captureRegion: (rect, maxSide, options) => {
            assertPdfCaptureAllowed(capabilities);
            return capturer.captureRegion(rect, maxSide, options);
        } },
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
                    persist(); refreshSelectionPointer();
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
            const presented = pendingPresentation.current;
            pendingPresentation.current = null;
            const hash = presentationPort.current.sourceHash;
            if (presented && currentSharp.current && hash && /^[0-9a-f]{64}$/.test(hash) && mounted.current && liveSession.current === session &&
                active.current.isVisible && session.isCurrent() && presented.complete && presented.sharp && !presented.staleVersion &&
                presented.frameId === frame.frameId && presented.viewEpoch === frame.view.epoch &&
                presented.token.vaultEpoch === frame.token.vaultEpoch && presented.token.documentId === frame.token.documentId &&
                presented.token.bytesGeneration === frame.token.bytesGeneration && presented.token.session === frame.token.session &&
                presented.token.viewLease === frame.token.viewLease && presented.token.deviceGeneration === frame.token.deviceGeneration &&
                frame.token.viewLease === lease) {
                const view = frame.view, left = view.camera.x, top = view.camera.y;
                const right = left + view.viewport.width / view.camera.z, bottom = top + view.viewport.height / view.camera.z;
                const pages = stack.rects.flatMap((rect, index) => rect.x < right && rect.x + rect.width > left &&
                    rect.y < bottom && rect.y + rect.height > top ? [index] : []);
                if (pages.length) presentationPort.current.onPresentation?.({ token: { ...presented.token }, resultHash: hash,
                    frameId: presented.frameId, viewEpoch: presented.viewEpoch, pages, complete: true, sharp: true, staleVersion: false });
            }
            links.current?.setView(frame.view, stack.rects);
            updateTextMirrorView(frame.view);
            onFindView(frame.view);
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
                }).catch(error => {
                    // A notebook redirect can retire the source before passive
                    // link cleanup. Cancellation is not a modal reader failure.
                    if (controller.signal.aborted || !mounted.current || liveSession.current !== session ||
                        !session.isCurrent() || pdf.poolDocument.closed || !active.current.isVisible ||
                        isCancellation(error)) return;
                    onNotice(error instanceof Error && error.message.trim() ? error.message : 'PDF links are unavailable.');
                })
                    .finally(() => { if (linkTasks.current.get(index) === controller) linkTasks.current.delete(index); });
            }
            pdf.emphasis.setVisiblePages([...visible], active.current.isFocused ? Math.max(0, pageAt(stack, top)) : -1, active.current.isVisible);
            for (const index of loadedLinks.current) if (!visible.has(index)) { links.current?.removePage(index); loadedLinks.current.delete(index); }
            for (const [index, task] of linkTasks.current) if (!visible.has(index)) { task.abort(); linkTasks.current.delete(index); }
        },
        onPresentation: presentation => {
            if (presentation && paperShown.current) { paperShown.current = false; setPaper(null); }
            pendingPresentation.current = presentation;
            const token = presentation?.token;
            currentSharp.current = !!presentation && presentation.complete && presentation.sharp && !presentation.staleVersion && session.isCurrent() &&
                token?.vaultEpoch === session.token.vaultEpoch && token.documentId === session.token.documentId &&
                token.bytesGeneration === session.token.bytesGeneration && token.session === session.token.session && token.viewLease === lease;
            if (currentSharp.current && updatingRef.current) { updatingRef.current = false; setUpdating(false); }
            if (currentSharp.current) clearQualityNotice();
        }, onError: () => reportRenderNotice('The PDF viewer encountered a rendering error.', true),
        onNotice: (message, cause) => reportRenderNotice(message === 'memory-pressure' || message === 'cpu-floor-denied' ? MEMORY_NOTICES[message]
            : message === 'cpu-pinned' ? 'PDF rendering is using a compatible mode.' : gpuUnavailableText(cause)),
        onNoticeCleared: (message, cause) => clearRenderNotice(message === 'gpu-unavailable' ? gpuUnavailableText(cause) : MEMORY_NOTICES[message]),
    }), [lease, mirror, capturer, mirrorView, onNotice, pageLayer, pdf, session, stack, updateTextMirrorView, onFindView, filePath, persist, correctReveal, clamp, refreshSelectionPointer, capabilities, reportRenderNotice, clearQualityNotice, clearRenderNotice]);
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
                if (restored) {
                    camera.current = clamp(restored); initialized.current = true;
                    if (!paperShown.current) {
                        // The same projection the page layer paints with (pagePresentation), so no page moves when it lands.
                        const view = { camera: camera.current, viewport: next, epoch: 0, moving: false };
                        const bottom = view.camera.y + next.height / view.camera.z, sheets = [];
                        for (let index = Math.max(0, pageAt(stack, view.camera.y)); index < stack.rects.length && stack.rects[index].y < bottom; index++) {
                            const box = stack.rects[index], matrix = pagePresentation(box, view).surface;
                            sheets.push({ left: matrix[4], top: matrix[5], width: box.width * matrix[0], height: box.height * matrix[3] });
                        }
                        paperShown.current = true; setPaper(sheets);
                    }
                }
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
                if (!onRotate) return;
                rotate(event.code === 'BracketLeft' ? -90 : 90);
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
        // The wheel (and a trackpad pinch, which arrives as ctrl+wheel) is taken on the content, not the surface: links are buttons in the
        // overlay, a sibling of the surface, so over a table of contents or a citation every wheel event missed the handler and the page
        // stood still under the cursor until the link left it (inv-f e11: zero presents while 40 wheel events reached the window).
        const wheelTarget = contentHost ?? host;
        wheelTarget.addEventListener('wheel', wheel, { passive: false });
        host.addEventListener('keydown', keydown);
        if (capabilities.copy !== true) {
            host.addEventListener('pointerdown', pointerDown); host.addEventListener('pointermove', pointerMove);
            host.addEventListener('pointerup', pointerEnd); host.addEventListener('pointercancel', pointerEnd);
        }
        return () => {
            touchHandler.current = () => {}; pointers.clear();
            observer.disconnect(); wheelTarget.removeEventListener('wheel', wheel); host.removeEventListener('keydown', keydown);
            host.removeEventListener('pointerdown', pointerDown); host.removeEventListener('pointermove', pointerMove);
            host.removeEventListener('pointerup', pointerEnd); host.removeEventListener('pointercancel', pointerEnd);
        };
    }, [host, contentHost, clamp, constraint, capabilities, filePath, find.find, goPage, onNotice, onRotate, persist, platformPane, rotate, stack, updateCamera]);

    useEffect(() => {
        const renderPageWithInfo = async (pageNumber: number, maxSide: number) => {
            assertPdfRenderAllowed(capabilities);
            assertPdfCaptureAllowed(capabilities);
            const index = pageNumber - 1, page = pdf.pages[index];
            if (!Number.isInteger(pageNumber) || !page) throw new RangeError('PDF page is out of range.');
            if (!Number.isFinite(maxSide) || maxSide <= 0 || !session.isCurrent()) throw new Error('PDF page capture is unavailable.');
            const capture = await capturer.capturePageWithInfo(index, maxSide);
            try {
                if (!mounted.current || liveSession.current !== session) { capture.bitmap.close(); throw new DOMException('PDF view changed', 'AbortError'); }
                const png = await bitmapPng(capture.bitmap);
                capture.check();
                if (!mounted.current || liveSession.current !== session) throw new DOMException('PDF view changed', 'AbortError');
                return { png, emphasis: capture.emphasis };
            } finally { capture.release(); }
        };
        return registerView(filePath, {
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
            assertPdfCaptureAllowed(capabilities);
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
        renderPageWithInfo,
        async renderPage(pageNumber, maxSide) { return (await renderPageWithInfo(pageNumber, maxSide)).png; },
        async pdfText(pages, signal) {
            assertPdfCopyAllowed(capabilities);
            const result = await pdfAgentPages(pdf.poolDocument, pages, signal ?? new AbortController().signal, () => session.isCurrent());
            if (!session.isCurrent()) throw new Error('PDF text changed during the request.');
            return result;
        },
        });
    }, [capabilities, capturer, filePath, pdf, platformPane, selectedText, session, stack]);
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

    const pageNotice = pageQuality.state === 'degraded' ? pageQuality.reason ?? 'This page may contain missing image content.'
        : pageStatus.state === 'slow' ? `Still drawing page ${page + 1}…`
            : pageStatus.state === 'failed' || pageStatus.state === 'quarantined' ? pageStatus.reason ?? 'This page could not be drawn.' : undefined;
    const visibleNotice = pageNotice ?? notice?.message;
    // Retry reloads the document, so it is offered only for a page or render that failed. A memory or mode notice gets Dismiss only:
    // retrying one reloaded every page and left an error-class message over sharp pages.
    const offerRetry = !!pageNotice || !!notice?.error;
    return <div className={`pdf-viewer pdf-tiled-view${thumbs ? ' has-thumbs' : ''}`}>
        {find.bar}
        {outline.panel}
        {visibleNotice && <div className="pdf-tiled-notice" role="status">
            <div>{visibleNotice}</div>
            <div className="pdf-tiled-notice-actions">
                {offerRetry && <button type="button" className="disk-bar-btn" onClick={() => { void retry(); }} disabled={!retryDocument || retryBusy === session}>Retry</button>}
                {!pageNotice && <button type="button" className="disk-bar-btn" onClick={() => { sessionNotices.delete(session); setNoticeState({ session, notice: undefined }); }}>Dismiss</button>}
            </div>
            {offerRetry && !retryDocument && <div className="pdf-tiled-notice-hint">Retry is unavailable.</div>}
        </div>}
        {thumbs && isVisible && <PdfThumbnails ref={thumbsRef} sizes={pdf.pages} renderThumbnail={renderThumbnail} onSelect={goPage} initialPage={page} />}
        <div className="pdf-tiled-content" ref={setContentHost}>
            {paper && <div className={`pdf-tiled-paper${inverted ? ' is-inverted' : ''}`} aria-hidden="true">
                {paper.map((sheet, index) => <div key={index} style={sheet} />)}</div>}
            <div className="pdf-tiled-surface" ref={setHost} tabIndex={0} aria-label="PDF pages" />
            <div className="pdf-tiled-overlays" ref={setOverlay} />
            {updating && <div className="pdf-tiled-updating" role="status">Updating PDF…</div>}</div>
        <div className="pdf-viewer-controls">
            {copyMenu.copyStatus && <div className="pdf-tiled-copy-status" role="status" aria-live="polite">{copyMenu.copyStatus}</div>}
            <div className="pdf-viewer-pill">{outline.button}<ThumbnailsToggle open={thumbs} onToggle={() => setThumbs(previous => { writeThumbnailsOpen(!previous); return !previous; })} />
                <PdfInvertToggle />
                {onRotate && <PdfTiledRotateControls page={page} onRotate={rotate}
                    disabledReason={capabilities.encrypted ? PDF_ENCRYPTED_READ_ONLY : undefined} />}
                <PdfCapabilitiesNotice capabilities={capabilities} nativeFontPolicy />
            </div>
            <PdfTiledPageField page={page} pageCount={pdf.pages.length} onNavigate={goPage} />
            <div className="pdf-viewer-pill pdf-viewer-zoom"><button type="button" aria-label="Zoom out" data-tooltip="Zoom out" onClick={() => zoomBy(1 / 1.2)}>−</button><span className="pdf-viewer-zoom-value">{Math.round(zoom * 100)}%</span><button type="button" aria-label="Zoom in" data-tooltip="Zoom in" onClick={() => zoomBy(1.2)}>+</button></div>
        </div>
    </div>;
}
