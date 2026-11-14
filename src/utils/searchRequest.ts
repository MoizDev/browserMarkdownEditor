import type { SearchRequest } from './searchRequest.types';
let current: SearchRequest | null = null;
let nextId = 0;
const listeners = new Set<() => void>();

/** Any reading surface can request vault search without depending on React or the sidebar. */
export function requestVaultSearch(query: string): void {
    current = { id: ++nextId, query };
    for (const listener of listeners) listener();
}
export function getSearchRequest(): SearchRequest | null { return current; }
export function subscribeSearchRequest(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
/** A late consumer cannot clear a newer request. */
export function consumeSearchRequest(id: number): void {
    if (current?.id !== id) return;
    current = null;
    for (const listener of listeners) listener();
}
