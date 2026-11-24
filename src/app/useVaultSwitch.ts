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
  // ── Vault switch ────────────────────────────────────────────────────────
  // A tab is only meaningful inside the vault it was opened from: its path
  // indexes that vault's tree and its handle writes into that vault's folder.
  // App owns each document session by id, distinct even at a reused path. Carrying
  // tabs across a switch would still show and autosave the previous vault's
  // notes behind the new tree. Flush the old handles and hand the new vault
  // an empty workspace, even when both vaults have a matching path.
  //
  // Emptying the workspace does NOT lose the outgoing vault's session: the
  // persist effect above has already written it under that vault's id on every
  // layout change, and the two session refs stop this `EMPTY_LAYOUT` being
  // filed under either vault — the outgoing one because its restore marker no
  // longer matches `rootHandle`, the incoming one because its restore has not
  // run yet. That is what makes switching back restore the workspace.
  //
  // Only fires on a REAL switch: the null → vault assignment at startup must not
  // clear the tabs the restore pass below is about to bring back.
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
    // Every registered pane belongs to the vault being left.
    flushReaderViewState(); flushPdfTextViewState();
    clearViews();
    // So does every open document's disk baseline and standoff; the pre-commit
    // hook has finished their writes.
    clearBaselines();
    pdfSeedsRef.current.clear();
    pdfSeedSourcesRef.current.clear();
    diskStateRef.current.clear();
    pdfRebuildRef.current.clear();
    // These paths index the vault being left.
    assetRefsRef.current.clear();
    boardBaselinesRef.current.clear();
    setTabs([]);
    setLayout(EMPTY_LAYOUT);
    setSaveStatus('');
    setPendingReveal(null);
    // The workspace on screen is no longer ANY vault's session — least of all
    // this empty one's. Only the handle ref is released: clearing the id ref too
    // would let the restore pass claim on this very commit, where
    // `currentVaultId` is still the OUTGOING vault's, and open the old vault's
    // paths out of the new vault's tree. Without this, persistence is gated only
    // by `rootHandle` never being the same OBJECT twice — and it can be, since
    // the vault menu re-mints its handles from `publishVaults`, which a
    // `recordVault` that failed after `setCurrentVaultId` never reaches. Coming
    // back to that vault by the same menu row then matched both refs and filed
    // this EMPTY layout under its id, destroying the session it was about to
    // restore. Gated instead, it merely does not restore that once.
    sessionRootRef.current = null;
    // The id ref is not cleared but RE-POINTED at the vault being left, which is
    // the only thing the restore pass's `=== currentVaultId` test can safely
    // mean. Leaving it holding whatever was last CLAIMED is not the same thing,
    // because a vault can set `currentVaultId` and never claim: the pass returns
    // above on an empty `fileTree`, and an empty FOLDER is indistinguishable
    // from a tree that has not landed yet. Measured — vault R with three tabs,
    // switch to an empty folder, switch back — the pass then claimed R's handle
    // against the EMPTY vault's id on the mid-switch commit, so the commit
    // carrying R's own id failed the handle test: R's tabs never came back and
    // nothing R did afterwards was persisted for the rest of the page load.
    sessionVaultIdRef.current = currentVaultIdRef.current;
  }, [rootHandle, flushTab, assetRefsRef, boardBaselinesRef, currentVaultIdRef, diskStateRef, pdfRebuildRef, pdfSeedSourcesRef, pdfSeedsRef, sessionRootRef, sessionVaultIdRef, setLayout, setPendingReveal, setSaveStatus, setTabs, tabsRef]);
}
