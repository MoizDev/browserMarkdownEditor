import type { EmphasisAvailability } from '../types/reading';

export interface PdfNativeEmphasisResult {
    glyphs: number;
    candidates: number;
    painted: number;
    eligible: number;
    skipped: number;
    supported: boolean;
    reason?: 'renderer-version' | 'glyph-data' | 'page-budget';
}

/** Header status is pure data; asking for availability must not load a renderer. */
export function pdfNativeEmphasisAvailability(result?: PdfNativeEmphasisResult): EmphasisAvailability {
    if (!result) return { kind: 'inactive', reason: 'Checking original PDF text for Word emphasis' };
    if (result.supported && result.eligible > 0) return { kind: 'toggle' };
    return { kind: 'inactive', reason: pdfNativeEmphasisNotice(result) || 'No supported original glyphs on this page' };
}
export function pdfNativeEmphasisNotice(result?: PdfNativeEmphasisResult): string {
    if (!result) return '';
    if (!result.supported) return result.reason === 'renderer-version'
        ? 'Word emphasis is unavailable with this PDF renderer version.'
        : 'Word emphasis is unavailable for this page’s text encoding or size.';
    if (result.glyphs === 0) return 'This page has no text glyphs to emphasize.';
    if (result.eligible === 0) return 'No supported visible word prefixes on this page.';
    return result.painted < result.candidates ? 'Word emphasis applied to supported text on this page.' : '';
}
