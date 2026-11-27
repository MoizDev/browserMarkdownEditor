import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getSearchRequest, subscribeSearchRequest } from '../utils/searchRequest';
import { readStoredValue, writeStoredValue } from '../utils/storage';

export interface UseSidebarDeps {
  setSearchOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

export function useSidebar(deps: UseSidebarDeps) {
  const { setSearchOpen } = deps;

  const [sidebarWidth, setSidebarWidth] = useState<number>(260);

  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => readStoredValue('sidebarCollapsed') === 'true');
  useEffect(() => subscribeSearchRequest(() => {
    if (!getSearchRequest()) return;
    setSidebarCollapsed(false);
    setSearchOpen(true);
  }), [setSearchOpen]);
  useEffect(() => {
    writeStoredValue('sidebarCollapsed', String(sidebarCollapsed));
  }, [sidebarCollapsed]);
  const collapseSidebar = useCallback(() => setSidebarCollapsed(true), []);

  const [isDraggingSidebar, setIsDraggingSidebar] = useState<boolean>(false);
  const isResizing = useRef<boolean>(false);
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
