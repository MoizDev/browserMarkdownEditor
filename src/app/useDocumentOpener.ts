import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ActiveFile, EditorMode, EditorRevealRequest, FileSystemContextValue, FileTreeFileNode, FileTreeNode, GraphNode, MainView, OpenTab, TextRange } from '../types';
import type { SetLayout, SetTabs } from './types';
import { isCanvasFile, isCodeFile, isEpubFile, isNativeDrawingFile, isPdfFile } from '../utils/fileTypes';
import { isTextFile } from '../utils/vaultSearch';
import { opensInApp, representationFor } from '../utils/documentReading';
import { setBaseline } from '../utils/docBaselines';
import { focusTab, openTab as openTabIn } from '../utils/tabPanes';
import { sniffCanvas } from '../utils/canvasFormat';
import { isOldBoardSniff } from '../utils/oldBoards';
import { getNoteResolver } from '../utils/noteResolver';
import { loadHelpDoc } from '../utils/helpDocLoader';
import { externalOpenUrl } from './externalOpen';
import { newTabId } from './documentIds';
import { describeReadError } from './readErrors';

export interface UseDocumentOpenerDeps {
  handleIO: FileSystemContextValue['handleIO'];
  readFileVersioned: FileSystemContextValue['readFileVersioned'];
  fileTree: FileSystemContextValue['fileTree'];
  rootHandleRef: React.RefObject<FileSystemDirectoryHandle | null>;
  tabsRef: React.RefObject<OpenTab[]>;
  closingRef: React.RefObject<Set<string>>;
  reopenedClosingRef: React.RefObject<Set<string>>;
  setLayout: SetLayout;
  setTabs: SetTabs;
  setSaveStatus: React.Dispatch<React.SetStateAction<string>>;
  setMainView: React.Dispatch<React.SetStateAction<MainView>>;
  rememberAssetRefs: (file: ActiveFile, content: string) => void;
  seedPdfBaseline: (id: string, handle: FileSystemFileHandle) => void;
  seedDocumentBuffer: (id: string, path: string, content: string, readable: boolean) => void;
  oldBoardOpenedRef: React.RefObject<((id: string, name: string) => void) | null>;
}

export interface OpenOptions {
  readonly offerCopy?: boolean;
  readonly id?: string;
}

export function useDocumentOpener(deps: UseDocumentOpenerDeps) {
  const {
    handleIO, readFileVersioned, fileTree, rootHandleRef, tabsRef, closingRef, reopenedClosingRef,
    setLayout, setTabs, setSaveStatus, setMainView, rememberAssetRefs, seedPdfBaseline, seedDocumentBuffer, oldBoardOpenedRef,
  } = deps;

  const retryUnreadTabRef = useRef<(path: string) => Promise<boolean>>(async () => false);

  const handleFileClick = useCallback(async (node: FileTreeNode, options: OpenOptions = {}): Promise<boolean> => {
    const rootAtOpen = rootHandleRef.current;
    try {
      if (!opensInApp(node.name)) {
        const file = await handleIO.file(node.handle as FileSystemFileHandle);
        window.open(externalOpenUrl(node.path, file), '_blank');
        return true;
      }

      const open = tabsRef.current.find(t => t.file.path === node.path);
      if (open) {
        if (closingRef.current.has(open.id)) {
          reopenedClosingRef.current.add(open.id);
          setLayout(l => openTabIn(l, node.path));
        } else setLayout(l => focusTab(l, node.path));
        if (open.readError) await retryUnreadTabRef.current(node.path);
        return true;
      }

      // A PDF's (or drawing's) bytes are read by its own pane, never as text:
      // its tab buffer is not the file, and decoding a PDF as UTF-8 corrupts it.
      const handle = node.handle as FileSystemFileHandle;
      let readError: string | undefined;
      const read = (isPdfFile(node.name) || isEpubFile(node.name) || isNativeDrawingFile(node.name)) ? null : await readFileVersioned(handle).catch(error => { readError=describeReadError(error); return null; });
      if (rootHandleRef.current !== rootAtOpen) return false;
      const content = read?.text ?? '';
      if (read) rememberAssetRefs(node, content);
      const id = options.id ?? newTabId();
      if (read) setBaseline(id, read.version); else if (isPdfFile(node.name) || isNativeDrawingFile(node.name)) seedPdfBaseline(id, handle);
      // Re-check inside the updater: a second click can land while the first
      // read is still in flight, and tabsRef only updates post-commit.
      const mode: EditorMode = isCodeFile(node.name) ? 'edit' : 'read';
      seedDocumentBuffer(id, node.path, content, !readError && representationFor(node.name).bufferKind === 'text');
      setTabs(prev => prev.some(t => t.file.path === node.path)
        ? prev
        : [...prev, { id, file: node, mode: isEpubFile(node.name) ? 'read' : mode, dirty: false, readError, representation: representationFor(node.name,false,0,!!readError) }]);
      setLayout(l => openTabIn(l, node.path));
      setSaveStatus('');
      if (read && options.offerCopy !== false && isOldBoardSniff(sniffCanvas(content, node.name))) {
        oldBoardOpenedRef.current?.(id, node.name);
      }
      return true;
    } catch (err) {
      console.error('Failed to read file:', err);
      return false;
    }
  }, [handleIO, readFileVersioned, rememberAssetRefs, seedPdfBaseline, seedDocumentBuffer, closingRef, reopenedClosingRef, rootHandleRef, setLayout, setSaveStatus, setTabs, tabsRef, oldBoardOpenedRef]);

  const noteResolver = useMemo(() => getNoteResolver(fileTree), [fileTree]);
  const noteResolverRef = useRef(noteResolver);
  useEffect(() => { noteResolverRef.current = noteResolver; }, [noteResolver]);

  const openNoteByName = useCallback((name: string | null) => {
    if (!name) return;
    const match = noteResolverRef.current.resolveNode(name);
    if (match) {
      handleFileClick(match);
      setMainView('editor');
    }
  }, [handleFileClick, setMainView]);

  const handleOpenNode = useCallback((graphNode: GraphNode) => {
    if (!graphNode || graphNode.unresolved || !graphNode.node) return;
    handleFileClick(graphNode.node);
    setMainView('editor');
  }, [handleFileClick, setMainView]);

  const [pendingReveal, setPendingReveal] = useState<EditorRevealRequest | null>(null);

  const handleOpenSearchResult = useCallback(async (node: FileTreeFileNode, range: TextRange | null) => {
    const opened = await handleFileClick(node);
    if (!opened) return;
    if (isEpubFile(node.name) || isPdfFile(node.name)) { setMainView('editor'); return; }
    if (!isTextFile(node.name)) return;
    setMainView('editor');
    if (range && !isCanvasFile(node.name)) {
      setPendingReveal({ path: node.path, from: range.from, to: range.to });
    }
  }, [handleFileClick, setMainView]);

  const handleRevealHandled = useCallback(() => setPendingReveal(null), []);

  const handleHelpClick = useCallback(async () => {
    const path = 'help-guide';
    if (tabsRef.current.some(t => t.file.path === path)) {
      setLayout(l => focusTab(l, path));
      return;
    }
    const content = await loadHelpDoc();
    const id = newTabId();
    seedDocumentBuffer(id, path, content, true);
    setTabs(prev => prev.some(t => t.file.path === path) ? prev : [...prev, {
      id,
      file: { name: 'Help Guide', isHelp: true, path },
      representation: representationFor('Help Guide', true),
      mode: 'read',
      dirty: false,
    }]);
    setLayout(l => openTabIn(l, path));
    setSaveStatus('');
  }, [seedDocumentBuffer, setLayout, setSaveStatus, setTabs, tabsRef]);

  return {
    retryUnreadTabRef, handleFileClick, openNoteByName, handleOpenNode, pendingReveal,
    setPendingReveal, handleOpenSearchResult, handleRevealHandled, handleHelpClick,
  };
}
