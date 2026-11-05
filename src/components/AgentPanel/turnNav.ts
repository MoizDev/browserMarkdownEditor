// ⌘↑ / ⌘↓ from wherever the keyboard is: the conversation handles them when it
// has focus, but the keyboard is nearly always in the composer, which cannot
// reach the list's scroller. The composer asks here; MessageList, the one
// that knows where the turns are and its own pending scroll target, listens.
// A plain module-level signal (like editRequest.ts) so neither imports the
// other: a request with no subscriber (no conversation mounted) is dropped,
// never queued.

export type TurnJumpDir = -1 | 1;

const listeners = new Set<(dir: TurnJumpDir) => void>();

/** Step to the previous (-1) or next (1) turn of the conversation on screen. */
export function requestTurnJump(dir: TurnJumpDir): void {
    for (const listener of [...listeners]) listener(dir);
}

export function subscribeTurnJump(cb: (dir: TurnJumpDir) => void): () => void {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
}
