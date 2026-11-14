import type { PdfConvertedInkSource } from './legacyInkAcquisition.types';

const converted = new WeakSet<object>();
/** Only the converted-source admission path may mark a source. */
export function markConvertedPdfInkSource(source: PdfConvertedInkSource): void { converted.add(source); }
export function isConvertedPdfInkSource(value: unknown): value is PdfConvertedInkSource {
    return !!value && typeof value === 'object' && converted.has(value);
}
