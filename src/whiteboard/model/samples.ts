export type SampleRef = number;
export type SamplePressure =
    | { readonly kind: 'none' }
    | { readonly kind: 'constant'; readonly value: number }
    | { readonly kind: 'u16'; readonly values: Uint16Array }
    | { readonly kind: 'u32'; readonly values: Uint32Array };

export interface SampleChunk {
    readonly originX: number;
    readonly originY: number;
    readonly positions: Float32Array | Float64Array;
    readonly first: number;
    readonly count: number;
    readonly firstX: number;
    readonly firstY: number;
    readonly lastX: number;
    readonly lastY: number;
    readonly pressure: SamplePressure;
    readonly runStarts: Uint16Array;
    readonly runKinds: Uint8Array;
}

export interface SampleBlockView {
    readonly chunk: SampleChunk;
    readonly offset: number;
    readonly count: number;
}

export interface SampleLease {
    readonly ref: SampleRef;
    release(): void;
}

export interface SampleSummary {
    readonly localBounds: readonly [x: number, y: number, w: number, h: number];
    readonly curveBounds: readonly [x: number, y: number, w: number, h: number];
    readonly maxReach: number;
    readonly maxPressure: number | null;
}

export interface SampleStoreReader {
    summary?(ref: SampleRef): SampleSummary | null;
    has(ref: SampleRef): boolean;
    count(ref: SampleRef): number;
    pressureMode(ref: SampleRef): 'real' | 'none';
    byteSize(ref: SampleRef): number;
    read(ref: SampleRef, first: number, count: number): SampleBlockView;
    retain(ref: SampleRef): SampleLease;
}

