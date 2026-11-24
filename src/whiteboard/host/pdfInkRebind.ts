import type { rebindPdfInkSource } from '../../pdf/session/inkHost';
import type { PdfInkAcquisition } from '../../pdf/session/inkAcquisition.types';
import type { PdfRuntimeInkSource } from '../../pdf/session/legacyInkAcquisition.types';
import type { RenderToken } from '../../platform/render/types';
import type { NativeCanvasHost, NativeCanvasIdentity } from '../../types/nativeCanvas';
import type { createPdfInkBuildCapture } from './pdfInkBuildCapture';
import type { createPdfInkSourceOwner } from './pdfInkSourceOwner';
import type { PaintSourceWitness } from './paintSourceRebind';

export interface PdfInkRebindOptions {
    readonly host: NativeCanvasHost;
    readonly documentId: string;
    readonly admittedIdentity: NativeCanvasIdentity;
    readonly initialSource: PdfRuntimeInkSource;
    readonly sources: ReturnType<typeof createPdfInkSourceOwner>;
    readonly rebind: typeof rebindPdfInkSource;
    onError(error: unknown): void;
    /** Must revoke authoritative write policy while preserving the live session and undo. */
    onReadOnly(reason: string): void;
    /**
     * Adopts the verified source as the paint token of future pins on the live runtime. It runs after the
     * source owner accepted the replacement and before `ready` is published; a throw fails closed to read-only.
     */
    adoptPaint(witness: PaintSourceWitness, isCurrent: () => boolean): void;
}

export type PdfInkWrittenContext = ReturnType<ReturnType<typeof createPdfInkBuildCapture>['writtenContext']>;

export interface PdfInkRebindSnapshot {
    readonly source: PdfRuntimeInkSource;
    /** Actual admitted source token. Existing frames retain their original token until a new view presents this source. */
    readonly token: RenderToken;
    readonly status: 'ready' | 'rebinding' | 'read-only' | 'failed';
    readonly reason?: string;
    /**
     * This owner has written bytes newer than what its generation names: a save kept the generation because the live
     * board already paints them (`afterWritten`). Any other reader of that generation (Original, Text) still shows the
     * older bytes until App advances the generation and `adoptWritten` follows it.
     */
    readonly writtenAhead?: true;
}

const tokenOf = (id: NativeCanvasIdentity): RenderToken => ({ documentId: id.documentId, session: id.session,
    vaultEpoch: id.vaultActivation, bytesGeneration: id.bytesGeneration });
const sameToken = (a: RenderToken, b: RenderToken) => a.documentId === b.documentId && a.session === b.session &&
    a.vaultEpoch === b.vaultEpoch && a.bytesGeneration === b.bytesGeneration;
const stale = () => new DOMException('PDF rebind is no longer current', 'AbortError');

/** The owner retains resources; this store only publishes the inspected backdrop version. */
export function createPdfInkRebind(options: PdfInkRebindOptions) {
    const { host, documentId, admittedIdentity, initialSource, sources } = options;
    if (admittedIdentity.kind !== 'pdfInk' || admittedIdentity.documentId !== documentId ||
        !sameToken(tokenOf(admittedIdentity), initialSource.source.token) || !host.isCurrent(admittedIdentity) || !initialSource.isCurrent()) {
        throw new Error('The PDF ink source does not match the admitted owner');
    }
    let snapshot: PdfInkRebindSnapshot = Object.freeze({ source: initialSource, token: initialSource.source.token, status: 'ready' });
    let disposed = false, serial = 0, tail: Promise<void> = Promise.resolve(), pending: AbortController | undefined;
    // The newest write whose generation was kept (see writtenAhead): what adoptWritten rebinds to.
    let ahead: PdfInkWrittenContext | undefined;
    const failures: unknown[] = [], listeners = new Set<() => void>();
    const report = (error: unknown) => { failures.push(error); try { options.onError(error); } catch { /* drain retains the original error. */ } };
    const publish = (next: PdfInkRebindSnapshot) => {
        snapshot = Object.freeze(next);
        for (const listener of [...listeners]) { try { listener(); } catch (error) { report(error); } }
    };
    const liveOwner = () => !disposed && host.isCurrent(admittedIdentity);
    const matches = (target: NativeCanvasIdentity, attempt: number) => {
        const outer = host.outerIdentity(documentId);
        return liveOwner() && attempt === serial && !!outer && outer.kind === 'pdfInk' &&
            sameToken(tokenOf(target), tokenOf(outer)) && host.isCurrent(target);
    };
    const release = async (source: PdfInkAcquisition) => { await source.release(); };
    const pause = () => {
        const reason = 'The saved PDF could not be safely rebound; editing is paused.';
        publish({ source: snapshot.source, token: snapshot.token, status: 'failed', reason });
        try { options.onReadOnly(reason); } catch (failure) { report(failure); }
    };
    /** Rebinds to the bytes `context` wrote, now named by the outer generation `target`. */
    const rebindTo = (attempt: number, target: NativeCanvasIdentity, context: PdfInkWrittenContext): Promise<void> => {
        // Any rebind supersedes a kept write: it inspects the file as it now is, and accepts only this owner's newest write id.
        ahead = undefined;
        publish({ source: snapshot.source, token: snapshot.token, status: 'rebinding' });
        const job = tail.then(async () => {
            const current = () => {
                if (matches(target, attempt)) return true;
                if (attempt === serial && !disposed) throw stale();
                return false;
            };
            if (!current()) return;
            const controller = new AbortController(); pending = controller;
            let acquired: PdfInkAcquisition | undefined;
            try {
                const outer = await host.acquireBytes(target, controller.signal);
                if (!current()) return;
                acquired = await options.rebind({ outer, token: tokenOf(target), signal: controller.signal,
                    isCurrent: liveOwner }, { pristineFingerprint: context.source.pristineFingerprint, writeId: context.writeId });
                if (!current()) return;
                if (acquired.kind === 'read-only') {
                    const reason = acquired.reason;
                    await release(acquired); acquired = undefined;
                    if (!current()) return;
                    publish({ source: snapshot.source, token: snapshot.token, status: 'read-only', reason });
                    options.onReadOnly(reason);
                    return;
                }
                if (!sameToken(acquired.source.token, tokenOf(target))) throw new Error('PDF rebind returned a different outer generation');
                sources.replace(acquired, tokenOf(target));
                const accepted = acquired; acquired = undefined;
                options.adoptPaint({ token: accepted.source.token, pristineFingerprint: accepted.source.pristineFingerprint,
                    writeId: accepted.kind === 'native' ? accepted.writeId : null }, liveOwner);
                publish({ source: accepted, token: accepted.source.token, status: 'ready' });
            } finally {
                if (pending === controller) pending = undefined;
                if (acquired) await release(acquired);
            }
        });
        const tracked = job.catch(error => {
            if (attempt !== serial || disposed) {
                if (error instanceof DOMException && error.name === 'AbortError') return;
                report(error);
                throw error;
            }
            report(error);
            pause();
            throw error;
        });
        tail = tracked.catch(() => {});
        return tracked;
    };
    return {
        getSnapshot: () => snapshot,
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        afterWritten(revision: number, context: PdfInkWrittenContext): Promise<void> {
            const attempt = ++serial;
            pending?.abort();
            let target: NativeCanvasIdentity;
            try {
                const outer = host.outerIdentity(documentId);
                if (!outer || !liveOwner() || outer.kind !== 'pdfInk' || outer.documentId !== documentId ||
                    outer.session !== admittedIdentity.session || outer.vaultActivation !== admittedIdentity.vaultActivation ||
                    !host.isCurrent(outer) || context.revision !== revision || !Number.isSafeInteger(revision) || revision < 0 ||
                    !/^[0-9a-f]{32}$/.test(context.writeId) || context.source.token.documentId !== documentId || context.source.token.session !== admittedIdentity.session ||
                    context.source.token.vaultEpoch !== admittedIdentity.vaultActivation ||
                    context.source.token.bytesGeneration > outer.bytesGeneration ||
                    context.source.pristineFingerprint !== initialSource.source.pristineFingerprint) throw stale();
                target = { ...outer };
                // The app keeps the generation for this pane's own save (useSaveFunnel): the live source already
                // paints those bytes, so there is nothing to rebind and the board stays live. The write is remembered:
                // the generation still names the older bytes, which is what Original would go on showing.
                if (outer.bytesGeneration === snapshot.token.bytesGeneration && snapshot.status === 'ready') {
                    ahead = context;
                    if (!snapshot.writtenAhead) publish({ ...snapshot, writtenAhead: true });
                    return Promise.resolve();
                }
            } catch (error) {
                report(error);
                if (!disposed) pause();
                return Promise.reject(error);
            }
            return rebindTo(attempt, target, context);
        },
        /**
         * Follows App advancing the generation over this owner's own kept write (PdfPane asks when it shows Original):
         * the same rebind an outside save gets, run while no board is on screen, so its cover drops no press. A no-op
         * unless a write is ahead and the outer generation has moved past this source's.
         */
        adoptWritten(): Promise<void> {
            const context = ahead, outer = host.outerIdentity(documentId);
            if (!context || !outer || !liveOwner() || snapshot.status !== 'ready' || outer.kind !== 'pdfInk' ||
                outer.session !== admittedIdentity.session || outer.vaultActivation !== admittedIdentity.vaultActivation ||
                !host.isCurrent(outer) || outer.bytesGeneration <= snapshot.token.bytesGeneration) return Promise.resolve();
            const attempt = ++serial;
            pending?.abort();
            return rebindTo(attempt, { ...outer }, context);
        },
        dispose() { if (!disposed) { disposed = true; serial++; pending?.abort(); listeners.clear(); } },
        async drain() { await tail; await sources.drain(); if (failures.length) throw new AggregateError([...failures], 'PDF ink rebind failed'); },
    };
}
