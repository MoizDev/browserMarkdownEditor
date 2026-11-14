import type { PageGeometry } from '../../platform/types';
import type { RenderToken } from '../../platform/render/types';
import type { Priority, RequestOptions } from '../../platform/workers/envelope';
import type { DocInfo, RawPdfLink, RawOutlineNode, PageComplexity } from '../engine/types';
import type { PdfArgs, PdfResult, PdfEngineOp, PdfDocKey, PdfTextDetail, PageTextReply, PageTileArgs, PageTileResult,
    PageProbeArgs, PageProbeResult, PdfWorkerStats } from '../worker/protocol';

export type PdfRequestOptions = Pick<RequestOptions, 'priority' | 'signal' | 'deadlineMs'>;
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

/** A retained, source-explicit document lease. Closing it cannot cancel another
 * pane's lease or change PDF bytes. Session/token checks guard every publication. */
export interface PdfPoolDocument {
    readonly docKey: PdfDocKey;
    readonly token: RenderToken;
    readonly source: 'outer' | 'original';
    readonly info: Readonly<DocInfo>;
    readonly closed: boolean;
    geometry(page: number): Readonly<PageGeometry>;
    request<K extends PdfDocumentOp>(op: K, args: Omit<PdfArgs<K>, 'docKey'>, options: PdfRequestOptions): Promise<PdfResult<K>>;
    text(page: number, detail: PdfTextDetail, options: PdfRequestOptions): Promise<PageTextReply>;
    tile(args: Omit<PageTileArgs, 'docKey'>, options: PdfRequestOptions): Promise<PageTileResult>;
    links(page: number, options: PdfRequestOptions): Promise<RawPdfLink[]>;
    outline(options: PdfRequestOptions): Promise<RawOutlineNode[]>;
    complexity(page: number, options: PdfRequestOptions): Promise<PageComplexity>;
    probe(args: Omit<PageProbeArgs, 'docKey'>, options: PdfRequestOptions): Promise<PageProbeResult>;
    attachment(index: number, maxBytes: number, options: PdfRequestOptions): Promise<ArrayBuffer>;
    releasePage(page: number): void;
    /** Highest-priority live waiter wins, including already queued/running extraction. */
    reprioritise(request: Promise<unknown>, priority: Priority): void;
    setVisible(visible: boolean): void;
    close(): Promise<void>;
}

/** Dedicated engine instance. Its typed writer facade/operation map lives in
 * writing/protocol.ts; this host seam deliberately has C5's generic request shape. */
export interface PdfWriterSession {
    request<T>(op: string, args: unknown, options: PdfRequestOptions): Promise<T>;
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
