import { useCallback, useLayoutEffect, useState } from 'react';
import { resetFileTimes } from '../utils/fileTimes';
import {
  collapsePaths as collapsePathsInStore, expandPaths as expandPathsInStore, toggleExpanded,
} from '../utils/expandedPaths';

export function useExplorerState(rootHandle: FileSystemDirectoryHandle | null) {
  useLayoutEffect(() => { resetFileTimes(); }, [rootHandle]);

  const [searchOpen, setSearchOpen] = useState(false);
  const closeSearch = useCallback(() => setSearchOpen(false), []);
  const openSearch = useCallback(() => setSearchOpen(true), []);

  const handleToggleExpand = useCallback((path: string) => { toggleExpanded(path); }, []);
  const expandPaths = useCallback((paths: string[]) => { expandPathsInStore(paths); }, []);
  const collapsePaths = useCallback((paths: string[]) => { collapsePathsInStore(paths); }, []);
  return { searchOpen, setSearchOpen, openSearch, closeSearch, handleToggleExpand, expandPaths, collapsePaths };
}
