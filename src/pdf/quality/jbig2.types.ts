export interface Jbig2ImageRegion {
    readonly id: number;
    /** Page-space bounds clipped to the page. */
    readonly box: readonly [number, number, number, number];
}
export interface Jbig2SampleTile {
    readonly scale: number;
    readonly rect: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
    /** RGBA with one-pixel apron; the interior is the only authority sampled. */
    readonly pixels: ArrayBuffer;
    readonly w: number;
    readonly h: number;
}
export interface Jbig2SampleStatus {
    readonly state: 'pending' | 'clear' | 'suspect';
    readonly covered: number;
}
