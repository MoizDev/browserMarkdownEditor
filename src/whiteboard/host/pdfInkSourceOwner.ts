import type { RenderToken } from '../../platform/render/types';
import type { PageGeometry } from '../../platform/types';
import type { PdfInkAcquisition } from '../../pdf/session/inkAcquisition.types';
import type { PdfRuntimeInkSource } from '../../pdf/session/legacyInkAcquisition.types';
import { isConvertedPdfInkSource } from '../../pdf/session/convertedInkBrand';

export interface PdfInkSourceOwnerOptions {
    /** Checks the App document/session owner and target byte generation, not pane visibility. */
    currentOwner(token: RenderToken): boolean;
    onError(error: unknown): void;
}

export interface PdfInkSourceLease {
    readonly source: PdfRuntimeInkSource;
    release(): void;
}

function sameToken(a: RenderToken, b: RenderToken): boolean {
    return a.documentId === b.documentId && a.session === b.session && a.vaultEpoch === b.vaultEpoch &&
        a.bytesGeneration === b.bytesGeneration;
}
function sameGeometry(a: Readonly<PageGeometry>, b: Readonly<PageGeometry>): boolean {
    return a.index === b.index && a.width === b.width && a.height === b.height && a.rotate === b.rotate &&
        a.userUnit === b.userUnit && a.toUserSpace.length === 6 && b.toUserSpace.length === 6 &&
        a.toUserSpace.every((value, index) => value === b.toUserSpace[index]);
}

/** Takes ownership only of accepted sources. A rejected replacement stays with its caller. */
export function createPdfInkSourceOwner(initial: PdfRuntimeInkSource, options: PdfInkSourceOwnerOptions) {
    type Entry = { source: PdfRuntimeInkSource; refs: number };
    const seen = new WeakSet<PdfRuntimeInkSource>();
    const failures: unknown[] = [];
    let tail: Promise<void> = Promise.resolve(), disposed = false;
    const valid = (source: PdfRuntimeInkSource | PdfInkAcquisition): source is PdfRuntimeInkSource =>
        source.kind !== 'read-only' && (source.kind !== 'legacy-converted' || isConvertedPdfInkSource(source))
        && source.isCurrent() && options.currentOwner(source.source.token);
    if (!valid(initial)) throw new Error('PDF ink source is not owned and current');
    const identity = { ...initial.source.token };
    let current: Entry | undefined = { source: initial, refs: 1 };
    seen.add(initial);
    const drop = (entry: Entry) => {
        if (--entry.refs !== 0) return;
        tail = tail.then(() => entry.source.release()).catch(error => {
            failures.push(error);
            try { options.onError(error); } catch { /* Retain the release failure for drain. */ }
        });
    };
    return {
        retain(): PdfInkSourceLease {
            const entry = current;
            if (disposed || !entry || !options.currentOwner(entry.source.source.token) || !entry.source.isCurrent()) {
                throw new Error('PDF ink source is no longer current');
            }
            entry.refs++;
            let released = false;
            return { source: entry.source, release() { if (!released) { released = true; drop(entry); } } };
        },
        /** Caller must complete the actual rebind verification before transferring next. */
        replace(next: PdfInkAcquisition, verifiedToken: RenderToken): void {
            const old = current;
            if (disposed || !old || !valid(next) || seen.has(next) || !sameToken(next.source.token, verifiedToken) ||
                verifiedToken.documentId !== identity.documentId || verifiedToken.session !== identity.session ||
                verifiedToken.vaultEpoch !== identity.vaultEpoch || !Number.isSafeInteger(verifiedToken.bytesGeneration) ||
                verifiedToken.bytesGeneration < old.source.source.token.bytesGeneration ||
                next.source.pristineFingerprint !== old.source.source.pristineFingerprint ||
                next.source.pristine.size !== old.source.source.pristine.size ||
                next.source.formatId !== old.source.source.formatId || next.pages.length !== old.source.pages.length ||
                !next.pages.every((page, index) => sameGeometry(page, old.source.pages[index]))) {
                throw new Error('PDF ink replacement does not match the owned source');
            }
            seen.add(next);
            current = { source: next, refs: 1 };
            drop(old);
        },
        dispose(): void {
            if (disposed) return;
            disposed = true;
            const old = current; current = undefined;
            if (old) drop(old);
        },
        /** Waits for releases queued so far; outstanding captured leases must first be released. */
        async drain(): Promise<void> {
            await tail;
            if (failures.length) throw new AggregateError([...failures], 'PDF ink source release failed');
        },
    };
}
