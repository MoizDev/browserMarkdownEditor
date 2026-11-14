import { Sha256 } from '../../utils/sha256';
import { PDF_FONT_CATALOGUE } from './catalogue';
import type { PdfFontId } from './catalogue';

interface Profile { fonts: Set<PdfFontId>; listeners: Set<() => void>; fingerprint?: string }
const profiles = new Map<string, Profile>();
function fingerprint(fonts: Iterable<PdfFontId>): string {
    const pins = [...fonts].sort().map(id => [id, PDF_FONT_CATALOGUE[id].sha256]);
    return new Sha256().update(new TextEncoder().encode(`pdf-font-profile-v1\0${JSON.stringify(pins)}`)).digest();
}
const EMPTY_FINGERPRINT = fingerprint([]);
function profile(docKey: string): Profile {
    if (typeof docKey !== 'string' || !docKey || docKey.length > 2048) throw new RangeError('Invalid PDF font profile key');
    let entry = profiles.get(docKey);
    if (!entry) { entry = { fonts: new Set(), listeners: new Set() }; profiles.set(docKey, entry); }
    return entry;
}

/** The owner releases the profile when the final lease on this document closes. */
export function getPdfFontEpoch(docKey: string): number { return profiles.get(docKey)?.fonts.size ?? 0; }
/** Availability identity is stable across workers and document byte generations. */
export function getPdfFontProfileKey(docKey: string): string {
    const entry = profiles.get(docKey);
    if (!entry || !entry.fonts.size) return EMPTY_FINGERPRINT;
    return entry.fingerprint ??= fingerprint(entry.fonts);
}
export function notePdfFontProvided(docKey: string, id: PdfFontId): void {
    if (!Object.hasOwn(PDF_FONT_CATALOGUE, id)) throw new RangeError('Unknown PDF font');
    const entry = profile(docKey);
    if (entry.fonts.has(id)) return;
    entry.fonts.add(id); entry.fingerprint = undefined;
    for (const listener of [...entry.listeners]) listener();
}
export function subscribePdfFontEpoch(docKey: string, listener: () => void): () => void {
    const entry = profile(docKey);
    entry.listeners.add(listener);
    return () => { entry.listeners.delete(listener); };
}
export function releasePdfFontProfile(docKey: string): void { profiles.delete(docKey); }
export function pdfMirrorProfilePrefix(variant: 'plain' | 'emphasis', docKey: string): string {
    if (variant !== 'plain' && variant !== 'emphasis') throw new RangeError('Invalid PDF mirror variant');
    return `${variant}:fonts:${getPdfFontProfileKey(docKey)}:proof:`;
}
export function pdfVariantRevision(variant: 'plain' | 'emphasis', epoch: number): string {
    if ((variant !== 'plain' && variant !== 'emphasis') || !Number.isSafeInteger(epoch) || epoch < 0) throw new RangeError('Invalid PDF font revision');
    return epoch === 0 ? variant : `${variant}@font:${epoch}`;
}
