// Cross-stream contracts live here without runtime imports or values (contracts.md C6.3:815–819).

/** Surface CSS extent and the scalar device-pixel ratio (contracts.md C1.2:99–102). */
export interface Viewport {
    width: number;
    height: number;
    dpr: number;
}

/** World origin at the surface's top-left; z is CSS pixels per world unit (C1.2:103–104). */
export interface Camera {
    x: number;
    y: number;
    z: number;
}

/** One snapshot shared by all layers; epoch tracks geometry, not content (C1.2:105–108). */
export interface ViewState {
    camera: Camera;
    viewport: Viewport;
    epoch: number;
    moving: boolean;
}

/** C1.5:209, C2.4:385; contract silent on shape, vr-lead ruling: axis-aligned extent. */
export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** C2.3:332, C2.4:385; contract silent on alias, vr-lead ruling: x'=ax+cy+e, y'=bx+dy+f. */
export type Affine = readonly [a: number, b: number, c: number, d: number, e: number, f: number];

/** C2.4:380–383; contract silent on shape, vr-lead ruling: straight encoded-sRGB in [0,1].
 * Unlike gfx RgbaP, these channels are NOT premultiplied; alpha becomes PDF opacity.
 */
export type Rgba = readonly [r: number, g: number, b: number, a: number];

/** C2.4:380; contract silent on members, vr-lead ruling: the Canvas/PDF cap names. */
export type LineCap = 'butt' | 'round' | 'square';

/** C2.4:380; contract silent on members, vr-lead ruling: the Canvas/PDF join names. */
export type LineJoin = 'miter' | 'round' | 'bevel';

/** PDF display box after rotation, with the engine-owned user-space mapping (C2.3:325–333). */
export interface PageGeometry {
    index: number;
    width: number;
    height: number;
    rotate: 0 | 90 | 180 | 270;
    /** Informational only; never a multiplier. PDFium reports 1 (C2.3:329–331). */
    userUnit: number;
    toUserSpace: Affine;
}

/** Only absolute move, line, cubic and close cross the writer boundary (C2.4:389–393). */
export type PathCommand =
    | ['M', x: number, y: number]
    | ['L', x: number, y: number]
    | ['C', x1: number, y1: number, x2: number, y2: number, x: number, y: number]
    | ['Z'];

/** Resolution-free page-local output, shared by paper, ink and the writer (C2.4:373–390, C3:449–453). */
export interface PageDisplayList {
    page: number;
    items: Array<
        | {
            kind: 'path';
            d: PathCommand[];
            fill?: Rgba;
            stroke?: {
                color: Rgba;
                width: number;
                cap: LineCap;
                join: LineJoin;
                /** C2.4:380; contract silent on shape, vr-lead ruling: read-only dash lengths. */
                dash?: readonly number[];
            };
            blend?: 'normal' | 'multiply';
        }
        | {
            kind: 'image';
            rect: Rect;
            transform: Affine;
            bytes: Uint8Array;
            mime: 'image/png' | 'image/jpeg';
        }
        | { kind: 'raster'; rect: Rect; png: Uint8Array }
    >;
}

/** Immutable, revision-pinned source; read is synchronous and side-effect free (C7.1:886–891). */
export interface ContentSource {
    kind: 'deferred';
    owner: { documentId: string; session: number };
    revision: number;
    read(): string | Uint8Array | Blob | BuildJob;
}

/** Deferred byte assembly is cancellable and pinned to the same revision (C7.1:892–895). */
export interface BuildJob {
    kind: 'build';
    revision: number;
    run(signal: AbortSignal): Promise<Uint8Array | Blob>;
}
