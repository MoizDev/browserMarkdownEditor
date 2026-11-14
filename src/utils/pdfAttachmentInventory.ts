// Read-only and worker-only. pdf.js's public attachment map selects a branch
// and collapses duplicate names: neither behaviour can authorize replacing pages.
import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream } from 'pdf-lib';
import { attachmentText, boundedAttachmentBytes, inventoryAttachments, type AttachmentEntry } from './pdfAttachmentTree';
import { BOARD_ATTACHMENT, NOTEBOOK_SOURCE_ATTACHMENT, ORIGINAL_ATTACHMENT, PDF_APP_MARKER_NAMESPACE, SNAPSHOT_ATTACHMENT } from './pdfFormat';
import { compatibleLegacySnapshot, PDF_EDITABLE_JSON_LIMIT, PDF_PRISTINE_LIMIT } from './pdfRole';
import type { PdfRole, PdfRoleFailure } from './pdfRole';
import { checkPdfWriteMark } from './pdfWriteMark';

type Entry = AttachmentEntry;
const key = PDFName.of;

export async function inspectPdfRole(bytes: Uint8Array, generation: string): Promise<PdfRole> {
    const unreadable = (attachment: string, reason: PdfRoleFailure, detail?: string, attachmentId?: string): PdfRole => ({ kind: 'unreadable', alreadyAnnotated: true, generation, attachment, attachmentId, reason, detail });
    try {
        const doc = await PDFDocument.load(bytes, { parseSpeed: Infinity, updateMetadata: false });
        if (doc.isEncrypted) return unreadable('PDF', 'encrypted');
        const all = inventoryAttachments(doc);
        const has = (entry: Entry, name: string) => entry.keys.length
            ? entry.keys.some(value => value.decodeText() === name)
            : entry.names.has(name);
        // Filespec /Desc and EmbeddedFile /Params/LocalVaultMarker are equal
        // authorities: PDFium's public attachment API writes only the latter.
        const declarations = new Map<Entry, { value?: string; conflict: boolean; invalid: boolean }>();
        for (const entry of all) {
            const desc = entry.description.startsWith(PDF_APP_MARKER_NAMESPACE) ? entry.description.split('\n', 1)[0] : undefined;
            const ef = entry.spec.lookup(key('EF'));
            const streams = ef instanceof PDFDict ? [ef.lookup(key('F')), ef.lookup(key('UF'))] : [];
            let param: string | undefined, invalid = false, conflict = false;
            for (const stream of streams) {
                if (!(stream instanceof PDFRawStream)) continue;
                const params = stream.dict.lookup(key('Params'));
                if (!(params instanceof PDFDict)) continue;
                const raw = params.lookup(key('LocalVaultMarker'));
                if (raw === undefined) continue;
                const value = attachmentText(raw);
                if (value === undefined) invalid = true;
                else if (param !== undefined && param !== value) conflict = true;
                else param = value;
            }
            if (desc !== undefined && param !== undefined && desc !== param) conflict = true;
            declarations.set(entry, { value: desc ?? param, conflict, invalid });
        }
        const conflicting = all.filter(entry => declarations.get(entry)!.conflict);
        if (conflicting.length) return { kind: 'ambiguous', alreadyAnnotated: true, generation, candidates: conflicting.map(entry => entry.id) };
        const marker = (entry: Entry, name: string, role: string, format: string) => {
            const prefix = `local-vault-pdf/v1;role=${role};format=${format}`;
            return entry.keys.length <= 1 && has(entry, name) && prefix.length <= 256 && declarations.get(entry)!.value === prefix;
        };
        const newer = all.filter(entry => has(entry, BOARD_ATTACHMENT) || (declarations.get(entry)!.value !== undefined || declarations.get(entry)!.invalid) &&
            !marker(entry, NOTEBOOK_SOURCE_ATTACHMENT, 'notebook-source', 'notebook-source') &&
            !marker(entry, ORIGINAL_ATTACHMENT, 'pristine', 'tldraw-legacy') &&
            !marker(entry, SNAPSHOT_ATTACHMENT, 'editable', 'tldraw-legacy'));
        if (newer.length) return { kind: 'newer', generation, alreadyAnnotated: true, attachments: newer.flatMap(entry => entry.names.size ? [...entry.names] : [entry.id]) };
        const originals = all.filter(entry => has(entry, ORIGINAL_ATTACHMENT));
        const snapshots = all.filter(entry => has(entry, SNAPSHOT_ATTACHMENT));
        const notebooks = all.filter(entry => has(entry, NOTEBOOK_SOURCE_ATTACHMENT));
        const authority = [...originals, ...snapshots, ...notebooks];
        if (originals.length > 1 || snapshots.length > 1 || notebooks.length > 1 || new Set(authority).size !== authority.length || authority.some(entry => entry.keys.length > 1) || notebooks.length && (originals.length || snapshots.length)) {
            return { kind: 'ambiguous', alreadyAnnotated: true, generation, candidates: authority.map(entry => entry.id) };
        }
        function content(entry: Entry, limit: number): Uint8Array | PdfRole {
            const failure = (reason: PdfRoleFailure, detail?: string) => unreadable([...entry.names].join(', '), reason, detail, entry.id);
            try {
                const ef = entry.spec.lookup(key('EF'));
                if (!(ef instanceof PDFDict)) return failure('null');
                const unicode = ef.lookup(key('UF')), fallback = ef.lookup(key('F'));
                if (unicode !== undefined && fallback !== undefined && unicode !== fallback) return { kind: 'ambiguous', generation, alreadyAnnotated: true, candidates: [entry.id + '/EF/UF', entry.id + '/EF/F'] };
                const f = unicode ?? fallback;
                if (!(f instanceof PDFRawStream)) return failure('null');
                const params = f.dict.lookup(key('Params'));
                const declared = params instanceof PDFDict ? params.lookup(key('Size')) : undefined;
                if (declared instanceof PDFNumber && declared.asNumber() > limit) return failure('limit', `${limit} bytes`);
                // Read at most limit+1 even when /Size lies. Stream decoding is
                // isolated here; a bad filter cannot become an absent source.
                return boundedAttachmentBytes(f, limit);
            } catch (error) {
                return error instanceof Error && error.message.includes('size limit') ? failure('limit', `${limit} bytes`) : failure('corrupt');
            }
        }
        if (notebooks.length) {
            const raw = content(notebooks[0], PDF_EDITABLE_JSON_LIMIT);
            if (!(raw instanceof Uint8Array)) return raw;
            try {
                const pointer = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as { path?: unknown; exportedAt?: unknown };
                if (typeof pointer.path !== 'string' || !pointer.path || pointer.path.startsWith('/') || pointer.path.split('/').some(p => p === '.' || p === '..' || !p)) return unreadable(NOTEBOOK_SOURCE_ATTACHMENT, 'corrupt');
                return { kind: 'notebookExport', generation, alreadyAnnotated: true, notebookSource: { path: pointer.path, exportedAt: typeof pointer.exportedAt === 'number' && Number.isFinite(pointer.exportedAt) ? pointer.exportedAt : 0 } };
            } catch { return unreadable(NOTEBOOK_SOURCE_ATTACHMENT, 'corrupt'); }
        }
        if (!originals.length && !snapshots.length) return { kind: 'plain', generation, alreadyAnnotated: false, original: bytes, snapshot: '', notebookSource: null };
        if (!originals.length || !snapshots.length) return unreadable(!snapshots.length ? SNAPSHOT_ATTACHMENT : ORIGINAL_ATTACHMENT, 'missing');
        const markedOriginal = marker(originals[0], ORIGINAL_ATTACHMENT, 'pristine', 'tldraw-legacy');
        const markedSnapshot = marker(snapshots[0], SNAPSHOT_ATTACHMENT, 'editable', 'tldraw-legacy');
        if (markedOriginal !== markedSnapshot) return { kind: 'newer', generation, alreadyAnnotated: true, attachments: [ORIGINAL_ATTACHMENT, SNAPSHOT_ATTACHMENT] };
        const original = content(originals[0], PDF_PRISTINE_LIMIT);
        if (!(original instanceof Uint8Array)) return original;
        const raw = content(snapshots[0], PDF_EDITABLE_JSON_LIMIT);
        if (!(raw instanceof Uint8Array)) return raw;
        let snapshot: string;
        try {
            snapshot = new TextDecoder('utf-8', { fatal: true }).decode(raw);
            if (!compatibleLegacySnapshot(JSON.parse(snapshot))) return unreadable(SNAPSHOT_ATTACHMENT, 'schema', undefined, snapshots[0].id);
        } catch { return unreadable(SNAPSHOT_ATTACHMENT, 'corrupt', undefined, snapshots[0].id); }
        try {
            const pristine = await PDFDocument.load(original, { parseSpeed: Infinity, updateMetadata: false });
            if (!pristine.getPageCount()) return unreadable(ORIGINAL_ATTACHMENT, 'corrupt', undefined, originals[0].id);
        } catch { return unreadable(ORIGINAL_ATTACHMENT, 'corrupt', undefined, originals[0].id); }
        const mark = await checkPdfWriteMark(bytes);
        // A board-bound v2 mark is not authority for a legacy-only snapshot.
        const writeMark = mark.kind === 'verified' && mark.writeId
            ? { kind: 'foreign' as const, reason: 'unsupported' as const } : mark;
        return { kind: 'annotated', generation, alreadyAnnotated: true, original, snapshot, notebookSource: null, writeMark };
    } catch (error) {
        return unreadable('attachment inventory', error instanceof Error && error.message.toLowerCase().includes('encrypted') ? 'encrypted' : 'corrupt');
    }
}
