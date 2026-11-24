import { useCallback, useLayoutEffect, useState } from 'react';
import { resetFileTimes } from '../utils/fileTimes';
import {
  collapsePaths as collapsePathsInStore, expandPaths as expandPathsInStore, toggleExpanded,
} from '../utils/expandedPaths';

/**
 * The sidebar explorer's own state: which tab it shows (files or search), the
 * expanded folders' callbacks, and the per-vault Modified-time sort.
 */
export function useExplorerState(rootHandle: FileSystemDirectoryHandle | null) {
  // Another vault reuses paths freely; its files' times are its own. A LAYOUT
  // effect, because every passive one runs after it: pickDirectory and
  // openRecentVault set the handle and the tree in one commit, and React runs
  // a child's passive effects before its parent's — so as a plain useEffect
  // this bumped the generation AFTER FileExplorer had started that vault's stat
  // walk, which then threw its own result away, and a Modified-time sort sat
  // in name order until something next rebuilt the tree.
  useLayoutEffect(() => { resetFileTimes(); }, [rootHandle]);

  /** Whether the sidebar shows vault search in place of the file tree — the
   *  explorer's Search tab, and its Files tab back. FileExplorer is memoized,
   *  so both callbacks have to be stable or the tree starts re-rendering while
   *  the user types. */
  const [searchOpen, setSearchOpen] = useState(false);
  const closeSearch = useCallback(() => setSearchOpen(false), []);
  const openSearch = useCallback(() => setSearchOpen(true), []);

  // Expanded folder paths live in a store, not in state (utils/expandedPaths.ts):
  // as a `Set` prop they re-rendered every mounted row of the tree to turn one
  // chevron. These wrappers keep the callbacks App already hands out.
  const handleToggleExpand = useCallback((path: string) => { toggleExpanded(path); }, []);
  const expandPaths = useCallback((paths: string[]) => { expandPathsInStore(paths); }, []);
  const collapsePaths = useCallback((paths: string[]) => { collapsePathsInStore(paths); }, []);
  return { searchOpen, setSearchOpen, openSearch, closeSearch, handleToggleExpand, expandPaths, collapsePaths };
}
