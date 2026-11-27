export interface Viewport {
    width: number;
    height: number;
    dpr: number;
}

export interface Camera {
    x: number;
    y: number;
    z: number;
}

export interface ViewState {
    camera: Camera;
    viewport: Viewport;
    epoch: number;
    moving: boolean;
}

export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export type Affine = readonly [a: number, b: number, c: number, d: number, e: number, f: number];

export type Rgba = readonly [r: number, g: number, b: number, a: number];

export type LineCap = 'butt' | 'round' | 'square';

export type LineJoin = 'miter' | 'round' | 'bevel';

export interface PageGeometry {
    index: number;
    width: number;
    height: number;
    rotate: 0 | 90 | 180 | 270;
    userUnit: number;
    toUserSpace: Affine;
}

export type PathCommand =
    | ['M', x: number, y: number]
    | ['L', x: number, y: number]
    | ['C', x1: number, y1: number, x2: number, y2: number, x: number, y: number]
    | ['Z'];

export type PageDisplayItem =
        | {
            kind: 'group';
            items: PageDisplayItem[];
            transform?: Affine;
            clip?: { d: PathCommand[]; fillRule?: 'nonzero' | 'evenodd' };
            isolation?: { opacity: number; blend: 'normal' | 'multiply' };
        }
        | {
            kind: 'path';
            d: PathCommand[];
            fill?: Rgba;
            fillRule?: 'nonzero' | 'evenodd';
            stroke?: {
                color: Rgba;
                width: number;
                cap: LineCap;
                join: LineJoin;
                dash?: readonly number[];
                miterLimit?: number;
                dashPhase?: number;
            };
            blend?: 'normal' | 'multiply';
        }
        | {
            kind: 'image';
            rect: Rect;
            transform: Affine;
            bytes: Uint8Array;
            mime: 'image/png' | 'image/jpeg';
            opacity?: number;
            blend?: 'normal' | 'multiply';
        }
        | { kind: 'raster'; rect: Rect; png: Uint8Array; opacity?: number; blend?: 'normal' | 'multiply' };

export interface PageDisplayList {
    page: number;
    items: PageDisplayItem[];
}

export interface ContentSource {
    kind: 'deferred';
    owner: { documentId: string; session: number };
    revision: number;
    read(): string | Uint8Array | Blob | BuildJob;
}

export interface BuildJob {
    kind: 'build';
    revision: number;
    run(signal: AbortSignal): Promise<Uint8Array | Blob>;
}
