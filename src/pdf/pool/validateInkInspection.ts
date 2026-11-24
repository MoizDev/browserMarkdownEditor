import { PDF_INK_INSPECTION_ERROR_CLASSES, PDF_INK_INSPECTION_PHASES } from '../writing/inkInspection.types';
import type { PdfInkInspection, PdfInkInspectionErrorClass, PdfInkInspectionFailure, PdfInkInspectionPhase, PdfInkMediaDescriptor } from '../writing/inkInspection.types';
import { invalidPdfReply, record, text } from './validationCommon';
import { validNotebookSourcePath } from '../writing/notebookPointer';

const LIMIT = 0x7fffffff, BOARD_LIMIT = 32 * 1024 * 1024;
const HASH = /^[0-9a-f]{64}$/, ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MEDIA = /^board-media\/([0-9a-f]{64})\.[a-zA-Z0-9]{1,16}$/;
const REASONS: readonly PdfInkInspectionFailure[] = ['invalid-source', 'encrypted', 'signed', 'unreadable', 'ambiguous',
    'unsupported-format', 'missing-attachment', 'invalid-marker', 'invalid-write-mark', 'nested-source', 'resource-limit', 'unsafe-policy'];
function hash(value: unknown): string { const result = text(value, 64); if (!HASH.test(result)) invalidPdfReply(); return result; }
function blob(value: unknown, max: number, empty: boolean): Blob {
    if (!(value instanceof Blob) || typeof File !== 'undefined' && value instanceof File || value.size > max || !empty && value.size < 1) invalidPdfReply();
    return value.slice(0, value.size, value.type);
}
export function validatePdfInkInspection(value: unknown): PdfInkInspection {
    const top = record(value, ['kind', 'reason', 'id', 'outerFingerprint', 'pristine', 'pristineFingerprint', 'board', 'media', 'writeId', 'formatId', 'notebookSource', 'writeSafety', 'phase', 'errorClass']);
    if (top.kind === 'read-only') {
        if (top.reason === 'notebook-source') {
            record(value, ['kind', 'reason', 'outerFingerprint', 'notebookSource']);
            const pointer = record(top.notebookSource, ['path', 'exportedAt']), path = text(pointer.path, 4096);
            if (!validNotebookSourcePath(path) || (pointer.exportedAt !== undefined &&
                (typeof pointer.exportedAt !== 'number' || !Number.isFinite(pointer.exportedAt) || pointer.exportedAt < 0))) invalidPdfReply();
            return { kind: 'read-only', reason: 'notebook-source', outerFingerprint: hash(top.outerFingerprint),
                notebookSource: { path, ...(pointer.exportedAt !== undefined ? { exportedAt: pointer.exportedAt as number } : {}) } };
        }
        if (top.reason === 'inspection-failed') {
            record(value, ['kind', 'reason', 'phase', 'errorClass']);
            if (typeof top.phase !== 'string' || !PDF_INK_INSPECTION_PHASES.includes(top.phase as PdfInkInspectionPhase) ||
                typeof top.errorClass !== 'string' || !PDF_INK_INSPECTION_ERROR_CLASSES.includes(top.errorClass as PdfInkInspectionErrorClass)) invalidPdfReply();
            return { kind: 'read-only', reason: 'inspection-failed', phase: top.phase as PdfInkInspectionPhase, errorClass: top.errorClass as PdfInkInspectionErrorClass };
        }
        record(value, ['kind', 'reason']);
        if (typeof top.reason !== 'string' || !REASONS.includes(top.reason as PdfInkInspectionFailure)) invalidPdfReply();
        return { kind: 'read-only', reason: top.reason as PdfInkInspectionFailure };
    }
    if (top.kind !== 'plain' && top.kind !== 'native') invalidPdfReply();
    record(value, top.kind === 'plain' ? ['kind', 'id', 'outerFingerprint', 'pristine', 'pristineFingerprint', 'board', 'media', 'formatId', 'writeSafety'] :
        ['kind', 'id', 'outerFingerprint', 'pristine', 'pristineFingerprint', 'board', 'media', 'writeId', 'formatId', 'writeSafety']);
    const safety = record(top.writeSafety, ['kind']);
    if (safety.kind !== 'safe') invalidPdfReply();
    const writeSafety = { kind: 'safe' } as const;
    const id = text(top.id, 36);
    if (!ID.test(id) || top.formatId !== 'board' || !Array.isArray(top.media) || top.media.length > 10_000) invalidPdfReply();
    const outerFingerprint = hash(top.outerFingerprint), pristineFingerprint = hash(top.pristineFingerprint), pristine = blob(top.pristine, LIMIT, false);
    if (top.kind === 'plain') {
        if (top.board !== null || top.media.length || outerFingerprint !== pristineFingerprint) invalidPdfReply();
        return { kind: 'plain', id, outerFingerprint, pristine, pristineFingerprint, board: null, media: [], formatId: 'board', writeSafety };
    }
    const board = blob(top.board, BOARD_LIMIT, false), writeId = text(top.writeId, 32);
    if (!/^[0-9a-f]{32}$/.test(writeId)) invalidPdfReply();
    const seen = new Set<string>();
    const media: PdfInkMediaDescriptor[] = top.media.map(item => {
        const o = record(item, ['name', 'size', 'sha256']), name = text(o.name, 1024), match = MEDIA.exec(name), sha256 = hash(o.sha256);
        if (!match || match[1] !== sha256 || o.size !== null || seen.has(name)) invalidPdfReply();
        seen.add(name); return { name, size: null, sha256 };
    });
    return { kind: 'native', id, outerFingerprint, pristine, pristineFingerprint, board, writeId, media, formatId: 'board', writeSafety };
}
/** Media bytes are immutable and only acquired by a separately authorised name request. */
export function validatePdfInkMedia(value: unknown): Blob { return blob(value, LIMIT, true); }
