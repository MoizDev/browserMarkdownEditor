/** Moves the keyboard to the board that a chrome control belongs to. Its keys listen on the board's interaction root
 *  (BoardAccessibility), and a popup's trigger sits outside that root, so closing a popup onto its trigger left every
 *  shortcut dead until the board was clicked. */
export function focusBoardInteraction(from: Element | null): void {
    from?.closest('.board-viewer-host')?.querySelector<HTMLElement>('.board-interaction-root')?.focus({ preventScroll: true });
}
