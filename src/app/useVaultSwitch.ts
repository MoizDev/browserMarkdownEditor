import type React from 'react';
import { useEffect, useRef } from 'react';
import type { FileSystemContextValue, OpenTab, EditorRevealRequest } from '../types';
import type { DocumentBufferStore } from '../utils/documentBuffers';
import type { DocumentSessionStore } from '../utils/documentSessions';
import type { BoardSaveBaselines } from '../utils/assetRetirement';
import type { DiskVersion } from '../utils/diskVersion';
import { anyPending, drainAll } from '../utils/unloadCoordinator';
import { clearPdfRenderData } from '../utils/pdfRenderCache';
import { clearNotebookRenderData } from '../utils/notebookRenderCache';
import { flushPdfTextViewState, flushReaderViewState } from '../utils/readerViewState';
import { clearViews } from '../utils/viewRegistry';
import { clearBaselines } from '../utils/docBaselines';
import { EMPTY_LAYOUT } from '../utils/tabPanes';
import type { DiskHold, FlushTab, PdfRebuildEntry, RecoveryEvent, SetLayout, SetTabs } from './types';

export interface UseVaultSwitchDeps {
  rootHandle: FileSystemDirectoryHandle | null;
  registerBeforeRootChange: FileSystemContextValue['registerBeforeRootChange'];
  getVaultActivation: FileSystemContextValue['getVaultActivation'];
  flushTab: FlushTab;
  documentSessions: DocumentSessionStore;
  documentBuffers: DocumentBufferStore;
  recoveryEvent: RecoveryEvent;
  tabsRef: React.MutableRefObject<OpenTab[]>;
  bytesGenerationsRef: React.MutableRefObject<Map<string, number>>;
  bufferPathIdsRef: React.MutableRefObject<Map<string, string>>;
  pdfSeedsRef: React.MutableRefObject<Map<string, Promise<DiskVersion | null>>>;
  pdfSeedSourcesRef: React.MutableRefObject<Map<string, FileSystemFileHandle>>;
  diskStateRef: React.MutableRefObject<Map<string, DiskHold>>;
  pdfRebuildRef: React.MutableRefObject<Map<string, PdfRebuildEntry>>;
  assetRefsRef: React.MutableRefObject<Map<string, { saved: Set<string>; references: Set<string> }>>;
  boardBaselinesRef: React.MutableRefObject<BoardSaveBaselines>;
  setTabs: SetTabs;
  setLayout: SetLayout;
  setSaveStatus: (status: string) => void;
  setPendingReveal: (request: EditorRevealRequest | null) => void;
  sessionRootRef: React.MutableRefObject<FileSystemDirectoryHandle | null>;
  sessionVaultIdRef: React.MutableRefObject<string | null | undefined>;
  currentVaultIdRef: React.MutableRefObject<string | null>;
}

export function useVaultSwitch(deps: UseVaultSwitchDeps): void {
  const {
    rootHandle, registerBeforeRootChange, getVaultActivation, flushTab, documentSessions, documentBuffers, recoveryEvent,
    tabsRef, bytesGenerationsRef, bufferPathIdsRef, pdfSeedsRef, pdfSeedSourcesRef, diskStateRef, pdfRebuildRef,
    assetRefsRef, boardBaselinesRef, setTabs, setLayout, setSaveStatus, setPendingReveal,
    sessionRootRef, sessionVaultIdRef, currentVaultIdRef,
  } = deps;
  useEffect(() => registerBeforeRootChange(async () => {
    const activation = getVaultActivation();
    for (;;) {
      await drainAll();
      if (getVaultActivation() !== activation) throw new Error('The vault changed while saving.');
      const docs = [...tabsRef.current];
      const results = await Promise.all(docs.map(tab => flushTab(tab.file.path)));
      if (getVaultActivation() !== activation) throw new Error('The vault changed while saving.');
      if (results.some(result => result === 'failed' || result === 'changed' || result === 'deleted')) {
        throw new Error('A document could not be saved; the vault was not switched.');
      }
      const pending = docs.some(tab => documentSessions.hasPendingEdits(tab.id));
      if (!pending && !anyPending()) {
        for (const tab of docs) {
          documentSessions.release(tab.id, 'vault-switch');
          void recoveryEvent({ type: 'release', documentId: tab.id });
        }
        await Promise.all(docs.map(tab => documentSessions.settled(tab.id)));
        for (const tab of docs) {
          documentBuffers.remove(tab.id); bytesGenerationsRef.current.delete(tab.id);
          if (bufferPathIdsRef.current.get(tab.file.path) === tab.id) bufferPathIdsRef.current.delete(tab.file.path);
        }
        return;
      }
      if (results.some((result, i) => {
        return result === 'skipped' && documentSessions.hasPendingEdits(docs[i].id);
      })) {
        throw new Error('A document cannot be saved; the vault was not switched.');
      }
    }
  }), [registerBeforeRootChange, getVaultActivation, flushTab, documentSessions, documentBuffers, recoveryEvent, bufferPathIdsRef, bytesGenerationsRef, tabsRef]);

  const prevRootRef = useRef<FileSystemDirectoryHandle | null>(null);
  useEffect(() => {
    const previous = prevRootRef.current;
    prevRootRef.current = rootHandle;
    if (!previous || previous === rootHandle) return;

    for (const tab of tabsRef.current) {
      clearPdfRenderData(tab.file.path);
      clearNotebookRenderData(tab.file.path);
    }
    flushReaderViewState(); flushPdfTextViewState();
    clearViews();
    clearBaselines();
    pdfSeedsRef.current.clear();
    pdfSeedSourcesRef.current.clear();
    diskStateRef.current.clear();
    pdfRebuildRef.current.clear();
    assetRefsRef.current.clear();
    boardBaselinesRef.current.clear();
    setTabs([]);
    setLayout(EMPTY_LAYOUT);
    setSaveStatus('');
    setPendingReveal(null);
    sessionRootRef.current = null;
    sessionVaultIdRef.current = currentVaultIdRef.current;
  }, [rootHandle, flushTab, assetRefsRef, boardBaselinesRef, currentVaultIdRef, diskStateRef, pdfRebuildRef, pdfSeedSourcesRef, pdfSeedsRef, sessionRootRef, sessionVaultIdRef, setLayout, setPendingReveal, setSaveStatus, setTabs, tabsRef]);
}
