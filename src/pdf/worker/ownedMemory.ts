import type { RawPageText } from '../engine/types';

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const add = (a: number, b: number): number => Math.min(MAX_SAFE, a + b);
const amount = (value: number): number => Number.isSafeInteger(value) && value >= 0 ? value : 0;

/** An advisory ownership estimate, not a measurement of JavaScript heap or RSS.
 * Backing stores are charged once, even when several retained views share one. */
export function pdfWorkerOwnedMemory(backendHeapBytes: number, fonts: Iterable<Uint8Array>,
    documents: Iterable<{ source: { cachedBytes: number }; raw: Map<number, RawPageText> }>): {
        heapBytes: number; fontBytes: number; blockCacheBytes: number; textBytes: number; ownedBytes: number;
    } {
    const seen = new Set<ArrayBufferLike>();
    const backing = (view: ArrayBufferView | undefined): number => {
        if (!view || seen.has(view.buffer)) return 0;
        seen.add(view.buffer);
        return amount(view.buffer.byteLength);
    };
    let fontBytes = 0, blockCacheBytes = 0, textBytes = 0;
    for (const font of fonts) fontBytes = add(fontBytes, backing(font));
    for (const document of documents) {
        blockCacheBytes = add(blockCacheBytes, amount(document.source.cachedBytes));
        for (const raw of document.raw.values()) {
            // Fixed field lists avoid walking the per-character typed arrays.
            const views: Array<ArrayBufferView | undefined> = [raw.codepoints, raw.flags, raw.loose, raw.tight, raw.origin,
                raw.matrix, raw.fontSize, raw.object, raw.textMatrix, raw.fontAscent, raw.fontDescent,
                raw.objects.renderMode, raw.objects.fill, raw.objects.mcid, raw.objects.font, raw.objects.sourceFontSize,
                raw.objects.opacity, raw.objects.hasTransparency, raw.objects.type3, raw.struct?.mcids, raw.struct?.roles];
            let page = 512 + views.length * 64;
            for (const view of views) page = add(page, backing(view));
            // String/record sizes are conservative model charges, not V8 layout.
            page = add(page, 64 + raw.fontNames.length * 16);
            for (const name of raw.fontNames) page = add(page, 32 + name.length * 2);
            if (raw.struct) {
                page = add(page, 256);
                for (const pairs of [raw.struct.lang, raw.struct.alt, raw.struct.actualText ?? []]) {
                    page = add(page, 64 + pairs.length * 48);
                    for (const [, value] of pairs) page = add(page, 32 + value.length * 2);
                }
                page = add(page, 64 + (raw.struct.figures?.length ?? 0) * 128);
            }
            textBytes = add(textBytes, page);
        }
    }
    const heapBytes = amount(backendHeapBytes);
    return { heapBytes, fontBytes, blockCacheBytes, textBytes,
        ownedBytes: add(add(heapBytes, fontBytes), add(blockCacheBytes, textBytes)) };
}
