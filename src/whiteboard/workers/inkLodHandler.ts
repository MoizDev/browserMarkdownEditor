import type { WorkerContext } from '../../platform/workers';
import { inkCoverage } from './inkCoverageHandler';
import { reportGeometryMemory } from './geometryHandler';
import { certifyLod } from './inkLodCertificate';
import type { InkCoverageReply, InkCoverageRequest } from './geometryProtocol';

export async function inkLod(payload: unknown, context: WorkerContext): Promise<unknown> {
    if (!payload || typeof payload !== 'object') throw new TypeError('Invalid ink LOD request');
    const { request, chunkCount } = payload as { request: InkCoverageRequest; chunkCount: number };
    if (!request || !Number.isSafeInteger(chunkCount) || chunkCount < 1) throw new TypeError('Invalid ink LOD descriptor');
    const owner = {};
    let buffers: Transferable[] = [];
    const scoped: WorkerContext = {
        get cancelled() { return context.cancelled; }, signal: context.signal,
        slice: () => context.slice(), heartbeat: () => context.heartbeat(),
        emit: (event, data, transfer) => context.emit(event, data, transfer),
        transfer: (...items) => { buffers.push(...items); },
    };
    try {
        const fine = await inkCoverage(request, scoped) as InkCoverageReply;
        const fineBuffers = buffers; buffers = [];
        let bytes = 0;
        for (const item of fineBuffers) if (item instanceof ArrayBuffer) bytes += item.byteLength;
        reportGeometryMemory(context, owner, bytes);
        context.signal.throwIfAborted();
        let chosen = fine, chosenBuffers = fineBuffers;
        let certificate: Awaited<ReturnType<typeof certifyLod>> = null;
        // The next chunk's dash prefix depends on the chosen level. Until a whole-stroke
        // certificate carries that phase, patterned strokes retain their fine result.
        if (!request.options.dash && !request.options.pointMotifs) {
            try {
                const coarse = await inkCoverage({ ...request, options: { ...request.options,
                    deviceScale: request.options.deviceScale / Math.SQRT2 } }, scoped) as InkCoverageReply;
                context.signal.throwIfAborted();
                let coarseBytes = 0;
                for (const item of buffers) if (item instanceof ArrayBuffer) coarseBytes += item.byteLength;
                const sampleBuffers = new Set([request.samples.xy.buffer, request.samples.kinds.buffer,
                    ...(request.samples.pressure ? [request.samples.pressure.buffer] : [])]);
                let inputBytes = 0;
                for (const buffer of sampleBuffers) inputBytes += buffer.byteLength;
                reportGeometryMemory(context, owner, bytes + coarseBytes + inputBytes);
                certificate = await certifyLod(fine, coarse, request.options.deviceScale, chunkCount, context);
                if (certificate) { chosen = coarse; chosenBuffers = buffers; }
            } catch (error) {
                context.signal.throwIfAborted();
                if (error instanceof DOMException && error.name === 'AbortError') throw error;
            }
        }
        context.transfer(...chosenBuffers);
        return { coverage: chosen, level: certificate ? 'coarse' : 'fine', certificate };
    } finally { reportGeometryMemory(context, owner, null); }
}
