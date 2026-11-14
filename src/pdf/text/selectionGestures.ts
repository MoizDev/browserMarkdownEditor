import { compareTextPoints, lineRange, wordRange } from './selection';
import type { PdfSelection, TextPoint } from './selection';
import type { PdfSelectionReply } from './selectionCache';
import type { PdfSelectionState } from './selectionState';

export interface PdfSelectionGestureHost {
    selection: PdfSelectionState;
    /** hit() must have loaded the page before returning its point. */
    cached(page: number): PdfSelectionReply | undefined;
    locale?(page: number, line: number): string | undefined;
}

/** Adapts pointer points into canonical word/line ranges without retaining
 * DOM or page geometry. A pane can discard/rebuild this adapter at will. */
export class PdfSelectionGestures {
    private seed: { start: TextPoint; end: TextPoint } | undefined;
    private fixedAnchor = false;
    constructor(private readonly host: PdfSelectionGestureHost) {}
    begin(point: TextPoint, granularity: PdfSelection['granularity'], extend: boolean): void {
        const existing = this.host.selection.getSnapshot().selection;
        if (extend && existing) {
            this.seed = undefined;
            this.fixedAnchor = true;
            this.extend(point);
            return;
        }
        const range = this.range(point, granularity);
        this.seed = range;
        this.fixedAnchor = false;
        this.host.selection.set({ docKey: this.host.selection.getSnapshot().docKey, anchor: range.start, focus: range.end,
            granularity, wholeDocument: false });
    }
    extend(point: TextPoint): void {
        const current = this.host.selection.getSnapshot().selection;
        if (!current) return;
        const range = this.range(point, current.granularity);
        if (this.fixedAnchor || !this.seed) {
            const backward = compareTextPoints(point, current.anchor) < 0;
            this.host.selection.set({ ...current, focus: backward ? range.start : range.end, wholeDocument: false });
            return;
        }
        const backward = compareTextPoints(point, this.seed.start) < 0;
        this.host.selection.set({ ...current, anchor: backward ? this.seed.end : this.seed.start,
            focus: backward ? range.start : range.end, wholeDocument: false });
    }
    private range(point: TextPoint, granularity: PdfSelection['granularity']): { start: TextPoint; end: TextPoint } {
        if (granularity === 'char') return { start: point, end: point };
        const page = this.host.cached(point.page);
        if (!page) return { start: point, end: point };
        const { lines, charU16 } = page.sel;
        for (let line = 0; line * 2 + 1 < lines.length; line++) {
            const bounds = lineRange(charU16, lines, line);
            if (!bounds || point.offset < bounds.from || point.offset > bounds.to) continue;
            const chosen = granularity === 'word' ? wordRange(page.text, bounds.from, bounds.to, point.offset, this.host.locale?.(point.page, line)) : bounds;
            return { start: { page: point.page, offset: chosen.from, affinity: 'before' },
                end: { page: point.page, offset: chosen.to, affinity: 'after' } };
        }
        return { start: point, end: point };
    }
}
