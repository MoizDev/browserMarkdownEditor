import { inspectPointsIncremental, type PointInspectionHeader } from '../format/points';
import { SECURITY_LIMITS } from '../security/limits';
import type { BoardDocInput } from './doc';
import type { JsonValue } from './json';
import { decodeLoadData, encodeLoadData } from './loadCodec';
import { createLoadedBoardDoc } from './loadDocument';
import { recountLoadMedia } from './loadMediaCounts';
import type { LoadProjection, LoadRepairDraft, LoadSampleWire, RehydratedLoad } from './loadTypes';
import type { NodeRecord } from './nodes';
import type { SampleLease, SampleRef, SampleStoreReader } from './samples';
import { validateLoadedNode, validateLoadedRootIncremental } from './validate';

function cancelled(signal?: AbortSignal): void { signal?.throwIfAborted(); }

/** Repaired and unrepaired parse results use this same inert wire dialect. The
 * projection itself carries no admission authority or receiving-store handles. */
export async function projectLoad(draft: LoadRepairDraft, sampleWire: (ref: SampleRef) => LoadSampleWire,
    cooperate?: () => Promise<void>, signal?: AbortSignal): Promise<LoadProjection> {
    const input = draft.input, nodes: NodeRecord[] = [], wires: LoadSampleWire[] = [], seen = new Set<SampleRef>();
    let index = 0;
    for (const node of input.nodes ?? []) {
        if ((index++ & 255) === 0) { cancelled(signal); await cooperate?.(); }
        nodes.push(node);
        if (node.kind === 'stroke' && !seen.has(node.samples)) {
            const wire = sampleWire(node.samples);
            if (wire.workerRef !== node.samples) throw new TypeError('Sample projection identity mismatch');
            seen.add(node.samples); wires.push(wire);
        }
    }
    const collect = async <T>(source: Iterable<T>): Promise<T[]> => {
        const values: T[] = [];
        for (const value of source) {
            if ((values.length & 255) === 0) { cancelled(signal); await cooperate?.(); }
            values.push(value);
        }
        return values;
    };
    const ordered = { version: 1, kind: input.kind, sheets: await collect(input.sheets), nodes,
        media: await collect(input.media ?? []), ui: input.ui, view: input.view, host: input.host, preserved: input.preserved,
        preservedMediaRefs: await collect(input.preservedMediaRefs), samples: wires, sources: draft.sources, unmapped: draft.unmapped,
        ...(draft.removedSources === undefined ? {} : { removedSources: draft.removedSources }),
        ...(draft.savedView === undefined ? {} : { savedView: draft.savedView }) };
    return await encodeLoadData(ordered, cooperate, signal) as unknown as LoadProjection;
}

function checkProjection(value: unknown): asserts value is LoadProjection {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid load projection');
    const p = value as LoadProjection;
    const keys = ['version', 'kind', 'sheets', 'nodes', 'media', 'ui', 'view', 'host', 'preserved', 'preservedMediaRefs', 'samples', 'sources', 'removedSources', 'unmapped', 'savedView'];
    for (const key in p) if (!keys.includes(key)) throw new TypeError('Unknown load projection field');
    if (p.version !== 1 || !['whiteboard', 'notebook', 'pdf-ink'].includes(p.kind)) throw new TypeError('Unsupported load projection version or kind');
    for (const key of ['sheets', 'nodes', 'media', 'preservedMediaRefs', 'samples', 'sources', 'unmapped'] as const) {
        if (!Array.isArray(p[key]) || p[key].length > SECURITY_LIMITS.records) throw new TypeError(`Invalid load ${key}`);
    }
    if (p.sheets.length < 1 || p.sheets.length > SECURITY_LIMITS.sheets) throw new RangeError('Invalid sheet count');
}

/** Re-admission owns all newly allocated leases until the host has installed
 * live ownership. Every worker field is copied through the inert decoder, then
 * the complete receiving model is validated, not trusted because it has a tag. */
export async function rehydrateLoad(projection: LoadProjection,
    admit: (pts: string, header: PointInspectionHeader) => SampleLease, samples: SampleStoreReader,
    cooperate?: () => Promise<void>, signal?: AbortSignal): Promise<RehydratedLoad> {
    const decoded = await decodeLoadData(projection as unknown as JsonValue, cooperate, signal);
    checkProjection(decoded);
    const p = decoded;
    const leases: SampleLease[] = [], refs = new Map<SampleRef, SampleRef>();
    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        for (const lease of leases) lease.release();
        leases.length = 0;
    };
    try {
        for (let i = 0; i < p.samples.length; i++) {
            if ((i & 255) === 0) { cancelled(signal); await cooperate?.(); }
            const wire = p.samples[i];
            if (!wire || typeof wire !== 'object' || Object.keys(wire).some(key => !['workerRef', 'pts', 'header'].includes(key))
                || !Number.isSafeInteger(wire.workerRef) || wire.workerRef < 0 || typeof wire.pts !== 'string'
                || wire.pts.length > SECURITY_LIMITS.encodedPoints || refs.has(wire.workerRef)) throw new TypeError('Invalid projected sample');
            // A worker header is a hint, not proof that its encoded bytes agree.
            const inspected = await inspectPointsIncremental(wire.pts, async () => { cancelled(signal); await cooperate?.(); cancelled(signal); });
            if (!inspected.ok) throw new TypeError(inspected.error.reason);
            cancelled(signal);
            const lease = admit(wire.pts, inspected.value.header);
            try { leases.push(lease); refs.set(wire.workerRef, lease.ref); }
            catch (error) { lease.release(); throw error; }
        }
        const nodes: NodeRecord[] = [], ids = new Set<string>();
        for (let i = 0; i < p.nodes.length; i++) {
            if ((i & 255) === 0) { cancelled(signal); await cooperate?.(); }
            const node = p.nodes[i] as unknown as NodeRecord;
            if (!node || typeof node !== 'object' || typeof node.id !== 'string' || ids.has(node.id)) throw new TypeError('Invalid or duplicate projected node identity');
            ids.add(node.id);
            if (node.kind === 'stroke') {
                const ref = refs.get(node.samples);
                if (ref === undefined) throw new TypeError('Projected stroke references missing samples');
                nodes.push({ ...node, samples: ref });
            } else nodes.push(node);
        }
        const sheetIds = new Set<string>(), mediaIds = new Set<string>();
        for (const sheet of p.sheets) {
            if (!sheet || typeof sheet !== 'object' || typeof sheet.id !== 'string' || ids.has(sheet.id) || sheetIds.has(sheet.id)
                || Object.keys(sheet).some(key => !['id', 'name', 'order', 'ext'].includes(key))) throw new TypeError('Invalid projected sheet');
            sheetIds.add(sheet.id);
        }
        for (let i = 0; i < p.media.length; i++) {
            if ((i & 255) === 0) { cancelled(signal); await cooperate?.(); }
            const entry = p.media[i];
            if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || mediaIds.has(entry.id)) throw new TypeError('Invalid or duplicate projected media');
            mediaIds.add(entry.id);
        }
        // The decoder reconstructs tagged ExtBag Maps; the top-level reference
        // count remains a pair array by contract and is validated before Map creation.
        const counts = new Map();
        let countOrdinal = 0;
        for (const pair of p.preservedMediaRefs) {
            if ((countOrdinal++ & 255) === 0) { cancelled(signal); await cooperate?.(); }
            if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || counts.has(pair[0])
                || !Number.isSafeInteger(pair[1]) || pair[1] < 1) throw new TypeError('Invalid preserved media reference count');
            counts.set(pair[0], pair[1]);
        }
        const input = { kind: p.kind, sheets: p.sheets, nodes, media: p.media, ui: p.ui, view: p.view,
            host: p.host, preserved: p.preserved, preservedMediaRefs: counts } as unknown as BoardDocInput;
        const recounted = await recountLoadMedia(input, cooperate, signal);
        if (recounted.size !== counts.size) throw new TypeError('Projected media counts do not match retained data');
        for (const [id, count] of recounted) if (counts.get(id) !== count) throw new TypeError('Projected media counts do not match retained data');
        const doc = await createLoadedBoardDoc(input, cooperate, signal);
        const root = await validateLoadedRootIncremental(doc, cooperate, signal);
        if (!root.ok) throw new TypeError(root.reason);
        let ordinal = 0;
        for (const node of nodes) {
            if ((ordinal & 255) === 0) { cancelled(signal); await cooperate?.(); }
            const check = validateLoadedNode({ doc, samples }, node, ordinal++);
            if (!check.ok) throw new TypeError(`Node ${node.id}: ${check.reason}`);
        }
        cancelled(signal);
        return { input, doc, sources: p.sources, removedSources: p.removedSources ?? [], unmapped: p.unmapped,
            ...(p.savedView ? { savedView: p.savedView } : {}), leases, release };
    } catch (error) { release(); throw error; }
}
