import type { TypedPdfWriter } from '../../pdf/writing/writerClient';
import type { WriterSource } from '../../pdf/writing/protocol';
import type { MediaEntry, MediaId } from '../model/media';
import type { PdfInkSnapshot } from './pdfInkExport';

export interface PinnedPdfInkSnapshot {
    readonly revision: number;
    readonly source: WriterSource;
    readonly ink: PdfInkSnapshot;
    readonly media: readonly MediaEntry[];
    readonly writeId: string;
    mediaBlob(id: MediaId): Blob | undefined;
    isCurrent(): boolean;
    release(): void;
}
export type OpenPdfInkWriter = (signal: AbortSignal) => Promise<TypedPdfWriter>;
