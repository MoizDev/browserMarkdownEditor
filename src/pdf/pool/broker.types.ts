import type { ContainedPort } from '../../platform/workers/envelope';
import type { PdfPool } from './types';

/** The opaque frame owns verification, compilation, worker construction and
 * engine bootstrap. The pool receives only a C5 MessagePort, never WASM or a
 * native handle. A writer spawn is separate from every render slot. */
export interface PdfWorkerBroker {
    spawn(role: 'render' | 'writer', workerId: number): Promise<ContainedPort>;
    dispose(): void;
}
export interface PdfPoolOptions {
    broker: PdfWorkerBroker;
    hardwareConcurrency?: number;
    deviceMemory?: number;
}
export type PdfPoolFactory = (options: PdfPoolOptions) => PdfPool;
