import type React from 'react';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { MainView, OpenTab } from '../types';
import { getReadingSurface } from '../utils/documentReading';
import { closeContextMenu, getContextMenu, subscribeContextMenu } from '../utils/contextMenu';

export interface UseMainViewDeps {
  rootHandle: FileSystemDirectoryHandle | null;
  rootHandleRef: React.MutableRefObject<FileSystemDirectoryHandle | null>;
  currentVaultIdRef: React.MutableRefObject<string | null>;
  readerEpochRef: React.MutableRefObject<{ root: FileSystemDirectoryHandle | null; epoch: number }>;
  tabsRef: React.MutableRefObject<OpenTab[]>;
}

/** What fills the main area — the editor or the graph — and the app's
 *  right-click menu, which a change of either view or vault takes down. */
export function useMainView(deps: UseMainViewDeps) {
  const { rootHandle, rootHandleRef, currentVaultIdRef, readerEpochRef, tabsRef } = deps;
  // Main pane view ('editor' or 'graph' — the Neural Brain view)
  const [mainView, setMainView] = useState<MainView>('editor');

  // ── The app's own right-click menu ──────────────────────────────────────
  // One menu is on screen at a time, and every raiser — the editor, a table
  // cell, a file tree row — asks for it through the module store rather than
  // through a prop. See utils/contextMenu.ts: a CodeMirror widget's handlers
  // know nothing about React and outlive the pane that built them, and the
  // file tree is memoized specifically so it stops re-rendering while the user
  // types. Reading the store here is the whole of App's involvement.
  const contextMenu = useSyncExternalStore(subscribeContextMenu, getContextMenu);

  // A menu's rows close over a view — a CodeMirror view, a tree row — and both
  // of those go away when the workspace switches out from under them. Leaving
  // the menu on screen would leave rows that act on something unmounted.
  useEffect(() => { closeContextMenu(); }, [mainView, rootHandle]);

  /* The sidebar footer's buttons. Stable for the app's life for the reason
     `collapseSidebar` below spells out: SidebarFooter is memoized too, and one
     inline arrow here re-rendered it on every App render. */
  const toggleGraph = useCallback(() => {
    const root = rootHandleRef.current;
    const captures = tabsRef.current.map(tab => getReadingSurface({vaultId:currentVaultIdRef.current??'',vaultEpoch:readerEpochRef.current.epoch,documentId:tab.id,byteGeneration:tab.representation.generation})?.captureReading?.());
    void Promise.allSettled(captures).then(() => { if(rootHandleRef.current===root)setMainView(v=>v==='graph'?'editor':'graph'); });
  }, [currentVaultIdRef, readerEpochRef, rootHandleRef, tabsRef]);
  return { mainView, setMainView, toggleGraph, contextMenu };
}
