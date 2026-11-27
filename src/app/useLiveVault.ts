import { useEffect, useLayoutEffect, useRef } from 'react';
import type { FileTreeNode } from '../types';

export function useLiveVault(rootHandle: FileSystemDirectoryHandle | null, currentVaultId: string | null, fileTree: FileTreeNode[]) {
  const currentVaultIdRef = useRef<string | null>(currentVaultId);
  useLayoutEffect(() => { currentVaultIdRef.current = currentVaultId; }, [currentVaultId]);
  const rootHandleRef = useRef<FileSystemDirectoryHandle | null>(rootHandle);
  useEffect(() => { rootHandleRef.current = rootHandle; }, [rootHandle]);
  const fileTreeRef = useRef<FileTreeNode[]>(fileTree);
  useEffect(() => { fileTreeRef.current = fileTree; }, [fileTree]);
  const readerEpochRef = useRef({ root: rootHandle, epoch: 0 });
  // eslint-disable-next-line react-hooks/refs -- bumped in render, so the panes this render draws already mint identities under the new epoch
  if (readerEpochRef.current.root !== rootHandle) readerEpochRef.current = { root: rootHandle, epoch: readerEpochRef.current.epoch + 1 };
  return { currentVaultIdRef, rootHandleRef, fileTreeRef, readerEpochRef };
}
