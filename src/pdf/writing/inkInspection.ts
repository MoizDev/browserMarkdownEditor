import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { boundedAttachmentBytes, inventoryAttachments } from '../../utils/pdfAttachmentTree';
import type { AttachmentEntry } from '../../utils/pdfAttachmentTree';
import { NOTEBOOK_SOURCE_ATTACHMENT } from '../../utils/pdfFormat';
import { checkPdfWriteMark } from '../../utils/pdfWriteMark';
import { Sha256 } from '../../utils/sha256';
import { NATIVE_FORMAT_ID } from '../../whiteboard/format/identity';
import { attachmentMarker } from './attachments';
import { validateBoardWriteIdentity } from './boardIdentity';
import type { PdfInkInspection, PdfInkInspectionFailure, PdfInkMediaDescriptor } from './inkInspection.types';

const LIMIT = 0x7fffffff, BOARD_LIMIT = 32 * 1024 * 1024, MAX_INSPECTIONS = 16;
const key = PDFName.of;
const RESERVED = new Set(['original.pdf', 'board.json', 'tldraw-snapshot.json', '.vault-write-mark', NOTEBOOK_SOURCE_ATTACHMENT]);
const MEDIA = /^board-media\/([0-9a-f]{64})\.[a-zA-Z0-9]{1,16}$/;
const FENCE = '{"document":{"schema":{"schemaVersion":999},"store":{}},"fence":"compat-1: compatibility fence, holds no content, so that builds of this app from before the guard release refuse to edit this file"}';
interface Retained { document: PDFDocument; bytes: Uint8Array; media: Map<string, AttachmentEntry> }
class Refusal extends Error { constructor(readonly reason: PdfInkInspectionFailure) { super(reason); } }
class Interrupted extends Error { constructor(readonly cause: unknown) { super('Inspection interrupted'); } }
const refuse = (reason: PdfInkInspectionFailure): never => { throw new Refusal(reason); };

function attachment(entry: AttachmentEntry, limit: number): Uint8Array {
    const ef = entry.spec.lookup(key('EF'));
    if (!(ef instanceof PDFDict)) return refuse('unreadable');
    const a = ef.lookup(key('F')), b = ef.lookup(key('UF'));
    if (a && b && a !== b) return refuse('ambiguous');
    const stream = b ?? a;
    if (!(stream instanceof PDFRawStream)) return refuse('unreadable');
    try { return boundedAttachmentBytes(stream, limit); }
    catch (error) {
        if (error instanceof Error && error.message.includes('size limit')) return refuse('resource-limit');
        return refuse('unreadable');
    }
}
function named(entry: AttachmentEntry): string {
    if (entry.keys.length > 1 || entry.names.size !== 1) return refuse('ambiguous');
    const name = [...entry.names][0];
    if (!name || name.length > 1024 || name.includes('\0')) return refuse('unreadable');
    return name;
}
function signaturePresent(doc: PDFDocument): boolean {
    if (doc.catalog.get(key('Perms'))) return true;
    const form = doc.catalog.lookup(key('AcroForm'));
    if (form === undefined) return false;
    if (!(form instanceof PDFDict)) return refuse('unreadable');
    const root = form.lookup(key('Fields'));
    if (root === undefined) return false;
    if (!(root instanceof PDFArray)) return refuse('unreadable');
    const stack: Array<{ value: unknown; depth: number }> = [];
    for (let i = 0; i < root.size(); i++) stack.push({ value: root.get(i), depth: 0 });
    const seen = new Set<PDFDict>();
    while (stack.length) {
        const { value, depth } = stack.pop()!;
        if (depth > 64 || seen.size >= 100_000) return refuse('resource-limit');
        const field = doc.context.lookup(value as Parameters<typeof doc.context.lookup>[0]);
        if (!(field instanceof PDFDict) || seen.has(field)) return refuse('unreadable');
        seen.add(field);
        if (field.lookup(key('FT')) === key('Sig')) return true;
        const kids = field.lookup(key('Kids'));
        if (kids !== undefined) {
            if (!(kids instanceof PDFArray) || kids.size() > 100_000 - seen.size - stack.length) return refuse('resource-limit');
            for (let i = 0; i < kids.size(); i++) stack.push({ value: kids.get(i), depth: depth + 1 });
        }
    }
    return false;
}
function inventory(doc: PDFDocument): Map<string, AttachmentEntry> {
    if (doc.isEncrypted) return refuse('encrypted');
    if (signaturePresent(doc)) return refuse('signed');
    if (!doc.getPageCount() || doc.getPageCount() > 100_000) return refuse('unreadable');
    const entries = inventoryAttachments(doc), result = new Map<string, AttachmentEntry>();
    if (entries.length > 10_000) return refuse('resource-limit');
    for (const entry of entries) {
        const name = named(entry);
        if (result.has(name)) return refuse('ambiguous');
        result.set(name, entry);
    }
    return result;
}
function isAuthority(name: string, entry: AttachmentEntry): boolean {
    return RESERVED.has(name) || name.startsWith('board-media/') || entry.description.startsWith('local-vault-pdf/');
}
async function hash(bytes: Uint8Array, cooperate: () => Promise<void>): Promise<string> {
    const digest = new Sha256();
    for (let at = 0; at < bytes.length; at += 1024 * 1024) { await cooperate(); digest.update(bytes.subarray(at, at + 1024 * 1024)); }
    return digest.digest();
}

/** Contained worker owns each parsed graph. Names are never filesystem paths. */
export class PdfInkInspector {
    private readonly retained = new Map<string, Retained>();
    private pending = 0;
    private closed = false;
    async inspect(outer: Blob, cooperate: () => Promise<void>): Promise<PdfInkInspection> {
        if (this.closed) throw new Error('PDF inspection is closed');
        if (!(outer instanceof Blob) || (typeof File !== 'undefined' && outer instanceof File) || outer.size < 1 || outer.size > LIMIT) return { kind: 'read-only', reason: 'invalid-source' };
        if (this.retained.size + this.pending >= MAX_INSPECTIONS) return { kind: 'read-only', reason: 'resource-limit' };
        this.pending++;
        const step = async () => { try { await cooperate(); } catch (error) { throw new Interrupted(error); } if (this.closed) throw new Interrupted(new DOMException('PDF inspection closed', 'AbortError')); };
        try {
            await step();
            const bytes = new Uint8Array(await outer.arrayBuffer());
            await step();
            const outerFingerprint = await hash(bytes, step);
            let document: PDFDocument;
            try { document = await PDFDocument.load(bytes, { parseSpeed: Infinity, updateMetadata: false }); }
            catch (error) { return { kind: 'read-only', reason: error instanceof Error && /encrypt/i.test(error.message) ? 'encrypted' : 'unreadable' }; }
            await step();
            const entries = inventory(document), owned = [...entries].filter(([name, entry]) => isAuthority(name, entry));
            let pristine = outer, pristineFingerprint = outerFingerprint, board: Blob | null = null, writeId: string | undefined;
            const media = new Map<string, AttachmentEntry>(), descriptors: PdfInkMediaDescriptor[] = [];
            if (owned.length) {
                const roles = new Map<string, 'pristine' | 'editable' | 'fence' | 'write-mark'>([
                    ['original.pdf', 'pristine'], ['board.json', 'editable'], ['tldraw-snapshot.json', 'fence'], ['.vault-write-mark', 'write-mark'],
                ]);
                for (const [name, entry] of owned) {
                    const match = MEDIA.exec(name), role = roles.get(name) ?? (match ? 'media' : undefined);
                    if (!role) return refuse('unsupported-format');
                    if (entry.description.split('\n', 1)[0] !== attachmentMarker(role, NATIVE_FORMAT_ID)) return refuse('invalid-marker');
                    if (match) { media.set(name, entry); descriptors.push({ name, size: null, sha256: match[1] }); }
                }
                for (const name of roles.keys()) if (!entries.has(name)) return refuse('missing-attachment');
                const originalBytes = attachment(entries.get('original.pdf')!, LIMIT);
                if (!originalBytes.length) return refuse('unreadable');
                await step();
                pristineFingerprint = await hash(originalBytes, step);
                pristine = new Blob([new Uint8Array(originalBytes)], { type: 'application/pdf' });
                const nested = await PDFDocument.load(originalBytes, { parseSpeed: Infinity, updateMetadata: false });
                await step();
                if ([...inventory(nested)].some(([name, entry]) => isAuthority(name, entry))) return refuse('nested-source');
                const boardBytes = attachment(entries.get('board.json')!, BOARD_LIMIT);
                if (!boardBytes.length) return refuse('unreadable');
                board = new Blob([new Uint8Array(boardBytes)], { type: 'application/json' });
                const fence = attachment(entries.get('tldraw-snapshot.json')!, BOARD_LIMIT);
                if (new TextDecoder('utf-8', { fatal: true }).decode(fence) !== FENCE) return refuse('unsupported-format');
                attachment(entries.get('.vault-write-mark')!, BOARD_LIMIT);
                await step();
                const mark = await checkPdfWriteMark(bytes);
                await step();
                if (mark.kind !== 'verified' || !mark.writeId) return refuse('invalid-write-mark');
                writeId = mark.writeId;
                try { await validateBoardWriteIdentity(board, NATIVE_FORMAT_ID, writeId, step); }
                catch (error) { if (error instanceof Interrupted) throw error; return refuse('unsupported-format'); }
            }
            await step();
            const id = crypto.randomUUID();
            this.retained.set(id, { document, bytes, media });
            if (!board) return { kind: 'plain', id, outerFingerprint, pristine, pristineFingerprint, board: null, media: [], formatId: NATIVE_FORMAT_ID };
            return { kind: 'native', id, outerFingerprint, pristine, pristineFingerprint, board, writeId: writeId!, media: descriptors, formatId: NATIVE_FORMAT_ID };
        } catch (error) {
            if (error instanceof Interrupted) throw error.cause;
            return { kind: 'read-only', reason: error instanceof Refusal ? error.reason : 'unreadable' };
        } finally { this.pending--; }
    }
    async readMedia(id: string, name: string, cooperate: () => Promise<void>): Promise<Blob> {
        const retained = this.retained.get(id), match = MEDIA.exec(name), entry = retained?.media.get(name);
        if (this.closed || !retained || !match || !entry) throw new Error('PDF media inspection is unavailable');
        const step = async () => { await cooperate(); if (this.closed || this.retained.get(id) !== retained) throw new DOMException('PDF inspection released', 'AbortError'); };
        await step();
        const bytes = attachment(entry, LIMIT);
        if (await hash(bytes, step) !== match[1]) throw new Error('PDF media fingerprint mismatch');
        await step();
        return new Blob([new Uint8Array(bytes)]);
    }
    release(id: string): void { this.retained.delete(id); }
    dispose(): void { this.closed = true; this.retained.clear(); }
    /** Advisory retained source/parsed-graph reservation, not measured JS heap. */
    memoryBytes(): number { let total = 0; for (const entry of this.retained.values()) total += entry.bytes.byteLength * 2; return total; }
}
