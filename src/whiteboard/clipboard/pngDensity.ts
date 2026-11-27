import { SECURITY_LIMITS } from '../security/limits';

export function pngCrc32(bytes: Uint8Array): number {
    let crc = 0xffffffff;
    for (const value of bytes) {
        crc ^= value;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
}
/** Metadata is only a sizing hint; the caller must still inspect/sniff/decode the PNG itself. */
export async function privatePngDensity(blob: Blob, signal: AbortSignal): Promise<number | undefined> {
    signal.throwIfAborted();
    if (!(blob instanceof Blob) || (typeof File !== 'undefined' && blob instanceof File) || blob.size > SECURITY_LIMITS.mediaBytes) throw new TypeError('Invalid private PNG bytes');
    const signature = new Uint8Array(await blob.slice(0, 8).arrayBuffer()); signal.throwIfAborted();
    const expected = [137, 80, 78, 71, 13, 10, 26, 10];
    if (signature.length !== expected.length || expected.some((value, index) => signature[index] !== value)) return undefined;
    let offset = 8, count = 0, density: number | undefined;
    while (offset + 12 <= blob.size) {
        if (++count > 100_000) throw new RangeError('PNG chunk count exceeds limits');
        const header = new Uint8Array(await blob.slice(offset, offset + 8).arrayBuffer()); signal.throwIfAborted();
        const view = new DataView(header.buffer), length = view.getUint32(0), type = String.fromCharCode(...header.subarray(4, 8));
        if (length > blob.size - offset - 12) return undefined;
        if (type === 'IDAT' || type === 'IEND') return density;
        if (type === 'pHYs') {
            if (length !== 9 || density !== undefined) return undefined;
            const record = new Uint8Array(await blob.slice(offset + 4, offset + 4 + 4 + 9 + 4).arrayBuffer()); signal.throwIfAborted();
            if (record.length !== 17 || pngCrc32(record.subarray(0, 13)) !== new DataView(record.buffer).getUint32(13)) return undefined;
            const data = new DataView(record.buffer), x = data.getUint32(4), y = data.getUint32(8), unit = record[12];
            if (unit !== 1 || !x || x !== y) return undefined;
            density = x * 0.0254 / 72;
            if (!Number.isFinite(density) || density <= 0) return undefined;
        }
        offset += 12 + length;
    }
    return undefined;
}
