import type React from 'react';
import { useCallback } from 'react';
import type { FileSystemContextValue, FileTreeNode, OpenTab, TrashItem, TrashRestoreResult } from '../types';
import { ASSETS_DIR } from '../utils/assets';
import { forgetEntry } from '../utils/entryStyle';
import { getEntryStyles } from '../utils/entryStyleStore';
import { dropPending, type PendingRestore } from '../utils/pendingRestore';
import type { DocumentSessionStore } from '../utils/documentSessions';
import { collectFiles } from '../utils/tree';
import type { FlushTab } from './types';
import type { AppDialogs, Ask, Notify, Tell } from './useAppDialogs';
import { loadChunk } from '../platform/chunkLoad';

/** Which open documents trashing `node` takes. A folder's own path is never a
 *  document's — except that the Help guide's pseudo-path is a bare name, so a
 *  vault folder called "help-guide" closed the Help tab. Only a FILE is matched
 *  by equality; a folder is matched by the `path/` prefix and nothing else. */
function trashedBy(node: FileTreeNode): (path: string) => boolean {
  return node.kind === 'directory'
    ? (path: string) => path.startsWith(`${node.path}/`)
    : (path: string) => path === node.path;
}

/** The App-scope values `useTrashActions` reads, named as App names them. */
export interface UseTrashActionsDeps {
  rootHandle: FileSystemContextValue['rootHandle'];
  rootHandleRef: React.RefObject<FileSystemDirectoryHandle | null>;
  tabsRef: React.RefObject<OpenTab[]>;
  trashInFlightRef: React.RefObject<boolean>;
  reconcileQueueRef: React.RefObject<Promise<void>>;
  setSaveStatus: React.Dispatch<React.SetStateAction<string>>;
  holdStatus: (message: string) => void;
  showStatus: (message: string, ms: number) => void;
  announce: (message: string) => void;
  notify: Notify;
  ask: Ask;
  tell: Tell;
  askChoice: AppDialogs['askChoice'];
  getVaultActivation: FileSystemContextValue['getVaultActivation'];
  moveToTrash: FileSystemContextValue['moveToTrash'];
  restoreFromTrash: FileSystemContextValue['restoreFromTrash'];
  copyTrashFile: FileSystemContextValue['copyTrashFile'];
  deleteFromTrash: FileSystemContextValue['deleteFromTrash'];
  emptyTrash: FileSystemContextValue['emptyTrash'];
  readFile: FileSystemContextValue['readFile'];
  handleIO: FileSystemContextValue['handleIO'];
  removeTab: (path: string) => void;
  flushTab: FlushTab;
  preparePdfDeparture: (paths: readonly string[], trashOwned?: boolean) => Promise<boolean>;
  documentSessions: DocumentSessionStore;
  requeueAssetsAffected: (path: string) => void;
  writeEntryStyles: (next: ReturnType<typeof getEntryStyles>) => Promise<void>;
  pendingFor: (root: FileSystemDirectoryHandle | null) => PendingRestore | null;
  trackVaultMove: <T>(work: () => Promise<T>) => Promise<T>;
}

export function useTrashActions(deps: UseTrashActionsDeps) {
  const {
    rootHandle, rootHandleRef, tabsRef, trashInFlightRef, reconcileQueueRef, setSaveStatus, holdStatus,
    showStatus, announce, notify, ask, tell, askChoice, getVaultActivation, moveToTrash, restoreFromTrash,
    copyTrashFile, deleteFromTrash, emptyTrash, readFile, handleIO, removeTab, flushTab, preparePdfDeparture,
    documentSessions, requeueAssetsAffected, writeEntryStyles, pendingFor, trackVaultMove,
  } = deps;

  /**
   * Move a file — or a whole folder, contents and all — to the Trash.
   *
   * A folder takes every document open from anywhere INSIDE it with it, which
   * is the whole difference from deleting one file. Left open, those tabs go on
   * drawing notes that no longer exist, holding handles that resolve to nothing,
   * and are written back into the stored session on the next layout change.
   *
   * ONE AT A TIME, and everything pending is written out FIRST. Both follow from
   * the same fact: unlike every other deletion in this app, trashing a folder is
   * a copy of arbitrary size, and it runs for as long as that takes. See below.
   */

  /**
   * The move itself, with no question in front of it — shared by the reader's
   * delete (after its confirm) and the AI agent's `vault_trash`, which the chat
   * shows instead of asking. The caller holds `trashInFlightRef`.
   */
  const performTrash = useCallback(async (node: FileTreeNode): Promise<boolean> => {
    const doomed = trashedBy(node);
    // Tracked from here — NOT around a question, nor a notice after: a restore
    // pass must never sit waiting on a dialog (see vaultMovesRef).
    return trackVaultMove(async () => {
      // Write out what is still in the save debounce BEFORE the copy starts.
      // The tabs inside a folder stay live and editable for the whole copy, and
      // their save timers stay armed — so a debounced write would land on an
      // original that `removeEntry` then destroys, AFTER the walk had already
      // copied the older bytes. Whether the edit survived came down to where the
      // note happened to fall in an arbitrary `entries()` order. Flushed rather
      // than merely cancelled: the copy then carries the reader's last words,
      // which is what a trash folder is for.
      const doomedTabs = tabsRef.current.filter(t => doomed(t.file.path));
      if (!await preparePdfDeparture(doomedTabs.map(t => t.file.path), true)) return false;
      const saved = await Promise.all(doomedTabs.filter(t => t.representation.loadedKind !== 'pdf').map(t => flushTab(t.file.path, false, true)));
      const savedTabs = doomedTabs.filter(t => t.representation.loadedKind !== 'pdf');
      if (saved.some((result, i) => {
        return result === 'failed' || (result === 'skipped' && documentSessions.hasPendingEdits(savedTabs[i].id));
      })) return false;
      // …and let the asset reconciles those saves queued run to completion, so
      // nothing moves a picture between `.Assets` and `.Garbage/.Assets` while
      // copyDirRecursive is walking one of them.
      await reconcileQueueRef.current;

      // The copy has no other outward sign, and an app that looks frozen is one
      // people click again. Re-armed over any "Saved" the flush above left, whose
      // own timer would otherwise clear this line mid-copy.
      holdStatus(`Moving "${node.name}" to Trash…`);

      const trashed = await moveToTrash(node);
      setSaveStatus('');
      if (!trashed) return false;
      requeueAssetsAffected(node.path);

      // A trashed row's icon and colour go with it, and a folder's takes
      // everything inside it — otherwise the entry sits in the file forever, and
      // something later given the same name inherits a look nobody chose. Its
      // place in a custom order goes too, for the same reason.
      const remaining = forgetEntry(getEntryStyles(), node.path);
      if (remaining !== getEntryStyles()) void writeEntryStyles(remaining);

      // A note a restore pass is still bringing back must not come back out of
      // the Trash as an open tab (issue #9) — it is not in tabsRef yet, so the
      // loop below cannot reach it. Only on success: a failed move moved nothing.
      const pending = pendingFor(rootHandleRef.current);
      if (pending) dropPending(pending, doomed);

      // What the deletion took with it. Read AFTER the move, not before: the
      // predicate is a path test and does not move, but a document opened while
      // the copy was running has to be closed too.
      // Closed WITHOUT flushing — that already happened above, and their handles
      // are gone now.
      for (const tab of tabsRef.current) {
        if (doomed(tab.file.path)) removeTab(tab.file.path);
      }
      return true;
    });
  }, [moveToTrash, removeTab, flushTab, writeEntryStyles, trackVaultMove, pendingFor, requeueAssetsAffected, preparePdfDeparture, documentSessions, reconcileQueueRef, rootHandleRef, setSaveStatus, tabsRef, holdStatus]);

  const handleTrash = useCallback(async (node: FileTreeNode) => {
    // A folder copy runs for seconds, and its row stays on screen throughout —
    // so "I clicked delete and nothing happened, click it again" is the natural
    // thing to do, and unguarded it ran two copies at once: one completed, the
    // other was abandoned half-written when the source vanished under it, and
    // the loser's `alert` then told the user a deletion that had SUCCEEDED had
    // failed. Same shape, same reason, as pickDirectory's pickerOpenRef.
    //
    // It covers the QUESTION as well as the copy, which `confirm()` used to get
    // for free by freezing the page: the app's own dialog does not block, so
    // without this a second click would stack a second question behind the
    // first. (The overlay stops the pointer reaching the tree either way; this
    // is what stops anything else from.)
    if (trashInFlightRef.current) return;
    trashInFlightRef.current = true;
    try {
      const isFolder = node.kind === 'directory';

      // Say what is actually going. "…and everything inside it" reads the same
      // for two notes as for two thousand, and is plainly wrong for an empty one.
      const files = node.kind === 'directory' ? collectFiles(node.children).length : 0;
      const beside = <>the <code>.Garbage</code> folder beside it</>;
      const confirmed = await ask({
        title: isFolder ? 'Move folder to Trash?' : 'Move to Trash?',
        confirmLabel: 'Move to Trash',
        danger: true,
        body: files > 0 ? (
          <>
            <strong>{node.name}</strong> and the {files} file{files === 1 ? '' : 's'} inside it move
            into {beside} — sub-folders, pictures and its own trash included. Notes you have open
            from it are saved first, then closed. Nothing leaves your disk: you can take it all
            back out whenever you like.
          </>
        ) : (
          <>
            <strong>{node.name}</strong> moves into {beside}. Nothing leaves your disk: you can
            take it back out whenever you like.
          </>
        ),
      });
      if (!confirmed) return;

      const moved = await performTrash(node);
      if (!moved) {
        // Never silence: from the outside a click that does nothing is
        // indistinguishable from a broken button. And the reassurance is worth
        // as much as the failure — the move is all-or-nothing, so there is no
        // half-deleted state to go looking for.
        await tell({
          title: 'Nothing was moved',
          confirmLabel: 'OK',
          body: (
            <>
              <strong>{node.name}</strong> is still where it was, and nothing was left half-done.
              Something inside it may be in use; the details are in the browser console. Try again
              in a moment.
            </>
          ),
        });
      }
    } finally {
      trashInFlightRef.current = false;
    }
  }, [performTrash, ask, tell, trashInFlightRef]);

  /** The agent's delete: no question (the chat shows it), same serialization. */
  const trashForAgent = useCallback(async (node: FileTreeNode): Promise<'ok' | 'busy' | 'failed'> => {
    if (trashInFlightRef.current) return 'busy';
    trashInFlightRef.current = true;
    try {
      return (await performTrash(node)) ? 'ok' : 'failed';
    } finally {
      trashInFlightRef.current = false;
    }
  }, [performTrash, trashInFlightRef]);

  /* ── The Trash bin ──────────────────────────────────────────────────────
   * The panel draws the list and owns nothing else: every one of these asks
   * the question, takes the SAME in-flight ref `handleTrash` does, and drains
   * the asset-reconcile queue first.
   *
   * The shared ref is deliberate. All four are copy-then-delete over the same
   * vault, so two at once is the abandoned-half-written-copy hazard
   * handleTrash documents — and the guard has to cover the QUESTION as well as
   * the copy, because only one dialog fits on screen: a second `ask` raised
   * while one is up leaves the first promise unresolved for the session.
   * Draining `reconcileQueueRef` matters for the same reason it does there —
   * a retire may be moving a picture between `.Assets` and `.Garbage/.Assets`
   * at that moment, which is exactly what the bin is reading and writing.
   * ─────────────────────────────────────────────────────────────────────── */

  /** Put one trashed item back beside the `.Garbage` it was found in. */
  const handleTrashRestore = useCallback(async (item: TrashItem): Promise<TrashRestoreResult> =>
    (await loadChunk(() => import('./trashBin'))).handleTrashRestore({
      rootHandleRef, tabsRef, trashInFlightRef, reconcileQueueRef, showStatus, tell, askChoice,
      restoreFromTrash, removeTab, flushTab, preparePdfDeparture, documentSessions, requeueAssetsAffected,
      writeEntryStyles, pendingFor, trackVaultMove,
    }, item), [
      restoreFromTrash, askChoice, tell, removeTab, flushTab, writeEntryStyles, trackVaultMove, pendingFor,
      requeueAssetsAffected, preparePdfDeparture, documentSessions, reconcileQueueRef, rootHandleRef,
      tabsRef, trashInFlightRef, showStatus,
    ]);

  /** Erase one trashed item. One of the app's two points of no return. */
  const handleTrashCopy = useCallback(async (item: TrashItem) =>
    (await loadChunk(() => import('./trashBin'))).handleTrashCopy({
      rootHandle, trashInFlightRef, reconcileQueueRef, announce, notify, getVaultActivation, copyTrashFile,
    }, item), [
      announce, copyTrashFile, getVaultActivation, notify, rootHandle, reconcileQueueRef, trashInFlightRef,
    ]);

  const handleTrashDelete = useCallback(async (item: TrashItem) =>
    (await loadChunk(() => import('./trashBin'))).handleTrashDelete({
      trashInFlightRef, reconcileQueueRef, ask, tell, deleteFromTrash,
    }, item), [
      ask, tell, deleteFromTrash, reconcileQueueRef, trashInFlightRef,
    ]);

  /** Erase every `.Garbage` in the vault. The other point of no return. */
  const handleTrashEmpty = useCallback(async (count: number) =>
    (await loadChunk(() => import('./trashBin'))).handleTrashEmpty({
      trashInFlightRef, reconcileQueueRef, ask, tell, emptyTrash,
    }, count), [
      ask, tell, emptyTrash, reconcileQueueRef, trashInFlightRef,
    ]);

  /** The bin's read-only preview of a trashed text file. */
  const handleTrashReadText = useCallback(
    (item: TrashItem) => readFile(item.handle as FileSystemFileHandle), [readFile]);

  /** The bytes behind the bin's picture preview. Here rather than in the panel
   *  so no component calls the File System Access API itself (AGENTS.md). The
   *  cast is sound for the same reason `handleTrashReadText`'s is: the crawl only
   *  ever hands a file handle to an item whose `kind` is 'file', and the preview
   *  asks for nothing else. */
  const handleTrashReadFile = useCallback(
    (item: TrashItem) => handleIO.file(item.handle as FileSystemFileHandle), [handleIO]);

  return { handleTrash, trashForAgent, handleTrashRestore, handleTrashCopy, handleTrashDelete, handleTrashEmpty, handleTrashReadText, handleTrashReadFile };
}
