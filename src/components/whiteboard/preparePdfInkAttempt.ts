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

/**
 * Plain captured values for one PDF source preparation. Every field is a value or a
 * plain getter/callback; none is a React ref, and no caller reads a ref while rendering.
 * App's cold agent path (ensureNativeAgentRuntime) calls it, dynamically imported, with the
 * live host and identity. NativePdfEntry keeps its own prepare: routing it through this helper
 * tripped the React Compiler's render-time ref check (see the commit message).
 */
export interface PdfInkAttemptInput {
    readonly host: NativeCanvasHost;
    readonly identity: NativeCanvasIdentity;
    readonly deadlineMs: number;
    readonly zMax: number;
    /** Only an explicit legacy-conversion route may set this. */
    readonly legacyConversion: boolean;
    /**
     * Cold agent acquisition: the source must already be native ink. A plain PDF is refused
     * after acquisition, never annotated, so an unannotated file is not written without consent.
     */
    readonly requireExistingNative?: boolean;
    onNotice(message: string): void;
    onError(cause: unknown): void;
    onHistoryLimit(): void;
    /**
     * Optional. A read-only result that names a notebook source hands off only when this is supplied and
     * canHandOff() is true. Omitted by callers with no handoff (the cold agent path), which then refuses.
     */
    readonly notebookHandoff?: {
        canHandOff(): boolean;
        open(path: string): void | Promise<void>;
    };
}

/**
 * The one PDF source attempt: the same document-owned source and runtime whether a view or
 * App's closed-PDF path asks for it. A read-only result is a thrown reason, never a board.
 */
export async function preparePdfInkAttempt(input: PdfInkAttemptInput, signal: AbortSignal): Promise<PreparedNativeBoard<ComposedBoardSession>> {
    const { host, identity } = input;
    if (identity.kind !== 'pdfInk') throw new Error('PDF identity does not match this entry');
    const create = input.legacyConversion ? prepareLegacyPdfInkSession : preparePdfInkSession;
    const result = await create({ host, identity, signal, deadlineMs: input.deadlineMs, zMax: input.zMax,
        requireExistingNative: input.requireExistingNative === true,
        prepareOwned: prepareOwnedPdfInk, createHost: createPdfInkHost, validateLoadedHost: validateLoadedPdfInkHost,
        readLegacyDigest: readPdfInkLegacyDigest, pinHost: pinPdfInkHostForSave, rebind: rebindPdfInkSource,
        // The acquisition adapter owns the temporary viewing seal. Source,
        // emergency and C5/D10 restrictions remain independent of that seal.
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
