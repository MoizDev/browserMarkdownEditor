import { serve } from '../../platform/workers/serve';
import { frameRecord, positiveInteger } from '../contained/protocol';
import type { PdfWorkerBinding } from '../contained/protocol';
import { startPdfWorker } from './runtime';

let bound = false;
let stopRuntime: (() => void) | undefined;
const stopBinding = serve({ protocol: 1, buildId: 'pdf-worker-binding-v1', handlers: {
    'worker.bind': value => {
        if (bound || !frameRecord(value) || typeof value.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(value.nonce) ||
            !positiveInteger(value.id) || !positiveInteger(value.generation) || !(value.port instanceof MessagePort) ||
            typeof value.glueUrl !== 'string' || !value.glueUrl.startsWith('blob:null/') || !frameRecord(value.engine)) {
            throw new Error('Invalid PDF worker binding');
        }
        bound = true;
        stopRuntime = startPdfWorker(value as unknown as PdfWorkerBinding);
        setTimeout(stopBinding, 0);
        return { bound: true };
    },
} });
self.addEventListener('close', () => stopRuntime?.(), { once: true });
