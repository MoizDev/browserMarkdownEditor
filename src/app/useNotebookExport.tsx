import type React from 'react';
import { useCallback, useRef } from 'react';
import type { ActiveFile, FileSystemContextValue, FileTreeNode, OpenTab } from '../types';
import type { DiskVersion } from '../utils/diskVersion';
import type { SetTabs } from './types';
import type { Ask, Notify, Tell } from './useAppDialogs';
import { ensureNotebookExt, isNotebookFile, stripPdfExt } from '../utils/fileTypes';
import { joinVaultPath, parentVaultPath } from '../utils/paths';
import { collectFiles } from '../utils/tree';
import { loadChunk } from '../platform/chunkLoad';

export interface UseNotebookExportDeps {
  fileTree: FileSystemContextValue['fileTree'];
  handleFileClick: (node: FileTreeNode) => Promise<boolean>;
  tell: Tell;
  ask: Ask;
  notify: Notify;
  getVaultActivation: FileSystemContextValue['getVaultActivation'];
  tabsRef: React.RefObject<OpenTab[]>;
  setTabs: SetTabs;
  rootHandleRef: React.RefObject<FileSystemDirectoryHandle | null>;
  currentVaultIdRef: React.RefObject<string | null>;
  readerEpochRef: React.RefObject<{ root: FileSystemDirectoryHandle | null; epoch: number }>;
  trashInFlightRef: React.RefObject<boolean>;
  reconcileQueueRef: React.RefObject<Promise<void>>;
  inspectExportTarget: FileSystemContextValue['inspectExportTarget'];
  writeNotebookExport: FileSystemContextValue['writeNotebookExport'];
}

export function useNotebookExport(deps: UseNotebookExportDeps) {
  const {
    fileTree, handleFileClick, tell, ask, notify, getVaultActivation, tabsRef, rootHandleRef,
    currentVaultIdRef, readerEpochRef, trashInFlightRef, reconcileQueueRef, inspectExportTarget,
    writeNotebookExport, setTabs,
  } = deps;

  const handleOpenNotebookSource = useCallback(async (pdfPath: string, notebookPath: string) => {
    const pdfName = pdfPath.slice(pdfPath.lastIndexOf('/') + 1);
    const beside = joinVaultPath(parentVaultPath(pdfPath), ensureNotebookExt(stripPdfExt(pdfName)));
    for (const candidate of [notebookPath, beside]) {
      const node = collectFiles(fileTree).find(f => f.path === candidate && isNotebookFile(f.name));
      if (!node) continue;
      setTabs(prev => prev.map(t => (t.file.path === pdfPath ? { ...t, mode: 'read' as const } : t)));
      await handleFileClick(node);
      return;
    }
    await tell({
      title: 'That notebook has moved',
      confirmLabel: 'OK',
      body: (
        <>
          This PDF was exported from <strong>{notebookPath}</strong>, which is no longer there.
          Open the notebook and export again — annotating this PDF instead would put marks in it
          that the notebook could not see.
        </>
      ),
    });
  }, [fileTree, handleFileClick, tell, setTabs]);

  const exportedNotebooksRef = useRef(new Map<string, DiskVersion>());
  const notebookExportInFlightRef = useRef(false);


  const handleExportNotebook = useCallback(async (file: ActiveFile) =>
    (await loadChunk(() => import('./notebookExport'))).handleExportNotebook({
      tell, notify, getVaultActivation, tabsRef, rootHandleRef, currentVaultIdRef, readerEpochRef,
      notebookExportInFlightRef, ask, trashInFlightRef, reconcileQueueRef, inspectExportTarget,
      writeNotebookExport, exportedNotebooksRef,
    }, file), [
      ask, inspectExportTarget, notify, writeNotebookExport, currentVaultIdRef, reconcileQueueRef, tabsRef,
      trashInFlightRef, getVaultActivation, tell, readerEpochRef, rootHandleRef,
    ]);

  return { handleOpenNotebookSource, handleExportNotebook };
}
