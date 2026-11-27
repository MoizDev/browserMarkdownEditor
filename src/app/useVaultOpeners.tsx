import { useCallback, useRef } from 'react';
import type { FileSystemContextValue, FileTreeNode } from '../types';
import type { Notify, Tell } from './useAppDialogs';

export interface UseVaultOpenersDeps {
  pickDirectoryFromFileSystem: FileSystemContextValue['pickDirectory'];
  openRecentVault: FileSystemContextValue['openRecentVault'];
  openFolderAsVault: FileSystemContextValue['openFolderAsVault'];
  canLeavePdfVault: () => boolean;
  notify: Notify;
  tell: Tell;
}

export function useVaultOpeners(deps: UseVaultOpenersDeps) {
  const { pickDirectoryFromFileSystem, openRecentVault, openFolderAsVault, canLeavePdfVault, notify, tell } = deps;
  const pickDirectory = useCallback(async () => {
    const result = await pickDirectoryFromFileSystem();
    if (typeof result === 'object') {
      notify(result.message);
      return 'error' as const;
    }
    return result;
  }, [notify, pickDirectoryFromFileSystem]);

  const pickDirectorySafely = useCallback(() => canLeavePdfVault() ? pickDirectory() : Promise.resolve('refused' as const), [canLeavePdfVault, pickDirectory]);
  const openRecentVaultSafely = useCallback((vault: Parameters<typeof openRecentVault>[0]) => canLeavePdfVault() ? openRecentVault(vault) : Promise.resolve('refused' as const), [canLeavePdfVault, openRecentVault]);

  const openAsVaultInFlightRef = useRef<boolean>(false);

  const handleOpenAsVault = useCallback(async (node: FileTreeNode) => {
    if (node.kind !== 'directory') return;
    if (openAsVaultInFlightRef.current) return;
    openAsVaultInFlightRef.current = true;
    try {
      if (!canLeavePdfVault()) return;
      const result = await openFolderAsVault(node.handle);
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
