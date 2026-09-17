import { keymap, runScopeHandlers } from '@codemirror/view';
import type { Command, EditorView } from '@codemirror/view';
import {
    closeSearchPanel,
    findNext,
    findPrevious,
    getSearchQuery,
    openSearchPanel,
    searchPanelOpen,
    setSearchQuery,
} from '@codemirror/search';
import { releaseScrollAnchor } from './scrollAnchor';

/* ── The search keys, for a note that cannot take focus ───────────────────
   CodeMirror runs a keymap only for key presses aimed at `.cm-content`, and a
   note in Reading mode cannot be focused (editor/readingMode.ts) — so its
   `searchKeymap` never saw ⌘F there, and Chrome's find bar opened instead.
   That bar only searches what is in the page: the lines drawn near the
   viewport (measured: 47 of an 805-line note) and nothing under a collapsed
   heading's "…" pill. It reported "not found" for text in the note (#17).

   These are the same keys, bound in a scope CodeMirror never runs itself and
   run by DocumentPane's window listener for the focused note pane only —
   after CodeMirror has had its turn, so nothing is handled twice.

   Escape is deliberately absent. Several app surfaces close on an Escape
   nobody stopped (the backlinks popover, the vault menu), and the panel's own
   Escape already works whenever the keyboard is in the panel. */
const SCOPE = 'note-search';

/** A jump started from outside the editor must let go of a held scroll place
 *  first: its scroll arrives as an effect, which the hold cannot see, so the
 *  re-pin would drag the view back from the match (releaseScrollAnchor).
 *  ⌘F is NOT wrapped — opening the panel moves nothing, and the hold should
 *  keep the restored place while the background parse settles; typing in the
 *  panel is input inside the editor and releases it anyway. */
const jumpFromOutside = (command: Command): Command => (view) => {
    releaseScrollAnchor(view);
    return command(view);
};
const nextFromOutside = jumpFromOutside(findNext);
const previousFromOutside = jumpFromOutside(findPrevious);

/** Add to the note's state, beside `searchKeymap`: `runScopeHandlers` reads
 *  the keymap from the state. */
export const noteSearchKeymap = keymap.of([
    { key: 'Mod-f', run: openSearchPanel, scope: SCOPE },
    { key: 'Mod-g', run: nextFromOutside, shift: previousFromOutside, scope: SCOPE, preventDefault: true },
    { key: 'F3', run: nextFromOutside, shift: previousFromOutside, scope: SCOPE, preventDefault: true },
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
 * to a tab put it in Find, so Space and PageDown stopped scrolling the note and
 * the next keystroke replaced the query. `before` is where the keyboard was
 * before the view moved it.
 */
export function returnKeyboard(view: EditorView, before: Element | null): void {
    const now = view.root.activeElement;
    if (now === before || !(now instanceof HTMLElement) || !view.dom.contains(now)) return;
    now.blur();
    if (before instanceof HTMLElement && before.isConnected) before.focus({ preventScroll: true });
}
