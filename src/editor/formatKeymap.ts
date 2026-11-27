import { keymap, EditorView } from '@codemirror/view';
import { Prec } from '@codemirror/state';
import type { Extension } from '@codemirror/state';

function wrapSelection(view: EditorView, delimiter: string): boolean {
    const { state } = view;
    const { from, to } = state.selection.main;

    if (from === to) {
        const insert = delimiter + delimiter;
        view.dispatch({
            changes: { from, to, insert },
            selection: { anchor: from + delimiter.length },
        });
    } else {
        const selected = state.doc.sliceString(from, to);
        const wrapped = delimiter + selected + delimiter;
        view.dispatch({
            changes: { from, to, insert: wrapped },
            selection: { anchor: from + delimiter.length, head: from + delimiter.length + selected.length },
        });
    }
    return true;
}

const formatKeymap = keymap.of([
    { key: 'Mod-b', run: (view) => wrapSelection(view, '**') },
    { key: 'Mod-i', run: (view) => wrapSelection(view, '*') },
]);

const formatKeydownFallback = EditorView.domEventHandlers({
    keydown(event, view) {
        if (!(event.metaKey || event.ctrlKey)) return false;
        if (event.altKey || event.shiftKey) return false;
        const key = event.key.toLowerCase();
        if (key === 'b') {
            event.preventDefault();
            return wrapSelection(view, '**');
        }
        if (key === 'i') {
            event.preventDefault();
            return wrapSelection(view, '*');
        }
        return false;
    },
});

export const markdownFormatExtension: Extension[] = [Prec.highest(formatKeymap), formatKeydownFallback];
