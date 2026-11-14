export type PdfSelectionGranularity = 'char' | 'word' | 'line';

/** The viewer owns the camera, page lookup, selection model and context menu. */
export interface PdfTextInputHost<Point> {
    hit(clientX: number, clientY: number, priority: 0 | 2, signal: AbortSignal): Promise<Point | null>;
    isLink(target: EventTarget | null): boolean;
    hasSelection(): boolean;
    overText(clientX: number, clientY: number, signal: AbortSignal): Promise<boolean>;
    setSelecting(active: boolean): void;
    begin(point: Point, granularity: PdfSelectionGranularity, extend: boolean): void;
    extend(point: Point): void;
    clear(): void;
    /** For keyboard invocation, the host anchors at the selection end or current page. */
    contextMenu(clientX: number, clientY: number, keyboard: boolean): void;
    /** CSS pixels per second; zero on either axis stops that axis. */
    autoScroll(x: number, y: number): void;
}
export interface PdfTextInputBinding {
    /** The camera can move while the pointer is still at an edge. */
    refreshPointer(): void;
    dispose(): void;
}
interface Drag<Point> {
    id: number; touch: boolean; x: number; y: number; startX: number; startY: number;
    shift: boolean; granularity: PdfSelectionGranularity; dragging: boolean; held: boolean; begun: boolean; ended: boolean;
    origin: Promise<Point | null>; abort: AbortController; sequence: number; timer?: number;
}
function edgeSpeed(position: number, start: number, end: number): number {
    const edge = 24;
    const delta = position < start + edge ? position - (start + edge) : position > end - edge ? position - (end - edge) : 0;
    return delta ? Math.sign(delta) * Math.max(60, Math.min(2400, Math.abs(delta) * 12)) : 0;
}

/** Bind once to the tiled PDF surface; text and geometry stay in its owner. */
export function bindPdfTextInput<Point>(element: HTMLElement, host: PdfTextInputHost<Point>): PdfTextInputBinding {
    let drag: Drag<Point> | null = null, lastClick = 0, lastX = 0, lastY = 0, clicks = 0;
    let hoverFrame = 0, hoverAbort: AbortController | null = null, hoverSequence = 0;
    const stop = (active: Drag<Point>) => {
        if (active.timer !== undefined) window.clearTimeout(active.timer);
        active.abort.abort(); host.autoScroll(0, 0); host.setSelecting(false);
        if (element.hasPointerCapture(active.id)) element.releasePointerCapture(active.id);
        if (drag === active) drag = null;
    };
    const begin = async (active: Drag<Point>) => {
        const point = await active.origin;
        if (!point || drag !== active || active.abort.signal.aborted) return null;
        if (!active.begun) {
            active.begun = true;
            host.begin(point, active.held ? 'word' : active.granularity, active.shift && host.hasSelection());
        }
        return point;
    };
    const update = (active: Drag<Point>) => {
        if (!active.dragging && !active.held) return;
        const sequence = ++active.sequence, x = active.x, y = active.y;
        void begin(active).then(async origin => {
            if (!origin || drag !== active || active.abort.signal.aborted) return;
            const point = await host.hit(x, y, 0, active.abort.signal);
            if (point && drag === active && active.sequence === sequence && !active.abort.signal.aborted) host.extend(point);
        }).catch(() => {});
        const box = element.getBoundingClientRect();
        host.autoScroll(edgeSpeed(x, box.left, box.right), edgeSpeed(y, box.top, box.bottom));
    };
    const down = (event: PointerEvent) => {
        if (event.button !== 0 || event.ctrlKey || host.isLink(event.target)) return;
        if (drag?.ended) stop(drag);
        if (drag) return;
        const touch = event.pointerType === 'touch', now = performance.now();
        if (!touch && now - lastClick < 500 && Math.hypot(event.clientX - lastX, event.clientY - lastY) < 5) clicks = clicks % 3 + 1;
        else clicks = 1;
        lastClick = now; lastX = event.clientX; lastY = event.clientY;
        const granularity: PdfSelectionGranularity = clicks === 2 ? 'word' : clicks === 3 ? 'line' : 'char';
        const abort = new AbortController();
        const active: Drag<Point> = { id: event.pointerId, touch, x: event.clientX, y: event.clientY,
            startX: event.clientX, startY: event.clientY, shift: event.shiftKey,
            granularity, dragging: false, held: false, begun: false, ended: false,
            origin: host.hit(event.clientX, event.clientY, 0, abort.signal).catch(() => null), abort, sequence: 0 };
        drag = active;
        if (!touch && granularity !== 'char') void begin(active);
        if (touch) {
            active.timer = window.setTimeout(() => {
                if (drag !== active) return;
                active.held = true; active.granularity = 'word'; host.setSelecting(true);
                element.setPointerCapture(active.id);
                void begin(active);
            }, 500);
        } else {
            event.preventDefault(); element.setPointerCapture(active.id);
        }
    };
    const move = (event: PointerEvent) => {
        const active = drag;
        if (!active || active.id !== event.pointerId) {
            if (event.pointerType === 'touch' || hoverFrame) return;
            const x = event.clientX, y = event.clientY;
            hoverFrame = requestAnimationFrame(() => {
                hoverFrame = 0; hoverAbort?.abort(); hoverAbort = new AbortController();
                const sequence = ++hoverSequence, signal = hoverAbort.signal;
                void host.overText(x, y, signal).then(over => { if (!signal.aborted && sequence === hoverSequence) element.style.cursor = over ? 'text' : ''; }).catch(() => {});
            });
            return;
        }
        active.x = event.clientX; active.y = event.clientY;
        if (Math.hypot(active.x - active.startX, active.y - active.startY) >= 4) {
            if (active.touch && !active.held) { stop(active); return; }
            if (!active.dragging) {
                active.dragging = true; host.setSelecting(true);
                void begin(active);
            }
        }
        update(active);
    };
    const up = (event: PointerEvent) => {
        const active = drag;
        if (!active || active.id !== event.pointerId) return;
        if (active.timer !== undefined) window.clearTimeout(active.timer);
        active.ended = true; host.autoScroll(0, 0);
        if (!active.dragging && !active.held && active.granularity === 'char') {
            if (active.shift && host.hasSelection()) {
                void active.origin.then(point => { if (point && drag === active) host.extend(point); }).finally(() => stop(active));
            } else { host.clear(); stop(active); }
        } else {
            // Keep the last hit alive until it resolves; a newer gesture can
            // still cancel this one rather than publishing into another page.
            const sequence = ++active.sequence;
            void begin(active).then(async point => {
                if (!point || drag !== active || active.abort.signal.aborted) return;
                if (active.dragging || active.held) {
                    const last = await host.hit(active.x, active.y, 0, active.abort.signal);
                    if (last && drag === active && sequence === active.sequence) host.extend(last);
                }
            }).catch(() => {}).finally(() => stop(active));
        }
    };
    const cancel = (event: PointerEvent) => { if (drag?.id === event.pointerId) stop(drag); };
    const menu = (event: MouseEvent) => { event.preventDefault(); host.contextMenu(event.clientX, event.clientY, false); };
    const key = (event: KeyboardEvent) => {
        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
        const target = event.target as HTMLElement | null;
        if (target?.closest('input, textarea, [contenteditable="true"], [role="dialog"], [role="menu"]')) return;
        event.preventDefault(); host.contextMenu(0, 0, true);
    };
    const leave = () => { if (!drag) { if (hoverFrame) cancelAnimationFrame(hoverFrame); hoverFrame = 0; hoverAbort?.abort(); ++hoverSequence; element.style.cursor = ''; } };
    element.addEventListener('pointerdown', down); element.addEventListener('pointermove', move);
    element.addEventListener('pointerleave', leave); element.addEventListener('keydown', key);
    element.addEventListener('pointerup', up); element.addEventListener('pointercancel', cancel);
    element.addEventListener('contextmenu', menu);
    return {
        refreshPointer: () => { if (drag) update(drag); },
        dispose() {
            if (drag) stop(drag);
            if (hoverFrame) cancelAnimationFrame(hoverFrame);
            hoverAbort?.abort(); element.style.cursor = '';
            element.removeEventListener('pointerdown', down); element.removeEventListener('pointermove', move);
            element.removeEventListener('pointerup', up); element.removeEventListener('pointercancel', cancel);
            element.removeEventListener('pointerleave', leave); element.removeEventListener('keydown', key);
            element.removeEventListener('contextmenu', menu);
        },
    };
}
