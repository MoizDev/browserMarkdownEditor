let activePath: string | null = null;
const listeners = new Set<() => void>();

export function setActiveFilePath(path: string | null): void {
    if (path === activePath) return;
    activePath = path;
    for (const listener of listeners) listener();
}

export function getActiveFilePath(): string | null {
    return activePath;
}

export function subscribeActiveFile(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function isActiveFilePath(path: string): boolean {
    return activePath === path;
}
