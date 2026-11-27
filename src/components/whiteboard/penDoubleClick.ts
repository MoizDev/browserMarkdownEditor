const PEN_DOUBLE_TAP_MS = 500;
const PEN_DOUBLE_TAP_CSS = 16;
const TAP_SLOP_CSS = 8;

export function installPenDoubleClick(root: HTMLElement): () => void {
    let press: { readonly id: number; readonly x: number; readonly y: number; readonly time: number; readonly taps: number; dragged: boolean } | null = null;
    let lastKind: string | null = null;
    let firstClick: EventTarget | null = null;
    const ours = new WeakSet<Event>();
    const down = (event: PointerEvent) => {
        lastKind = event.pointerType;
        if (event.pointerType !== 'pen') { press = null; return; }
        if (event.button !== 0) return;
        const previous = press;
        const again = !!previous && !previous.dragged && event.timeStamp >= previous.time && event.timeStamp - previous.time <= PEN_DOUBLE_TAP_MS
            && Math.hypot(event.clientX - previous.x, event.clientY - previous.y) <= PEN_DOUBLE_TAP_CSS;
        press = { id: event.pointerId, x: event.clientX, y: event.clientY, time: event.timeStamp, taps: again ? previous.taps + 1 : 1, dragged: false };
    };
    const move = (event: PointerEvent) => {
        if (press && !press.dragged && event.pointerId === press.id && event.buttons !== 0
            && Math.hypot(event.clientX - press.x, event.clientY - press.y) >= TAP_SLOP_CSS) press.dragged = true;
    };
    const cancel = (event: PointerEvent) => { if (press?.id === event.pointerId) press.dragged = true; };
    const click = (event: MouseEvent) => {
        const tap = press;
        if ((event as PointerEvent).pointerType !== 'pen' || !tap) return;
        const first = tap.taps === 1;
        const same = firstClick === event.target;
        firstClick = first ? event.target : null;
        if (tap.taps !== 2 || !same || tap.dragged || !(event.target instanceof Element) || !root.contains(event.target)) return;
        const double = new MouseEvent('dblclick', { bubbles: true, cancelable: true, composed: true, view: window, detail: 2,
            clientX: event.clientX, clientY: event.clientY, screenX: event.screenX, screenY: event.screenY, button: 0, buttons: 0,
            shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, altKey: event.altKey, metaKey: event.metaKey });
        ours.add(double);
        event.target.dispatchEvent(double);
    };
    const doubleClick = (event: MouseEvent) => {
        if (ours.has(event) || lastKind !== 'pen') return;
        event.stopImmediatePropagation(); event.preventDefault();
    };
    root.addEventListener('pointerdown', down, true);
    root.addEventListener('pointermove', move, true);
    root.addEventListener('pointercancel', cancel, true);
    root.addEventListener('dblclick', doubleClick, true);
    window.addEventListener('click', click);
    return () => {
        root.removeEventListener('pointerdown', down, true);
        root.removeEventListener('pointermove', move, true);
        root.removeEventListener('pointercancel', cancel, true);
        root.removeEventListener('dblclick', doubleClick, true);
        window.removeEventListener('click', click);
    };
}
