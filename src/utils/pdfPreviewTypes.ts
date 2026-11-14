export interface PreviewRect {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

export interface PreviewCanvasPage {
    readonly index: number;
    readonly pageRect: PreviewRect;
    readonly canvasRect: PreviewRect;
    readonly canvas: HTMLCanvasElement | null;
    readonly rasterKey: string | null;
    readonly current: () => boolean;
}

export interface PreviewSnapshot {
    readonly scroll: HTMLElement;
    readonly camera: { readonly x: number; readonly y: number; readonly z: number };
    readonly inverted: boolean;
    readonly pages: readonly PreviewCanvasPage[];
}

export interface PreviewBinding {
    readonly vaultEpoch: number;
    readonly documentId: string;
    readonly bytesGeneration: number;
    readonly session: number;
}

export interface PdfPreview {
    sync(): void;
    setVisible(visible: boolean): void;
    setFocused(focused: boolean): void;
    dispose(): void;
}
