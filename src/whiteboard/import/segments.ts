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
    readonly dropped: number;
}

const POINT_LIMIT = 1_000_000;

function bytesOf(base64: string): Uint8Array {
    if (base64.length > 8_000_032) throw new Error('Stroke segment exceeds the point limit');
    let binary: string;
    try { binary = atob(base64); } catch { throw new Error('Invalid stroke segment encoding'); }
    return Uint8Array.from(binary, char => char.charCodeAt(0));
}

export function decodeLegacySegment(segment: LegacySegment): LegacySegmentPoints {
    if (segment.type !== 'free' && segment.type !== 'straight') throw new Error('Unsupported stroke segment');
    const points: LegacyPoint[] = [];
    let total = 0;
    const add = (x: number, y: number, z: number | undefined): boolean => {
        if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
        points.push({ x, y, pressure: z !== undefined && Number.isFinite(z) ? z : null });
        return true;
    };
    if ('path' in segment) {
        const dim = segment.dim ?? 3;
        if (dim !== 2 && dim !== 3) throw new Error('Unsupported stroke segment');
        const bytes = bytesOf(segment.path);
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
