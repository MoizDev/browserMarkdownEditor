export interface NativeCanvasIdentity {
    readonly documentId: string;
    readonly session: number;
    readonly vaultActivation: number;
    readonly bytesGeneration: number;
    readonly kind: 'drawing' | 'notebook' | 'pdfInk';
    readonly path: string;
    readonly name: string;
}

export interface NativeCanvasMedia {
    readonly hash: string;
    readonly preferredName?: string | null;
}

export interface NativeCanvasHost {
    identity(documentId: string): NativeCanvasIdentity | undefined;
    isCurrent(identity: NativeCanvasIdentity): boolean;
    acquireBytes(identity: NativeCanvasIdentity, signal: AbortSignal): Promise<Blob>;
    readMedia(identity: NativeCanvasIdentity, media: NativeCanvasMedia, signal: AbortSignal): Promise<{ name: string; blob: Blob } | null>;
    putMedia(identity: NativeCanvasIdentity, media: NativeCanvasMedia & { extension: string }, blob: Blob, signal: AbortSignal): Promise<string>;
}
