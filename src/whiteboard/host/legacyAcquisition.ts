import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { RenderToken } from '../../platform/render/types';
import type { BoardKind, HostBlock } from '../model/doc';
import type { MediaId } from '../model/media';
import type { ImportReport } from '../import/report';
import type { LegacyPageRect } from '../import/pages';
import { inspectMedia } from '../media/inspect';
import type { InspectedMedia } from '../media/ingest';
import { boardWorker, importDeadline } from '../workers/client';
import type { BoardJobIdentity } from '../workers/protocol';
import { validBoardIdentity } from '../workers/protocol';
import type { NativeLoadReply } from '../workers/nativeLoad';
import type { LegacyPrepareReply } from '../workers/legacyPrepare';
import { acquireNativeBoard, type NativeBoardAcquisition } from './nativeAcquisition';
import { scanLegacyBoard } from './legacyScan';
import { encodeHost } from '../format/encode';
import { FORMAT_LIMITS } from '../format/schema';
import { parseJsonIncremental } from '../format/jsonRead';

// Provenance: copied original -> governed legacy mapping -> real native C5.
// Native R0 is a conversion-pending source, never an invented user edit or disk baseline.
export interface LegacyAcquisitionOptions {
    readonly bytes: Blob;
    readonly kind: BoardKind;
    readonly host: HostBlock;
    readonly token: RenderToken;
    readonly zMax: number;
    readonly memory: MemoryAllocator;
    readonly nativeReport: Pick<NativeLoadReply, 'format' | 'complete' | 'bytesRead'>;
    readonly identity: BoardJobIdentity;
    /** App alone resolves local relative paths against this source document's folder. */
    readAsset?(src: string, signal: AbortSignal): Promise<Blob | null>;
    isCurrent(identity: BoardJobIdentity): boolean;
    readonly signal?: AbortSignal;
    cooperate?(): Promise<void>;
}
export type LegacyBoardAcquisition =
    | { readonly status: 'read-only'; readonly original: Blob; readonly legacyReport: ImportReport;
        readonly conversionPending: true; dispose(): void }
    | { readonly status: 'editable'; readonly original: Blob;
        /** Hash of the supplied legacy JSON, NOT an enclosing PDF's disk baseline. */
        readonly originalSha256: string;
        /** Serializer offsets and native prime MUST use these bytes, not original legacy JSON. */
        readonly bytes: Blob; readonly native: Extract<NativeBoardAcquisition, { status: 'editable' }>;
        readonly legacyReport: ImportReport; readonly media: ReadonlyMap<MediaId, Blob>;
        readonly previousFrames: readonly LegacyPageRect[]; readonly nextFrames: readonly LegacyPageRect[];
        readonly conversionPending: true; dispose(): void };
type EditableLegacy = Extract<LegacyBoardAcquisition, { status: 'editable' }>;
const activeLegacy = new WeakSet<EditableLegacy>();
function ownLegacy(value: Omit<EditableLegacy, 'dispose' | 'media'> & { readonly media: Map<MediaId, Blob> }): EditableLegacy {
    let live = true;
    const result: EditableLegacy = { ...value, dispose() {
        if (!live) return;
        live = false; activeLegacy.delete(result);
        try { value.media.clear(); } finally { value.native.dispose(); }
    } };
    activeLegacy.add(result);
    return result;
}
function report(value: unknown): value is ImportReport {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const r = value as Partial<ImportReport>;
    if (!r.counts || typeof r.counts !== 'object' || !Array.isArray(r.repairs) || !Array.isArray(r.unrepresentable)
        || r.repairs.length + r.unrepresentable.length > 400_016) return false;
    for (const [key, count] of Object.entries(r.counts)) if (key.length > 256 || !Number.isSafeInteger(count) || count < 0 || count > 200_000) return false;
    for (const list of [r.repairs, r.unrepresentable]) for (const issue of list) {
        if (!issue || (issue.id !== null && (typeof issue.id !== 'string' || issue.id.length > 1_048_576))
            || typeof issue.reason !== 'string' || issue.reason.length > 1_048_576) return false;
    }
    return true;
}
function frames(value: unknown): value is readonly LegacyPageRect[] {
    return Array.isArray(value) && value.length <= 100_000 && value.every(rect => rect && typeof rect === 'object'
        && [rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) && rect.w > 0 && rect.h > 0);
}
export async function acquireLegacyBoard(options: LegacyAcquisitionOptions): Promise<LegacyBoardAcquisition> {
    const { bytes, memory } = options;
    if (!(bytes instanceof Blob) || (typeof File !== 'undefined' && bytes instanceof File) || bytes.size > 256 * 1024 * 1024
        || !validBoardIdentity(options.identity) || options.host.kind !== options.kind) throw new TypeError('Invalid copied legacy acquisition');
    const original = new Blob([bytes], { type: bytes.type }), identity = Object.freeze({ ...options.identity });
    const signal = options.signal ?? new AbortController().signal;
    const check = () => { signal.throwIfAborted(); if (!options.isCurrent(identity)) throw new DOMException('Legacy acquisition became stale', 'AbortError'); };
    const cooperate = async () => { check(); await (options.cooperate?.() ?? new Promise<void>(resolve => setTimeout(resolve, 0))); check(); };
    check();
    // Original text, legacy object graph, two admitted sample representations and
    // native assembly coexist. The shared allocator must admit that peak first.
    const reservation = memory.reserve(16 * 1024 * 1024 + original.size * 12);
    if (!reservation) throw new Error('Insufficient shared memory for legacy conversion');
    let owned: NativeBoardAcquisition | undefined;
    const resourceReservations: ReturnType<MemoryAllocator['reserve']>[] = [];
    try {
        const scanned = await scanLegacyBoard({ bytes: original, kind: options.kind, nativeReport: options.nativeReport,
            identity, isCurrent: options.isCurrent, signal }); check();
        if (scanned.status !== 'recognized') return { status: 'read-only', original, legacyReport: scanned.report, conversionPending: true, dispose() {} };
        const verified: InspectedMedia[] = [], verifiedById = new Map<MediaId, InspectedMedia>(), sourceBlobs = new Map<MediaId, Blob>();
        const relativeAssets: NonNullable<import('../workers/legacyPrepare').LegacyPrepareRequest['relativeAssets']>[number][] = [];
        const resolved = new Map<string, Blob>(), inspected = new Map<Blob, InspectedMedia>();
        let relativeBytes = 0;
        for (const asset of scanned.assets) {
            check();
            let blob: Blob;
            if (asset.src !== undefined) {
                const cached = resolved.get(asset.src);
                if (cached) blob = cached;
                else {
                    const read = await options.readAsset?.(asset.src, signal); check();
                    if (!(read instanceof Blob)) throw new Error(`Relative legacy media is unavailable: ${asset.src}`);
                    blob = new Blob([read], { type: read.type }); resolved.set(asset.src, blob);
                }
                if (blob.size > 10 * 1024 * 1024 || blob.size > 256 * 1024 * 1024 - relativeBytes) throw new RangeError('Legacy resource bytes exceed the source limits');
                const resource = memory.reserve(blob.size * 12);
                if (!resource) throw new Error('Insufficient shared memory for legacy resources');
                resourceReservations.push(resource); relativeBytes += blob.size;
                relativeAssets.push({ sourceOrdinal: asset.sourceOrdinal, src: asset.src, blob });
            } else blob = new Blob([asset.blob], { type: asset.blob.type });
            let info = inspected.get(blob);
            if (!info) { info = await inspectMedia(blob, { identity, memory, signal, isCurrent: options.isCurrent }); check(); inspected.set(blob, info); }
            verified.push(info); verifiedById.set(info.id, info); sourceBlobs.set(info.id, blob); await cooperate();
        }
        const reply: unknown = await boardWorker('parse').request('legacyPrepare', { bytes: original, kind: options.kind,
            host: options.host, token: options.token, zMax: options.zMax, media: verified, relativeAssets }, identity,
        { priority: 0, cpu: 'governed', deadlineMs: Math.max(30_000, importDeadline(original.size)), signal }, options.isCurrent);
        check();
        if (!reply || typeof reply !== 'object' || Array.isArray(reply)) throw new TypeError('Invalid legacy preparation reply');
        const value = reply as LegacyPrepareReply;
        if ((value.status !== 'prepared' && value.status !== 'read-only') || value.conversionPending !== true || !report(value.report)
            || !frames(value.previousFrames) || !frames(value.nextFrames) || !Array.isArray(value.media) || value.media.length > 100_000
            || (value.status === 'prepared' ? !(value.bytes instanceof Blob) || value.bytes.size > 512 * 1024 * 1024 : value.bytes !== null)) {
            throw new TypeError('Invalid legacy preparation reply');
        }
        if (value.status === 'prepared' && value.report.unrepresentable.length) throw new Error('Legacy conversion reported content that cannot be represented');
        if (value.status !== 'prepared' || !value.bytes) return { status: 'read-only', original, legacyReport: value.report, conversionPending: true, dispose() {} };
        const nativeBytes = new Blob([value.bytes], { type: value.bytes.type });
        owned = await acquireNativeBoard({ bytes: nativeBytes, kind: options.kind,
            identity: { session: identity.session, epoch: identity.epoch, generation: identity.revision },
            ...(options.host.kind === 'pdf-ink' ? { pdfPages: options.host.pages } : {}), signal,
            deadlineMs: importDeadline(nativeBytes.size), cooperate }); check();
        if (owned.status !== 'editable' || !owned.report.complete || owned.report.format !== 'native') {
            throw new Error('Converted legacy source failed actual native C5 admission');
        }
        const media = new Map<MediaId, Blob>();
        for (const entry of owned.load.doc.media.values()) {
            const blob = sourceBlobs.get(entry.id), inspected = verifiedById.get(entry.id);
            if (!blob || !inspected || entry.bytes !== blob.size || entry.mime !== inspected.mime || entry.w !== inspected.width
                || entry.h !== inspected.height || entry.duration !== inspected.duration || entry.animated !== inspected.animated) {
                throw new Error('Converted media does not match the actual original-byte inspection');
            }
            media.set(entry.id, blob); await cooperate();
        }
        // Hash the copied original, not reserialized JSON or the new native R0.
        const digest = await boardWorker('decode').request<unknown>('hashSource', { blob: original }, identity,
            { priority: 0, cpu: 'governed', deadlineMs: importDeadline(original.size), signal }, options.isCurrent); check();
        if (typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(digest)) throw new TypeError('Invalid original legacy digest');
        const native = owned; owned = undefined;
        return ownLegacy({ status: 'editable', original, originalSha256: digest, bytes: nativeBytes, native,
            legacyReport: value.report, media,
            previousFrames: Object.freeze(value.previousFrames.map(rect => Object.freeze({ ...rect }))),
            nextFrames: Object.freeze(value.nextFrames.map(rect => Object.freeze({ ...rect }))), conversionPending: true });
    } finally {
        try { owned?.dispose(); } finally {
            for (const resource of resourceReservations) if (resource) memory.release(resource);
            memory.release(reservation);
        }
    }
}

/** Upgrade a genuine PDF preview HOST only after the PDF domain minted its final
 * conversion host. This does not grant write authority, reconvert legacy shapes,
 * or manufacture an edit: offsets and all other R0 bytes remain source-owned.
 * Caller keeps the old acquisition until this independent result is acquired. */
export async function rehostLegacyBoard(source: EditableLegacy,
    finalHost: Extract<HostBlock, { kind: 'pdf-ink' }>,
    options: Pick<LegacyAcquisitionOptions, 'identity' | 'isCurrent' | 'memory' | 'signal' | 'cooperate'>): Promise<EditableLegacy> {
    const identity = Object.freeze({ ...options.identity }), signal = options.signal ?? new AbortController().signal;
    const check = () => {
        signal.throwIfAborted();
        if (!activeLegacy.has(source) || !options.isCurrent(identity)) throw new DOMException('Legacy source ended', 'AbortError');
    };
    if (!validBoardIdentity(identity) || !source || !activeLegacy.has(source) || finalHost.kind !== 'pdf-ink') throw new TypeError('Expected an active legacy PDF acquisition');
    check();
    const doc = source.native.load.doc, previous = doc.host;
    if (doc.kind !== 'pdf-ink' || previous.kind !== 'pdf-ink' || doc.rev !== 0 || previous.pages.length !== finalHost.pages.length
        || previous.pages.some((page, index) => page[0] !== finalHost.pages[index][0] || page[1] !== finalHost.pages[index][1]))
        throw new Error('Final legacy PDF host must retain the admitted physical geometry');
    const records = source.native.load.sources.filter(record => record.category === 'host');
    const position = records[0]?.position;
    if (records.length !== 1 || records[0].reencode || !position || !Number.isSafeInteger(position.byteOffset)
        || !Number.isSafeInteger(position.byteLength) || position.byteOffset < 0 || position.byteLength <= 0
        || position.byteLength > FORMAT_LIMITS.recordBytes || position.byteOffset + position.byteLength > source.bytes.size
        || source.native.report.bytesRead !== source.bytes.size || !source.native.report.complete) throw new Error('Native R0 HOST has no exact admitted source span');
    const encoded = encodeHost(finalHost);
    if (!encoded.ok) throw new Error(encoded.error.reason);
    const reservation = options.memory.reserve(16 * 1024 * 1024 + source.bytes.size * 12);
    if (!reservation) throw new Error('Insufficient shared memory for native PDF host admission');
    let owned: NativeBoardAcquisition | undefined;
    try {
        const cooperate = async () => {
            check(); await (options.cooperate?.() ?? new Promise<void>(resolve => setTimeout(resolve, 0))); check();
        };
        const physical = new Uint8Array(await source.bytes.slice(position.byteOffset, position.byteOffset + position.byteLength).arrayBuffer());
        check();
        const line = new TextDecoder('utf-8', { fatal: true }).decode(physical);
        const whitespace = (code: number) => code === 32 || code === 9 || code === 10 || code === 13;
        let first = 0, last = line.length;
        while (first < last && whitespace(line.charCodeAt(first))) first++;
        while (last > first && whitespace(line.charCodeAt(last - 1))) last--;
        if (line.charCodeAt(last - 1) === 44) last--;
        while (last > first && whitespace(line.charCodeAt(last - 1))) last--;
        const original = await parseJsonIncremental(line.slice(first, last), cooperate);
        const fields = await original.fieldMapIncremental(cooperate);
        if (original.kind !== 'object' || fields.get('type')?.string(32) !== 'host' || !fields.has('pdf')) {
            throw new Error('Admitted HOST span does not contain exactly its PDF record');
        }
        // ReadPosition spans the PHYSICAL line, including its comma, not just
        // the JSON token (actual failure: final rehost dropped that delimiter).
        // Only the skipped ASCII prefix/suffix need byte conversion; Unicode
        // inside the untouched token cannot shift either splice boundary.
        const tokenStart = position.byteOffset + first;
        const tokenEnd = position.byteOffset + position.byteLength - (line.length - last);
        const bytes = new Blob([source.bytes.slice(0, tokenStart), encoded.value.text,
            source.bytes.slice(tokenEnd)], { type: source.bytes.type });
        const media = new Map(source.media);
        owned = await acquireNativeBoard({ bytes, kind: 'pdf-ink', pdfPages: finalHost.pages,
            identity: { session: identity.session, epoch: identity.epoch, generation: identity.revision }, signal,
            deadlineMs: importDeadline(bytes.size), cooperate: options.cooperate });
        check();
        if (owned.status !== 'editable' || !owned.report.complete || owned.report.format !== 'native'
            || owned.report.repaired?.repairs.length) throw new Error('Final legacy PDF HOST failed lossless native C5 admission');
        const native = owned; owned = undefined;
        return ownLegacy({ status: 'editable', original: source.original, originalSha256: source.originalSha256,
            bytes, native, legacyReport: source.legacyReport, media, previousFrames: source.previousFrames,
            nextFrames: source.nextFrames, conversionPending: true });
    } finally { try { owned?.dispose(); } finally { options.memory.release(reservation); } }
}
