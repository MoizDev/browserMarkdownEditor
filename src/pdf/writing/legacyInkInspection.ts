import { inspectPdfRole } from '../../utils/pdfAttachmentInventory';
import { PDF_EDITABLE_JSON_LIMIT } from '../../utils/pdfRole';
import { Sha256 } from '../../utils/sha256';
import type { PdfLegacyInspection } from './legacyInkInspection.types';

async function fingerprint(bytes: Uint8Array, cooperate: () => Promise<void>): Promise<string> {
    const digest = new Sha256();
    for (let at = 0; at < bytes.length; at += 1024 * 1024) {
        await cooperate(); digest.update(bytes.subarray(at, at + 1024 * 1024));
    }
    return digest.digest();
}

/** Explicit legacy conversion inspection, never an editable-source fallback. */
export async function inspectLegacyPdfInk(blob: Blob, cooperate: () => Promise<void>): Promise<PdfLegacyInspection> {
    if (!(blob instanceof Blob) || typeof File !== 'undefined' && blob instanceof File || blob.size < 1 || blob.size > 0x7fffffff) {
        return { kind: 'read-only', reason: 'invalid-source' };
    }
    await cooperate();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await cooperate();
    const role = await inspectPdfRole(bytes, 'legacy-inspection');
    await cooperate();
    if (role.writeSafety?.kind !== 'safe') return { kind: 'read-only', reason: role.writeSafety?.kind === 'signed' ? 'signed' :
        role.writeSafety?.kind === 'encrypted' ? 'encrypted' : 'unsupported' };
    if (role.kind === 'plain' || role.kind === 'notebookExport') return { kind: 'not-legacy' };
    if (role.kind === 'ambiguous') return { kind: 'read-only', reason: 'ambiguous' };
    if (role.kind === 'newer') return { kind: 'read-only', reason: 'unsupported' };
    if (role.kind === 'unreadable') return { kind: 'read-only', reason: role.reason === 'encrypted' ? 'encrypted' : 'unreadable' };
    const snapshot = new TextEncoder().encode(role.snapshot);
    if (!role.original.length || !snapshot.length || snapshot.length > PDF_EDITABLE_JSON_LIMIT) return { kind: 'read-only', reason: 'unreadable' };
    const outerFingerprint = await fingerprint(bytes, cooperate);
    const pristineFingerprint = await fingerprint(role.original, cooperate);
    await cooperate();
    return { kind: 'legacy', pristine: new Blob([new Uint8Array(role.original)], { type: 'application/pdf' }), pristineFingerprint,
        outerFingerprint, snapshot: new Blob([snapshot], { type: 'application/json' }), writeMark: role.writeMark, writeSafety: { ...role.writeSafety } };
}
