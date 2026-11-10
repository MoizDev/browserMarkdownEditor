// "A rotation of this PDF is in flight", as an external store.
//
// A rotation reads the file, rewrites it in the build worker and writes it
// back — over a second on a 1,000-page book — and nothing on screen moved until
// it landed, so users read the wait as "rotate does nothing" and clicked again.
// The reader's rotate buttons show this while it is pending.
//
// A store, not a prop: App owns the rotation, and threading a flag down would
// re-render the whole pane host for it, twice per turn. The viewer subscribes
// for its own path and nothing else re-renders.
//
// A COUNT per path, not a flag: rotations queue on the tab's save chain, so two
// quick clicks are two quarter turns in flight, and the first landing must not
// clear the busy state while the second is still running.

const pending = new Map<string, number>();
const listeners = new Set<() => void>();

function emit(): void {
    for (const listener of listeners) listener();
}

/** A rotation of `path` has been accepted onto its tab's chain. */
export function beginPdfRotation(path: string): void {
    pending.set(path, (pending.get(path) ?? 0) + 1);
    emit();
}

/** That rotation has finished, whichever way it ended. */
export function endPdfRotation(path: string): void {
    const left = (pending.get(path) ?? 0) - 1;
    if (left > 0) pending.set(path, left);
    else pending.delete(path);
    emit();
}

export function isPdfRotating(path: string): boolean {
    return pending.has(path);
}

export function subscribePdfRotating(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
