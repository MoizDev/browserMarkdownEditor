import { useEffect } from 'react';
import type { FileTreeNode } from '../types';
import { prefetchPanes } from '../components/prefetchPanes';
import { collectFiles } from '../utils/tree';
import { isDrawingFile, isEpubFile, isNativeDrawingFile, isNotebookFile, isPdfFile } from '../utils/fileTypes';

function whenIdle(run: () => void): void {
  if (window.requestIdleCallback) window.requestIdleCallback(run, { timeout: 4000 });
  else setTimeout(run, 1500);
}

export function usePanePrefetch(fileTree: FileTreeNode[]): void {
  /**
   * Warm the heavy panes for the kinds of file this vault actually holds.
   *
   * Walks `fileTree`, which is already in memory — no disk reads — and only
   * when the tree changes shape enough to matter. `prefetchPanes` itself is
   * idle-scheduled and fetches each chunk once, so calling it after every
   * refresh costs nothing.
   */
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
    // A PDF's gestures (rotate, print, unsigned copy) load on first use; warm
    // them beside its pane, so a turn of the page never waits on a fetch and
    // two quick clicks run in the order they were made.
    if (kinds.pdf) whenIdle(() => { void import('./pdfGestures').catch(() => {}); });
  }, [fileTree]);
}
