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
import { hasHostedNativeOwner, RECOVERY_SESSION_BINDING } from './nativeOwners';
import { loadChunk } from '../platform/chunkLoad';
import { cancelAfterPdfTurn, holdPdfTurn, pdfTurnHeld, pdfTurnSettled } from '../utils/pdfTurnHold';

/** Everything the PDF actions read from App. Refs are App's own `useRef`s. */
export interface UsePdfActionsDeps {
  // useFileSystem()
  getVaultActivation: FileSystemContextValue['getVaultActivation'];
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
    getVaultActivation, readFileSnapshot, readBytesVersioned, writeDistinctCopy, ask, tell,
    notifyRef, rootHandleRef, currentVaultIdRef, readerEpochRef, tabsRef, activeTabPathRef, documentBuffers,
    documentSessions, setTabs, nativePoliciesRef, bytesGenerationsRef, bumpBytesGeneration, flushingRef,
    flushTab, flushChainsRef, writeFileVersionedRef, diskStateRef, setDiskState, currentPdfOwner,
    pdfSeedForRef,
  } = deps;

  const unsignedCopyInFlight = useRef(false);
  const handleUnsignedPdfCopy = useCallback(async (identity: ReaderIdentity, displayed: DiskVersion) =>
    (await loadChunk(() => import('./pdfGestures'))).handleUnsignedPdfCopy({
      getVaultActivation, readFileSnapshot, writeDistinctCopy, ask, tell, rootHandleRef, documentBuffers,
      documentSessions, diskStateRef, setDiskState, currentPdfOwner, unsignedCopyInFlight,
    }, identity, displayed), [
      ask, currentPdfOwner, documentBuffers, documentSessions, getVaultActivation, readFileSnapshot,
      setDiskState, tell, writeDistinctCopy, diskStateRef, rootHandleRef,
    ]);

  const preparePdfPrint = useCallback(async (path: string) =>
    (await loadChunk(() => import('./pdfGestures'))).preparePdfPrint({
      readBytesVersioned, rootHandleRef, tabsRef, activeTabPathRef, documentBuffers, documentSessions,
      flushingRef, flushTab, flushChainsRef, diskStateRef, setDiskState, pdfSeedForRef,
    }, path), [
      documentBuffers, documentSessions, flushTab, readBytesVersioned, setDiskState, activeTabPathRef,
      diskStateRef, flushChainsRef, flushingRef, pdfSeedForRef, rootHandleRef, tabsRef,
    ]);

  const turnPdf = useCallback(async (path: string, delta: number, pageIndex?: number) =>
    (await loadChunk(() => import('./pdfGestures'))).rotatePdf({
      getVaultActivation, readFileSnapshot, notifyRef, rootHandleRef, currentVaultIdRef,
      readerEpochRef, tabsRef, documentBuffers, documentSessions, setTabs, nativePoliciesRef,
      bytesGenerationsRef, bumpBytesGeneration, flushingRef, flushChainsRef, writeFileVersionedRef,
      diskStateRef, setDiskState, pdfSeedForRef, flushTab,
    }, path, delta, pageIndex), [
      readFileSnapshot, setDiskState, bumpBytesGeneration, documentSessions, documentBuffers, flushTab,
      getVaultActivation, bytesGenerationsRef, currentVaultIdRef, diskStateRef, flushChainsRef, flushingRef,
      nativePoliciesRef, notifyRef, pdfSeedForRef, readerEpochRef, rootHandleRef, setTabs, tabsRef,
      writeFileVersionedRef,
    ]);
  /** Turn a PDF's pages a quarter at a time and write it (pdfGestures.rotatePdf says how). Held from the press until
   * this press's write has settled, synchronously, before the writer's chunk loads (utils/pdfTurnHold.ts says why). */
  const rotatePdf = useCallback(async (path: string, delta: number, pageIndex?: number) => {
    const id = tabsRef.current.find(t => t.file.path === path)?.id;
    const release = id ? holdPdfTurn(id) : undefined;
    try { await turnPdf(path, delta, pageIndex); } finally { release?.(); }
  }, [tabsRef, turnPdf]);

  /**
   * Original is about to show a PDF whose Annotate board saved without a new byte generation (useSaveFunnel keeps it
   * for the pane's own saves, so the pen never meets a rebind's cover). That generation still names the bytes before
   * the ink, which is what Original would draw. Advance it now that no board is on screen, keeping the retained
   * Annotate owner (its camera, history and write authority) through it; the caller then has the owner's PDF source
   * follow (`adoptWritten`). The board's after-write step is waited out first: until it has run, the source does not
   * know the newest write id, and a rebind to the older one would refuse the file as not its own. False, with nothing
   * advanced, when anything is still being written or the file is held.
   */
  const adoptSavedPdfInk = useCallback(async (path: string): Promise<boolean> => {
    const eligible = () => {
      const tab = tabsRef.current.find(t => t.file.path === path);
      if (!tab || tab.mode !== 'read' || tab.readError || tab.representation.loadedKind !== 'pdf') return undefined;
      const session = documentSessions.get(tab.id), policy = nativePoliciesRef.current.get(tab.id);
      return session && policy && policy.kind === 'pdfInk' && policy.session === session.serial && policy.activation === getVaultActivation()
        && policy.retainedThroughGeneration === session.bytesGeneration && hasHostedNativeOwner(session, tab.id)
        && !diskStateRef.current.has(tab.id) && !flushingRef.current.has(tab.id) && !documentBuffers.isDirty(tab.id)
        // A turn reads the generation it began on; advancing it mid-turn would abandon the turn.
        && !pdfTurnHeld(tab.id)
        ? { id: tab.id, session, policy } : undefined;
    };
    const before = eligible();
    if (!before) return false;
    try { await before.session.adapter.drain?.(); } catch { return false; }
    const now = eligible();
    if (!now || now.session !== before.session || now.session.bytesGeneration !== before.session.bytesGeneration
      || documentSessions.hasPendingEdits(now.id)) return false;
    bumpBytesGeneration(now.id, true);
    return now.policy.retainedThroughGeneration === now.session.bytesGeneration;
  }, [bumpBytesGeneration, documentBuffers, documentSessions, getVaultActivation, diskStateRef, flushingRef, nativePoliciesRef, tabsRef]);

  const pdfDeparturesRef = useRef(new Set<string>());
  const preparePdfDeparture = useCallback(async (paths: readonly string[], trashOwned = false): Promise<boolean> => {
    for (const path of paths) {
      const opened = tabsRef.current.find(t => t.file.path === path);
      if (opened?.representation.loadedKind !== 'pdf') continue;
      if (pdfDeparturesRef.current.has(opened.id)) return false;
      pdfDeparturesRef.current.add(opened.id);
      let tab = opened;
      try {
        // A turn still being written is waited out, as a pending ink save is (utils/pdfTurnHold.ts pdfTurnSettled); an
        // Annotate switch that waited for it is not made on a document that is leaving.
        if (pdfTurnHeld(opened.id)) {
          cancelAfterPdfTurn(opened.id);
          await pdfTurnSettled(opened.id);
          const settled = tabsRef.current.find(t => t.id === opened.id);
          if (!settled || settled.file.path !== path || settled.representation.loadedKind !== 'pdf') return false;
          tab = settled;
        }
        await drain(tab.id);
        const revision = documentBuffers.revisionForDocument(tab.id)?.revision;
        const data = documentBuffers.snapshotForDocument(tab.id)?.data;
        const refusal = typeof data === 'string' ? pdfSnapshotRefusal(data) : undefined;
        const needsSave = tabsRef.current.find(t => t.id === tab.id)?.dirty || documentBuffers.isDirty(tab.id);
        const outcome = await flushTab(path, !!needsSave, true, undefined, trashOwned);
        const now = tabsRef.current.find(t => t.id === tab.id);
        if (!now || now.file.path !== path || now.representation.generation !== tab.representation.generation) return false;
        // After a write, whatever is still unsaved is newer than it. The revision taken before the flush is not that test:
        // the flush itself reports the board's last change when its 150 ms hand-off has not run yet, so a close right after
        // a change wrote it and then refused as if a newer one had come, and the tab came back with no word (measured: a
        // nudge of 220 annotations, written 0.25 s after the close, tab back at 0.5 s).
        const changedSince = outcome === 'written' ? documentBuffers.isDirty(tab.id) : documentBuffers.revisionForDocument(tab.id)?.revision !== revision;
        if (outcome === 'failed' || changedSince || getView(path)?.hasPendingEdits?.() ||
            // Unsaved bytes only: now.dirty also counts native session journalling, which
            // refused every trash/close of an annotated PDF whose ink had already been written.
            outcome === 'skipped' && documentBuffers.isDirty(now.id)) {
          if (outcome === 'skipped' && !refusal) notifyRef.current('These annotations have not been saved. Keep this PDF open and resolve its notice before closing it.');
          return false;
        }
      } catch (error) { notifyRef.current(`Could not finish PDF annotations: ${describeReadError(error)}`); return false; }
      finally { pdfDeparturesRef.current.delete(opened.id); }
    }
    return true;
  }, [documentBuffers, flushTab, notifyRef, tabsRef]);

  // Keep the gesture synchronous for the directory picker/permission prompt.
  // A refused PDF revision stays in its current vault instead of being dropped
  // by the workspace reset before an asynchronous refusal can reach it.
  const canLeavePdfVault = useCallback(() => {
    // Synchronous, so it cannot wait for a turn: the turn's write would land in the vault being left.
    if (tabsRef.current.some(t => t.representation.loadedKind === 'pdf' && pdfTurnHeld(t.id))) {
      notifyRef.current('A PDF’s pages are still being turned. Keep this vault open until that has finished.');
      return false;
    }
    // The buffer, not the tab's `dirty`: a PDF tab keeps that until rebuilt (as useUpdateNotice's `unsaved` says), so
    // asking it refused every switch after any stroke, its ink long on disk (measured: written 1.3 s after the stroke,
    // four switches over 32 s all refused). The buffer stays dirty until a save of it succeeds.
    const tab = tabsRef.current.find(t => t.representation.loadedKind === 'pdf' &&
      (documentBuffers.isDirty(t.id) || flushingRef.current.has(t.id) || getView(t.file.path)?.hasPendingEdits?.()));
    if (!tab) return true;
    const snapshot = documentBuffers.snapshotForDocument(tab.id)?.data;
    const refusal = typeof snapshot === 'string' ? pdfSnapshotRefusal(snapshot) : undefined;
    notifyRef.current(refusal ? new PdfBuildRefused(refusal).message : 'Keep this vault open until its PDF annotations are saved. Resolve any notice first, or wait for the pending save.');
    return false;
  }, [documentBuffers, flushingRef, notifyRef, tabsRef]);

  return {
    handleUnsignedPdfCopy, preparePdfPrint, rotatePdf, adoptSavedPdfInk, preparePdfDeparture, canLeavePdfVault,
  };
}
