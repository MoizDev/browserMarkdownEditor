import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getSearchRequest, subscribeSearchRequest } from '../utils/searchRequest';
import { writeStoredValue } from '../utils/storage';

/** What the sidebar hook reads from App. */
export interface UseSidebarDeps {
  setSearchOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

export function useSidebar(deps: UseSidebarDeps) {
  const { setSearchOpen } = deps;

  // Sidebar resizing
  const [sidebarWidth, setSidebarWidth] = useState<number>(260);

  // Sidebar collapse (Cmd+\, the explorer-header button, or the rail) —
  // persisted, and collapsing leaves a thin rail so it can be re-expanded.
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => localStorage.getItem('sidebarCollapsed') === 'true');
  useEffect(() => subscribeSearchRequest(() => {
    if (!getSearchRequest()) return;
    setSidebarCollapsed(false);
    setSearchOpen(true);
  }), [setSearchOpen]);
  useEffect(() => {
    writeStoredValue('sidebarCollapsed', String(sidebarCollapsed));
  }, [sidebarCollapsed]);
  /** Stable for the app's life. As an inline arrow this handed `FileExplorer` a
   *  fresh prop on EVERY App render, which defeated its `React.memo` outright —
   *  the one thing that memo exists to prevent. */
  const collapseSidebar = useCallback(() => setSidebarCollapsed(true), []);

  // Suppresses the collapse animation while drag-resizing, so the width
  // tracks the pointer instead of easing 150ms behind it.
  const [isDraggingSidebar, setIsDraggingSidebar] = useState<boolean>(false);
  const isResizing = useRef<boolean>(false);
  // Drag-to-resize sidebar
  const startResize = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    isResizing.current = true;
    setIsDraggingSidebar(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return;
      const newWidth = Math.max(180, Math.min(600, e.clientX));
      setSidebarWidth(newWidth);
    };

    const onMouseUp = () => {
      isResizing.current = false;
      setIsDraggingSidebar(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, []);

  return {
    sidebarWidth,
    sidebarCollapsed, setSidebarCollapsed,
    isDraggingSidebar,
    collapseSidebar,
    startResize,
  };
}
