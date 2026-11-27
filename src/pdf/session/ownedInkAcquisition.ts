import { acquirePdfInkSource } from './inkAcquisition';
import type { PdfEditableInkSource, PdfInkAcquisitionOptions } from './inkAcquisition.types';

export type PreparedOwnedPdfInk =
    | { readonly kind: 'read-only'; readonly reason: string; readonly notebookSource?: { readonly path: string; readonly exportedAt?: number };
        readonly outerFingerprint?: string; isCurrent?(): boolean; dispose(): Promise<void> }
    | { readonly kind: 'ready'; take(): PdfEditableInkSource; dispose(): Promise<void> };

export async function prepareOwnedPdfInk(
    options: Omit<PdfInkAcquisitionOptions, 'signal'>, paneSignal: AbortSignal,
): Promise<PreparedOwnedPdfInk> {
    const scope = new AbortController();
    let taken = false, disposed = false;
    const stale = () => new DOMException('PDF ink source is no longer current', 'AbortError');
    const current = () => {
        if (disposed || scope.signal.aborted || paneSignal.aborted) return false;
        try { return options.isCurrent(); } catch { return false; }
    };
    const onPaneAbort = () => scope.abort(paneSignal.reason);
    paneSignal.addEventListener('abort', onPaneAbort, { once: true });
    const detach = () => paneSignal.removeEventListener('abort', onPaneAbort);
    if (!current()) { detach(); scope.abort(); throw stale(); }
    let acquired: Awaited<ReturnType<typeof acquirePdfInkSource>>;
    try {
        acquired = await acquirePdfInkSource({ ...options, signal: scope.signal });
        if (!current()) { await acquired.release(); throw stale(); }
    } catch (error) { detach(); scope.abort(); throw error; }
    if (acquired.kind === 'read-only') {
        detach();
        return { kind: 'read-only', reason: acquired.reason,
            ...(acquired.notebookSource && acquired.outerFingerprint && acquired.isCurrent ? {
                notebookSource: acquired.notebookSource, outerFingerprint: acquired.outerFingerprint,
                isCurrent: () => current() && acquired.isCurrent!(),
            } : {}),
            dispose: () => { disposed = true; scope.abort(); return acquired.release(); } };
    }
    const source = acquired;
    let release: Promise<void> | undefined;
    const dispose = () => {
        if (taken) return Promise.resolve();
        if (release) return release;
        disposed = true;
        detach();
        scope.abort();
        return release = source.release();
    };
    return {
        kind: 'ready',
        take() {
            if (taken || !current() || !source.isCurrent()) {
                void dispose();
                throw stale();
            }
            taken = true;
            detach();
            return source;
        },
        dispose,
    };
}
