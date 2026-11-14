import type { FontProvider, FontSpec } from '../types';
import { PdfEngineError } from '../types';
import type { PdfiumFontBridge } from './fontBridge.types';
import type { PdfiumRuntime } from './loader';
import { heapView } from './memory';

interface FontHandle { bytes: Uint8Array; face: Uint8Array; charset: number }
const MAX_FONT_BYTES = 64 * 1024 * 1024, MAX_HANDLES = 512, TTCF = 0x74746366;
const BASE14 = /^(?:Helvetica|Times-Roman|Times-Bold|Times-Italic|Times-BoldItalic|Courier|Symbol|ZapfDingbats)(?:-(?:Bold|Oblique|BoldOblique))?$/i;

function fontTable(bytes: Uint8Array, tag: number): Uint8Array | undefined {
    if (bytes.length < 12) return undefined;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const collection = view.getUint32(0, false) === TTCF;
    if (tag === TTCF) return collection ? bytes : undefined;
    if (tag === 0) return collection ? undefined : bytes;
    const offset = collection ? view.getUint32(12, false) : 0;
    if (offset > bytes.length - 12) return undefined;
    const count = view.getUint16(offset + 4, false);
    if (count > Math.floor((bytes.length - offset - 12) / 16)) return undefined;
    for (let index = 0; index < count; index++) {
        const entry = offset + 12 + index * 16;
        if (view.getUint32(entry, false) !== (tag >>> 0)) continue;
        const start = view.getUint32(entry + 8, false), size = view.getUint32(entry + 12, false);
        if (start > bytes.length || size > bytes.length - start) return undefined;
        return bytes.subarray(start, start + size);
    }
    return undefined;
}

/** MapFont is synchronous and receives only pre-approved cached bytes from the
 * runtime. No callback may fetch or re-enter PDFium; a miss stays provisional. */
export function installPdfiumFontBridge(runtime: PdfiumRuntime, provider: FontProvider): PdfiumFontBridge {
    const layout = runtime.abi.structs.systemFontInfo, pointer = runtime.malloc(layout.size);
    const callbacks: number[] = [], fonts = new Map<number, FontHandle>();
    let next = 1, closed = false;
    const readName = (rawPointer: number): string => {
        const address = rawPointer >>> 0, heap = runtime.HEAPU8;
        if (!address || address >= heap.length) return '';
        let end = address;
        while (end < heap.length && end - address < 128 && heap[end] !== 0) end++;
        if (end === heap.length || end - address === 128) return '';
        return new TextDecoder().decode(heap.subarray(address, end));
    };
    const copy = (bytes: Uint8Array | undefined, destination: number, capacity: number): number => {
        if (!bytes) return 0;
        const target = destination >>> 0, available = capacity >>> 0;
        if (target && available >= bytes.length) {
            const heap = runtime.HEAPU8;
            if (target > heap.byteLength || bytes.length > heap.byteLength - target) return 0;
            heap.set(bytes, target);
        }
        return bytes.length;
    };
    try {
        runtime.HEAPU8.fill(0, pointer, pointer + layout.size);
        const map = runtime.addFunction((_self, weight, italic, charset, _pitch, face) => {
            try {
                if (closed || fonts.size >= MAX_HANDLES) return 0;
                const family = readName(face);
                if (!family || BASE14.test(family)) return 0;
                const spec: FontSpec = { family, weight: Math.max(1, Math.min(1000, weight | 0)), italic: !!italic, charset: charset | 0 };
                const bytes = provider.request(spec);
                if (!(bytes instanceof Uint8Array) || bytes.length < 12 || bytes.length > MAX_FONT_BYTES) return 0;
                const handle = next++;
                if (!Number.isSafeInteger(handle) || handle > 0x7fffffff) return 0;
                fonts.set(handle, { bytes: bytes.slice(), face: new TextEncoder().encode(`${family}\0`), charset: charset | 0 });
                return handle;
            } catch { return 0; }
        }, 'iiiiiiii');
        callbacks.push(map);
        const getData = runtime.addFunction((_self, handle, table, buffer, size) => {
            try { const font = fonts.get(handle >>> 0); return font ? copy(fontTable(font.bytes, table >>> 0), buffer, size) : 0; }
            catch { return 0; }
        }, 'iiiiii');
        callbacks.push(getData);
        const getFace = runtime.addFunction((_self, handle, buffer, size) => {
            try { return copy(fonts.get(handle >>> 0)?.face, buffer, size); } catch { return 0; }
        }, 'iiiii');
        callbacks.push(getFace);
        const getCharset = runtime.addFunction((_self, handle) => fonts.get(handle >>> 0)?.charset ?? 0, 'iii');
        callbacks.push(getCharset);
        const del = runtime.addFunction((_self, handle) => { fonts.delete(handle >>> 0); }, 'vii');
        callbacks.push(del);
        const view = heapView(runtime, pointer, layout.size);
        view.setInt32(layout.offsets.version, 2, true);
        view.setUint32(layout.offsets.MapFont, map, true);
        view.setUint32(layout.offsets.GetFontData, getData, true);
        view.setUint32(layout.offsets.GetFaceName, getFace, true);
        view.setUint32(layout.offsets.GetFontCharset, getCharset, true);
        view.setUint32(layout.offsets.DeleteFont, del, true);
        runtime.call('FPDF_SetSystemFontInfo', pointer);
    } catch (error) {
        for (const callback of callbacks) runtime.removeFunction(callback);
        runtime.free(pointer);
        throw error;
    }
    return { close() {
        if (closed) return;
        closed = true;
        if (!runtime.aborted) { try { runtime.call('FPDF_SetSystemFontInfo', 0); } catch { /* worker unusable */ } }
        fonts.clear();
        for (const callback of callbacks) runtime.removeFunction(callback);
        try { runtime.free(pointer); } catch { throw new PdfEngineError('EngineBroken', 'PDF font bridge teardown failed'); }
    } };
}
