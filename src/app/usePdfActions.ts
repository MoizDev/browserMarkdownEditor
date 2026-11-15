import type React from 'react';
import { useCallback, useRef } from 'react';
import type { FileSystemContextValue, OpenTab } from '../types';
import type { ReaderIdentity } from '../types/reading';
import type { DocumentBufferStore } from '../utils/documentBuffers';
import type { DocumentSessionStore } from '../utils/documentSessions';
import type { DiskVersion } from '../utils/diskVersion';
import type { Ask, Notify, Tell } from './useAppDialogs';
import type { FlushTab, NativePolicy, SetDiskState, SetTabs } from './types';
import { drain } from '../utils/unloadCoordinator';
import { getView } from '../utils/viewRegistry';
import { PdfBuildRefused, pdfSnapshotRefusal } from '../utils/pdfBuildRefusal';
import { describeReadError } from './readErrors';
import { RECOVERY_SESSION_BINDING } from './nativeOwners';

/** Everything the PDF actions read from App. Refs are App's own `useRef`s. */
export interface UsePdfActionsDeps {
  // useFileSystem()
  getVaultActivation: FileSystemContextValue['getVaultActivation'];
  readFileBytes: FileSystemContextValue['readFileBytes'];
  readFileSnapshot: FileSystemContextValue['readFileSnapshot'];
  readBytesVersioned: FileSystemContextValue['readBytesVersioned'];
  writeDistinctCopy: FileSystemContextValue['writeDistinctCopy'];
  // App: dialogs, vault, reader epoch
  ask: Ask;
  tell: Tell;
  notifyRef: React.RefObject<Notify>;
  rootHandleRef: React.RefObject<FileSystemDirectoryHandle | null>;
  currentVaultIdRef: React.RefObject<string | null>;
  readerEpochRef: React.RefObject<{ root: FileSystemDirectoryHandle | null; epoch: number }>;
  // useOpenDocuments
  tabsRef: React.RefObject<OpenTab[]>;
  activeTabPathRef: React.RefObject<string | null>;
  documentBuffers: DocumentBufferStore;
  documentSessions: DocumentSessionStore;
  setTabs: SetTabs;
  nativePoliciesRef: React.RefObject<Map<string, NativePolicy>>;
  bytesGenerationsRef: React.RefObject<Map<string, number>>;
  bumpBytesGeneration: (id: string, preserveNative?: boolean) => void;
  flushingRef: React.RefObject<Map<string, number>>;
  // useSaveFunnel
  flushTab: FlushTab;
  flushChainsRef: React.RefObject<Map<string, Promise<unknown>>>;
  writeFileVersionedRef: React.RefObject<FileSystemContextValue['writeFileVersioned']>;
  // useDiskState
  diskStateRef: React.RefObject<Map<string, 'conflict' | 'deleted'>>;
  setDiskState: SetDiskState;
  currentPdfOwner: (identity: ReaderIdentity) => OpenTab | undefined;
  // usePdfSeeds
  pdfSeedForRef: React.RefObject<(id: string) => Promise<DiskVersion | null> | undefined>;
}

export function usePdfActions(deps: UsePdfActionsDeps) {
  const {
    getVaultActivation, readFileBytes, readFileSnapshot, readBytesVersioned, writeDistinctCopy, ask, tell,
    notifyRef, rootHandleRef, currentVaultIdRef, readerEpochRef, tabsRef, activeTabPathRef, documentBuffers,
    documentSessions, setTabs, nativePoliciesRef, bytesGenerationsRef, bumpBytesGeneration, flushingRef,
    flushTab, flushChainsRef, writeFileVersionedRef, diskStateRef, setDiskState, currentPdfOwner,
    pdfSeedForRef,
  } = deps;

  const unsignedCopyInFlight = useRef(false);
  const handleUnsignedPdfCopy = useCallback(async (identity: ReaderIdentity, displayed: DiskVersion) =>
    (await import('./pdfGestures')).handleUnsignedPdfCopy({
      getVaultActivation, readFileSnapshot, writeDistinctCopy, ask, tell, rootHandleRef, documentBuffers,
      documentSessions, diskStateRef, setDiskState, currentPdfOwner, unsignedCopyInFlight,
    }, identity, displayed), [
      ask, currentPdfOwner, documentBuffers, documentSessions, getVaultActivation, readFileSnapshot,
      setDiskState, tell, writeDistinctCopy, diskStateRef, rootHandleRef,
    ]);

  const preparePdfPrint = useCallback(async (path: string) =>
    (await import('./pdfGestures')).preparePdfPrint({
      readBytesVersioned, rootHandleRef, tabsRef, activeTabPathRef, documentBuffers, documentSessions,
      flushingRef, flushTab, flushChainsRef, diskStateRef, setDiskState, pdfSeedForRef,
    }, path), [
      documentBuffers, documentSessions, flushTab, readBytesVersioned, setDiskState, activeTabPathRef,
      diskStateRef, flushChainsRef, flushingRef, pdfSeedForRef, rootHandleRef, tabsRef,
    ]);

  /**
   * Turn a PDF's pages a quarter at a time, and write it.
   *
   * A REAL EDIT, not a view setting (utils/pdfRotate.ts says why): the angle
   * goes into each page's `/Rotate`, so a sideways scan is fixed for the
   * reader, the annotate canvas, the thumbnails and every other app at once,
   * through the one attribute all of them already honour.
   *
   * It writes through `writeFileVersioned` against the tab's disk baseline and
   * queues on the same per-tab chain `flushTab` uses — a rotation is a save
   * like any other, and must not overtake or interleave with one.
   *
   * REFUSED on a PDF this app has annotated. Its strokes are authored against
   * the pages as they were, and `/Rotate` would turn the paper out from under
   * every mark; the honest answer is to say so rather than move the ink. The
   * role read that decides it happens HERE, at the moment of the gesture, so
   * that merely opening a PDF to read still costs no attachment read.
   */
  const rotatePdf = useCallback(async (path: string, delta: number, pageIndex?: number) =>
    (await import('./pdfGestures')).rotatePdf({
      getVaultActivation, readFileBytes, readFileSnapshot, notifyRef, rootHandleRef, currentVaultIdRef,
      readerEpochRef, tabsRef, documentBuffers, documentSessions, setTabs, nativePoliciesRef,
      bytesGenerationsRef, bumpBytesGeneration, flushingRef, flushChainsRef, writeFileVersionedRef,
      diskStateRef, setDiskState, pdfSeedForRef,
    }, path, delta, pageIndex), [
      readFileBytes, readFileSnapshot, setDiskState, bumpBytesGeneration, documentSessions, documentBuffers,
      getVaultActivation, bytesGenerationsRef, currentVaultIdRef, diskStateRef, flushChainsRef, flushingRef,
      nativePoliciesRef, notifyRef, pdfSeedForRef, readerEpochRef, rootHandleRef, setTabs, tabsRef,
      writeFileVersionedRef,
    ]);

  const pdfDeparturesRef = useRef(new Set<string>());
  const preparePdfDeparture = useCallback(async (paths: readonly string[], trashOwned = false): Promise<boolean> => {
    for (const path of paths) {
      const tab = tabsRef.current.find(t => t.file.path === path);
      if (tab?.representation.loadedKind !== 'pdf') continue;
      if (pdfDeparturesRef.current.has(tab.id)) return false;
      pdfDeparturesRef.current.add(tab.id);
      try {
        await drain(tab.id);
        const revision = documentBuffers.revisionForDocument(tab.id)?.revision;
        const data = documentBuffers.snapshotForDocument(tab.id)?.data;
        const refusal = typeof data === 'string' ? pdfSnapshotRefusal(data) : undefined;
        const needsSave = tabsRef.current.find(t => t.id === tab.id)?.dirty || documentBuffers.isDirty(tab.id);
        const outcome = await flushTab(path, !!needsSave, true, undefined, trashOwned);
        const now = tabsRef.current.find(t => t.id === tab.id);
        if (!now || now.file.path !== path || now.representation.generation !== tab.representation.generation) return false;
        if (outcome === 'failed' || documentBuffers.revisionForDocument(tab.id)?.revision !== revision || getView(path)?.hasPendingEdits?.() ||
            // Unsaved bytes only: now.dirty also counts native session journalling, which
            // refused every trash/close of an annotated PDF whose ink had already been written.
            outcome === 'skipped' && documentBuffers.isDirty(now.id)) {
          if (outcome === 'skipped' && !refusal) notifyRef.current('These annotations have not been saved. Keep this PDF open and resolve its notice before closing it.');
          return false;
        }
      } catch (error) { notifyRef.current(`Could not finish PDF annotations: ${describeReadError(error)}`); return false; }
      finally { pdfDeparturesRef.current.delete(tab.id); }
    }
    return true;
  }, [documentBuffers, flushTab, notifyRef, tabsRef]);

  // Keep the gesture synchronous for the directory picker/permission prompt.
  // A refused PDF revision stays in its current vault instead of being dropped
  // by the workspace reset before an asynchronous refusal can reach it.
  const canLeavePdfVault = useCallback(() => {
    const tab = tabsRef.current.find(t => t.representation.loadedKind === 'pdf' &&
      (t.dirty || documentBuffers.isDirty(t.id) || flushingRef.current.has(t.id) || getView(t.file.path)?.hasPendingEdits?.()));
    if (!tab) return true;
    const snapshot = documentBuffers.snapshotForDocument(tab.id)?.data;
    const refusal = typeof snapshot === 'string' ? pdfSnapshotRefusal(snapshot) : undefined;
    notifyRef.current(refusal ? new PdfBuildRefused(refusal).message : 'Keep this vault open until its PDF annotations are saved. Resolve any notice first, or wait for the pending save.');
    return false;
  }, [documentBuffers, flushingRef, notifyRef, tabsRef]);

  return {
    handleUnsignedPdfCopy, preparePdfPrint, rotatePdf, preparePdfDeparture, canLeavePdfVault,
  };
}
