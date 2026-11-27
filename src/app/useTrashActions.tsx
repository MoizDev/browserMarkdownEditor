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

function trashedBy(node: FileTreeNode): (path: string) => boolean {
  return node.kind === 'directory'
    ? (path: string) => path.startsWith(`${node.path}/`)
    : (path: string) => path === node.path;
}

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

  const performTrash = useCallback(async (node: FileTreeNode): Promise<boolean> => {
    const doomed = trashedBy(node);
    // Tracked from here — NOT around a question, nor a notice after: a restore
    // pass must never sit waiting on a dialog (see vaultMovesRef).
    return trackVaultMove(async () => {
      const doomedTabs = tabsRef.current.filter(t => doomed(t.file.path));
      if (!await preparePdfDeparture(doomedTabs.map(t => t.file.path), true)) return false;
      const saved = await Promise.all(doomedTabs.filter(t => t.representation.loadedKind !== 'pdf').map(t => flushTab(t.file.path, false, true)));
      const savedTabs = doomedTabs.filter(t => t.representation.loadedKind !== 'pdf');
      if (saved.some((result, i) => {
        return result === 'failed' || (result === 'skipped' && documentSessions.hasPendingEdits(savedTabs[i].id));
      })) return false;
      await reconcileQueueRef.current;

      holdStatus(`Moving "${node.name}" to Trash…`);

      const trashed = await moveToTrash(node);
      setSaveStatus('');
      if (!trashed) return false;
      requeueAssetsAffected(node.path);

      const remaining = forgetEntry(getEntryStyles(), node.path);
      if (remaining !== getEntryStyles()) void writeEntryStyles(remaining);

      // A note a restore pass is still bringing back must not come back out of
      // the Trash as an open tab (issue #9) — it is not in tabsRef yet, so the
      // loop below cannot reach it. Only on success: a failed move moved nothing.
      const pending = pendingFor(rootHandleRef.current);
      if (pending) dropPending(pending, doomed);

      for (const tab of tabsRef.current) {
        if (doomed(tab.file.path)) removeTab(tab.file.path);
      }
      return true;
    });
  }, [moveToTrash, removeTab, flushTab, writeEntryStyles, trackVaultMove, pendingFor, requeueAssetsAffected, preparePdfDeparture, documentSessions, reconcileQueueRef, rootHandleRef, setSaveStatus, tabsRef, holdStatus]);

  const handleTrash = useCallback(async (node: FileTreeNode) => {
    if (trashInFlightRef.current) return;
    trashInFlightRef.current = true;
    try {
      const isFolder = node.kind === 'directory';

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

  const trashForAgent = useCallback(async (node: FileTreeNode): Promise<'ok' | 'busy' | 'failed'> => {
    if (trashInFlightRef.current) return 'busy';
    trashInFlightRef.current = true;
    try {
      return (await performTrash(node)) ? 'ok' : 'failed';
    } finally {
      trashInFlightRef.current = false;
    }
  }, [performTrash, trashInFlightRef]);

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

  const handleTrashEmpty = useCallback(async (count: number) =>
    (await loadChunk(() => import('./trashBin'))).handleTrashEmpty({
      trashInFlightRef, reconcileQueueRef, ask, tell, emptyTrash,
    }, count), [
      ask, tell, emptyTrash, reconcileQueueRef, trashInFlightRef,
    ]);

  const handleTrashReadText = useCallback(
    (item: TrashItem) => readFile(item.handle as FileSystemFileHandle), [readFile]);

  const handleTrashReadFile = useCallback(
    (item: TrashItem) => handleIO.file(item.handle as FileSystemFileHandle), [handleIO]);

  return { handleTrash, trashForAgent, handleTrashRestore, handleTrashCopy, handleTrashDelete, handleTrashEmpty, handleTrashReadText, handleTrashReadFile };
}
