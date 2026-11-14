import { version } from 'pdfjs-dist';
import type { PDFPageProxy } from 'pdfjs-dist';
import { classicAssets } from 'virtual:pdfjs-classic-assets';
import { EMPHASIS_ALGORITHM } from './readingEmphasis';
import type { PdfEmphasisVerdictKey, PdfEmphasisVerdictState } from './pdfEmphasisVerdicts';
import type { PdfNativeEmphasisResult } from './pdfNativeEmphasis';

/** Reader and pristine annotation sources must supply their own byte identity.
 * The current classic paths use display intent, default annotations and OCGs,
 * a white background and the PDF's native crop/rotation. */
export function classicEmphasisKey(bytes: string, page: number, geometry: string): PdfEmphasisVerdictKey {
    let locale = '';
    try { locale = new Intl.Segmenter().resolvedOptions().locale; } catch { /* conservative segmentation fallback */ }
    return { bytes, page, algorithm: EMPHASIS_ALGORITHM, locale, planner: 'classic-glyph-plan-v1',
        stroke: '.035em', renderer: version, assets: classicAssets.manifestHash, intent: 'display',
        annotations: 'default', optionalContent: 'default', geometry, background: 'white-srgb', probe: 'classic-page-probe-v1' };
}
export function classicEmphasisPageKey(bytes: string, index: number, page: PDFPageProxy): PdfEmphasisVerdictKey {
    return classicEmphasisKey(bytes, index, JSON.stringify([page.view, page.rotate, page.userUnit]));
}
export function classicEmphasisResult(state: PdfEmphasisVerdictState): PdfNativeEmphasisResult | undefined {
    if (state.kind === 'verified') return state.result;
    if (state.kind !== 'unavailable') return undefined;
    const reason = state.reason === 'renderer-version' ? 'renderer-version'
        : state.reason === 'page-budget' ? 'page-budget' : 'glyph-data';
    return { glyphs: 0, candidates: 0, painted: 0, eligible: 0, skipped: 0, supported: false, reason };
}
