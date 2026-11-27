import type { WorkerContext } from '../../platform/workers';
import type { InkCoverage } from '../ink/outline';
import { computeInkCoverage } from './inkCoverageHandler';
import { nestedInkLod } from './inkLodNested';
import { nestedInkLodGroups, type DerivedLod } from './inkLodGroups';
import type { InkCoverageRequest } from './geometryProtocol';

export async function computeInkLod(request: InkCoverageRequest, chunkCount: number, context: WorkerContext,
    memory: (bytes: number) => void): Promise<{ readonly coverage: InkCoverage; readonly level: 'fine' | 'coarse' }> {
    if (!request || !Number.isSafeInteger(chunkCount) || chunkCount < 1) throw new TypeError('Invalid ink LOD descriptor');
    const fine = await computeInkCoverage(request, context, memory);
    context.signal.throwIfAborted();
    let result: DerivedLod | null = null;
    try {
        const scratch = (bytes: number) => memory(fine.segments.buffer.byteLength + bytes);
        const uniform = await nestedInkLod(fine, request, chunkCount, context, scratch);
        result = uniform ? { segments: uniform.coverage.segments, centreErrorWorld: uniform.coverage.centreErrorWorld,
            certificate: uniform.certificate }
            : await nestedInkLodGroups(fine, request.options.deviceScale, chunkCount, context, scratch);
    } catch (error) {
        context.signal.throwIfAborted();
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
    }
    context.signal.throwIfAborted();
    if (!result) return { coverage: fine, level: 'fine' };
    return { coverage: { ...fine, segments: result.segments, centreErrorWorld: result.centreErrorWorld }, level: 'coarse' };
}
