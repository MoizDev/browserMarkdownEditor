import type { PdfPoolDocument } from '../pool/types';
import type { TileVariant } from '../worker/protocol';
import type { PdfTileRequest } from './tileDemand';
import type { PdfTileProducer } from './tileLayer';

/** One producer is bound to one pool document lease and never owns or closes it. */
export interface PdfTileProducerOptions {
    readonly document: PdfPoolDocument;
    readonly isCurrent: () => boolean;
    readonly isFocused: () => boolean;
    /** Profile and emphasis parameters are frozen for each submitted request. */
    variant(request: PdfTileRequest): TileVariant;
    readonly annotations: boolean;
    readonly forms: boolean;
}

export type CreatePdfTileProducer = (options: PdfTileProducerOptions) => PdfTileProducer;
