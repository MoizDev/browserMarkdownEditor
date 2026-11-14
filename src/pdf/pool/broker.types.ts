import type { ContainedPort } from '../../platform/workers/envelope';
import type { EngineInitArgs } from '../worker/protocol';
import type { PdfPool } from './types';

/** The opaque frame owns verification, compilation, worker construction and
 * engine bootstrap. The pool receives only a C5 MessagePort, never WASM or a
 * native handle. A writer spawn is separate from every render slot. */
export interface PdfEnginePort extends ContainedPort {
    readonly engine: EngineInitArgs;
    compiled(): Promise<void>;
}
export interface PdfWorkerBroker {
    spawn(role: 'render' | 'writer', workerId: number): Promise<PdfEnginePort>;
    dispose(): void;
}
export interface PdfPoolOptions {
    broker: PdfWorkerBroker;
    hardwareConcurrency?: number;
    deviceMemory?: number;
}
export type PdfPoolFactory = (options: PdfPoolOptions) => PdfPool;
