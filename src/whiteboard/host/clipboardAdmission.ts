import type { ExternalClipboardAdmission } from '../clipboard/paste';
import { MediaStore } from '../media/store';
import type { MediaEntry, MediaId } from '../model/media';
import type { BoardDoc } from '../model/doc';
import type { Bounds } from '../format/schema';
import type { Node } from '../model/nodes';
import { createBoardRenderServices } from '../render/services';
import { SECURITY_LIMITS } from '../security/limits';
import { importDeadline } from '../workers/client';
import { validBoardIdentity, type BoardJobIdentity } from '../workers/protocol';
import type { RenderToken } from '../../platform/render/types';
import type { BoardClipboardAcquisition } from './clipboardAcquisition';
import { createBoardEncoderBounds } from './encoderBounds';
import { acquireNativeBoard } from './nativeAcquisition';
import { inspectPdfVisualModel } from './pdfVisualPreflight';

// Provenance: native clipboard admission (C5 acquisition, render-service canonical
// geometry and encoder bounds) composed from existing host seams; no third-party source.

export interface NativeRecordsAdmissionOptions {
    /** The exact owner token the live board runtime was created with; render identity must not be guessed. */
    readonly token: RenderToken;
    readonly identity: BoardJobIdentity;
    isCurrent(identity: BoardJobIdentity): boolean;
    /** Reads one media entry's bytes from the copying host; null means the item is missing. */
    readBlob(entry: MediaEntry, signal: AbortSignal): Promise<Blob | null>;
    readonly signal: AbortSignal;
    cooperate?(): Promise<void>;
}

/** Clipboard native files are always written with a whiteboard header (makeClipboardNativeRecords). */
const CLIPBOARD_KIND = 'whiteboard' as const;

/** Union of canonical encoder bounds over every node. A node whose bounds are invalid is refused,
 * never replaced by an AABB guess; a source with no nodes has an empty extent. */
async function sourceExtent(doc: BoardDoc, bounds: (node: Node) => Bounds, check: () => Promise<void>)
    : Promise<Readonly<{ x: number; y: number; w: number; h: number }>> {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, visited = 0;
    for (const node of doc.nodes.values()) {
        const [x, y, w, h] = bounds(node);
        if (![x, y, w, h].every(Number.isFinite) || w < 0 || h < 0) throw new RangeError('Clipboard source has invalid canonical bounds');
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h);
        if ((++visited & 255) === 0) await check();
    }
    if (!Number.isFinite(minX)) return Object.freeze({ x: 0, y: 0, w: 0, h: 0 });
    return Object.freeze({ x: minX, y: minY, w: maxX - minX, h: maxY - minY });
}

/**
 * Admits external native clipboard records into an owned acquisition. Any loss is refused: a
 * repaired, incomplete, read-only or opaque-visual source is not a clipboard admission. Bounds come
 * from the same canonical geometry the encoder uses. The returned acquisition owns the load and
 * samples until its dispose runs; on refusal everything acquired here is released.
 */
export async function admitNativeClipboardRecords(bytes: Blob, options: NativeRecordsAdmissionOptions): Promise<ExternalClipboardAdmission> {
    options.signal.throwIfAborted();
    if (!(bytes instanceof Blob) || (typeof File !== 'undefined' && bytes instanceof File)
        || bytes.size > SECURITY_LIMITS.clipboardExpandedBytes || !validBoardIdentity(options.identity)) {
        throw new TypeError('Native clipboard admission requires a copied Blob and a valid job identity');
    }
    const identity = Object.freeze({ ...options.identity });
    const check = async () => {
        options.signal.throwIfAborted();
        if (!options.isCurrent(identity)) throw new DOMException('Clipboard admission became stale', 'AbortError');
    };
    const cooperate = async () => {
        await check();
        await (options.cooperate?.() ?? new Promise<void>(resolve => setTimeout(resolve, 0)));
        await check();
    };
    await check();
    const token = options.token;
    const admitted = await acquireNativeBoard({ bytes, kind: CLIPBOARD_KIND,
        identity: { session: identity.session, epoch: identity.epoch, generation: identity.revision },
        signal: options.signal, deadlineMs: importDeadline(bytes.size), cooperate });
    let transferred = false;
    let media: MediaStore | undefined;
    let services: ReturnType<typeof createBoardRenderServices> | undefined;
    const leases: { release(): void }[] = [];
    try {
        await check();
        if (admitted.status !== 'editable' || !admitted.report.complete || admitted.report.format !== 'native'
            || (admitted.report.repaired?.repairs.length ?? 0) > 0) {
            throw new Error('Clipboard native records could not be admitted without loss');
        }
        const load = admitted.load, samples = admitted.samples, doc = load.doc;
        const visual = await inspectPdfVisualModel(load, { signal: options.signal, cooperate });
        await check();
        if (visual.status !== 'known') throw new Error('Clipboard contains opaque or uninterpreted visual records');
        const sheet = doc.sheets.keys().next().value;
        if (sheet === undefined) throw new Error('Clipboard native records contain no sheet');

        // Referenced media are loaded before geometry, so image-dependent bounds are measured, not guessed.
        // A missing item keeps its placeholder; insertion reports it.
        media = new MediaStore();
        const store = media;
        const references = new Set<MediaId>();
        for (const [id, refs] of doc.mediaRefs) if (refs.size) references.add(id);
        for (const [id, count] of doc.preservedMediaRefs) if (count > 0) references.add(id);
        let loaded = 0;
        for (const id of references) {
            const entry = doc.media.get(id);
            if (!entry) continue;
            const blob = await options.readBlob(entry, options.signal);
            await check();
            if (!blob) continue;
            leases.push(store.retain(id, 'journal'));
            store.put(id, blob);
            if ((++loaded & 15) === 0) await cooperate();
        }

        services = createBoardRenderServices({ doc, samples, media: store, token });
        const render = services;
        const encoderBounds = await createBoardEncoderBounds({ doc, sources: load.sources, local: render.encoderLocal,
            realize: render.realize, cooperate, geometryEpoch: () => render.text.fonts.epoch });
        await encoderBounds.prepare(doc.nodes.keys(), options.signal);
        await check();
        const bounds = await sourceExtent(doc, node => encoderBounds.bounds(node), check);
        await check();

        const acquisition: BoardClipboardAcquisition = {
            // Synthetic origin: the external text names no source board, and insertion never reuses its samples.
            payload: Object.freeze({ v: 1, nonce: 'external0000000000', from: Object.freeze({ board: 'external', sheet, kind: doc.kind }),
                bounds, records: Object.freeze([]), media: Object.freeze({}) }),
            load, samples, inline: Object.freeze([]), report: admitted.report, originalSourceKind: doc.kind,
            dispose: admitted.dispose,
        };
        transferred = true;
        return { acquisition, bounds };
    } finally {
        // Render services and media are needed only for the measured bounds, never by the acquisition.
        for (const lease of leases) lease.release();
        try { services?.dispose(); } finally {
            media?.clear();
            if (!transferred) admitted.dispose();
        }
    }
}
