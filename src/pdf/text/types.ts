import type { PdfItemInterval, PdfPageGeometry, PdfPageText } from '../../utils/pdfPageText';

/** Worker-owned copies; never views into engine memory. All geometry is in
 * page space. Generated characters may have empty boxes. */
export interface RawPageText {
    n: number;
    truncated: boolean;
    codepoints: Uint32Array;
    flags: Uint8Array;
    loose: Float32Array;
    tight: Float32Array;
    origin: Float32Array;
    matrix: Float32Array;
    fontSize: Float32Array;
    object: Int32Array;
    objects: { renderMode: Uint8Array; fill: Uint32Array; mcid: Int32Array; font: Uint16Array };
    fontNames: string[];
    struct?: {
        mcids: Int32Array;
        roles: Uint8Array;
        lang: Array<[number, string]>;
        alt: Array<[number, string]>;
        /** Optional structure-object bounds when the backend can supply them. */
        figures?: Array<{ mcid: number; box: readonly [number, number, number, number]; charIndex?: number }>;
    };
}
export interface Schema2Interval extends PdfItemInterval { syntheticSpace: boolean; charStart?: number }
export interface Schema2PageText extends Omit<PdfPageText, 'schema' | 'intervals'> {
    schema: 2;
    intervals: readonly Schema2Interval[];
}
export interface Schema2Projection { model: Schema2PageText; charU16: Uint32Array }
export interface Schema2Geometry { physicalPageIndex: number; width: number; height: number; rotation: number }
export type PageGeometry = PdfPageGeometry;
export interface FigureTag { box: { x: number; y: number; width: number; height: number }; alt: string; offset: number }
export interface LineTable {
    lines: Uint32Array;
    lineBox: Float32Array;
    lineDir: Float32Array;
    lineBidi: Uint8Array;
    clusters: Uint32Array;
    headingLevels: ReadonlyMap<number, 1 | 2 | 3 | 4 | 5 | 6>;
    figures: readonly FigureTag[];
}

export const GENERATED = 1, LINE_HYPHEN = 2, UNICODE_ERROR = 4, INVISIBLE = 8, OUTSIDE = 16;
export function boxAt(raw: RawPageText, i: number): readonly [number, number, number, number] {
    const p = i * 4;
    return [raw.loose[p], raw.loose[p + 1], raw.loose[p + 2], raw.loose[p + 3]];
}
export function validBox(box: readonly number[]): boolean {
    return box.every(Number.isFinite) && box[2] > box[0] && box[3] > box[1];
}
export function differentLine(raw: RawPageText, previous: number, current: number): boolean {
    const a = boxAt(raw, previous), b = boxAt(raw, current);
    if (!validBox(a) || !validBox(b)) return false;
    const dx = raw.matrix[previous * 4] || 1, dy = raw.matrix[previous * 4 + 1] || 0;
    const length = Math.hypot(dx, dy) || 1, nx = -dy / length, ny = dx / length;
    const across = Math.abs(((b[0] + b[2] - a[0] - a[2]) * nx + (b[1] + b[3] - a[1] - a[3]) * ny) / 2);
    const height = Math.max(raw.fontSize[previous] || 0, raw.fontSize[current] || 0, a[3] - a[1], b[3] - b[1], 1);
    return across > 2 * height;
}
export function strongRtl(cp: number): boolean {
    return ((cp >= 0x590 && cp <= 0x8ff) || (cp >= 0xfb1d && cp <= 0xfdff) || (cp >= 0xfe70 && cp <= 0xfeff) ||
        (cp >= 0x10800 && cp <= 0x10fff) || (cp >= 0x1e800 && cp <= 0x1eeff)) && /\p{Letter}/u.test(character(cp));
}
export function character(cp: number): string {
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '\uFFFD';
}
