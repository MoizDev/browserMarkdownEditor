import type { ContainedPort } from '../../platform/workers/envelope';
import type { EngineInitArgs } from '../worker/protocol';
import type { PdfPool } from './types';

export interface PdfEnginePort extends ContainedPort {
    readonly engine: EngineInitArgs;
    compiled(): Promise<void>;
}
export interface PdfWorkerBroker {
    spawn(role: 'render' | 'writer', workerId: number): Promise<PdfEnginePort>;
    /** Explicit user Retry only; ordinary requests cannot clear frame quarantine. */
    reset?(): void;
    dispose(): void;
}
export interface PdfPoolOptions {
    broker: PdfWorkerBroker;
    hardwareConcurrency?: number;
    deviceMemory?: number;
}
export type PdfPoolFactory = (options: PdfPoolOptions) => PdfPool;
