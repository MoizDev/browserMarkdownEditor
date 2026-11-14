import type { Layer, PlatformLayerDefinition, ViewState } from '../../platform/render';
import type { PdfDemandInput, PdfTileRequest } from './tileDemand';
import { PdfTileLayer } from './tileLayer';
import type { PdfLayerMirror, PdfTileProducer } from './tileLayer';
import type { PdfVersionBridge } from './versionBridge';

/** The definition is stable for one view lease; the platform owns its layer's
 * final GPU release/dispose. The pane may cancel view work without closing the
 * App-owned document session or its mirror store. */
export function pdfPageLayerDefinition(options: {
    producer: PdfTileProducer;
    demand(view: ViewState): Omit<PdfDemandInput, 'covered' | 'previousMotionScale'>;
    isCurrent(): boolean;
    onError(error: unknown, request: PdfTileRequest): void;
    mirror?: PdfLayerMirror;
    bridge?: PdfVersionBridge | null;
}): { definition: PlatformLayerDefinition; current(): PdfTileLayer | null } {
    let current: PdfTileLayer | null = null;
    const asTileLayer = (layer: Layer): PdfTileLayer => layer as PdfTileLayer;
    const definition: PlatformLayerDefinition = {
        id: 'pdf-page', group: 'document',
        create(host) {
            const layer = new PdfTileLayer(host, options.producer, options.demand, options.isCurrent, options.onError, options.mirror, options.bridge);
            current = layer;
            return layer;
        },
        revision: layer => asTileLayer(layer).revision(),
        cpuWorkingSet: (layer, viewport) => asTileLayer(layer).cpuWorkingSet(viewport),
        critical: () => true,
        coverage: (layer, frame, backend) => asTileLayer(layer).coverage(frame.view, backend !== 'canvas2d'),
    };
    return { definition, current: () => current };
}
