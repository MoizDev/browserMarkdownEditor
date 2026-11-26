/** Two pen taps make one double-tap within this time of each other (the platforms' default double-click time)... */
const PEN_DOUBLE_TAP_MS = 500;
/** ...when the second lands within this many CSS px of the first: a pen tip lands a few px off each time. */
const PEN_DOUBLE_TAP_CSS = 16;
/** A tap that travels this far is a drag, and starts no double-tap (input/tool.ts CLICK_SLOP_CSS). */
const TAP_SLOP_CSS = 8;

/**
 * A pen's double-tap on a board, decided by the board rather than by the browser. Chromium raises `dblclick` only for a second
 * click within the system's double-click rectangle, sized for a mouse (4 px on Windows), and a pen's tip lands further off than
 * that between two quick taps: every board control that acts on a double-click (an arrow end's head, a picture's crop, a crop
 * edge, a frame's edge, the minimap, the zoom box, a sheet's name) then did nothing for a pen, or did it only now and then.
 * Here a pen's second tap within 500 ms and 16 px of the first, on the same element, neither of them dragged, raises one `dblclick` where its
 * `click` landed, just after that click, as the browser would; the browser's own `dblclick` after pen taps is withheld, so a
 * double-tap acts exactly once whether or not the browser saw one. A mouse and a finger keep the browser's own.
 */
export function installPenDoubleClick(root: HTMLElement): () => void {
    let press: { readonly id: number; readonly x: number; readonly y: number; readonly time: number; readonly taps: number; dragged: boolean } | null = null;
    let lastKind: string | null = null;
    /** Where the run's first tap clicked. A double-tap is two clicks on one thing, as the browser's own: counted by position
     * alone, a pen's tap on a bar button and a tap on the paper beside it within 16 px made a double-click on the paper, which
     * with Select starts a new text there. */
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
    // A press the system took back (a pointercancel: palm rejection, a system gesture) made no click, and is no tap of a run.
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
    // At the window on the way back up, so every listener of the click itself, React's included, has run first: the browser's own
    // dblclick follows the click's whole dispatch.
    window.addEventListener('click', click);
    return () => {
        root.removeEventListener('pointerdown', down, true);
        root.removeEventListener('pointermove', move, true);
        root.removeEventListener('pointercancel', cancel, true);
        root.removeEventListener('dblclick', doubleClick, true);
        window.removeEventListener('click', click);
    };
}
