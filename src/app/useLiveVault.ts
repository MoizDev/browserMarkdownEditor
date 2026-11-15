import { useEffect, useLayoutEffect, useRef } from 'react';
import type { FileTreeNode } from '../types';

/**
 * The vault on screen, mirrored into refs for the code that has to re-check it
 * after an await — every async pass in the app asks these, never the props it
 * started with, whether the vault it began in is still the one open.
 */
export function useLiveVault(rootHandle: FileSystemDirectoryHandle | null, currentVaultId: string | null, fileTree: FileTreeNode[]) {
  // The open vault, for the async restore pass to re-check after its awaits —
  // BOTH halves of it, because `currentVaultId` lags `rootHandle` — by
  // recordVault's IndexedDB write and labelling round trips — on every path
  // that commits the tree before awaiting `recordVault`. The id alone
  // cannot tell that pass a switch happened underneath it (see there).
  const currentVaultIdRef = useRef<string | null>(currentVaultId);
  useLayoutEffect(() => { currentVaultIdRef.current = currentVaultId; }, [currentVaultId]);
  const rootHandleRef = useRef<FileSystemDirectoryHandle | null>(rootHandle);
  useEffect(() => { rootHandleRef.current = rootHandle; }, [rootHandle]);
  // The tree as last committed, for callbacks that must not close over it.
  const fileTreeRef = useRef<FileTreeNode[]>(fileTree);
  useEffect(() => { fileTreeRef.current = fileTree; }, [fileTree]);
  // Which incarnation of the vault a reader's identity belongs to: bumped on
  // every root change, so a token minted before a switch never matches after.
  const readerEpochRef = useRef({ root: rootHandle, epoch: 0 });
  // eslint-disable-next-line react-hooks/refs -- bumped in render, so the panes this render draws already mint identities under the new epoch
  if (readerEpochRef.current.root !== rootHandle) readerEpochRef.current = { root: rootHandle, epoch: readerEpochRef.current.epoch + 1 };
  return { currentVaultIdRef, rootHandleRef, fileTreeRef, readerEpochRef };
}
