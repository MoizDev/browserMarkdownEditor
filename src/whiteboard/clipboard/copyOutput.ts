import type { BoardRuntime } from '../host/runtime';
import type { CopySnapshot } from './snapshot';
import { pngCrc32 } from './pngDensity';

// Provenance: clipboard §2.4 capture formats and PNG density convention;
// independent bounded chunk rewriting, no upstream engine source.
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;
/** Adds our density to trusted PNG capture bytes without decoding or resampling pixels. */
export async function pngWithClipboardDensity(png: Blob, pixelsPerWorldUnit: number, signal: AbortSignal): Promise<Blob> {
    if (!(png instanceof Blob) || !Number.isFinite(pixelsPerWorldUnit) || pixelsPerWorldUnit <= 0) throw new TypeError('Invalid PNG capture');
    const ppm = Math.round(72 * pixelsPerWorldUnit / 0.0254);
    if (!Number.isSafeInteger(ppm) || ppm < 1 || ppm > 0xffffffff) throw new RangeError('Invalid PNG clipboard density');
    const header = new Uint8Array(await png.slice(0, 33).arrayBuffer()); signal.throwIfAborted();
    if (header.length !== 33 || PNG_SIGNATURE.some((value, index) => header[index] !== value)
        || new DataView(header.buffer).getUint32(8) !== 13 || String.fromCharCode(...header.subarray(12, 16)) !== 'IHDR'
        || pngCrc32(header.subarray(12, 29)) !== new DataView(header.buffer).getUint32(29)) throw new Error('Invalid PNG capture');
    const chunk = new Uint8Array(21), view = new DataView(chunk.buffer);
    view.setUint32(0, 9); chunk.set([112, 72, 89, 115], 4); view.setUint32(8, ppm); view.setUint32(12, ppm); chunk[16] = 1;
    view.setUint32(17, pngCrc32(chunk.subarray(4, 17)));
    const parts: BlobPart[] = [png.slice(0, 33), chunk];
    let offset = 33, count = 0, ended = false;
    while (offset + 12 <= png.size) {
        if (++count > 100_000) throw new RangeError('PNG capture contains too many chunks');
        const next = new Uint8Array(await png.slice(offset, offset + 8).arrayBuffer()); signal.throwIfAborted();
        const length = new DataView(next.buffer).getUint32(0), type = String.fromCharCode(...next.subarray(4, 8));
        if (length > png.size - offset - 12 || type === 'IHDR') throw new Error('Invalid PNG capture chunk');
        if (type !== 'pHYs') parts.push(png.slice(offset, offset + length + 12));
        offset += length + 12;
        if (type === 'IEND') { if (length !== 0 || offset !== png.size) throw new Error('Invalid PNG capture end'); ended = true; break; }
    }
    if (!ended) throw new Error('PNG capture has no end');
    return new Blob(parts, { type: 'image/x-board+png' });
}
/** Capture is the real export port; promises are installed while user activation is live. */
export async function copyBoardPng(runtime: BoardRuntime, capture: (signal: AbortSignal) => Promise<Blob>, signal: AbortSignal,
    current: () => boolean, pixelsPerWorldUnit = 2): Promise<void> {
    const session = runtime.session;
    const check = () => { signal.throwIfAborted(); if (runtime.session !== session || !current()) throw new DOMException('Clipboard capture became stale', 'AbortError'); };
    check();
    const captured = runtime.jobs.run(async context => {
        const blob = await capture(context.signal); context.assertCurrent(); check();
        const image = new Blob([blob], { type: 'image/png' });
        const privateImage = await pngWithClipboardDensity(image, pixelsPerWorldUnit, context.signal);
        context.assertCurrent(); check();
        return { image, privateImage };
    }, { signal, deadlineMs: 120_000 });
    const image = captured.then(value => value.image), privateImage = captured.then(value => value.privateImage);
    // The OS promise must be installed during the gesture; unsupported custom formats fall back to standard PNG.
    void image.catch(() => undefined); void privateImage.catch(() => undefined);
    try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': image, 'web image/x-board+png': privateImage })]); }
    catch { check(); await navigator.clipboard.write([new ClipboardItem({ 'image/png': image })]); }
    check();
}
/** The caller supplies the real escaped/exported SVG; the clipboard holds plain text only. */
export function copyBoardSvg(svg: string): Promise<void> { return navigator.clipboard.writeText(svg); }
/** Copy-as-JSON is an array of the native record-line strings, not an array of parsed objects. */
export function copyBoardJson(snapshot: CopySnapshot, current: () => boolean): Promise<void> {
    if (!current()) return Promise.reject(new DOMException('Clipboard capture became stale', 'AbortError'));
    return navigator.clipboard.writeText(JSON.stringify(snapshot.payload.records));
}
