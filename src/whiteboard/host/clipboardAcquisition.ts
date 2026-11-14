import type { CachedClipboard } from '../clipboard/copy';
import { makeClipboardNativeRecords } from '../clipboard/nativeRecords';
import type { BoardPayload, CopySnapshot } from '../clipboard/snapshot';
import type { SampleStore } from '../ink/samples';
import type { MediaId } from '../model/media';
import type { NodeId } from '../model/ids';
import type { Attachment } from '../model/nodes';
import type { RehydratedLoad } from '../model/loadTypes';
import { SECURITY_LIMITS } from '../security/limits';
import { boardWorker, importDeadline } from '../workers/client';
import type { BoardJobIdentity } from '../workers/protocol';
import { validBoardIdentity } from '../workers/protocol';
import type { NativeLoadReply } from '../workers/nativeLoad';
import type { DecodedBoardClipboard } from '../workers/clipboardDecode';
import { acquireNativeBoard, type NativeBoardAcquisition } from './nativeAcquisition';
import { inspectPdfVisualModel } from './pdfVisualPreflight';

// Provenance: private clipboard source admission, C5 rehydration and immutable
// media identity contracts; independent host composition, no third-party source.
export interface BoardClipboardAcquisition {
    readonly payload: BoardPayload;
    readonly load: RehydratedLoad;
    readonly samples: SampleStore;
    readonly inline: readonly Readonly<{ id: MediaId; blob: Blob }>[];
    /** Exact in-window copy data for bindings outside the native source container. */
    readonly externalBindings?: ReadonlyMap<NodeId, Readonly<{ start?: Attachment; end?: Attachment }>>;
    readonly report: NativeLoadReply;
    readonly originalSourceKind: BoardPayload['from']['kind'];
    dispose(): void;
}
export interface BoardClipboardAcquisitionOptions {
    readonly decoded: DecodedBoardClipboard;
    readonly identity: BoardJobIdentity;
    isCurrent(identity: BoardJobIdentity): boolean;
    readonly signal?: AbortSignal;
    cooperate?(): Promise<void>;
    /** Must be the exact result of ClipboardCopy.match for these actual clipboard strings. */
    readonly cache?: Readonly<{ match: CachedClipboard; encoded: string; plain: string }>;
    /** Actual same-session snapshot owned by the duplicate command, never an external payload. */
    readonly duplicateSnapshot?: CopySnapshot;
}
function snapshot(payload: BoardPayload): BoardPayload {
    if (!payload || payload.v !== 1 || typeof payload.nonce !== 'string' || !/^[A-Za-z0-9]{16}$/.test(payload.nonce)
        || !payload.from || typeof payload.from.board !== 'string' || !payload.from.board.length || payload.from.board.length > 128
        || typeof payload.from.sheet !== 'string' || !payload.from.sheet.length || payload.from.sheet.length > 128
        || !['whiteboard', 'notebook', 'pdf-ink'].includes(payload.from.kind) || !payload.bounds
        || ![payload.bounds.x, payload.bounds.y, payload.bounds.w, payload.bounds.h, payload.bounds.x + payload.bounds.w,
            payload.bounds.y + payload.bounds.h].every(Number.isFinite) || payload.bounds.w < 0 || payload.bounds.h < 0
        || !Array.isArray(payload.records) || payload.records.length > SECURITY_LIMITS.clipboardRecords
        || !payload.media || typeof payload.media !== 'object' || Array.isArray(payload.media)) throw new TypeError('Invalid clipboard payload');
    const from = Object.freeze({ ...payload.from }), bounds = Object.freeze({ ...payload.bounds });
    const records = Object.freeze(payload.records.map(row => { if (typeof row !== 'string') throw new TypeError('Invalid clipboard record'); return row; }));
    const media: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [id, data] of Object.entries(payload.media)) {
        if (!/^sha256:[0-9a-f]{64}$/.test(id) || typeof data !== 'string') throw new TypeError('Invalid clipboard media data');
        media[id] = data;
    }
    return Object.freeze({ v: 1, nonce: payload.nonce, from, bounds, records, media: Object.freeze(media) });
}
function sameMarker(marker: BoardPayload, value: BoardPayload): boolean {
    return marker.nonce === value.nonce && marker.from.board === value.from.board && marker.from.sheet === value.from.sheet
        && marker.from.kind === value.from.kind && marker.bounds.x === value.bounds.x && marker.bounds.y === value.bounds.y
        && marker.bounds.w === value.bounds.w && marker.bounds.h === value.bounds.h;
}
/** Decoder/cache data is copied before the first await; its owner may then release its lease. */
export async function acquireBoardClipboard(options: BoardClipboardAcquisitionOptions): Promise<BoardClipboardAcquisition> {
    options.signal?.throwIfAborted();
    if (!validBoardIdentity(options.identity) || !options.decoded || typeof options.decoded.cacheOnly !== 'boolean'
        || !Array.isArray(options.decoded.inline) || options.decoded.inline.length > SECURITY_LIMITS.clipboardNodes) throw new TypeError('Invalid clipboard acquisition');
    const identity = Object.freeze({ ...options.identity }), marker = snapshot(options.decoded.payload);
    let source = marker;
    if (options.decoded.cacheOnly) {
        if (marker.records.length || Object.keys(marker.media).length || options.decoded.inline.length) throw new TypeError('Invalid cache-only clipboard marker');
        const cache = options.cache;
        if (!cache || !cache.match.cacheOnly || cache.match.encoded !== cache.encoded || cache.match.plain !== cache.plain
            || !sameMarker(marker, cache.match.snapshot.payload)) throw new Error('This clipboard content requires its matching in-session copy cache');
        source = snapshot(cache.match.snapshot.payload);
    }
    if (!source.records.length) throw new Error('Clipboard contains no native records');
    const externalBindings = new Map<NodeId, Readonly<{ start?: Attachment; end?: Attachment }>>();
    const cacheMatch = options.cache;
    const cached = options.duplicateSnapshot ?? (cacheMatch && cacheMatch.match.encoded === cacheMatch.encoded
        && (!cacheMatch.match.cacheOnly || cacheMatch.match.plain === cacheMatch.plain) ? cacheMatch.match.snapshot : undefined);
    if (cached && sameMarker(marker, cached.payload)) {
        const present = new Set<NodeId>(); let visited = 0;
        for (const node of cached.nodes) {
            present.add(node.id);
            if ((++visited & 255) === 0) {
                options.signal?.throwIfAborted(); await (options.cooperate?.() ?? new Promise<void>(resolve => setTimeout(resolve, 0)));
                if (!options.isCurrent(identity)) throw new DOMException('Clipboard acquisition became stale', 'AbortError');
            }
        }
        const external = (attachment: Attachment | null | undefined) => attachment && !present.has(attachment.target)
            ? Object.freeze({ ...attachment, anchor: Object.freeze({ ...attachment.anchor }) }) : undefined;
        for (const node of cached.nodes) {
            if ((++visited & 255) === 0) {
                options.signal?.throwIfAborted(); await (options.cooperate?.() ?? new Promise<void>(resolve => setTimeout(resolve, 0)));
                if (!options.isCurrent(identity)) throw new DOMException('Clipboard acquisition became stale', 'AbortError');
            }
            if (node.kind !== 'connector' && node.kind !== 'polyline') continue;
            const line = node as typeof node & { readonly startAttach?: Attachment | null; readonly endAttach?: Attachment | null };
            const start = external(node.kind === 'connector' ? node.start.attach : line.startAttach);
            const end = external(node.kind === 'connector' ? node.end.attach : line.endAttach);
            if (start || end) externalBindings.set(node.id, Object.freeze({ ...(start ? { start } : {}), ...(end ? { end } : {}) }));
        }
    }
    const inline: { id: MediaId; blob: Blob }[] = [], seen = new Set<string>();
    let total = 0;
    for (const item of options.decoded.inline) {
        if (!item || typeof item.id !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(item.id) || seen.has(item.id)
            || !(item.blob instanceof Blob) || (typeof File !== 'undefined' && item.blob instanceof File)
            || item.blob.size > SECURITY_LIMITS.mediaBytes || item.blob.size > 32 * 1024 * 1024 - total) throw new TypeError('Invalid inline clipboard media');
        total += item.blob.size; seen.add(item.id);
        inline.push(Object.freeze({ id: item.id, blob: new Blob([item.blob], { type: item.blob.type }) }));
    }
    Object.freeze(inline);
    const signal = options.signal ?? new AbortController().signal;
    const check = () => { signal.throwIfAborted(); if (!options.isCurrent(identity)) throw new DOMException('Clipboard acquisition became stale', 'AbortError'); };
    const cooperate = async () => { check(); await (options.cooperate?.() ?? new Promise<void>(resolve => setTimeout(resolve, 0))); check(); };
    check();
    let acquisition: NativeBoardAcquisition | undefined;
    try {
        for (const item of inline) {
            const hash = await boardWorker('decode').request<unknown>('hash', { blob: item.blob }, identity,
                { priority: 0, cpu: 'governed', signal, deadlineMs: 10_000 }, options.isCurrent);
            check();
            if (hash !== item.id) throw new Error('Clipboard inline media hash mismatch');
        }
        const result = await makeClipboardNativeRecords(source, { signal, cooperate }); check();
        acquisition = await acquireNativeBoard({ bytes: result.bytes, kind: 'whiteboard',
            identity: { session: identity.session, epoch: identity.epoch, generation: identity.revision },
            signal, deadlineMs: importDeadline(result.bytes.size), cooperate });
        check();
        if (acquisition.status !== 'editable' || !acquisition.report.complete || acquisition.report.format !== 'native') {
            throw new Error('Clipboard native records could not be admitted without loss');
        }
        const visual = await inspectPdfVisualModel(acquisition.load, { signal, cooperate }); check();
        if (visual.status !== 'known') throw new Error('Clipboard contains opaque or uninterpreted visual records');
        const owned = acquisition;
        acquisition = undefined;
        let disposed = false;
        return { payload: source, load: owned.load, samples: owned.samples, inline, externalBindings, report: owned.report,
            originalSourceKind: result.originalSourceKind,
            dispose() { if (!disposed) { disposed = true; owned.dispose(); } } };
    } catch (error) { acquisition?.dispose(); throw error; }
}
