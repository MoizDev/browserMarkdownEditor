import type React from 'react';
import { useCallback, useEffect } from 'react';
import type { FileSystemContextValue, FileTreeNode, OpenTab, TrashItem } from '../types';
import type { DocumentSessionStore } from '../utils/documentSessions';
import type { NativePolicy } from './types';
import type { Notify } from './useAppDialogs';
import { registerConversionRestore } from '../utils/conversionRestore';

/**
 * Restoring a file's pre-conversion copy from Trash, found by its recorded
 * digest. Registers the handler the file tree's context menu calls; it gives
 * nothing back to App.
 */
export interface UseConversionRestoreDeps {
  announce: (message: string) => void;
  notify: Notify;
  documentSessions: DocumentSessionStore;
  getVaultActivation: FileSystemContextValue['getVaultActivation'];
  handleIO: FileSystemContextValue['handleIO'];
  listTrash: FileSystemContextValue['listTrash'];
  readFileVersioned: FileSystemContextValue['readFileVersioned'];
  restoreConversionCopy: FileSystemContextValue['restoreConversionCopy'];
  rootHandle: FileSystemContextValue['rootHandle'];
  tabsRef: React.RefObject<OpenTab[]>;
  nativePoliciesRef: React.RefObject<Map<string, NativePolicy>>;
  trashInFlightRef: React.RefObject<boolean>;
  reconcileQueueRef: React.RefObject<Promise<void>>;
}

export function useConversionRestore(deps: UseConversionRestoreDeps): void {
  const {
    announce, notify, documentSessions, getVaultActivation, handleIO, listTrash, readFileVersioned,
    restoreConversionCopy, rootHandle, tabsRef, nativePoliciesRef, trashInFlightRef, reconcileQueueRef,
  } = deps;

  const restoreBeforeConversion = useCallback(async (node: FileTreeNode) =>
    (await import('./conversionRestore')).restoreBeforeConversion({
      announce, notify, documentSessions, getVaultActivation, handleIO, listTrash, readFileVersioned,
      restoreConversionCopy, rootHandle, tabsRef, nativePoliciesRef, trashInFlightRef, reconcileQueueRef,
    }, node), [
      announce, documentSessions, getVaultActivation, handleIO, listTrash, notify, readFileVersioned,
      restoreConversionCopy, rootHandle, nativePoliciesRef, reconcileQueueRef, tabsRef, trashInFlightRef,
    ]);
  useEffect(() => registerConversionRestore(node => { void restoreBeforeConversion(node); }), [restoreBeforeConversion]);
}
