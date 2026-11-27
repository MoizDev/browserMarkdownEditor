import { useEffect } from 'react';

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

export function useGlobalShortcuts(deps: UseGlobalShortcutsDeps): void {
  const { flushTab, handleNewNote, toggleTabMode, activeTabPathRef, setSidebarCollapsed } = deps;
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const inSidePanel = e.target instanceof Element && !!e.target.closest('[data-agent-panel], [data-terminal]');
      if (isCmdLetter(e, 's')) {
        e.preventDefault();
        flushTab(activeTabPathRef.current, true);
      }
      if (isCmdLetter(e, 'n')) {
        e.preventDefault();
        void handleNewNote();
      }
      if (!inSidePanel && isCmdLetter(e, 'e')) {
        e.preventDefault();
        toggleTabMode(activeTabPathRef.current);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault();
        setSidebarCollapsed(c => !c);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleNewNote, flushTab, toggleTabMode, activeTabPathRef, setSidebarCollapsed]);
}
