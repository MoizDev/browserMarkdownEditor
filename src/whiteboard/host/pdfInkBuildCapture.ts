import type { pinPdfInkHostForSave } from '../../pdf/session/inkHost';
import type { PdfRuntimeInkSource } from '../../pdf/session/legacyInkAcquisition.types';
import { encodeHost } from '../format/encode';
import type { BoardRecoveryRecipe } from '../format/recoveryRecipe';
import type { SerializerRecordOverride } from '../format/serializerProtocol';
import { recordKey } from '../format/writeTypes';
import type { BoardBuildCapture } from '../session/factoryTypes';
import { pinPagedBoardScene } from './pagedSceneCapture';
import { pinPdfInkAssembly } from './pdfInkAssembly';
import type { createPdfInkSourceOwner } from './pdfInkSourceOwner';
import { createPdfRecoveryRecipe } from './pdfRecovery';
import type { BoardRuntime } from './runtime';

class PdfBuildContext {
    constructor(readonly owner: object, readonly revision: number, readonly acquisition: PdfRuntimeInkSource,
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
            let scene: ReturnType<typeof pinPagedBoardScene>;
            try { scene = pinPagedBoardScene(runtime, revision, options.currentOwner, options.onError); }
            catch (error) { sourceLease.release(); throw error; }
            let released = false;
            const release = () => {
                if (released) return;
                released = true;
                try { scene.release(); } finally { sourceLease.release(); }
            };
            try {
                const pages = context.acquisition.pages;
                if (scene.rects.length !== pages.length || !pages.every((page, index) =>
                    scene.rects[index].width === page.width && scene.rects[index].height === page.height)) {
                    throw new Error('PDF ink layout differs from its inspected source');
                }
                return pinPdfInkAssembly({ revision, source: context.acquisition.source, writeId: context.writeId,
                    media: scene.media, mediaBlob: scene.mediaBlob,
                    isCurrent: () => !released && options.currentOwner(), release,
                    ink: { pages, sheets: scene.sheets, readSheetPage: scene.readSheetPage },
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
