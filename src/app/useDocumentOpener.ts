import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ActiveFile, EditorMode, EditorRevealRequest, FileSystemContextValue, FileTreeFileNode, FileTreeNode, GraphNode, MainView, OpenTab, TextRange } from '../types';
import type { SetLayout, SetTabs } from './types';
import { isCanvasFile, isCodeFile, isEpubFile, isNativeDrawingFile, isPdfFile } from '../utils/fileTypes';
import { isTextFile } from '../utils/vaultSearch';
import { opensInApp, representationFor } from '../utils/documentReading';
import { setBaseline } from '../utils/docBaselines';
import { focusTab, openTab as openTabIn, renamePath } from '../utils/tabPanes';
import { sniffCanvas } from '../utils/canvasFormat';
import { isOldBoardSniff } from '../utils/oldBoards';
import { getNoteResolver } from '../utils/noteResolver';
import { loadHelpDoc } from '../utils/helpDocLoader';
import { externalOpenUrl } from './externalOpen';
import { newTabId } from './documentIds';
import { describeReadError } from './readErrors';

/**
 * How a click, a wikilink, a graph node, a search result or ⌘-reopen becomes an
 * open document: the one opener every route into a note goes through.
 */
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
  /** A person opened a drawing or notebook whose bytes are the old app's: offer an editable copy (useEditableCopy). */
  oldBoardOpenedRef: React.RefObject<((id: string, name: string) => void) | null>;
}

/** How a document is opened. Every route a person takes (the tree, a link, search, the switcher, ⌥⇧T) is the default;
 *  the agent and the copy that replaces an old board say otherwise. */
export interface OpenOptions {
  /** Offer an editable copy when the file turns out to be an old-format board. Off for opens nobody asked for. */
  readonly offerCopy?: boolean;
  /** Open it in this open document's place (its column, index and focus), as an old board's editable copy does. The
   *  caller releases the replaced document. */
  readonly replacing?: string;
  /** The new tab's id, minted by a caller that has to name the document before it opens (a copy's notice). */
  readonly id?: string;
}

export function useDocumentOpener(deps: UseDocumentOpenerDeps) {
  const {
    handleIO, readFileVersioned, fileTree, rootHandleRef, tabsRef, closingRef, reopenedClosingRef,
    setLayout, setTabs, setSaveStatus, setMainView, rememberAssetRefs, seedPdfBaseline, seedDocumentBuffer, oldBoardOpenedRef,
  } = deps;

  const retryUnreadTabRef = useRef<(path: string) => Promise<boolean>>(async () => false);

  // Returns whether the file was actually opened (as a tab or externally).
  const handleFileClick = useCallback(async (node: FileTreeNode, options: OpenOptions = {}): Promise<boolean> => {
    const rootAtOpen = rootHandleRef.current;
    try {
      // PDFs open in a pane like any other file. Everything else non-textual
      // (images, video, …) still hands off to the browser.
      if (!opensInApp(node.name)) {
        const file = await handleIO.file(node.handle as FileSystemFileHandle);
        window.open(externalOpenUrl(node.path, file), '_blank');
        return true;
      }

      // Already open? Just focus it — don't re-read (preserves the tab's
      // unsaved edits and its own undo history). Its column takes focus and
      // fronts its tab, wherever in the row that column happens to be.
      const open = tabsRef.current.find(t => t.file.path === node.path);
      if (open) {
        if (closingRef.current.has(open.id)) {
          reopenedClosingRef.current.add(open.id);
          setLayout(l => openTabIn(l, node.path));
        } else setLayout(l => focusTab(l, node.path));
        // Clicking a note whose tab could not be read is asking for it again.
        // Awaited, so a caller that acts on the opened document next (a search
        // result's reveal) lands on the remounted, readable pane rather than
        // being consumed by the unreadable one.
        if (open.readError) await retryUnreadTabRef.current(node.path);
        return true;
      }

      // A PDF's (or drawing's) bytes are read by its own pane, never as text:
      // its tab buffer is not the file, and decoding a PDF as UTF-8 corrupts it.
      // Read WITH the version of exactly those bytes — the baseline every later
      // save of this document is checked against (writeFileVersioned) and every
      // outside change is compared with (checkOpenDocs).
      const handle = node.handle as FileSystemFileHandle;
      let readError: string | undefined;
      const read = (isPdfFile(node.name) || isEpubFile(node.name) || isNativeDrawingFile(node.name)) ? null : await readFileVersioned(handle).catch(error => { readError=describeReadError(error); return null; });
      if (rootHandleRef.current !== rootAtOpen) return false;
      const content = read?.text ?? '';
      // What this note referred to when it was opened — the baseline every
      // later save's asset diff is taken against.
      if (read) rememberAssetRefs(node, content);
      const id = options.id ?? newTabId();
      if (read) setBaseline(id, read.version); else if (isPdfFile(node.name) || isNativeDrawingFile(node.name)) seedPdfBaseline(id, handle);
      // Re-check inside the updater: a second click can land while the first
      // read is still in flight, and tabsRef only updates post-commit.
      // A source file opens ready to type in: there is no "reading mode" worth
      // having for code — the syntax colours are the same either way, and the
      // only difference is whether the caret works (⌘E still toggles it).
      const mode: EditorMode = isCodeFile(node.name) ? 'edit' : 'read';
      seedDocumentBuffer(id, node.path, content, !readError && representationFor(node.name).bufferKind === 'text');
      setTabs(prev => prev.some(t => t.file.path === node.path)
        ? prev
        : [...prev, { id, file: node, mode: isEpubFile(node.name) ? 'read' : mode, dirty: false, readError, representation: representationFor(node.name,false,0,!!readError) }]);
      // openTab re-checks too, and focuses an existing tab rather than minting a
      // second one — the same race, answered the same way. A replacement takes the
      // replaced document's slot instead: same column, same place in its strip.
      const replacing = options.replacing;
      setLayout(l => replacing && l.panes.some(p => p.paths.includes(replacing)) && !l.panes.some(p => p.paths.includes(node.path))
        ? renamePath(l, replacing, node.path) : openTabIn(l, node.path));
      setSaveStatus('');
      // Sniffed from the bytes just read, never the name: a `.notebook` may be either kind, and a `.tldraw` may hold a
      // board an earlier build already converted in place.
      if (read && options.offerCopy !== false && !replacing && isOldBoardSniff(sniffCanvas(content, node.name))) {
        oldBoardOpenedRef.current?.(id, node.name);
      }
      return true;
    } catch (err) {
      console.error('Failed to read file:', err);
      return false;
    }
  }, [handleIO, readFileVersioned, rememberAssetRefs, seedPdfBaseline, seedDocumentBuffer, closingRef, reopenedClosingRef, rootHandleRef, setLayout, setSaveStatus, setTabs, tabsRef, oldBoardOpenedRef]);

  // The graph and the click share one canonical resolver revision. Read it
  // through an App-lifetime ref: the wikilink handler is baked into cached
  // EditorStates, which outlive their panes (see DocumentPane).
  const noteResolver = useMemo(() => getNoteResolver(fileTree), [fileTree]);
  const noteResolverRef = useRef(noteResolver);
  useEffect(() => { noteResolverRef.current = noteResolver; }, [noteResolver]);

  // Open a note by its name (used by [[wikilinks]], graph nodes, backlinks).
  //
  // STABLE FOR THE APP'S LIFE, deliberately — the note index is read from a ref
  // rather than closed over. The editor bakes this into each document's
  // EditorState (DocumentPane's `mousedown` handler), outside any compartment,
  // and that state is cached and re-adopted by whichever pane shows the
  // document next. Depending on `noteResolver` here would freeze the handler at whatever
  // the index held when the document's FIRST pane unmounted, so a wikilink to
  // any note created, renamed or moved after that silently did nothing.
  const openNoteByName = useCallback((name: string | null) => {
    if (!name) return;
    const match = noteResolverRef.current.resolveNode(name);
    if (match) {
      handleFileClick(match);
      setMainView('editor');
    }
  }, [handleFileClick, setMainView]);

  // Open a note given a graph node (skips unresolved placeholder nodes).
  const handleOpenNode = useCallback((graphNode: GraphNode) => {
    if (!graphNode || graphNode.unresolved || !graphNode.node) return;
    handleFileClick(graphNode.node);
    setMainView('editor');
  }, [handleFileClick, setMainView]);

  // ── Vault search → editor navigation ───────────────────────────────────
  // A clicked search result opens the file and, for content matches, asks
  // EditorPane to select + scroll to the matched range. Each click builds a
  // fresh request object, so re-clicking the same match re-triggers.
  const [pendingReveal, setPendingReveal] = useState<EditorRevealRequest | null>(null);

  const handleOpenSearchResult = useCallback(async (node: FileTreeFileNode, range: TextRange | null) => {
    const opened = await handleFileClick(node);
    // Non-text files opened externally (pdf/image): no view switch, no reveal.
    if (!opened) return;
    if (isEpubFile(node.name) || isPdfFile(node.name)) { setMainView('editor'); return; }
    if (!isTextFile(node.name)) return;
    setMainView('editor');
    // Drawings match by NAME only (their JSON isn't indexed), so there's no text
    // range to reveal — and a char offset would be meaningless on a canvas.
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
    // The guide is its own chunk (utils/helpDocLoader.ts). One network round
    // trip on the first open of a session, nothing on every other start.
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
