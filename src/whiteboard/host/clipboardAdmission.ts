import type { ExternalClipboardAdmission } from '../clipboard/paste';
import type { RenderToken } from '../../platform/render/types';
import { SampleStore } from '../ink/samples';
import { MediaStore } from '../media/store';
import type { BoardDoc } from '../model/doc';
import type { Bounds } from '../format/schema';
import type { MediaEntry, MediaId } from '../model/media';
import type { Node } from '../model/nodes';
import type { RehydratedLoad } from '../model/loadTypes';
import { createBoardRenderServices } from '../render/services';
import { SECURITY_LIMITS } from '../security/limits';
import { importDeadline } from '../workers/client';
import type { NativeLoadReply } from '../workers/nativeLoad';
import { validBoardIdentity, type BoardJobIdentity } from '../workers/protocol';
import type { BoardClipboardAcquisition } from './clipboardAcquisition';
import { createBoardEncoderBounds } from './encoderBounds';
import { acquireNativeBoard } from './nativeAcquisition';
import { inspectPdfVisualModel } from './pdfVisualPreflight';
import { yieldToHost } from '../../platform/yieldToHost';

const CLIPBOARD_KIND = 'whiteboard' as const;

export interface ClipboardAdmissionContext {
    readonly token: RenderToken;
    readonly identity: BoardJobIdentity;
    isCurrent(identity: BoardJobIdentity): boolean;
    readBlob(entry: MediaEntry, signal: AbortSignal): Promise<Blob | null>;
    readonly signal: AbortSignal;
    cooperate?(): Promise<void>;
}

export interface AdmittedClipboardLoad {
    readonly load: RehydratedLoad;
    readonly samples: SampleStore;
    readonly report: NativeLoadReply;
    dispose(): void;
}

async function sourceExtent(doc: BoardDoc, bounds: (node: Node) => Bounds, cooperate: () => Promise<void>)
    : Promise<Readonly<{ x: number; y: number; w: number; h: number }>> {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, visited = 0;
    for (const node of doc.nodes.values()) {
        const [x, y, w, h] = bounds(node);
        if (![x, y, w, h].every(Number.isFinite) || w < 0 || h < 0) throw new RangeError('Clipboard source has invalid canonical bounds');
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h);
        if ((++visited & 255) === 0) await cooperate();
    }
    if (!Number.isFinite(minX)) return Object.freeze({ x: 0, y: 0, w: 0, h: 0 });
    return Object.freeze({ x: minX, y: minY, w: maxX - minX, h: maxY - minY });
}

export async function admitLoadedClipboard(owned: AdmittedClipboardLoad, context: ClipboardAdmissionContext): Promise<ExternalClipboardAdmission> {
    const { signal } = context;
    const check = async () => {
        signal.throwIfAborted();
        if (!context.isCurrent(context.identity)) throw new DOMException('Clipboard admission became stale', 'AbortError');
    };
    const cooperate = async () => {
        await check();
        await (context.cooperate?.() ?? yieldToHost());
        await check();
    };
    let transferred = false;
    let media: MediaStore | undefined;
    let services: ReturnType<typeof createBoardRenderServices> | undefined;
    const leases: { release(): void }[] = [];
    try {
        await check();
        const { load, samples } = owned, doc = load.doc;
        const visual = await inspectPdfVisualModel(load, { signal, cooperate });
        await check();
        if (visual.status !== 'known') throw new Error('Clipboard contains opaque or uninterpreted visual records');
        const sheet = doc.sheets.keys().next().value;
        if (sheet === undefined) throw new Error('Clipboard native records contain no sheet');

        media = new MediaStore();
        const store = media;
        const references = new Set<MediaId>();
        for (const [id, refs] of doc.mediaRefs) if (refs.size) references.add(id);
        for (const [id, count] of doc.preservedMediaRefs) if (count > 0) references.add(id);
        let loaded = 0;
        for (const id of references) {
            const entry = doc.media.get(id);
            if (!entry) continue;
            const blob = await context.readBlob(entry, signal);
            await check();
            if (!blob) continue;
            leases.push(store.retain(id, 'journal'));
            store.put(id, blob);
            if ((++loaded & 15) === 0) await cooperate();
        }

        services = createBoardRenderServices({ doc, samples, media: store, token: context.token });
        const render = services;
        const encoderBounds = await createBoardEncoderBounds({ doc, sources: load.sources, local: render.encoderLocal,
            realize: render.realize, cooperate, geometryEpoch: () => render.text.fonts.epoch });
        await encoderBounds.prepare(doc.nodes.keys(), signal);
        await check();
        const bounds = await sourceExtent(doc, node => encoderBounds.bounds(node), cooperate);
        await check();

        const acquisition: BoardClipboardAcquisition = {
            payload: Object.freeze({ v: 1, nonce: 'external0000000000', from: Object.freeze({ board: 'external', sheet, kind: doc.kind }),
                bounds, records: Object.freeze([]), media: Object.freeze({}) }),
            load, samples, inline: Object.freeze([]), report: owned.report, originalSourceKind: doc.kind,
            dispose: owned.dispose,
        };
        transferred = true;
        return { acquisition, bounds };
    } finally {
        for (const lease of leases) lease.release();
        // Awaited first: the admitted board's builds may still read the media and services until it has retired.
        try { if (!transferred) await owned.dispose(); } finally {
            services?.dispose();
            media?.clear();
        }
    }
}

export async function admitNativeClipboardRecords(bytes: Blob, context: ClipboardAdmissionContext): Promise<ExternalClipboardAdmission> {
    context.signal.throwIfAborted();
    if (!(bytes instanceof Blob) || (typeof File !== 'undefined' && bytes instanceof File)
        || bytes.size > SECURITY_LIMITS.clipboardExpandedBytes || !validBoardIdentity(context.identity)) {
        throw new TypeError('Native clipboard admission requires a copied Blob and a valid job identity');
    }
    const identity = Object.freeze({ ...context.identity });
    const cooperate = async () => {
        if (!context.isCurrent(identity)) throw new DOMException('Clipboard admission became stale', 'AbortError');
        await (context.cooperate?.() ?? yieldToHost());
    };
    const admitted = await acquireNativeBoard({ bytes, kind: CLIPBOARD_KIND,
        identity: { session: identity.session, epoch: identity.epoch, generation: identity.revision },
        signal: context.signal, deadlineMs: importDeadline(bytes.size), cooperate });
    if (admitted.status !== 'editable' || !admitted.report.complete || admitted.report.format !== 'native'
        || (admitted.report.repaired?.repairs.length ?? 0) > 0) {
        admitted.dispose();
        throw new Error('Clipboard native records could not be admitted without loss');
    }
    return admitLoadedClipboard({ load: admitted.load, samples: admitted.samples, report: admitted.report, dispose: admitted.dispose }, context);
}
