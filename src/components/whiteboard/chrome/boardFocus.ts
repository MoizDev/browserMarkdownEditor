/** Moves the keyboard to the board that a chrome control belongs to. Its keys listen on the board's interaction root
 *  (BoardAccessibility), and a popup's trigger sits outside that root, so closing a popup onto its trigger left every
 *  shortcut dead until the board was clicked. */
export function focusBoardInteraction(from: Element | null): void {
    from?.closest('.board-viewer-host')?.querySelector<HTMLElement>('.board-interaction-root')?.focus({ preventScroll: true });
}

/** A control that ends by leaving the DOM (Apply, or a press that commits a crop) takes the focus down with it, and the board
 *  is only re-rendered once the event has settled. Measured: a pointer Apply left the focus on BODY, so the board's keys were
 *  dead until a click. Runs after the press's own focus change, and only when that change left the focus nowhere. */
export function returnBoardFocusIfLost(host: Element | null): void {
    setTimeout(() => {
        const active = document.activeElement;
        if (!active || active === document.body) focusBoardInteraction(host);
    }, 0);
}
