import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { RotateCcw, RotateCw } from './icons';
import { cameraForPagedPosition, fitWidthZ, pageAt, pageStack, pagedConstraint, pagedPosition } from '../platform/render';
import type { Camera, PlatformPaneOptions, Viewport, ViewState } from '../platform/render';
import { pdfGeometryDigest, type OpenTiledDocument, type PdfTiledDocumentSession } from '../pdf/session/documentSession';
import { pdfPageLayerDefinition } from '../pdf/layer/definition';
import type { PdfMirrorPixels, PdfSessionMirrors } from '../pdf/layer/tileMirror';
import { PdfLinkOverlay } from '../pdf/overlay/links';
import type { PdfLinkTarget } from '../pdf/pdfLinkModel';
import { flushPdfViewPositions, getPdfInverted, readPdfViewPos, readThumbnailsOpen, recordPdfNavigation, subscribePdfInverted,
    writePdfViewPos, writeThumbnailsOpen } from '../utils/pdfViewState';
import PdfInvertToggle from './PdfInvertToggle';
import PdfThumbnails, { ThumbnailsToggle, type PdfThumbnailsHandle } from './PdfThumbnails';
import { usePlatformPane } from './platformPane/usePlatformPane';
import '../pdf/overlay/links.css';
import './PdfTiledView.css';

const INSETS = { left: 28, right: 28, top: 16, bottom: 0 };
const LIMITS = { min: 0.4, max: 4 };
let nextViewLease = 0;

function paneBackground(): readonly [number, number, number, number] {
    const value = getComputedStyle(document.documentElement).getPropertyValue('--background-primary').trim();
    const match = /^#([0-9a-f]{6})$/i.exec(value);
    if (!match) return [0.12, 0.12, 0.12, 1];
    const color = Number.parseInt(match[1], 16);
    return [((color >> 16) & 255) / 255, ((color >> 8) & 255) / 255, (color & 255) / 255, 1];
}

interface Props {
    readonly session: PdfTiledDocumentSession;
    readonly document: OpenTiledDocument;
    readonly filePath: string;
    readonly isVisible: boolean;
    readonly isFocused: boolean;
    readonly mirror: PdfSessionMirrors;
    readonly mirrorCoverage: NonNullable<PlatformPaneOptions<PdfMirrorPixels>['mirrorCoverage']>;
    readonly renderThumbnail: (index: number, scale: number) => Promise<string>;
    readonly onRotate?: (delta: number, pageIndex?: number) => void;
    readonly onNotice: (message: string) => void;
}

/** The pane is a camera and DOM chrome around one shared-platform page layer.
 * The document/pool and CPU mirror belong to App's session, not this mount. */
export default function PdfTiledView({ session, document: pdf, filePath, isVisible, isFocused,
    mirror, mirrorCoverage, renderThumbnail, onRotate, onNotice }: Props) {
    const [host, setHost] = useState<HTMLDivElement | null>(null);
    const [overlay, setOverlay] = useState<HTMLDivElement | null>(null);
    const [lease] = useState(() => ++nextViewLease);
    const [page, setPage] = useState(0);
    const [zoom, setZoom] = useState(1);
    const [thumbs, setThumbs] = useState(readThumbnailsOpen);
    const inverted = useSyncExternalStore(subscribePdfInverted, getPdfInverted);
    const stack = useMemo(() => pageStack(pdf.pages), [pdf]);
    const geometryDigest = useMemo(() => pdfGeometryDigest(pdf.pages), [pdf]);
    const constraint = useMemo(() => pagedConstraint(stack, LIMITS, INSETS), [stack]);
    const initial = useRef(readPdfViewPos(filePath));
    const camera = useRef<Camera>({ x: 0, y: 0, z: 1 });
    const viewport = useRef<Viewport>({ width: 0, height: 0, dpr: 1 });
    const initialized = useRef(false);
    const interacting = useRef(false);
    const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
    const paneRef = useRef<ReturnType<typeof usePlatformPane<PdfMirrorPixels>> | null>(null);
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

    const mirrorView = useCallback((view: ViewState) => ({ token: session.token, sourceRole: session.source,
        contentRevision: 'plain', colourVersion: 0, geometryDigest, nominalDpr: Math.min(view.viewport.dpr, 2), view }),
        [session, geometryDigest]);
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
    const layers = useMemo(() => [pageLayer.definition], [pageLayer]);

    const services = useMemo<Omit<PlatformPaneOptions<PdfMirrorPixels>, 'documentToken' | 'initialVisible' | 'initialFocused' | 'layers'>>(() => ({
        paneId: `pdf:${session.token.documentId}:${lease}`, viewLease: lease,
        session: { mirrors: mirror.mirrors, checkpoint: () => {} },
        readMirrorView: mirrorView, mirrorQuad: mirror.mirrorQuad, mirrorCoverage, layout: stack,
        readAppearance: () => ({ background: [...paneBackground()], inverted: getPdfInverted() }),
        currentToken: () => session.isCurrent() ? session.token : null,
        readCamera: () => camera.current,
        revision: () => String(pageLayer.current()?.revision() ?? 0),
        consumeInput: () => {}, isInteracting: () => interacting.current,
        setInputEnabled: () => {},
        cancelViewWork: () => {
            for (const task of linkTasks.current.values()) task.abort();
            linkTasks.current.clear();
            for (const index of loadedLinks.current) links.current?.removePage(index);
            loadedLinks.current.clear(); pageLayer.current()?.hide();
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
    }), [lease, mirror, mirrorView, mirrorCoverage, onNotice, pageLayer, pdf, session, stack]);
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
        const keydown = (event: KeyboardEvent) => {
            if (!active.current.isVisible || !active.current.isFocused || event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
            const old = camera.current;
            if (event.code === 'BracketLeft' || event.code === 'BracketRight') {
                if (!onRotate) return;
                onRotate(event.code === 'BracketLeft' ? -90 : 90);
            } else if (event.key === '+' || event.key === '=' || event.key === '-') {
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
            if (event.pointerType !== 'touch') return;
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
        host.addEventListener('wheel', wheel, { passive: false });
        host.addEventListener('keydown', keydown);
        host.addEventListener('pointerdown', pointerDown); host.addEventListener('pointermove', pointerMove);
        host.addEventListener('pointerup', pointerEnd); host.addEventListener('pointercancel', pointerEnd);
        return () => {
            observer.disconnect(); host.removeEventListener('wheel', wheel); host.removeEventListener('keydown', keydown);
            host.removeEventListener('pointerdown', pointerDown); host.removeEventListener('pointermove', pointerMove);
            host.removeEventListener('pointerup', pointerEnd); host.removeEventListener('pointercancel', pointerEnd);
        };
    }, [host, clamp, constraint, filePath, goPage, onRotate, persist, platformPane, stack, updateCamera]);

    useEffect(() => { platformPane.current?.invalidate('pdf-invert'); }, [inverted, platformPane]);
    useEffect(() => {
        const observer = new MutationObserver(() => platformPane.current?.invalidate('pdf-theme'));
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme'] });
        return () => observer.disconnect();
    }, [platformPane]);
    useEffect(() => () => { if (settle.current) clearTimeout(settle.current); flushPdfViewPositions(); }, []);
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
