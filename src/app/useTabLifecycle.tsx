import type React from 'react';
import { useCallback, useEffect, useRef } from 'react';
import { afterPdfTurn, cancelAfterPdfTurn, pdfTurnHeld } from '../utils/pdfTurnHold';
import type { ActiveFile, EditorMode, FileSystemContextValue, FileTreeNode, OpenTab } from '../types';
import type { ReaderIdentity } from '../types/reading';
import type { DiskVersion } from '../utils/diskVersion';
import type { DocumentBufferStore } from '../utils/documentBuffers';
import type { DocumentSessionStore } from '../utils/documentSessions';
import type { BoardSaveBaselines } from '../utils/assetRetirement';
import type { IndexGraphRef, FlushTab, PdfRebuildEntry, RecoveryEvent, SetDiskState, SetLayout, SetTabs } from './types';
import type { Notify } from './useAppDialogs';
import type { Tell } from './useAppDialogs';
import { clearNotebookRenderData } from '../utils/notebookRenderCache';
import { clearPdfRenderData } from '../utils/pdfRenderCache';
import { clearPdfRotationStandIn } from '../utils/pdfRotationStandIn';
import { flushPdfTextViewState, flushReaderViewState } from '../utils/readerViewState';
import { dropBaseline, setBaseline } from '../utils/docBaselines';
import { notifySearchChanges } from '../utils/searchChanges';
import { canChangeTabMode, getReadingSurface, representationFor } from '../utils/documentReading';
import { closePath, openTab as openTabIn } from '../utils/tabPanes';
import { collectFiles } from '../utils/tree';
import { drain, isLanding, settle } from '../utils/unloadCoordinator';
import { getView } from '../utils/viewRegistry';
import { isCanvasFile, isNativeDrawingFile } from '../utils/fileTypes';
import { describeReadError, isNotFound } from './readErrors';
import { hasHostedNativeOwner } from './nativeOwners';
import { tracksAssets } from './tracksAssets';
import { loadHelpDoc } from '../utils/helpDocLoader';

const CLOSED_TAB_MEMORY = 20;
const CLOSE_SETTLE_MS = 15_000;
const CLOSE_SETTLE_QUIET_MS = 400;
const CLOSE_RETRY_MS = 2000;

export interface UseTabLifecycleDeps {
  clearSaveTimer: (path: string) => void;
  tabsRef: React.RefObject<OpenTab[]>;
  documentSessions: DocumentSessionStore;
  bufferPathIdsRef: React.RefObject<Map<string, string>>;
  documentBuffers: DocumentBufferStore;
  syncExitGuard: () => void;
  recoveryEvent: RecoveryEvent;
  bytesGenerationsRef: React.RefObject<Map<string, number>>;
  invalidReaderTokens: React.RefObject<Set<string>>;
  readerIdentityCache: React.RefObject<Map<string, ReaderIdentity>>;
  pdfSeedsRef: React.RefObject<Map<string, Promise<DiskVersion | null>>>;
  pdfSeedSourcesRef: React.RefObject<Map<string, FileSystemFileHandle>>;
  diskStateRef: React.RefObject<Map<string, 'conflict' | 'deleted'>>;
  pdfRebuildRef: React.RefObject<Map<string, PdfRebuildEntry>>;
  indexGraphRef: IndexGraphRef;
  assetRefsRef: React.RefObject<Map<string, { saved: Set<string>; references: Set<string> }>>;
  boardBaselinesRef: React.RefObject<BoardSaveBaselines>;
  assetReadableWakeRef: React.RefObject<Set<string>>;
  flushTab: FlushTab;
  setLayout: SetLayout;
  setTabs: SetTabs;
  currentVaultId: FileSystemContextValue['currentVaultId'];
  currentVaultIdRef: React.RefObject<string | null>;
  closingRef: React.RefObject<Set<string>>;
  reopenedClosingRef: React.RefObject<Set<string>>;
  rootHandleRef: React.RefObject<FileSystemDirectoryHandle | null>;
  readerEpochRef: React.RefObject<{ root: FileSystemDirectoryHandle | null; epoch: number }>;
  setClosingDocumentIds: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>;
  notifyRef: React.RefObject<Notify>;
  tell: Tell;
  preparePdfDeparture: (paths: readonly string[], trashOwned?: boolean) => Promise<boolean>;
  fileTreeRef: React.RefObject<FileTreeNode[]>;
  handleFileClick: (node: FileTreeNode) => Promise<boolean>;
  retryUnreadTabRef: React.RefObject<(path: string) => Promise<boolean>>;
  rememberAssetRefs: (file: ActiveFile, content: string) => void;
  readFileVersioned: FileSystemContextValue['readFileVersioned'];
  readBytesVersioned: FileSystemContextValue['readBytesVersioned'];
  resolveFileHandle: FileSystemContextValue['resolveFileHandle'];
  bumpBytesGeneration: (id: string, preserveNative?: boolean) => void;
  seedDocumentBuffer: (id: string, path: string, content: string, readable: boolean) => void;
  setDiskState: SetDiskState;
  showStatus: (message: string, ms: number) => void;
}

export function useTabLifecycle(deps: UseTabLifecycleDeps) {
  const {
    clearSaveTimer, tabsRef, documentSessions, bufferPathIdsRef, documentBuffers, syncExitGuard,
    recoveryEvent, bytesGenerationsRef, invalidReaderTokens, readerIdentityCache, pdfSeedsRef,
    pdfSeedSourcesRef, diskStateRef, pdfRebuildRef, indexGraphRef, assetRefsRef, boardBaselinesRef,
    assetReadableWakeRef, flushTab, setLayout, setTabs, currentVaultId, currentVaultIdRef, closingRef,
    reopenedClosingRef, rootHandleRef, readerEpochRef, setClosingDocumentIds, notifyRef, tell,
    preparePdfDeparture, fileTreeRef, handleFileClick, retryUnreadTabRef, rememberAssetRefs,
    readFileVersioned, readBytesVersioned, resolveFileHandle, bumpBytesGeneration, seedDocumentBuffer,
    setDiskState, showStatus,
  } = deps;

  const releaseTab = useCallback((path: string) => {
    // Callers drain and save before releasing, or explicitly discard the tab.
    clearSaveTimer(path);
    const doc = tabsRef.current.find(t => t.file.path === path);
    if (doc) {
      documentSessions.release(doc.id, 'tab-close');
      if (bufferPathIdsRef.current.get(path) === doc.id) bufferPathIdsRef.current.delete(path);
      void documentSessions.settled(doc.id).then(() => { documentBuffers.remove(doc.id); syncExitGuard(); });
      bytesGenerationsRef.current.delete(doc.id);
      void recoveryEvent({ type: 'release', documentId: doc.id });
      syncExitGuard();
      invalidReaderTokens.current.add(`${doc.id}|${doc.representation.generation}`);
      clearPdfRotationStandIn(doc.id);
      flushReaderViewState(); flushPdfTextViewState();
      readerIdentityCache.current.forEach((value,key)=>{if(value.documentId===doc.id)readerIdentityCache.current.delete(key)});
      dropBaseline(doc.id);
      pdfSeedsRef.current.delete(doc.id);
      pdfSeedSourcesRef.current.delete(doc.id);
      diskStateRef.current.delete(doc.id);
      pdfRebuildRef.current.delete(doc.id);
    }
    const owner = indexGraphRef.current;
    if (owner) void owner.client.dropOverlay(path).catch(() => {});
    notifySearchChanges();
    clearPdfRenderData(path);
    clearNotebookRenderData(path);
    assetRefsRef.current.delete(path);
    boardBaselinesRef.current.remove(path);
  }, [clearSaveTimer, documentBuffers, documentSessions, indexGraphRef, recoveryEvent, syncExitGuard, assetRefsRef, boardBaselinesRef, bufferPathIdsRef, bytesGenerationsRef, diskStateRef, invalidReaderTokens, pdfRebuildRef, pdfSeedSourcesRef, pdfSeedsRef, readerIdentityCache, tabsRef]);

  const releaseOverwritten = useCallback(async (path: string, movedFrom: string, keep = false) => {
    if (path === movedFrom) return;
    if (!tabsRef.current.some(t => t.file.path === path)) return;
    if (keep) {
      const result = await flushTab(path, false, true);
      const tab = tabsRef.current.find(t => t.file.path === path);
      const pending = !!tab && documentSessions.hasPendingEdits(tab.id);
      if (result === 'failed' || (result === 'skipped' && pending)) throw new Error('Could not preserve the overwritten document.');
    }
    releaseTab(path);
    setLayout(l => closePath(l, path));
    setTabs(prev => prev.filter(t => t.file.path !== path));
  }, [releaseTab, flushTab, documentSessions, setLayout, setTabs, tabsRef]);

  const removeTab = useCallback((path: string) => {
    releaseTab(path);
    setLayout(l => closePath(l, path));
    setTabs(prev => prev.filter(t => t.file.path !== path));
  }, [releaseTab, setLayout, setTabs]);

  const closedPathsRef = useRef<string[]>([]);
  useEffect(() => { closedPathsRef.current = []; }, [currentVaultId]);
  const rememberClosed = useCallback((paths: readonly string[]) => {
    const stack = closedPathsRef.current.filter(p => !paths.includes(p));
    stack.push(...paths);
    closedPathsRef.current = stack.slice(-CLOSED_TAB_MEMORY);
  }, []);

  const retryClosingSave = useCallback((tab: OpenTab) => {
    setTimeout(() => {
      const now = tabsRef.current.find(t => t.id === tab.id);
      if (!now || closingRef.current.has(tab.id) || diskStateRef.current.has(tab.id) || !documentBuffers.isDirty(tab.id)) return;
      void flushTab(now.file.path).catch(error => console.error('Could not save again after a close:', error));
    }, CLOSE_RETRY_MS);
  }, [documentBuffers, flushTab, closingRef, diskStateRef, tabsRef]);

  const closeDocuments = useCallback((paths: readonly string[], hide: () => void) => {
    const docs = paths.flatMap(path => {
      const tab = tabsRef.current.find(t => t.file.path === path);
      return tab && !closingRef.current.has(tab.id) ? [tab] : [];
    });
    if (!docs.length) return;
    const root = rootHandleRef.current;
    for (const tab of docs) closingRef.current.add(tab.id);
    setClosingDocumentIds(new Set(closingRef.current));
    const stopClosing = (tab: OpenTab) => {
      closingRef.current.delete(tab.id);
      reopenedClosingRef.current.delete(tab.id);
      setClosingDocumentIds(new Set(closingRef.current));
    };
    const leave = () => {
      rememberClosed(docs.map(tab => tab.file.path));
      hide();
      for (const tab of docs) void (async () => {
        const path = tab.file.path;
        try {
          await getReadingSurface({vaultId:currentVaultIdRef.current??'',vaultEpoch:readerEpochRef.current.epoch,documentId:tab.id,byteGeneration:tab.representation.generation})?.captureReading?.().catch(() => {});
          if (tab.representation.loadedKind === 'pdf' && !await preparePdfDeparture([path])) {
            setLayout(l => openTabIn(l, path));
            retryClosingSave(tab);
            return;
          }
          await drain(tab.id);
          if (rootHandleRef.current !== root || !tabsRef.current.some(t => t.id === tab.id && t.file.path === path)) return;
          const result = await flushTab(path);
          if (result === 'written') await drain(tab.id);
          const pending = documentSessions.hasPendingEdits(tab.id);
          if (rootHandleRef.current !== root || !tabsRef.current.some(t => t.id === tab.id && t.file.path === path)) return;
          const dirtyNow = tabsRef.current.find(t => t.id === tab.id)?.dirty ?? tab.dirty;
          if (result === 'changed' || result === 'deleted') {
            setLayout(l => openTabIn(l, path));
            notifyRef.current(`“${tab.file.name}” changed on disk while it was closing, so its tab stays open.`);
            return;
          }
          if (result === 'failed' || (result === 'skipped' && (pending || (tab.representation.loadedKind !== 'pdf' && dirtyNow))) || pending) {
            setLayout(l => openTabIn(l, path));
            notifyRef.current(`“${tab.file.name}” could not be saved yet, so its tab stays open with your changes. It is saved again in a moment; close it once it shows “Saved”.`);
            retryClosingSave(tab);
            return;
          }
          if (reopenedClosingRef.current.has(tab.id)) return;
          releaseTab(path);
          setTabs(prev => prev.filter(t => t.id !== tab.id));
        } catch (error) {
          console.error('Could not close document:', error);
          if (rootHandleRef.current === root && tabsRef.current.some(t => t.id === tab.id)) {
            setLayout(l => openTabIn(l, path));
            notifyRef.current(`“${tab.file.name}” could not be saved yet, so its tab stays open with your changes. It is saved again in a moment; close it once it shows “Saved”.`);
            retryClosingSave(tab);
          }
        } finally { stopClosing(tab); }
      })();
    };
    if (!docs.some(tab => isLanding(tab.id))) { leave(); return; }
    void (async () => {
      let told = false;
      const telling = setTimeout(() => { told = true; showStatus('Finishing your last change before closing…', CLOSE_SETTLE_MS); }, CLOSE_SETTLE_QUIET_MS);
      let landed: boolean[];
      try { landed = await Promise.all(docs.map(tab => settle(tab.id, CLOSE_SETTLE_MS))); }
      finally { clearTimeout(telling); if (told) showStatus('', 0); }
      if (rootHandleRef.current === root && landed.every(Boolean)) { leave(); return; }
      for (const tab of docs) stopClosing(tab);
      if (rootHandleRef.current !== root) return;
      // Closed now, the change would be lost; open, it lands and is saved by itself.
      const late = docs.filter((_, i) => !landed[i]).map(tab => `“${tab.file.name}”`).join(', ');
      notifyRef.current(`${late} is still applying your last change, so it stays open. Close it again once that change shows.`);
    })();
  }, [flushTab, releaseTab, rememberClosed, preparePdfDeparture, retryClosingSave, showStatus, documentSessions, closingRef, currentVaultIdRef, notifyRef, readerEpochRef, reopenedClosingRef, rootHandleRef, setClosingDocumentIds, setLayout, setTabs, tabsRef]);

  const closeTab = useCallback((path: string) => {
    closeDocuments([path], () => setLayout(l => closePath(l, path)));
  }, [closeDocuments, setLayout]);

  const reopenClosedTab = useCallback(async () => {
    for (;;) {
      const path = closedPathsRef.current.pop();
      if (path === undefined) return;
      const held = tabsRef.current.find(t => t.file.path === path);
      if (held && closingRef.current.has(held.id)) { reopenedClosingRef.current.add(held.id); setLayout(l => openTabIn(l, path)); return path; }
      if (held) continue;
      const node = collectFiles(fileTreeRef.current).find(f => f.path === path);
      if (!node) continue;
      if (await handleFileClick(node)) return path;
    }
  }, [handleFileClick, closingRef, fileTreeRef, reopenedClosingRef, setLayout, tabsRef]);

  const retryingReadsRef = useRef(new Set<string>());
  const retryUnreadTab = useCallback(async (path: string): Promise<boolean> => {
    const tab = tabsRef.current.find(t => t.file.path === path);
    if (tab?.representation.loadedKind === 'epub') {
      if (retryingReadsRef.current.has(tab.id)) return false;
      retryingReadsRef.current.add(tab.id);
      try {
        const handle = await resolveFileHandle(path);
        if (!tabsRef.current.some(t => t.id === tab.id && t.file.path === path && t.representation.generation === tab.representation.generation)) return false;
        if (!handle) { setDiskState(tab.id, 'deleted'); return false; }
        invalidReaderTokens.current.add(`${tab.id}|${tab.representation.generation}`);
        dropBaseline(tab.id); diskStateRef.current.delete(tab.id);
        setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, file: {...t.file,handle}, readError: undefined, disk: undefined, readerCapabilities: undefined, diskRev: (t.diskRev ?? 0) + 1, representation: representationFor(t.file.name, false, t.representation.generation + 1) } : t));
        return true;
      } finally { retryingReadsRef.current.delete(tab.id); }
    }
    if (tab?.readError && tab.file.isHelp) {
      if (retryingReadsRef.current.has(tab.id)) return false;
      retryingReadsRef.current.add(tab.id);
      try {
        const content = await loadHelpDoc();
        if (!tabsRef.current.some(t => t.id === tab.id)) return false;
        if (!documentBuffers.get(tab.id)) seedDocumentBuffer(tab.id, tab.file.path, content, true);
        documentBuffers.report(tab.id, content, true);
        documentBuffers.setReadable(tab.id, true);
        setTabs(prev => prev.map(t => t.id === tab.id && t.readError
          ? { ...t, readError: undefined, representation: representationFor(t.file.name, true, t.representation.generation + 1) } : t));
        return true;
      } catch (err) {
        setTabs(prev => prev.map(t => t.id === tab.id && t.readError ? { ...t, readError: describeReadError(err) } : t));
        return false;
      } finally {
        retryingReadsRef.current.delete(tab.id);
      }
    }
    if (!tab?.readError || !tab.file.handle) return !!tab && !tab.readError;
    if (retryingReadsRef.current.has(tab.id)) return false;
    retryingReadsRef.current.add(tab.id);
    try {
      const binaryDrawing = isNativeDrawingFile(tab.file.name);
      const { text: content, version } = binaryDrawing
        ? { text: '', version: (await readBytesVersioned(tab.file.handle as FileSystemFileHandle)).version }
        : await readFileVersioned(tab.file.handle as FileSystemFileHandle);
      const current = tabsRef.current.find(t => t.id === tab.id);
      if (!current) return false;
      setBaseline(tab.id, version);
      if (!documentBuffers.get(tab.id)) seedDocumentBuffer(tab.id, current.file.path, content, representationFor(current.file.name).bufferKind === 'text');
      documentBuffers.report(tab.id, content, true);
      documentBuffers.setReadable(tab.id, representationFor(current.file.name).bufferKind === 'text');
      bumpBytesGeneration(tab.id);
      if (!binaryDrawing && ((tracksAssets(current.file) && !assetRefsRef.current.has(current.file.path)) ||
          (isCanvasFile(current.file.name) && !boardBaselinesRef.current.capture(current.file.path)))) {
        rememberAssetRefs(current.file, content);
      }
      assetReadableWakeRef.current.add(current.file.path);
      setTabs(prev => prev.map(t =>
        t.id === tab.id && t.readError ? { ...t, readError: undefined, representation: representationFor(t.file.name, false, t.representation.generation + 1) } : t));
      return true;
    } catch (err) {
      const current = tabsRef.current.find(t => t.id === tab.id);
      if (!current) return false;
      // NotFoundError on the handle this read started with only means "gone" if
      // the tab still holds that handle: a rename or move mid-read retargets
      // the tab and removes the old entry, and must not close a note that
      // merely moved.
      if (isNotFound(err) && current.file.handle === tab.file.handle) {
        removeTab(current.file.path);
        void tell({
          title: 'That note is gone',
          confirmLabel: 'OK',
          body: <><strong>{current.file.name}</strong> is no longer in this vault, so its tab has been closed.</>,
        });
      } else {
        console.warn('Could not read the file again:', path, err);
        setTabs(prev => prev.map(t =>
          t.id === tab.id && t.readError ? { ...t, readError: describeReadError(err) } : t));
      }
      return false;
    } finally {
      retryingReadsRef.current.delete(tab.id);
    }
  }, [readFileVersioned, readBytesVersioned, rememberAssetRefs, removeTab, tell, resolveFileHandle, setDiskState, documentBuffers, bumpBytesGeneration, seedDocumentBuffer, assetReadableWakeRef, assetRefsRef, boardBaselinesRef, diskStateRef, invalidReaderTokens, setTabs, tabsRef]);
  useEffect(() => { retryUnreadTabRef.current = retryUnreadTab; }, [retryUnreadTab, retryUnreadTabRef]);

  const pendingPdfMode = useRef(new Set<string>());
  const changeTabModeRef = useRef<(path: string | null, requestedMode?: EditorMode) => void>(() => {});
  const changeTabMode = useCallback((path: string | null, requestedMode?: EditorMode) => {
    if (!path) return;
    const tab = tabsRef.current.find(t => t.file.path === path);
    if (!tab || !canChangeTabMode(tab)) return;
    const mode = requestedMode ?? (tab.mode === 'edit' ? 'read' : 'edit');
    if (tab.representation.loadedKind === 'pdf' && mode !== tab.mode && diskStateRef.current.has(tab.id)) return;
    if (tab.representation.loadedKind === 'pdf' && pdfTurnHeld(tab.id)) {
      if (!requestedMode && cancelAfterPdfTurn(tab.id)) return;
      if (mode === 'edit') {
        afterPdfTurn(tab.id, () => {
          const now = tabsRef.current.find(t => t.id === tab.id);
          if (now && now.mode === 'read') changeTabModeRef.current(now.file.path, 'edit');
        });
        return;
      }
      cancelAfterPdfTurn(tab.id);
    }
    if (mode === tab.mode) return;
    const view = getView(path);
    const nativeEntry = documentSessions.get(tab.id);
    const nativePdf = tab.representation.loadedKind === 'pdf' && hasHostedNativeOwner(nativeEntry, tab.id);
    if (tab.representation.loadedKind === 'pdf' && tab.mode === 'edit' && (view?.flushPending || nativePdf)) {
      if (pendingPdfMode.current.has(tab.id)) return;
      pendingPdfMode.current.add(tab.id);
      void Promise.resolve(view?.flushPending?.()).then(async () => {
        const needsSave = documentBuffers.isDirty(tab.id) || !nativePdf && tabsRef.current.find(t => t.id === tab.id)?.dirty;
        const outcome = await flushTab(path, !!needsSave);
        const unsaved = documentBuffers.isDirty(tab.id) || !nativePdf && !!tabsRef.current.find(t => t.id === tab.id)?.dirty;
        if (outcome === 'failed' || outcome === 'changed' || outcome === 'deleted' || outcome === 'skipped' && unsaved
          || diskStateRef.current.has(tab.id)) return;
        setTabs(prev => prev.map(t => t.id === tab.id && t.file.path === path && t.representation.generation === tab.representation.generation && t.mode === tab.mode ? {...t,mode} : t));
      }).catch(error => notifyRef.current(`The PDF annotations could not be saved, so Annotate stays open: ${describeReadError(error)}`)).finally(() => pendingPdfMode.current.delete(tab.id));
      return;
    }
    const surface = getReadingSurface({vaultId:currentVaultIdRef.current ?? '',vaultEpoch:readerEpochRef.current.epoch,documentId:tab.id,byteGeneration:tab.representation.generation});
    if (mode === 'edit' && surface?.capabilities().surface === 'pdf-text' && surface.showPdfOriginal) {
      if (pendingPdfMode.current.has(tab.id)) return;
      pendingPdfMode.current.add(tab.id);
      void surface.showPdfOriginal().then(() => {
        setTabs(prev => prev.map(t => t.id === tab.id && t.file.path === path && t.representation.generation === tab.representation.generation && t.mode === tab.mode ? {...t,mode} : t));
      }).finally(() => pendingPdfMode.current.delete(tab.id));
      return;
    }
    setTabs(prev => prev.map(t =>
      t.file.path === path && canChangeTabMode(t)
        ? { ...t, mode }
        : t));
  }, [flushTab, documentBuffers, documentSessions, currentVaultIdRef, diskStateRef, notifyRef, readerEpochRef, setTabs, tabsRef]);
  useEffect(() => { changeTabModeRef.current = changeTabMode; }, [changeTabMode]);
  const toggleTabMode = useCallback((path: string | null) => changeTabMode(path), [changeTabMode]);

  return {
    releaseTab, releaseOverwritten, removeTab, closeDocuments, closeTab, reopenClosedTab,
    retryUnreadTab, changeTabMode, toggleTabMode,
  };
}
