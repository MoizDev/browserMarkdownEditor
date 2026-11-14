import { Sha256 } from '../../utils/sha256';
import { tiledPdfCapabilities } from '../../utils/pdfCapabilities';
import { NATIVE_FORMAT_ID } from '../../whiteboard/format/identity';
import type { PageGeometry } from '../../platform/types';
import type { PdfPoolDocument } from '../pool/types';
import { pdfDocKey } from '../worker/protocol';
import type { WriterSource } from '../writing/protocol';
import { typedPdfWriter } from '../writing/writerClient';
import { getSharedPdfPool } from './startup';
import { createPdfInkBackdrop } from './inkBackdrop';
import { createPdfInkPreviewHost } from './inkPreviewHost';
import type { PdfLegacyInkAcquisition, PdfLegacyInkAcquisitionOptions, PdfLegacyConversionReady, PdfLegacyPrepareOptions } from './legacyInkAcquisition.types';

const prepared = new WeakSet<PdfLegacyConversionReady>();
/** Only the admission/backup path can mint a conversion capability. */
export function isPreparedPdfLegacyConversion(value: PdfLegacyConversionReady): boolean { return prepared.has(value); }
const stale = () => new DOMException('PDF legacy source is no longer current', 'AbortError');
const memoryBlob = (value: unknown): value is Blob => value instanceof Blob &&
    !(typeof File !== 'undefined' && value instanceof File) && value.size > 0 && value.size < 0x80000000;
async function hash(blob: Blob, guard: () => void): Promise<string> {
    const digest = new Sha256();
    for (let offset = 0; offset < blob.size; offset += 1024 * 1024) {
        guard(); const bytes = await blob.slice(offset, offset + 1024 * 1024).arrayBuffer(); guard(); digest.update(new Uint8Array(bytes));
    }
    guard(); return digest.digest();
}
function policy(doc: PdfPoolDocument): string | null {
    const cap = tiledPdfCapabilities(doc.info);
    if (cap.encrypted !== false) return 'Encrypted PDFs cannot be converted.';
    if (cap.signed !== false) return 'PDF signatures could not be ruled out.';
    return cap.render === true && cap.copy === true && cap.capture === true && cap.write === true ? null : 'PDF permissions or write safety could not be established.';
}
function samePage(a: Readonly<PageGeometry>, b: Readonly<PageGeometry>): boolean {
    return a.index === b.index && a.width === b.width && a.height === b.height && a.rotate === b.rotate && a.userUnit === b.userUnit &&
        a.toUserSpace.length === 6 && b.toUserSpace.length === 6 && a.toUserSpace.every((n, i) => n === b.toUserSpace[i]);
}

/** Explicit conversion capability. No writer, editor or empty board is exposed by inspection. */
export async function acquireLegacyPdfInkCandidate(options: PdfLegacyInkAcquisitionOptions): Promise<PdfLegacyInkAcquisition> {
    if (!memoryBlob(options.outer)) throw new RangeError('PDF conversion requires a nonempty memory-backed Blob below 2 GiB');
    const token = Object.freeze({ ...options.token }), controller = new AbortController();
    const lifetime = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])]);
    let outer: PdfPoolDocument | undefined, original: PdfPoolDocument | undefined, released = false, releasePromise: Promise<void> | undefined;
    const callerCurrent = () => { if (options.signal?.aborted) return false; try { return options.isCurrent(); } catch { return false; } };
    const current = () => !released && !lifetime.aborted && !outer?.closed && !original?.closed && callerCurrent();
    const guard = () => { if (!current()) throw stale(); };
    const release = (): Promise<void> => {
        if (releasePromise) return releasePromise;
        released = true; controller.abort(); options.signal?.removeEventListener('abort', onAbort);
        releasePromise = Promise.allSettled([original?.close(), outer?.close()]).then(() => {}); return releasePromise;
    };
    const onAbort = () => { void release(); };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const refused = async (reason: string): Promise<PdfLegacyInkAcquisition> => {
        guard(); await release(); if (!callerCurrent()) throw stale(); return { kind: 'read-only', reason, release };
    };
    try {
        guard(); const pool = options.pool ?? await getSharedPdfPool(); guard();
        const openedOuter = await pool.open({ token, source: 'outer', blob: options.outer, priority: 0, signal: lifetime });
        openedOuter.setVisible(false);
        if (released) { await openedOuter.close(); throw stale(); }
        outer = openedOuter; guard();
        if (outer.source !== 'outer' || outer.docKey !== pdfDocKey({ ...token, source: 'outer' })) throw new Error('Invalid outer PDF lease');
        const inspected = await outer.request('doc.inspectLegacyInk', {}, { priority: 0, signal: lifetime }); guard();
        if (inspected.kind === 'not-legacy') { await release(); if (!callerCurrent()) throw stale(); return { kind: 'not-legacy', release }; }
        if (inspected.kind === 'read-only') return await refused(`PDF conversion is read-only: ${inspected.reason}.`);
        if (inspected.writeSafety?.kind !== 'safe' || !memoryBlob(inspected.pristine) || !memoryBlob(inspected.snapshot) || inspected.snapshot.size > 32 * 1024 * 1024 ||
            !/^[0-9a-f]{64}$/.test(inspected.outerFingerprint) || !/^[0-9a-f]{64}$/.test(inspected.pristineFingerprint) ||
            inspected.writeMark.kind === 'verified' && inspected.writeMark.writeId !== undefined) return await refused('The legacy PDF source could not be verified.');
        const outerHash = await hash(options.outer, guard), pristineHash = await hash(inspected.pristine, guard);
        if (outerHash !== inspected.outerFingerprint || pristineHash !== inspected.pristineFingerprint) return await refused('The legacy PDF fingerprint does not match the inspected bytes.');
        const outerPolicy = policy(outer); if (outerPolicy) return await refused(outerPolicy);
        const openedOriginal = await pool.open({ token, source: 'original', blob: inspected.pristine, priority: 0, signal: lifetime });
        openedOriginal.setVisible(false);
        if (released) { await openedOriginal.close(); throw stale(); }
        original = openedOriginal; guard();
        if (original.source !== 'original' || original.docKey !== pdfDocKey({ ...token, source: 'original' })) throw new Error('Invalid original PDF lease');
        const originalInspection = await original.request('doc.inspectInk', {}, { priority: 0, signal: lifetime }); guard();
        if (originalInspection.kind !== 'plain' || originalInspection.writeSafety?.kind !== 'safe' ||
            originalInspection.outerFingerprint !== pristineHash || originalInspection.pristineFingerprint !== pristineHash) {
            return await refused('The retained pristine PDF does not match the inspected source.');
        }
        const originalPolicy = policy(original); if (originalPolicy) return await refused(originalPolicy);
        if (outer.info.pageCount !== original.info.pageCount) return await refused('The legacy PDF pages do not match the pristine source.');
        const pages: Readonly<PageGeometry>[] = [];
        for (let page = 0; page < original.info.pageCount; page++) {
            const visible = await outer.resolveGeometry(page, { priority: 0, signal: lifetime }); guard();
            const pristine = await original.resolveGeometry(page, { priority: 0, signal: lifetime }); guard();
            if (!samePage(visible, pristine)) return await refused('The legacy PDF geometry does not match the pristine source.');
            pages.push(Object.freeze({ ...pristine, toUserSpace: Object.freeze([...pristine.toUserSpace]) as PageGeometry['toUserSpace'] }));
        }
        const geometryEngine = pool.geometryEngine; guard();
        const source: WriterSource = Object.freeze({ token, docKey: original.docKey, pristine: inspected.pristine, pristineFingerprint: pristineHash,
            outer: options.outer, outerFingerprint: outerHash, formatId: NATIVE_FORMAT_ID, geometryEngine });
        const frozenPages = Object.freeze(pages), mark = Object.freeze({ ...inspected.writeMark }), writeSafety = Object.freeze({ ...inspected.writeSafety });
        let preparation: Promise<PdfLegacyConversionReady> | undefined;
        const prepare = (admission: PdfLegacyPrepareOptions): Promise<PdfLegacyConversionReady> => {
            guard(); admission.assertRenderable(); guard();
            if (preparation) return preparation;
            const ready = (async () => {
                const check = () => { guard(); admission.assertRenderable(); guard(); };
                check();
                if (mark.kind === 'foreign') {
                    const accepted = await admission.confirmForeignMark(mark, lifetime); check();
                    if (accepted !== true) throw new DOMException('Legacy PDF conversion was not confirmed', 'NotAllowedError');
                }
                check();
                const backup = await admission.keepConversionBackup(options.outer, outerHash, lifetime); check();
                if (!backup || backup.kind !== 'file' || backup.handle?.kind !== 'file' || backup.parentHandle?.kind !== 'directory' ||
                    typeof backup.sourcePath !== 'string' || !backup.sourcePath.split('/').includes('.Garbage') || backup.size !== options.outer.size) {
                    throw new Error('A real legacy PDF conversion backup is required');
                }
                const result = { kind: 'legacy-conversion' as const, source, snapshot: inspected.snapshot, pages: frozenPages, writeMark: mark, writeSafety,
                    legacyOriginalSha256: outerHash, backup, isCurrent: current, release,
                    async openWriter(signal?: AbortSignal) {
                        check(); const requestSignal = AbortSignal.any([lifetime, ...(signal ? [signal] : [])]); requestSignal.throwIfAborted();
                        const writer = await pool.writer({ signal: requestSignal });
                        try { check(); requestSignal.throwIfAborted(); return typedPdfWriter(writer); }
                        catch (error) { await writer.close(); throw error; }
                    },
                    async createBackdrop(viewOptions) {
                        check(); const signal = AbortSignal.any([lifetime, ...(viewOptions.signal ? [viewOptions.signal] : [])]); signal.throwIfAborted();
                        const view = await createPdfInkBackdrop({ ...viewOptions, pool, source, isCurrent: current, signal });
                        try { check(); signal.throwIfAborted(); return view; } catch (error) { view.dispose(); throw error; }
                    } } satisfies PdfLegacyConversionReady;
                prepared.add(result);
                return Object.freeze(result);
            })();
            preparation = ready;
            void ready.catch(() => { if (preparation === ready) preparation = undefined; });
            return ready;
        };
        return { kind: 'conversion-required', snapshot: inspected.snapshot, pages: frozenPages, writeMark: mark, writeSafety,
            legacyOriginalSha256: outerHash, createPreviewHost: () => createPdfInkPreviewHost({ pristineFingerprint: source.pristineFingerprint,
                geometryEngine: source.geometryEngine, pages: frozenPages, isCurrent: current }), prepare, isCurrent: current, release };
    } catch {
        const wasCurrent = current(); await release(); if (!wasCurrent || !callerCurrent()) throw stale();
        return { kind: 'read-only', reason: 'The legacy PDF source could not be safely acquired.', release };
    }
}
