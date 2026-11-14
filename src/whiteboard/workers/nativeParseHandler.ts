import type { WorkerContext } from '../../platform/workers';
import { readNative } from '../format/read';
import { projectLoad } from '../model/loadProjection';
import type { LoadSampleWire } from '../model/loadTypes';
import { validateNativeRequest } from './nativeRequest';
import type { ParseNativeReply } from './nativeParseTypes';

async function* blobBytes(blob: Blob): AsyncIterable<Uint8Array> {
    const reader = blob.stream().getReader();
    try {
        for (;;) { const next = await reader.read(); if (next.done) return; yield next.value; }
    } finally { reader.releaseLock(); }
}

/** Projection is not admission: C5 revalidates and repairs the ordered records. */
export async function parseNative(payload: unknown, context: WorkerContext): Promise<ParseNativeReply> {
    const request = validateNativeRequest(payload);
    const samples: LoadSampleWire[] = [];
    const result = await readNative(blobBytes(request.bytes), {
        byteLength: request.bytes.size, expectedKind: request.expectedKind, pdfPages: request.pdfPages,
        signal: context.signal, cooperate: () => context.slice(),
        admitEncoded(pts, header) {
            const workerRef = samples.length + 1;
            samples.push({ workerRef, pts, header });
            return workerRef;
        },
    });
    context.signal.throwIfAborted();
    if (!result.draft) return { ...result, draft: null };
    const draft = result.draft;
    const projection = await projectLoad(draft, ref => {
        const wire = samples[ref - 1];
        if (!wire || wire.workerRef !== ref) throw new TypeError('Missing encoded sample in native draft');
        return wire;
    }, () => context.slice(), context.signal);
    const coldBounds: (readonly [string, import('../format/schema').Bounds])[] = [];
    for (const [id, bounds] of draft.coldBounds) {
        if ((coldBounds.length & 255) === 0) { context.signal.throwIfAborted(); await context.slice(); }
        coldBounds.push([id, bounds]);
    }
    context.signal.throwIfAborted();
    return { ...result, draft: { ...projection, coldBounds } };
}
