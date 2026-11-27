import { useEffect } from 'react';
import type { FileTreeNode } from '../types';
import { prefetchPanes } from '../components/prefetchPanes';
import { collectFiles } from '../utils/tree';
import { isDrawingFile, isEpubFile, isNativeDrawingFile, isNotebookFile, isPdfFile } from '../utils/fileTypes';
import { loadChunk } from '../platform/chunkLoad';

function whenIdle(run: () => void): void {
  if (window.requestIdleCallback) window.requestIdleCallback(run, { timeout: 4000 });
  else setTimeout(run, 1500);
}

export function usePanePrefetch(fileTree: FileTreeNode[]): void {
  useEffect(() => {
    if (!fileTree.length) return;
    const kinds = { epub: false, pdf: false, drawing: false, nativeDrawing: false, notebook: false };
    for (const file of collectFiles(fileTree)) {
      if (isEpubFile(file.name)) kinds.epub = true;
      else if (isPdfFile(file.name)) kinds.pdf = true;
      else if (isNotebookFile(file.name)) kinds.notebook = true;
      else if (isDrawingFile(file.name)) kinds.drawing = true;
      else if (isNativeDrawingFile(file.name)) kinds.nativeDrawing = true;
      if (kinds.epub && kinds.pdf && kinds.drawing && kinds.nativeDrawing && kinds.notebook) break;
    }
    prefetchPanes(kinds);
    if (kinds.pdf) whenIdle(() => { void loadChunk(() => import('./pdfGestures')).catch(() => {}); });
  }, [fileTree]);
}
