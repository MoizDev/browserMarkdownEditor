import { EditorView, ViewPlugin } from '@codemirror/view';

const pendingReadingSelection = new WeakMap<EditorView, () => void>();
/** CM finishes synchronising its own selection after updateDOM. Restore the
 * widget's native selection only after that, with no transaction/undo entry. */
export const tableReadingSelection = [ViewPlugin.define(view => {
    // CM ignores a widget selection only when its ANCHOR is in the widget. A
    // forward prose→table range otherwise becomes a source-edge selection before
    // any presentation capture can run. Both endpoints belong to native reading.
    const onSelection = (event: Event) => {
        if (!view.state.readOnly) return;
        const sel = view.contentDOM.ownerDocument.getSelection();
        if (!sel?.anchorNode || !sel.focusNode || sel.isCollapsed
            || !view.contentDOM.contains(sel.anchorNode) || !view.contentDOM.contains(sel.focusNode)) return;
        const cell = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest('.cm-table-cell');
        if (cell(sel.anchorNode) || cell(sel.focusNode)) event.stopImmediatePropagation();
    };
    const doc = view.contentDOM.ownerDocument;
    doc.addEventListener('selectionchange', onSelection, true);
    return {
        update(update) {
            if (update.docChanged || !view.state.readOnly || pendingReadingSelection.has(view)) return;
            const sel = doc.getSelection();
            const inCell = (node: Node | null) => (node instanceof Element ? node : node?.parentElement)?.closest('.cm-table-cell');
            if (!inCell(sel?.anchorNode ?? null) && !inCell(sel?.focusNode ?? null)) return;
            const restore = captureReadingSelection(view);
            if (restore) pendingReadingSelection.set(view, restore);
        },
        destroy() { doc.removeEventListener('selectionchange', onSelection, true); }
    };
}), EditorView.updateListener.of(update => {
    const restore = pendingReadingSelection.get(update.view);
    if (restore) {
        pendingReadingSelection.delete(update.view);
        restore();
    }
})];

// Each endpoint has its own representation: CM source or table/cell + rendered
// UTF-16 offset. Mixed and backwards selections must have one owner, too.
export function captureReadingSelection(view: EditorView): (() => void) | null {
    const sel = view.contentDOM.ownerDocument.getSelection();
    if (!sel?.anchorNode || !sel.focusNode || sel.isCollapsed
        || !view.contentDOM.contains(sel.anchorNode) || !view.contentDOM.contains(sel.focusNode)) return null;
    function endpoint(node: Node, offset: number) {
        const cell = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>('.cm-table-cell');
        const table = cell?.closest<HTMLElement>('table');
        if (cell && table) {
            const range = table.ownerDocument.createRange(); range.setStart(cell, 0); range.setEnd(node, offset);
            return { table, row: cell.dataset.row, col: cell.dataset.col, offset: range.toString().length };
        }
        return { pos: view.posAtDOM(node, offset) };
    }
    try {
        const anchor = endpoint(sel.anchorNode, sel.anchorOffset), focus = endpoint(sel.focusNode, sel.focusOffset);
        const doc = view.state.doc;
        return () => {
            if (view.state.doc !== doc) return;
            function point(saved: ReturnType<typeof endpoint>) {
                if ('pos' in saved) return view.domAtPos(saved.pos!);
                const cell = saved.table.querySelector<HTMLElement>(`.cm-table-cell[data-row="${saved.row}"][data-col="${saved.col}"]`);
                if (!cell?.isConnected) return null;
                let offset = saved.offset;
                const walker = cell.ownerDocument.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
                for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                    const length = node.nodeValue?.length ?? 0;
                    if (offset <= length) return { node, offset };
                    offset -= length;
                }
                return { node: cell, offset: cell.childNodes.length };
            }
            const a = point(anchor), f = point(focus);
            if (a && f) sel.setBaseAndExtent(a.node, a.offset, f.node, f.offset);
        };
    } catch { return null; }
}
export function preserveTableReadingSelection(table: HTMLElement, view: EditorView): (() => void) | null {
    // A second table updates after the first has destroyed its endpoint. Keep the
    // first whole-range capture until CM's update listener restores it once.
    return pendingReadingSelection.get(view) ?? captureReadingSelection(view);
}

/** Queue only after the widget DOM has been re-dressed. */
export function queueTableReadingSelection(view: EditorView, restore: () => void): void {
    pendingReadingSelection.set(view, restore);
}
