// Today's canvas engine admits a pinch mid-pen and never finishes the stroke
// (W-00: WB/NB omit it on disk; PDF saves it incomplete, then joins the next pen).
// Install before rendering so the permanent pointer gate precedes the library's
// window listeners, including when the canvas arrives through a lazy chunk.
let installed = false;

export function installPenPriority(): void {
    if (installed) return;
    installed = true;

    const pens = new Set<number>();
    // Pointer ids and Touch.identifier are different namespaces. Both streams
    // must be stopped; neither id can be used to stand in for the other.
    const stoppedPointers = new Set<number>();
    const stoppedTouches = new Set<number>();
    const touchTypes = ['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const;
    const touchOptions = { capture: true, passive: false } as const;
    let touchListening = false;
    const insideLegacyBoard = (target: EventTarget | null): boolean =>
        target instanceof Element && target.closest('[data-legacy-board]') !== null;
    const stop = (event: Event): void => {
        event.stopImmediatePropagation();
        if (event.cancelable) event.preventDefault();
    };

    const onPointer = (event: PointerEvent): void => {
        if (event.pointerType !== 'pen' && pens.size === 0 && stoppedPointers.size === 0 && stoppedTouches.size === 0) return;
        if (event.pointerType === 'pen') {
            if (event.type === 'pointerdown' && insideLegacyBoard(event.target)) {
                pens.add(event.pointerId);
                syncTouchListeners();
            } else if (event.type === 'pointerup' || event.type === 'pointercancel') {
                // Release wherever it lands, even after leaving the pane.
                pens.delete(event.pointerId);
                syncTouchListeners();
            }
            return;
        }
        if (event.pointerType !== 'touch') return;
        if (event.type === 'pointerdown' && pens.size > 0 && insideLegacyBoard(event.target)) {
            stoppedPointers.add(event.pointerId);
        }
        if (!stoppedPointers.has(event.pointerId)) return;
        stop(event);
        if (event.type === 'pointerup' || event.type === 'pointercancel') {
            stoppedPointers.delete(event.pointerId);
        }
    };

    const onTouch = (event: TouchEvent): void => {
        if (pens.size === 0 && stoppedPointers.size === 0 && stoppedTouches.size === 0) return;
        if (event.type === 'touchstart' && pens.size > 0 && insideLegacyBoard(event.target)) {
            for (const touch of event.changedTouches) stoppedTouches.add(touch.identifier);
        }
        let stopped = false;
        for (const touch of event.changedTouches) {
            if (!stoppedTouches.has(touch.identifier)) continue;
            stopped = true;
            if (event.type === 'touchend' || event.type === 'touchcancel') {
                stoppedTouches.delete(touch.identifier);
            }
        }
        // Never clear at pen-up: a palm that started under the pen remains a
        // rejected contact until its own end, not a fresh gesture after pen-up.
        if (stopped) stop(event);
        syncTouchListeners();
    };

    function syncTouchListeners(): void {
        const needed = pens.size > 0 || stoppedTouches.size > 0;
        if (needed === touchListening) return;
        touchListening = needed;
        // Chrome waits on non-passive window touch listeners even when they
        // return immediately. Do not make a Markdown scroll wait for this pen
        // guard; keep it armed only until the last rejected touch ends.
        for (const type of touchTypes) {
            if (needed) window.addEventListener(type, onTouch, touchOptions);
            else window.removeEventListener(type, onTouch, touchOptions);
        }
    }

    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'] as const) {
        window.addEventListener(type, onPointer, { capture: true, passive: false });
    }
}
