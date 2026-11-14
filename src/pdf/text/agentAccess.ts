import type { ClosedPdfAgentAccess } from '../../types/vaultAgent';
import type { RenderToken } from '../../platform/render';
import type { PdfOpenOptions, PdfPool } from '../pool/types';
import { readPdfAgentText, renderPdfAgentPage } from './agentText';

/** A fresh token is required for each captured byte snapshot, including a reopened path. */
export function createClosedPdfAgentAccess(pool: PdfPool, capture: (path: string) => {
    token: RenderToken;
    isCurrent(): boolean;
}): ClosedPdfAgentAccess {
    const open = (path: string, bytes: Uint8Array, signal: AbortSignal): { options: PdfOpenOptions; current: () => boolean } => {
        signal.throwIfAborted();
        const identity = capture(path);
        if (!identity.isCurrent()) throw new DOMException('PDF session changed', 'AbortError');
        const blob = new Blob([Uint8Array.from(bytes)], { type: 'application/pdf' });
        return { options: { token: identity.token, source: 'outer', blob, priority: 0, signal }, current: identity.isCurrent };
    };
    return {
        async read(path, bytes, first, maxPages, maxChars, signal) {
            const { options, current } = open(path, bytes, signal);
            const result = await readPdfAgentText(pool, options, first, maxPages, maxChars, signal, current);
            if (!current()) throw new DOMException('PDF session changed', 'AbortError');
            return result;
        },
        async render(path, bytes, page, maxSide, signal) {
            const { options, current } = open(path, bytes, signal);
            const result = await renderPdfAgentPage(pool, options, page, maxSide, signal, current);
            if (!current()) throw new DOMException('PDF session changed', 'AbortError');
            return result;
        },
    };
}
