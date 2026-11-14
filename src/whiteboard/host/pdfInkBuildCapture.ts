import type { pinPdfInkHostForSave } from '../../pdf/session/inkHost';
import type { PdfEditableInkSource } from '../../pdf/session/inkAcquisition.types';
import { createExportImageResolver } from '../export/exportImage';
import { streamPageDisplayList } from '../export/streamPage';
import { encodeHost } from '../format/encode';
import type { BoardRecoveryRecipe } from '../format/recoveryRecipe';
import type { SerializerRecordOverride } from '../format/serializerProtocol';
import { recordKey } from '../format/writeTypes';
import { createBoardHostImages } from '../media/hostImages';
import type { MediaLease } from '../media/store';
import type { MediaId } from '../model/media';
import type { BoardBuildCapture } from '../session/factoryTypes';
import type { SceneSnapshot } from '../scene/types';
import { pinPdfInkAssembly } from './pdfInkAssembly';
import type { createPdfInkSourceOwner } from './pdfInkSourceOwner';
import { createPdfRecoveryRecipe } from './pdfRecovery';
import type { BoardRuntime } from './runtime';

class PdfBuildContext {
    constructor(readonly owner: object, readonly revision: number, readonly acquisition: PdfEditableInkSource,
        readonly writeId: string, readonly override: SerializerRecordOverride) {}
}

/** PDF authority is supplied by the actual pooled acquisition and its host validator.
 * Drawing/notebook routes never import the PDF implementation to manufacture that authority. */
export function createPdfInkBuildCapture(options: {
    runtime(): BoardRuntime;
    sources: ReturnType<typeof createPdfInkSourceOwner>;
    pinHost: typeof pinPdfInkHostForSave;
    currentOwner(): boolean;
    onError(error: unknown): void;
}) {
    const owner = Object.freeze({});
    const contextFor = (value: unknown, revision?: number): PdfBuildContext => {
        if (!(value instanceof PdfBuildContext) || value.owner !== owner ||
            (revision !== undefined && value.revision !== revision)) throw new Error('PDF build context does not match this captured source');
        return value;
    };
    const copyOverride = (value: SerializerRecordOverride): SerializerRecordOverride => ({
        identity: { ...value.identity }, bytes: value.bytes.slice(),
    });
    return {
        captureBuild(revision: number): BoardBuildCapture {
            const runtime = options.runtime(), doc = runtime.session.doc;
            if (!options.currentOwner() || doc.kind !== 'pdf-ink' || doc.host.kind !== 'pdf-ink' || doc.rev !== revision) {
                throw new Error('A current PDF ink revision is required');
            }
            const lease = options.sources.retain();
            try {
                const pinned = options.pinHost(lease.source, doc.host), encoded = encodeHost(pinned.host);
                if (!encoded.ok) throw new Error(encoded.error.reason);
                const override = { identity: encoded.value.identity, bytes: new TextEncoder().encode(encoded.value.text) };
                const context = Object.freeze(new PdfBuildContext(owner, revision, lease.source, pinned.writeId, copyOverride(override)));
                // The source owner retains this acquisition until pinBuild in the same synchronous
                // capture stack. A failed serializer checkpoint therefore cannot leak a PDF lease.
                return { context, overrides: [override] };
            } finally { lease.release(); }
        },
        pinPdf(revision: number, value: unknown) {
            const context = contextFor(value, revision), runtime = options.runtime(), doc = runtime.session.doc;
            if (!options.currentOwner() || doc.rev !== revision || doc.kind !== 'pdf-ink' || !runtime.scene) {
                throw new Error('PDF ink scene is not ready for this revision');
            }
            const sourceLease = options.sources.retain();
            if (sourceLease.source !== context.acquisition) {
                sourceLease.release();
                throw new Error('PDF source changed during synchronous capture');
            }
            let scene: SceneSnapshot;
            try { scene = runtime.scene.pin(); }
            catch (error) { sourceLease.release(); throw error; }
            const held: MediaLease[] = [];
            let images: ReturnType<typeof createBoardHostImages> | undefined, released = false;
            const release = () => {
                if (released) return;
                released = true;
                try { images?.dispose(); } finally {
                    try { scene.release(); } finally {
                        try { for (const lease of held) lease.release(); } finally { sourceLease.release(); }
                    }
                }
            };
            try {
                if (scene.revision !== revision) throw new Error('PDF scene revision changed during capture');
                const stack = scene.layout, pages = context.acquisition.pages;
                if (!stack || stack.rects.length !== pages.length || !pages.every((page, index) =>
                    stack.rects[index].width === page.width && stack.rects[index].height === page.height)) {
                    throw new Error('PDF ink layout differs from its inspected source');
                }
                const entries = new Map([...doc.media].map(([id, entry]) => [id, structuredClone(entry)]));
                const blobs = new Map<MediaId, Blob>();
                for (const [id, entry] of entries) {
                    held.push(runtime.media.retain(id, 'snapshot'));
                    const blob = runtime.media.get(id);
                    if (!blob || blob.size !== entry.bytes) throw new Error(`PDF ink media is unavailable: ${id}`);
                    blobs.set(id, blob);
                }
                for (const [id, count] of doc.preservedMediaRefs) {
                    if (count > 0 && !entries.has(id)) throw new Error(`PDF preserved media has no metadata: ${id}`);
                }
                const token = scene.token;
                const readBlob = (id: MediaId, signal: AbortSignal): Promise<Blob> => {
                    signal.throwIfAborted();
                    const blob = blobs.get(id);
                    if (released || !blob) return Promise.reject(new Error(`Captured PDF media is unavailable: ${id}`));
                    return Promise.resolve(blob);
                };
                images = createBoardHostImages({ token, media: runtime.media, entry: id => entries.get(id), readBlob,
                    identity: { session: `${token.documentId}:${token.session}`, epoch: token.vaultEpoch, revision },
                    current: candidate => !released && candidate.documentId === token.documentId && candidate.session === token.session &&
                        candidate.vaultEpoch === token.vaultEpoch && candidate.bytesGeneration === token.bytesGeneration,
                    onError: options.onError });
                const capturedImages = images;
                const readImage = (key: string, signal: AbortSignal) => {
                    const match = /^(?:sha256:([0-9a-f]{64})(?::0)?|media:([0-9a-f]{64}):0)$/.exec(key);
                    if (!match) throw new TypeError('Invalid captured PDF image key');
                    return readBlob(`sha256:${match[1] ?? match[2]}` as MediaId, signal);
                };
                return pinPdfInkAssembly({ revision, source: context.acquisition.source, writeId: context.writeId,
                    media: [...entries.values()], mediaBlob: id => blobs.get(id),
                    isCurrent: () => !released && options.currentOwner(), release,
                    ink: { pages, sheets: doc.sheetOrder.map(sheet => sheet.id),
                        async readSheetPage(sheet, page, signal) {
                            signal.throwIfAborted();
                            const box = stack.rects[page];
                            if (!box || released) throw new Error('Captured PDF ink page is unavailable');
                            const source = await scene.paintSource({ sheetId: sheet, page, world: box, theme: 'light' }, signal);
                            const image = createExportImageResolver(token, capturedImages, readImage, signal);
                            return streamPageDisplayList(source, page, box, 1, image, signal);
                        } },
                }, signal => context.acquisition.openWriter(signal));
            } catch (error) { release(); throw error; }
        },
        pdfCopy(board: BoardRecoveryRecipe, value: unknown) {
            if (!board.delta) throw new Error('PDF recovery copy requires a captured board delta');
            const context = contextFor(value, board.delta.revision), key = recordKey(context.override.identity);
            // Only the copy gets the frozen HOST fork. The matching-baseline journal still
            // describes the admitted live model, whose host was deliberately never mutated.
            const overrides = [...(board.overrides ?? []).filter(row => recordKey(row.identity) !== key).map(copyOverride),
                copyOverride(context.override)];
            return createPdfRecoveryRecipe({ ...board, overrides }, { source: context.acquisition.source,
                pages: context.acquisition.pages.map(page => ({ ...page, toUserSpace: [...page.toUserSpace] })),
                revision: context.revision, writeId: context.writeId });
        },
        writtenContext(revision: number, value: unknown) {
            const context = contextFor(value, revision);
            return { revision, writeId: context.writeId, source: context.acquisition.source };
        },
    };
}
