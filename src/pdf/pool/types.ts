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
    /** Refuse an oversized capture; never silently reduce the requested scale. */
    maxPixels?: number;
};
export interface PdfOpenOptions {
    /** App-owned full session token; only its first three fields enter docKey. */
    token: RenderToken;
    source: 'outer' | 'original';
    /** Already memory-backed, immutable. A disk-backed File is not accepted. */
    blob: Blob;
    password?: string;
    priority: Priority;
    signal?: AbortSignal;
}
export type PdfDocumentOp = Exclude<PdfEngineOp, 'engine.init' | 'doc.open' | 'doc.close' | 'font.provide' | 'worker.stats'>;
export type WithoutDocKey<T> = T extends unknown ? Omit<T, 'docKey'> : never;

/** A retained, source-explicit document lease. Closing it cannot cancel another
 * pane's lease or change PDF bytes. Session/token checks guard every publication. */
export interface PdfPoolDocument {
    readonly docKey: PdfDocKey;
    readonly token: RenderToken;
    readonly source: 'outer' | 'original';
    readonly info: Readonly<DocInfo>;
    readonly closed: boolean;
    /** Exact transforms are acquired on demand; document extents alone are layout estimates. */
    resolveGeometry(page: number, options: PdfRequestOptions): Promise<Readonly<PageGeometry>>;
    request<K extends PdfDocumentOp>(op: K, args: WithoutDocKey<PdfArgs<K>>, options: PdfRequestOptions): Promise<PdfResult<K>>;
    text(page: number, detail: PdfTextDetail, options: PdfRequestOptions): Promise<PageTextReply>;
    tile(args: WithoutDocKey<PageTileArgs>, options: PdfRequestOptions): Promise<PageTileResult>;
    /** Release raw reply credit after every consumer has finished bitmap conversion. Idempotent. */
    releaseTile(result: PageTileResult): void;
    /** Independent of viewport demand; composes exact-scale tiles, caller owns bitmap. */
    renderPage(page: number, scale: number, options: PdfPageBitmapOptions): Promise<ImageBitmap>;
    /** Plain/emphasis follows explicit options, but dispatch is always priority 3. */
    thumbnail(page: number, maxSidePx: number, options: Omit<PdfPageBitmapOptions, 'priority' | 'maxPixels'>): Promise<ImageBitmap>;
    links(page: number, options: PdfRequestOptions): Promise<RawPdfLink[]>;
    outline(options: PdfRequestOptions): Promise<RawOutlineNode[]>;
    complexity(page: number, options: PdfRequestOptions): Promise<PageComplexity>;
    probe(args: Omit<PageProbeArgs, 'docKey'>, options: PdfRequestOptions): Promise<PageProbeResult>;
    attachment(index: number, maxBytes: number, options: PdfRequestOptions): Promise<ArrayBuffer>;
    releasePage(page: number): void;
    /** Highest-priority live waiter wins, including already queued/running extraction. */
    reprioritise(request: Promise<unknown>, priority: Priority): void;
    setVisible(visible: boolean): void;
    /** Explicitly clear failures for this lease's document without replacing its source. */
    retry(): Promise<void>;
    close(): Promise<void>;
}

/** Dedicated engine instance; the writer owns its single operation map. */
export interface PdfWriterSession {
    request<K extends keyof WriterOperations>(op: K, args: WriterOperations[K]['args'], options: PdfRequestOptions): Promise<WriterOperations[K]['result']>;
    reprioritise(request: Promise<unknown>, priority: Priority): void;
    close(): Promise<void>;
}
export interface PdfPool {
    open(options: PdfOpenOptions): Promise<PdfPoolDocument>;
    writer(options?: { signal?: AbortSignal }): Promise<PdfWriterSession>;
    stats(): Promise<readonly PdfWorkerStats[]>;
    /** Explicit user recovery, never an automatic switch to the classic parser. */
    retry(docKey: PdfDocKey): Promise<void>;
    dispose(): void;
}
