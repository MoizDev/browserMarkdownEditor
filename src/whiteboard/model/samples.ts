// ink.md §2.1, M-10: numeric handles refer to sealed sample records, not node-owned arrays.
export type SampleRef = number;
export type SamplePressure =
    | { readonly kind: 'none' }
    | { readonly kind: 'constant'; readonly value: number }
    | { readonly kind: 'u16'; readonly values: Uint16Array }
    | { readonly kind: 'u32'; readonly values: Uint32Array };

// Published typed arrays are immutable by ownership. Consumers never write or create
// per-frame subarray views; read() clips a range at a chunk boundary instead.
export interface SampleChunk {
    readonly originX: number;
    readonly originY: number;
    readonly positions: Float32Array | Float64Array; // Interleaved anchor-local x,y.
    readonly first: number; // First sample's index within the record.
    readonly count: number;
    readonly firstX: number; // Exact Float64 endpoints in stroke-local space.
    readonly firstY: number;
    readonly lastX: number;
    readonly lastY: number;
    readonly pressure: SamplePressure;
    readonly runStarts: Uint16Array; // Chunk-local sample indices; 0 starts the first run.
    readonly runKinds: Uint8Array; // 0 freehand, 1 straight; source transitions survive import.
}

export interface SampleBlockView {
    readonly chunk: SampleChunk;
    readonly offset: number;
    readonly count: number;
}

export interface SampleLease {
    readonly ref: SampleRef;
    release(): void; // Idempotent; live nodes, history and snapshots each own their lease.
}

export interface SampleStoreReader {
    has(ref: SampleRef): boolean;
    count(ref: SampleRef): number;
    pressureMode(ref: SampleRef): 'real' | 'none'; // Sealed metadata; no view allocation or decode.
    byteSize(ref: SampleRef): number; // Owned decoded typed payload + conservative UTF-16 native backing, no decode.
    read(ref: SampleRef, first: number, count: number): SampleBlockView;
    retain(ref: SampleRef): SampleLease;
}
