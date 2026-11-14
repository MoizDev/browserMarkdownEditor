export interface SessionIdentity {
    readonly serial: number;
    readonly bytesGeneration: number;
}

/** App's session owner will supply this read boundary; absence keeps consumers on their classic path. */
export function getSessionIdentity(_documentId: string): SessionIdentity | undefined {
    return undefined;
}

export function subscribeSessionIdentity(_listener: () => void): () => void {
    return () => {};
}
