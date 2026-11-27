export interface SearchRequest { readonly id: number; readonly query: string }

export interface SearchRequestChannel {
    request(query: string): void;
    current(): SearchRequest | null;
    subscribe(listener: () => void): () => void;
    consume(id: number): void;
}
