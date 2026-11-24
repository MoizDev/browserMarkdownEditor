import type { Layer, PlatformLayerDefinition } from '../../platform/render';
import { PdfTextHighlightLayer } from './textHighlight';
import type { PdfHighlightPalette, PdfHighlightRects } from './textHighlight';

/** The pane supplies this stable definition after the document page layer. */
export function pdfTextHighlightDefinition(initialPalette: PdfHighlightPalette): {
    definition: PlatformLayerDefinition;
    setRects(rects: PdfHighlightRects): void;
    setPalette(palette: PdfHighlightPalette): void;
} {
    let revision = 0, current: PdfTextHighlightLayer | null = null, palette = initialPalette;
    let rects: PdfHighlightRects = { find: [], current: [], selection: [] };
    const definition: PlatformLayerDefinition = {
        id: 'pdf-text-highlight', group: 'chrome',
        create(host) { current = new PdfTextHighlightLayer(host, palette); current.setRects(rects); return current; },
        revision: (_layer: Layer) => revision,
        critical: () => false,
        coverage: () => ({ complete: true, sharp: true }),
    };
    return {
        definition,
        setRects(next) { rects = next; revision++; current?.setRects(next); },
        setPalette(next) { palette = next; revision++; current?.setPalette(next); },
    };
}
