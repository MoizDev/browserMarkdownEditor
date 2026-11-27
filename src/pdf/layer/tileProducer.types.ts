import type { PdfPoolDocument } from '../pool/types';
import type { TileVariant } from '../worker/protocol';
import type { PdfTileRequest } from './tileDemand';
import type { PdfTileProducer } from './tileLayer';

export interface PdfTileProducerOptions {
    readonly document: PdfPoolDocument;
    readonly isCurrent: () => boolean;
    readonly isFocused: () => boolean;
    variant(request: PdfTileRequest): TileVariant;
    readonly annotations: boolean;
    readonly forms: boolean;
}

export type CreatePdfTileProducer = (options: PdfTileProducerOptions) => PdfTileProducer;
