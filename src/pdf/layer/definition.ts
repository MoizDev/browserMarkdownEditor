import type { Layer, PlatformLayerDefinition, Rect, ViewState } from '../../platform/render';
import type { PdfDemandInput, PdfTileRequest } from './tileDemand';
import { PdfTileLayer } from './tileLayer';
import type { PdfLayerMirror, PdfTileProducer } from './tileLayer';
import type { PdfVersionBridge } from './versionBridge';

export function pdfPageLayerDefinition(options: {
    producer: PdfTileProducer;
    demand(view: ViewState): Omit<PdfDemandInput, 'covered' | 'previousMotionScale'>;
    isCurrent(): boolean;
    onError(error: unknown, request: PdfTileRequest | null): void;
    mirror?: PdfLayerMirror;
    bridge?: PdfVersionBridge | null;
}): { definition: PlatformLayerDefinition; current(): PdfTileLayer | null; drawnPageRects(): readonly Rect[] } {
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
        cpuEvict: (layer, bytes) => asTileLayer(layer).cpuEvict(bytes),
        critical: (layer, view) => asTileLayer(layer).critical(view),
        coverage: (layer, frame, backend) => asTileLayer(layer).coverage(frame.view, backend !== 'canvas2d'),
    };
    return { definition, current: () => current, drawnPageRects: () => current?.drawnPageRects() ?? [] };
}
