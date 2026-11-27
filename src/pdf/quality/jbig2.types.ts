export interface Jbig2ImageRegion {
    readonly id: number;
    readonly box: readonly [number, number, number, number];
}
export interface Jbig2SampleTile {
    readonly scale: number;
    readonly rect: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
    readonly pixels: ArrayBuffer;
    readonly w: number;
    readonly h: number;
}
export interface Jbig2SampleStatus {
    readonly state: 'pending' | 'clear' | 'suspect';
    readonly covered: number;
}
