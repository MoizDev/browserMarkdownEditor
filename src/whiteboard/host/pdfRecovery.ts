import type { PageGeometry } from '../../platform/types';
import type { WriterSource } from '../../pdf/writing/protocol';
import type { RecoveryMediaAsset } from '../../utils/recoveryCopy';
import { streamPageDisplayList } from '../export/streamPage';
import { writeIncrementalPdfPage } from '../export/incrementalPdf';
import type { IncrementalPdfPage } from '../export/incrementalPdf';
import type { SheetId } from '../model/ids';
import { createExportImageResolver } from '../export/exportImage';
import { boardRecoveryMedia, materializeBoardRecoveryRecipe, type BoardRecoveryRecipe } from '../format/recoveryRecipe';
import { hashMedia } from '../media/sha256';
import { MediaStore, type MediaLease } from '../media/store';
import type { BoardDoc } from '../model/doc';
import type { MediaId } from '../model/media';
import { boardPageStack } from '../model/pages';
import { createBoardRenderServices } from '../render/services';
import { acquireNativeBoard, type NativeBoardAcquisition } from './nativeAcquisition';
import { pinPdfInkAssembly } from './pdfInkAssembly';
import { inspectPdfVisualModel } from './pdfVisualPreflight';

/** Pure journal data: neither the original PDF tab nor its worker survives in the recipe. */
export interface PdfRecoveryRecipe {
    readonly version: 1;
    readonly board: BoardRecoveryRecipe;
    readonly source: WriterSource;
    readonly pages: readonly PageGeometry[];
    readonly revision: number;
    readonly writeId: string;
}
function isCopiedBlob(value: unknown): value is Blob {
    return value instanceof Blob && !(typeof File !== 'undefined' && value instanceof File);
}
function validate(recipe: PdfRecoveryRecipe): void {
    if (!recipe || recipe.version !== 1 || !recipe.board || !recipe.source || !Array.isArray(recipe.pages)
        || !Number.isSafeInteger(recipe.revision) || recipe.revision < 0 || recipe.board.delta?.revision !== recipe.revision
        || typeof recipe.writeId !== 'string' || !/^[0-9a-f]{32}$/.test(recipe.writeId)
        || !isCopiedBlob(recipe.source.pristine) || !isCopiedBlob(recipe.source.outer) || !recipe.pages.length) {
        throw new TypeError('Invalid PDF recovery recipe');
    }
    for (let i = 0; i < recipe.pages.length; i++) {
        const page = recipe.pages[i];
        if (!page || page.index !== i || !Number.isFinite(page.width) || page.width <= 0
            || !Number.isFinite(page.height) || page.height <= 0 || !Number.isFinite(page.userUnit) || page.userUnit <= 0
            || ![0, 90, 180, 270].includes(page.rotate) || !Array.isArray(page.toUserSpace)
            || page.toUserSpace.length !== 6 || !page.toUserSpace.every(Number.isFinite)) throw new TypeError('Invalid PDF recovery page geometry');
    }
}

/** Capture this alongside the dirty board recipe, while the PDF source lease is held. */
export function createPdfRecoveryRecipe(board: BoardRecoveryRecipe, input: Omit<PdfRecoveryRecipe, 'version' | 'board'>): PdfRecoveryRecipe {
    const recipe: PdfRecoveryRecipe = { ...input, board, version: 1 };
    validate(recipe);
    // Structured clone severs the caller's maps, arrays and typed buffers as well
    // as rejecting callbacks. Blob slices retain owned bytes, never a disk File.
    const copy = structuredClone(recipe);
    return { ...copy, source: { ...copy.source, pristine: copy.source.pristine.slice(0, copy.source.pristine.size, copy.source.pristine.type),
        outer: copy.source.outer.slice(0, copy.source.outer.size, copy.source.outer.type) } };
}

export function pdfRecoveryMedia(payload: unknown): readonly RecoveryMediaAsset[] {
    const recipe = payload as PdfRecoveryRecipe;
    validate(recipe);
    return boardRecoveryMedia(recipe.board);
}

/** Rebuild against the owned native copy, then let the contained PDF writer
 * verify and assemble the pristine source, ink, attachments and write mark. */
export async function materializePdfRecoveryRecipe(payload: unknown, signal: AbortSignal,
    mediaFiles?: ReadonlyMap<string, string>): Promise<Blob> {
    signal.throwIfAborted();
    const recipe = payload as PdfRecoveryRecipe;
    validate(recipe);
    const board = await materializeBoardRecoveryRecipe(recipe.board, signal, mediaFiles);
    signal.throwIfAborted();
    const media = new MediaStore(), leases: MediaLease[] = [];
    let acquisition: NativeBoardAcquisition | undefined;
    let services: ReturnType<typeof createBoardRenderServices> | undefined;
    let images: ReturnType<typeof import('../media/hostImages').createBoardHostImages> | undefined;
    let alive = true;
    try {
        const assets = boardRecoveryMedia(recipe.board);
        for (const asset of assets) {
            signal.throwIfAborted();
            const id = asset.id as MediaId;
            leases.push(media.retain(id, 'snapshot'));
            media.put(id, asset.blob);
            media.setFile(id, mediaFiles?.get(id) ?? asset.file);
        }
        acquisition = await acquireNativeBoard({ bytes: board, kind: 'pdf-ink',
            identity: { session: `pdf-recovery-${crypto.randomUUID()}`, epoch: 0, generation: 0 },
            pdfPages: recipe.pages.map(page => [page.width, page.height] as const), signal, deadlineMs: 120_000 });
        if (acquisition.status !== 'editable' || acquisition.report.repaired?.repairs.length || acquisition.load.unmapped.length) {
            throw new Error('Recovered PDF board cannot be rendered without repair or data loss');
        }
        const visual = await inspectPdfVisualModel(acquisition.load, { signal });
        if (visual.status !== 'known') throw new Error('Recovered PDF contains uninterpreted visual content; flattening would lose it');
        const doc: BoardDoc = Object.freeze({ ...acquisition.load.doc, rev: recipe.revision });
        if (doc.kind !== 'pdf-ink' || doc.host.kind !== 'pdf-ink') throw new Error('Recovered board is not PDF ink');
        const stack = boardPageStack(doc.host);
        if (!stack || stack.rects.length !== recipe.pages.length) throw new Error('Recovered PDF page stack differs from source');
        for (let i = 0; i < recipe.pages.length; i++) {
            const page = recipe.pages[i], box = stack.rects[i];
            if (box.width !== page.width || box.height !== page.height) throw new Error('Recovered PDF page dimensions differ from source');
        }
        for (const entry of doc.media.values()) {
            signal.throwIfAborted();
            const blob = media.get(entry.id);
            if (!blob || blob.size !== entry.bytes || await hashMedia(blob, signal) !== entry.id) {
                throw new Error(`Recovered PDF media is missing or corrupt: ${entry.id}`);
            }
        }
        for (const [id, count] of doc.preservedMediaRefs) {
            if (count > 0 && !doc.media.has(id)) throw new Error(`Recovered PDF preserved media has no metadata: ${id}`);
        }
        const token = Object.freeze({ ...recipe.source.token });
        services = createBoardRenderServices({ doc, samples: acquisition.samples, media, token });
        const ownedServices = services;
        const { createBoardHostImages } = await import('../media/hostImages');
        images = createBoardHostImages({ identity: { session: `pdf-recovery-${crypto.randomUUID()}`, epoch: 0, revision: recipe.revision },
            token, media, entry: id => doc.media.get(id),
            readBlob: async (id, readSignal) => {
                readSignal.throwIfAborted();
                const blob = media.get(id);
                if (!blob) throw new Error(`Recovered PDF media is unavailable: ${id}`);
                return blob;
            }, current: candidate => alive && candidate.vaultEpoch === token.vaultEpoch && candidate.documentId === token.documentId
                && candidate.bytesGeneration === token.bytesGeneration && candidate.session === token.session,
            onError: error => console.error('PDF recovery image:', error), signal });
        const ownedImages = images;
        let released = false;
        const prepareSheet = async (sheet: SheetId, page: number, pageSignal: AbortSignal) => {
            pageSignal.throwIfAborted();
            const box = stack.rects[page];
            if (!box) throw new RangeError('PDF recovery page is unavailable');
            const source = await ownedServices.preparePaint(doc, { sheetId: sheet, page, world: box, theme: 'light' }, pageSignal);
            const image = createExportImageResolver(token, ownedImages, async (key, readSignal) => {
                readSignal.throwIfAborted();
                const match = /^(?:sha256:([0-9a-f]{64})(?::0)?|media:([0-9a-f]{64}):0)$/.exec(key);
                if (!match) throw new TypeError('Invalid recovered PDF image key');
                const blob = media.get(`sha256:${match[1] ?? match[2]}` as MediaId);
                if (!blob) throw new Error('Recovered PDF image bytes are unavailable');
                return blob;
            }, pageSignal);
            return { source, box, image };
        };
        const assembly = pinPdfInkAssembly({ revision: recipe.revision, source: recipe.source, writeId: recipe.writeId,
            media: [...doc.media.values()], mediaBlob: id => media.get(id), isCurrent: () => !released,
            release() { released = true; },
            ink: { pages: recipe.pages, sheets: doc.sheetOrder.map(sheet => sheet.id),
                async readSheetPage(sheet, page, pageSignal) {
                    const { source, box, image } = await prepareSheet(sheet, page, pageSignal);
                    return streamPageDisplayList(source, page, box, 1, image, pageSignal);
                },
                async writeSheetPage(sheet: SheetId, page: number, sink: IncrementalPdfPage, pageSignal: AbortSignal) {
                    const { source, box, image } = await prepareSheet(sheet, page, pageSignal);
                    await writeIncrementalPdfPage({ source, world: box }, page, 1, image, sink, pageSignal);
                } },
        }, async writerSignal => {
            const [{ getSharedPdfPool }, { typedPdfWriter }] = await Promise.all([
                import('../../pdf/session/startup'), import('../../pdf/writing/writerClient'),
            ]);
            writerSignal.throwIfAborted();
            const pool = getSharedPdfPool();
            const writer = await pool.writer({ signal: writerSignal });
            if (writerSignal.aborted) { await writer.close(); writerSignal.throwIfAborted(); }
            return typedPdfWriter(writer);
        });
        try {
            const bytes = await assembly.assemble(board, signal);
            signal.throwIfAborted();
            return bytes instanceof Blob ? bytes.slice(0, bytes.size, 'application/pdf')
                : new Blob([Uint8Array.from(bytes)], { type: 'application/pdf' });
        } finally { assembly.release(); }
    } finally {
        alive = false;
        try { images?.dispose(); } finally {
            try { services?.dispose(); } finally {
                try { for (const lease of leases) lease.release(); } finally {
                    try { media.clear(); } finally { acquisition?.dispose(); }
                }
            }
        }
    }
}
