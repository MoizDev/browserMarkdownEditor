import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { ByteLease } from '../../platform/render/gfx/api';
import type { BoardRuntime } from '../host/runtime';
import { SECURITY_LIMITS } from '../security/limits';
import { pngCrc32 } from './pngDensity';

// Provenance: clipboard §2.4 capture formats and PNG density convention;
// independent bounded chunk rewriting, no upstream engine source.
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;
/** Adds our density to trusted PNG capture bytes without decoding or resampling pixels. */
export async function pngWithClipboardDensity(png: Blob, pixelsPerWorldUnit: number, signal: AbortSignal,
    memory: MemoryAllocator): Promise<{ readonly blob: Blob; release(): void }> {
    if (!(png instanceof Blob) || !Number.isFinite(pixelsPerWorldUnit) || pixelsPerWorldUnit <= 0) throw new TypeError('Invalid PNG capture');
    const leases: ByteLease[] = []; let released = false;
    const release = () => { if (!released) { released = true; for (const lease of leases) memory.release(lease); } };
    const reserve = () => { const lease = memory.reserve(256 * 512); if (!lease) throw new Error('Insufficient memory for PNG clipboard metadata'); leases.push(lease); };
    try {
    reserve();
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
        if ((count & 255) === 0) {
            reserve(); await new Promise<void>(resolve => setTimeout(resolve, 0)); signal.throwIfAborted();
        }
        const next = new Uint8Array(await png.slice(offset, offset + 8).arrayBuffer()); signal.throwIfAborted();
        const length = new DataView(next.buffer).getUint32(0), type = String.fromCharCode(...next.subarray(4, 8));
        if (length > png.size - offset - 12 || type === 'IHDR') throw new Error('Invalid PNG capture chunk');
        if (type !== 'pHYs') parts.push(png.slice(offset, offset + length + 12));
        offset += length + 12;
        if (type === 'IEND') { if (length !== 0 || offset !== png.size) throw new Error('Invalid PNG capture end'); ended = true; break; }
    }
    if (!ended) throw new Error('PNG capture has no end');
    return { blob: new Blob(parts, { type: 'image/x-board+png' }), release };
    } catch (error) { release(); throw error; }
}
/** Capture is the real in-job export port; promises are installed while user activation is live. */
export async function copyBoardPng(runtime: BoardRuntime, memory: MemoryAllocator, capture: (signal: AbortSignal) => Promise<Blob>, signal: AbortSignal,
    current: () => boolean, pixelsPerWorldUnit = 2): Promise<void> {
    const session = runtime.session, controller = new AbortController(), jobSignal = AbortSignal.any([signal, controller.signal]);
    const check = () => { signal.throwIfAborted(); if (runtime.session !== session || !current()) throw new DOMException('Clipboard capture became stale', 'AbortError'); };
    check();
    let finished = false, owned: { release(): void } | undefined;
    const captured = runtime.jobs.run(async context => {
        const blob = await capture(context.signal); context.assertCurrent(); check();
        const image = new Blob([blob], { type: 'image/png' });
        const privateImage = await pngWithClipboardDensity(image, pixelsPerWorldUnit, context.signal, memory);
        try { context.assertCurrent(); check(); return { image, privateImage }; }
        catch (error) { privateImage.release(); throw error; }
    }, { signal: jobSignal, deadlineMs: 120_000 }).then(value => {
        if (finished) { value.privateImage.release(); throw new DOMException('Clipboard operation ended', 'AbortError'); }
        owned = value.privateImage; return value;
    });
    const image = captured.then(value => value.image), privateImage = captured.then(value => value.privateImage.blob);
    // The OS promise must be installed during the gesture; unsupported custom formats fall back to standard PNG.
    void image.catch(() => undefined); void privateImage.catch(() => undefined);
    try {
        try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': image, 'web image/x-board+png': privateImage })]); }
        catch { check(); await navigator.clipboard.write([new ClipboardItem({ 'image/png': image })]); }
        check();
    } finally { finished = true; controller.abort(); owned?.release(); }
}
/** The in-job capture supplies the real escaped/exported SVG and its C2 resource lease. */
export async function copyBoardSvg(options: {
    readonly runtime: BoardRuntime; readonly signal?: AbortSignal; current(): boolean;
    capture(signal: AbortSignal): Promise<{ readonly svg: Blob; release(): void }>;
}): Promise<void> {
    const { runtime } = options, session = runtime.session, controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const check = () => { signal.throwIfAborted(); if (runtime.session !== session || !options.current()) throw new DOMException('Clipboard capture became stale', 'AbortError'); };
    check();
    let finished = false, owned: { release(): void } | undefined;
    const captured = runtime.jobs.run(async context => {
        const result = await options.capture(context.signal);
        try {
            context.assertCurrent(); check();
            if (!(result.svg instanceof Blob) || result.svg.size > SECURITY_LIMITS.clipboardExpandedBytes) throw new RangeError('Invalid clipboard SVG capture');
            return result;
        } catch (error) { result.release(); throw error; }
    }, { signal, deadlineMs: 120_000 });
    const text = captured.then(result => {
        if (finished) { result.release(); throw new DOMException('Clipboard operation ended', 'AbortError'); }
        owned = result; return new Blob([result.svg], { type: 'text/plain' });
    });
    void text.catch(() => undefined);
    try { await navigator.clipboard.write([new ClipboardItem({ 'text/plain': text })]); check(); }
    finally { finished = true; controller.abort(); owned?.release(); }
}
export { copyBoardJsonFresh as copyBoardJson } from './copyJson';
