import { PDF_FONT_CATALOGUE } from './catalogue';
import type { PdfFontId } from './catalogue';

interface Profile { fonts: Set<PdfFontId>; listeners: Set<() => void> }
const profiles = new Map<string, Profile>();
function profile(docKey: string): Profile {
    if (typeof docKey !== 'string' || !docKey || docKey.length > 2048) throw new RangeError('Invalid PDF font profile key');
    let entry = profiles.get(docKey);
    if (!entry) { entry = { fonts: new Set(), listeners: new Set() }; profiles.set(docKey, entry); }
    return entry;
}

/** The owner releases the profile when the final lease on this document closes. */
export function getPdfFontEpoch(docKey: string): number { return profiles.get(docKey)?.fonts.size ?? 0; }
export function notePdfFontProvided(docKey: string, id: PdfFontId): void {
    if (!Object.hasOwn(PDF_FONT_CATALOGUE, id)) throw new RangeError('Unknown PDF font');
    const entry = profile(docKey);
    if (entry.fonts.has(id)) return;
    entry.fonts.add(id);
    for (const listener of [...entry.listeners]) listener();
}
export function subscribePdfFontEpoch(docKey: string, listener: () => void): () => void {
    const entry = profile(docKey);
    entry.listeners.add(listener);
    return () => { entry.listeners.delete(listener); };
}
export function releasePdfFontProfile(docKey: string): void { profiles.delete(docKey); }
export function pdfVariantRevision(variant: 'plain' | 'emphasis', epoch: number): string {
    if ((variant !== 'plain' && variant !== 'emphasis') || !Number.isSafeInteger(epoch) || epoch < 0) throw new RangeError('Invalid PDF font revision');
    return epoch === 0 ? variant : `${variant}@font:${epoch}`;
}
