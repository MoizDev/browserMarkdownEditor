import { EditorView, ViewPlugin } from '@codemirror/view';

/* ── Tab from the scroller into the text ──────────────────────────────────
   After a tab click the note's `.cm-scroller` holds the keyboard (#35), and
   in Edit mode the next stop in the Tab order is the text itself, one level
   down. Left to the browser, Tab focused it with the caret wherever the
   selection was last left — the top of a note never clicked, pages above the
   reader — and the next key edited THERE and jumped the view to it
   (measured: Tab, Tab from mid-note indented line 1 into `    ## Section 0`,
   scrollTop 3016 → 23, and autosave wrote it). So a Tab from the scroller
   starts typing where the reader is: a caret already on screen stays put,
   anything else moves to the end of the first whole line in view, and with
   no such line Tab does nothing. Shift+Tab and Reading mode (whose text
   cannot be focused) are left to the browser.

   On `scrollDOM`, not in `domEventHandlers`, which CodeMirror binds to the
   content — the key never reaches it. The listener touches only its own view,
   so it is safe to bake into a state that outlives its pane (AGENTS.md). */

/** Whether `pos` is drawn inside the scroller's visible box. */
function onScreen(view: EditorView, pos: number): boolean {
    const box = view.scrollDOM.getBoundingClientRect();
    const at = view.coordsAtPos(pos); // null outside the drawn viewport
    return !!at && at.top >= box.top && at.bottom <= box.bottom;
}

/**
 * The END of the first non-blank line wholly in view — where a click to the
 * right of it puts the caret — or null when none fits (one paragraph, table or
 * diagram taller than the pane). A blank line is skipped: typed into, the one
 * under a table became a GFM table row elsewhere and glued the next paragraph
 * on (measured: `| delta | 4 |\nK\nAfterTable`). So is a block spanning
 * several lines: this app draws its tables, mermaid fences and `$$` blocks as
 * INLINE replacements over whole lines, which CodeMirror merges into one text
 * block (`BlockType.Text` cannot tell them apart), and a caret at their edge
 * would type into their source — or, on a fence, reveal the code under the
 * reader. The end rather than the start keeps a heading's `##`, a list's
 * bullet and a rule's `---`, all hidden at the line's start, from being typed
 * in front of.
 */
function lineInView(view: EditorView): number | null {
    const box = view.scrollDOM.getBoundingClientRect();
    const top = box.top - view.documentTop;
    const bottom = box.bottom - view.documentTop;
    const { doc } = view.state;
    for (let block = view.lineBlockAtHeight(top); block.top < bottom;) {
        const line = doc.lineAt(block.from);
        if (block.top >= top - 1 && block.bottom <= bottom + 1 && line.to === block.to && line.length > 0) return block.to;
        if (block.to >= doc.length) break;
        block = view.lineBlockAt(block.to + 1);
    }
    return null;
}

export const tabIntoText = ViewPlugin.fromClass(class {
    constructor(readonly view: EditorView) {
        view.scrollDOM.addEventListener('keydown', this.onKeyDown);
    }

    readonly onKeyDown = (event: KeyboardEvent): void => {
        const { view } = this;
        if (event.key !== 'Tab' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
        if (event.target !== view.scrollDOM || !view.state.facet(EditorView.editable)) return;
        event.preventDefault();
        if (!onScreen(view, view.state.selection.main.head)) {
            // Nothing to type into on screen (a table or paragraph fills it):
            // stay on the scroller rather than arm the off-screen caret —
            // measured: a Z typed after Tab over a 60-row table landed at the
            // top of the note and jumped the view 3221 → 28.
            const pos = lineInView(view);
            if (pos === null) return;
            view.dispatch({ selection: { anchor: pos }, userEvent: 'select' });
        }
        view.focus();
    };

    destroy() {
        this.view.scrollDOM.removeEventListener('keydown', this.onKeyDown);
    }
});
