import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import LucideGlyph from '../LucideGlyph';
import { worldToSurface } from '../../platform/render/camera';
import { worldPose } from '../../whiteboard/change/coordinates';
import type { NodeId } from '../../whiteboard/model/ids';
import type { PictureNode } from '../../whiteboard/model/nodes';
import type { MediaActions } from '../../whiteboard/host/mediaActions';
import { pictureIcons } from './chrome/boardIcons';
import { CROP_ZOOM_MAX, HANDLES, WHOLE_PICTURE, clamp, dragged, fitWhole, within, zoomOf, type CropAspect, type CropDrag, type CropHandle, type CropWindow } from './nativeCropGeometry';
import type { PictureCropStore } from './pictureCropStore';
import type { NativeViewLease } from './nativeViewLease';
import type { BoardTextQuestion } from './useNativeBoardDialogs';
import { chooseReplacementImage } from './nativeMediaRows';
import { returnBoardFocusIfLost } from './chrome/boardFocus';
import { useFloatingBar, type FloatingAnchor } from './floatingBar';

type Translate = (key: string) => string;

/** Where a picture sits on screen, in surface pixels, with its node-frame geometry: the frame every crop shape is drawn in. */
export interface PictureFrame {
    /** The node box's top-left corner (its own origin, before rotation), in surface pixels. */
    readonly originX: number;
    readonly originY: number;
    /** Rotation in degrees, as CSS takes it: clockwise on screen, the board's own convention. */
    readonly degrees: number;
    readonly radians: number;
    /** Surface pixels per world unit. */
    readonly zoom: number;
    readonly flipX: boolean;
    readonly flipY: boolean;
    /** The committed box in world units. */
    readonly w: number;
    readonly h: number;
    /** The whole original picture in world units, and the committed window it is cut to. */
    readonly fullW: number;
    readonly fullH: number;
    readonly cropX0: number;
    readonly cropY0: number;
    /** The top edge's centre on screen, for the bars that sit above the picture, and its lowest point, for when they go below. */
    readonly anchorX: number;
    readonly anchorY: number;
    readonly anchorBottom: number;
    readonly id: NodeId;
    readonly media: { readonly width: number; readonly height: number };
}

function pictureOf(lease: NativeViewLease, id: NodeId): PictureNode | null {
    const node = lease.runtime.session.doc.nodes.get(id);
    return node && node.kind === 'picture' ? node : null;
}

/** The picture's frame now, or null when it is gone or is not a picture. Pure of the DOM, so a frame loop can compare it. */
function frameOf(lease: NativeViewLease, id: NodeId): PictureFrame | null {
    const doc = lease.runtime.session.doc, node = pictureOf(lease, id);
    if (!node) return null;
    const pose = worldPose(doc, node.id), camera = lease.camera.camera, zoom = camera.z;
    const origin = worldToSurface({ x: pose.x, y: pose.y }, camera);
    const crop = node.crop ?? WHOLE_PICTURE;
    const cropW = crop.x1 - crop.x0, cropH = crop.y1 - crop.y0;
    if (!(cropW > 0 && cropH > 0 && node.w > 0 && node.h > 0 && zoom > 0)) return null;
    const entry = node.media ? doc.media.get(node.media) : undefined;
    const media = { width: entry?.w ?? node.w, height: entry?.h ?? node.h };
    const cos = Math.cos(pose.rotation), sin = Math.sin(pose.rotation);
    // Top-edge centre of the rotated box: the average of its corners' x, and the highest corner's y.
    const corners = [[0, 0], [node.w, 0], [0, node.h], [node.w, node.h]].map(([x, y]) => ({
        x: origin.x + (cos * x - sin * y) * zoom, y: origin.y + (sin * x + cos * y) * zoom,
    }));
    const anchorX = corners.reduce((sum, point) => sum + point.x, 0) / 4;
    const anchorY = Math.min(...corners.map(point => point.y)), anchorBottom = Math.max(...corners.map(point => point.y));
    return Object.freeze({ originX: origin.x, originY: origin.y, degrees: pose.rotation * 180 / Math.PI, radians: pose.rotation, zoom,
        flipX: node.flipX, flipY: node.flipY, w: node.w, h: node.h, fullW: node.w / cropW, fullH: node.h / cropH,
        cropX0: crop.x0, cropY0: crop.y0, anchorX, anchorY, anchorBottom, id: node.id, media });
}

/** Re-reads the frame each animation frame while active, and re-renders only when something it draws has moved. */
function useFrame(lease: NativeViewLease, id: NodeId, active: boolean): PictureFrame | null {
    const [frame, setFrame] = useState<PictureFrame | null>(() => (active ? frameOf(lease, id) : null));
    useEffect(() => {
        if (!active) { setFrame(null); return; }
        let raf = 0, last = '';
        const tick = () => {
            const next = frameOf(lease, id), key = next ? JSON.stringify(next) : '';
            if (key !== last) { last = key; setFrame(next); }
            raf = requestAnimationFrame(tick);
        };
        tick();
        return () => cancelAnimationFrame(raf);
    }, [lease, id, active]);
    return frame;
}

/** The screen delta of a pointer, in the picture's own unflipped, unrotated frame, in world units. */
function localDelta(frame: PictureFrame, dx: number, dy: number): { x: number; y: number } {
    const c = Math.cos(frame.radians), s = Math.sin(frame.radians);
    let x = c * dx + s * dy, y = -s * dx + c * dy;
    if (frame.flipX) x = -x;
    if (frame.flipY) y = -y;
    return { x: x / frame.zoom, y: y / frame.zoom };
}

export interface NativePictureCropProps {
    readonly lease: NativeViewLease;
    readonly store: PictureCropStore;
    readonly media: MediaActions;
    readonly t: Translate;
    readonly isVisible: boolean;
    readonly onError: (error: unknown) => void;
}

/** The crop, drawn over the picture on the board: the whole original faded, the kept window bright, and a bar above. */
export function NativePictureCrop({ lease, store, t, isVisible, onError }: NativePictureCropProps) {
    const session = useSyncExternalStore(store.subscribe, store.get);
    const frame = useFrame(lease, session?.id ?? ('' as NodeId), !!session && isVisible);
    const root = useRef<HTMLDivElement | null>(null);
    const drag = useRef<{ drag: CropDrag; pointer: number; x: number; y: number; frame: PictureFrame } | null>(null);
    const commit = useCallback(() => { try { store.commit(); } catch (error) { onError(error); } }, [store, onError]);
    // Ending a crop hands the board its keyboard focus back: the bar's button or the pressed bar leaves the DOM with it.
    const leave = useCallback((apply: boolean) => {
        const host = root.current?.closest<HTMLElement>('.board-viewer-host') ?? null;
        if (apply) commit(); else store.cancel();
        returnBoardFocusIfLost(host);
    }, [store, commit]);

    // Escape cancels; Enter applies; an arrow moves the picture's content inside the frame (Shift for ten times as far).
    // Captured at the window, so the board's own keys do not also act on the same press.
    useEffect(() => {
        if (!session) return;
        const onKey = (event: KeyboardEvent) => {
            const target = event.target;
            const form = target instanceof HTMLElement && (target.isContentEditable || target instanceof HTMLInputElement
                || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement);
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); leave(false); return; }
            if (form) return;
            if (event.key === 'Enter' && !event.repeat && !event.metaKey && !event.ctrlKey && !event.altKey) {
                event.preventDefault(); event.stopPropagation(); leave(true); return;
            }
            const step = event.shiftKey ? 10 : 1, live = store.get();
            const vector = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
            if (!vector || !live || event.metaKey || event.ctrlKey || event.altKey || !frame) return;
            event.preventDefault(); event.stopPropagation();
            const content = localDelta(frame, vector[0] * step, vector[1] * step);
            const win = live.window;
            store.setWindow(within({ x0: win.x0 - content.x / frame.fullW, y0: win.y0 - content.y / frame.fullH,
                x1: win.x1 - content.x / frame.fullW, y1: win.y1 - content.y / frame.fullH }));
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [session, store, leave, frame]);

    // A press outside the crop ends it and keeps the draft, and passes on: the press still selects whatever it landed on.
    // The bar is part of the crop: a press on its aspect menu, zoom slider or Fit is not an outside click (measured: it ended the crop).
    useEffect(() => {
        if (!session) return;
        const onDown = (event: PointerEvent) => {
            const target = event.target;
            if (root.current?.contains(target as Node) || (target instanceof Element && target.closest('.crop-bar'))) return;
            if (store.get()) {
                const host = root.current?.closest<HTMLElement>('.board-viewer-host') ?? null;
                commit();
                returnBoardFocusIfLost(host);
            }
        };
        window.addEventListener('pointerdown', onDown, true);
        return () => window.removeEventListener('pointerdown', onDown, true);
    }, [session, store, commit]);

    // A Ctrl/Cmd-press on a selection handle asked for this crop from one edge (the select tool gave the press to the crop): the drag
    // then follows that press on the window, since the press belongs to the board and no element of this editor holds it.
    useEffect(() => {
        if (!session || !frame) return;
        const grab = store.takeEdge();
        if (grab) drag.current = { drag: { mode: 'edge', dx: grab.dx, dy: grab.dy, origin: session.window }, pointer: grab.pointerId, x: grab.x, y: grab.y, frame };
    }, [session, frame, store]);
    const sessionOpen = session !== null;
    useEffect(() => {
        if (!sessionOpen) return;
        const onMove = (event: PointerEvent) => {
            const active = drag.current, live = store.get();
            if (!active || !live || active.pointer !== event.pointerId) return;
            const delta = localDelta(active.frame, event.clientX - active.x, event.clientY - active.y);
            store.setWindow(dragged(active.drag, delta.x / active.frame.fullW, delta.y / active.frame.fullH,
                { shift: event.shiftKey, fromCentre: event.altKey }, live.width, live.height));
        };
        const onUp = (event: PointerEvent) => { if (drag.current?.pointer === event.pointerId) drag.current = null; };
        // Captured: the board's gesture stops the press's moves below the window, and the drag must still follow them.
        window.addEventListener('pointermove', onMove, true);
        window.addEventListener('pointerup', onUp, true);
        window.addEventListener('pointercancel', onUp, true);
        return () => {
            window.removeEventListener('pointermove', onMove, true);
            window.removeEventListener('pointerup', onUp, true);
            window.removeEventListener('pointercancel', onUp, true);
        };
    }, [sessionOpen, store]);

    // The board's own selection frame stays drawn under the crop, and its turn handle, outside the picture, showed beside the
    // crop's handles though it does nothing there: the board's overlay is hidden for as long as the crop is drawn.
    const cropping = !!session && !!frame;
    useEffect(() => {
        if (!cropping) return;
        const host = root.current?.closest<HTMLElement>('.board-viewer-host');
        host?.setAttribute('data-cropping', '');
        return () => host?.removeAttribute('data-cropping');
    }, [cropping]);

    if (!session || !frame) return null;
    const win = session.window;
    const move = (event: ReactPointerEvent<HTMLElement>) => {
        const active = drag.current;
        if (!active || active.pointer !== event.pointerId) return;
        const delta = localDelta(active.frame, event.clientX - active.x, event.clientY - active.y);
        const next = dragged(active.drag, delta.x / active.frame.fullW, delta.y / active.frame.fullH,
            { shift: event.shiftKey, fromCentre: event.altKey }, session.width, session.height);
        store.setWindow(next);
    };
    const end = (event: ReactPointerEvent<HTMLElement>) => { if (drag.current?.pointer === event.pointerId) drag.current = null; };
    // A double-click on an edge gives back that side of the original (a corner gives back its two sides), catalogue S§12 "Image":
    // the picture keeps its other sides as they are, so it is one step to undo a cut you have made by hand.
    const resetSide = (handle: { readonly dx: -1 | 0 | 1; readonly dy: -1 | 0 | 1 }) => (event: ReactMouseEvent<HTMLElement>) => {
        event.preventDefault(); event.stopPropagation();
        const live = store.get();
        if (!live) return;
        const win = live.window;
        store.setWindow({ x0: handle.dx < 0 ? 0 : win.x0, y0: handle.dy < 0 ? 0 : win.y0, x1: handle.dx > 0 ? 1 : win.x1, y1: handle.dy > 0 ? 1 : win.y1 });
    };
    const begin = (mode: 'move' | 'edge', dx: -1 | 0 | 1, dy: -1 | 0 | 1) => (event: ReactPointerEvent<HTMLElement>) => {
        if (event.button !== 0) return;
        event.preventDefault(); event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { drag: { mode, dx, dy, origin: session.window }, pointer: event.pointerId, x: event.clientX, y: event.clientY, frame };
    };
    const zoom = clamp(zoomOf(win), 1, CROP_ZOOM_MAX);
    const fullLeft = -frame.cropX0 * frame.fullW * frame.zoom, fullTop = -frame.cropY0 * frame.fullH * frame.zoom;
    const z = frame.zoom;
    const windowStyle = {
        left: (win.x0 - frame.cropX0) * frame.fullW * z, top: (win.y0 - frame.cropY0) * frame.fullH * z,
        width: (win.x1 - win.x0) * frame.fullW * z, height: (win.y1 - win.y0) * frame.fullH * z,
    };
    const aspectOptions: readonly { readonly id: CropAspect; readonly key: string }[] = [
        { id: 'original', key: 'crop.aspect.original' }, { id: 'square', key: 'crop.aspect.square' }, { id: 'circle', key: 'crop.aspect.circle' },
        { id: 'landscape', key: 'crop.aspect.landscape' }, { id: 'portrait', key: 'crop.aspect.portrait' }, { id: 'wide', key: 'crop.aspect.wide' },
    ];
    // The bar is a sibling, not a child: the picture's frame turns with the picture, and the bar must not.
    return (
        <>
        <div ref={root} className="crop-live" style={{ left: frame.originX, top: frame.originY, transform: `rotate(${frame.degrees}deg)` }}>
            <div className="crop-live-frame" style={{ width: frame.w * z, height: frame.h * z, transform: `scale(${frame.flipX ? -1 : 1}, ${frame.flipY ? -1 : 1})` }}>
                {/* An opaque backdrop under the faded original: the board's own picture beneath must not show through the fade. */}
                <div className="crop-live-full" style={{ left: fullLeft, top: fullTop, width: frame.fullW * z, height: frame.fullH * z }}>
                    <img className="crop-live-faded" src={session.url} alt="" draggable={false} />
                </div>
                <div className={`crop-live-window${session.circle ? ' is-circle' : ''}`} style={windowStyle}
                    onPointerDown={begin('move', 0, 0)} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
                    <div className="crop-live-clip">
                        <img className="crop-live-kept" src={session.url} alt="" draggable={false}
                            style={{ left: -win.x0 * frame.fullW * z, top: -win.y0 * frame.fullH * z, width: frame.fullW * z, height: frame.fullH * z }} />
                    </div>
                    {HANDLES.map(handle => (
                        <span key={handle.name} className={`crop-handle crop-handle-${handle.name as CropHandle}`} aria-hidden="true"
                            onPointerDown={begin('edge', handle.dx, handle.dy)} onPointerMove={move} onPointerUp={end} onPointerCancel={end}
                            onDoubleClick={resetSide(handle)} />
                    ))}
                </div>
            </div>
        </div>
        <CropBar anchor={{ x: frame.anchorX, top: frame.anchorY, bottom: frame.anchorBottom }} t={t} aspect={session.aspect}
            zoom={zoom} onAspect={next => store.setAspect(next)} onZoom={value => store.setZoom(value)}
            onFit={() => store.setWindow(fitWhole(session.aspect, session.width, session.height))} onApply={() => leave(true)}
            aspectOptions={aspectOptions} />
        </>
    );
}

interface CropBarProps {
    readonly anchor: FloatingAnchor;
    readonly t: Translate;
    readonly aspect: CropAspect;
    readonly zoom: number;
    readonly aspectOptions: readonly { readonly id: CropAspect; readonly key: string }[];
    readonly onAspect: (aspect: CropAspect) => void;
    readonly onZoom: (zoom: number) => void;
    readonly onFit: () => void;
    readonly onApply: () => void;
}

/** The crop bar: aspect presets, a zoom slider, Fit and Apply. It sits above the picture, unturned, clear of the chrome (floatingBar.ts). */
function CropBar({ anchor, t, aspect, zoom, aspectOptions, onAspect, onZoom, onFit, onApply }: CropBarProps) {
    const bar = useRef<HTMLDivElement>(null);
    useFloatingBar(bar, anchor);
    return (
        <div ref={bar} className="crop-bar" role="toolbar" aria-label={t('crop.aspect')}
            onPointerDown={event => event.stopPropagation()}>
            <label className="crop-field">
                <span className="visually-hidden">{t('crop.aspect')}</span>
                <select className="crop-select" value={aspect} onChange={event => onAspect(event.target.value as CropAspect)}>
                    {aspectOptions.map(option => <option key={option.id} value={option.id}>{t(option.key)}</option>)}
                </select>
            </label>
            <label className="crop-field crop-zoom">
                <span className="visually-hidden">{t('crop.zoom')}</span>
                <input className="crop-range" type="range" min={1} max={CROP_ZOOM_MAX} step={0.01} value={zoom}
                    style={{ '--crop-zoom-fill': `${(zoom - 1) / (CROP_ZOOM_MAX - 1) * 100}%` } as CSSProperties}
                    aria-label={t('crop.zoom')} onChange={event => onZoom(Number(event.target.value))} />
            </label>
            <button type="button" className="crop-bar-btn" data-tooltip={t('crop.fit')} aria-label={t('crop.fit')} onClick={onFit}>
                <LucideGlyph nodes={pictureIcons.fit} size={16} />
            </button>
            <button type="button" className="crop-bar-btn crop-bar-apply" data-tooltip={t('crop.apply')} aria-label={t('crop.apply')} onClick={onApply}>
                <LucideGlyph nodes={pictureIcons.check} size={16} />
            </button>
        </div>
    );
}

export interface NativePictureToolbarProps {
    readonly lease: NativeViewLease;
    readonly media: MediaActions;
    readonly store: PictureCropStore;
    readonly t: Translate;
    readonly isVisible: boolean;
    readonly writable: () => boolean;
    readonly requestText: (question: BoardTextQuestion) => Promise<string | null>;
    readonly onError: (error: unknown) => void;
    readonly notice: (message: string) => void;
}

/** The picture's own toolbar, floating above a single selected picture: replace, crop, download and alternative text. */
export function NativePictureToolbar({ lease, media, store, t, isVisible, writable, requestText, onError, notice }: NativePictureToolbarProps) {
    const runtime = lease.runtime;
    const subscribe = useCallback((listener: () => void) => runtime.selection.subscribe(listener), [runtime]);
    const selection = useSyncExternalStore(subscribe, runtime.selection.getSnapshot);
    const sessionOpen = useSyncExternalStore(store.subscribe, () => store.get() !== null);
    const picture = selection.selected.length === 1 ? media.selection(writable()) : null;
    const id = picture && picture.kind === 'picture' && picture.blocked === null ? picture.id : null;
    const frame = useFrame(lease, id ?? ('' as NodeId), id !== null && isVisible && !sessionOpen);
    const bar = useRef<HTMLDivElement>(null);
    useFloatingBar(bar, frame && { x: frame.anchorX, top: frame.anchorY, bottom: frame.anchorBottom });
    if (!id || !frame || !picture) return null;
    const run = (action: () => void | Promise<void>) => () => {
        // The picture the toolbar was drawn over must still be the one selected; otherwise the press does nothing.
        if (!writable() || runtime.selection.getSnapshot().selected[0] !== id) { notice(t('crop.selectionChanged')); return; }
        try { void Promise.resolve(action()).catch(onError); } catch (error) { onError(error); }
    };
    const replace = run(async () => { const file = await chooseReplacementImage(); if (file) await media.replace(id, file, file.name); });
    const crop = run(() => store.open(id));
    const download = run(() => media.downloadOriginal(id));
    const alt = run(async () => {
        const initial = media.alternativeText(id);
        const value = await requestText({ title: t('chrome.alternativeText'), body: t('crop.altBody'), confirmLabel: t('chrome.save'),
            input: { label: t('chrome.altLabel'), initialValue: initial, validate: text => text.length > 10_000 ? t('chrome.altTooLong') : null } });
        if (value !== null && value !== initial) media.setAlt(id, value);
    });
    return (
        <div ref={bar} className="picture-toolbar" role="toolbar" aria-label={t('chrome.cropImage')}>
            {picture.replaceable && <button type="button" className="picture-toolbar-btn" data-tooltip={t('chrome.replaceMedia')} aria-label={t('chrome.replaceMedia')} onClick={replace}>
                <LucideGlyph nodes={pictureIcons.replace} size={18} /></button>}
            <button type="button" className="picture-toolbar-btn" data-tooltip={t('chrome.cropImage')} aria-label={t('chrome.cropImage')} onClick={crop}>
                <LucideGlyph nodes={pictureIcons.crop} size={18} /></button>
            <button type="button" className="picture-toolbar-btn" data-tooltip={t('chrome.downloadOriginal')} aria-label={t('chrome.downloadOriginal')} onClick={download}>
                <LucideGlyph nodes={pictureIcons.download} size={18} /></button>
            <button type="button" className="picture-toolbar-btn picture-toolbar-text" data-tooltip={t('chrome.alternativeText')} aria-label={t('chrome.alternativeText')} onClick={alt}>ALT</button>
        </div>
    );
}
