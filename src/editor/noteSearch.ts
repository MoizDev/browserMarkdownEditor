import { EditorView, keymap, runScopeHandlers } from '@codemirror/view';
import { findNext, findPrevious, openSearchPanel, searchPanelOpen } from '@codemirror/search';

const SCOPE = 'note-search';

export const noteSearchKeymap = keymap.of([
    { key: 'Mod-f', run: openSearchPanel, scope: SCOPE },
    { key: 'Mod-g', run: findNext, shift: findPrevious, scope: SCOPE, preventDefault: true },
    { key: 'F3', run: findNext, shift: findPrevious, scope: SCOPE, preventDefault: true },
]);

export function runNoteSearchKey(view: EditorView, event: KeyboardEvent): boolean {
    if (!runScopeHandlers(view, event, SCOPE)) return false;
    event.preventDefault();
    return true;
}

export function returnKeyboard(view: EditorView, before: Element | null): void {
    const now = view.root.activeElement;
    if (now === before || !(now instanceof HTMLElement) || !view.dom.contains(now)) return;
    now.blur();
    if (before instanceof HTMLElement && before.isConnected) before.focus({ preventScroll: true });
}

export const keyboardAfterSearchClose = EditorView.updateListener.of((update) => {
    if (!searchPanelOpen(update.startState) || searchPanelOpen(update.state)) return;
    const active = update.view.root.activeElement;
    if (active && active !== update.view.dom.ownerDocument.body) return;
    update.view.scrollDOM.focus({ preventScroll: true });
});
