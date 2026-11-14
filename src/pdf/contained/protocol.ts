import type { EngineInitArgs } from '../worker/protocol';

export const PDF_FRAME_VERSION = 1;
export const PDF_BROKER_BUILD = 'pdf-broker-v1';
export interface PdfFrameIdentity { v: 1; nonce: string; epoch: number }
export interface PdfFrameInit extends PdfFrameIdentity { kind: 'pdf-frame.init' }
export interface PdfWorkerBootstrap {
    id: number;
    generation: number;
    workerSource: string;
    glueSource: string;
    /** Host-authenticated immutable engine bytes; never a Module or a transfer list entry. */
    wasm: Blob;
    abi: unknown;
    engine: Omit<EngineInitArgs, 'engineUrl'>;
}
export interface PdfBrokerSpawnResult {
    id: number;
    generation: number;
    engineUrl: string;
    port: MessagePort;
}
export interface PdfWorkerBinding {
    nonce: string;
    id: number;
    generation: number;
    port: MessagePort;
    glueUrl: string;
    abi: unknown;
    engine: EngineInitArgs;
}
export interface PdfBrokerOps {
    'broker.spawn': { args: PdfWorkerBootstrap; result: PdfBrokerSpawnResult };
    'broker.terminate': { args: { id: number; generation: number }; result: Record<string, never> };
    'broker.compiled': { args: { id: number; generation: number }; result: Record<string, never> };
    'broker.ping': { args: Record<string, never>; result: Record<string, never> };
}
export function positiveInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
export function frameRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
