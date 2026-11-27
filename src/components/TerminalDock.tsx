import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { writeStoredValue } from '../utils/storage';
import { moduleSlot } from './moduleSlot';
import { ErrorBoundary, PartFailureBox } from './ErrorBoundary';

const TerminalPanel = moduleSlot(() => import('./TerminalPanel')).View;

const HEIGHT_KEY = 'terminalHeight';
const MIN_HEIGHT = 120;
const DEFAULT_HEIGHT = 300;
const MAX_FRACTION = 0.7;
const KEY_STEP = 24;
const KEY_STEP_BIG = 96;

function readHeight(): number {
    try {
        const n = Number(localStorage.getItem(HEIGHT_KEY));
        if (Number.isFinite(n) && n > 0) return Math.min(Math.max(Math.round(n), MIN_HEIGHT), 4000);
    } catch { /* storage blocked */ }
    return DEFAULT_HEIGHT;
}

interface Drag {
    handle: HTMLElement;
    pointerId: number;
    y0: number;
    h0: number;
    max: number;
    y: number;
    live: number;
    frame: number | null;
    onKey: (e: KeyboardEvent) => void;
}

interface TerminalDockProps {
    open: boolean;
    takeFocus: boolean;
    onHide: () => void;
}

export default function TerminalDock({ open, takeFocus, onHide }: TerminalDockProps) {
    const [height, setHeight] = useState(readHeight);
    const dockRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef<Drag | null>(null);

    const write = useCallback((px: number) => {
        dockRef.current?.style.setProperty('--terminal-height', `${px}px`);
    }, []);

    const commit = useCallback((px: number) => {
        setHeight(px);
        writeStoredValue(HEIGHT_KEY, String(px));
    }, []);

    const maxHeight = useCallback((): number => {
        const main = dockRef.current?.parentElement;
        const total = main?.getBoundingClientRect().height ?? window.innerHeight;
        return Math.max(MIN_HEIGHT, Math.floor(total * MAX_FRACTION));
    }, []);

    const clamp = useCallback((px: number) => Math.min(maxHeight(), Math.max(MIN_HEIGHT, Math.round(px))), [maxHeight]);

    const endDrag = useCallback((commitIt: boolean, restore = true) => {
        const drag = dragRef.current;
        if (!drag) return;
        dragRef.current = null;
        if (drag.frame !== null) cancelAnimationFrame(drag.frame);
        if (drag.handle.hasPointerCapture?.(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId);
        drag.handle.classList.remove('is-resizing');
        window.removeEventListener('keydown', drag.onKey, true);
        document.body.classList.remove('is-resizing-terminal');
        if (commitIt) commit(drag.live);
        else if (restore) write(drag.h0);
    }, [commit, write]);

    useEffect(() => {
        if (!open && dragRef.current) endDrag(false, false);
    }, [open, endDrag]);
    useEffect(() => () => { if (dragRef.current) endDrag(false, false); }, [endDrag]);

    const startDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
        if (e.button !== 0 || !e.isPrimary || dragRef.current) return;
        const dock = dockRef.current;
        if (!dock) return;
        const handle = e.currentTarget;
        handle.setPointerCapture(e.pointerId);
        handle.focus({ preventScroll: true });
        handle.classList.add('is-resizing');
        const onKey = (ev: KeyboardEvent) => {
            if (ev.key !== 'Escape') return;
            ev.preventDefault();
            ev.stopPropagation();
            endDrag(false);
        };
        window.addEventListener('keydown', onKey, true);
        document.body.classList.add('is-resizing-terminal');
        const h0 = Math.round(dock.getBoundingClientRect().height);
        dragRef.current = { handle, pointerId: e.pointerId, y0: e.clientY, h0, max: maxHeight(), y: e.clientY, live: h0, frame: null, onKey };
    };

    const moveDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (!drag || e.pointerId !== drag.pointerId) return;
        drag.y = e.clientY;
        if (drag.frame !== null) return;
        drag.frame = requestAnimationFrame(() => {
            drag.frame = null;
            const next = Math.min(drag.max, Math.max(MIN_HEIGHT, Math.round(drag.h0 + (drag.y0 - drag.y))));
            if (next === drag.live) return;
            drag.live = next;
            write(next);
        });
    };

    const endsGesture = (e: ReactPointerEvent<HTMLDivElement>) => e.pointerId === dragRef.current?.pointerId;

    const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
        const dir = e.key === 'ArrowUp' ? 1 : e.key === 'ArrowDown' ? -1 : 0;
        if (!dir) return;
        e.preventDefault();
        const current = Math.round(dockRef.current?.getBoundingClientRect().height ?? height);
        commit(clamp(current + dir * (e.shiftKey ? KEY_STEP_BIG : KEY_STEP)));
    };

    if (!open) return null;

    const style = { '--terminal-height': `${height}px` } as CSSProperties;
    return (
        <>
            <div
                className="terminal-resize-handle"
                role="separator"
                aria-orientation="horizontal"
                aria-label="Resize the terminal"
                aria-valuenow={height}
                aria-valuemin={MIN_HEIGHT}
                tabIndex={0}
                data-terminal=""
                data-tooltip="Drag to resize · double-click to reset"
                data-tooltip-position="top"
                onPointerDown={startDrag}
                onPointerMove={moveDrag}
                onPointerUp={(e) => { if (endsGesture(e)) endDrag(true); }}
                onPointerCancel={(e) => { if (endsGesture(e)) endDrag(false); }}
                onLostPointerCapture={(e) => { if (endsGesture(e)) endDrag(false); }}
                onKeyDown={onKeyDown}
                // Not on pointerdown: cancelling that would suppress the compatibility
                // mouse events, and with them the double-click this reset hangs off.
                onMouseDown={(e) => e.preventDefault()}
                onDoubleClick={() => commit(DEFAULT_HEIGHT)}
            />
            <div className="workspace-terminal" ref={dockRef} style={style} data-terminal="">
                <ErrorBoundary label="The terminal" fallback={(error, retry) => <PartFailureBox error={error} retry={retry} what="the terminal" />}>
                    <TerminalPanel fallback={<div className="workspace-terminal-loading" />} takeFocus={takeFocus} onHide={onHide} />
                </ErrorBoundary>
            </div>
        </>
    );
}
