// "Edit my last message", asked from one component and done by another: ↑ in
// an empty composer (Composer) opens the last user message of the visible
// branch for editing (MessageList / UserMessage). The two
// share no parent state worth threading a callback through, so it is a signal
// with no payload — the subscriber knows which message is last and whether a
// reply is running (then it does nothing: an edit cannot start mid-run).
//
// A module store like chatStore, outside React: a request with no subscriber
// (no conversation mounted) is simply dropped, never queued for later.

const listeners = new Set<() => void>();

export function requestEditLast(): void {
    for (const listener of [...listeners]) listener();
}

export function subscribeEditRequest(cb: () => void): () => void {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
}
