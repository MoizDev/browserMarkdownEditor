import type { PageGeometry } from '../../platform/types';
import type { RenderToken } from '../../platform/render';
import type { PdfPageLink } from '../pdfLinkModel';
import type { PdfTileProducer } from '../layer/tileLayer';
import type { PdfPoolDocument } from '../pool/types';
import { stablePdfBlob } from './stableBlob';

/** The pool adapter is the only engine-specific half of this session. */
export interface OpenTiledDocument {
    readonly pages: readonly PageGeometry[];
    readonly poolDocument: PdfPoolDocument;
    readonly producer: PdfTileProducer;
    links(page: number, signal: AbortSignal): Promise<readonly PdfPageLink[]>;
    close(): Promise<void>;
}

export interface TiledDocumentPool {
    open(blob: Blob, token: RenderToken, source: 'outer' | 'original', signal: AbortSignal, password?: string): Promise<OpenTiledDocument>;
}

/** App-owned prompt; null means the user cancelled, never an empty password. */
export type PdfPasswordRequest = (token: RenderToken, incorrect: boolean, signal: AbortSignal) => Promise<string | null>;

/** Geometry, not path, determines whether older pixels can bridge a version. */
export function pdfGeometryDigest(pages: readonly PageGeometry[]): string {
    return JSON.stringify(pages.map(page => [page.index, page.width, page.height, page.rotate, page.userUnit, ...page.toUserSpace]));
}

interface Slot { value: unknown; dispose?: () => void | Promise<void> }

/**
 * App/session lifetime, not a component lifetime. The source snapshot and
 * pool document survive pane hide, graph trips and StrictMode remounts. A new
 * byte generation is a different instance; rename is not. The App closing
 * barrier calls close only after saves/exports and outstanding views drain.
 */
export class PdfTiledDocumentSession {
    private readonly controller = new AbortController();
    private readonly slots = new Map<symbol, Slot>();
    private opening: Promise<OpenTiledDocument> | null = null;
    private document: OpenTiledDocument | null = null;
    private closing: Promise<void> | null = null;
    private closed = false;
    private captureUsers = 0;
    private readonly captureWaiters = new Set<() => void>();

    constructor(readonly token: RenderToken, readonly source: 'outer' | 'original',
        private readonly acquireSnapshot: (signal: AbortSignal) => Promise<{ blob: Blob; stat: { lastModified: number; size: number }; dispose(): void }>,
        private readonly pool: TiledDocumentPool, private readonly isTokenCurrent: (token: RenderToken) => boolean,
        private readonly onStableBlob?: (blob: Blob, stat: { lastModified: number; size: number }, signal: AbortSignal) => void) {}

    open(): Promise<OpenTiledDocument> {
        if (this.closed || !this.isTokenCurrent(this.token)) return Promise.reject(new DOMException('PDF session closed', 'AbortError'));
        if (!this.opening) {
            this.opening = (async () => {
                const snapshot = await this.acquireSnapshot(this.controller.signal);
                let blob: Blob;
                try { blob = await stablePdfBlob(snapshot.blob, this.controller.signal); }
                finally { snapshot.dispose(); }
                this.onStableBlob?.(blob, snapshot.stat, this.controller.signal);
                const opened = await this.pool.open(blob, this.token, this.source, this.controller.signal);
                if (this.closed || !this.isTokenCurrent(this.token)) {
                    await opened.close();
                    throw new DOMException('PDF session replaced', 'AbortError');
                }
                this.document = opened;
                return opened;
            })();
            const opening = this.opening;
            void opening.catch(() => { if (this.opening === opening && !this.closed) this.opening = null; });
        }
        return this.opening;
    }

    /** Captures pin the source until their async work has actually settled.
     * Hiding a pane never cancels this signal; closing the session does. */
    async acquireCapture(): Promise<{ document: OpenTiledDocument; signal: AbortSignal; release(): void }> {
        if (this.closed) throw new DOMException('PDF session closed', 'AbortError');
        this.captureUsers++;
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            if (--this.captureUsers === 0) { for (const wake of this.captureWaiters) wake(); this.captureWaiters.clear(); }
        };
        try {
            const document = await this.open();
            if (this.closed) throw new DOMException('PDF session closed', 'AbortError');
            return { document, signal: this.controller.signal, release };
        } catch (error) { release(); throw error; }
    }

    isCurrent(): boolean { return !this.closed && this.isTokenCurrent(this.token); }

    getSlot<T>(key: symbol): T | undefined { return this.slots.get(key)?.value as T | undefined; }
    setSlot<T>(key: symbol, value: T, dispose?: (value: T) => void | Promise<void>): void {
        if (this.closed) throw new Error('PDF session is closed');
        if (this.slots.has(key)) throw new Error('PDF session slot is already occupied');
        this.slots.set(key, { value, dispose: dispose ? () => dispose(value) : undefined });
    }

    close(): Promise<void> {
        if (this.closing) return this.closing;
        this.closed = true;
        this.controller.abort();
        this.closing = (async () => {
            // A late successful open closes itself after observing `closed`.
            if (this.opening) await this.opening.catch(() => undefined);
            if (this.captureUsers) await new Promise<void>(resolve => this.captureWaiters.add(resolve));
            const document = this.document;
            this.document = null;
            const slots = [...this.slots.values()];
            this.slots.clear();
            const failures: unknown[] = [];
            for (const slot of slots) try { await slot.dispose?.(); } catch (error) { failures.push(error); }
            try { await document?.close(); } catch (error) { failures.push(error); }
            if (failures.length) throw new AggregateError(failures, 'PDF session could not be closed cleanly');
        })();
        return this.closing;
    }
}
