import { useEffect } from 'react';

/**
 * Is this keystroke ⌘/Ctrl + `letter`, whatever case the OS reported?
 *
 * `e.key` carries the CHARACTER the layout produced, so with Caps Lock on it is
 * `'E'` and a bare `e.key === 'e'` silently stops matching — ⌘E just did
 * nothing, with no feedback of any kind, for as long as the light was on.
 * Lower-casing is the fix; the `shiftKey` test is what keeps it honest.
 *
 * Caps Lock and Shift are indistinguishable in `e.key` — both give `'E'` — and
 * `e.shiftKey` is the only thing that tells them apart. It is tested rather
 * than ignored because ⌘⇧S / ⌘⇧N / ⌘⇧E are conventionally DIFFERENT commands
 * (Save As, New Window, …): firing the unshifted action on them would both
 * surprise the user and spend three chords this app may want later. So Caps
 * Lock is accepted and Shift is declined, which is exactly the distinction a
 * user would draw.
 */
function isCmdLetter(e: KeyboardEvent, letter: string): boolean {
  return (e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === letter;
}

export interface UseGlobalShortcutsDeps {
  flushTab: (path: string | null, force?: boolean) => unknown;
  handleNewNote: () => Promise<void>;
  toggleTabMode: (path: string | null) => void;
  activeTabPathRef: { readonly current: string | null };
  setSidebarCollapsed: (update: (collapsed: boolean) => boolean) => void;
}

/** The app-wide chords: ⌘S, ⌘N, ⌘E and ⌘\ (⌘⇧X and ⌃` are useSidePanels'). */
export function useGlobalShortcuts(deps: UseGlobalShortcutsDeps): void {
  const { flushTab, handleNewNote, toggleTabMode, activeTabPathRef, setSidebarCollapsed } = deps;
  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // ⌘E from inside the agent panel is not about the note behind it — the
      // reader is typing a message, and flipping the focused document's mode
      // from there would be a change they cannot see happen. ⌘S and ⌘N stay
      // app-wide (saving, a new note), and so does ⌘\; ⌘⇧X is below.
      // The terminal likewise: there ⌘E is the shell's (and on Windows/Linux,
      // Ctrl+E is readline's end-of-line).
      const inSidePanel = e.target instanceof Element && !!e.target.closest('[data-agent-panel], [data-terminal]');
      if (isCmdLetter(e, 's')) {
        e.preventDefault();
        flushTab(activeTabPathRef.current, true);
      }
      // Cmd+N — create new note in vault root. Through the same handler the
      // tab strip's + uses, so the two cannot drift; it draws the app's own
      // dialog and checks the vault itself, so there is nothing to gate here.
      if (isCmdLetter(e, 'n')) {
        e.preventDefault();
        void handleNewNote();
      }
      // Cmd+E — toggle read/edit mode of the active tab
      if (!inSidePanel && isCmdLetter(e, 'e')) {
        e.preventDefault();
        toggleTabMode(activeTabPathRef.current);
      }
      // Cmd+\ — collapse/expand the sidebar (Cmd+B is taken by bold)
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault();
        setSidebarCollapsed(c => !c);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleNewNote, flushTab, toggleTabMode, activeTabPathRef, setSidebarCollapsed]);
}
