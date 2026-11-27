import type { PdfConvertedInkSource } from './legacyInkAcquisition.types';

const converted = new WeakSet<object>();
export function markConvertedPdfInkSource(source: PdfConvertedInkSource): void { converted.add(source); }
export function isConvertedPdfInkSource(value: unknown): value is PdfConvertedInkSource {
    return !!value && typeof value === 'object' && converted.has(value);
}
