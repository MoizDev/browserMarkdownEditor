import { EditorView, keymap, runScopeHandlers } from '@codemirror/view';
import { findNext, findPrevious, openSearchPanel, searchPanelOpen } from '@codemirror/search';

/* ── The search keys, for a note that cannot take focus ───────────────────
   CodeMirror runs a keymap only for key presses aimed at `.cm-content`, and a
   note's text cannot be focused in Reading mode (editor/readingMode.ts) — so its
   `searchKeymap` never saw ⌘F there, and Chrome's find bar opened instead.
   That bar only searches what is in the page: the lines drawn near the
   viewport (measured: 47 of an 805-line note) and nothing under a collapsed
   heading's "…" pill. It reported "not found" for text in the note (#17).

   These are the same keys, bound in a scope CodeMirror never runs itself and
   run by DocumentPane's window listener for the focused note pane only —
   after CodeMirror has had its turn, so nothing is handled twice.

   Escape is deliberately absent. The backlinks popover and the vault menu
   close on an Escape nobody handled (utils/escapeDismiss.ts), so one bound
   here would close the bar from a pane that merely has it open — reaching
   past those surfaces. The panel's own keymap already handles, and prevents,
   Escape whenever the keyboard is in the panel, which is what lets those
   surfaces stay open on that press (#36). */
const SCOPE = 'note-search';

/** Add to the note's state, beside `searchKeymap`: `runScopeHandlers` reads
 *  the keymap from the state. */
export const noteSearchKeymap = keymap.of([
    { key: 'Mod-f', run: openSearchPanel, scope: SCOPE },
    { key: 'Mod-g', run: findNext, shift: findPrevious, scope: SCOPE, preventDefault: true },
    { key: 'F3', run: findNext, shift: findPrevious, scope: SCOPE, preventDefault: true },
]);

/** Run `event` against the note's search keys. True when it was one of them,
 *  in which case the browser's own find is cancelled — `runScopeHandlers`
 *  reports a handled key but leaves the event alone. */
export function runNoteSearchKey(view: EditorView, event: KeyboardEvent): boolean {
    if (!runScopeHandlers(view, event, SCOPE)) return false;
    event.preventDefault();
    return true;
}

/**
 * Undo a focus move the view made by itself. A search panel takes the keyboard
 * as it MOUNTS (`FindPanel.mount()` selects its Find field) — whenever a pane
 * builds its view from a cached state whose panel was left open. Neither is the reader asking for the keyboard: returning
 * to a tab put it in Find, so the next keystroke replaced the query. `before`
 * is where the keyboard was before the view moved it — `<body>`, after a
 * tab-bar click, which scrolls nothing either; EditorPane's handKeyboardToNote
 * then gives it to the note's scroller, and that is what lets Space and
 * PageDown scroll the note.
 */
export function returnKeyboard(view: EditorView, before: Element | null): void {
    const now = view.root.activeElement;
    if (now === before || !(now instanceof HTMLElement) || !view.dom.contains(now)) return;
    now.blur();
    if (before instanceof HTMLElement && before.isConnected) before.focus({ preventScroll: true });
}

/**
 * Give the keyboard to the note's scroller when its search bar closes with the
 * keyboard in it and nowhere else to go. Escape (or the bar's ×) runs
 * `closeSearchPanel`, whose `view.focus()` is a no-op in Reading mode — the
 * text cannot take focus — so the Find field was removed with the keyboard in
 * it and it fell to `<body>`: tab click → ⌘F → Escape → PageDown did nothing,
 * the dead keys of #35 one step further on (measured: scrollTop 3021 → 3021).
 *
 * Only on CLOSE, so a panel that has just taken the keyboard is never robbed;
 * and only from `<body>`, so Edit mode — whose close already put the caret back
 * in the text — and a keyboard held anywhere else are left alone. Touches
 * nothing but `update.view`, so it is safe to bake into a state that outlives
 * its pane.
 */
export const keyboardAfterSearchClose = EditorView.updateListener.of((update) => {
    if (!searchPanelOpen(update.startState) || searchPanelOpen(update.state)) return;
    const active = update.view.root.activeElement;
    if (active && active !== update.view.dom.ownerDocument.body) return;
    update.view.scrollDOM.focus({ preventScroll: true });
});
