// The terminal's dock, under the editor: a row-resize handle and the box the lazy
// TerminalPanel fills. App renders this as a sibling AFTER the main view inside
// `.workspace-main` — outside the graph/editor ternary, so switching to the graph
// never unmounts it — and owns only whether it is open. The height, its limits and
// the drag live here.
//
// MAIN-CHUNK CODE: it must import nothing from xterm. The panel is reached only
// through `lazy`, exactly as the agent panel is, so a user who never opens a
// terminal downloads none of it. (Closing renders null; the shells live in the
// panel chunk's module store, so unmounting this never ends one.)

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';

const TerminalPanel = lazy(() => import('./TerminalPanel'));

const HEIGHT_KEY = 'terminalHeight';
const MIN_HEIGHT = 120;
const DEFAULT_HEIGHT = 300;
/** Of `.workspace-main`: the editor keeps the rest, always. */
const MAX_FRACTION = 0.7;
/** A keystroke's nudge, and Shift's. */
const KEY_STEP = 24;
const KEY_STEP_BIG = 96;

/** Clamped on read: localStorage is user-editable, and a NaN or a negative height
 *  would reach CSS. The upper limit is the window's own (the CSS max-height holds
 *  the live 70% of the workspace, whatever the window does afterwards). */
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
    /** The pointer's and the dock's height when it began. */
    y0: number;
    h0: number;
    max: number;
    /** Latest pointer y, and the height last written. */
    y: number;
    live: number;
    frame: number | null;
    onKey: (e: KeyboardEvent) => void;
}

interface TerminalDockProps {
    open: boolean;
    /** The reader opened it (a click or the chord), as opposed to a dock restored
     *  open with the page: only the former takes the keyboard. */
    takeFocus: boolean;
    onHide: () => void;
}

export default function TerminalDock({ open, takeFocus, onHide }: TerminalDockProps) {
    const [height, setHeight] = useState(readHeight);
    const dockRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef<Drag | null>(null);

    // The live height goes straight onto the dock as a CSS variable and is committed
    // once, on release — the pane divider's way (EditorPane): the terminal re-fits on
    // every size change (a ResizeObserver, once per frame), and a setState per frame
    // would re-render the whole workspace on top of that.
    const write = useCallback((px: number) => {
        dockRef.current?.style.setProperty('--terminal-height', `${px}px`);
    }, []);

    const commit = useCallback((px: number) => {
        setHeight(px);
        try { localStorage.setItem(HEIGHT_KEY, String(px)); } catch { /* not remembered */ }
    }, []);

    /** The most this dock may be right now: 70% of the workspace beside it. */
    const maxHeight = useCallback((): number => {
        const main = dockRef.current?.parentElement;
        const total = main?.getBoundingClientRect().height ?? window.innerHeight;
        return Math.max(MIN_HEIGHT, Math.floor(total * MAX_FRACTION));
    }, []);

    const clamp = useCallback((px: number) => Math.min(maxHeight(), Math.max(MIN_HEIGHT, Math.round(px))), [maxHeight]);

    /**
     * The one way out of a drag, however it ended. A cancel puts the height back by
     * hand (React has not re-rendered during the drag, so nothing else would).
     * Stable for the app's life: the unmount guard below depends on it, and an
     * identity that moved would cancel a live drag on every re-render.
     */
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

    // Hidden, or the whole workspace going away (a vault switch), under a live drag: a
    // handle removed while it holds the capture gets its lostpointercapture at a
    // detached node that reaches no listener, which would leave the body stuck on a
    // row-resize cursor with text selection off for the rest of the session.
    useEffect(() => {
        if (!open && dragRef.current) endDrag(false, false);
    }, [open, endDrag]);
    useEffect(() => () => { if (dragRef.current) endDrag(false, false); }, [endDrag]);

    const startDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
        if (e.button !== 0 || !e.isPrimary || dragRef.current) return;
        const dock = dockRef.current;
        if (!dock) return;
        const handle = e.currentTarget;
        // Capture keeps every later move away from xterm and CodeMirror, and makes a
        // drag that leaves the window still arrive back here.
        handle.setPointerCapture(e.pointerId);
        // Capture does not focus, and the mousedown that would is cancelled below.
        handle.focus({ preventScroll: true });
        handle.classList.add('is-resizing');
        // Capture phase and stopped: the terminal and CodeMirror bind Escape too.
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
        // At most one write per frame, and none when the clamped answer has not moved.
        drag.frame = requestAnimationFrame(() => {
            drag.frame = null;
            // The handle is the dock's TOP edge: dragging up makes it taller.
            const next = Math.min(drag.max, Math.max(MIN_HEIGHT, Math.round(drag.h0 + (drag.y0 - drag.y))));
            if (next === drag.live) return;
            drag.live = next;
            write(next);
        });
    };

    /** Only the gesture's OWN pointer ends it: a second finger on the same strip must not commit the first's drag. */
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
                <Suspense fallback={<div className="workspace-terminal-loading" />}>
                    <TerminalPanel takeFocus={takeFocus} onHide={onHide} />
                </Suspense>
            </div>
        </>
    );
}
