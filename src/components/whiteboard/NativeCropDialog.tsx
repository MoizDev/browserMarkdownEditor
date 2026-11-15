import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

/** A window on the original picture, 0..1 on each axis. */
export interface CropWindow { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }
type Aspect = 'original' | 'square' | 'circle' | 'landscape' | 'portrait' | 'wide';
const RATIOS: Readonly<Record<Exclude<Aspect, 'original'>, number>> = { square: 1, circle: 1, landscape: 4 / 3, portrait: 3 / 4, wide: 16 / 9 };
const ASPECTS: readonly { readonly id: Aspect; readonly label: string }[] = [
    { id: 'original', label: 'Original' }, { id: 'square', label: 'Square (1:1)' }, { id: 'circle', label: 'Circle (1:1)' },
    { id: 'landscape', label: 'Landscape (4:3)' }, { id: 'portrait', label: 'Portrait (3:4)' }, { id: 'wide', label: 'Wide (16:9)' },
];
const WHOLE: CropWindow = { x0: 0, y0: 0, x1: 1, y1: 1 };
const MIN_SIDE = 0.02;
const HANDLES: readonly { readonly name: string; readonly dx: -1 | 0 | 1; readonly dy: -1 | 0 | 1 }[] = [
    { name: 'nw', dx: -1, dy: -1 }, { name: 'n', dx: 0, dy: -1 }, { name: 'ne', dx: 1, dy: -1 }, { name: 'e', dx: 1, dy: 0 },
    { name: 'se', dx: 1, dy: 1 }, { name: 's', dx: 0, dy: 1 }, { name: 'sw', dx: -1, dy: 1 }, { name: 'w', dx: -1, dy: 0 },
];

function clamp(value: number, low: number, high: number): number { return Math.min(high, Math.max(low, value)); }
/** Moves a window inside the picture, keeping its size. */
function within(win: CropWindow): CropWindow {
    const width = win.x1 - win.x0, height = win.y1 - win.y0;
    const x0 = clamp(win.x0, 0, 1 - width), y0 = clamp(win.y0, 0, 1 - height);
    return { x0, y0, x1: x0 + width, y1: y0 + height };
}
/** The largest window of `ratio` (in pixels) that fits the current one and keeps its centre. */
function fit(win: CropWindow, ratio: number, width: number, height: number): CropWindow {
    const cx = (win.x0 + win.x1) / 2, cy = (win.y0 + win.y1) / 2;
    let w = (win.x1 - win.x0) * width, h = (win.y1 - win.y0) * height;
    if (w / h > ratio) w = h * ratio; else h = w / ratio;
    const hw = w / width / 2, hh = h / height / 2;
    return within({ x0: cx - hw, y0: cy - hh, x1: cx + hw, y1: cy + hh });
}
/** Magnification of the source: 1 is the whole picture, 3 is a third of its longer side. */
function zoomOf(win: CropWindow): number { return 1 / Math.max(win.x1 - win.x0, win.y1 - win.y0); }
function withZoom(win: CropWindow, zoom: number): CropWindow {
    const cx = (win.x0 + win.x1) / 2, cy = (win.y0 + win.y1) / 2;
    const k = (1 / zoom) / Math.max(win.x1 - win.x0, win.y1 - win.y0);
    const hw = (win.x1 - win.x0) * k / 2, hh = (win.y1 - win.y0) * k / 2;
    return within({ x0: cx - hw, y0: cy - hh, x1: cx + hw, y1: cy + hh });
}

interface Drag {
    readonly mode: 'move' | 'edge';
    readonly dx: -1 | 0 | 1;
    readonly dy: -1 | 0 | 1;
    readonly pointer: number;
    readonly x: number;
    readonly y: number;
    readonly origin: CropWindow;
}
/** The window a drag produces, from where it began and the total movement so far (in picture fractions). */
function dragged(drag: Drag, ddx: number, ddy: number): CropWindow {
    const origin = drag.origin;
    if (drag.mode === 'move') return within({ x0: origin.x0 + ddx, y0: origin.y0 + ddy, x1: origin.x1 + ddx, y1: origin.y1 + ddy });
    let { x0, y0, x1, y1 } = origin;
    if (drag.dx < 0) x0 = clamp(origin.x0 + ddx, 0, origin.x1 - MIN_SIDE);
    if (drag.dx > 0) x1 = clamp(origin.x1 + ddx, origin.x0 + MIN_SIDE, 1);
    if (drag.dy < 0) y0 = clamp(origin.y0 + ddy, 0, origin.y1 - MIN_SIDE);
    if (drag.dy > 0) y1 = clamp(origin.y1 + ddy, origin.y0 + MIN_SIDE, 1);
    return { x0, y0, x1, y1 };
}

export interface NativeCropDialogProps {
    readonly url: string;
    /** The original picture's pixel size: the window's proportions are measured in these. */
    readonly width: number;
    readonly height: number;
    readonly initial: CropWindow;
    readonly initialCircle: boolean;
    readonly onConfirm: (window: CropWindow, circle: boolean) => void;
    readonly onCancel: () => void;
}

/**
 * The picture's crop editor: drag the window's edges or its body, pick an aspect ratio, zoom, then Confirm. The window
 * is shown over the whole original, so cropping never loses what was cut away. It uses the app's confirm-dialog shell
 * and its own colours, so both themes follow the app's variables.
 */
export function NativeCropDialog({ url, width, height, initial, initialCircle, onConfirm, onCancel }: NativeCropDialogProps) {
    const titleId = useId();
    const [win, setWin] = useState<CropWindow>(initial);
    const [circle, setCircle] = useState(initialCircle);
    const [aspect, setAspect] = useState<Aspect>(initialCircle ? 'circle' : 'original');
    const stage = useRef<HTMLDivElement | null>(null), confirmButton = useRef<HTMLButtonElement | null>(null);
    const drag = useRef<Drag | null>(null);
    const [opener] = useState(() => document.activeElement as HTMLElement | null);
    const cancel = useRef(onCancel);
    useEffect(() => { cancel.current = onCancel; });
    // Capture and stopped, as the app's other modals are: the editor behind must not also act on the same Escape.
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault(); event.stopPropagation(); cancel.current();
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
    }, []);
    useEffect(() => { confirmButton.current?.focus(); }, []);
    useEffect(() => () => { if (opener?.isConnected) opener.focus(); }, [opener]);

    const begin = (mode: 'move' | 'edge', dx: -1 | 0 | 1, dy: -1 | 0 | 1) => (event: ReactPointerEvent<HTMLElement>) => {
        if (event.button !== 0) return;
        event.preventDefault(); event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { mode, dx, dy, pointer: event.pointerId, x: event.clientX, y: event.clientY, origin: win };
    };
    const move = (event: ReactPointerEvent<HTMLElement>) => {
        const active = drag.current, box = stage.current?.getBoundingClientRect();
        if (!active || active.pointer !== event.pointerId || !box || box.width <= 0 || box.height <= 0) return;
        let next = dragged(active, (event.clientX - active.x) / box.width, (event.clientY - active.y) / box.height);
        // A circle is a square window: a drag keeps it square about its centre.
        if (circle) next = fit(next, 1, width, height);
        setWin(next);
    };
    const end = (event: ReactPointerEvent<HTMLElement>) => { if (drag.current?.pointer === event.pointerId) drag.current = null; };

    const choose = (next: Aspect) => {
        setAspect(next);
        if (next === 'original') { setWin(WHOLE); setCircle(false); return; }
        setCircle(next === 'circle');
        setWin(fit(win, RATIOS[next], width, height));
    };
    const zoom = clamp(zoomOf(win), 1, 3);

    return (
        <div className="confirm-overlay crop-overlay" onMouseDown={() => cancel.current()}>
            <div className="confirm-dialog crop-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}
                onMouseDown={event => event.stopPropagation()}>
                <h3 className="confirm-title" id={titleId}>Crop image</h3>
                <div className="crop-stage" ref={stage}>
                    <img className="crop-image" src={url} alt="" draggable={false} />
                    <div className={`crop-window${circle ? ' crop-window-circle' : ''}`}
                        style={{ left: `${win.x0 * 100}%`, top: `${win.y0 * 100}%`, width: `${(win.x1 - win.x0) * 100}%`, height: `${(win.y1 - win.y0) * 100}%` }}
                        onPointerDown={begin('move', 0, 0)} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
                        {HANDLES.map(handle => (
                            <span key={handle.name} className={`crop-handle crop-handle-${handle.name}`} aria-hidden="true"
                                onPointerDown={begin('edge', handle.dx, handle.dy)} />
                        ))}
                    </div>
                </div>
                <div className="crop-controls">
                    <label className="crop-field">
                        <span>Aspect ratio</span>
                        <select className="crop-select" value={aspect} onChange={event => choose(event.target.value as Aspect)}>
                            {ASPECTS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
                        </select>
                    </label>
                    <label className="crop-field">
                        <span>Zoom</span>
                        <input className="crop-range" type="range" min={1} max={3} step={0.01} value={zoom}
                            onChange={event => setWin(withZoom(win, Number(event.target.value)))} />
                    </label>
                </div>
                <div className="confirm-actions">
                    <button className="confirm-btn" onClick={() => cancel.current()}>Cancel</button>
                    <button ref={confirmButton} className="confirm-btn" onClick={() => onConfirm(win, circle)}>Confirm</button>
                </div>
            </div>
        </div>
    );
}
