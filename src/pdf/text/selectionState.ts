import type { PdfSelection, TextPoint } from './selection';

export interface SelectionGeometryOwner {
    setEndpoints(pages: readonly number[]): void;
    setVisible(visible: boolean): void;
}
export interface PdfSelectionSnapshot { readonly docKey: string; readonly selection: PdfSelection | null }

/** The pane, not its mounted overlay, owns this store. Camera changes and Text
 * round trips never alter canonical offsets; new immutable bytes do. */
export class PdfSelectionState {
    private snapshot: PdfSelectionSnapshot;
    private readonly listeners = new Set<() => void>();
    private geometry?: SelectionGeometryOwner;
    private visible = true;
    constructor(docKey: string) { this.snapshot = { docKey, selection: null }; }
    getSnapshot = (): PdfSelectionSnapshot => this.snapshot;
    subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
    attachGeometry(geometry: SelectionGeometryOwner): () => void {
        this.geometry = geometry;
        geometry.setEndpoints(this.endpoints());
        geometry.setVisible(this.visible);
        return () => { if (this.geometry === geometry) this.geometry = undefined; };
    }
    setDocument(docKey: string): void {
        if (docKey === this.snapshot.docKey) return;
        this.snapshot = { docKey, selection: null };
        this.geometry?.setEndpoints([]);
        this.emit();
    }
    set(selection: PdfSelection | null): void {
        if (selection && selection.docKey !== this.snapshot.docKey) return;
        const copy = selection ? { ...selection, anchor: { ...selection.anchor }, focus: { ...selection.focus } } : null;
        this.snapshot = { docKey: this.snapshot.docKey, selection: copy };
        this.geometry?.setEndpoints(this.endpoints());
        this.emit();
    }
    clear(): void { if (this.snapshot.selection) this.set(null); }
    begin(point: TextPoint, granularity: PdfSelection['granularity'] = 'char', extend = false): void {
        const previous = this.snapshot.selection;
        if (extend && previous) this.set({ ...previous, focus: point, wholeDocument: false });
        else this.set({ docKey: this.snapshot.docKey, anchor: point, focus: point, granularity, wholeDocument: false });
    }
    extend(point: TextPoint): void {
        const selection = this.snapshot.selection;
        if (selection) this.set({ ...selection, focus: point, wholeDocument: false });
    }
    selectAll(pageCount: number): void {
        if (!Number.isSafeInteger(pageCount) || pageCount <= 0) { this.clear(); return; }
        this.set({ docKey: this.snapshot.docKey, wholeDocument: true, granularity: 'char',
            anchor: { page: 0, offset: 0, affinity: 'before' },
            focus: { page: pageCount - 1, offset: Number.MAX_SAFE_INTEGER, affinity: 'after' } });
    }
    setVisible(visible: boolean): void { this.visible = visible; this.geometry?.setVisible(visible); }
    private endpoints(): number[] {
        const s = this.snapshot.selection;
        return s ? [...new Set([s.anchor.page, s.focus.page])] : [];
    }
    private emit(): void { for (const listener of this.listeners) listener(); }
}
