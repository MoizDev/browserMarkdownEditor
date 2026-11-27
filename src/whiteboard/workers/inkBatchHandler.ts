import type { WorkerContext } from '../../platform/workers';
import type { InkCoverage } from '../ink/outline';
import { packedInkCoverageBytes, writePackedInkCoverage } from '../ink/packedCoverage';
import { reportBoardMemory } from './boardMemory';
import { computeInkCoverage } from './inkCoverageHandler';
import { computeInkLod } from './inkLodHandler';
import { INK_BATCH_MAX_ITEMS, inkBatchSampleBytes, type InkBatchItem, type InkBatchReply, type InkBatchRequest, type InkBatchResult, type InkCoverageRequest } from './geometryProtocol';


function itemRequest(input: ArrayBuffer, item: InkBatchItem): InkCoverageRequest {
    if (!item || typeof item !== 'object' || !Number.isSafeInteger(item.at) || item.at < 0 || item.at % 8
        || !Number.isSafeInteger(item.count) || item.count < 1 || typeof item.pressure !== 'boolean'
        || item.at + inkBatchSampleBytes(item.count, item.pressure) > input.byteLength) throw new TypeError('Invalid ink batch item');
    const xy = new Float64Array(input, item.at, 2 * item.count);
    const pressure = item.pressure ? new Float64Array(input, item.at + 16 * item.count, item.count) : null;
    const kinds = new Uint8Array(input, item.at + (item.pressure ? 24 : 16) * item.count, item.count);
    return { samples: { xy, pressure, kinds, indexOffset: item.indexOffset, totalCount: item.totalCount },
        parameters: item.parameters, style: item.style, range: item.range, options: item.options };
}

export async function inkBatch(payload: unknown, context: WorkerContext): Promise<InkBatchReply> {
    if (!payload || typeof payload !== 'object') throw new TypeError('Invalid ink batch');
    const { input, items } = payload as Partial<InkBatchRequest>;
    if (!(input instanceof ArrayBuffer) || !Array.isArray(items) || !items.length || items.length > INK_BATCH_MAX_ITEMS) throw new TypeError('Invalid ink batch');
    const owner = {}, built: ({ coverage: InkCoverage; level: 'fine' | 'coarse' } | { error: string; name: string })[] = [];
    let held = input.byteLength;
    const memory = (bytes: number) => reportBoardMemory(context, owner, held + bytes);
    try {
        for (const item of items) {
            context.signal.throwIfAborted();
            try {
                const request = itemRequest(input, item);
                const result = item.lodChunks !== undefined
                    ? await computeInkLod(request, item.lodChunks, context, memory)
                    : { coverage: await computeInkCoverage(request, context, memory), level: 'fine' as const };
                built.push(result);
                held += packedInkCoverageBytes(result.coverage);
            } catch (error) {
                context.signal.throwIfAborted();
                if (error instanceof DOMException && error.name === 'AbortError') throw error;
                built.push({ error: error instanceof Error ? error.message : String(error), name: error instanceof Error ? error.name : 'Error' });
            }
        }
        let total = 0;
        for (const entry of built) if ('coverage' in entry) total += packedInkCoverageBytes(entry.coverage);
        const output = new ArrayBuffer(total), results: InkBatchResult[] = [];
        let at = 0;
        for (const entry of built) {
            if (!('coverage' in entry)) { results.push(entry); continue; }
            const bytes = writePackedInkCoverage(entry.coverage, output, at);
            results.push({ at, bytes, level: entry.level }); at += bytes;
        }
        context.transfer(output);
        return { output, items: results };
    } finally { reportBoardMemory(context, owner, null); }
}
