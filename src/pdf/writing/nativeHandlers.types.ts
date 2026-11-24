import type { WorkerContext } from '../../platform/workers/serve';
import type { BackendInfo } from '../engine/types';
import type { PdfiumLoadOptions } from '../engine/pdfium/loader';
import type { WriterOperations } from './protocol';

/** Native state is owned entirely by the isolated writer worker. */
export type PdfWriterHandler = (args: unknown, context: WorkerContext) => unknown | Promise<unknown>;
export interface PdfWriterRuntime {
    readonly info: BackendInfo;
    readonly handlers: Record<keyof WriterOperations, PdfWriterHandler>;
    heapBytes(): number;
    close(): void | Promise<void>;
}
export type CreatePdfWriterRuntime = (options: PdfiumLoadOptions) => Promise<PdfWriterRuntime>;
