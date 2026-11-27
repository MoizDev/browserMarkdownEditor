export function focusBoardInteraction(from: Element | null): void {
    boardInteractionRoot(from)?.focus({ preventScroll: true });
}

export function boardInteractionRoot(from: Element | null): HTMLElement | null {
    return from?.closest('.board-viewer-host')?.querySelector<HTMLElement>('.board-interaction-root') ?? null;
}

export function returnBoardFocusIfLost(host: Element | null): void {
    setTimeout(() => {
        const active = document.activeElement;
        if (!active || active === document.body) focusBoardInteraction(host);
    }, 0);
}
