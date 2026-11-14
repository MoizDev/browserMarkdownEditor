import type { PageGeometry } from '../../platform/types';
import { NATIVE_FORMAT_ID } from '../format/identity';
import type { PinnedPdfAssembly } from './saveBuildTypes';
import { pdfBoardAttachments, pdfInkReservedNames } from './pdfAttachments';
import { pdfInkPages } from './pdfInkExport';
import type { OpenPdfInkWriter, PinnedPdfInkSnapshot } from './pdfInkAssemblyTypes';

function sameGeometry(a: PageGeometry, b: PageGeometry): boolean {
    return a.index === b.index && a.width === b.width && a.height === b.height && a.rotate === b.rotate
        && a.userUnit === b.userUnit && a.toUserSpace.every((value, i) => value === b.toUserSpace[i]);
}

/** Stage every physical page from pristine bytes, preserving the outer attachment inventory.
 * The PDF writer returns bytes only; App alone authorizes and performs the versioned write. */
export function pinPdfInkAssembly(snapshot: PinnedPdfInkSnapshot, openWriter: OpenPdfInkWriter): PinnedPdfAssembly {
    if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || !/^[0-9a-f]{32}$/u.test(snapshot.writeId)
        || snapshot.source.formatId !== NATIVE_FORMAT_ID || !/^[0-9a-f]{64}$/u.test(snapshot.source.pristineFingerprint)
        || !/^[0-9a-f]{64}$/u.test(snapshot.source.outerFingerprint)
        || !(snapshot.source.pristine instanceof Blob) || !(snapshot.source.outer instanceof Blob)
        || (typeof File !== 'undefined' && (snapshot.source.pristine instanceof File || snapshot.source.outer instanceof File))) {
        throw new Error('Invalid pinned PDF source');
    }
    let released = false;
    const check = (signal: AbortSignal) => {
        signal.throwIfAborted();
        if (released || !snapshot.isCurrent()) throw new DOMException('PDF board session ended', 'AbortError');
    };
    return {
        async assemble(board, signal) {
            check(signal);
            const writer = await openWriter(signal);
            try {
                check(signal);
                const request = { priority: 0 as const, signal };
                const prepared = await writer.request('writer.prepareSource', { source: snapshot.source }, request);
                check(signal);
                const geometries = [...snapshot.ink.pages];
                if (prepared.sourceFingerprint !== snapshot.source.pristineFingerprint || prepared.inspection.encrypted || prepared.inspection.signed
                    || prepared.inspection.pageCount !== geometries.length || prepared.inspection.geometries.length !== geometries.length
                    || geometries.some((page, i) => !sameGeometry(page, prepared.inspection.geometries[i]))) {
                    throw new Error('PDF source or page geometry changed');
                }
                const pages = await pdfInkPages(snapshot.ink, signal);
                check(signal);
                const ink = await writer.request('writer.emitInk', { revision: snapshot.revision, displayListSchema: 1, pages }, request);
                check(signal);
                const stage = await writer.request('writer.stageAnnotated', { writerSession: prepared.writerSession,
                    revision: snapshot.revision, ink, geometries, reservedNames: pdfInkReservedNames(snapshot.media) }, request);
                check(signal);
                if (stage.sourceFingerprint !== snapshot.source.pristineFingerprint) throw new Error('PDF writer staged a different source');
                const bytes = board instanceof Blob ? new Uint8Array(await board.arrayBuffer()) : board;
                check(signal);
                const attachments = await pdfBoardAttachments(bytes, snapshot.media, id => snapshot.mediaBlob(id), signal);
                check(signal);
                const result = await writer.request('writer.finishAnnotated', { stageId: stage.stageId, revision: snapshot.revision,
                    attachments, writeId: snapshot.writeId }, request);
                check(signal);
                if (result.revision !== snapshot.revision || result.writeId !== snapshot.writeId
                    || result.sourceFingerprint !== snapshot.source.pristineFingerprint || result.verification.writeMark !== 'verified') {
                    throw new Error('PDF writer returned a different revision or source');
                }
                return new Uint8Array(result.bytes);
            } finally { await writer.close(); }
        },
        release() { if (!released) { released = true; snapshot.release(); } },
    };
}
