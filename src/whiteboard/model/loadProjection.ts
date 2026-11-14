import type { PointInspectionHeader } from '../format/points';
import type { BoardDocInput } from './doc';
import type { JsonObject, JsonValue } from './json';
import type { LoadProjection, LoadRepairDraft, LoadSampleWire, RehydratedLoad } from './loadTypes';
import type { MediaId } from './media';
import type { NodeRecord } from './nodes';
import type { SampleLease, SampleRef } from './samples';

// ExtBag and preserved.fields are the only Maps in a parsed model. Tagging a
// Map prevents JSON object keys such as __proto__ from becoming properties;
// its entries are arrays and raw JSON lexemes stay byte-identical strings.
const MAP = '$boardMap';
function encode(value: unknown): JsonValue {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.map(encode);
    if (value instanceof Map) {
        const entries: JsonValue[] = [];
        for (const [key, item] of value) {
            if (typeof key !== 'string') throw new TypeError('Model map key must be a string');
            entries.push([key, encode(item)]);
        }
        return { [MAP]: entries };
    }
    if (typeof value !== 'object' || value === undefined) throw new TypeError('Model value is not inert JSON');
    const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const [key, item] of Object.entries(value)) {
        if (item === undefined) continue;
        if (key === MAP) throw new TypeError('Reserved projection key in model object');
        result[key] = encode(item);
    }
    return result;
}
function object(value: unknown): JsonObject {
    const result = encode(value);
    if (!result || Array.isArray(result) || typeof result !== 'object') throw new TypeError('Expected model record');
    return result as JsonObject;
}
function decode(value: JsonValue): unknown {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(decode);
    const source = value as JsonObject;
    if (Object.hasOwn(source, MAP)) {
        if (Object.keys(source).length !== 1 || !Array.isArray(source[MAP])) throw new TypeError('Invalid projection map');
        const result = new Map<string, unknown>();
        for (const entry of source[MAP] as readonly JsonValue[]) {
            if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || result.has(entry[0])) throw new TypeError('Invalid projection map entry');
            result.set(entry[0], decode(entry[1]));
        }
        return result;
    }
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, item] of Object.entries(source)) result[key] = decode(item);
    return result;
}
function cancelled(signal?: AbortSignal): void {
    if (signal?.aborted) throw new DOMException('Board admission cancelled', 'AbortError');
}

/** Encode repaired, ordered records only; this object is inert, not admission authority. */
export async function projectLoad(draft: LoadRepairDraft, sampleWire: (ref: SampleRef) => LoadSampleWire,
    cooperate?: () => Promise<void>, signal?: AbortSignal): Promise<LoadProjection> {
    const input = draft.input, nodes: JsonObject[] = [], wires: LoadSampleWire[] = [], seen = new Set<SampleRef>();
    let index = 0;
    for (const node of input.nodes ?? []) {
        if ((index++ & 1023) === 0) { cancelled(signal); await cooperate?.(); }
        nodes.push(object(node));
        if (node.kind === 'stroke' && !seen.has(node.samples)) {
            const wire = sampleWire(node.samples);
            if (wire.workerRef !== node.samples) throw new TypeError('Sample projection identity mismatch');
            seen.add(node.samples); wires.push(wire);
        }
    }
    cancelled(signal);
    return { version: 1, kind: input.kind, sheets: Array.from(input.sheets, object), nodes,
        media: Array.from(input.media ?? [], object), ui: object(input.ui), view: object(input.view),
        host: object(input.host), preserved: object(input.preserved),
        preservedMediaRefs: [...input.preservedMediaRefs], samples: wires, sources: draft.sources, unmapped: draft.unmapped,
        ...(draft.savedView === undefined ? {} : { savedView: draft.savedView }) };
}

/** Re-admit encoded samples in the receiving store; caller retains creator leases
 * until live-node ownership is installed. This conversion does not validate a
 * graph or make untrusted worker input authoritative. */
export async function rehydrateLoad(projection: LoadProjection,
    admit: (pts: string, header: PointInspectionHeader) => SampleLease,
    cooperate?: () => Promise<void>, signal?: AbortSignal): Promise<RehydratedLoad> {
    if (projection.version !== 1) throw new TypeError('Unsupported load projection version');
    const leases: SampleLease[] = [], refs = new Map<SampleRef, SampleRef>();
    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        for (const lease of leases) lease.release();
        leases.length = 0;
    };
    try {
        for (let i = 0; i < projection.samples.length; i++) {
            if ((i & 255) === 0) { cancelled(signal); await cooperate?.(); }
            const wire = projection.samples[i];
            if (refs.has(wire.workerRef)) throw new TypeError('Duplicate projected sample handle');
            const lease = admit(wire.pts, wire.header);
            try { leases.push(lease); refs.set(wire.workerRef, lease.ref); }
            catch (error) { lease.release(); throw error; }
        }
        const nodes: NodeRecord[] = [];
        for (let i = 0; i < projection.nodes.length; i++) {
            if ((i & 1023) === 0) { cancelled(signal); await cooperate?.(); }
            const node = decode(projection.nodes[i]) as NodeRecord;
            if (node.kind === 'stroke') {
                const ref = refs.get(node.samples);
                if (ref === undefined) throw new TypeError('Projected stroke references missing samples');
                nodes.push({ ...node, samples: ref });
            } else nodes.push(node);
        }
        cancelled(signal);
        const input = {
            kind: projection.kind, sheets: projection.sheets.map(value => decode(value)), nodes,
            media: projection.media.map(value => decode(value)), ui: decode(projection.ui), view: decode(projection.view),
            host: decode(projection.host), preserved: decode(projection.preserved),
            preservedMediaRefs: new Map(projection.preservedMediaRefs as readonly (readonly [MediaId, number])[]),
        } as BoardDocInput;
        return { input, leases, release };
    } catch (error) { release(); throw error; }
}
