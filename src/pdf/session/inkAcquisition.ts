import { Sha256 } from '../../utils/sha256';
import { tiledPdfCapabilities } from '../../utils/pdfCapabilities';
import { NATIVE_FORMAT_ID } from '../../whiteboard/format/identity';
import type { PageGeometry } from '../../platform/types';
import type { PdfPoolDocument } from '../pool/types';
import { pdfDocKey } from '../worker/protocol';
import { validateBoardWriteIdentity } from '../writing/boardIdentity';
import type { PdfInkInspection } from '../writing/inkInspection.types';
import type { WriterSource } from '../writing/protocol';
import { typedPdfWriter } from '../writing/writerClient';
import { getSharedPdfPool } from './startup';
import { createPdfInkBackdrop } from './inkBackdrop';
import type { PdfInkAcquisition, PdfInkAcquisitionOptions } from './inkAcquisition.types';

const HASH = /^[0-9a-f]{64}$/;
const MEDIA = /^board-media\/([0-9a-f]{64})\.[a-zA-Z0-9]{1,16}$/;
const stale = () => new DOMException('PDF ink source is no longer current', 'AbortError');
const memoryBlob = (value: unknown): value is Blob => value instanceof Blob &&
    !(typeof File !== 'undefined' && value instanceof File) && value.size > 0 && value.size < 0x80000000;

async function chunkedBlobSha256(blob: Blob, guard: () => void): Promise<string> {
    const hash = new Sha256();
    for (let offset = 0; offset < blob.size; offset += 1024 * 1024) {
        guard();
        const bytes = await blob.slice(offset, offset + 1024 * 1024).arrayBuffer();
        guard();
        hash.update(new Uint8Array(bytes));
    }
    guard();
    return hash.digest();
}

function matchingGeometry(a: Readonly<PageGeometry>, b: Readonly<PageGeometry>): boolean {
    return a.index === b.index && a.width === b.width && a.height === b.height && a.rotate === b.rotate &&
        a.userUnit === b.userUnit && a.toUserSpace.length === 6 && b.toUserSpace.length === 6 &&
        a.toUserSpace.every((value, index) => value === b.toUserSpace[index]);
}

function policyReason(doc: PdfPoolDocument): string | null {
    const policy = tiledPdfCapabilities(doc.info);
    if (policy.encrypted !== false) return 'Encrypted PDFs cannot be edited.';
    if (policy.signed !== false) return 'PDF signatures could not be ruled out; editing is unavailable.';
    if (policy.render !== true || policy.copy !== true || policy.capture !== true || policy.write !== true) {
        return 'PDF permissions or write safety could not be established; editing is unavailable.';
    }
    return null;
}

/** Acquires only immutable, caller-owned snapshots. No filesystem access or writer is held during inspection. */
export async function acquirePdfInkSource(options: PdfInkAcquisitionOptions): Promise<PdfInkAcquisition> {
    if (!memoryBlob(options.outer)) throw new RangeError('PDF ink requires a nonempty memory-backed Blob below 2 GiB');
    const token = Object.freeze({ ...options.token }), controller = new AbortController();
    const lifetime = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])]);
    let outer: PdfPoolDocument | undefined, original: PdfPoolDocument | undefined;
    let released = false, releasePromise: Promise<void> | undefined;
    const callerCurrent = () => {
        if (options.signal?.aborted) return false;
        try { return options.isCurrent(); } catch { return false; }
    };
    const current = () => !released && !lifetime.aborted && !outer?.closed && !original?.closed && callerCurrent();
    const guard = () => { if (!current()) throw stale(); };
    const release = (): Promise<void> => {
        if (releasePromise) return releasePromise;
        released = true;
        controller.abort();
        options.signal?.removeEventListener('abort', onAbort);
        // These are this inspection's independent pool.open leases. The pool
        // keeps App's reader source alive until its separate last lease closes.
        releasePromise = Promise.allSettled([original?.close(), outer?.close()]).then(() => {});
        return releasePromise;
    };
    const onAbort = () => { void release(); };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const readOnly = async (reason: string, notebook?: { notebookSource: { path: string; exportedAt?: number }; outerFingerprint: string }): Promise<PdfInkAcquisition> => {
        guard();
        await release();
        if (!callerCurrent()) throw stale();
        return { kind: 'read-only', reason, ...(notebook ? { ...notebook, isCurrent: callerCurrent } : {}), release };
    };
    try {
        guard();
        const pool = options.pool ?? await getSharedPdfPool();
        guard();
        const openedOuter = await pool.open({ token, source: 'outer', blob: options.outer, priority: 0, signal: lifetime });
        openedOuter.setVisible(false);
        if (released) { await openedOuter.close(); throw stale(); }
        outer = openedOuter;
        guard();
        if (outer.source !== 'outer' || outer.docKey !== pdfDocKey({ ...token, source: 'outer' })) throw new Error('Invalid outer PDF lease');
        const inspection: PdfInkInspection = await outer.request('doc.inspectInk', {}, { priority: 0, signal: lifetime });
        guard();
        if (inspection.kind === 'read-only') {
            if (inspection.reason !== 'notebook-source') return await readOnly(inspection.reason === 'unsafe-policy'
                ? 'The PDF write safety could not be established; annotation is read-only.' : `PDF ink is read-only: ${inspection.reason}.`);
            const outerFingerprint = await chunkedBlobSha256(options.outer, guard);
            guard();
            if (outerFingerprint !== inspection.outerFingerprint) return await readOnly('The PDF source fingerprint does not match the inspected bytes.');
            return await readOnly('This PDF was exported from a notebook.', { notebookSource: Object.freeze({ ...inspection.notebookSource }), outerFingerprint });
        }
        if ((inspection.kind !== 'plain' && inspection.kind !== 'native') || inspection.formatId !== NATIVE_FORMAT_ID || inspection.writeSafety?.kind !== 'safe' ||
            !memoryBlob(inspection.pristine) || !HASH.test(inspection.outerFingerprint) || !HASH.test(inspection.pristineFingerprint) ||
            (inspection.kind === 'plain' && (inspection.board !== null || inspection.media.length !== 0)) ||
            (inspection.kind === 'native' && (!memoryBlob(inspection.board) || !/^[0-9a-f]{32}$/.test(inspection.writeId)))) {
            return await readOnly('The PDF ink source could not be safely verified.');
        }
        const outerHash = await chunkedBlobSha256(options.outer, guard);
        guard();
        const pristineHash = await chunkedBlobSha256(inspection.pristine, guard);
        guard();
        if (outerHash !== inspection.outerFingerprint || pristineHash !== inspection.pristineFingerprint ||
            (inspection.kind === 'plain' && outerHash !== pristineHash)) {
            return await readOnly('The PDF source fingerprint does not match the inspected bytes.');
        }
        const media = new Map<string, string>();
        for (const entry of inspection.media) {
            const match = MEDIA.exec(entry.name);
            if (!match || entry.sha256 !== match[1] || entry.size !== null || media.has(entry.name)) {
                return await readOnly('The PDF ink media inventory could not be verified.');
            }
            media.set(entry.name, entry.sha256);
        }
        if (inspection.kind === 'native') {
            try { await validateBoardWriteIdentity(inspection.board, NATIVE_FORMAT_ID, inspection.writeId, async () => guard()); }
            catch { guard(); return await readOnly('The PDF ink board identity could not be verified.'); }
            guard();
        }
        const outerReason = policyReason(outer);
        if (outerReason) return await readOnly(outerReason);
        const openedOriginal = await pool.open({ token, source: 'original', blob: inspection.pristine, priority: 0, signal: lifetime });
        openedOriginal.setVisible(false);
        if (released) { await openedOriginal.close(); throw stale(); }
        original = openedOriginal;
        guard();
        if (original.source !== 'original' || original.docKey !== pdfDocKey({ ...token, source: 'original' })) throw new Error('Invalid original PDF lease');
        // A same-size original lease may already exist for this key; geometry must come
        // from the inspected pristine bytes, not merely from an equal-length snapshot.
        const originalInspection = await original.request('doc.inspectInk', {}, { priority: 0, signal: lifetime });
        guard();
        if (originalInspection.kind !== 'plain' || originalInspection.writeSafety?.kind !== 'safe' || originalInspection.outerFingerprint !== pristineHash ||
            originalInspection.pristineFingerprint !== pristineHash) {
            return await readOnly('The retained pristine PDF does not match the inspected source.');
        }
        const originalReason = policyReason(original);
        if (originalReason) return await readOnly(originalReason);
        if (outer.info.pageCount !== original.info.pageCount) return await readOnly('The PDF ink source pages do not match the displayed PDF.');
        const pages: Readonly<PageGeometry>[] = [];
        for (let page = 0; page < original.info.pageCount; page++) {
            const visible = await outer.resolveGeometry(page, { priority: 0, signal: lifetime });
            guard();
            const pristine = await original.resolveGeometry(page, { priority: 0, signal: lifetime });
            guard();
            if (!matchingGeometry(visible, pristine)) return await readOnly('The PDF ink source geometry does not match the displayed PDF.');
            pages.push(Object.freeze({ ...pristine, toUserSpace: Object.freeze([...pristine.toUserSpace]) as PageGeometry['toUserSpace'] }));
        }
        const geometryEngine = pool.geometryEngine;
        guard();
        const source: WriterSource = Object.freeze({ token, docKey: original.docKey, pristine: inspection.pristine,
            pristineFingerprint: pristineHash, outer: options.outer, outerFingerprint: outerHash,
            formatId: NATIVE_FORMAT_ID, geometryEngine });
        const retainedOuter = outer;
        return {
            ...(inspection.kind === 'native' ? { kind: 'native' as const, board: inspection.board, writeId: inspection.writeId } : { kind: 'plain' as const, board: null }),
            source, writeSafety: Object.freeze({ ...inspection.writeSafety }), pages: Object.freeze(pages), isCurrent: current, release,
            async readMedia(name, signal) {
                guard();
                const expected = media.get(name);
                if (!expected) throw new Error('PDF ink media is not in the inspected inventory');
                const requestSignal = AbortSignal.any([lifetime, ...(signal ? [signal] : [])]);
                requestSignal.throwIfAborted();
                const blob = await retainedOuter.request('doc.inkMedia', { name, outerFingerprint: outerHash }, { priority: 1, signal: requestSignal });
                guard(); requestSignal.throwIfAborted();
                if (!(blob instanceof Blob) || (typeof File !== 'undefined' && blob instanceof File) || blob.size >= 0x80000000) throw new Error('Invalid PDF ink media');
                const actual = await chunkedBlobSha256(blob, () => { guard(); requestSignal.throwIfAborted(); });
                guard(); requestSignal.throwIfAborted();
                if (actual !== expected) throw new Error('PDF ink media fingerprint mismatch');
                return blob;
            },
            async createBackdrop(viewOptions) {
                guard();
                const signal = AbortSignal.any([lifetime, ...(viewOptions.signal ? [viewOptions.signal] : [])]);
                signal.throwIfAborted();
                const view = await createPdfInkBackdrop({ ...viewOptions, pool, source, isCurrent: current, signal });
                try { guard(); signal.throwIfAborted(); return view; }
                catch (error) { view.dispose(); throw error; }
            },
            async openWriter(signal) {
                guard();
                const requestSignal = AbortSignal.any([lifetime, ...(signal ? [signal] : [])]);
                requestSignal.throwIfAborted();
                const writer = await pool.writer({ signal: requestSignal });
                try { guard(); requestSignal.throwIfAborted(); return typedPdfWriter(writer); }
                catch (error) { await writer.close(); throw error; }
            },
        };
    } catch (error) {
        const wasCurrent = current();
        await release();
        if (!wasCurrent || !callerCurrent()) throw stale();
        return { kind: 'read-only', reason: 'The PDF ink source could not be safely acquired.', release };
    }
}
