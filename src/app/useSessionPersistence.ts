import { useEffect, useRef } from 'react';
import type { TabLayout } from '../types';
import { setRecordScope } from '../utils/storage';
import { focusedPath as focusedPathOf } from '../utils/tabPanes';
import { writeSession } from '../utils/tabSessions';

export interface UseSessionPersistenceDeps {
  rootHandle: FileSystemDirectoryHandle | null;
  currentVaultId: string | null;
  layout: TabLayout;
  indexRestoreSettled: () => void;
}

export function useSessionPersistence(deps: UseSessionPersistenceDeps) {
  const { rootHandle, currentVaultId, layout, indexRestoreSettled } = deps;
  const sessionRootRef = useRef<FileSystemDirectoryHandle | null>(null);
  const sessionVaultIdRef = useRef<string | null | undefined>(undefined);
  const restoringRef = useRef<object | null>(null);
  const sessionSealedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!rootHandle) return;
    const timer = setTimeout(() => {
      if (sessionRootRef.current !== rootHandle && !restoringRef.current) indexRestoreSettled();
    }, 2000);
    return () => clearTimeout(timer);
  }, [rootHandle, indexRestoreSettled]);

  useEffect(() => { setRecordScope(currentVaultId); }, [currentVaultId]);

  useEffect(() => {
    if (!currentVaultId) return;
    if (sessionRootRef.current !== rootHandle) return;
    if (sessionVaultIdRef.current !== currentVaultId) return;
    if (restoringRef.current) return;
    if (sessionSealedRef.current === currentVaultId) return;
    writeSession(currentVaultId, {
      v: 2,
      paths: layout.panes.flatMap(p => p.paths),
      groups: layout.panes.map(p => p.paths),
      focus: layout.panes.map(p => p.activePath),
      sizes: layout.sizes ?? null,
      active: focusedPathOf(layout),
    });
  }, [layout, currentVaultId, rootHandle]);
  return { sessionRootRef, sessionVaultIdRef, restoringRef, sessionSealedRef };
}
