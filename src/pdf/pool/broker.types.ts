import type { ContainedPort } from '../../platform/workers/envelope';

/** The opaque frame owns verification, compilation, worker construction and
 * engine bootstrap. The pool receives only a C5 MessagePort, never WASM or a
 * native handle. A writer spawn is separate from every render slot. */
export interface PdfWorkerBroker {
    spawn(role: 'render' | 'writer', workerId: number): Promise<ContainedPort>;
    dispose(): void;
}
