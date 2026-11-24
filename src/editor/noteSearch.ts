import { EditorView, keymap, runScopeHandlers } from '@codemirror/view';
import {
    closeSearchPanel,
    findNext,
    findPrevious,
    getSearchQuery,
    openSearchPanel,
    searchPanelOpen,
    setSearchQuery,
} from '@codemirror/search';

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
 * Rebuild an open search panel after a mode switch, so its Replace row matches
 * the new mode. `SearchPanel` decides whether to draw Replace ONCE, in its
 * constructor (@codemirror/search 6.6.0: `view.state.readOnly ? [] : [br,
 * replaceField, replace, replaceAll]`), so a panel carried across ⌘E kept the
 * old mode's row: visible-but-dead Replace buttons while reading, none while
 * editing. `togglePanel` is not exported (and off+on in one transaction keeps
 * the same panel instance), hence close + open.
 *
 * `wasReadOnly` is the state's `readOnly` before the reconfigure; a switch that
 * did not change it leaves the panel alone. The keyboard stays where it was,
 * and so does the caret in the panel's fields.
 */
export function rebuildSearchPanelForMode(view: EditorView, wasReadOnly: boolean): void {
    if (view.state.readOnly === wasReadOnly || !searchPanelOpen(view.state)) return;
    const query = getSearchQuery(view.state);
    const before = view.root.activeElement;
    const held = before instanceof HTMLElement && view.dom.querySelector('.cm-search')?.contains(before)
        ? before : null;
    const caret = held instanceof HTMLInputElement && held.selectionStart !== null
        ? { start: held.selectionStart, end: held.selectionEnd ?? held.selectionStart, direction: held.selectionDirection ?? undefined }
        : null;
    closeSearchPanel(view);
    openSearchPanel(view);
    // openSearchPanel re-seeds the query from a short selection — after a
    // search, the match itself — which would turn a regexp into its literal hit.
    view.dispatch({ effects: setSearchQuery.of(query) });

    // The new panel's mount() focused its Find field with ALL its text
    // selected. Outside the panel that is theft (⌘E from the header button):
    // hand it back.
    if (!held) {
        returnKeyboard(view, before);
        return;
    }
    // Inside it, that selection made ⌘E mid-word wipe the query on the next
    // keystroke (measured: `zebr`, ⌘E, `a` → Find read `a`). Put the keyboard
    // back on the same control — by tag as well as name, since the Replace
    // field and its button are both `name="replace"` — and its caret where it
    // was. A control the new mode does not draw (Replace, going into Reading)
    // leaves the caret at the end of Find instead.
    const panel = view.dom.querySelector('.cm-search');
    const name = held.getAttribute('name');
    const same = name ? panel?.querySelector(`${held.tagName.toLowerCase()}[name="${name}"]`) : null;
    if (same instanceof HTMLElement) {
        same.focus({ preventScroll: true });
        if (caret && same instanceof HTMLInputElement) same.setSelectionRange(caret.start, caret.end, caret.direction);
        return;
    }
    const find = panel?.querySelector('input[main-field]');
    if (find instanceof HTMLInputElement) {
        find.focus({ preventScroll: true });
        find.setSelectionRange(find.value.length, find.value.length);
    }
}

/**
 * Undo a focus move the view made by itself. A search panel takes the keyboard
 * as it MOUNTS (`SearchPanel.mount()` selects its Find field) — on a mode
 * switch above, and whenever a pane builds its view from a cached state whose
 * panel was left open. Neither is the reader asking for the keyboard: returning
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
 *
 * `rebuildSearchPanelForMode`'s close-then-open passes through here too: from
 * `<body>` the scroller is focused for a moment, until the reopened panel takes
 * the keyboard and `returnKeyboard` puts it back. That is a real focus event,
 * harmless only because a mode changes on the FOCUSED pane alone (App's ⌘E,
 * the header toggle) and a view being built ignores it (`buildingViewRef`) —
 * anything that switches a background pane's mode would move a split's focus.
 */
export const keyboardAfterSearchClose = EditorView.updateListener.of((update) => {
    if (!searchPanelOpen(update.startState) || searchPanelOpen(update.state)) return;
    const active = update.view.root.activeElement;
    if (active && active !== update.view.dom.ownerDocument.body) return;
    update.view.scrollDOM.focus({ preventScroll: true });
});
