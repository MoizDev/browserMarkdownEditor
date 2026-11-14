import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { RotateCcw, RotateCw } from 'lucide-react';
import { cameraForPagedPosition, fitWidthZ, pageAt, pageStack, pagedConstraint, pagedPosition } from '../platform/render';
import type { Camera, PlatformPaneOptions, Viewport, ViewState } from '../platform/render';
import type { OpenTiledDocument, PdfTiledDocumentSession } from '../pdf/session/documentSession';
import { pdfPageLayerDefinition } from '../pdf/layer/definition';
import { PdfLinkOverlay } from '../pdf/overlay/links';
import type { PdfLinkTarget } from '../pdf/pdfLinkModel';
import { getPdfInverted, readPdfViewPos, readThumbnailsOpen, recordPdfNavigation, subscribePdfInverted,
    writePdfViewPos, writeThumbnailsOpen } from '../utils/pdfViewState';
import PdfInvertToggle from './PdfInvertToggle';
import PdfThumbnails, { ThumbnailsToggle, type PdfThumbnailsHandle } from './PdfThumbnails';
import { usePlatformPane } from './platformPane/usePlatformPane';
import '../pdf/overlay/links.css';
import './PdfTiledView.css';

const INSETS = { left: 28, right: 28, top: 16, bottom: 0 };
const LIMITS = { min: 0.4, max: 4 };
let nextViewLease = 0;

interface Props<T extends object> {
    readonly session: PdfTiledDocumentSession;
    readonly document: OpenTiledDocument;
    readonly filePath: string;
    readonly isVisible: boolean;
    readonly isFocused: boolean;
    readonly mirror: Pick<PlatformPaneOptions<T>, 'session' | 'readMirrorView' | 'mirrorQuad' | 'mirrorCoverage'>;
    readonly renderThumbnail: (index: number, scale: number) => Promise<string>;
    readonly onRotate?: (delta: number, pageIndex?: number) => void;
    readonly onNotice: (message: string) => void;
}

/** The pane is a camera and DOM chrome around one shared-platform page layer.
 * The document/pool and CPU mirror belong to App's session, not this mount. */
export default function PdfTiledView<T extends object>({ session, document: pdf, filePath, isVisible, isFocused,
    mirror, renderThumbnail, onRotate, onNotice }: Props<T>) {
    const [host, setHost] = useState<HTMLDivElement | null>(null);
    const [overlay, setOverlay] = useState<HTMLDivElement | null>(null);
    const [lease] = useState(() => ++nextViewLease);
    const [page, setPage] = useState(0);
    const [zoom, setZoom] = useState(1);
    const [thumbs, setThumbs] = useState(readThumbnailsOpen);
    const inverted = useSyncExternalStore(subscribePdfInverted, getPdfInverted);
    const stack = useMemo(() => pageStack(pdf.pages), [pdf]);
    const constraint = useMemo(() => pagedConstraint(stack, LIMITS, INSETS), [stack]);
    const initial = useRef(readPdfViewPos(filePath));
    const camera = useRef<Camera>({ x: 0, y: 0, z: 1 });
    const viewport = useRef<Viewport>({ width: 0, height: 0, dpr: 1 });
    const initialized = useRef(false);
    const interacting = useRef(false);
    const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
    const paneRef = useRef<ReturnType<typeof usePlatformPane<T>> | null>(null);
    const thumbsRef = useRef<PdfThumbnailsHandle | null>(null);
    const links = useRef<PdfLinkOverlay | null>(null);
    const loadedLinks = useRef(new Set<number>());
    const linkTasks = useRef(new Map<number, AbortController>());
    const active = useRef({ isVisible, isFocused });
    active.current = { isVisible, isFocused };
    const velocity = useRef({ x: 0, y: 0 });
    const previousInput = useRef({ x: 0, y: 0, time: 0 });

    const persist = useCallback(() => {
        const pos = pagedPosition(camera.current, viewport.current, stack, INSETS);
        if (!pos) return;
        writePdfViewPos(filePath, pos, false);
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

    const goPage = useCallback((index: number) => {
        const target = stack.rects[Math.max(0, Math.min(stack.rects.length - 1, index))];
        if (!target) return;
        recordPdfNavigation(filePath, 'user-navigation');
        updateCamera({ ...camera.current, y: target.y });
    }, [filePath, stack, updateCamera]);

    const navigate = useCallback((target: Exclude<PdfLinkTarget, { kind: 'uri' }>) => {
        const current = Math.max(0, pageAt(stack, camera.current.y));
        if (target.kind === 'destination') goPage(target.page);
        else goPage(target.name === 'FirstPage' ? 0 : target.name === 'LastPage' ? stack.rects.length - 1 :
            current + (target.name === 'NextPage' ? 1 : -1));
    }, [goPage, stack]);

    useEffect(() => {
        if (!overlay) return;
        const layer = new PdfLinkOverlay(overlay, navigate);
        links.current = layer;
        return () => { layer.destroy(); if (links.current === layer) links.current = null; };
    }, [overlay, navigate]);

    const pageLayer = useMemo(() => pdfPageLayerDefinition({
        producer: pdf.producer, isCurrent: () => session.isCurrent() && active.current.isVisible,
        onError: () => onNotice('A PDF page could not be rendered. Retry the document.'),
        demand: (view: ViewState) => ({ token: session.token, source: session.source, variant: 'plain', stack,
            viewport: { x: view.camera.x, y: view.camera.y, width: view.viewport.width / view.camera.z, height: view.viewport.height / view.camera.z },
            rasterScale: view.camera.z * Math.min(view.viewport.dpr, 2), fitWidthZoom: fitWidthZ(view.viewport, stack, INSETS),
            nominalDpr: Math.min(view.viewport.dpr, 2), moving: view.moving,
            velocity: velocity.current, direction: velocity.current }),
    }), [pdf, session, stack, onNotice]);
    const layers = useMemo(() => [pageLayer.definition], [pageLayer]);

    const services = useMemo<Omit<PlatformPaneOptions<T>, 'documentToken' | 'initialVisible' | 'initialFocused' | 'layers'>>(() => ({
        paneId: `pdf:${session.token.documentId}:${lease}`, viewLease: lease,
        ...mirror, layout: stack,
        readAppearance: () => ({ background: [0.12, 0.12, 0.12, 1], inverted: getPdfInverted() }),
        currentToken: () => session.isCurrent() ? session.token : null,
        readCamera: () => camera.current,
        revision: () => String(pageLayer.current()?.revision() ?? 0),
        consumeInput: () => {}, isInteracting: () => interacting.current,
        setInputEnabled: () => {},
        cancelViewWork: () => {
            for (const task of linkTasks.current.values()) task.abort();
            linkTasks.current.clear(); pageLayer.current()?.hide();
        },
        writeOverlays: frame => {
            links.current?.setView(frame.view, stack.rects);
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
    }), [lease, mirror, onNotice, pageLayer, pdf, session, stack]);
    const platformPane = usePlatformPane<T>({ host, isVisible, isFocused, vaultEpoch: session.token.vaultEpoch,
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
            if (!active.current.isVisible) return;
            event.preventDefault();
            const old = camera.current;
            if (event.ctrlKey || event.metaKey) {
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
        host.addEventListener('wheel', wheel, { passive: false });
        return () => { observer.disconnect(); host.removeEventListener('wheel', wheel); };
    }, [host, clamp, constraint, filePath, persist, platformPane, stack, updateCamera]);

    useEffect(() => { platformPane.current?.invalidate('pdf-invert'); }, [inverted, platformPane]);
    useEffect(() => () => { if (settle.current) clearTimeout(settle.current); }, []);
    const zoomBy = (factor: number) => {
        const old = camera.current, z = constraint.clampZoom(old.z * factor, viewport.current);
        const x = viewport.current.width / 2, y = viewport.current.height / 2;
        updateCamera({ z, x: old.x + x / old.z - x / z, y: old.y + y / old.z - y / z });
    };

    return <div className={`pdf-viewer pdf-tiled-view${thumbs ? ' has-thumbs' : ''}`}>
        {thumbs && <PdfThumbnails ref={thumbsRef} sizes={pdf.pages} renderThumbnail={renderThumbnail} onSelect={goPage} initialPage={page} />}
        <div className="pdf-tiled-content"><div className="pdf-tiled-surface" ref={setHost} tabIndex={0} aria-label="PDF pages" />
            <div className="pdf-tiled-overlays" ref={setOverlay} /></div>
        <div className="pdf-viewer-controls">
            <div className="pdf-viewer-pill"><ThumbnailsToggle open={thumbs} onToggle={() => setThumbs(previous => { writeThumbnailsOpen(!previous); return !previous; })} />
                <PdfInvertToggle />
                {onRotate && <><button aria-label="Rotate the document left" data-tooltip="Rotate left ([) — hold ⌥ for this page only" onClick={event => onRotate(-90, event.altKey ? page : undefined)}><RotateCcw size={15} /></button>
                    <button aria-label="Rotate the document right" data-tooltip="Rotate right (]) — hold ⌥ for this page only" onClick={event => onRotate(90, event.altKey ? page : undefined)}><RotateCw size={15} /></button></>}
            </div>
            <div className="pdf-viewer-pill pdf-viewer-pages"><input className="pdf-viewer-page-input" aria-label="Current page" type="number" min={1} max={pdf.pages.length}
                value={page + 1} onChange={event => goPage(Number(event.target.value) - 1)} /><span>/ {pdf.pages.length}</span></div>
            <div className="pdf-viewer-pill"><button aria-label="Zoom out" onClick={() => zoomBy(1 / 1.2)}>−</button><span>{Math.round(zoom * 100)}%</span><button aria-label="Zoom in" onClick={() => zoomBy(1.2)}>+</button></div>
        </div>
    </div>;
}
