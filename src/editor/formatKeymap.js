import { keymap, EditorView } from '@codemirror/view';
import { Prec } from '@codemirror/state';

/**
 * Wraps the current selection with a delimiter (e.g., `**` for bold, `*` for italic).
 * If no selection, inserts the delimiters and places the cursor between them.
 */
function wrapSelection(view, delimiter) {
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

/**
 * Markdown formatting bindings:
 *   Cmd/Ctrl+B → bold   (**text**)
 *   Cmd/Ctrl+I → italic (*text*)
 *
 * A direct keydown handler backs the keymap up — the browser's contenteditable
 * layer can otherwise eat Cmd+I via a `beforeinput: formatItalic` before the
 * keymap runs.
 */
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

export const markdownFormatExtension = [Prec.highest(formatKeymap), formatKeydownFallback];
