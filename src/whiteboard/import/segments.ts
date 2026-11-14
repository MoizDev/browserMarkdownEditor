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

export function decodeLegacySegment(segment: LegacySegment): readonly LegacyPoint[] {
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
    const points: LegacyPoint[] = [];
    const add = () => {
        const [x, y] = values;
        const pressure = dim === 3 ? values[2] : 0.5;
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(pressure) || pressure < 0) {
            throw new Error('Invalid stroke coordinate or pressure');
        }
        points.push({ x, y, pressure });
    };
    add();
    for (let offset = firstBytes; offset < bytes.length; offset += deltaBytes) {
        for (let i = 0; i < dim; i++) values[i] += half(view.getUint16(offset + 2 * i, true));
        add();
    }
    return points;
}
