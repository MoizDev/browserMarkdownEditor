import type React from 'react';
import { useCallback, useRef } from 'react';
import type { ContentChangeOptions, DiskAction, FileSystemContextValue, OpenTab } from '../types';
import type { ReaderIdentity } from '../types/reading';
import { type ContentSource, type DocumentBufferStore } from '../utils/documentBuffers';
import type { DocumentSessionStore } from '../utils/documentSessions';
import type { DiskVersion } from '../utils/diskVersion';
import type { Ask, Tell } from './useAppDialogs';
import type { FlushTab, IndexGraphRef, NativePolicy, PdfRebuildEntry, RecoveryEvent, SetDiskState, SetTabs } from './types';
import { loadChunk } from '../platform/chunkLoad';

/** The App-scope values `useDiskBarActions` reads, named as App names them. */
export interface UseDiskBarActionsDeps {
  tabsRef: React.RefObject<OpenTab[]>;
  rootHandleRef: React.RefObject<FileSystemDirectoryHandle | null>;
  pdfRebuildRef: React.RefObject<Map<string, PdfRebuildEntry>>;
  diskStateRef: React.RefObject<Map<string, 'conflict' | 'deleted'>>;
  nativePoliciesRef: React.RefObject<Map<string, NativePolicy>>;
  bytesGenerationsRef: React.RefObject<Map<string, number>>;
  sessionReportRef: React.RefObject<(documentId: string, source: ContentSource, options?: ContentChangeOptions) => void>;
  retryUnreadTabRef: React.RefObject<(path: string) => Promise<boolean>>;
  indexGraphRef: IndexGraphRef;
  setTabs: SetTabs;
  setDiskState: SetDiskState;
  setPdfRebuildNotice: (id: string, notice: OpenTab['pdfRebuild']) => void;
  currentPdfOwner: (identity: ReaderIdentity) => OpenTab | undefined;
  keepPdfBaseline: (entry: PdfRebuildEntry, trashOwned?: boolean) => Promise<boolean>;
  flushTab: FlushTab;
  documentBuffers: DocumentBufferStore;
  documentSessions: DocumentSessionStore;
  removeTab: (path: string) => void;
  hasUnsaved: (tab: OpenTab) => boolean;
  reloadFromDisk: (tab: OpenTab, text: string, version: DiskVersion) => void;
  bumpBytesGeneration: (id: string, preserveNative?: boolean) => void;
  clearSaveTimer: (path: string) => void;
  syncExitGuard: () => void;
  recoveryEvent: RecoveryEvent;
  announce: (message: string) => void;
  ask: Ask;
  tell: Tell;
  getVaultActivation: FileSystemContextValue['getVaultActivation'];
  recreateFile: FileSystemContextValue['recreateFile'];
  resolveFileHandle: FileSystemContextValue['resolveFileHandle'];
  resolveVaultFile: FileSystemContextValue['resolveVaultFile'];
  readBytesVersioned: FileSystemContextValue['readBytesVersioned'];
  readFileVersioned: FileSystemContextValue['readFileVersioned'];
  writeFileVersioned: FileSystemContextValue['writeFileVersioned'];
  writeConflictCopy: FileSystemContextValue['writeConflictCopy'];
}

export function useDiskBarActions(deps: UseDiskBarActionsDeps) {
  const {
    tabsRef, rootHandleRef, pdfRebuildRef, diskStateRef, nativePoliciesRef, bytesGenerationsRef,
    sessionReportRef, retryUnreadTabRef, indexGraphRef, setTabs, setDiskState, setPdfRebuildNotice,
    currentPdfOwner, keepPdfBaseline, flushTab, documentBuffers, documentSessions, removeTab, hasUnsaved,
    reloadFromDisk, bumpBytesGeneration, clearSaveTimer, syncExitGuard, recoveryEvent, announce, ask, tell,
    getVaultActivation, recreateFile, resolveFileHandle, resolveVaultFile, readBytesVersioned,
    readFileVersioned, writeFileVersioned, writeConflictCopy,
  } = deps;

  /**
   * The DiskBar's buttons. Serialized per document (the bar disables itself
   * too). Whichever version the reader does not pick is kept beside the file
   * as `name (conflict).ext` — never dropped.
   */
  const resolvingRef = useRef(new Set<string>());
  const handleDiskAction = useCallback(async (path: string, action: DiskAction) =>
    (await loadChunk(() => import('./diskBarActions'))).handleDiskAction({
      tabsRef, rootHandleRef, pdfRebuildRef, diskStateRef, nativePoliciesRef, bytesGenerationsRef,
      sessionReportRef, retryUnreadTabRef, indexGraphRef, setTabs, setDiskState, setPdfRebuildNotice,
      currentPdfOwner, keepPdfBaseline, flushTab, documentBuffers, documentSessions, removeTab, hasUnsaved,
      reloadFromDisk, bumpBytesGeneration, clearSaveTimer, syncExitGuard, recoveryEvent, announce, ask, tell,
      getVaultActivation, recreateFile, resolveFileHandle, resolveVaultFile, readBytesVersioned,
      readFileVersioned, writeFileVersioned, writeConflictCopy, resolvingRef,
    }, path, action), [
      ask, tell, announce, hasUnsaved, removeTab, recreateFile, setDiskState, clearSaveTimer,
      resolveFileHandle, readBytesVersioned, readFileVersioned, writeFileVersioned, writeConflictCopy, reloadFromDisk, flushTab,
      resolveVaultFile, syncExitGuard, getVaultActivation, currentPdfOwner, keepPdfBaseline,
      setPdfRebuildNotice, documentBuffers, documentSessions, indexGraphRef, recoveryEvent,
      bumpBytesGeneration, bytesGenerationsRef, diskStateRef, nativePoliciesRef, pdfRebuildRef,
      retryUnreadTabRef, rootHandleRef, sessionReportRef, setTabs, tabsRef,
    ]);

  return { handleDiskAction };
}
