import type React from 'react';
import type { FileSystemContextValue, FileTreeNode, OpenTab, TrashItem, TrashRestoreResult } from '../types';
import { ASSETS_DIR } from '../utils/assets';
import { forgetEntry } from '../utils/entryStyle';
import { getEntryStyles } from '../utils/entryStyleStore';
import { joinVaultPath } from '../utils/paths';
import { dropPending, type PendingRestore } from '../utils/pendingRestore';
import type { DocumentSessionStore } from '../utils/documentSessions';
import type { FlushTab } from './types';
import type { AppDialogs, Ask, Notify, Tell } from './useAppDialogs';

import type { UseTrashActionsDeps } from './useTrashActions';

export type TrashBinDeps = UseTrashActionsDeps;

export async function handleTrashRestore(deps: Pick<TrashBinDeps,
  'rootHandleRef' | 'tabsRef' | 'trashInFlightRef' | 'reconcileQueueRef' | 'showStatus' | 'tell' |
  'askChoice' | 'restoreFromTrash' | 'removeTab' | 'flushTab' | 'preparePdfDeparture' | 'documentSessions' |
  'requeueAssetsAffected' | 'writeEntryStyles' | 'pendingFor' | 'trackVaultMove'
>, item: TrashItem): Promise<TrashRestoreResult> {
  const {
    rootHandleRef, tabsRef, trashInFlightRef, reconcileQueueRef, showStatus, tell, askChoice,
    restoreFromTrash, removeTab, flushTab, preparePdfDeparture, documentSessions, requeueAssetsAffected,
    writeEntryStyles, pendingFor, trackVaultMove,
  } = deps;
  if (trashInFlightRef.current) return { status: 'error' };
  trashInFlightRef.current = true;
  try {
    await reconcileQueueRef.current;
    const where = item.origin === 'retired'
      ? joinVaultPath(item.restorePath, ASSETS_DIR)
      : (item.restorePath || 'the vault root');
    const taken = item.origin === 'retired' ? null : joinVaultPath(item.restorePath, item.name);
    const doomed = (tab: typeof tabsRef.current[number]) =>
      !!taken && !tab.file.isHelp &&
      (tab.file.path === taken || tab.file.path.startsWith(`${taken}/`));
    let result = await restoreFromTrash(item, 'auto');

    if (result.status === 'collision') {
      const choice = await askChoice({
        title: 'That name is taken',
        confirmLabel: 'Replace',
        altLabel: 'Keep both',
        danger: true,
        body: (
          <>
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
        result = await trackVaultMove(async () => {
          const displacedTabs = tabsRef.current.filter(doomed);
          if (!await preparePdfDeparture(displacedTabs.map(t => t.file.path), true)) return { status: 'error' as const };
          const savedTabs = displacedTabs.filter(t => t.representation.loadedKind !== 'pdf');
          const saved = await Promise.all(savedTabs.map(t => flushTab(t.file.path, false, true)));
          if (saved.some((result, i) => {
            return result === 'failed' || (result === 'skipped' && documentSessions.hasPendingEdits(savedTabs[i].id));
          })) return { status: 'error' as const };
          await reconcileQueueRef.current;
          const replaced = await restoreFromTrash(item, 'replace');
          if (replaced.status === 'ok') {
            for (const tab of tabsRef.current) if (doomed(tab)) removeTab(tab.file.path);
            const pending = pendingFor(rootHandleRef.current);
            if (pending && taken) {
              dropPending(pending, path => path === taken || path.startsWith(`${taken}/`));
            }
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
      if (result.name !== item.name) {
        showStatus(`Put back as “${result.name}”`, 4000);
      }
    }
    return result;
  } finally {
    trashInFlightRef.current = false;
  }
}

export async function handleTrashCopy(deps: Pick<TrashBinDeps,
  'rootHandle' | 'trashInFlightRef' | 'reconcileQueueRef' | 'announce' | 'notify' | 'getVaultActivation' |
  'copyTrashFile'
>, item: TrashItem) {
  const {
    rootHandle, trashInFlightRef, reconcileQueueRef, announce, notify, getVaultActivation, copyTrashFile,
  } = deps;
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
}

export async function handleTrashDelete(deps: Pick<TrashBinDeps,
  'trashInFlightRef' | 'reconcileQueueRef' | 'ask' | 'tell' | 'deleteFromTrash'
>, item: TrashItem) {
  const {
    trashInFlightRef, reconcileQueueRef, ask, tell, deleteFromTrash,
  } = deps;
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
}

export async function handleTrashEmpty(deps: Pick<TrashBinDeps,
  'trashInFlightRef' | 'reconcileQueueRef' | 'ask' | 'tell' | 'emptyTrash'
>, count: number) {
  const {
    trashInFlightRef, reconcileQueueRef, ask, tell, emptyTrash,
  } = deps;
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
}
