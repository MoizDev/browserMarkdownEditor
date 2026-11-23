// IMP-2, E-IMP-15: the input layout is specified in current-format.md §2.3.
// Three layouts of a stroke segment occur in real files, told apart by their own fields, not by the schema version:
//  - `path` (tldraw 4.3+): base64, little-endian; the first point as float32 per channel, each later point as float16
//    deltas from the previous TRUE value; 3 channels (x, y, z) unless `dim: 2` (5.2+) says x, y only;
//  - `points` as a base64 string (an earlier compact form): each point x, y, z as absolute float16;
//  - `points` as an array of {x, y, z?} objects (2.x–4.2).
/** `pressure` is null where the source holds none (a 2-D segment, a missing or non-finite z). */
export interface LegacyPoint { readonly x: number; readonly y: number; readonly pressure: number | null }
export type LegacySegment =
    | { readonly type: 'free' | 'straight'; readonly path: string; readonly dim?: 2 | 3 }
    | { readonly type: 'free' | 'straight'; readonly points: string }
    | { readonly type: 'free' | 'straight'; readonly points: readonly unknown[] };

function half(bits: number): number {
    const sign = bits & 0x8000 ? -1 : 1;
    const exponent = (bits >>> 10) & 31;
    const fraction = bits & 1023;
    if (exponent === 0) return sign * fraction * 2 ** -24;
    if (exponent === 31) return fraction ? NaN : sign * Infinity;
    return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}

export interface LegacySegmentPoints {
    readonly points: readonly LegacyPoint[];
    /** Points after the first non-finite x or y, which cannot be placed. */
    readonly dropped: number;
}

const POINT_LIMIT = 1_000_000;

function bytesOf(base64: string): Uint8Array {
    // One million points is the native admission ceiling; check before expanding base64.
    if (base64.length > 8_000_032) throw new Error('Stroke segment exceeds the point limit');
    let binary: string;
    try { binary = atob(base64); } catch { throw new Error('Invalid stroke segment encoding'); }
    return Uint8Array.from(binary, char => char.charCodeAt(0));
}

/** Decodes one segment's points. x/y keep the valid-prefix rule (plan document-model §9.2): with delta encoding one
 * non-finite value poisons every later point of its channel, so the tail is dropped and counted. A non-finite
 * pressure does NOT end the stroke: its point keeps x/y with pressure null, and the caller decides what it carries. */
export function decodeLegacySegment(segment: LegacySegment): LegacySegmentPoints {
    if (segment.type !== 'free' && segment.type !== 'straight') throw new Error('Unsupported stroke segment');
    const points: LegacyPoint[] = [];
    let total = 0;
    // Returns false at the first non-finite x or y; the caller stops there.
    const add = (x: number, y: number, z: number | undefined): boolean => {
        if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
        points.push({ x, y, pressure: z !== undefined && Number.isFinite(z) ? z : null });
        return true;
    };
    if ('path' in segment) {
        const dim = segment.dim ?? 3;
        if (dim !== 2 && dim !== 3) throw new Error('Unsupported stroke segment');
        const bytes = bytesOf(segment.path);
        // tldraw writes `path: ''` for a segment with no points: nothing to place, nothing wrong.
        if (!bytes.length) return { points, dropped: 0 };
        const firstBytes = dim * 4, deltaBytes = dim * 2;
        if (bytes.length < firstBytes || (bytes.length - firstBytes) % deltaBytes !== 0
            || 1 + (bytes.length - firstBytes) / deltaBytes > POINT_LIMIT) throw new Error('Truncated stroke segment');
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const values = Array.from({ length: dim }, (_, i) => view.getFloat32(i * 4, true));
        total = 1 + (bytes.length - firstBytes) / deltaBytes;
        if (add(values[0], values[1], dim === 3 ? values[2] : undefined)) {
            for (let offset = firstBytes; offset < bytes.length; offset += deltaBytes) {
                for (let i = 0; i < dim; i++) values[i] += half(view.getUint16(offset + 2 * i, true));
                if (!add(values[0], values[1], dim === 3 ? values[2] : undefined)) break;
            }
        }
    } else if (typeof segment.points === 'string') {
        const bytes = bytesOf(segment.points);
        if (bytes.length % 6 !== 0 || bytes.length / 6 > POINT_LIMIT) throw new Error('Truncated stroke segment');
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        total = bytes.length / 6;
        for (let offset = 0; offset < bytes.length; offset += 6) {
            if (!add(half(view.getUint16(offset, true)), half(view.getUint16(offset + 2, true)), half(view.getUint16(offset + 4, true)))) break;
        }
    } else {
        if (segment.points.length > POINT_LIMIT) throw new Error('Stroke segment exceeds the point limit');
        total = segment.points.length;
        for (const value of segment.points) {
            const point = value !== null && typeof value === 'object' ? value as { x?: unknown; y?: unknown; z?: unknown } : null;
            if (!point) throw new Error('Invalid stroke point');
            const coordinate = (v: unknown) => typeof v === 'number' ? v : NaN;
            if (!add(coordinate(point.x), coordinate(point.y), typeof point.z === 'number' ? point.z : undefined)) break;
        }
    }
    return { points, dropped: total - points.length };
}
