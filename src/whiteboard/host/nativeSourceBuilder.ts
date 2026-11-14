import type { RenderToken } from '../../platform/render/types';
import { encodeDocumentRecords, encodeHeader, type EncoderContext } from '../format/encode';
import type { PointSamples } from '../format/points';
import { LineTable } from '../format/lineTable';
import { NATIVE_VERSION } from '../format/schema';
import type { WriteResult } from '../format/writeTypes';
import { SampleStore } from '../ink/samples';
import { createBoardDoc } from '../model/doc';
import { UI_DEFAULTS, VIEW_DEFAULTS } from '../model/defaults';
import type { SheetId } from '../model/ids';
import type { MediaEntry, MediaId } from '../model/media';
import type { Node, StrokeNode } from '../model/nodes';
import { keyBetween } from '../model/orderKey';
import { MediaStore } from '../media/store';
import { createBoardRenderServices } from '../render/services';
import { SECURITY_LIMITS } from '../security/limits';
import { createBoardEncoderBounds } from './encoderBounds';

// Provenance: native source encoding from converted clipboard nodes, using the same
// canonical encoder bounds, render services and encodeDocumentRecords as the worker
// legacy preparation; no third-party source.

export interface ExternalNativeSource {
    readonly sheet: SheetId;
    readonly nodes: readonly Node[];
    readonly media: readonly MediaEntry[];
    readonly blobs: ReadonlyMap<MediaId, Blob>;
    readonly samples: SampleStore;
}
export interface ExternalNativeEncodeOptions {
    readonly token: RenderToken;
    /** Host's maximum CSS-px/world-unit scale, as the encoder requires. */
    readonly zMax: number;
    readonly signal: AbortSignal;
    cooperate(): Promise<void>;
}

function take<T>(result: WriteResult<T>): T {
    if (!result.ok) throw new Error(`Clipboard native source refused: ${result.error.reason}`);
    return result.value;
}

/** Points of one stroke, pinned from its own sample sequence; runs mark straight/curved segments. */
function strokePoints(samples: SampleStore, node: StrokeNode): PointSamples {
    const sequence = samples.sequence(node.samples), count = sequence.count;
    const xy = new Float64Array(count * 2);
    const pressure = samples.pressureMode(node.samples) === 'real' ? new Float64Array(count) : null;
    const starts: number[] = [], kinds: number[] = [];
    for (let i = 0; i < count; i++) {
        xy[2 * i] = sequence.x(i); xy[2 * i + 1] = sequence.y(i);
        if (pressure) pressure[i] = sequence.pressure(i)!;
        if (i + 1 < count) {
            const kind = sequence.segmentKind(i) === 'straight' ? 1 : 0;
            if (!kinds.length || kinds[kinds.length - 1] !== kind) { starts.push(i); kinds.push(kind); }
        }
    }
    return { xy, pressure, runs: kinds.length ? { starts: Uint32Array.from(starts), kinds: Uint8Array.from(kinds) } : null };
}

/**
 * Encode converted external nodes as one native clipboard file. The document is built from the
 * nodes themselves, every node's bounds come from the render services' canonical geometry, and
 * media blobs enter a store once. A node that cannot be measured or encoded fails the whole source.
 */
export async function encodeExternalNativeSource(source: ExternalNativeSource, options: ExternalNativeEncodeOptions): Promise<Blob> {
    const { signal, cooperate } = options;
    signal.throwIfAborted();
    if (source.nodes.length > SECURITY_LIMITS.clipboardNodes || source.media.length > SECURITY_LIMITS.mediaBatch) {
        throw new RangeError('External clipboard source exceeds its limits');
    }
    const doc = createBoardDoc({ kind: 'whiteboard', sheets: [{ id: source.sheet, name: 'Clipboard', order: keyBetween(null, null), ext: null }],
        nodes: source.nodes, media: source.media, host: { kind: 'whiteboard' }, ui: UI_DEFAULTS, view: VIEW_DEFAULTS,
        preserved: { version: NATIVE_VERSION, fields: new Map(), records: [], end: null }, preservedMediaRefs: new Map() });
    const store = new MediaStore(), leases: { release(): void }[] = [];
    let services: ReturnType<typeof createBoardRenderServices> | undefined;
    try {
        for (const entry of source.media) {
            const blob = source.blobs.get(entry.id);
            if (!blob) continue;
            leases.push(store.retain(entry.id, 'journal'));
            store.put(entry.id, blob);
        }
        services = createBoardRenderServices({ doc, samples: source.samples, media: store, token: options.token });
        const render = services;
        const bounds = await createBoardEncoderBounds({ doc, sources: [], local: render.encoderLocal, realize: render.realize,
            cooperate, geometryEpoch: () => render.text.fonts.epoch });
        await bounds.prepare(doc.nodes.keys(), signal);
        const encoder: EncoderContext = {
            bounds: bounds.bounds, zMax: options.zMax,
            stroke: node => strokePoints(source.samples, node),
            readEncoded: node => source.samples.readEncoded(node.samples),
            savedView: () => undefined, mediaRefs: doc.mediaRefs, preservedMediaRefs: doc.preservedMediaRefs,
        };
        const lines = new LineTable();
        take(lines.setHeader(take(encodeHeader('whiteboard', doc.preserved))));
        for (const record of encodeDocumentRecords(doc, encoder)) {
            take(await lines.setAsync(take(record), 0, { signal, cooperate }));
            signal.throwIfAborted();
        }
        return take(await lines.assembleAsync(lines.integrity(), doc.preserved.end, { signal, cooperate })).blob;
    } finally {
        for (const lease of leases) lease.release();
        try { services?.dispose(); } finally { store.clear(); }
    }
}
