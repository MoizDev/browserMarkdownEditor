import { createWorkerClient } from '../../platform/workers/client';
import type { DisplayPdfInput, InkPackage, InkPageInput } from './types';

// A separate, lazy worker keeps the new writer behind its entry point and cannot
// interfere with a legacy annotation save that is already in flight.
const client = createWorkerClient({
    name: 'display-pdf-writer', protocol: 1,
    spawn: () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
});

/** Produces staged bytes only. The caller owns vault, revision and destination checks. */
export function buildDisplayPdf(input: DisplayPdfInput, options: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
    return client.request<Uint8Array>('build', input, { priority: 2, cpu: 'governed', signal: options.signal });
}

/** Emit resolution-free ink for a separate assembler; this never receives an imported PDF. */
export function emitInkPdf(pages: readonly InkPageInput[], options: { signal?: AbortSignal } = {}): Promise<InkPackage> {
    return client.request<InkPackage>('emitInk', pages, { priority: 2, cpu: 'governed', signal: options.signal });
}
