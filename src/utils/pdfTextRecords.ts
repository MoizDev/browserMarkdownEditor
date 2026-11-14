import type { PdfTextAnchor, PdfTextReadingRecord, PdfTextRecordRead } from '../types/reading';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
function context(value: unknown): value is string {
    if (typeof value !== 'string' || value.length > 512) return false;
    let count = 0;
    for (const _segment of segmenter.segment(value)) if (++count > 64) return false;
    return true;
}
function anchor(value: unknown): value is PdfTextAnchor {
    return object(value) && integer(value.physicalPageIndex) && integer(value.offsetUTF16) &&
        (value.affinity === 'before' || value.affinity === 'after') &&
        context(value.quote) && context(value.before) && context(value.after) &&
        (value.alignHint === undefined || finite(value.alignHint) && Math.abs(value.alignHint) <= 10000);
}
function base(value: unknown): value is Record<string, unknown> & {
    rawFingerprint: string; surface: 'original' | 'text'; textChoice?: 'manual';
    v: number; extractionSchema: number; textNavigationRevision: number;
    originalCheckpoint: PdfTextReadingRecord['originalCheckpoint'];
} {
    if (!object(value) || !integer(value.v) || value.v < 1 || !integer(value.extractionSchema) || value.extractionSchema < 1 ||
        (value.surface !== 'original' && value.surface !== 'text') || (value.textChoice !== undefined && value.textChoice !== 'manual') ||
        !hash(value.rawFingerprint) || !integer(value.textNavigationRevision) || !object(value.originalCheckpoint)) return false;
    const c = value.originalCheckpoint;
    return integer(c.page) && finite(c.offset) && c.offset >= 0 && c.offset <= 1 &&
        finite(c.zoom) && c.zoom > 0 && integer(c.navigationRevision);
}
export function isPdfTextReadingRecord(value: unknown): value is PdfTextReadingRecord {
    return base(value) && value.v === 1 && (value.extractionSchema === 1 || value.extractionSchema === 2) &&
        (value.pageDigest === undefined || hash(value.pageDigest)) && (value.textAnchor === undefined || anchor(value.textAnchor));
}

/** Reading never mutates the stored object. A future record contributes only
 * known camera/surface fields; even an unfamiliar anchor is not cloned or used. */
export function readPdfTextRecord(value: unknown): PdfTextRecordRead | undefined {
    if (!base(value)) return;
    const anchorUsable = value.v === 1 && value.extractionSchema <= 2;
    if (anchorUsable && !isPdfTextReadingRecord(value)) return;
    const record: PdfTextReadingRecord = {
        v: 1, extractionSchema: value.extractionSchema === 2 ? 2 : 1,
        rawFingerprint: value.rawFingerprint, surface: value.surface, textChoice: value.textChoice,
        originalCheckpoint: { ...value.originalCheckpoint }, textNavigationRevision: value.textNavigationRevision,
    };
    if (anchorUsable) {
        if (typeof value.pageDigest === 'string') record.pageDigest = value.pageDigest;
        if (value.textAnchor !== undefined) record.textAnchor = { ...value.textAnchor as PdfTextAnchor };
    }
    // Legacy emphasis opened Text implicitly. Preserve its camera and anchor,
    // but only an explicit manual Text choice may restore that surface.
    if (record.surface === 'text' && record.textChoice !== 'manual') record.surface = 'original';
    return { record, storedSchema: value.extractionSchema, storedV: value.v, anchorUsable };
}
