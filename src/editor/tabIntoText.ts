import { EditorView, ViewPlugin } from '@codemirror/view';

function onScreen(view: EditorView, pos: number): boolean {
    const box = view.scrollDOM.getBoundingClientRect();
    const at = view.coordsAtPos(pos);
    return !!at && at.top >= box.top && at.bottom <= box.bottom;
}

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
