import type { WorkerContext } from '../../platform/workers';

function crcValid(bytes: Uint8Array): boolean {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length - 4; i++) {
        crc ^= bytes[i];
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(bytes.length - 4) === ((crc ^ 0xffffffff) >>> 0);
}

export async function privatePngDensityWorker(args: unknown, context: WorkerContext): Promise<number | null> {
    if (!args || typeof args !== 'object' || !((args as { blob?: unknown }).blob instanceof Blob)) throw new TypeError('Invalid private PNG');
    const blob = (args as { blob: Blob }).blob;
    if (blob.size > 10 * 1024 * 1024 || blob.size < 33) throw new TypeError('Invalid private PNG size');
    const prefix = new Uint8Array(await blob.slice(0, 33).arrayBuffer());
    context.signal.throwIfAborted();
    if (![137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => prefix[i] === byte)) throw new TypeError('Clipboard image is not a PNG');
    const header = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
    if (header.getUint32(8) !== 13 || String.fromCharCode(...prefix.subarray(12, 16)) !== 'IHDR'
        || !header.getUint32(16) || !header.getUint32(20) || !crcValid(prefix.subarray(12, 33))) throw new TypeError('Invalid PNG header');
    let offset = 33;
    for (let count = 0; count < 8192 && offset + 12 <= blob.size; count++) {
        const bytes = new Uint8Array(await blob.slice(offset, offset + 8).arrayBuffer());
        context.signal.throwIfAborted();
        const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
        const type = String.fromCharCode(...bytes.subarray(4));
        if (length > blob.size - offset - 12) return null;
        if (type === 'IDAT' || type === 'IEND') return null;
        if (type === 'IHDR') return null;
        if (type === 'pHYs') {
            if (length !== 9) return null;
            const phys = new Uint8Array(await blob.slice(offset + 4, offset + 21).arrayBuffer());
            context.signal.throwIfAborted();
            const view = new DataView(phys.buffer, phys.byteOffset, phys.byteLength), x = view.getUint32(4), y = view.getUint32(8);
            const density = x * 0.0254 / 72;
            return crcValid(phys) && phys[12] === 1 && x === y && Number.isFinite(density) && density > 0 ? density : null;
        }
        offset += length + 12;
        if ((count & 127) === 127) await context.slice();
    }
    return null;
}
