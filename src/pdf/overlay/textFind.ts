import type { Rect } from '../../platform/types';
import type { PdfFindHit } from '../../utils/pdfFind';
import { selectionRange } from '../text/selection';
import type { PdfSelection } from '../text/selection';
import type { PdfSelectionGeometryCache, PdfSelectionReply } from '../text/selectionCache';
import { pdfHighlightRuns } from './textHighlightRuns';
import type { PdfHighlightRects } from './textHighlight';

export interface PdfFindStart { page: number; y: number }
export interface PdfTiledFindHost {
    pageRect(page: number): Readonly<Rect> | undefined;
    /** Fallback for a host without the animated, revision-guarded path. */
    reveal(page: number, box: Readonly<Rect>): void;
    approximate?(hit: PdfFindHit, signal: AbortSignal): Promise<Rect | null>;
    beginReveal?(page: number, box: Readonly<Rect>): number | null;
    correctReveal?(page: number, box: Readonly<Rect>, revision: number): void;
    publish(rects: PdfHighlightRects): void;
    error(error: unknown): void;
}
const abort = () => new DOMException('PDF highlight operation cancelled', 'AbortError');
const task = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const sameHit = (a: PdfFindHit, b: PdfFindHit | undefined) => !!b && a.page === b.page && a.from === b.from && a.to === b.to;

/** Keeps search independent of the viewport; only its on-screen geometry is
 * requested and painted. The retained reader owns the actual D7 index. */
export class PdfTiledFindHighlights {
    private hits: readonly PdfFindHit[] = [];
    private current: PdfFindHit | undefined;
    private selection: PdfSelection | null = null;
    private pages: readonly number[] = [];
    private zoom = 1;
    private cancel: AbortController | null = null;
    private visible = true;
    private disposed = false;

    constructor(private readonly geometry: PdfSelectionGeometryCache, private readonly host: PdfTiledFindHost) {}
    setFind(hits: readonly PdfFindHit[], current?: PdfFindHit): void {
        this.hits = hits; this.current = current;
        this.geometry.setFindPage(this.visible ? current?.page ?? null : null);
        this.rebuild();
    }
    setSelection(selection: PdfSelection | null): void { this.selection = selection; this.rebuild(); }
    setWindow(pages: readonly number[], zoom: number): void {
        if (this.zoom === zoom && this.pages.length === pages.length && pages.every((page, i) => page === this.pages[i])) return;
        this.pages = [...pages]; this.zoom = zoom; this.rebuild();
    }
    setVisible(visible: boolean): void {
        if (this.visible === visible) return;
        this.visible = visible;
        if (!visible) { this.geometry.setFindPage(null); this.cancel?.abort(); this.cancel = null; this.host.publish({ find: [], current: [], selection: [] }); }
        else { this.geometry.setFindPage(this.current?.page ?? null); this.rebuild(); }
    }
    async atOrAfter(hit: PdfFindHit, start: PdfFindStart, signal: AbortSignal): Promise<boolean> {
        if (hit.page !== start.page) return hit.page > start.page;
        const rect = await this.firstRect(hit, signal);
        return !rect || rect.y + rect.height >= start.y;
    }
    async reveal(hit: PdfFindHit, signal: AbortSignal): Promise<void> {
        // Start exact geometry concurrently: a cold page can already be queued
        // by find, and the pool promotes this select request to priority 0.
        const exact = this.firstRect(hit, signal).then(rect => ({ rect }), error => ({ error }));
        const approx = await this.host.approximate?.(hit, signal).catch(() => null);
        if (signal.aborted || this.disposed || !this.visible) throw abort();
        const revision = approx ? this.host.beginReveal?.(hit.page, approx) ?? null : null;
        const result = await exact;
        if (signal.aborted || this.disposed || !this.visible) throw abort();
        if ('error' in result) throw result.error;
        const rect = result.rect ?? { x: 0, y: 0, width: 0, height: 0 };
        if (revision !== null && this.host.correctReveal) this.host.correctReveal(hit.page, rect, revision);
        else this.host.reveal(hit.page, rect);
    }
    dispose(): void { this.disposed = true; this.geometry.setFindPage(null); this.cancel?.abort(); this.cancel = null; }

    private async firstRect(hit: PdfFindHit, signal: AbortSignal): Promise<Rect | undefined> {
        const reply = await this.geometry.get(hit.page, 0, signal);
        let deadline = performance.now() + 4;
        for (const chunk of pdfHighlightRuns({ text: reply.text, ...reply.sel }, hit.from, hit.to, 1 / this.zoom)) {
            if (signal.aborted || this.disposed) throw abort();
            if (chunk.length) return chunk[0];
            if (performance.now() >= deadline) { await task(); deadline = performance.now() + 4; }
        }
        return undefined;
    }
    private rebuild(): void {
        this.cancel?.abort();
        if (!this.visible || this.disposed) return;
        const controller = new AbortController(); this.cancel = controller;
        const pages = [...this.pages], hits = this.hits, current = this.current, selection = this.selection;
        const output: { find: Rect[]; current: Rect[]; selection: Rect[] } = { find: [], current: [], selection: [] };
        void (async () => {
            let deadline = performance.now() + 4;
            const add = async (reply: PdfSelectionReply, from: number, to: number, target: Rect[]) => {
                const page = this.host.pageRect(reply.page);
                if (!page) return;
                for (const chunk of pdfHighlightRuns({ text: reply.text, ...reply.sel }, from, to, 1 / this.zoom)) {
                    if (controller.signal.aborted) throw abort();
                    for (const rect of chunk) target.push({ ...rect, x: rect.x + page.x, y: rect.y + page.y });
                    if (performance.now() >= deadline) { await task(); deadline = performance.now() + 4; }
                }
            };
            for (const page of pages) {
                if (controller.signal.aborted) return;
                const pageHits = hits.filter(hit => hit.page === page);
                const range = selection && !selection.wholeDocument ? selectionRange(selection) : null;
                const selected = !!selection && (selection.wholeDocument || !!range && page >= range.start.page && page <= range.end.page);
                if (!pageHits.length && !selected) continue;
                const reply = await this.geometry.get(page, current?.page === page ? 0 : 2, controller.signal);
                for (const hit of pageHits) await add(reply, hit.from, hit.to, sameHit(hit, current) ? output.current : output.find);
                if (selected) {
                    const from = range && page === range.start.page ? range.start.offset : 0;
                    const to = range && page === range.end.page ? range.end.offset : reply.text.length;
                    await add(reply, from, to, output.selection);
                }
            }
            if (!controller.signal.aborted && this.visible && !this.disposed) this.host.publish(output);
        })().catch(error => { if (!controller.signal.aborted && !this.disposed) this.host.error(error); });
    }
}
