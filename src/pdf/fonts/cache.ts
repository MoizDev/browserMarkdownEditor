import { PDF_FONT_CATALOGUE, type PdfFontId } from './catalogue';

const BUDGET = 64 * 1024 * 1024;
interface Pending { controller: AbortController; promise: Promise<Blob>; waiters: number; size: number }

/** Own one cache per app, not per document or worker. Cached Blobs are immutable. */
export class PdfFontCache {
    private readonly cached = new Map<PdfFontId, Blob>();
    private readonly pending = new Map<PdfFontId, Pending>();
    private retained = 0;
    private reserved = 0;

    async load(id: PdfFontId, signal?: AbortSignal): Promise<Blob> {
        signal?.throwIfAborted();
        if (!Object.hasOwn(PDF_FONT_CATALOGUE, id)) throw new Error('Unknown PDF font');
        const hit = this.cached.get(id);
        if (hit) { this.cached.delete(id); this.cached.set(id, hit); return hit; }
        let pending = this.pending.get(id);
        if (!pending) {
            const asset = PDF_FONT_CATALOGUE[id];
            if (!asset.sha256 || !asset.bytes) throw new Error('PDF font asset is not supplied');
            while (this.retained + this.reserved + asset.bytes > BUDGET && this.cached.size) {
                const oldest = this.cached.keys().next().value!;
                this.retained -= this.cached.get(oldest)!.size;
                this.cached.delete(oldest);
            }
            if (this.retained + this.reserved + asset.bytes > BUDGET) throw new Error('PDF font cache limit exceeded');
            const controller = new AbortController();
            pending = { controller, waiters: 0, size: asset.bytes, promise: undefined as unknown as Promise<Blob> };
            const entry = pending;
            this.reserved += entry.size;
            this.pending.set(id, entry);
            entry.promise = this.fetchAsset(id, controller.signal).then(blob => {
                if (controller.signal.aborted) throw controller.signal.reason;
                this.cached.set(id, blob); this.retained += blob.size;
                return blob;
            }).finally(() => {
                this.reserved -= entry.size;
                if (this.pending.get(id) === entry) this.pending.delete(id);
            });
        }
        pending.waiters++;
        const entry = pending;
        return new Promise<Blob>((resolve, reject) => {
            let done = false;
            const finish = () => {
                if (done) return false;
                done = true;
                signal?.removeEventListener('abort', abort);
                if (--entry.waiters === 0 && this.pending.get(id) === entry) entry.controller.abort();
                return true;
            };
            const abort = () => { if (finish()) reject(signal?.reason); };
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) { abort(); return; }
            entry.promise.then(value => { if (finish()) resolve(value); }, error => { if (finish()) reject(error); });
        });
    }

    private async fetchAsset(id: PdfFontId, signal: AbortSignal): Promise<Blob> {
        const asset = PDF_FONT_CATALOGUE[id];
        const url = new URL(asset.path, document.baseURI);
        if (url.origin !== location.origin) throw new Error('Invalid PDF font asset origin');
        const response = await fetch(url, { signal, redirect: 'error', credentials: 'same-origin' });
        if (!response.ok || !response.body) throw new Error('PDF font asset unavailable');
        const reader = response.body.getReader(), chunks: Uint8Array<ArrayBuffer>[] = [];
        let size = 0;
        try {
            for (;;) {
                const part = await reader.read();
                if (part.done) break;
                size += part.value.byteLength;
                if (size > asset.bytes) throw new Error('PDF font length mismatch');
                chunks.push(new Uint8Array(part.value));
            }
        } catch (error) { void reader.cancel().catch(() => {}); throw error; }
        finally { reader.releaseLock(); }
        if (size !== asset.bytes) throw new Error('PDF font length mismatch');
        const blob = new Blob(chunks);
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
        signal.throwIfAborted();
        const hash = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
        if (hash !== asset.sha256) throw new Error('PDF font integrity mismatch');
        return blob;
    }
}

/** Shared across all PDF documents and render workers. */
export const pdfFontCache = new PdfFontCache();
