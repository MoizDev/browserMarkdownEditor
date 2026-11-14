import type { PdfPoolDocument } from '../pool/types';
import type { PageSelectionModel, PageTextReply } from '../worker/protocol';

export type PdfSelectionReply = Omit<PageTextReply, 'model' | 'digest' | 'sel'> & { sel: PageSelectionModel };

const MAX_PAGES = 48, MAX_BYTES = 8 * 1024 * 1024;
const abort = () => new DOMException('PDF selection geometry cancelled', 'AbortError');
function cost(reply: PdfSelectionReply): number {
    const sel = reply.sel;
    return 128 + reply.text.length * 2 + reply.reasons.reduce((n, reason) => n + reason.length * 2, 0) + reply.tokenBreaks.byteLength + sel.charU16.byteLength + sel.loose.byteLength +
        sel.flags.byteLength + sel.lines.byteLength + sel.lineBox.byteLength + sel.lineDir.byteLength +
        sel.lineBidi.byteLength + sel.clusters.byteLength + (sel.headingLevels?.length ?? 0) * 16 +
        sel.figures.reduce((n, figure) => n + 64 + figure.alt.length * 2, 0);
}

/** Session-local selection geometry. The pool deduplicates and reprioritises
 * concurrent waiters; this cache never retains a result from an old docKey. */
export class PdfSelectionGeometryCache {
    private readonly key: string;
    private readonly pages = new Map<number, { value: PdfSelectionReply; bytes: number }>();
    private readonly lifetime = new AbortController();
    private visibility = new AbortController();
    private visible = true;
    private pinned = new Set<number>();
    private bytes = 0;

    constructor(private readonly document: PdfPoolDocument) { this.key = document.docKey; }

    cached(page: number): PdfSelectionReply | undefined {
        const found = this.pages.get(page);
        if (!found) return undefined;
        this.pages.delete(page); this.pages.set(page, found);
        return found.value;
    }
    setEndpoints(pages: readonly number[]): void {
        this.pinned = new Set(pages.filter(page => Number.isInteger(page) && page >= 0 && page < this.document.info.pageCount));
        if (!this.visible) this.dropUnpinned();
    }
    async get(page: number, priority: 0 | 1 | 2 | 3, external?: AbortSignal): Promise<PdfSelectionReply> {
        const signal = AbortSignal.any([this.lifetime.signal, this.visibility.signal, ...(external ? [external] : [])]);
        if (signal.aborted || this.document.closed) throw abort();
        const found = this.cached(page);
        if (found) return found;
        const reply = await this.document.text(page, 'select', { priority, signal });
        if (signal.aborted || this.document.closed) throw abort();
        if (reply.docKey !== this.key || reply.page !== page || reply.schema !== 2 || !reply.sel)
            throw new Error('The PDF text worker returned stale or incomplete selection geometry.');
        // Selection has its own 8 MiB budget; the optional rich model belongs
        // only to the separate Text reader's 4 MiB cache.
        const value: PdfSelectionReply = { docKey: reply.docKey, page: reply.page, schema: reply.schema,
            text: reply.text, tokenBreaks: reply.tokenBreaks, quality: reply.quality, reasons: reply.reasons, sel: reply.sel };
        const bytes = cost(value);
        if (bytes <= MAX_BYTES) {
            const previous = this.pages.get(page);
            if (previous) this.bytes -= previous.bytes;
            this.pages.delete(page);
            while (this.pages.size >= MAX_PAGES || this.bytes + bytes > MAX_BYTES) {
                const victim = [...this.pages.keys()].find(index => !this.pinned.has(index));
                if (victim === undefined) break;
                this.bytes -= this.pages.get(victim)!.bytes; this.pages.delete(victim);
            }
            if (this.pages.size < MAX_PAGES && this.bytes + bytes <= MAX_BYTES) {
                this.pages.set(page, { value, bytes }); this.bytes += bytes;
            }
        }
        return value;
    }
    setVisible(visible: boolean): void {
        if (visible === this.visible) return;
        this.visible = visible;
        if (visible) this.visibility = new AbortController();
        else { this.visibility.abort(); this.dropUnpinned(); }
    }
    diagnostics(): { pages: number; bytes: number } { return { pages: this.pages.size, bytes: this.bytes }; }
    dispose(): void {
        this.lifetime.abort(); this.visibility.abort(); this.pages.clear(); this.pinned.clear(); this.bytes = 0;
    }
    private dropUnpinned(): void {
        for (const [page, entry] of this.pages) if (!this.pinned.has(page)) { this.bytes -= entry.bytes; this.pages.delete(page); }
    }
}
