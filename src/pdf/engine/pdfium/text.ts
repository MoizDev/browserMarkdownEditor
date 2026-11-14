import type { PageGeometry } from '../../../platform/types';
import { PdfEngineError } from '../types';
import type { EngineLimits, RawPageText } from '../types';
import { GENERATED, INVISIBLE, LINE_HYPHEN, OUTSIDE, UNICODE_ERROR } from '../../text/types';
import type { PdfiumRuntime } from './loader';
import { pdfiumTransformBox, pdfiumTransformPoint, pdfiumUserToPage } from './geometry';
import { heapView, withPdfiumMemory } from './memory';

/** Handles stay page-private and are rebuilt in a disposable clone in the same
 * character order. Only the owned typed arrays leave this module. */
export interface PdfiumTextResult { raw: RawPageText; objectHandles: readonly number[] }

export function extractPdfiumText(runtime: PdfiumRuntime, page: number, textPage: number,
    geometry: PageGeometry, limits: Readonly<EngineLimits>): PdfiumTextResult {
    const count = runtime.call('FPDFText_CountChars', textPage);
    if (!Number.isSafeInteger(count) || count < 0) throw new PdfEngineError('PageError', 'PDF text page is unreadable');
    const n = Math.min(count, limits.maxChars);
    if (!Number.isSafeInteger(n) || n < 0 || n > 200_000) throw new PdfEngineError('ResourceLimit', 'Invalid PDF text limit');
    const transform = pdfiumUserToPage(geometry);
    const codepoints = new Uint32Array(n), flags = new Uint8Array(n), loose = new Float32Array(n * 4);
    const tight = new Float32Array(n * 4), origin = new Float32Array(n * 2), matrix = new Float32Array(n * 4);
    const textMatrix = new Float32Array(n * 6), fontSize = new Float32Array(n), object = new Int32Array(n).fill(-1);
    const objectHandles: number[] = [], objectIds = new Map<number, number>();
    const modes: number[] = [], fills: number[] = [], mcids: number[] = [], objectFonts: number[] = [];
    const sourceFontSizes: number[] = [], opacities: number[] = [], transparency: number[] = [];
    const fontNames: string[] = [], fontAscents: number[] = [], fontDescents: number[] = [];
    const fontIds = new Map<number, number>();
    let truncated = count > n;
    const pageHasTransparency = runtime.call('FPDFPage_HasTransparency', page) !== 0;
    const safeFloat = (value: number) => Number.isFinite(Math.fround(value)) ? value : 0;
    return withPdfiumMemory(runtime, 80, scratch => {
        const fontIndex = (handle: number, characterIndex: number): number => {
            if (!handle) return 0xffff;
            const existing = fontIds.get(handle);
            if (existing !== undefined) return existing;
            if (fontNames.length >= Math.min(limits.maxFonts, 512)) { truncated = true; return 0xffff; }
            const length = runtime.call('FPDFText_GetFontInfo', textPage, characterIndex, 0, 0, scratch) >>> 0;
            let name = '';
            if (length > 0 && length <= 4096) {
                name = withPdfiumMemory(runtime, length, pointer => {
                    const returned = runtime.call('FPDFText_GetFontInfo', textPage, characterIndex, pointer, length, scratch) >>> 0;
                    if (returned !== length) return '';
                    const view = heapView(runtime, pointer, length);
                    const bytes = new Uint8Array(view.buffer, view.byteOffset, Math.max(0, length - 1));
                    return new TextDecoder().decode(bytes).slice(0, 128).replace(/[\uD800-\uDBFF]$/u, '');
                });
            }
            let ascent = 0, descent = 0;
            if (runtime.call('FPDFFont_GetAscent', handle, 1, scratch)) ascent = safeFloat(heapView(runtime, scratch, 4).getFloat32(0, true));
            if (runtime.call('FPDFFont_GetDescent', handle, 1, scratch)) descent = safeFloat(heapView(runtime, scratch, 4).getFloat32(0, true));
            const id = fontNames.length;
            fontIds.set(handle, id); fontNames.push(name); fontAscents.push(ascent); fontDescents.push(descent);
            return id;
        };
        const objectIndex = (handle: number, characterIndex: number): number => {
            if (!handle) return -1;
            const existing = objectIds.get(handle);
            if (existing !== undefined) return existing;
            if (objectHandles.length >= Math.min(limits.maxTextObjects, 20_000)) { truncated = true; return -1; }
            const id = objectHandles.length;
            objectIds.set(handle, id); objectHandles.push(handle);
            const mode = runtime.call('FPDFTextObj_GetTextRenderMode', handle);
            modes.push(Number.isInteger(mode) && mode >= 0 && mode <= 7 ? mode : 255);
            let color = 0, alpha = 0;
            if (runtime.call('FPDFPageObj_GetFillColor', handle, scratch, scratch + 4, scratch + 8, scratch + 12)) {
                const view = heapView(runtime, scratch, 16);
                const r = view.getUint32(0, true), g = view.getUint32(4, true), b = view.getUint32(8, true);
                alpha = view.getUint32(12, true);
                if ([r, g, b, alpha].every(value => value <= 255)) color = ((r << 24) | (g << 16) | (b << 8) | alpha) >>> 0;
                else alpha = 0;
            }
            fills.push(color); opacities.push(alpha / 255); transparency.push(alpha !== 255 ? 1 : pageHasTransparency ? 2 : 0);
            mcids.push(runtime.call('FPDFPageObj_GetMarkedContentID', handle) | 0);
            let sourceSize = 0;
            if (runtime.call('FPDFTextObj_GetFontSize', handle, scratch)) sourceSize = safeFloat(heapView(runtime, scratch, 4).getFloat32(0, true));
            sourceFontSizes.push(sourceSize);
            const font = runtime.call('FPDFTextObj_GetFont', handle) >>> 0;
            objectFonts.push(fontIndex(font, characterIndex));
            return id;
        };
        for (let i = 0; i < n; i++) {
            codepoints[i] = runtime.call('FPDFText_GetUnicode', textPage, i) >>> 0;
            const generated = runtime.call('FPDFText_IsGenerated', textPage, i) === 1;
            if (generated) flags[i] |= GENERATED;
            if (runtime.call('FPDFText_IsHyphen', textPage, i) === 1) flags[i] |= LINE_HYPHEN;
            if (runtime.call('FPDFText_HasUnicodeMapError', textPage, i) === 1) flags[i] |= UNICODE_ERROR;
            const handle = generated ? 0 : runtime.call('FPDFText_GetTextObject', textPage, i) >>> 0;
            const obj = objectIndex(handle, i);
            object[i] = obj;
            if (obj >= 0 && (modes[obj] === 3 || modes[obj] === 7)) flags[i] |= INVISIBLE;
            const font = runtime.call('FPDFText_GetFontSize', textPage, i);
            fontSize[i] = safeFloat(font > 0 ? font : 0);
            if (runtime.call('FPDFText_GetMatrix', textPage, i, scratch)) {
                const view = heapView(runtime, scratch, 24);
                const a = view.getFloat32(0, true), b = view.getFloat32(4, true), c = view.getFloat32(8, true);
                const d = view.getFloat32(12, true), e = view.getFloat32(16, true), f = view.getFloat32(20, true);
                const composed = [transform[0] * a + transform[2] * b, transform[1] * a + transform[3] * b,
                    transform[0] * c + transform[2] * d, transform[1] * c + transform[3] * d,
                    transform[0] * e + transform[2] * f + transform[4], transform[1] * e + transform[3] * f + transform[5]].map(safeFloat);
                matrix.set(composed.slice(0, 4), i * 4);
                textMatrix.set(composed, i * 6);
            }
            if (generated && i > 0) {
                origin[i * 2] = origin[(i - 1) * 2]; origin[i * 2 + 1] = origin[(i - 1) * 2 + 1];
            } else if (runtime.call('FPDFText_GetCharOrigin', textPage, i, scratch, scratch + 8)) {
                const view = heapView(runtime, scratch, 16);
                const point = pdfiumTransformPoint(transform, view.getFloat64(0, true), view.getFloat64(8, true));
                origin[i * 2] = safeFloat(point[0]); origin[i * 2 + 1] = safeFloat(point[1]);
            }
            if (!generated && runtime.call('FPDFText_GetCharBox', textPage, i, scratch, scratch + 8, scratch + 16, scratch + 24)) {
                const view = heapView(runtime, scratch, 32);
                const box = pdfiumTransformBox(transform, view.getFloat64(0, true), view.getFloat64(16, true), view.getFloat64(8, true), view.getFloat64(24, true));
                tight.set(box, i * 4);
            }
            if (!generated && runtime.call('FPDFText_GetLooseCharBox', textPage, i, scratch)) {
                const view = heapView(runtime, scratch, 16);
                loose.set(pdfiumTransformBox(transform, view.getFloat32(0, true), view.getFloat32(12, true), view.getFloat32(8, true), view.getFloat32(4, true)), i * 4);
            } else if (!generated) loose.set(tight.subarray(i * 4, i * 4 + 4), i * 4);
            const k = i * 4;
            if (!generated && (loose[k + 2] <= 0 || loose[k + 3] <= 0 || loose[k] >= geometry.width || loose[k + 1] >= geometry.height) &&
                (loose[k + 2] > loose[k] && loose[k + 3] > loose[k + 1])) flags[i] |= OUTSIDE;
        }
        const raw: RawPageText = { n, truncated, codepoints, flags, loose, tight, origin, matrix, textMatrix, fontSize, object,
            objects: { renderMode: Uint8Array.from(modes), fill: Uint32Array.from(fills), mcid: Int32Array.from(mcids),
                font: Uint16Array.from(objectFonts), sourceFontSize: Float32Array.from(sourceFontSizes),
                opacity: Float32Array.from(opacities), hasTransparency: Uint8Array.from(transparency) },
            fontNames, fontAscent: Float32Array.from(fontAscents), fontDescent: Float32Array.from(fontDescents) };
        return { raw, objectHandles };
    });
}
