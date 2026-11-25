import { useCallback, useRef } from 'react';
import type { FileSystemContextValue, FileTreeNode } from '../types';
import type { Notify, Tell } from './useAppDialogs';

export interface UseVaultOpenersDeps {
  pickDirectoryFromFileSystem: FileSystemContextValue['pickDirectory'];
  openRecentVault: FileSystemContextValue['openRecentVault'];
  openFolderAsVault: FileSystemContextValue['openFolderAsVault'];
  /** False while a PDF's annotations are still unsaved: the vault stays open. */
  canLeavePdfVault: () => boolean;
  notify: Notify;
  tell: Tell;
}

/** Every way the reader opens another vault: the picker, the vault menu, a tree folder. */
export function useVaultOpeners(deps: UseVaultOpenersDeps) {
  const { pickDirectoryFromFileSystem, openRecentVault, openFolderAsVault, canLeavePdfVault, notify, tell } = deps;
  // Context reports the failure; only App owns the notice, including before a
  // vault is open. Keep the legacy string result for the welcome/menu callers.
  const pickDirectory = useCallback(async () => {
    const result = await pickDirectoryFromFileSystem();
    if (typeof result === 'object') {
      notify(result.message);
      return 'error' as const;
    }
    return result;
  }, [notify, pickDirectoryFromFileSystem]);

  // Keep the gesture synchronous for the directory picker/permission prompt.
  // A refused PDF revision stays in its current vault instead of being dropped
  // by the workspace reset before an asynchronous refusal can reach it.
  // 'refused', not 'busy': canLeavePdfVault has said why, and 'busy' added "Another vault is still opening" under it.
  const pickDirectorySafely = useCallback(() => canLeavePdfVault() ? pickDirectory() : Promise.resolve('refused' as const), [canLeavePdfVault, pickDirectory]);
  const openRecentVaultSafely = useCallback((vault: Parameters<typeof openRecentVault>[0]) => canLeavePdfVault() ? openRecentVault(vault) : Promise.resolve('refused' as const), [canLeavePdfVault, openRecentVault]);

  /**
   * Open a folder in the tree as the vault — the file tree's "Open as Vault"
   * row, and the same switch as picking that folder in the OS picker.
   *
   * Nothing is flushed or closed here: setting `rootHandle` is what makes this a
   * vault switch, and the switch effect above already flushes every open tab
   * (its handles are still good) before emptying the workspace. Every failure is
   * said out loud, because from the sidebar a switch that did not happen is
   * indistinguishable from one that did and found an empty folder — the rule
   * VaultMenu.messageFor states for the vault list.
   *
   * ONE AT A TIME. Two switches in flight are two vault walks racing, and the
   * one that FINISHES last wins the tree — which can be the one that started
   * FIRST, leaving the sidebar on vault A while `rootHandle`, IndexedDB and
   * `currentVaultId` all say vault B. The tree is where that is easiest to
   * start: setRootHandle lands early, but the OLD vault's rows stay on screen
   * until the new walk finishes — seconds on a big vault — so the folder just
   * right-clicked is still sitting there, still offering the row.
   *
   * Racing a DIFFERENT raiser is the provider's `switchInFlightRef`, which is
   * why 'busy' is not an error here. This ref covers the two things that gate
   * cannot: a second click on the tree, and the dialog below — which, like
   * handleTrash's, must not have a second question stacked behind it.
   */
  const openAsVaultInFlightRef = useRef<boolean>(false);

  const handleOpenAsVault = useCallback(async (node: FileTreeNode) => {
    if (node.kind !== 'directory') return;
    if (openAsVaultInFlightRef.current) return;
    openAsVaultInFlightRef.current = true;
    try {
      if (!canLeavePdfVault()) return;
      const result = await openFolderAsVault(node.handle);
      // 'busy' is another raiser's switch still walking, not a failure — the
      // ref above only covers a second click on the TREE. The vault menu says
      // so inline; a tree row has nowhere to put a note, and a modal for "not
      // yet" would be louder than the thing it reports, so here it stays silent.
      if (result === 'ok' || result === 'busy') return;
      await tell({
        title: 'Could not open that folder as a vault',
        confirmLabel: 'OK',
        body: result === 'denied'
          ? <>Permission to read and write <strong>{node.name}</strong> was refused.</>
          : result === 'missing'
            ? <><strong>{node.name}</strong> is no longer on disk.</>
            : <><strong>{node.name}</strong> could not be opened.</>,
      });
    } finally {
      openAsVaultInFlightRef.current = false;
    }
  }, [openFolderAsVault, tell, canLeavePdfVault]);
  return { pickDirectorySafely, openRecentVaultSafely, handleOpenAsVault };
}
