export interface SearchRequest { readonly id: number; readonly query: string }

/** App-owned request channel for a reading surface's vault-search command. */
export interface SearchRequestChannel {
    request(query: string): void;
    current(): SearchRequest | null;
    subscribe(listener: () => void): () => void;
    consume(id: number): void;
}
