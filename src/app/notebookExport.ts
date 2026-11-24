import type React from 'react';
import type { ActiveFile, FileSystemContextValue, FileTreeNode, OpenTab } from '../types';
import type { DiskVersion } from '../utils/diskVersion';
import type { SetTabs } from './types';
import type { Ask, Notify, Tell } from './useAppDialogs';
import { notebookPdfName } from '../utils/fileTypes';
import { joinVaultPath, parentVaultPath } from '../utils/paths';
import { sameStat } from '../utils/diskVersion';
import { getNotebookExporter } from '../utils/notebookRenderCache';
import type { UseNotebookExportDeps } from './useNotebookExport';
import { isCancellation } from '../platform/workers/envelope';
import { loadChunk } from '../platform/chunkLoad';

/**
 * A notebook's Export to PDF: the render, then the destination transaction.
 * Loaded on the gesture (useNotebookExport), never at startup.
 */
export interface NotebookExportDeps extends UseNotebookExportDeps {
  exportedNotebooksRef: React.MutableRefObject<Map<string, DiskVersion>>
  notebookExportInFlightRef: React.MutableRefObject<boolean>
}

/** Export the notebook's frozen render; destination consent is a separate transaction. */
export async function handleExportNotebook(deps: Pick<NotebookExportDeps,
  'tell' | 'notify' | 'getVaultActivation' | 'tabsRef' | 'rootHandleRef' | 'currentVaultIdRef' |
  'readerEpochRef' | 'notebookExportInFlightRef' | 'ask' | 'trashInFlightRef' | 'reconcileQueueRef' |
  'inspectExportTarget' | 'writeNotebookExport' | 'exportedNotebooksRef'
>, file: ActiveFile) {
  const {
    tell, notify, getVaultActivation, tabsRef, rootHandleRef, currentVaultIdRef, readerEpochRef,
    notebookExportInFlightRef,
  } = deps;
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
      const { buildNotebookPdfAsync } = await loadChunk(() => import('../utils/pdfBuildClient'));
      paper = exported.paper;
      bytes = await buildNotebookPdfAsync(paper, exported.overlays, { path: file.path, exportedAt: Date.now() });
    } else {
      nativeJob = exporter.prepare();
      if (nativeJob.sourcePath !== file.path || !isCurrent()) return;
      ({ paper, bytes } = await nativeJob.run(new AbortController().signal));
    }
    if (!isCurrent() || !await commitNotebookPdf(deps, file, bytes, source.id, isCurrent)) return;
    void tell({
      title: 'Exported to PDF', confirmLabel: 'OK',
      body: `"${notebookPdfName(file.name)}" is in the same folder — ${paper.pageCount} `
        + `${paper.pageCount === 1 ? 'page' : 'pages'}.`,
    });
  } catch (err) {
    if (isCancellation(err) && !isCurrent()) return;
    console.error('Could not export the notebook:', err);
    notify(err instanceof DOMException && err.name === 'TypeMismatchError'
      ? `A folder named "${notebookPdfName(file.name)}" already exists.` : `Could not export "${file.name}".`);
  } finally { try { nativeJob?.release(); } finally { notebookExportInFlightRef.current = false; } }
}

// Shared destination transaction for a staged notebook PDF. The source owner
// is pinned before rendering; no worker receives a filesystem handle.
export async function commitNotebookPdf(deps: Pick<NotebookExportDeps,
  'ask' | 'notify' | 'tabsRef' | 'currentVaultIdRef' | 'trashInFlightRef' | 'reconcileQueueRef' |
  'inspectExportTarget' | 'writeNotebookExport' | 'exportedNotebooksRef'
>, file: ActiveFile, bytes: Uint8Array, sourceId: string, isCurrent: () => boolean): Promise<boolean> {
  const {
    ask, notify, tabsRef, currentVaultIdRef, trashInFlightRef, reconcileQueueRef, inspectExportTarget,
    writeNotebookExport, exportedNotebooksRef,
  } = deps;
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
}
