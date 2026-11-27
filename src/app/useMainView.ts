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

export function useMainView(deps: UseMainViewDeps) {
  const { rootHandle, rootHandleRef, currentVaultIdRef, readerEpochRef, tabsRef } = deps;
  const [mainView, setMainView] = useState<MainView>('editor');

  const contextMenu = useSyncExternalStore(subscribeContextMenu, getContextMenu);

  useEffect(() => { closeContextMenu(); }, [mainView, rootHandle]);

  const toggleGraph = useCallback(() => {
    const root = rootHandleRef.current;
    const captures = tabsRef.current.map(tab => getReadingSurface({vaultId:currentVaultIdRef.current??'',vaultEpoch:readerEpochRef.current.epoch,documentId:tab.id,byteGeneration:tab.representation.generation})?.captureReading?.());
    void Promise.allSettled(captures).then(() => { if(rootHandleRef.current===root)setMainView(v=>v==='graph'?'editor':'graph'); });
  }, [currentVaultIdRef, readerEpochRef, rootHandleRef, tabsRef]);
  return { mainView, setMainView, toggleGraph, contextMenu };
}
