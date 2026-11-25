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

/** How many closed documents ⌥⇧T can reach back through. Session-only and
 *  bounded: a long session closes hundreds of tabs and nobody reaches past a
 *  handful, while an unbounded list would pin a path per close for the day. */
const CLOSED_TAB_MEMORY = 20;
/** How long closing a board waits for its last change to land (a nudge of 4,000 strokes measured 4.4 s), and how long
 *  before the status line says so. */
const CLOSE_SETTLE_MS = 15_000;
const CLOSE_SETTLE_QUIET_MS = 400;
/** How long after a close that could not save the save is tried again. */
const CLOSE_RETRY_MS = 2000;

/**
 * Every way one document stops being open: its release (buffers, sessions,
 * per-path records), closing with a save first, overwrite and removal, the
 * ⌥⇧T reopen stack, unreadable-tab retry, and the editing-mode switch.
 */
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

  /** Everything that has to happen for ONE document to stop being open, short
   *  of the two state updates (which differ per caller). */
  const releaseTab = useCallback((path: string) => {
    // Callers drain and save before releasing, or explicitly discard the tab.
    clearSaveTimer(path);
    // The document's disk state goes with it.
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
    // A successful closing flush has already captured the render data.
    clearPdfRenderData(path);
    // A notebook's exporter closes over its editor; dropping it is what stops a
    // closed notebook pinning that editor for the rest of the session.
    clearNotebookRenderData(path);
    // Same: the flush above captured its own diff before this ran. A closed
    // note has no unsaved edits left to attribute an asset change to.
    assetRefsRef.current.delete(path);
    boardBaselinesRef.current.remove(path);
  }, [clearSaveTimer, documentBuffers, documentSessions, indexGraphRef, recoveryEvent, syncExitGuard, assetRefsRef, boardBaselinesRef, bufferPathIdsRef, bytesGenerationsRef, diskStateRef, invalidReaderTokens, pdfRebuildRef, pdfSeedSourcesRef, pdfSeedsRef, readerIdentityCache, tabsRef]);

  /**
   * A rename or move that lands on a name another tab is holding. renameFile /
   * moveFile deliberately overwrite (an explicit move onto a name is the user
   * saying so), so that tab's file no longer exists — its buffer must NOT be
   * flushed, or it would write itself straight back over the file that just
   * replaced it. Dropping it here is what keeps one path from ending up in two
   * tabs, drawing one document under two names.
   *
   * Called on EVERY overwrite, whether or not the file being renamed is itself
   * open: the hazard belongs to the tab holding the destination name, which
   * still holds a handle resolving to that very directory entry. Skipping it
   * when the source happened to be closed left that tab's autosave to put the
   * old bytes back over the file that had just replaced them.
   *
   * BEFORE the moved document's own per-path state is re-keyed onto this path,
   * never after: `releaseTab` clears exactly the two slots (the parked PDF
   * render data, the asset-diff baseline) that movePdfRenderData/moveAssetRefs
   * write, so running it second wiped the survivor's rather than the loser's —
   * silently dropping pending annotations and killing that note's asset diff
   * for the rest of the session.
   */
  // `keep`: the overwrite was NOT the reader's doing (a `mv` noticed on disk), so
  // the buffer's unsaved edits are flushed as a closing document's — its file
  // now holds other bytes, so they land beside it as a `(conflict)` copy.
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
    // Its tab goes too. renamePath would drop it as it re-points the moved
    // document, but only when the moved one is open — and closing it here is
    // also what fronts a NEIGHBOUR of the tab that vanished rather than
    // whichever tab happens to be leftmost in the column.
    setLayout(l => closePath(l, path));
    setTabs(prev => prev.filter(t => t.file.path !== path));
  }, [releaseTab, flushTab, documentSessions, setLayout, setTabs, tabsRef]);

  /** Close one document. Its tab goes; the column goes with it only if that was
   *  the column's last tab (see utils/tabPanes.ts closePath). */
  const removeTab = useCallback((path: string) => {
    releaseTab(path);
    setLayout(l => closePath(l, path));
    setTabs(prev => prev.filter(t => t.file.path !== path));
  }, [releaseTab, setLayout, setTabs]);

  /**
   * The documents the user closed, oldest first — the stack ⌥⇧T pops.
   *
   * PATHS, not the tabs themselves: a reopen reads the file again, so a note
   * edited elsewhere between the close and the reopen comes back as it now is
   * (its buffer was flushed on the way out, so nothing is lost either way), and
   * a closed PDF or notebook costs nothing to hold on to. Only a close the USER
   * asked for is recorded: a rename, an overwrite or a vault switch takes a tab
   * away for a reason that reopening would undo (see releaseOverwritten).
   */
  const closedPathsRef = useRef<string[]>([]);
  // Two vaults share paths freely, so the stack is emptied on a switch rather
  // than left to resolve "notes/todo.md" against whichever vault is open now.
  useEffect(() => { closedPathsRef.current = []; }, [currentVaultId]);
  const rememberClosed = useCallback((paths: readonly string[]) => {
    // Closing, reopening and closing a note again puts it back on top rather
    // than leaving two entries for one document.
    const stack = closedPathsRef.current.filter(p => !paths.includes(p));
    stack.push(...paths);
    closedPathsRef.current = stack.slice(-CLOSED_TAB_MEMORY);
  }, []);

  // A close that could not save tries once more on its own after this long: told "your next change tries again", the
  // person had nothing left to change, and the close had already failed once.
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
          // A board's acknowledged write still finishes its after-write step as tracked work; checking before
          // it settles misreads a clean board as pending (seen closing a written drawing beside a PDF pane).
          if (result === 'written') await drain(tab.id);
          const pending = documentSessions.hasPendingEdits(tab.id);
          if (rootHandleRef.current !== root || !tabsRef.current.some(t => t.id === tab.id && t.file.path === path)) return;
          // The tab as it is NOW: the one captured when the close began may still say dirty for a write that has since landed.
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
          // Reopening while the save was in flight reuses this very document.
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
    // Hiding a board cancels a change still being prepared for it (a nudge, a paste, a delete of many items), so the close
    // waits, with the board on screen, for what the person already did to land. Measured: a select-all nudge of 220 PDF
    // annotations closed 80 ms after the key was dropped, and the close said it could not save; nothing reached the file.
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

  /**
   * Put the last closed document back (⌥⇧T), through the same opener a click in
   * the file tree uses.
   *
   * Reaches further back rather than failing: an entry already open again, or
   * whose file has since been trashed, renamed or moved, is dropped and the one
   * before it tried. So the chord either lands on a document or does nothing —
   * it never reopens a ghost tab of a file that is gone.
   */
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

  /**
   * Read an unreadable tab's file again (see OpenTab.readError). Resolves true
   * when the tab now holds the file's text.
   *
   * Serialized per document — a double click, or the pane's button and a tree
   * click together, would otherwise race two reads into one tab. The updaters
   * match on the tab's id, not its path: a close, rename or vault switch can
   * land mid-read, and must turn the result into a no-op rather than hand the
   * text to whatever answers to that path by then. A success remounts the pane
   * (EditorPane keys it on readError), so its view is built from the real text
   * exactly as on a fresh open.
   */
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
    // The guide's text is a chunk of the app, not a file: a restore that could not fetch it kept its tab, unreadable.
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
      // The asset-diff baseline the restore held back, taken under the path the
      // document answers to NOW.
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
      // Closed, or its vault switched away, while the read was out: nothing
      // left to update or to tell anyone about.
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
  // handleFileClick is declared long before this, and reads it through a ref
  // rather than growing a dependency.
  useEffect(() => { retryUnreadTabRef.current = retryUnreadTab; }, [retryUnreadTab, retryUnreadTabRef]);

  const pendingPdfMode = useRef(new Set<string>());
  const changeTabModeRef = useRef<(path: string | null, requestedMode?: EditorMode) => void>(() => {});
  const changeTabMode = useCallback((path: string | null, requestedMode?: EditorMode) => {
    if (!path) return;
    const tab = tabsRef.current.find(t => t.file.path === path);
    if (!tab || !canChangeTabMode(tab)) return;
    const mode = requestedMode ?? (tab.mode === 'edit' ? 'read' : 'edit');
    // A PDF whose DiskBar is up stays as it is until the bar is answered, and nothing else is said: the bar is the
    // message. Switched under it, Annotate refused with "The PDF source is not eligible for editing", and leaving Annotate
    // with unsaved ink left the pane on "Applying annotations…" behind "The board is read-only"; a refusal in a dialog
    // ("Could not continue") then covered the bar's own buttons (measured: Keep mine not reachable until it was dismissed).
    if (tab.representation.loadedKind === 'pdf' && mode !== tab.mode && diskStateRef.current.has(tab.id)) return;
    // A page turn being written: Annotate waits for it and opens on the turned pages (utils/pdfTurnHold.ts), so the
    // tab's mode stays what is on screen meanwhile; the same toggle again takes the request back.
    if (tab.representation.loadedKind === 'pdf' && pdfTurnHeld(tab.id)) {
      if (!requestedMode && cancelAfterPdfTurn(tab.id)) return;
      if (mode === 'edit') {
        // Made as any other switch to Annotate is, once the turn is released: the document is found again by id (it may
        // have been renamed meanwhile), and a tab showing Text goes through Original first, as the direct switch does.
        afterPdfTurn(tab.id, () => {
          const now = tabsRef.current.find(t => t.id === tab.id);
          if (now && now.mode === 'read') changeTabModeRef.current(now.file.path, 'edit');
        });
        return;
      }
      // An explicit request for reading (the agent's, a command's) withdraws a waiting Annotate switch as the toggle does.
      cancelAfterPdfTurn(tab.id);
    }
    if (mode === tab.mode) return;
    const view = getView(path);
    const nativeEntry = documentSessions.get(tab.id);
    const nativePdf = tab.representation.loadedKind === 'pdf' && hasHostedNativeOwner(nativeEntry, tab.id);
    if (tab.representation.loadedKind === 'pdf' && tab.mode === 'edit' && (view?.flushPending || nativePdf)) {
      if (pendingPdfMode.current.has(tab.id)) return;
      pendingPdfMode.current.add(tab.id);
      // Native ink reports through its document bridge, not the retired canvas view reporter.
      void Promise.resolve(view?.flushPending?.()).then(async () => {
        const needsSave = documentBuffers.isDirty(tab.id) || !nativePdf && tabsRef.current.find(t => t.id === tab.id)?.dirty;
        const outcome = await flushTab(path, !!needsSave);
        // Leaving Annotate goes ahead only once its ink is on disk (or there was none to write). A flush that met the other
        // program's write ('changed'), a deleted file, or a write that failed abandons the switch: the board stays up with
        // the ink, and the bar or the save notice says what happened. Committed regardless, the pane went to Original with
        // the ink unwritten and sat blank on "Applying annotations…" under the bar (measured: 4 of 4 timings).
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
