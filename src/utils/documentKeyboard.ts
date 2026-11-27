type Listener = (path: string) => void;
const listeners = new Set<Listener>();

export function requestDocumentKeyboard(path: string): void {
    for (const listener of [...listeners]) listener(path);
}

export function subscribeDocumentKeyboard(listener: Listener): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
