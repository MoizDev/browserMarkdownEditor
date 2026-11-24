import { getPlatformRuntime } from '../../platform/render/platformRuntime';
import type { ReserveOptions } from '../../platform/render/memoryGovernor';
import { acquireLegacyPdfInkCandidate } from '../../pdf/session/legacyInkAcquisition';
import { createConvertedPdfInkSource } from '../../pdf/session/convertedInkSource';
import { createPdfInkConversionHost } from '../../pdf/session/inkHost';
import { getSessionIdentity } from '../../utils/sessionIdentity';
import { acquireLegacyBoard, rehostLegacyBoard, type LegacyBoardAcquisition } from './legacyAcquisition';
import type { NativeLoadReply } from '../workers/nativeLoad';
import { acquireNativeBoard } from './nativeAcquisition';
import { importFailure, importNotice } from '../import/report';
import { inspectPdfVisualModel } from './pdfVisualPreflight';
import { prepareAcceptedPdfInkSession, type PreparePdfInkSessionOptions } from './preparePdfInkSession';

let memorySerial = 0;
const stale = () => new DOMException('PDF conversion ended', 'AbortError');

function visualFailure(phase: 'preview' | 'final', visual: Awaited<ReturnType<typeof inspectPdfVisualModel>>): Error {
    const counts = new Map<string, number>();
    const families = new Set(['legacy-document', 'legacy-user', 'legacy-shape', 'legacy-binding', 'legacy-unknown-record',
        'legacy-unreadable-record', 'legacy-bookmark-asset', 'legacy-orphan-asset', 'legacy-unreadable-asset', 'legacy-rich-text']);
    for (const issue of visual.issues) {
        const key = issue.kind === 'preserved-record'
            ? `${issue.kind}/${families.has(issue.type) ? issue.type : 'other'}` : issue.kind;
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const summary = [...counts].map(([kind, count]) => `${kind}: ${count}`).join(', ');
    return new Error(`Legacy PDF ${phase} visual preflight is unknown (${summary || 'unclassified'}). The original is unchanged.`);
}

/** The candidate is pane-cancellable until the actual App-owned runtime takes it. */
export async function prepareLegacyPdfInkSession(options: PreparePdfInkSessionOptions) {
    const { host, identity, signal } = options, documentId = identity.documentId;
    const current = () => identity.kind === 'pdfInk' && host.isCurrent(identity)
        && getSessionIdentity(documentId)?.serial === identity.session;
    signal.throwIfAborted();
    if (!current()) throw stale();
    const outer = await host.acquireBytes(identity, signal);
    signal.throwIfAborted();
    if (!current()) throw stale();
    const token = { documentId, session: identity.session, vaultEpoch: identity.vaultActivation, bytesGeneration: identity.bytesGeneration };
    const internal = new AbortController(), forwardAbort = () => internal.abort(signal.reason);
    signal.addEventListener('abort', forwardAbort, { once: true });
    if (signal.aborted) forwardAbort();
    const detach = () => signal.removeEventListener('abort', forwardAbort);
    let transferred = false, candidate: Awaited<ReturnType<typeof acquireLegacyPdfInkCandidate>> | undefined;
    let preview: LegacyBoardAcquisition | undefined, final: LegacyBoardAcquisition | undefined;
    try {
        candidate = await acquireLegacyPdfInkCandidate({ outer, token, isCurrent: current, signal: internal.signal });
        signal.throwIfAborted();
        if (!current()) throw stale();
        if (candidate.kind !== 'conversion-required') throw new Error(candidate.kind === 'read-only' ? candidate.reason : 'This PDF is not a legacy annotated PDF');
        const source = candidate;
        const native = await acquireNativeBoard({ bytes: source.snapshot, kind: 'pdf-ink',
            pdfPages: source.pages.map(page => [page.width, page.height] as const), signal: internal.signal,
            deadlineMs: options.deadlineMs, identity: { session: `${documentId}:${identity.session}`,
                epoch: identity.vaultActivation, generation: identity.bytesGeneration } });
        let nativeReport: typeof native.report;
        try {
            if (native.status !== 'read-only' || native.report.format !== 'other' || !native.report.complete
                || native.report.bytesRead !== source.snapshot.size) throw new Error('The embedded source is not a completely classified legacy board');
            nativeReport = native.report;
        } finally { native.dispose(); }
        const now = performance.now();
        let live = 0;
        const cache = getPlatformRuntime().governor.register({ id: `legacy-pdf:${documentId}:${++memorySerial}`, owner: token,
            pool: 'cpu', kind: 'working', class: 'critical', hiddenAt: null, lastVisibleAt: now, lastUsedAt: now,
            memory: () => ({ live, retiring: 0 }), evict: () => {} });
        const memory = {
            reserve(bytes: number, options?: ReserveOptions) { const lease = cache.reserve(bytes, options); if (lease) live += lease.bytes; return lease; },
            release(lease: Parameters<typeof cache.release>[0]) { cache.release(lease); live -= lease.bytes; },
            whenAvailable: (wake: () => void, bytes?: number) => cache.whenAvailable?.(wake, bytes),
        };
        try {
            const job = { session: `${documentId}:${identity.session}`, epoch: identity.vaultActivation, revision: identity.bytesGeneration };
            const isCurrent = (value: typeof job) => value.session === job.session && value.epoch === job.epoch
                && value.revision === job.revision && current() && source.isCurrent();
            const convert = (hostBlock: ReturnType<typeof source.createPreviewHost>) => acquireLegacyBoard({ bytes: source.snapshot,
                kind: 'pdf-ink', host: hostBlock, token, zMax: options.zMax, memory, nativeReport, identity: job, loadKey: documentId,
                isCurrent, readAsset: (src, assetSignal) => host.readLegacyAsset(identity, src, assetSignal), signal: internal.signal });
            preview = await convert(source.createPreviewHost());
            if (preview.status !== 'editable') throw new Error(importFailure('The old ink on this PDF could not be read', preview.legacyReport.unrepresentable));
            const visual = await inspectPdfVisualModel(preview.native.load, { signal: internal.signal });
            if (visual.status !== 'known') throw visualFailure('preview', visual);
            const qualificationFor = (board: Blob, report: NativeLoadReply, checkedVisual: typeof visual) => ({ board,
                report: Object.freeze({ format: report.format, complete: report.complete, bytesRead: report.bytesRead }), visual: checkedVisual });
            let qualification = qualificationFor(preview.bytes, preview.native.report, visual);
            const checkRenderable = () => {
                internal.signal.throwIfAborted();
                if (!current() || !source.isCurrent() || qualification.visual.status !== 'known'
                    || qualification.report.format !== 'native' || !qualification.report.complete
                    || qualification.report.bytesRead !== qualification.board.size) throw stale();
            };
            checkRenderable();
            if (source.writeMark.kind !== 'foreign') {
                const allowed = await host.confirmLegacyPdfConversion(identity, { originalSha256: source.legacyOriginalSha256, foreign: null }, internal.signal);
                checkRenderable();
                if (!allowed) throw new DOMException('PDF conversion was not confirmed', 'NotAllowedError');
            }
            const ready = await source.prepare({ assertRenderable: checkRenderable,
                confirmForeignMark: (foreign, innerSignal) => host.confirmLegacyPdfConversion(identity,
                    { originalSha256: source.legacyOriginalSha256, foreign }, innerSignal),
                keepConversionBackup: (bytes, sha, innerSignal) => host.keepConversionBackup(identity, bytes, sha, innerSignal) });
            checkRenderable();
            const previousFrames = preview.previousFrames.map(frame => ({ width: frame.w, height: frame.h }));
            const finalHost = createPdfInkConversionHost(ready, previousFrames);
            final = await rehostLegacyBoard(preview, finalHost, { identity: job, isCurrent, loadKey: documentId, signal: internal.signal });
            if (final.status !== 'editable' || final.originalSha256 !== preview.originalSha256
                || final.previousFrames.length !== preview.previousFrames.length
                || final.previousFrames.some((frame, i) => {
                    const old = preview!.status === 'editable' ? preview!.previousFrames[i] : undefined;
                    return !old || frame.x !== old.x || frame.y !== old.y || frame.w !== old.w || frame.h !== old.h;
                })) throw new Error('The final PDF conversion does not match its verified preview');
            preview.dispose(); preview = undefined;
            const finalVisual = await inspectPdfVisualModel(final.native.load, { signal: internal.signal });
            checkRenderable();
            if (finalVisual.status !== 'known') throw visualFailure('final', finalVisual);
            qualification = qualificationFor(final.bytes, final.native.report, finalVisual);
            checkRenderable();
            const accepted = await createConvertedPdfInkSource(ready, { board: qualification.board, host: finalHost, media: final.media, signal: internal.signal });
            if (accepted.board !== qualification.board) { await accepted.release(); throw new Error('Converted PDF source changed its qualified board'); }
            transferred = true;
            const prepared = await prepareAcceptedPdfInkSession(options, accepted, detach);
            const notice = final.status === 'editable' ? importNotice(final.legacyReport) : null;
            return { ...prepared, importNotice: notice, async dispose() { try { await prepared.dispose(); } finally { detach(); } } };
        } finally { try { preview?.dispose(); } finally { try { final?.dispose(); } finally { cache.close(); } } }
    } catch (error) {
        if (!transferred) await candidate?.release();
        detach();
        throw error;
    }
}
