import type React from 'react';
import { useCallback } from 'react';
import type { FileSystemContextValue, FileTreeNode, OpenTab, TrashItem, TrashRestoreResult } from '../types';
import { ASSETS_DIR } from '../utils/assets';
import { forgetEntry } from '../utils/entryStyle';
import { getEntryStyles } from '../utils/entryStyleStore';
import { joinVaultPath } from '../utils/paths';
import { dropPending, type PendingRestore } from '../utils/pendingRestore';
import type { DocumentSessionStore } from '../utils/documentSessions';
import { collectFiles } from '../utils/tree';
import type { FlushTab } from './types';
import type { AppDialogs, Ask, Notify, Tell } from './useAppDialogs';

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
    copyTrashFile, deleteFromTrash, emptyTrash, readFile, handleIO, removeTab, flushTab,
    preparePdfDeparture, documentSessions, requeueAssetsAffected, writeEntryStyles, pendingFor, trackVaultMove,
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
  }, [moveToTrash, removeTab, flushTab, writeEntryStyles, trackVaultMove, pendingFor, requeueAssetsAffected, preparePdfDeparture, documentSessions, reconcileQueueRef, rootHandleRef, setSaveStatus, tabsRef]);

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
  const handleTrashRestore = useCallback(async (item: TrashItem): Promise<TrashRestoreResult> => {
    if (trashInFlightRef.current) return { status: 'error' };
    trashInFlightRef.current = true;
    try {
      await reconcileQueueRef.current;
      // Where the clash actually is — a retired picture goes back INSIDE that
      // folder's `.Assets`, so naming the folder itself would send the reader
      // looking at the wrong one.
      const where = item.origin === 'retired'
        ? joinVaultPath(item.restorePath, ASSETS_DIR)
        : (item.restorePath || 'the vault root');
      // Which open documents a 'replace' would take with it: the entry standing
      // at the destination name, and — when that entry is a FOLDER — every
      // document open from inside it. Both, by one prefix test, because App
      // cannot know which kind is in the way until the copy resolves it, and a
      // file has no children for the `/` branch to match anyway. A retired
      // picture's destination is `.Assets`, which nothing opens as a tab. The
      // Help guide is excluded: its pseudo-path is a bare name (`help-guide`),
      // so a vault folder of that name would otherwise close it.
      const taken = item.origin === 'retired' ? null : joinVaultPath(item.restorePath, item.name);
      const doomed = (tab: typeof tabsRef.current[number]) =>
        !!taken && !tab.file.isHelp &&
        (tab.file.path === taken || tab.file.path.startsWith(`${taken}/`));
      // Asked for without permission to overwrite: a taken name comes back as
      // a collision with nothing touched, and the reader decides.
      let result = await restoreFromTrash(item, 'auto');

      if (result.status === 'collision') {
        const choice = await askChoice({
          title: 'That name is taken',
          confirmLabel: 'Replace',
          altLabel: 'Keep both',
          danger: true,
          body: (
            <>
              {/* `where` is a real path everywhere except one case — a file
                  trashed from the vault root — where it is prose, and prose set
                  in monospace reads as a folder nobody has. */}
              {item.restorePath || item.origin === 'retired' ? <code>{where}</code> : 'The vault root'}
              {' '}already holds something called <strong>{item.name}</strong>.
              Replacing it moves what is there now into that folder’s own <code>.Garbage</code> —
              it will be waiting here in the Trash, not erased. Keeping both puts this one back
              under a numbered name.
            </>
          ),
        });
        if (choice === 'cancel') return { status: 'collision' };

        if (choice === 'confirm') {
          // Tracked (see vaultMovesRef): a Replace displaces documents exactly
          // as a trash does, and the path it frees is filled again at once — so
          // a restore pass's re-check at the merge would find it standing and
          // could not tell it holds different bytes. Only the registry drop
          // below catches that.
          result = await trackVaultMove(async () => {
            // Write out what is still in the save debounce, so the copy that
            // gets displaced into `.Garbage` carries the reader's last words
            // rather than the disk's — handleTrash's reason, and its ordering.
            const displacedTabs = tabsRef.current.filter(doomed);
            if (!await preparePdfDeparture(displacedTabs.map(t => t.file.path), true)) return { status: 'error' as const };
            const savedTabs = displacedTabs.filter(t => t.representation.loadedKind !== 'pdf');
            const saved = await Promise.all(savedTabs.map(t => flushTab(t.file.path, false, true)));
            if (saved.some((result, i) => {
              return result === 'failed' || (result === 'skipped' && documentSessions.hasPendingEdits(savedTabs[i].id));
            })) return { status: 'error' as const };
            // …and re-drain the reconcile queue: the question above took real
            // time, and a retire can have queued a picture move into the very
            // `.Garbage/.Assets` a retired put-back is about to read.
            await reconcileQueueRef.current;
            const replaced = await restoreFromTrash(item, 'replace');
            // The displaced entry's bytes have just moved into `.Garbage`, and
            // every tab that was open from it still holds a handle resolving to
            // that DIRECTORY ENTRY — which the restored copy now occupies. Left
            // open, the next keystroke in one of them writes the displaced bytes
            // straight over the note that was just put back (measured: putting a
            // trashed `homework` back over a live one restored its `hw1.md`, and
            // one keystroke in the still-open tab turned it back into the live
            // file's text). releaseOverwritten's hazard exactly. Closed WITHOUT
            // flushing — that already happened above, before the copy.
            if (replaced.status === 'ok') {
              for (const tab of tabsRef.current) if (doomed(tab)) removeTab(tab.file.path);
              // A document a restore pass is still bringing back from there has
              // been displaced just the same (issue #9); tabsRef cannot reach it.
              const pending = pendingFor(rootHandleRef.current);
              if (pending && taken) {
                dropPending(pending, path => path === taken || path.startsWith(`${taken}/`));
              }
              // The displaced entry's icon and colour go into the Trash with it,
              // or the item that just took its path inherits a look nobody
              // chose — handleTrash's reason for forgetting them at trash time.
              if (taken) {
                const remaining = forgetEntry(getEntryStyles(), taken);
                if (remaining !== getEntryStyles()) void writeEntryStyles(remaining);
              }
            }
            return replaced;
          });
        } else {
          result = await restoreFromTrash(item, 'keep-both');
        }
      }

      if (result.status === 'error') {
        await tell({
          title: 'Nothing was put back',
          confirmLabel: 'OK',
          body: (
            <>
              <strong>{item.name}</strong> is still in the Trash, and nothing was left half-done.
              The details are in the browser console. Try again in a moment.
            </>
          ),
        });
        return result;
      }

      if (result.status === 'ok') {
        requeueAssetsAffected(joinVaultPath(item.restorePath, result.name));
        // A numbered rename must never be silent — "Keep both" says there will
        // be a number, not what it is. Re-armed over any pending "Saved", the
        // way handleTrash re-arms it.
        if (result.name !== item.name) {
          showStatus(`Put back as “${result.name}”`, 4000);
        }
      }
      return result;
    } finally {
      trashInFlightRef.current = false;
    }
  }, [restoreFromTrash, askChoice, tell, removeTab, flushTab, writeEntryStyles, trackVaultMove, pendingFor, requeueAssetsAffected, preparePdfDeparture, documentSessions, reconcileQueueRef, rootHandleRef, tabsRef, trashInFlightRef]);

  /** Erase one trashed item. One of the app's two points of no return. */
  const handleTrashCopy = useCallback(async (item: TrashItem) => {
    if (!rootHandle || trashInFlightRef.current) return;
    trashInFlightRef.current = true;
    const activation = getVaultActivation();
    const current = () => getVaultActivation() === activation;
    try {
      await reconcileQueueRef.current;
      const name = await copyTrashFile(item, rootHandle, current);
      if (current()) announce(`Restored a copy as "${name}". The Trash original remains.`);
    } catch (error) {
      console.error('Could not copy from Trash:', error);
      if (current()) notify('Could not restore the copy. Nothing was replaced.');
    } finally { trashInFlightRef.current = false; }
  }, [announce, copyTrashFile, getVaultActivation, notify, rootHandle, reconcileQueueRef, trashInFlightRef]);

  const handleTrashDelete = useCallback(async (item: TrashItem) => {
    if (trashInFlightRef.current) return false;
    trashInFlightRef.current = true;
    try {
      const confirmed = await ask({
        title: 'Delete for good?',
        confirmLabel: 'Delete permanently',
        danger: true,
        body: (
          <>
            <strong>{item.name}</strong>{item.kind === 'directory' ? ' and everything inside it' : ''} is
            erased from your disk. This is one of the only two things in this app that cannot be
            undone — there is no second copy anywhere.
          </>
        ),
      });
      if (!confirmed) return false;

      await reconcileQueueRef.current;
      const done = await deleteFromTrash(item);
      if (!done) {
        await tell({
          title: 'Nothing was deleted',
          confirmLabel: 'OK',
          body: (
            <>
              <strong>{item.name}</strong> is still in the Trash. Something inside it may be in use;
              the details are in the browser console.
            </>
          ),
        });
      }
      return done;
    } finally {
      trashInFlightRef.current = false;
    }
  }, [ask, tell, deleteFromTrash, reconcileQueueRef, trashInFlightRef]);

  /** Erase every `.Garbage` in the vault. The other point of no return. */
  const handleTrashEmpty = useCallback(async (count: number) => {
    if (trashInFlightRef.current) return false;
    trashInFlightRef.current = true;
    try {
      const confirmed = await ask({
        title: 'Empty the Trash?',
        confirmLabel: 'Empty bin',
        danger: true,
        body: (
          <>
            All {count} item{count === 1 ? '' : 's'} here are erased from your disk, and so is
            every <code>.Garbage</code> folder in this vault — deleted notes, deleted folders, and
            pictures your notes stopped using. There is no second copy of any of it, and nothing
            brings it back.
          </>
        ),
      });
      if (!confirmed) return false;

      await reconcileQueueRef.current;
      const { removed, failed } = await emptyTrash();
      if (!removed && count > 0) {
        await tell({
          title: 'Nothing was deleted',
          confirmLabel: 'OK',
          body: <>The Trash is still where it was. The details are in the browser console.</>,
        });
        return false;
      }
      // Partly done is not done, and the panel would otherwise clear its list
      // and say the bin was empty while those folders still held their files.
      if (failed) {
        await tell({
          title: 'Some of it is still there',
          confirmLabel: 'OK',
          body: (
            <>
              {failed} folder{failed === 1 ? '' : 's'} would not empty — something inside may be in
              use. The rest is gone. Open the Trash again to see what is left; the details are in
              the browser console.
            </>
          ),
        });
        return false;
      }
      return true;
    } finally {
      trashInFlightRef.current = false;
    }
  }, [ask, tell, emptyTrash, reconcileQueueRef, trashInFlightRef]);

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

  return { performTrash, handleTrash, trashForAgent, handleTrashRestore, handleTrashCopy, handleTrashDelete, handleTrashEmpty, handleTrashReadText, handleTrashReadFile };
}
