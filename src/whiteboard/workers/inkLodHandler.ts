import type { WorkerContext } from '../../platform/workers';
import { inkCoverage } from './inkCoverageHandler';
import { reportBoardMemory } from './boardMemory';
import { nestedInkLod } from './inkLodNested';
import { nestedInkLodGroups } from './inkLodGroups';
import type { InkCoverageReply, InkCoverageRequest } from './geometryProtocol';

export async function inkLod(payload: unknown, context: WorkerContext): Promise<unknown> {
    if (!payload || typeof payload !== 'object') throw new TypeError('Invalid ink LOD request');
    const { request, chunkCount } = payload as { request: InkCoverageRequest; chunkCount: number };
    if (!request || !Number.isSafeInteger(chunkCount) || chunkCount < 1) throw new TypeError('Invalid ink LOD descriptor');
    const owner = {};
    const buffers: Transferable[] = [];
    const scoped: WorkerContext = {
        get cancelled() { return context.cancelled; }, signal: context.signal,
        slice: () => context.slice(), heartbeat: () => context.heartbeat(),
        emit: (event, data, transfer) => context.emit(event, data, transfer),
        transfer: (...items) => { buffers.push(...items); },
    };
    try {
        const fine = await inkCoverage(request, scoped) as InkCoverageReply;
        let bytes = 0;
        for (const item of buffers) if (item instanceof ArrayBuffer) bytes += item.byteLength;
        const input = new Set([request.samples.xy.buffer, request.samples.kinds.buffer,
            ...(request.samples.pressure ? [request.samples.pressure.buffer] : [])]);
        for (const buffer of input) bytes += buffer.byteLength;
        reportBoardMemory(context, owner, bytes);
        context.signal.throwIfAborted();
        let result: Awaited<ReturnType<typeof nestedInkLod>> = null;
        try {
            const memory = (scratch: number) => reportBoardMemory(context, owner, bytes + scratch);
            result = await nestedInkLod(fine, request, chunkCount, context, memory)
                ?? await nestedInkLodGroups(fine, request, chunkCount, context, memory);
        } catch (error) {
            context.signal.throwIfAborted();
            if (error instanceof DOMException && error.name === 'AbortError') throw error;
        }
        context.signal.throwIfAborted();
        if (!result) {
            context.transfer(...buffers);
            return { coverage: fine, level: 'fine', certificate: null };
        }
        context.transfer(...buffers.filter(buffer => buffer !== fine.segments.buffer), result.coverage.segments.buffer as ArrayBuffer);
        return { coverage: result.coverage, level: 'coarse', certificate: result.certificate };
    } finally { reportBoardMemory(context, owner, null); }
}
