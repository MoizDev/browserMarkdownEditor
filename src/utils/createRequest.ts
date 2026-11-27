import { ensureNotebookExt, isNativeDrawingFile, NATIVE_DRAWING_EXT } from './fileTypes';

export type CreateKind = 'file' | 'folder' | 'notebook' | 'drawing';

export interface CreateRequest {
    path: string;
    kind: CreateKind;
}

let current: CreateRequest | null = null;
const listeners = new Set<() => void>();

export function requestCreate(path: string, kind: CreateKind): void {
    current = { path, kind };
    for (const listener of listeners) listener();
}

export function clearCreateRequest(): void {
    if (!current) return;
    current = null;
    for (const listener of listeners) listener();
}

export function getCreateRequest(): CreateRequest | null {
    return current;
}

export function subscribeCreateRequest(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function getCreateKindFor(path: string): CreateKind | null {
    return current && current.path === path ? current.kind : null;
}

export function ancestorsOf(path: string): string[] {
    if (!path) return [];
    const parts = path.split('/');
    return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
}

export function nameForKind(kind: CreateKind | null, name: string): string {
    if (kind === 'notebook') return ensureNotebookExt(name);
    if (kind === 'drawing') {
        if (isNativeDrawingFile(name)) return name;
        return `${name.replace(/\.tldraw$/i, '')}${NATIVE_DRAWING_EXT}`;
    }
    return name;
}

export function placeholderFor(kind: CreateKind | null): string {
    switch (kind) {
        case 'notebook': return 'Untitled.notebook';
        case 'drawing': return 'Untitled.drawing';
        case 'folder': return 'New folder';
        default: return 'Untitled.md';
    }
}
