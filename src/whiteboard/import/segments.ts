// IMP-2, E-IMP-15: the input layout is specified in current-format.md §2.3.
export interface LegacyPoint { readonly x: number; readonly y: number; readonly pressure: number }
export interface LegacySegment { readonly type: 'free' | 'straight'; readonly path: string; readonly dim?: 2 | 3 }

function half(bits: number): number {
    const sign = bits & 0x8000 ? -1 : 1;
    const exponent = (bits >>> 10) & 31;
    const fraction = bits & 1023;
    if (exponent === 0) return sign * fraction * 2 ** -24;
    if (exponent === 31) return fraction ? NaN : sign * Infinity;
    return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}

export interface LegacySegmentPoints { readonly points: readonly LegacyPoint[]; readonly dropped: number }

// Plan document-model §9.2 (non-finite stroke points): every delta is relative to the point before it,
// so one non-finite value poisons all later points of its channel (Infinity + finite stays Infinity,
// NaN stays NaN). The valid prefix is therefore all that can be placed; the tail is dropped and counted.
// A negative pressure is a different class (native E-FMT-21, import.md D-10) and still refuses.
export function decodeLegacySegment(segment: LegacySegment): LegacySegmentPoints {
    const dim = segment.dim ?? 3;
    if ((dim !== 2 && dim !== 3) || (segment.type !== 'free' && segment.type !== 'straight')) {
        throw new Error('Unsupported stroke segment');
    }
    // One million points is the native admission ceiling; check before expanding base64.
    if (segment.path.length > 8_000_032) throw new Error('Stroke segment exceeds the point limit');
    let binary: string;
    try { binary = atob(segment.path); } catch { throw new Error('Invalid stroke segment encoding'); }
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    const firstBytes = dim * 4, deltaBytes = dim * 2;
    if (bytes.length < firstBytes || (bytes.length - firstBytes) % deltaBytes !== 0
        || 1 + (bytes.length - firstBytes) / deltaBytes > 1_000_000) {
        throw new Error('Truncated stroke segment');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const values = Array.from({ length: dim }, (_, i) => view.getFloat32(i * 4, true));
    const total = 1 + (bytes.length - firstBytes) / deltaBytes;
    const points: LegacyPoint[] = [];
    // Returns false at the first non-finite point; the caller stops there.
    const add = (): boolean => {
        const [x, y] = values;
        const pressure = dim === 3 ? values[2] : 0.5;
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(pressure)) return false;
        if (pressure < 0) throw new Error('Invalid stroke coordinate or pressure');
        points.push({ x, y, pressure });
        return true;
    };
    if (add()) {
        for (let offset = firstBytes; offset < bytes.length; offset += deltaBytes) {
            for (let i = 0; i < dim; i++) values[i] += half(view.getUint16(offset + 2 * i, true));
            if (!add()) break;
        }
    }
    return { points, dropped: total - points.length };
}
