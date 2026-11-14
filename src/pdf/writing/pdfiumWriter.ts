import type { PdfiumRuntime } from '../engine/pdfium/loader';
import { pdfiumPageGeometry, pdfiumPageSize } from '../engine/pdfium/geometry';
import { PdfEngineError } from '../engine/types';
import type { WriterOperations, WriterSource } from './protocol';
import { validateWriterSource } from './source';
import { inventoryNativeAttachments } from './nativeInventory';
import { preservationPath } from './preservation';
import { validateBoardAttachments, attachmentMarker } from './attachments';
import { addNativeAttachment, addNativeWriteMark, saveNativeMarkedPdf } from './nativeSave';
import { stampNativeInk, WriterNativeDocument } from './nativeStage';
import { WriterStageStore } from './stageStore';

const FIXED = ['original.pdf', 'board.json', 'tldraw-snapshot.json', '.vault-write-mark'];
type Prepare = WriterOperations['writer.prepareSource'];
type Stage = WriterOperations['writer.stageAnnotated'];
type Finish = WriterOperations['writer.finishAnnotated'];
type Coop = { slice(): Promise<void>; readonly cancelled: boolean };
type Preserved = Array<{ originalName: string; name: string; sha256: string }>;
type Session = { source: WriterSource; path: 'native' | 'legacy'; pageCount: number };
class NativeStage {
    constructor(readonly doc: WriterNativeDocument, readonly source: WriterSource, readonly pageCount: number,
        readonly reserved: readonly string[], readonly preserved: Preserved) {}
    close(): void { this.doc.close(); }
}

function reservedNames(names: readonly string[]): Set<string> {
    if (!Array.isArray(names) || names.length < FIXED.length || names.length > 100_004) throw new Error('Invalid reserved attachment names');
    const set = new Set(names);
    if (set.size !== names.length || FIXED.some(name => !set.has(name)) || [...set].some(name =>
        !FIXED.includes(name) && !/^board-media\/[0-9a-f]{64}\.[a-zA-Z0-9]{1,16}$/.test(name))) throw new Error('Invalid reserved attachment names');
    return set;
}
function equalSets(a: Set<string>, b: Set<string>): boolean { return a.size === b.size && [...a].every(value => b.has(value)); }

/** Only the writer worker creates this object. Closing it tears down every
 * native stage; no pointers or mutable graph escape as an operation result. */
export class PdfiumWriter {
    private readonly sessions = new Map<string, Session>();
    private readonly stages = new WriterStageStore<NativeStage>();
    private disposed = false;
    constructor(private readonly runtime: PdfiumRuntime) {
        if (runtime.role !== 'writer') throw new PdfEngineError('EngineBroken', 'PDF mutation requires an isolated writer instance');
    }

    async prepareSource(args: Prepare['args'], context: Coop): Promise<Prepare['result']> {
        if (this.disposed || this.sessions.size >= 16) throw new PdfEngineError('ResourceLimit', 'Too many PDF writer sessions');
        await validateWriterSource(args.source, () => context.slice());
        const source = args.source, pristine = await WriterNativeDocument.open(this.runtime, source.pristine);
        let outer: WriterNativeDocument | undefined;
        try {
            pristine.assertEditable();
            const count = pristine.pageCount(), geometries = [];
            for (let i = 0; i < count; i++) {
                await context.slice();
                const size = pdfiumPageSize(this.runtime, pristine.handle, i, 14_400);
                const page = this.runtime.call('FPDF_LoadPage', pristine.handle, i) >>> 0;
                if (!page) throw new PdfEngineError('PageError', 'Cannot inspect source page geometry');
                try { geometries.push(pdfiumPageGeometry(this.runtime, page, i, size)); }
                finally { this.runtime.call('FPDF_ClosePage', page); }
            }
            const pristineAttachments = await inventoryNativeAttachments(pristine, () => context.slice());
            let outerAttachments = pristineAttachments;
            if (source.outerFingerprint !== source.pristineFingerprint) {
                outer = await WriterNativeDocument.open(this.runtime, source.outer);
                outer.assertEditable();
                outerAttachments = await inventoryNativeAttachments(outer, () => context.slice());
            }
            const path = preservationPath(pristineAttachments, outerAttachments, source.formatId, source.pristineFingerprint, source.outerFingerprint);
            const writerSession = crypto.randomUUID();
            if (this.disposed || context.cancelled) throw new PdfEngineError('AbortError', 'PDF writer preparation cancelled');
            this.sessions.set(writerSession, { source, path, pageCount: count });
            return { writerSession, sourceFingerprint: source.pristineFingerprint,
                inspection: { pageCount: count, geometries, encrypted: false, signed: false,
                    attachments: outerAttachments.map(({ name, sha256 }) => ({ name, sha256 })) } };
        } finally { outer?.close(); pristine.close(); }
    }

    async stageAnnotated(args: Stage['args'], context: Coop): Promise<Stage['result']> {
        const session = this.sessions.get(args.writerSession);
        if (this.disposed || !session || !Number.isSafeInteger(args.revision) || args.revision < 0) throw new PdfEngineError('NotFoundError', 'PDF writer source is unavailable');
        const reserved = reservedNames(args.reservedNames);
        let working = session.source.pristine, preserved: Preserved = [];
        if (session.path === 'legacy') {
            const { convertLegacyAttachmentUnion } = await import('./legacyConverter');
            const converted = await convertLegacyAttachmentUnion({ pristine: session.source.pristine, outer: session.source.outer,
                reservedNames: [...reserved], format: session.source.formatId }, () => context.slice());
            working = converted.workingPdf; preserved = converted.preserved;
        }
        await context.slice();
        const doc = await WriterNativeDocument.open(this.runtime, working);
        try {
            await stampNativeInk(doc, args.ink, args.geometries, () => context.slice());
            if (this.disposed || context.cancelled || this.sessions.get(args.writerSession) !== session) throw new PdfEngineError('AbortError', 'PDF writer source was released');
            const native = new NativeStage(doc, session.source, session.pageCount, [...reserved], preserved);
            const stageId = this.stages.put({ session: args.writerSession, revision: args.revision,
                sourceFingerprint: session.source.pristineFingerprint, geometryEngine: session.source.geometryEngine, native });
            return { stageId, sourceFingerprint: session.source.pristineFingerprint, geometryEngine: session.source.geometryEngine };
        } catch (error) { doc.close(); throw error; }
    }

    async finishAnnotated(args: Finish['args'], context: Coop): Promise<Finish['result']> {
        if (this.disposed || !/^[0-9a-f]{32}$/.test(args.writeId)) throw new PdfEngineError('InvalidPdf', 'Invalid PDF write identity');
        const stage = await this.stages.take(args.stageId, args.revision), native = stage.native;
        const current = () => !this.disposed && !context.cancelled && this.sessions.get(stage.session)?.source === native.source;
        const cooperate = async () => { await context.slice(); if (!current()) throw new PdfEngineError('AbortError', 'PDF writer source was released'); };
        try {
            await cooperate();
            await validateBoardAttachments(args.attachments, native.source.formatId, args.writeId, cooperate);
            const app = args.attachments.filter(entry => entry.role !== 'unknown');
            const required = new Set([...FIXED, ...app.filter(entry => entry.role === 'media').map(entry => entry.name)]);
            if (!equalSets(required, new Set(native.reserved))) throw new Error('The frozen board media changed after staging');
            for (const entry of args.attachments.filter(entry => entry.role === 'unknown')) {
                if (!native.preserved.some(item => item.originalName === entry.name && item.sha256 === entry.sha256)) throw new Error('An unknown PDF attachment was not preserved');
            }
            await addNativeAttachment(native.doc, 'original.pdf', native.source.pristine, attachmentMarker('pristine', native.source.formatId));
            for (const entry of app) {
                await cooperate();
                await addNativeAttachment(native.doc, entry.name, entry.bytes, attachmentMarker(entry.role as 'editable' | 'fence' | 'media', native.source.formatId));
            }
            await cooperate();
            addNativeWriteMark(native.doc, native.source.formatId, args.writeId);
            const output = await saveNativeMarkedPdf(native.doc, args.writeId, () => !current());
            native.close();
            await cooperate();
            const check = WriterNativeDocument.openBytes(this.runtime, output);
            try {
                const pageCount = check.pageCount(), attachments = await inventoryNativeAttachments(check, cooperate);
                const expected = [
                    { name: 'original.pdf', sha256: native.source.pristineFingerprint, marker: attachmentMarker('pristine', native.source.formatId) },
                    ...app.map(entry => ({ name: entry.name, sha256: entry.sha256, marker: attachmentMarker(entry.role as 'editable' | 'fence' | 'media', native.source.formatId) })),
                ];
                if (pageCount !== native.pageCount || expected.some(item => !attachments.some(actual => actual.name === item.name && actual.sha256 === item.sha256 && actual.marker === item.marker)) ||
                    native.preserved.some(item => !attachments.some(actual => actual.name === item.name && actual.sha256 === item.sha256)) ||
                    !attachments.some(item => item.name === '.vault-write-mark' && item.marker === attachmentMarker('write-mark', native.source.formatId))) {
                    throw new PdfEngineError('InvalidPdf', 'PDF output could not be verified');
                }
                return { bytes: output.buffer as ArrayBuffer, revision: stage.revision, writeId: args.writeId,
                    sourceFingerprint: stage.sourceFingerprint, verification: { pageCount, attachmentCount: attachments.length, writeMark: 'verified' } };
            } finally { check.close(); }
        } finally { native.close(); }
    }

    async release(writerSession: string): Promise<void> {
        this.sessions.delete(writerSession);
        await this.stages.releaseSession(writerSession);
    }
    async dispose(): Promise<void> {
        this.disposed = true;
        this.sessions.clear();
        await this.stages.dispose();
    }
}
