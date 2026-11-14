// Read-only and worker-only. pdf.js's public attachment map selects a branch
// and collapses duplicate names: neither behaviour can authorize replacing pages.
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFString, decodePDFRawStream } from 'pdf-lib';
import type { PDFObject } from 'pdf-lib';
import { BOARD_ATTACHMENT, NOTEBOOK_SOURCE_ATTACHMENT, ORIGINAL_ATTACHMENT, PDF_APP_MARKER_NAMESPACE, SNAPSHOT_ATTACHMENT } from './pdfFormat';
import { compatibleLegacySnapshot, PDF_EDITABLE_JSON_LIMIT, PDF_PRISTINE_LIMIT } from './pdfRole';
import type { PdfRole, PdfRoleFailure } from './pdfRole';
import { checkPdfWriteMark } from './pdfWriteMark';

interface Entry { id: string; names: Set<string>; description: string; spec: PDFDict }
const key = PDFName.of;
function text(value: PDFObject | undefined): string | undefined {
    return value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : undefined;
}

export async function inspectPdfRole(bytes: Uint8Array, generation: string): Promise<PdfRole> {
    const unreadable = (attachment: string, reason: PdfRoleFailure, detail?: string, attachmentId?: string): PdfRole => ({ kind: 'unreadable', alreadyAnnotated: true, generation, attachment, attachmentId, reason, detail });
    try {
        const doc = await PDFDocument.load(bytes, { parseSpeed: Infinity, updateMetadata: false });
        if (doc.isEncrypted) return unreadable('PDF', 'encrypted');
        const entries = new Map<PDFDict, Entry>();
        function spec(raw: PDFObject | undefined, alias?: string) {
            const value = doc.context.lookup(raw);
            if (!(value instanceof PDFDict)) throw new Error('Unreadable attachment Filespec');
            let entry = entries.get(value);
            if (!entry) {
                entry = { id: doc.context.getObjectRef(value)?.toString() ?? `direct:${entries.size}`, names: new Set(), description: text(value.lookup(key('Desc'))) ?? '', spec: value };
                entries.set(value, entry);
            }
            for (const name of [alias, text(value.lookup(key('UF'))), text(value.lookup(key('F')))]) if (name) entry.names.add(name);
        }
        const visited = new Set<PDFDict>();
        const nodes: PDFObject[] = [];
        const names = doc.catalog.lookup(key('Names'));
        if (names !== undefined) {
            if (!(names instanceof PDFDict)) throw new Error('Unreadable Names dictionary');
            const root = names.get(key('EmbeddedFiles'));
            if (root) nodes.push(root);
        }
        while (nodes.length) {
            const node = doc.context.lookup(nodes.pop());
            if (!(node instanceof PDFDict)) throw new Error('Unreadable attachment name-tree node');
            if (visited.has(node)) continue;
            visited.add(node);
            // Both are intentional. pdf-lib's historical writer produced a
            // mixed node; choosing Kids OR Names hid a perfectly readable pair.
            const pairs = node.lookup(key('Names'));
            if (pairs !== undefined) {
                if (!(pairs instanceof PDFArray) || pairs.size() % 2) throw new Error('Malformed attachment name pairs');
                for (let i = 0; i < pairs.size(); i += 2) {
                    const name = text(pairs.lookup(i));
                    if (name === undefined) throw new Error('Unreadable attachment name');
                    spec(pairs.get(i + 1), name);
                }
            }
            const kids = node.lookup(key('Kids'));
            if (kids !== undefined) {
                if (!(kids instanceof PDFArray)) throw new Error('Malformed attachment children');
                for (let i = kids.size() - 1; i >= 0; i--) nodes.push(kids.get(i));
            }
        }
        function associated(dict: PDFDict) {
            const af = dict.lookup(key('AF'));
            if (af === undefined) return;
            if (!(af instanceof PDFArray)) throw new Error('Unreadable associated attachments');
            for (let i = 0; i < af.size(); i++) spec(af.get(i));
        }
        associated(doc.catalog);
        for (const page of doc.getPages()) {
            associated(page.node);
            const annotations = page.node.lookup(key('Annots'));
            if (annotations === undefined) continue;
            if (!(annotations instanceof PDFArray)) throw new Error('Unreadable page annotations');
            for (let i = 0; i < annotations.size(); i++) {
                const annotation = annotations.lookup(i);
                if (!(annotation instanceof PDFDict)) throw new Error('Unreadable page annotation');
                associated(annotation);
                if (annotation.lookup(key('Subtype')) === key('FileAttachment')) spec(annotation.get(key('FS')));
            }
        }
        const all = [...entries.values()];
        const has = (entry: Entry, name: string) => entry.names.has(name);
        // Namespace recognition deliberately precedes marker parsing. This
        // legacy writer supports NO marked editable format, even a malformed
        // declaration or an unfamiliar name without an original.pdf companion.
        const newer = all.filter(entry => has(entry, BOARD_ATTACHMENT) || entry.description.startsWith(PDF_APP_MARKER_NAMESPACE));
        if (newer.length) return { kind: 'newer', generation, alreadyAnnotated: true, attachments: newer.flatMap(entry => entry.names.size ? [...entry.names] : [entry.id]) };
        const originals = all.filter(entry => has(entry, ORIGINAL_ATTACHMENT));
        const snapshots = all.filter(entry => has(entry, SNAPSHOT_ATTACHMENT));
        const notebooks = all.filter(entry => has(entry, NOTEBOOK_SOURCE_ATTACHMENT));
        const authority = [...originals, ...snapshots, ...notebooks];
        if (originals.length > 1 || snapshots.length > 1 || notebooks.length > 1 || new Set(authority).size !== authority.length || authority.some(entry => entry.names.size !== 1) || notebooks.length && (originals.length || snapshots.length)) {
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
                const decoded = decodePDFRawStream(f).getBytes(limit + 1);
                if (decoded.length > limit) return failure('limit', `${limit} bytes`);
                return new Uint8Array(decoded);
            } catch { return failure('corrupt'); }
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
        return { kind: 'annotated', generation, alreadyAnnotated: true, original, snapshot, notebookSource: null,
            writeMark: await checkPdfWriteMark(bytes) };
    } catch (error) {
        return unreadable('attachment inventory', error instanceof Error && error.message.includes('encrypted') ? 'encrypted' : 'corrupt');
    }
}
