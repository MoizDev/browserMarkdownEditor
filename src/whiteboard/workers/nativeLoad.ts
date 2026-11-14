import type { WorkerContext } from '../../platform/workers';
import { pageAt } from '../../platform/render/pageStack';
import { readNative } from '../format/read';
import type { ReadIssue } from '../format/readTypes';
import { SampleStore } from '../ink/samples';
import type { LoadRepairResult, LoadSampleWire } from '../model/loadTypes';
import { boardPageStack, pageOrigin } from '../model/pages';
import { repairLoad } from '../model/loadRepair';
import type { SampleLease, SampleRef } from '../model/samples';
import type { ParseNativeRequest } from './nativeParseTypes';

export interface NativeLoadReply {
    readonly format: 'native' | 'empty' | 'other';
    readonly readOnly: boolean;
    readonly repaired: LoadRepairResult | null;
    readonly issues: readonly ReadIssue[];
    readonly complete: boolean;
}

/** Parse and graph repair share the worker-local sample store. Only immutable
 * encoded sample records cross the worker boundary; leases stay in that store. */
export async function nativeLoad(payload: unknown, context: WorkerContext): Promise<NativeLoadReply> {
    if (!payload || typeof payload !== 'object' || !((payload as ParseNativeRequest).bytes instanceof Blob)) throw new TypeError('Native load requires a Blob');
    const request = payload as ParseNativeRequest, samples = new SampleStore();
    const leases: SampleLease[] = [], wires = new Map<SampleRef, LoadSampleWire>();
    try {
        async function* bytes(): AsyncIterable<Uint8Array> {
            const reader = request.bytes.stream().getReader();
            try {
                for (;;) {
                    context.signal.throwIfAborted();
                    const part = await reader.read();
                    if (part.done) break;
                    yield part.value;
                }
            } finally { reader.releaseLock(); }
        }
        const parsed = await readNative(bytes(), {
            byteLength: request.bytes.size, expectedKind: request.expectedKind, pdfPages: request.pdfPages,
            signal: context.signal, cooperate: context.slice,
            admitEncoded(pts, header) {
                const lease = samples.admitEncoded(pts, header);
                try { leases.push(lease); wires.set(lease.ref, { workerRef: lease.ref, pts, header }); }
                catch (error) { lease.release(); throw error; }
                return lease.ref;
            },
        });
        if (!parsed.draft || parsed.readOnly || !parsed.complete) return { format: parsed.format, readOnly: true, repaired: null, issues: parsed.issues, complete: parsed.complete };
        const draft = parsed.draft, stack = boardPageStack(draft.input.host);
        let serial = 0;
        const sourceByOrdinal = new Map(draft.sources.map(source => [source.position.ordinal, source]));
        let repaired: LoadRepairResult;
        try {
            repaired = await repairLoad({ input: draft.input, sources: draft.sources, unmapped: draft.unmapped, savedView: draft.savedView }, {
                samples, newId: () => `repair-${++serial}`,
                sampleWire(ref) {
                    const wire = wires.get(ref);
                    if (!wire) throw new Error('Missing encoded sample for repaired stroke');
                    return wire;
                },
                rootPlacement(node, _sheet, ordinal) {
                    if (!stack?.rects.length) throw new Error('Page geometry is unavailable for orphan repair');
                    const bounds = sourceByOrdinal.get(ordinal)?.nodeBounds;
                    if (!bounds) throw new Error('Exact orphan bounds are unavailable; keeping original bytes');
                    const page = pageAt(stack, bounds[1] + bounds[3] / 2), origin = pageOrigin(stack, page);
                    if (!origin) throw new Error('Page geometry is unavailable for orphan repair');
                    return { page, x: node.x - origin.x, y: node.y - origin.y };
                },
                cooperate: context.slice, signal: context.signal,
            });
        } catch (error) {
            context.signal.throwIfAborted();
            return { format: parsed.format, readOnly: true, repaired: null, complete: parsed.complete,
                issues: [...parsed.issues, { code: 'repair', reason: error instanceof Error ? error.message : 'Board repair failed', readOnly: true }] };
        }
        return { format: parsed.format, readOnly: repaired.status !== 'editable', repaired, issues: parsed.issues, complete: parsed.complete };
    } finally { for (const lease of leases) lease.release(); }
}
