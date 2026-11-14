import type { PageViewport, TextLayer } from 'pdfjs-dist';

/** Measured: pdf.js 6.1.200 resets its ascent canvas to 0×0 but keeps a 30px
 *  font-cache entry. A 15pt title at DPR 2 is then measured in 10px sans-serif:
 *  scaleX 3.7717, copying 8 of 29 characters. Public update() never measures
 *  ascent, so normalize its current scale (DPR may have moved while streaming),
 *  then force two different measurement passes without replacing any DOM.
 *  Upstream 6.4.299 removes the reset (published build/pdf.mjs:15343–15374).
 *  Delete when the classic pin reaches ≥ 6.4.299. */
export function remeasurePdfTextLayer(layer: TextLayer, viewport: PageViewport): void {
    layer.update({ viewport });
    layer.update({ viewport: viewport.clone({ scale: viewport.scale / 2 }) });
    layer.update({ viewport });
}
