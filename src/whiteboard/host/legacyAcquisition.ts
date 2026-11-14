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
    try {
        const scanned = await scanLegacyBoard({ bytes: original, kind: options.kind, nativeReport: options.nativeReport,
            identity, isCurrent: options.isCurrent, signal }); check();
        if (scanned.status !== 'recognized') return { status: 'read-only', original, legacyReport: scanned.report, conversionPending: true, dispose() {} };
        const verified: InspectedMedia[] = [], verifiedById = new Map<MediaId, InspectedMedia>(), sourceBlobs = new Map<MediaId, Blob>();
        for (const asset of scanned.assets) {
            check();
            const blob = new Blob([asset.blob], { type: asset.blob.type });
            const info = await inspectMedia(blob, { identity, memory, signal, isCurrent: options.isCurrent }); check();
            verified.push(info); verifiedById.set(info.id, info); sourceBlobs.set(info.id, blob); await cooperate();
        }
        const reply: unknown = await boardWorker('parse').request('legacyPrepare', { bytes: original, kind: options.kind,
            host: options.host, token: options.token, zMax: options.zMax, media: verified }, identity,
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
        const digest = await boardWorker('decode').request<unknown>('hash', { blob: original }, identity,
            { priority: 0, cpu: 'governed', deadlineMs: importDeadline(original.size), signal }, options.isCurrent); check();
        if (typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(digest)) throw new TypeError('Invalid original legacy digest');
        const native = owned; owned = undefined;
        let live = true;
        return { status: 'editable', original, originalSha256: digest, bytes: nativeBytes, native,
            legacyReport: value.report, media,
            previousFrames: Object.freeze(value.previousFrames.map(rect => Object.freeze({ ...rect }))),
            nextFrames: Object.freeze(value.nextFrames.map(rect => Object.freeze({ ...rect }))), conversionPending: true,
            dispose() { if (!live) return; live = false; media.clear(); native.dispose(); } };
    } finally { try { owned?.dispose(); } finally { memory.release(reservation); } }
}
