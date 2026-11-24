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

/**
 * A notebook's PDF export and the hand-back from an exported PDF to its
 * notebook. Writes go through the destination transaction below, which asks
 * before it replaces a PDF it did not write.
 */
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

  /**
   * Hand a notebook's exported PDF back to its notebook.
   *
   * The PDF pane reads the pointer (see pdfFormat.ts) and calls this instead of
   * drawing anything: annotating an export would fork a third document whose
   * marks the notebook could neither see nor replace. The stored path first,
   * then a notebook beside the PDF answering to its name — the pointer is
   * written once and the vault goes on moving, so between them they survive a
   * rename of either file.
   */
  const handleOpenNotebookSource = useCallback(async (pdfPath: string, notebookPath: string) => {
    const pdfName = pdfPath.slice(pdfPath.lastIndexOf('/') + 1);
    const beside = joinVaultPath(parentVaultPath(pdfPath), ensureNotebookExt(stripPdfExt(pdfName)));
    for (const candidate of [notebookPath, beside]) {
      const node = collectFiles(fileTree).find(f => f.path === candidate && isNotebookFile(f.name));
      if (!node) continue;
      // Back to reading, so coming back to this tab shows the PDF rather than
      // the hand-off message that sent you away from it.
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


  /** Export the notebook's frozen render; destination consent is a separate transaction. */
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
