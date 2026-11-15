import type React from 'react';
import { useCallback, useRef } from 'react';
import type { ActiveFile, FileSystemContextValue, FileTreeNode, OpenTab } from '../types';
import type { DiskVersion } from '../utils/diskVersion';
import type { SetTabs } from './types';
import type { Ask, Notify, Tell } from './useAppDialogs';
import { ensureNotebookExt, isNotebookFile, notebookPdfName, stripPdfExt } from '../utils/fileTypes';
import { joinVaultPath, parentVaultPath } from '../utils/paths';
import { collectFiles } from '../utils/tree';
import { sameStat } from '../utils/diskVersion';
import { getNotebookExporter } from '../utils/notebookRenderCache';

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

  // Shared destination transaction for a staged notebook PDF. The source owner
  // is pinned before rendering; no worker receives a filesystem handle.
  const commitNotebookPdf = useCallback(async (file: ActiveFile, bytes: Uint8Array, sourceId: string, isCurrent: () => boolean): Promise<boolean> => {
    if (!file.parentHandle || trashInFlightRef.current || !isCurrent()) return false;
    const vault = currentVaultIdRef.current;
    const parentPath = parentVaultPath(file.path), targetName = notebookPdfName(file.name);
    const targetPath = joinVaultPath(parentPath, targetName);
    const key = JSON.stringify([vault, sourceId, file.path, targetPath]);
    const targetClosed = () => !tabsRef.current.some(tab => tab.file.path === targetPath);
    if (!targetClosed()) { notify(`Close "${targetName}" before replacing it.`); return false; }
    trashInFlightRef.current = true;
    try {
      await reconcileQueueRef.current;
      while (isCurrent() && targetClosed()) {
        const observed = await inspectExportTarget(file.parentHandle, targetName);
        if (!isCurrent() || !targetClosed()) return false;
        const trusted = exportedNotebooksRef.current.get(key);
        if (observed && (!trusted || observed.hash !== trusted.hash || !sameStat(observed, trusted))) {
          const replace = await ask({
            title: `Replace "${targetName}"?`,
            body: 'A PDF of that name is already in this folder. Its existing contents will be kept in Trash.',
            confirmLabel: 'Replace', danger: true,
          });
          if (!replace || !isCurrent() || !targetClosed()) return false;
        }
        const result = await writeNotebookExport(file.parentHandle, parentPath, targetName, bytes, observed, () => isCurrent() && targetClosed());
        if (result.status !== 'written') {
          if (result.status === 'changed') continue;
          return false;
        }
        exportedNotebooksRef.current.set(key, result.version);
        return true;
      }
      return false;
    } finally { trashInFlightRef.current = false; }
  }, [ask, inspectExportTarget, notify, writeNotebookExport, currentVaultIdRef, reconcileQueueRef, tabsRef, trashInFlightRef]);

  /** Export the notebook's frozen render; destination consent is a separate transaction. */
  const handleExportNotebook = useCallback(async (file: ActiveFile) => {
    if (!file.parentHandle || notebookExportInFlightRef.current) return;
    const vault = currentVaultIdRef.current, root = rootHandleRef.current;
    const source = tabsRef.current.find(tab => tab.file.path === file.path);
    const exporter = getNotebookExporter(file.path);
    if (!vault || !root || !source || !exporter) { notify(`Open "${file.name}" before exporting it.`); return; }
    const epoch = readerEpochRef.current.epoch, activation = getVaultActivation(), generation = source.representation.generation, diskRev = source.diskRev;
    let nativeJob: import('../utils/notebookRenderCache').NativeNotebookExportJob | undefined;
    const isCurrent = () => rootHandleRef.current === root && currentVaultIdRef.current === vault && readerEpochRef.current.epoch === epoch &&
      getVaultActivation() === activation && tabsRef.current.some(tab => tab.id === source.id && tab.file.path === file.path &&
        (nativeJob ? nativeJob.isCurrent() : tab.representation.generation === generation && tab.diskRev === diskRev));
    notebookExportInFlightRef.current = true;
    try {
      let paper: import('../utils/paper').NotebookPaper, bytes: Uint8Array;
      if (typeof exporter === 'function') {
        const exported = await exporter();
        if (!exported || !isCurrent()) return;
        const { buildNotebookPdfAsync } = await import('../utils/pdfBuildClient');
        paper = exported.paper;
        bytes = await buildNotebookPdfAsync(paper, exported.overlays, { path: file.path, exportedAt: Date.now() });
      } else {
        nativeJob = exporter.prepare();
        if (nativeJob.sourcePath !== file.path || !isCurrent()) return;
        ({ paper, bytes } = await nativeJob.run(new AbortController().signal));
      }
      if (!isCurrent() || !await commitNotebookPdf(file, bytes, source.id, isCurrent)) return;
      void tell({
        title: 'Exported to PDF', confirmLabel: 'OK',
        body: `"${notebookPdfName(file.name)}" is in the same folder — ${paper.pageCount} `
          + `${paper.pageCount === 1 ? 'page' : 'pages'}.`,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError' && !isCurrent()) return;
      console.error('Could not export the notebook:', err);
      notify(err instanceof DOMException && err.name === 'TypeMismatchError'
        ? `A folder named "${notebookPdfName(file.name)}" already exists.` : `Could not export "${file.name}".`);
    } finally { try { nativeJob?.release(); } finally { notebookExportInFlightRef.current = false; } }
  }, [commitNotebookPdf, getVaultActivation, notify, tell, currentVaultIdRef, readerEpochRef, rootHandleRef, tabsRef]);

  return { handleOpenNotebookSource, handleExportNotebook };
}
