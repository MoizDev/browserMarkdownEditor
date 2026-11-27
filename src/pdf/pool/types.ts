import type { PageGeometry } from '../../platform/types';
import type { RenderToken } from '../../platform/render/types';
import type { Priority, RequestOptions } from '../../platform/workers/envelope';
import type { DocInfo, RawPdfLink, RawOutlineNode, PageComplexity } from '../engine/types';
import type { WriterOperations } from '../writing/protocol';
import type { PdfArgs, PdfResult, PdfEngineOp, PdfDocKey, PdfTextDetail, PageTextReply, PageTileArgs, PageTileResult,
    PageProbeArgs, PageProbeResult, PdfWorkerStats, TileVariant } from '../worker/protocol';

export type PdfRequestOptions = Pick<RequestOptions, 'priority' | 'signal' | 'deadlineMs'>;
export type PdfPageBitmapOptions = PdfRequestOptions & TileVariant & {
    profileKey: string;
    annotations?: boolean;
    forms?: boolean;
    maxPixels?: number;
};
export interface PdfOpenOptions {
    token: RenderToken;
    source: 'outer' | 'original';
    /** Immutable: memory-backed, or a nameless slice of the disk snapshot whose memory-backed copy the caller hands to
     * `adoptSource` once made. A File itself is refused (its name must not reach the contained engine). */
    blob: Blob;
    password?: string;
    priority: Priority;
    signal?: AbortSignal;
}
export type PdfDocumentOp = Exclude<PdfEngineOp, 'engine.init' | 'doc.open' | 'doc.close' | 'doc.adoptSource' | 'font.provide' | 'worker.stats'>;
export type WithoutDocKey<T> = T extends unknown ? Omit<T, 'docKey'> : never;

export interface PdfPoolDocument {
    readonly docKey: PdfDocKey;
    readonly token: RenderToken;
    readonly source: 'outer' | 'original';
    readonly info: Readonly<DocInfo>;
    readonly closed: boolean;
    peekGeometry(page: number): Readonly<PageGeometry> | undefined;
    resolveGeometry(page: number, options: PdfRequestOptions): Promise<Readonly<PageGeometry>>;
    request<K extends PdfDocumentOp>(op: K, args: WithoutDocKey<PdfArgs<K>>, options: PdfRequestOptions): Promise<PdfResult<K>>;
    text(page: number, detail: PdfTextDetail, options: PdfRequestOptions): Promise<PageTextReply>;
    tile(args: WithoutDocKey<PageTileArgs>, options: PdfRequestOptions): Promise<PageTileResult>;
    releaseTile(result: PageTileResult): void;
    renderPage(page: number, scale: number, options: PdfPageBitmapOptions): Promise<ImageBitmap>;
    thumbnail(page: number, maxSidePx: number, options: Omit<PdfPageBitmapOptions, 'priority' | 'maxPixels'>): Promise<ImageBitmap>;
    links(page: number, options: PdfRequestOptions): Promise<RawPdfLink[]>;
    outline(options: PdfRequestOptions): Promise<RawOutlineNode[]>;
    complexity(page: number, options: PdfRequestOptions): Promise<PageComplexity>;
    probe(args: Omit<PageProbeArgs, 'docKey'>, options: PdfRequestOptions): Promise<PageProbeResult>;
    attachment(index: number, maxBytes: number, options: PdfRequestOptions): Promise<ArrayBuffer>;
    releasePage(page: number): void;
    reprioritise(request: Promise<unknown>, priority: Priority): void;
    setVisible(visible: boolean): void;
    adoptSource(blob: Blob): Promise<void>;
    retry(): Promise<void>;
    close(): Promise<void>;
}

export interface PdfWriterSession {
    request<K extends keyof WriterOperations>(op: K, args: WriterOperations[K]['args'], options: PdfRequestOptions): Promise<WriterOperations[K]['result']>;
    reprioritise(request: Promise<unknown>, priority: Priority): void;
    close(): Promise<void>;
}
export interface PdfPool {
    readonly geometryEngine: Readonly<WriterOperations['writer.stageAnnotated']['result']['geometryEngine']>;
    open(options: PdfOpenOptions): Promise<PdfPoolDocument>;
    writer(options?: { signal?: AbortSignal }): Promise<PdfWriterSession>;
    stats(): Promise<readonly PdfWorkerStats[]>;
    warm(): void;
    retry(docKey: PdfDocKey): Promise<void>;
    dispose(): void;
}
