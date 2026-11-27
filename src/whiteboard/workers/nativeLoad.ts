import type { WorkerContext } from '../../platform/workers';
import { readNative } from '../format/read';
import type { NativeReadResult, ReadSourceRecord, UnmappedRecord } from '../format/readTypes';
import type { SavedView } from '../format/encode';
import type { Bounds } from '../format/schema';
import { SampleStore } from '../ink/samples';
import type { LoadRepairResult, LoadSampleWire } from '../model/loadTypes';
import { repairLoad } from '../model/loadRepair';
import type { SampleLease, SampleRef } from '../model/samples';
import { validateNativeRequest } from './nativeRequest';
import { reportBoardMemory } from './boardMemory';

export interface NativeLoadReply extends Omit<NativeReadResult, 'draft'> {
    readonly repaired: LoadRepairResult | null;
    readonly sources: readonly ReadSourceRecord[];
    readonly unmapped: readonly UnmappedRecord[];
    readonly coldBounds: readonly (readonly [string, Bounds])[];
    readonly savedView?: SavedView;
}

export async function nativeLoad(payload: unknown, context: WorkerContext): Promise<NativeLoadReply> {
    const request = validateNativeRequest(payload), samples = new SampleStore(), owner = {};
    const leases: SampleLease[] = [], wires = new Map<SampleRef, LoadSampleWire>();
    let wireBytes = 0;
    const cooperate = () => { reportBoardMemory(context, owner, samples.byteLength + wireBytes); return context.slice(); };
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
            signal: context.signal, cooperate,
            admitEncoded(pts, header) {
                const lease = samples.admitEncoded(pts, header);
                try { leases.push(lease); wires.set(lease.ref, { workerRef: lease.ref, pts, header }); wireBytes += 2 * pts.length; }
                catch (error) { lease.release(); throw error; }
                return lease.ref;
            },
        });
        const { draft, ...report } = parsed;
        const coldBounds: (readonly [string, Bounds])[] = [];
        if (draft) for (const [id, bounds] of draft.coldBounds) {
            if ((coldBounds.length & 255) === 0) { context.signal.throwIfAborted(); await context.slice(); }
            coldBounds.push([id, bounds]);
        }
        const diagnostics = { sources: draft?.sources ?? [], unmapped: draft?.unmapped ?? [], coldBounds,
            ...(draft?.savedView === undefined ? {} : { savedView: draft.savedView }) };
        if (!draft || parsed.readOnly || !parsed.complete) return { ...report, ...diagnostics, readOnly: true, repaired: null };
        let serial = 0, scanned = 0;
        const prefixes = new Set<string>();
        const reserve = (id: string) => {
            const match = /^repair-([0-9]+)-/.exec(id);
            if (match) prefixes.add(match[1]);
        };
        for (const sheet of draft.input.sheets) {
            if ((scanned++ & 255) === 0) { context.signal.throwIfAborted(); await context.slice(); }
            reserve(sheet.id);
        }
        for (const node of draft.input.nodes ?? []) {
            if ((scanned++ & 255) === 0) { context.signal.throwIfAborted(); await context.slice(); }
            reserve(node.id);
        }
        let namespace = 0;
        while (prefixes.has(String(namespace))) {
            if ((namespace++ & 255) === 0) { context.signal.throwIfAborted(); await context.slice(); }
        }
        const prefix = `repair-${namespace}-`;
        let repaired: LoadRepairResult;
        try {
            repaired = await repairLoad({ input: draft.input, sources: draft.sources, unmapped: draft.unmapped, savedView: draft.savedView }, {
                samples, newId: () => `${prefix}${++serial}`,
                sampleWire(ref) {
                    const wire = wires.get(ref);
                    if (!wire) throw new Error('Missing encoded sample for repaired stroke');
                    return wire;
                },
                rootPlacement() {
                    throw new Error('Exact orphan bounds are unavailable for paged repair');
                },
                cooperate, signal: context.signal,
            });
        } catch (error) {
            context.signal.throwIfAborted();
            return { ...report, ...diagnostics, readOnly: true, repaired: null, issueCount: report.issueCount + 1,
                issues: [...parsed.issues, { code: 'repair', reason: error instanceof Error ? error.message : 'Board repair failed', readOnly: true }] };
        }
        return { ...report, ...diagnostics, readOnly: repaired.status !== 'editable', repaired };
    } finally {
        for (const lease of leases) lease.release();
        reportBoardMemory(context, owner, null);
    }
}
