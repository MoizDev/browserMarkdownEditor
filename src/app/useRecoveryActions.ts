import type React from 'react';
import { useCallback } from 'react';
import type { FileSystemContextValue, OpenTab } from '../types';
import type { MarkdownSessionHost } from '../editor/markdownSession.types';
import type { DocumentBufferStore } from '../utils/documentBuffers';
import type { RecoveryEntry } from '../utils/recoveryJournal';
import type { RecoveryInspection } from '../components/RecoverySurface';

/** Everything the recovery actions read from App. Refs are App's own `useRef`s. */
export interface UseRecoveryActionsDeps {
  // useFileSystem()
  getVaultActivation: FileSystemContextValue['getVaultActivation'];
  rootHandle: FileSystemContextValue['rootHandle'];
  currentVaultId: FileSystemContextValue['currentVaultId'];
  recentVaults: FileSystemContextValue['recentVaults'];
  handleIO: FileSystemContextValue['handleIO'];
  resolveFileHandle: FileSystemContextValue['resolveFileHandle'];
  resolveVaultFile: FileSystemContextValue['resolveVaultFile'];
  readFileSnapshot: FileSystemContextValue['readFileSnapshot'];
  readBoardAsset: FileSystemContextValue['readBoardAsset'];
  putBoardAsset: FileSystemContextValue['putBoardAsset'];
  writeConflictCopy: FileSystemContextValue['writeConflictCopy'];
  writeFileVersioned: FileSystemContextValue['writeFileVersioned'];
  // App: vault refs, status line
  rootHandleRef: React.RefObject<FileSystemDirectoryHandle | null>;
  currentVaultIdRef: React.RefObject<string | null>;
  announce: (message: string) => void;
  // useOpenDocuments
  tabsRef: React.RefObject<OpenTab[]>;
  documentBuffers: DocumentBufferStore;
  markdownSessions: MarkdownSessionHost;
  contentOf: (path: string) => string | undefined;
  // useOutsideChanges
  hasUnsaved: (tab: OpenTab) => boolean;
}

export function useRecoveryActions(deps: UseRecoveryActionsDeps) {
  const {
    getVaultActivation, rootHandle, currentVaultId, recentVaults, handleIO, resolveFileHandle,
    resolveVaultFile, readFileSnapshot, readBoardAsset, putBoardAsset, writeConflictCopy, writeFileVersioned,
    rootHandleRef, currentVaultIdRef, announce, tabsRef, documentBuffers, markdownSessions, contentOf,
    hasUnsaved,
  } = deps;

  const inspectRecovery = useCallback(async (entry: RecoveryEntry): Promise<RecoveryInspection> =>
    (await import('./recoveryActions')).inspectRecovery({
      getVaultActivation, rootHandle, currentVaultId, recentVaults, handleIO, resolveFileHandle,
      resolveVaultFile, readFileSnapshot, readBoardAsset, rootHandleRef, currentVaultIdRef,
    }, entry), [
      rootHandle, currentVaultId, recentVaults, handleIO, resolveFileHandle, resolveVaultFile,
      readFileSnapshot, readBoardAsset, getVaultActivation, rootHandleRef, currentVaultIdRef,
    ]);

  const recoverEntry = useCallback(async (entry: RecoveryEntry) =>
    (await import('./recoveryActions')).recoverEntry({
      inspectRecovery, getVaultActivation, rootHandleRef, currentVaultIdRef, tabsRef, documentBuffers,
      markdownSessions, contentOf, hasUnsaved,
    }, entry), [
      hasUnsaved, inspectRecovery, contentOf, documentBuffers, markdownSessions, getVaultActivation,
      currentVaultIdRef, rootHandleRef, tabsRef,
    ]);

  const saveRecoveryCopy = useCallback(async (entry: RecoveryEntry) =>
    (await import('./recoveryActions')).saveRecoveryCopy({
      getVaultActivation, recentVaults, handleIO, resolveVaultFile, readFileSnapshot, putBoardAsset,
      writeConflictCopy, writeFileVersioned, rootHandleRef, currentVaultIdRef, announce, tabsRef, hasUnsaved,
    }, entry), [
      writeConflictCopy, resolveVaultFile, putBoardAsset, readFileSnapshot, writeFileVersioned, hasUnsaved,
      announce, recentVaults, handleIO, getVaultActivation, rootHandleRef, currentVaultIdRef, tabsRef,
    ]);

  return { inspectRecovery, recoverEntry, saveRecoveryCopy };
}
