import { inkRefusal } from '../../pdf/session/inkReadOnlyText';
import { createPdfInkHost, pinPdfInkHostForSave, readPdfInkLegacyDigest, rebindPdfInkSource, validateLoadedPdfInkHost } from '../../pdf/session/inkHost';
import { prepareOwnedPdfInk } from '../../pdf/session/ownedInkAcquisition';
import type { NativeCanvasHost, NativeCanvasIdentity } from '../../types/nativeCanvas';
import { preparePdfInkSession } from '../../whiteboard/host/preparePdfInkSession';
import { prepareLegacyPdfInkSession } from '../../whiteboard/host/prepareLegacyPdfInkSession';
import { createNotebookCopyOnlyRole, NotebookCopyOnlyRefusal } from '../../whiteboard/host/notebookCopyOnlyRole';
import type { ComposedBoardSession } from '../../whiteboard/session/factoryTypes';
import type { PreparedNativeBoard } from './nativeBoardAcquisitionTypes';

export const PDF_VIEW_REASON = 'PDF annotation tools are unavailable in this view.';

export interface PdfInkAttemptInput {
    readonly host: NativeCanvasHost;
    readonly identity: NativeCanvasIdentity;
    readonly deadlineMs: number;
    readonly zMax: number;
    readonly legacyConversion: boolean;
    /**
     * Cold agent acquisition: the source must already be native ink. A plain PDF is refused
     * after acquisition, never annotated, so an unannotated file is not written without consent.
     */
    readonly requireExistingNative?: boolean;
    onNotice(message: string): void;
    onError(cause: unknown): void;
    onHistoryLimit(): void;
    readonly notebookHandoff?: {
        canHandOff(): boolean;
        open(path: string): void | Promise<void>;
    };
}

export async function preparePdfInkAttempt(input: PdfInkAttemptInput, signal: AbortSignal): Promise<PreparedNativeBoard<ComposedBoardSession>> {
    const { host, identity } = input;
    if (identity.kind !== 'pdfInk') throw new Error('PDF identity does not match this entry');
    const create = input.legacyConversion ? prepareLegacyPdfInkSession : preparePdfInkSession;
    const result = await create({ host, identity, signal, deadlineMs: input.deadlineMs, zMax: input.zMax,
        requireExistingNative: input.requireExistingNative === true,
        prepareOwned: prepareOwnedPdfInk, createHost: createPdfInkHost, validateLoadedHost: validateLoadedPdfInkHost,
        readLegacyDigest: readPdfInkLegacyDigest, pinHost: pinPdfInkHostForSave, rebind: rebindPdfInkSource,
        currentReadOnly: () => null, onReadOnly: reason => input.onNotice(reason), onError: input.onError,
        onHistoryLimit: input.onHistoryLimit });
    if (result.kind === 'read-only') {
        // A notebook-backed PDF is copy-only: the refusal carries the role, granting no write to the export.
        const { notebookSource, outerFingerprint, isCurrent } = result;
        const role = notebookSource && outerFingerprint && isCurrent
            ? createNotebookCopyOnlyRole({ notebookPath: notebookSource.path, outerFingerprint, isCurrent: () => isCurrent() })
            : undefined;
        try {
            signal.throwIfAborted();
            const handoff = input.notebookHandoff;
            if (handoff && notebookSource && isCurrent?.() && handoff.canHandOff()) {
                await handoff.open(notebookSource.path);
                signal.throwIfAborted();
                if (!isCurrent?.() || !handoff.canHandOff()) throw new DOMException('PDF notebook handoff ended', 'AbortError');
            }
            if (role) throw new NotebookCopyOnlyRefusal(result.reason, role);
            throw inkRefusal(result.reason);
        } finally { await result.dispose(); }
    }
    return result;
}
