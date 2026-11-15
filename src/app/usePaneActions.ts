import type React from 'react';
import { useCallback } from 'react';
import type { OpenTab, TabLayout } from '../types';
import type { SetLayout } from './types';
import { closePane as closePaneIn, focusTab, goBack, goForward, moveTabToPane, paneById, selectTab as selectTabIn, setPaneSizes, splitToPane } from '../utils/tabPanes';
import { getReadingSurface } from '../utils/documentReading';

/**
 * The pane header's and the tab strip's actions: closing a column, focusing,
 * selecting and moving tabs between columns, dividing the width, and the ← →
 * history of each column. Each waits for the document's reading checkpoint
 * before it moves, so the view it leaves is the one it was reading.
 */
export interface UsePaneActionsDeps {
  layoutRef: React.RefObject<TabLayout>;
  setLayout: SetLayout;
  tabsRef: React.RefObject<OpenTab[]>;
  rootHandleRef: React.RefObject<FileSystemDirectoryHandle | null>;
  currentVaultIdRef: React.RefObject<string | null>;
  readerEpochRef: React.RefObject<{ root: FileSystemDirectoryHandle | null; epoch: number }>;
  closeDocuments: (paths: readonly string[], hide: () => void) => void;
}

export function usePaneActions(deps: UsePaneActionsDeps) {
  const {
    layoutRef, setLayout, tabsRef, rootHandleRef, currentVaultIdRef, readerEpochRef, closeDocuments,
  } = deps;

  /**
   * Close a whole column — every document in it. What the pane header's
   * ⋯ menu means by *Close this pane*; a tab's own × closes just that one.
   *
   * Every tab is drained and saved before release, including hidden tabs.
   * Read through `layoutRef` rather than `layout` so this keeps its identity
   * for the app's life: it is baked into a pane's chrome, which outlives the
   * render that raised the menu.
   */
  const closePaneAndTabs = useCallback((paneId: string) => {
    const pane = paneById(layoutRef.current, paneId);
    if (!pane) return;
    closeDocuments(pane.paths, () => setLayout(l => closePaneIn(l, paneId)));
  }, [closeDocuments, layoutRef, setLayout]);

  /** A click on a tab: its column takes focus and fronts it. Path-explicit AND
   *  pane-explicit — two columns may hold tabs with the same name, and the id
   *  is what says which strip was clicked. */
  const selectTabInPane = useCallback(
    (paneId: string, path: string) => {
      const outgoing=paneById(layoutRef.current,paneId)?.activePath,tab=tabsRef.current.find(t=>t.file.path===outgoing),root=rootHandleRef.current;
      const select=()=>{if(rootHandleRef.current===root&&paneById(layoutRef.current,paneId)?.activePath===outgoing)setLayout(l=>selectTabIn(l,paneId,path))};
      const checkpoint=tab&&outgoing!==path&&getReadingSurface({vaultId:currentVaultIdRef.current??'',vaultEpoch:readerEpochRef.current.epoch,documentId:tab.id,byteGeneration:tab.representation.generation})?.captureReading?.();
      if(checkpoint)return checkpoint.catch(()=>{}).then(select);else select();
    }, [currentVaultIdRef, layoutRef, readerEpochRef, rootHandleRef, setLayout, tabsRef]);
  const focusPane = useCallback((path: string) => setLayout(l => focusTab(l, path)), [setLayout]);
  /** A tab dropped on the editor body: it leaves its column and becomes one of
   *  its own at `at`. Refused past MAX_PANES by splitToPane itself. */
  const splitTabToPane = useCallback((path: string, at: number) => {
    const tab=tabsRef.current.find(t=>t.file.path===path),root=rootHandleRef.current;
    const split=()=>{if(rootHandleRef.current===root&&tabsRef.current.some(t=>t.id===tab?.id))setLayout(l=>splitToPane(l,path,at))};
    const checkpoint=tab&&getReadingSurface({vaultId:currentVaultIdRef.current??'',vaultEpoch:readerEpochRef.current.epoch,documentId:tab.id,byteGeneration:tab.representation.generation})?.captureReading?.();
    if(checkpoint)void checkpoint.catch(()=>{}).then(split);else split();
  }, [currentVaultIdRef, readerEpochRef, rootHandleRef, setLayout, tabsRef]);
  /** A tab dragged within its own strip (a reorder) or into another one.
   *  `toIndex` indexes the destination's tabs as they were DRAWN, which is
   *  where the drop indicator sat. */
  const moveTab = useCallback((path: string, toPaneId: string, toIndex: number) => {
    const tab=tabsRef.current.find(t=>t.file.path===path),root=rootHandleRef.current;
    const move=()=>{if(rootHandleRef.current===root&&tabsRef.current.some(t=>t.id===tab?.id))setLayout(l=>moveTabToPane(l,path,toPaneId,toIndex))};
    const checkpoint=tab&&getReadingSurface({vaultId:currentVaultIdRef.current??'',vaultEpoch:readerEpochRef.current.epoch,documentId:tab.id,byteGeneration:tab.representation.generation})?.captureReading?.();
    if(checkpoint)void checkpoint.catch(()=>{}).then(move);else move();
  }, [currentVaultIdRef, readerEpochRef, rootHandleRef, setLayout, tabsRef]);
  /** How the editor divides its width between its columns; null evens them up.
   *  One update at the END of a divider drag, never per frame: the persist
   *  effect is keyed on `layout`, so a live commit would write the whole
   *  session to localStorage sixty times a second. EditorPane holds the widths
   *  in flight and hands the settled row over here. */
  const resizePanes = useCallback(
    (sizes: number[] | null) => setLayout(l => setPaneSizes(l, sizes)), [setLayout]);
  /** The pane header's ← and →. Per COLUMN: each remembers the tabs it has
   *  shown, so stepping back in one leaves its neighbours alone. Session-only
   *  (the stored session records no history), so both read as disabled right
   *  after a reload. */
  const paneBack = useCallback((paneId: string) => setLayout(l => goBack(l, paneId)), [setLayout]);
  const paneForward = useCallback((paneId: string) => setLayout(l => goForward(l, paneId)), [setLayout]);

  return {
    closePaneAndTabs, selectTabInPane, focusPane, splitTabToPane, moveTab, resizePanes, paneBack, paneForward,
  };
}
