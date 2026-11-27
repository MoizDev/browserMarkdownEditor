import type React from 'react';
import { useCallback } from 'react';
import type { OpenTab, TabLayout } from '../types';
import type { SetLayout } from './types';
import { closePane as closePaneIn, focusTab, goBack, goForward, moveTabToPane, paneById, selectTab as selectTabIn, setPaneSizes, splitToPane } from '../utils/tabPanes';
import { getReadingSurface } from '../utils/documentReading';

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

  const closePaneAndTabs = useCallback((paneId: string) => {
    const pane = paneById(layoutRef.current, paneId);
    if (!pane) return;
    closeDocuments(pane.paths, () => setLayout(l => closePaneIn(l, paneId)));
  }, [closeDocuments, layoutRef, setLayout]);

  const selectTabInPane = useCallback(
    (paneId: string, path: string) => {
      const outgoing=paneById(layoutRef.current,paneId)?.activePath,tab=tabsRef.current.find(t=>t.file.path===outgoing),root=rootHandleRef.current;
      const select=()=>{if(rootHandleRef.current===root&&paneById(layoutRef.current,paneId)?.activePath===outgoing)setLayout(l=>selectTabIn(l,paneId,path))};
      const checkpoint=tab&&outgoing!==path&&getReadingSurface({vaultId:currentVaultIdRef.current??'',vaultEpoch:readerEpochRef.current.epoch,documentId:tab.id,byteGeneration:tab.representation.generation})?.captureReading?.();
      if(checkpoint)return checkpoint.catch(()=>{}).then(select);else select();
    }, [currentVaultIdRef, layoutRef, readerEpochRef, rootHandleRef, setLayout, tabsRef]);
  const focusPane = useCallback((path: string) => setLayout(l => focusTab(l, path)), [setLayout]);
  const splitTabToPane = useCallback((path: string, at: number) => {
    const tab=tabsRef.current.find(t=>t.file.path===path),root=rootHandleRef.current;
    const split=()=>{if(rootHandleRef.current===root&&tabsRef.current.some(t=>t.id===tab?.id))setLayout(l=>splitToPane(l,path,at))};
    const checkpoint=tab&&getReadingSurface({vaultId:currentVaultIdRef.current??'',vaultEpoch:readerEpochRef.current.epoch,documentId:tab.id,byteGeneration:tab.representation.generation})?.captureReading?.();
    if(checkpoint)void checkpoint.catch(()=>{}).then(split);else split();
  }, [currentVaultIdRef, readerEpochRef, rootHandleRef, setLayout, tabsRef]);
  const moveTab = useCallback((path: string, toPaneId: string, toIndex: number) => {
    const tab=tabsRef.current.find(t=>t.file.path===path),root=rootHandleRef.current;
    const move=()=>{if(rootHandleRef.current===root&&tabsRef.current.some(t=>t.id===tab?.id))setLayout(l=>moveTabToPane(l,path,toPaneId,toIndex))};
    const checkpoint=tab&&getReadingSurface({vaultId:currentVaultIdRef.current??'',vaultEpoch:readerEpochRef.current.epoch,documentId:tab.id,byteGeneration:tab.representation.generation})?.captureReading?.();
    if(checkpoint)void checkpoint.catch(()=>{}).then(move);else move();
  }, [currentVaultIdRef, readerEpochRef, rootHandleRef, setLayout, tabsRef]);
  const resizePanes = useCallback(
    (sizes: number[] | null) => setLayout(l => setPaneSizes(l, sizes)), [setLayout]);
  const paneBack = useCallback((paneId: string) => setLayout(l => goBack(l, paneId)), [setLayout]);
  const paneForward = useCallback((paneId: string) => setLayout(l => goForward(l, paneId)), [setLayout]);

  return {
    closePaneAndTabs, selectTabInPane, focusPane, splitTabToPane, moveTab, resizePanes, paneBack, paneForward,
  };
}
