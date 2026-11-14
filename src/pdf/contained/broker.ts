import { source as workerSource } from 'virtual:pdf-engine-worker';
import { PdfEngineError } from '../engine/types';
import type { PdfWorkerBroker } from '../pool/broker.types';
import { loadTrustedPdfAssets } from './assets';
import { PdfEngineFrame } from './bridge';

/** One frame per pool, created lazily. Vault teardown invalidates in-flight
 * asset acquisition before any old worker can publish into the next vault. */
export function createPdfWorkerBroker(onFailure: (error: PdfEngineError) => void): PdfWorkerBroker {
    const controller = new AbortController();
    const generations = new Map<string, number>();
    let frame: PdfEngineFrame | undefined;
    let pending: Promise<PdfEngineFrame> | undefined;
    let disposed = false;
    const acquire = (): Promise<PdfEngineFrame> => {
        if (disposed) return Promise.reject(new PdfEngineError('EngineBroken', 'PDF broker is closed'));
        if (frame) return Promise.resolve(frame);
        pending ??= loadTrustedPdfAssets(controller.signal).then(assets => {
            if (disposed) throw new PdfEngineError('EngineBroken', 'PDF broker is closed');
            return frame = new PdfEngineFrame(assets, workerSource, error => { frame = undefined; onFailure(error); });
        }).finally(() => { pending = undefined; });
        return pending;
    };
    return {
        async spawn(role, workerId) {
            const key = `${role}:${workerId}`, generation = (generations.get(key) ?? 0) + 1;
            generations.set(key, generation);
            const broker = await acquire();
            if (disposed) throw new PdfEngineError('EngineBroken', 'PDF broker is closed');
            // Render and writer identifiers occupy distinct broker namespaces.
            const id = workerId * 2 + (role === 'writer' ? 1 : 0);
            return broker.spawn(role, id, generation, controller.signal);
        },
        dispose() { if (disposed) return; disposed = true; controller.abort(); frame?.dispose(); frame = undefined; generations.clear(); },
    };
}
