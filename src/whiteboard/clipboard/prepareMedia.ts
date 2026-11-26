import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { Op } from '../change/ops';
import type { BoardRuntime } from '../host/runtime';
import type { BoardDoc } from '../model/doc';
import type { SessionOwner } from '../session/BoardSession';
import type { BoardClipboardAcquisition } from '../host/clipboardAcquisition';
import { inspectMedia } from '../media/inspect';
import type { InspectedMedia } from '../media/ingest';
import type { MediaLease } from '../media/store';
import { isSafeMediaFile, type MediaEntry, type MediaId } from '../model/media';
import { nodeRawValues } from '../model/rawMedia';
import type { ExtBag } from '../model/json';
import { IMPORTED_LEGACY_MEDIA_FIELDS, IMPORTED_LEGACY_NODE_FIELDS } from '../format/legacyRecords';
import type { BoardJobIdentity } from '../workers/protocol';
import type { JobContext } from '../security/admission';
import { resolveMediaStorage } from '../media/storage';
import type { MediaStorageReceipt, StoreMedia } from '../media/storage.types';
import { yieldToHost } from '../../platform/yieldToHost';

// Provenance: private clipboard media, session job authority and SEC-W4
// verification contracts; independent pre-transaction staging, no third-party source.
export interface PreparedClipboardMedia {
    /** The board the media was staged for. Not its revision: what a stored picture adds or renames is checked again where it
     * lands (change/insertionLanding.ts), so a stroke committed meanwhile does not throw the paste away. */
    readonly stamp: Readonly<{ runtime: BoardRuntime; owner: Readonly<SessionOwner>; doc: BoardDoc; revision: number }>;
    readonly mediaOps: readonly Op[];
    readonly files: ReadonlyMap<MediaId, string | null>;
    readonly blobs: ReadonlyMap<MediaId, Blob>;
    readonly missing: readonly MediaId[];
    /** Called inside the same owning job, after the one destination kernel commit. */
    committed(): void;
    /** Release only after the destination transaction has retained its media. */
    release(): void;
}
export interface PrepareClipboardMediaOptions {
    readonly runtime: BoardRuntime;
    readonly acquisition: Pick<BoardClipboardAcquisition, 'load' | 'inline'>;
    readonly memory: MemoryAllocator;
    readBlob(entry: MediaEntry, signal: AbortSignal): Promise<Blob | null>;
    readonly storeMedia: StoreMedia;
    current(): boolean;
    readonly signal?: AbortSignal;
    cooperate?(): Promise<void>;
}
function cloneEntry(entry: MediaEntry): MediaEntry {
    return { ...entry, ext: entry.ext ? { fields: new Map(entry.ext.fields), raw: new Map(entry.ext.raw) } : null };
}
function matches(entry: MediaEntry, info: InspectedMedia, size: number): boolean {
    return entry.id === info.id && entry.mime === info.mime && entry.bytes === size && entry.w === info.width && entry.h === info.height
        && entry.animated === info.animated && entry.duration === info.duration;
}
/** Data this version cannot interpret, which might name a media file. The old-board importer's own fields are not that
 * (format/legacyRecords.ts): counted, they refused every paste of an old notebook's pictures into a PDF, whose copy is
 * stored under another name, with "Cannot remap media with uninterpreted filename dependencies". */
function uninterpreted(ext: ExtBag | null, known: ReadonlySet<string>): boolean {
    if (!ext) return false;
    if (ext.raw.size) return true;
    for (const key of ext.fields.keys()) if (!known.has(key)) return true;
    return false;
}
function compatible(a: MediaEntry, b: MediaEntry): boolean {
    return a.id === b.id && a.mime === b.mime && a.bytes === b.bytes && a.w === b.w && a.h === b.h
        && a.animated === b.animated && a.duration === b.duration;
}
/** A picture that cannot be pasted here: details this version cannot read may name its file, and here it would be stored
 * under another name. Said in the person's words (the board shows the message as is); the media id is kept for the console. */
export class ClipboardMediaRefused extends Error {
    constructor(readonly mediaId: string) {
        super('A picture in what you pasted carries details this version of the app cannot read, which may depend on its file '
            + 'name, so it cannot be stored here under a different one. Paste it into a drawing or notebook in the folder you '
            + 'copied it from, or copy the other items without it.');
        this.name = 'ClipboardMediaRefused';
    }
}
export function prepareBoardClipboardMedia(options: PrepareClipboardMediaOptions): Promise<PreparedClipboardMedia> {
    return prepareMedia(options);
}
/** A whole-paste job already owns the serial tail. Never enqueue behind that same job. */
export function prepareBoardClipboardMediaInJob(options: PrepareClipboardMediaOptions, context: JobContext): Promise<PreparedClipboardMedia> {
    options.runtime.jobs.assertContext(context);
    if (options.signal && options.signal !== context.signal) throw new TypeError('In-job clipboard media must use its owning context signal');
    return prepareMedia({ ...options, signal: context.signal }, context);
}
function prepareMedia(options: PrepareClipboardMediaOptions, existingContext?: JobContext): Promise<PreparedClipboardMedia> {
    const { runtime } = options, source = options.acquisition.load.doc;
    options.signal?.throwIfAborted();
    // Rehydrated source maps and Blob values remain immutable after acquisition disposal;
    // copy their metadata cooperatively inside the owning job, not on the event path.
    const sourceInline = options.acquisition.inline;
    const deadlineMs = 180_000;
    let abortOwned: (() => void) | undefined;
    const work = async (context: JobContext): Promise<PreparedClipboardMedia> => {
        runtime.jobs.assertContext(context);
        const session = runtime.session, doc = session.doc, revision = doc.rev;
        const owner = Object.freeze({ documentId: session.owner.documentId, session: session.owner.session });
        const stamp = Object.freeze({ runtime, owner, doc, revision });
        const identity: BoardJobIdentity = Object.freeze({ session: context.job.session, epoch: context.job.vaultEpoch, revision });
        const current = (job: BoardJobIdentity) => job.session === identity.session && job.epoch === identity.epoch && job.revision === identity.revision
            && runtime.jobs.isCurrent(context.job) && options.current() && runtime.session === session && session.doc === doc
            && session.owner.documentId === owner.documentId && session.owner.session === owner.session;
        const check = () => { runtime.jobs.assertContext(context); context.assertCurrent(); if (!current(identity)) throw new DOMException('Clipboard media staging became stale', 'AbortError'); };
        let steps = 0, sliceStart = performance.now();
        const cooperate = async () => {
            check();
            if (++steps < 128 && performance.now() - sliceStart < 3) return;
            await (options.cooperate?.() ?? yieldToHost());
            check(); steps = 0; sliceStart = performance.now();
        };
        const ops: Op[] = [], files = new Map<MediaId, string | null>(), blobs = new Map<MediaId, Blob>(), leases: MediaLease[] = [], missing: MediaId[] = [];
        const receipts: MediaStorageReceipt[] = [];
        let held = true;
        const release = () => {
            if (!held) return; held = false; context.signal.removeEventListener('abort', release);
            try { for (const receipt of receipts) receipt.release(); }
            finally { receipts.length = 0; for (const lease of leases) lease.release(); leases.length = 0; }
        };
        try {
            check();
            const entries = new Map<MediaId, MediaEntry>(), preservedRefs = new Map<MediaId, number>(), inline = new Map<MediaId, Blob>();
            let hasUnknownRaw = false, visits = 0;
            for (const [id, refs] of source.mediaRefs) {
                if (refs.size) {
                    const entry = source.media.get(id); if (!entry) throw new Error(`Clipboard media has no metadata: ${id}`);
                    entries.set(id, cloneEntry(entry));
                }
                if ((++visits & 255) === 0) await cooperate();
            }
            for (const [id, count] of source.preservedMediaRefs) {
                preservedRefs.set(id, count);
                if (count > 0) {
                    const entry = source.media.get(id); if (!entry) throw new Error(`Clipboard preserved media has no metadata: ${id}`);
                    entries.set(id, cloneEntry(entry));
                }
                if ((++visits & 255) === 0) await cooperate();
            }
            for (const node of source.nodes.values()) {
                hasUnknownRaw = uninterpreted(node.ext, IMPORTED_LEGACY_NODE_FIELDS);
                if (!hasUnknownRaw) for (const item of nodeRawValues({ ...node, ext: null })) if (item !== null) { hasUnknownRaw = true; break; }
                if (hasUnknownRaw) break;
                if ((++visits & 255) === 0) await cooperate();
            }
            for (const item of sourceInline) {
                if (inline.has(item.id) || !(item.blob instanceof Blob) || (typeof File !== 'undefined' && item.blob instanceof File)) throw new TypeError('Invalid clipboard inline media');
                inline.set(item.id, new Blob([item.blob], { type: item.blob.type }));
                if ((++visits & 255) === 0) await cooperate();
            }
            for (const [id, entry] of entries) {
                check();
                const existing = runtime.session.doc.media.get(id);
                if (existing && !compatible(existing, entry)) throw new Error(`Conflicting destination media metadata: ${id}`);
                let candidate = runtime.media.get(id) ?? inline.get(id);
                if (!candidate) { candidate = await options.readBlob(entry, context.signal) ?? undefined; check(); }
                if (!(candidate instanceof Blob)) {
                    if (!existing) {
                        // No bytes to store, so nothing is renamed: where unknown data may name the file, the record keeps the
                        // name it was written with (the picture appears if that file is put in this folder's .Assets). Refusing
                        // here lost the whole paste of a board whose picture file was missing ("Cannot remap missing media…").
                        const keepName = entry.file !== null && (uninterpreted(entry.ext, IMPORTED_LEGACY_MEDIA_FIELDS)
                            || (preservedRefs.get(id) ?? 0) > 0 || hasUnknownRaw);
                        ops.push({ t: 'media', op: 'add', entry: keepName ? entry : { ...entry, file: null } });
                        files.set(id, keepName ? entry.file : null);
                    }
                    missing.push(id); await cooperate(); continue;
                }
                const blob = new Blob([candidate], { type: candidate.type });
                const info = await inspectMedia(blob, { memory: options.memory, signal: context.signal, identity, isCurrent: current });
                check();
                if (!matches(entry, info, blob.size) || (existing && !matches(existing, info, blob.size))) throw new Error(`Clipboard media bytes do not match metadata: ${id}`);
                const location = existing ? runtime.media.currentFile(id) : undefined;
                const existingFile = existing ? (location === undefined ? existing.file : location) : null;
                const proposed = existing ? { ...cloneEntry(existing), file: existingFile } : { ...entry, file: null };
                const proof = { runtime, context, inspection: info };
                const result = await options.storeMedia(proposed, blob, context.signal, proof);
                const { file, receipt } = resolveMediaStorage(result, { ...proof, entry: proposed, blob });
                if (receipt) receipts.push(receipt);
                check();
                if (!isSafeMediaFile(file)) throw new Error(`Invalid destination media file: ${id}`);
                const sourceConflict = file !== entry.file && (uninterpreted(entry.ext, IMPORTED_LEGACY_MEDIA_FIELDS)
                    || (preservedRefs.get(id) ?? 0) > 0 || (entry.file !== null && hasUnknownRaw));
                const destinationConflict = !!existing && file !== existingFile
                    && (uninterpreted(existing.ext, IMPORTED_LEGACY_MEDIA_FIELDS)
                        || (runtime.session.doc.preservedMediaRefs.get(id) ?? 0) > 0);
                if (sourceConflict || destinationConflict) throw new ClipboardMediaRefused(id);
                leases.push(runtime.media.retain(id, 'snapshot'));
                runtime.media.put(id, blob); blobs.set(id, blob); files.set(id, file);
                if (!existing) ops.push({ t: 'media', op: 'add', entry: { ...entry, file } });
                else if (existing.file !== file) ops.push({ t: 'media', op: 'set-file', id, file });
                await cooperate();
            }
            check();
            abortOwned = release;
            context.signal.addEventListener('abort', release, { once: true });
            check();
            return { stamp, mediaOps: Object.freeze(ops), files, blobs, missing: Object.freeze(missing),
                committed() { if (!held) throw new Error('Clipboard media storage ended'); for (const receipt of receipts) receipt.committed(); }, release };
        } catch (error) { release(); throw error; }
    };
    const operation = existingContext ? work(existingContext) : runtime.jobs.run(work, { signal: options.signal, deadlineMs });
    return operation.then(result => {
        options.signal?.throwIfAborted();
        if (!options.current() || runtime.session.doc !== result.stamp.doc
            || runtime.session.owner.documentId !== result.stamp.owner.documentId || runtime.session.owner.session !== result.stamp.owner.session) throw new DOMException('Clipboard media staging became stale', 'AbortError');
        abortOwned = undefined;
        return result;
    }).catch(error => { abortOwned?.(); abortOwned = undefined; throw error; });
}
