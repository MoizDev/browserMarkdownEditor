import React, { useState, useCallback, useRef, useEffect, useMemo, useSyncExternalStore } from 'react';
import { useFileSystem } from './context/FileSystemContext';
import { HELP_DOC_CONTENT } from './utils/helpDoc';
import { buildGraph, collectMarkdownFiles, baseName, clearLinkCache } from './utils/graph';
import { readJSON, setRecordScope, writeJSON } from './utils/storage';
import { pruneSessions, readSession, writeSession } from './utils/tabSessions';
import { joinVaultPath, parentVaultPath } from './utils/paths';
import { ASSETS_DIR, assetEmbeds, referencesAsset } from './utils/assets';
import { collectFiles } from './utils/tree';
import { bumpSaveEpoch } from './utils/saveEpoch';
import { isTextFile } from './utils/vaultSearch';
import {
  isCanvasFile, isPdfFile, isNotebookFile, ensureNotebookExt, notebookPdfName, stripPdfExt,
} from './utils/fileTypes';
import { clampRecentVaultLimit, DEFAULT_RECENT_VAULT_LIMIT } from './utils/recentVaults';
import {
  EMPTY_LAYOUT,
  closeGroup as closeGroupIn,
  closePath,
  focusTab,
  focusedPath as focusedPathOf,
  groupById,
  mergeIntoActive,
  mergeLayouts,
  openTab as openTabIn,
  renamePath,
  reorderGroups,
  restoreLayout,
  selectGroup,
  setGroupSizes,
  splitOff,
  visiblePaths,
} from './utils/tabGroups';
import { clampTabSize } from './editor/lists';
import { retryMissingAssets } from './editor/imageWidget';
import { getNotebookExporter, clearNotebookRenderData, moveNotebookRenderData } from './utils/notebookRenderCache';
import { findLinkedVault, readLocation, vaultLinkName, writeLocation } from './utils/appUrl';
import { setActiveFilePath } from './utils/activeFile';
import {
  ENTRY_STYLE_FILE, LEGACY_STYLE_FILE, emptyEntryStyles, forgetEntry, parseEntryStyles,
  renameEntry, serializeEntryStyles, withEntryStyle, type IconNode,
} from './utils/entryStyle';
import { getEntryStyles, setEntryStyles } from './utils/entryStyleStore';
import { setTableNotify } from './editor/tableEdit';
import { closeContextMenu, getContextMenu, subscribeContextMenu } from './utils/contextMenu';
// Cache only — importing utils/pdfAnnotation here would pull pdf-lib + pdf.js
// (~1.3MB) into the main bundle, which a markdown-only session never needs.
// The builder itself is import()ed at the two points that actually write a PDF.
import { getPdfRenderData, clearPdfRenderData, movePdfRenderData } from './utils/pdfRenderCache';
import './index.css';
import FileExplorer from './components/FileExplorer';
import { prefetchPanes } from './components/prefetchPanes';
import ConfirmDialog from './components/ConfirmDialog';
import ContextMenu from './components/ContextMenu';
import EditorPane from './components/EditorPane';
import SettingsPanel from './components/SettingsPanel';
import TrashPanel from './components/TrashPanel';
import GraphView from './components/GraphView';
import { Settings, HelpCircle, Network, FileTextOutline, PanelLeft, Search, Trash2 } from './components/icons';
import type {
  ActiveFile,
  FileTreeNode,
  FileTreeFileNode,
  OpenTab,
  GraphData,
  GraphNode,
  SettingsDefaults,
  TabLayout,
  Theme,
  MainView,
  CaretStyle,
  EditorRevealRequest,
  TextRange,
  TrashItem,
  TrashRestoreResult,
} from './types';

/**
 * Object URLs handed to `window.open` for files this app doesn't edit (images,
 * video, archives), one per file VERSION.
 *
 * These were previously minted fresh on every open and never revoked, so a
 * session of browsing media left a permanent registry entry — and a pinned file
 * reference — behind for each click. Reusing the URL bounds that to the number
 * of distinct files opened.
 *
 * Deliberately NOT a timed revoke: the tab we opened may re-request the URL
 * later (a <video> seeking, a reload), and any timeout is a guess about the
 * user's session. Replacing an entry only when the file itself changed is
 * unambiguously safe.
 */
const externalUrls = new Map<string, { url: string; mtime: number; size: number }>();

function externalOpenUrl(path: string, file: File): string {
  const cached = externalUrls.get(path);
  if (cached && cached.mtime === file.lastModified && cached.size === file.size) return cached.url;
  if (cached) URL.revokeObjectURL(cached.url);
  const url = URL.createObjectURL(file);
  externalUrls.set(path, { url, mtime: file.lastModified, size: file.size });
  return url;
}

/** Session-unique document ids (see OpenTab.id). Never persisted — the stored
 *  session records paths, so these are re-minted on restore and only have to be
 *  unique among the documents open at one moment. */
let docSeq = 0;
function newTabId(): string {
  return `d${(++docSeq).toString(36)}`;
}

/**
 * Whether a document's text can embed a picture — i.e. whether its `.Assets`
 * folder has to be kept in step with it. A drawing and a PDF are text on disk
 * but a canvas on screen, and the Help guide has no folder of its own.
 */
function tracksAssets(file: ActiveFile): boolean {
  return !file.isHelp && !!file.parentHandle && isTextFile(file.name) && !isCanvasFile(file.name);
}

/**
 * Structural equality for two link graphs.
 *
 * buildGraph is deterministic for a given vault — nodes follow the file list and
 * links follow document order — so an element-wise walk is exact, and it lets a
 * rebuild that found nothing new keep the previous object identity instead of
 * cascading a re-render (and a graph re-simulation) through the app.
 */
const EMPTY_GRAPH: GraphData = { nodes: [], links: [], backlinks: {}, outlinks: {} };

/**
 * The file at a vault-relative path, and the directory holding it.
 *
 * Walked down from the root rather than looked up in the file tree, so it
 * answers for a path the tree has not caught up with yet — which is exactly the
 * moment a rename or a move needs it. Throws if anything on the way is missing,
 * which the caller reports rather than guesses past.
 */
async function resolveVaultFile(root: FileSystemDirectoryHandle, path: string) {
  const segs = path.split('/');
  const name = segs.pop()!;
  let parent = root;
  for (const seg of segs) parent = await parent.getDirectoryHandle(seg);
  return { handle: await parent.getFileHandle(name), parentHandle: parent };
}

/** A question (or a notice) waiting on screen — see App's `ask`/`tell`. */
interface DialogRequest {
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  danger?: boolean;
}
interface AppDialog extends DialogRequest {
  onConfirm: () => void;
  /** Absent on a notice, which has nothing to decline. */
  onCancel?: () => void;
  /** The third answer, and its label, on the one question that has one — see
   *  `askChoice`. Deliberately NOT on `DialogRequest`: ConfirmDialog draws the
   *  third button only when it has both, so an `altLabel` handed to `ask` or
   *  `tell` would type-check and then silently render nothing. */
  altLabel?: string;
  onAlt?: () => void;
}

/**
 * Is `name` already used inside `dir`, by anything at all?
 *
 * BOTH KINDS of entry count as taken, whichever kind is about to be written: a
 * file and a folder cannot share a name, and asking only about files once
 * reported a name free while a folder of it sat there. That is the rule
 * `freeEntryName` already documents (FileSystemContext.tsx:21-25); this is the
 * same rule at the one entry point that cannot go through it.
 *
 * It matters here because `createFile` OPENS-OR-TRUNCATES (:425-434). Without
 * this check a "New note" onto an existing name empties that file — no
 * warning, no undo, and the tree looks exactly as it did a moment before. The
 * guard is at this entry point rather than in the primitive deliberately:
 * routing `createFile` through `freeEntryName` would quietly create
 * "note (1).md" while the caller went on to open the name it asked for, and
 * the other caller (the annotated-PDF path) wants create-or-open.
 */
async function nameTaken(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try { await dir.getFileHandle(name); return true; } catch { /* not a file */ }
  try { await dir.getDirectoryHandle(name); return true; } catch { /* nor a folder */ }
  return false;
}

/**
 * Is this graph the same one we already handed out?
 *
 * `rebuildGraph` keeps the PREVIOUS GraphData object when the answer is yes, and
 * that identity is load-bearing: a fresh object propagates into GraphView's
 * effects, which re-seed the simulation (alpha = 1) and tear down and rebuild
 * the RAF loop and the ResizeObserver. Without this, an unrelated tab
 * autosaving visibly re-heated the graph the user was looking at — and the
 * graph is rebuilt after EVERY save, not just on tree changes.
 */
function sameGraph(a: GraphData, b: GraphData): boolean {
  if (a.nodes.length !== b.nodes.length || a.links.length !== b.links.length) return false;
  for (let i = 0; i < a.nodes.length; i++) {
    const x = a.nodes[i], y = b.nodes[i];
    // `node` too: a tree refresh hands out fresh handles, and the graph's nodes
    // are what the graph view and backlinks open files through.
    if (x.id !== y.id || x.degree !== y.degree || x.unresolved !== y.unresolved || x.node !== y.node) return false;
  }
  for (let i = 0; i < a.links.length; i++) {
    if (a.links[i].source !== b.links[i].source || a.links[i].target !== b.links[i].target) return false;
  }
  return true;
}

/**
 * Is this keystroke ⌘/Ctrl + `letter`, whatever case the OS reported?
 *
 * `e.key` carries the CHARACTER the layout produced, so with Caps Lock on it is
 * `'E'` and a bare `e.key === 'e'` silently stops matching — ⌘E just did
 * nothing, with no feedback of any kind, for as long as the light was on.
 * Lower-casing is the fix; the `shiftKey` test is what keeps it honest.
 *
 * Caps Lock and Shift are indistinguishable in `e.key` — both give `'E'` — and
 * `e.shiftKey` is the only thing that tells them apart. It is tested rather
 * than ignored because ⌘⇧S / ⌘⇧N / ⌘⇧E are conventionally DIFFERENT commands
 * (Save As, New Window, …): firing the unshifted action on them would both
 * surprise the user and spend three chords this app may want later. So Caps
 * Lock is accepted and Shift is declined, which is exactly the distinction a
 * user would draw.
 */
function isCmdLetter(e: KeyboardEvent, letter: string): boolean {
  return (e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === letter;
}

export default function App() {
  const {
    rootHandle,
    fileTree,
    isLoading,
    previousVault,
    linkedVault,
    recentVaults,
    currentVaultId,
    pickDirectory,
    openRecentVault,
    openFolderAsVault,
    openLinkedVault,
    forgetRecentVault,
    readFile,
    writeFile,
    writeFileBytes,
    importFiles,
    createFile,
    createFolder,
    retireAsset,
    restoreAsset,
    restoreVault,
    moveToTrash,
    listTrash,
    restoreFromTrash,
    deleteFromTrash,
    emptyTrash,
    moveFile,
    renameFile,
  } = useFileSystem();

  // Every open document, flat — one entry per file, whatever tab it is drawn
  // in. Autosave, the asset diff, search and rename all index this by path.
  const [tabs, setTabs] = useState<OpenTab[]>([]);
  // How those documents are arranged in the tab bar: one group per tab, holding
  // one path in the ordinary case and up to five once tabs have been merged
  // into a split view (utils/tabGroups.ts). Groups + the active one are ONE
  // piece of state so no update can leave the active id naming a group it just
  // removed; the focused document — the old `activeTabPath` — is derived from
  // it, which is what keeps the two from drifting.
  const [layout, setLayout] = useState<TabLayout>(EMPTY_LAYOUT);
  const [saveStatus, setSaveStatus] = useState<string>('');

  const activeTabPath = focusedPathOf(layout);

  const activeTab = useMemo(
    () => tabs.find(t => t.file.path === activeTabPath) ?? null,
    [tabs, activeTabPath]
  );
  // Keeping `t.file` identity stable across keystrokes (see updateTabContent)
  // means `activeFile` only changes when the focus does, not on every edit.
  // It is what the file tree highlights and what the graph view centres on;
  // the editor derives its own from the layout, pane by pane.
  const activeFile = activeTab?.file ?? null;
  /* Published to a store as well as held in state: the file tree reads "am I
     the active row" from it per row, so switching tabs re-renders the two rows
     that changed instead of every row in the vault. See utils/activeFile.ts. */
  useEffect(() => { setActiveFilePath(activeFile?.path ?? null); }, [activeFile]);

  // Main pane view ('editor' or 'graph' — the Neural Brain view)
  const [mainView, setMainView] = useState<MainView>('editor');

  // The link graph powering the Neural Brain view and backlinks panel
  const [graph, setGraph] = useState<GraphData>(EMPTY_GRAPH);

  // The global light/dark theme state
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('theme') as Theme) || 'dark');

  // Font size and padding settings (persisted via localStorage)
  const [editorFontSize, setEditorFontSize] = useState<number>(() => parseInt(localStorage.getItem('editorFontSize') || '16', 10));
  const [treeFontSize, setTreeFontSize] = useState<number>(() => parseInt(localStorage.getItem('treeFontSize') || '13', 10));
  const [editorPadding, setEditorPadding] = useState<number>(() => parseInt(localStorage.getItem('editorPadding') || '6', 10));
  const [showSettings, setShowSettings] = useState<boolean>(false);
  /** Whether the Trash bin is on screen. Its rows hold handles crawled out of
   *  ONE vault, so the panel closes when the vault does (see the effect beside
   *  the context menu's) — a put-back clicked after a switch would otherwise
   *  write into the vault the reader has left. */
  const [showTrash, setShowTrash] = useState<boolean>(false);

  // Spaces a Tab inserts — and how far Tab indents a list item. Clamped on the
  // way in: localStorage is user-editable and a NaN would reach CodeMirror.
  const [tabSize, setTabSize] = useState<number>(() => clampTabSize(parseInt(localStorage.getItem('tabSize') || '4', 10)));

  // How many recently opened vaults the vault button's menu lists. Clamped for
  // the same reason as tabSize — this one ends up in Array.slice.
  const [recentVaultLimit, setRecentVaultLimit] = useState<number>(
    () => clampRecentVaultLimit(parseInt(localStorage.getItem('recentVaultLimit') || String(DEFAULT_RECENT_VAULT_LIMIT), 10))
  );

  // Caret (text cursor) appearance settings — persisted via localStorage.
  // caretStyle: 'line' (thin bar) or 'block' (thick terminal-style block).
  // smoothCaret: glide the caret between positions like MS Word.
  // caretSpeed: duration (ms) of that glide.
  const [caretStyle, setCaretStyle] = useState<CaretStyle>(() => (localStorage.getItem('caretStyle') as CaretStyle) || 'line');
  const [caretThickness, setCaretThickness] = useState<number>(() => parseInt(localStorage.getItem('caretThickness') || '10', 10));
  const [smoothCaret, setSmoothCaret] = useState<boolean>(() => (localStorage.getItem('smoothCaret') ?? 'true') === 'true');
  const [caretSpeed, setCaretSpeed] = useState<number>(() => parseInt(localStorage.getItem('caretSpeed') || '80', 10));

  // Custom font loaded from Google Fonts (empty string = use the default)
  const [fontFamily, setFontFamily] = useState<string>(() => localStorage.getItem('fontFamily') || '');

  // Custom accent color (empty string = each theme's default purple)
  const [accentColor, setAccentColor] = useState<string>(() => localStorage.getItem('accentColor') || '');

  // Base ink for language-less ``` blocks (empty string = follow the accent)
  const [codeBlockColor, setCodeBlockColor] = useState<string>(() => localStorage.getItem('codeBlockColor') || '');

  // Keep HTML root data attribute in sync with state for global CSS variables
  useEffect(() => {
    if (theme === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    localStorage.setItem('theme', theme);
  }, [theme]);

  // Sync font sizes to CSS variables and localStorage
  useEffect(() => {
    document.documentElement.style.setProperty('--font-size-normal', editorFontSize + 'px');
    localStorage.setItem('editorFontSize', String(editorFontSize));
  }, [editorFontSize]);

  useEffect(() => {
    document.documentElement.style.setProperty('--nav-item-size', treeFontSize + 'px');
    localStorage.setItem('treeFontSize', String(treeFontSize));
  }, [treeFontSize]);

  useEffect(() => {
    document.documentElement.style.setProperty('--editor-padding', editorPadding + '%');
    localStorage.setItem('editorPadding', String(editorPadding));
  }, [editorPadding]);

  useEffect(() => {
    localStorage.setItem('tabSize', String(tabSize));
  }, [tabSize]);

  useEffect(() => {
    localStorage.setItem('recentVaultLimit', String(recentVaultLimit));
  }, [recentVaultLimit]);

  // Translate the caret settings into CSS variables the CodeMirror theme reads.
  useEffect(() => {
    const root = document.documentElement.style;
    const isBlock = caretStyle === 'block';

    // A block caret fills ~0.6 character widths with a semi-transparent overlay
    // so the glyph beneath stays readable; a line caret uses the thickness slider.
    // Both caret styles use a translucent accent (the line caret's equivalent
    // lives in cmTheme), so they follow a custom accent in either app theme.
    root.setProperty('--caret-line-width', isBlock ? '0px' : caretThickness + 'px');
    root.setProperty('--caret-block-width', isBlock ? '0.6em' : '0px');
    root.setProperty('--caret-block-bg', isBlock
      ? 'color-mix(in srgb, var(--interactive-accent) 40%, transparent)'
      : 'transparent');
    root.setProperty('--caret-radius', isBlock ? '1px' : '0');

    // The smooth glide that gives it the MS Word feel — animate position & height.
    root.setProperty('--caret-transition', smoothCaret
      ? `left ${caretSpeed}ms ease-out, top ${caretSpeed}ms ease-out, height ${caretSpeed}ms ease-out`
      : 'none');

    localStorage.setItem('caretStyle', caretStyle);
    localStorage.setItem('caretThickness', String(caretThickness));
    localStorage.setItem('smoothCaret', String(smoothCaret));
    localStorage.setItem('caretSpeed', String(caretSpeed));
  }, [caretStyle, caretThickness, smoothCaret, caretSpeed]);

  // Load a Google Font by name and apply it app-wide via --font-text.
  useEffect(() => {
    localStorage.setItem('fontFamily', fontFamily);
    const linkId = 'google-font-link';
    let link = document.getElementById(linkId) as HTMLLinkElement | null;
    const family = fontFamily.trim();
    const fallback = '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, "Roboto", sans-serif';

    if (family) {
      const href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}:wght@400;500;600;700&display=swap`;
      if (!link) {
        link = document.createElement('link');
        link.id = linkId;
        link.rel = 'stylesheet';
        document.head.appendChild(link);
      }
      link.href = href;
      document.documentElement.style.setProperty('--font-text', `"${family}", ${fallback}`);
    } else {
      if (link) link.remove();
      document.documentElement.style.removeProperty('--font-text');
    }
  }, [fontFamily]);

  // One custom accent recolors links, code, buttons and highlights everywhere:
  // an inline override on <html> outranks both theme blocks, so it holds across
  // dark/light switches. The hover shade is derived rather than picked —
  // color-mix is fine here, the app is Chromium-only anyway (File System API).
  useEffect(() => {
    const root = document.documentElement.style;
    if (accentColor) {
      root.setProperty('--text-accent', accentColor);
      root.setProperty('--interactive-accent', accentColor);
      root.setProperty('--interactive-accent-hover', `color-mix(in srgb, ${accentColor} 85%, black)`);
    } else {
      root.removeProperty('--text-accent');
      root.removeProperty('--interactive-accent');
      root.removeProperty('--interactive-accent-hover');
    }
    localStorage.setItem('accentColor', accentColor);
  }, [accentColor]);

  // Same override trick for the plain-code-block ink; its stylesheet default
  // is var(--text-accent), so with no custom pick it tracks the accent.
  useEffect(() => {
    const root = document.documentElement.style;
    if (codeBlockColor) {
      root.setProperty('--code-block-color', codeBlockColor);
    } else {
      root.removeProperty('--code-block-color');
    }
    localStorage.setItem('codeBlockColor', codeBlockColor);
  }, [codeBlockColor]);

  const handleResetDefaults = useCallback((defaults: SettingsDefaults) => {
    setEditorFontSize(defaults.editorFontSize);
    setTreeFontSize(defaults.treeFontSize);
    setEditorPadding(defaults.editorPadding);
    setTabSize(defaults.tabSize);
    setCaretStyle(defaults.caretStyle);
    setCaretThickness(defaults.caretThickness);
    setSmoothCaret(defaults.smoothCaret);
    setCaretSpeed(defaults.caretSpeed);
    setFontFamily('');
    setAccentColor(defaults.accentColor);
    setCodeBlockColor(defaults.codeBlockColor);
    setRecentVaultLimit(defaults.recentVaultLimit);
  }, []);

  // ── The app's own modal question ────────────────────────────────────────
  // What `window.confirm` used to do, in the app's own dialog (see
  // components/ConfirmDialog). Beyond looking like the rest of the app, a real
  // dialog can say what will actually HAPPEN — a native one gets a single line
  // of unformatted text, so the question could never be more than "are you
  // sure?", while the thing worth knowing is where the file ends up.
  //
  // A promise per question keeps the callers linear, exactly as they read with
  // `confirm()`. The handlers close the dialog before resolving, so a caller
  // that opens another one is never fighting the first for the screen.
  const [dialog, setDialog] = useState<AppDialog | null>(null);

  // The one on screen, for `raise` below. A ref and not the state, because all
  // three helpers must stay STABLE (`notify` reaches every memoized
  // DocumentPane) and reading `dialog` would put it in their deps.
  const dialogRef = useRef<AppDialog | null>(null);

  /**
   * Put a question on screen, settling whatever was already there.
   *
   * One slot holds one dialog, and each of these hands back a promise the caller
   * is awaiting — so a second question arriving while one is up used to replace
   * it and leave the first promise pending FOR THE SESSION. Whoever was awaiting
   * it never reached its `finally`, so the in-flight ref it holds (`trashInFlight`
   * covers the question as well as the copy) stayed true and every later Move to
   * Trash and every Trash-bin operation silently did nothing. Reachable: any
   * background job that reports through `tell` — a notebook's PDF export runs for
   * seconds with no overlay — landing while the bin's confirmation is open.
   *
   * Dismissing the displaced one is the honest reading: its question was taken
   * off the screen before it could be answered, so its caller hears "no".
   */
  const raise = useCallback((next: AppDialog) => {
    // Settled FIRST, so that its own `setDialog(null)` cannot land on top of the
    // dialog installed below — both writes batch, and the last one must win.
    const prev = dialogRef.current;
    if (prev) (prev.onCancel ?? prev.onConfirm)();
    dialogRef.current = next;
    setDialog(next);
  }, []);

  const settle = useCallback(() => { dialogRef.current = null; setDialog(null); }, []);

  const ask = useCallback((question: DialogRequest) => new Promise<boolean>(resolve => {
    raise({
      ...question,
      onConfirm: () => { settle(); resolve(true); },
      onCancel: () => { settle(); resolve(false); },
    });
  }), [raise, settle]);

  /**
   * A question with THREE answers, for the one place a yes/no cannot say what
   * the reader means: putting something back out of the Trash onto a name that
   * is taken is "replace it", "keep both", or "leave it where it is", and
   * folding either of the first two into the other would decide for them.
   * Escape and a click outside still cancel — the alternative is never a
   * dismissal.
   */
  const askChoice = useCallback((question: DialogRequest & { altLabel: string }) =>
    new Promise<'confirm' | 'alt' | 'cancel'>(resolve => {
      raise({
        ...question,
        onConfirm: () => { settle(); resolve('confirm'); },
        onAlt: () => { settle(); resolve('alt'); },
        onCancel: () => { settle(); resolve('cancel'); },
      });
    }), [raise, settle]);

  /** Report something and wait for it to be read. One button, so Escape and a
   *  click outside mean the same as pressing it. */
  const tell = useCallback((notice: DialogRequest) => new Promise<void>(resolve => {
    raise({ ...notice, onConfirm: () => { settle(); resolve(); } });
  }), [raise, settle]);

  // ── The app's own right-click menu ──────────────────────────────────────
  // One menu is on screen at a time, and every raiser — the editor, a table
  // cell, a file tree row — asks for it through the module store rather than
  // through a prop. See utils/contextMenu.ts: a CodeMirror widget's handlers
  // know nothing about React and outlive the pane that built them, and the
  // file tree is memoized specifically so it stops re-rendering while the user
  // types. Reading the store here is the whole of App's involvement.
  const contextMenu = useSyncExternalStore(subscribeContextMenu, getContextMenu);

  // A menu's rows close over a view — a CodeMirror view, a tree row — and both
  // of those go away when the workspace switches out from under them. Leaving
  // the menu on screen would leave rows that act on something unmounted.
  useEffect(() => { closeContextMenu(); }, [mainView, rootHandle]);

  // Same hazard, one surface further out: every row in the Trash panel closes
  // over a handle from the vault it was crawled in, and nothing in those
  // handles goes stale when the vault does — a put-back clicked afterwards
  // would copy a file into a folder of the vault the reader just left.
  useEffect(() => { setShowTrash(false); }, [rootHandle]);

  /** Say something went wrong, in the app's own dialog. One button, because
   *  there is nothing to decide. STABLE — it is handed to EditorPane and on to
   *  every memoized DocumentPane, which must not re-render per keystroke. */
  const notify = useCallback((message: string) => {
    void tell({ title: 'Could not continue', confirmLabel: 'OK', body: message });
  }, [tell]);

  // The same voice, given to the editor subsystem: a refused clipboard read
  // inside a table cell is the only thing that uses it today. ONE call, at the
  // top level, into a module-level setter — src/editor/ must not learn about
  // React, and what it holds has to stay valid for the app's life, because the
  // handler that eventually calls it was baked into a widget several panes ago.
  useEffect(() => { setTableNotify(notify); }, [notify]);

  /** Whether the sidebar shows vault search in place of the file tree. Lifted
   *  out of FileExplorer when the toggle moved to the bottom actions, which App
   *  renders — FileExplorer is memoized, so `closeSearch` has to be stable or
   *  the tree starts re-rendering while the user types. */
  const [searchOpen, setSearchOpen] = useState(false);
  const closeSearch = useCallback(() => setSearchOpen(false), []);

  /** Stable for the app's life. As an inline arrow this handed `FileExplorer` a
   *  fresh prop on EVERY App render, which defeated its `React.memo` outright —
   *  the one thing that memo exists to prevent. */
  const collapseSidebar = useCallback(() => setSidebarCollapsed(true), []);

  // Expanded folder paths (persisted via localStorage)
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
    () => new Set<string>(readJSON<string[]>('expandedPaths', []))
  );

  const handleToggleExpand = useCallback((path: string) => {
    setExpandedPaths(prev => {
      const next = new Set<string>(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      writeJSON('expandedPaths', [...next]);
      return next;
    });
  }, []);

  // Refs mirroring tab state for use inside stable callbacks / timers.
  const tabsRef = useRef<OpenTab[]>(tabs);
  const layoutRef = useRef<TabLayout>(layout);
  const activeTabPathRef = useRef<string | null>(activeTabPath);
  // The documents currently on screen — every pane of the active tab, not just
  // the focused one, so a save in a neighbouring pane still reports itself.
  const visiblePathsRef = useRef<string[]>([]);
  // Per-PATH debounced save timers, so switching or closing one tab never
  // cancels another tab's pending write (fixes the old single-timer data loss).
  const saveTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const saveStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { tabsRef.current = tabs; }, [tabs]);
  useEffect(() => {
    layoutRef.current = layout;
    visiblePathsRef.current = visiblePaths(layout);
  }, [layout]);
  useEffect(() => { activeTabPathRef.current = activeTabPath; }, [activeTabPath]);

  /**
   * WHICH VAULT the workspace on screen is the session of — the handle and the
   * id together, because neither alone is enough.
   *
   * `openVaultHandle` commits rootHandle + fileTree in one batch and only then
   * awaits recordVault, so there is a commit where the tree is the NEW vault's
   * and `currentVaultId` is still the OLD one; restoring there would open the
   * old vault's paths out of the new vault's tree. And the persist effect is
   * declared before the switch effect, so on the switch commit it runs FIRST,
   * with the outgoing layout — and would file it under the incoming id.
   *
   * So both effects check both refs, and the restore pass writes them together
   * — and only once it has a real id to write, never against the `null` a vault
   * carries between its tree landing and recordVault answering (see there).
   * `undefined` is "nothing restored yet", which no vault id can collide with.
   */
  const sessionRootRef = useRef<FileSystemDirectoryHandle | null>(null);
  const sessionVaultIdRef = useRef<string | null | undefined>(undefined);
  /**
   * The restore pass still READING the claimed vault's files, if one is — and
   * while it is, nothing is persisted. Claiming the two refs above is what
   * un-gates persistence, and the claim comes before the reads, so a note opened
   * in that window was written out as the vault's whole session until the merge
   * wrote it back (measured: a tree click 100ms into a restore reading 600ms per
   * file held the stored session at that one tab for 2.4s, and a reload inside
   * the window came back with only it — all four saved documents, split and
   * all, gone for good). A token rather than a flag, so a pass that outlives a
   * switch cannot release the gate a later pass holds.
   */
  const restoringRef = useRef<object | null>(null);

  // The open vault, for the async restore pass to re-check after its awaits —
  // BOTH halves of it, because `currentVaultId` lags `rootHandle` by a commit on
  // every path that commits the tree before awaiting `recordVault`. The id alone
  // cannot tell that pass a switch happened underneath it (see there).
  const currentVaultIdRef = useRef<string | null>(currentVaultId);
  useEffect(() => { currentVaultIdRef.current = currentVaultId; }, [currentVaultId]);
  const rootHandleRef = useRef<FileSystemDirectoryHandle | null>(rootHandle);
  useEffect(() => { rootHandleRef.current = rootHandle; }, [rootHandle]);

  // Which vault the two path-keyed records (fileScrollPositions,
  // pdfViewPositions) file their entries under. Declared BEFORE the restore
  // pass so no pane it opens can read a record under the outgoing vault's
  // scope — `Notes/index.md` names a different file in every vault, and with
  // per-vault sessions both of them are routinely open.
  //
  // That covers the panes THIS app opens, and not the one window it cannot:
  // `currentVaultId` lands a commit after `rootHandle`+`fileTree` on the
  // switch paths, so the new vault's tree is clickable while the scope still
  // names the old one, and a file opened by hand right then reads the other
  // vault's offset for the same path. Deliberately not "fixed" by clearing the
  // scope on switch: pane unmounts run one commit AFTER the switch effect, so
  // their flush would then write the OUTGOING vault's offsets to bare paths —
  // trading a rare wrong offset for a routine one.
  useEffect(() => { setRecordScope(currentVaultId); }, [currentVaultId]);

  // Persist the open documents, how they are grouped into tabs, which pane each
  // tab was left on and how wide those panes were, UNDER THIS VAULT'S ID — so a
  // reload, and a switch away and back, both come back to the same workspace.
  // Keyed on `layout` (not `tabs`) so it does NOT run on every keystroke — the
  // layout's identity only moves when the tab bar actually changes.
  //
  // GATED on the two session refs, which is the old `hasRestoredTabs` rule
  // generalized per vault. It has to cover two things:
  //   • mount, with zero tabs — writing that out would clobber the stored list
  //     moments before restore reads it, which is what once reduced every
  //     reload to "only the last-active file comes back";
  //   • the vault-switch commit, where this effect runs first (declaration
  //     order) with the OUTGOING layout, and a commit later with the empty one
  //     the switch installs — either of which would land under the INCOMING
  //     vault's id.
  // The HANDLE test is what actually closes that, under either ordering:
  // `sessionRootRef` holds the outgoing handle before the switch effect runs
  // and `null` after, and the switch effect only fires when the handle really
  // changed — so it can never equal the incoming `rootHandle`. Declaration
  // order is therefore not the guard; the `sessionRootRef.current = null`
  // there is (see it for what depends on it).
  // An empty layout is written happily once the refs match: "I closed
  // everything in this vault" is a session, and must survive a switch.
  useEffect(() => {
    if (!currentVaultId) return;                              // no id → nowhere to file it
    if (sessionRootRef.current !== rootHandle) return;        // the workspace is still the old vault's
    if (sessionVaultIdRef.current !== currentVaultId) return; // …or this vault's restore has not run yet
    if (restoringRef.current) return;                         // …or is still reading (see restoringRef)
    writeSession(currentVaultId, {
      paths: layout.groups.flatMap(g => g.paths),
      groups: layout.groups.map(g => g.paths),
      // Which pane each split tab was left on: without it a background split
      // tab came back on its leftmost pane, since `active` speaks for one group.
      focus: layout.groups.map(g => g.activePath),
      // `null` for the tabs nobody resized, which is most of them — absence is
      // how "equal columns" is encoded all the way down (see tabGroups.ts).
      sizes: layout.groups.map(g => g.sizes ?? null),
      active: focusedPathOf(layout),
    });
  }, [layout, currentVaultId, rootHandle]);

  // Sidebar resizing
  const [sidebarWidth, setSidebarWidth] = useState<number>(260);

  // Sidebar collapse (Cmd+\, the explorer-header button, or the rail) —
  // persisted, and collapsing leaves a thin rail so it can be re-expanded.
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => localStorage.getItem('sidebarCollapsed') === 'true');
  useEffect(() => {
    localStorage.setItem('sidebarCollapsed', String(sidebarCollapsed));
  }, [sidebarCollapsed]);
  // Suppresses the collapse animation while drag-resizing, so the width
  // tracks the pointer instead of easing 150ms behind it.
  const [isDraggingSidebar, setIsDraggingSidebar] = useState<boolean>(false);
  const isResizing = useRef<boolean>(false);

  // ── Asset lifecycle ─────────────────────────────────────────────────────
  // An asset belongs to the notes that embed it: paste a picture and it is
  // written into the `.Assets` beside the note, and when the last reference to
  // it goes away it is retired into that same folder's `.Garbage`.
  //
  // What each open document referred to as of its last write, so a save can
  // tell an embed that has just been DELETED from one that was never there.
  // Seeded when a tab opens (below), because otherwise the first edit after
  // opening a note — the likeliest one to remove a picture — would have
  // nothing to compare against.
  const assetRefsRef = useRef<Map<string, Set<string>>>(new Map());
  const fileTreeRef = useRef<FileTreeNode[]>(fileTree);
  useEffect(() => { fileTreeRef.current = fileTree; }, [fileTree]);

  const rememberAssetRefs = useCallback((file: ActiveFile, content: string) => {
    if (tracksAssets(file)) assetRefsRef.current.set(file.path, assetEmbeds(content));
  }, []);

  /** Follow a note to its new path (rename/move), so the next save there still
   *  has something to diff against. */
  const moveAssetRefs = useCallback((from: string, to: string) => {
    const refs = assetRefsRef.current.get(from);
    if (!refs) return;
    assetRefsRef.current.delete(from);
    assetRefsRef.current.set(to, refs);
  }, []);

  /**
   * Bring a folder's `.Assets` back in step with the note that was just saved.
   *
   * Driven by the SAVED text rather than by keystrokes: until a removal has
   * reached the disk it isn't one, the save debounce doubles as an undo grace
   * period, and one regex pass per second beats one per character typed.
   *
   * Both sets are handed in rather than derived here, because the baseline can
   * only be read (and handed over) SYNCHRONOUSLY at the point of the save — see
   * flushTab.
   */
  const reconcileAssets = useCallback(async (file: ActiveFile, before: Set<string>, after: Set<string>) => {
    const dir = file.parentHandle;
    if (!dir) return;

    try {
      // A reference that came BACK — undo, or the same embed pasted into a
      // sibling note — reclaims its asset from the folder's `.Garbage`. Almost
      // always a no-op (the asset is right where it should be), and cheap.
      //
      // The editor showed the reclaimed embed the instant it was typed, i.e.
      // a second before the file it wants came back, so it is holding an
      // "Image not found" it has no reason to re-check on its own.
      let reclaimed = false;
      for (const name of after) {
        if (before.has(name)) continue;
        if (await restoreAsset(name, dir)) reclaimed = true;
      }
      if (reclaimed) retryMissingAssets();

      const orphaned = new Set([...before].filter(name => !after.has(name)));
      if (orphaned.size === 0) return;

      // Who has to be consulted before a picture is taken away — a picture
      // shared with another note must survive being removed from this one.
      //
      // NOT just this folder's own notes: getAssetUrl walks UP from a note when
      // its own `.Assets` doesn't have the file, so a note in any DESCENDANT
      // folder may be showing this very asset. That is exactly how a vault
      // carried forward from the era of one root-level `.Assets` still renders,
      // and going by the folder alone would retire the picture out from under
      // every one of those notes. The subtree is only walked when an embed was
      // actually dropped, which is rare; same-folder notes come first because
      // they are the overwhelmingly likely hit, and the walk stops as soon as
      // every dropped name has been spoken for.
      const folder = parentVaultPath(file.path);
      const under = folder ? `${folder}/` : '';
      const candidates = collectFiles(fileTreeRef.current).filter(f =>
        f.path !== file.path && isTextFile(f.name) && f.path.startsWith(under));
      const neighbours = [
        ...candidates.filter(f => parentVaultPath(f.path) === folder),
        ...candidates.filter(f => parentVaultPath(f.path) !== folder),
      ];

      // Every dropped name is answered in ONE pass, holding one note's text at
      // a time. These are the same files buildGraph deliberately stopped
      // holding all at once, and for a note at the vault root this subtree is
      // the whole vault.
      for (const note of neighbours) {
        if (orphaned.size === 0) break;
        // An open tab is read from its BUFFER, so an unsaved reference counts
        // just as much as a saved one.
        const open = tabsRef.current.find(t => t.file.path === note.path);
        const text = open ? open.content : await readFile(note.handle).catch(() => null);
        // A note that can't be read might say anything, so it is taken to say
        // "keep": a stale file costs nothing next to deleting a picture that is
        // still on screen somewhere.
        if (text === null) return;
        for (const name of orphaned) {
          if (referencesAsset(text, name)) orphaned.delete(name);
        }
      }

      for (const name of orphaned) await retireAsset(name, dir);
    } catch (err) {
      console.error('Could not reconcile assets for', file.path, err);
    }
  }, [readFile, retireAsset, restoreAsset]);

  // Read through a ref for the same reason writeFile and rebuildGraph are: it
  // keeps flushTab — and every timer and listener downstream of it — stable.
  const reconcileAssetsRef = useRef(reconcileAssets);
  useEffect(() => { reconcileAssetsRef.current = reconcileAssets; }, [reconcileAssets]);

  /**
   * Reconciles run ONE AT A TIME, in the order their saves happened.
   *
   * A single pass can take a while — it may read a whole subtree — and the
   * saves that start them are only a second apart, so they overlap easily. Left
   * to race, the classic sequence loses a picture: remove an embed (save A
   * begins a long scan), undo (save B restores the asset at once), then A's
   * retire lands on top and the note is pointing at a file in `.Garbage`.
   * Ordering them makes B's restore the last word, which is what it is.
   *
   * Same promise-queue shape as utils/recentVaults.ts. reconcileAssets catches
   * its own errors, so this chain never rejects.
   */
  const reconcileQueueRef = useRef<Promise<void>>(Promise.resolve());
  const queueReconcile = useCallback((file: ActiveFile, before: Set<string>, after: Set<string>) => {
    reconcileQueueRef.current = reconcileQueueRef.current
      .then(() => reconcileAssetsRef.current(file, before, after));
  }, []);

  // Returns whether the file was actually opened (as a tab or externally).
  const handleFileClick = useCallback(async (node: FileTreeNode): Promise<boolean> => {
    try {
      // PDFs open in a pane like any other file. Everything else non-textual
      // (images, video, …) still hands off to the browser.
      if (!isTextFile(node.name) && !isPdfFile(node.name)) {
        const file = await (node.handle as FileSystemFileHandle).getFile();
        window.open(externalOpenUrl(node.path, file), '_blank');
        return true;
      }

      // Already open? Just focus it — don't re-read (preserves the tab's
      // unsaved edits and its own undo history). Its pane comes to the front
      // whether it is a tab of its own or one pane of a split.
      if (tabsRef.current.some(t => t.file.path === node.path)) {
        setLayout(l => focusTab(l, node.path));
        return true;
      }

      // A PDF's bytes are read by PdfPane itself; its tab buffer holds the
      // tldraw snapshot instead (empty until the canvas loads and reports one).
      // readFile() must not touch it — decoding a PDF as UTF-8 corrupts it.
      const content = isPdfFile(node.name) ? '' : await readFile(node.handle as FileSystemFileHandle);
      // What this note referred to when it was opened — the baseline every
      // later save's asset diff is taken against.
      rememberAssetRefs(node, content);
      // Re-check inside the updater: a second click can land while the first
      // read is still in flight, and tabsRef only updates post-commit.
      setTabs(prev => prev.some(t => t.file.path === node.path)
        ? prev
        : [...prev, { id: newTabId(), file: node, content, mode: 'read', dirty: false }]);
      // openTab re-checks too, and focuses an existing tab rather than minting a
      // second one — the same race, answered the same way.
      setLayout(l => openTabIn(l, node.path));
      setSaveStatus('');
      return true;
    } catch (err) {
      console.error('Failed to read file:', err);
      return false;
    }
  }, [readFile, rememberAssetRefs]);

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
  }, [fileTree, handleFileClick, tell]);

  /**
   * Read `<vault>/.appearance.json` when the vault opens.
   *
   * Once per vault, not once per tree walk: the walk runs after every save, and
   * a file read on that path would be a read per keystroke-triggered autosave
   * (the rule AGENTS.md states for anything that touches the whole vault). The
   * styles are held in a store from then on, and this app is the only writer.
   */
  useEffect(() => {
    let cancelled = false;
    if (!rootHandle) { setEntryStyles(emptyEntryStyles()); return; }
    (async () => {
      const read = async (name: string) => {
        const handle = await rootHandle.getFileHandle(name);
        return (await handle.getFile()).text();
      };
      try {
        if (!cancelled) setEntryStyles(parseEntryStyles(await read(ENTRY_STYLE_FILE)));
      } catch {
        try {
          // The name this file had while only folders could be styled. Read it
          // once and write it forward, so a rename we chose costs nobody their
          // icons; the parser reads that build's `folders` key too. The old file
          // is left alone — this app does not delete from a vault to tidy up.
          const legacy = parseEntryStyles(await read(LEGACY_STYLE_FILE));
          if (cancelled) return;
          setEntryStyles(legacy);
          if (Object.keys(legacy.entries).length) void writeEntryStylesRef.current?.(legacy);
        } catch {
          // No file at all is the ordinary case — a vault has none until
          // something is given a look. Anything unreadable is the parser's.
          if (!cancelled) setEntryStyles(emptyEntryStyles());
        }
      }
    })();
    return () => { cancelled = true; };
  }, [rootHandle]);

  /** The migration above runs before `writeEntryStyles` is declared, and a
   *  hoisted reference is the only way to reach it from there. */
  const writeEntryStylesRef = useRef<((next: ReturnType<typeof getEntryStyles>) => Promise<void>) | null>(null);

  /**
   * Persist the styles, and put them on screen at once.
   *
   * The store is updated first and the write follows, so a picked icon appears
   * in the sidebar immediately rather than after a round trip to disk — the
   * picker is a live preview, and it is being judged against the real tree.
   */
  const writeEntryStyles = useCallback(async (next: ReturnType<typeof getEntryStyles>) => {
    setEntryStyles(next);
    if (!rootHandle) return;
    try {
      // createFile opens-or-truncates, which is exactly right here: this file is
      // the app's own and is rewritten whole every time.
      const handle = await createFile(rootHandle, ENTRY_STYLE_FILE);
      await writeFile(handle, serializeEntryStyles(next));
    } catch (err) {
      console.error(`Could not save ${ENTRY_STYLE_FILE}:`, err);
      notify('Could not save how that folder looks.');
    }
  }, [createFile, notify, rootHandle, writeFile]);
  useEffect(() => { writeEntryStylesRef.current = writeEntryStyles; }, [writeEntryStyles]);

  /** Stable for the app's life: FileExplorer and TreeNode are both memoized. */
  const handleStyleEntry = useCallback((
    path: string,
    icon: string | undefined,
    color: string | undefined,
    nodes?: IconNode[],
  ) => {
    void writeEntryStyles(withEntryStyle(getEntryStyles(), path, { icon, color }, nodes));
  }, [writeEntryStyles]);

  /** PDF names this session has exported. Re-exporting must not ask about a
   *  file that is this notebook's own previous export. */
  const exportedNotebooksRef = useRef<Set<string>>(new Set());

  /**
   * Write the open notebook out as a PDF beside it.
   *
   * The notebook stays the editable original and the PDF is an OUTPUT, so
   * re-exporting overwrites the same name rather than piling up "(1)" copies —
   * that name is derived from the notebook's, so it can only ever land on this
   * notebook's own export. It is the one deliberate exception to the app's
   * never-overwrite rule, and it is why the confirm below exists: a PDF of that
   * name that ISN'T ours is a file we would be destroying.
   */
  const handleExportNotebook = useCallback(async (file: ActiveFile) => {
    if (!file.parentHandle) return;
    const targetName = notebookPdfName(file.name);

    const exporter = getNotebookExporter(file.path);
    if (!exporter) {
      notify(`Open "${file.name}" before exporting it.`);
      return;
    }

    try {
      const exported = await exporter();
      if (!exported) { notify(`Open "${file.name}" before exporting it.`); return; }

      // Only ask when there is something to lose, and only once: after the
      // first export the file at that name is one of ours.
      if (!exportedNotebooksRef.current.has(targetName)
          && await nameTaken(file.parentHandle, targetName)) {
        const replace = await ask({
          title: `Replace "${targetName}"?`,
          body: `A PDF of that name is already in this folder. Exporting will overwrite it.`,
          confirmLabel: 'Replace',
          danger: true,
        });
        if (!replace) return;
      }

      const { buildNotebookPdfAsync } = await import('./utils/pdfBuildClient');
      const bytes = await buildNotebookPdfAsync(exported.paper, exported.overlays, {
        path: file.path,
        exportedAt: Date.now(),
      });
      // createFile refreshes the tree, so the PDF shows up in the sidebar.
      const handle = await createFile(file.parentHandle, targetName);
      await writeFileBytes(handle, bytes);
      exportedNotebooksRef.current.add(targetName);
      void tell({
        title: 'Exported to PDF',
        confirmLabel: 'OK',
        body: `"${targetName}" is in the same folder — ${exported.paper.pageCount} `
          + `${exported.paper.pageCount === 1 ? 'page' : 'pages'}.`,
      });
    } catch (err) {
      console.error('Could not export the notebook:', err);
      notify(`Could not export "${file.name}".`);
    }
  }, [ask, createFile, notify, tell, writeFileBytes]);

  // Flat index of markdown files for resolving wikilinks by note name. Read
  // through a ref by openNoteByName below, which MUST stay stable: the editor
  // bakes its wikilink handler into a document's EditorState, and that state
  // outlives the pane that built it (see DocumentPane).
  const mdFiles = useMemo(() => collectMarkdownFiles(fileTree), [fileTree]);
  const mdFilesRef = useRef(mdFiles);
  useEffect(() => { mdFilesRef.current = mdFiles; }, [mdFiles]);

  // A different vault may reuse paths — never resolve links from the old one's
  // cached extractions (mirrors FileExplorer clearing the search cache).
  useEffect(() => { clearLinkCache(); }, [rootHandle]);

  // Same reasoning for the window.open blob URLs: a different vault can hold the
  // same path, and (mtime, size) alone could match, so drop them with the vault
  // rather than risk serving the old file's bytes (and pinning them all session).
  useEffect(() => () => {
    for (const { url } of externalUrls.values()) URL.revokeObjectURL(url);
    externalUrls.clear();
  }, [rootHandle]);

  // Rebuild the link graph. Re-runs when the tree changes and after every save;
  // buildGraph itself only re-reads files whose (mtime, size) moved.
  const rebuildGraph = useCallback(async () => {
    if (!fileTree || fileTree.length === 0) {
      // Through the same identity guard as the built graph below: a fresh empty
      // object here would re-seed GraphView on every tree change just as surely.
      setGraph(prev => sameGraph(prev, EMPTY_GRAPH) ? prev : EMPTY_GRAPH);
      return;
    }
    try {
      const g = await buildGraph(fileTree);
      // Keep the OLD object when nothing about the graph changed. A fresh
      // identity on every save propagates all the way into GraphView's effects,
      // which re-seed the simulation (alpha = 1) and tear down and rebuild the
      // RAF loop and ResizeObserver — so an unrelated tab autosaving used to
      // visibly re-heat the Neural Brain view while the user was looking at it.
      setGraph(prev => sameGraph(prev, g) ? prev : g);
    } catch (err) {
      console.error('Failed to build link graph:', err);
    }
  }, [fileTree]);

  useEffect(() => { rebuildGraph(); }, [rebuildGraph]);

  // ── Per-tab autosave ────────────────────────────────────────────────────
  // rebuildGraph/writeFile are read through refs so the save helpers keep a
  // stable identity (no re-armed timers / re-subscribed listeners on every
  // graph rebuild) while never going stale.
  const rebuildGraphRef = useRef(rebuildGraph);
  const writeFileRef = useRef(writeFile);
  const writeFileBytesRef = useRef(writeFileBytes);
  useEffect(() => { rebuildGraphRef.current = rebuildGraph; }, [rebuildGraph]);
  useEffect(() => { writeFileRef.current = writeFile; }, [writeFile]);
  useEffect(() => { writeFileBytesRef.current = writeFileBytes; }, [writeFileBytes]);

  const clearSaveTimer = useCallback((path: string) => {
    const pending = saveTimersRef.current.get(path);
    if (pending) { clearTimeout(pending); saveTimersRef.current.delete(path); }
  }, []);

  // Write one tab's buffered content to its OWN handle. The tab is captured
  // synchronously (before the await), so this is safe to fire right before the
  // tab is removed from state (e.g. on close). Skips Help / handle-less tabs.
  const flushTab = useCallback(async (path: string | null, force = false, contentOverride?: string) => {
    if (!path) return;
    clearSaveTimer(path);

    const tab = tabsRef.current.find(t => t.file.path === path);
    if (!tab || tab.file.isHelp || !tab.file.handle) return;
    if (!tab.dirty && !force) return;
    // contentOverride exists for callers who have fresher content than the tab
    // does: setTabs is async, so a caller that just produced new content would
    // otherwise race with React and write the previous buffer.
    const snapshot = contentOverride ?? tab.content;

    try {
      if (isPdfFile(tab.file.name)) {
        // An annotated PDF tab's buffer is a tldraw snapshot; the file on disk
        // is a real PDF. Rebuild it from the pristine original + the overlays
        // the canvas parked for us. No render data yet means the canvas has not
        // reported a change — which is also every PDF only ever read, now that
        // any of them can be annotated and none is told apart by its name.
        const data = getPdfRenderData(path);
        if (!data) return;
        // Off the main thread: stamping overlays costs ~150ms per annotated page
        // (~4.2s at 30 pages), which would land as stutter under the pen.
        const { buildAnnotatedPdfAsync } = await import('./utils/pdfBuildClient');
        const bytes = await buildAnnotatedPdfAsync(data.original, snapshot, data.overlays);
        await writeFileBytesRef.current(tab.file.handle as FileSystemFileHandle, bytes);
      } else {
        // Read AND handed over in one synchronous step, which is what makes the
        // asset diff exact. Two things would otherwise race it: removeTab drops
        // this entry the moment after it calls flushTab (so a closing tab's last
        // save must capture first), and a second save landing while the first is
        // still reconciling would read a baseline the first had yet to replace,
        // and could retire a picture that save had just put back.
        const embedsBefore = tracksAssets(tab.file) ? assetRefsRef.current.get(path) : undefined;
        const embedsAfter = embedsBefore && assetEmbeds(snapshot);
        if (embedsAfter) assetRefsRef.current.set(path, embedsAfter);

        await writeFileRef.current(tab.file.handle as FileSystemFileHandle, snapshot);
        // Queued rather than awaited: reconciling reads the note's neighbours,
        // and a save's "Saved" status (and the graph rebuild below) should not
        // wait on that — but two of them must not interleave either.
        if (embedsBefore && embedsAfter) {
          queueReconcile(tab.file, embedsBefore, embedsAfter);
        }
      }
      // Only clear `dirty` if the content hasn't changed since we snapshotted.
      setTabs(prev => prev.map(t =>
        t.file.path === path && t.content === snapshot ? { ...t, dirty: false } : t));
      // Any pane on screen, not only the focused one: with a split tab the
      // status line speaks for everything the reader can see.
      if (visiblePathsRef.current.includes(path)) {
        setSaveStatus('Saved');
        // Re-armed, not stacked: rapid saves used to leave a handful of live
        // timers all racing to clear the same message.
        if (saveStatusTimerRef.current) clearTimeout(saveStatusTimerRef.current);
        saveStatusTimerRef.current = setTimeout(() => setSaveStatus(''), 2000);
      }
      rebuildGraphRef.current();
      // Notifies the vault-search index (see utils/saveEpoch.ts) so a file that
      // was edited, saved and then closed is re-read from disk. Deliberately not
      // React state: as a prop it re-rendered the whole file tree every save.
      bumpSaveEpoch();
    } catch (err) {
      console.error('Auto-save failed:', err);
    }
    // queueReconcile is stable (a useCallback over refs), so flushTab — and
    // every timer and listener downstream of it — keeps its identity.
  }, [clearSaveTimer, queueReconcile]);

  const scheduleSave = useCallback((path: string) => {
    clearSaveTimer(path);
    // flushTab clears the (now-fired) timer itself, so no delete needed here.
    saveTimersRef.current.set(path, setTimeout(() => flushTab(path), 1000));
  }, [clearSaveTimer, flushTab]);

  // Buffer an edit against ONE named document and schedule its save.
  // Path-explicit on purpose, and the only content funnel there is: several
  // documents are editable at once in a split tab, and the drawing canvas
  // serializes on a debounce that can fire after its pane has gone away. Either
  // way the text must land in the document it came from — never in whichever
  // pane happens to have focus by then.
  const updateTabContent = useCallback((path: string, content: string) => {
    setTabs(prev => prev.map(t => t.file.path === path ? { ...t, content, dirty: true } : t));
    scheduleSave(path);
  }, [scheduleSave]);

  /**
   * Buffer an edit and write it NOW, skipping the save debounce.
   *
   * For the moment a PDF leaves annotate mode: the viewer is about to re-read
   * the file, so waiting out the 1s debounce would show the pre-annotation PDF
   * and only correct itself a second later.
   *
   * The content is passed explicitly rather than read back from the tab — the
   * setTabs above hasn't committed yet when flushTab runs.
   */
  const flushTabNow = useCallback(async (path: string, content: string) => {
    setTabs(prev => prev.map(t => t.file.path === path ? { ...t, content, dirty: true } : t));
    await flushTab(path, true, content);
  }, [flushTab]);

  /** Everything that has to happen for ONE document to stop being open, short
   *  of the two state updates (which differ per caller). */
  const releaseTab = useCallback((path: string, flush: boolean) => {
    // flushTab captures the tab synchronously, clears the timer, and no-ops for
    // non-dirty / Help / handle-less tabs, so calling it whenever we flush is safe.
    if (flush) flushTab(path); else clearSaveTimer(path);
    // Safe to drop now: flushTab reads the render data synchronously, before its
    // first await, so a flush already in flight has what it needs.
    clearPdfRenderData(path);
    // A notebook's exporter closes over its editor; dropping it is what stops a
    // closed notebook pinning that editor for the rest of the session.
    clearNotebookRenderData(path);
    // Same: the flush above captured its own diff before this ran. A closed
    // note has no unsaved edits left to attribute an asset change to.
    assetRefsRef.current.delete(path);
  }, [clearSaveTimer, flushTab]);

  /**
   * A rename or move that lands on a name another tab is holding. renameFile /
   * moveFile deliberately overwrite (an explicit move onto a name is the user
   * saying so), so that tab's file no longer exists — its buffer must NOT be
   * flushed, or it would write itself straight back over the file that just
   * replaced it. Dropping it here is what keeps one path from ending up in two
   * tabs, drawing one document under two names.
   *
   * Called on EVERY overwrite, whether or not the file being renamed is itself
   * open: the hazard belongs to the tab holding the destination name, which
   * still holds a handle resolving to that very directory entry. Skipping it
   * when the source happened to be closed left that tab's autosave to put the
   * old bytes back over the file that had just replaced them.
   *
   * BEFORE the moved document's own per-path state is re-keyed onto this path,
   * never after: `releaseTab` clears exactly the two slots (the parked PDF
   * render data, the asset-diff baseline) that movePdfRenderData/moveAssetRefs
   * write, so running it second wiped the survivor's rather than the loser's —
   * silently dropping pending annotations and killing that note's asset diff
   * for the rest of the session.
   */
  const releaseOverwritten = useCallback((path: string, movedFrom: string) => {
    if (path === movedFrom) return;
    if (!tabsRef.current.some(t => t.file.path === path)) return;
    releaseTab(path, false);                       // no flush: the bytes are gone
    // Its pane goes too. renamePath would drop it as it re-points the moved
    // document, but only when the moved one is open — and closing it here is
    // also what puts the focus on a NEIGHBOUR of the tab that vanished rather
    // than on whichever tab happens to be leftmost.
    setLayout(l => closePath(l, path));
    setTabs(prev => prev.filter(t => t.file.path !== path));
  }, [releaseTab]);

  /** Close one document. Its pane goes; the tab goes with it only if that was
   *  its last pane (see utils/tabGroups.ts closePath). */
  const removeTab = useCallback((path: string, flush: boolean) => {
    releaseTab(path, flush);
    setLayout(l => closePath(l, path));
    setTabs(prev => prev.filter(t => t.file.path !== path));
  }, [releaseTab]);

  const closeTab = useCallback((path: string) => removeTab(path, true), [removeTab]);

  /** Close a whole tab — every document in it. A merged tab is one tab, so its
   *  × takes all of its panes; each pane's own × closes just that one. */
  const closeTabGroup = useCallback((id: string) => {
    const group = groupById(layoutRef.current, id);
    if (!group) return;
    for (const path of group.paths) releaseTab(path, true);
    const closed = new Set(group.paths);
    setLayout(l => closeGroupIn(l, id));
    setTabs(prev => prev.filter(t => !closed.has(t.file.path)));
  }, [releaseTab]);

  const selectTabGroup = useCallback((id: string) => setLayout(l => selectGroup(l, id)), []);
  const focusPane = useCallback((path: string) => setLayout(l => focusTab(l, path)), []);
  const splitOffPane = useCallback((path: string) => setLayout(l => splitOff(l, path)), []);
  const mergeTabGroups = useCallback(
    (sourceId: string, index: number) => setLayout(l => mergeIntoActive(l, sourceId, index)), []);
  const reorderTabGroups = useCallback(
    (id: string, toIndex: number) => setLayout(l => reorderGroups(l, id, toIndex)), []);
  /** How a split tab divides its width between its panes; null evens them up.
   *  One update at the END of a divider drag, never per frame: the persist
   *  effect is keyed on `layout`, so a live commit would write the whole
   *  session to localStorage sixty times a second. EditorPane holds the widths
   *  in flight and hands the settled row over here. */
  const resizeTabPanes = useCallback(
    (id: string, sizes: number[] | null) => setLayout(l => setGroupSizes(l, id, sizes)), []);

  const toggleTabMode = useCallback((path: string | null) => {
    if (!path) return;
    setTabs(prev => prev.map(t =>
      t.file.path === path && !t.file.isHelp
        ? { ...t, mode: t.mode === 'edit' ? 'read' : 'edit' }
        : t));
  }, []);

  // Open a note by its name (used by [[wikilinks]], graph nodes, backlinks).
  //
  // STABLE FOR THE APP'S LIFE, deliberately — the note index is read from a ref
  // rather than closed over. The editor bakes this into each document's
  // EditorState (DocumentPane's `mousedown` handler), outside any compartment,
  // and that state is cached and re-adopted by whichever pane shows the
  // document next. Depending on `mdFiles` here froze the handler at whatever
  // the index held when the document's FIRST pane unmounted, so a wikilink to
  // any note created, renamed or moved after that silently did nothing.
  const openNoteByName = useCallback((name: string | null) => {
    if (!name) return;
    const key = baseName(name).toLowerCase();
    const match = mdFilesRef.current.find(f => baseName(f.name).toLowerCase() === key);
    if (match) {
      handleFileClick(match);
      setMainView('editor');
    }
  }, [handleFileClick]);

  // Open a note given a graph node (skips unresolved placeholder nodes).
  const handleOpenNode = useCallback((graphNode: GraphNode) => {
    if (!graphNode || graphNode.unresolved || !graphNode.node) return;
    handleFileClick(graphNode.node);
    setMainView('editor');
  }, [handleFileClick]);

  // ── Vault search → editor navigation ───────────────────────────────────
  // A clicked search result opens the file and, for content matches, asks
  // EditorPane to select + scroll to the matched range. Each click builds a
  // fresh request object, so re-clicking the same match re-triggers.
  const [pendingReveal, setPendingReveal] = useState<EditorRevealRequest | null>(null);

  const handleOpenSearchResult = useCallback(async (node: FileTreeFileNode, range: TextRange | null) => {
    const opened = await handleFileClick(node);
    // Non-text files opened externally (pdf/image): no view switch, no reveal.
    if (!opened || !isTextFile(node.name)) return;
    setMainView('editor');
    // Drawings match by NAME only (their JSON isn't indexed), so there's no text
    // range to reveal — and a char offset would be meaningless on a canvas.
    if (range && !isCanvasFile(node.name)) {
      setPendingReveal({ path: node.path, from: range.from, to: range.to });
    }
  }, [handleFileClick]);

  const handleRevealHandled = useCallback(() => setPendingReveal(null), []);

  // ── Vault switch ────────────────────────────────────────────────────────
  // A tab is only meaningful inside the vault it was opened from: its path
  // indexes that vault's tree, its handle writes into that vault's folder, and
  // EditorPane's cached editor states are keyed by path alone. Carrying the set
  // across a switch leaves the previous vault's notes on screen — and still
  // autosaving into it — behind the new vault's file tree, and a path the two
  // vaults happen to share would serve the old vault's buffer for the new
  // vault's file. So flush what's pending (those handles are still good) and
  // hand the new vault an empty workspace.
  //
  // Emptying the workspace does NOT lose the outgoing vault's session: the
  // persist effect above has already written it under that vault's id on every
  // layout change, and the two session refs stop this `EMPTY_LAYOUT` being
  // filed under either vault — the outgoing one because its restore marker no
  // longer matches `rootHandle`, the incoming one because its restore has not
  // run yet. That is what makes switching back restore the workspace.
  //
  // Only fires on a REAL switch: the null → vault assignment at startup must not
  // clear the tabs the restore pass below is about to bring back.
  const prevRootRef = useRef<FileSystemDirectoryHandle | null>(null);
  useEffect(() => {
    const previous = prevRootRef.current;
    prevRootRef.current = rootHandle;
    if (!previous || previous === rootHandle) return;

    for (const tab of tabsRef.current) {
      flushTab(tab.file.path);           // no-ops unless dirty; captures synchronously
      clearPdfRenderData(tab.file.path);
      clearNotebookRenderData(tab.file.path);
    }
    // Those flushes captured what they needed synchronously (see flushTab); the
    // paths themselves index the vault being left.
    assetRefsRef.current.clear();
    setTabs([]);
    setLayout(EMPTY_LAYOUT);
    setSaveStatus('');
    setPendingReveal(null);
    // The workspace on screen is no longer ANY vault's session — least of all
    // this empty one's. Only the handle ref is released: clearing the id ref too
    // would let the restore pass claim on this very commit, where
    // `currentVaultId` is still the OUTGOING vault's, and open the old vault's
    // paths out of the new vault's tree. Without this, persistence is gated only
    // by `rootHandle` never being the same OBJECT twice — and it can be, since
    // the vault menu re-mints its handles from `publishVaults`, which a
    // `recordVault` that failed after `setCurrentVaultId` never reaches. Coming
    // back to that vault by the same menu row then matched both refs and filed
    // this EMPTY layout under its id, destroying the session it was about to
    // restore. Gated instead, it merely does not restore that once.
    sessionRootRef.current = null;
    // The id ref is not cleared but RE-POINTED at the vault being left, which is
    // the only thing the restore pass's `=== currentVaultId` test can safely
    // mean. Leaving it holding whatever was last CLAIMED is not the same thing,
    // because a vault can set `currentVaultId` and never claim: the pass returns
    // above on an empty `fileTree`, and an empty FOLDER is indistinguishable
    // from a tree that has not landed yet. Measured — vault R with three tabs,
    // switch to an empty folder, switch back — the pass then claimed R's handle
    // against the EMPTY vault's id on the mid-switch commit, so the commit
    // carrying R's own id failed the handle test: R's tabs never came back and
    // nothing R did afterwards was persisted for the rest of the page load.
    sessionVaultIdRef.current = currentVaultIdRef.current;
  }, [rootHandle, flushTab]);

  // Search reads open-tab buffers through this accessor (via tabsRef) so its
  // results reflect unsaved edits without re-rendering the sidebar on typing.
  const getOpenTabContent = useCallback(
    (path: string) => tabsRef.current.find(t => t.file.path === path)?.content ?? null,
    []
  );

  /**
   * The address bar AS THE PAGE LOADED, captured once.
   *
   * Not re-read later: the URL writer further down rewrites the hash as the
   * app settles, and one render where a vault is open but the labelled list has
   * not caught up used to clear it — wiping the link before its note had been
   * opened. Reading a link that is being kept up to date is the mistake; the
   * instruction is what arrived, once. Declared here because its one reader is
   * the restore pass below.
   */
  const [initialLocation] = useState(readLocation);
  /** Consumed by the first vault this page restores (see the restore pass). */
  const linkPendingRef = useRef(true);

  // Auto-restore THIS VAULT'S tabs once its file tree has loaded — on a cold
  // start and on every switch back to it. The ONLY thing that opens documents
  // when a vault loads: the note a link names is folded in rather than opened
  // beside it, which raced this pass and cost the vault its tabs (see below).
  useEffect(() => {
    // Nothing to restore against yet — and NOTE that this return is above the
    // claim below, so a vault can set `currentVaultId` and never claim (an
    // empty folder walks to an empty tree, which is indistinguishable from one
    // that has not landed). That is why the switch effect re-points the id ref
    // at the vault being LEFT rather than leaving it on the last claim; see
    // there for what went wrong when it did not.
    if (!fileTree || fileTree.length === 0) return;
    // Both halves must have moved on: see sessionRootRef's note above. Equal on
    // either one means this commit is mid-switch (openVaultHandle commits the
    // tree before recordVault sets the id) or this vault has already been
    // restored — and restoring against the wrong pairing opens whichever of the
    // other vault's files happen to sit at these paths. That is the same hazard
    // the vault-switch effect exists to prevent, arriving by another road.
    if (sessionRootRef.current === rootHandle) return;
    if (sessionVaultIdRef.current === currentVaultId) return;
    // WAIT for the id rather than claim against its absence. Two paths —
    // openVaultHandle (and openRecentVault, only a wrapper over it) and
    // pickDirectory — commit the tree and only THEN await recordVault, while
    // the mount path and restoreVault record FIRST and walk after (which is why
    // an ordinary reload always looked fine). So the first vault of a page load
    // opened through the picker or the vault menu arrives
    // with `currentVaultId` still at its initial null; claiming here would mark
    // the workspace as that vault's and make the very next commit, the one
    // carrying the real id, fail the `sessionRootRef.current === rootHandle`
    // test above — the vault's session silently never restored. A vault whose
    // recordVault genuinely FAILED gets no session either way, which is the
    // intent: on the first vault of a load it keeps the null id and stops here;
    // on a later switch `currentVaultId` is left naming the OUTGOING vault, and
    // the id test above stops it instead. Persistence is not left un-gated by
    // the wait, because its own first line is the same check.
    if (!currentVaultId) return;
    // Claimed before every remaining early return — and before any await, since
    // StrictMode runs this effect twice — because persistence stays gated until
    // this pass has run, and a vault with nothing stored must still un-gate it.
    // The old `hasRestoredTabs` rule, per vault. (The `fileTree` return at the
    // top is the one that precedes it, deliberately: see there.)
    sessionRootRef.current = rootHandle;
    sessionVaultIdRef.current = currentVaultId;
    // Every claim starts with persistence open: a pass still reading an earlier
    // vault's files must not hold this one's gate — a vault with nothing to
    // read would otherwise persist nothing until that pass finished.
    restoringRef.current = null;
    const vaultFiles = collectFiles(fileTree);

    // The note the address bar names, when it belongs HERE. Consumed at the
    // claim, so it applies to the first vault this page restores and never
    // again on a later switch back to it. Resolved through the same
    // findLinkedVault FileSystemContext picked the vault with, so the two
    // agree: an unknown name that fell back to the last-used vault, another
    // vault chosen from the "Open 'X'" screen, or a hash naming no vault at all
    // opens that vault as it was left — the old opener instead opened the
    // link's path out of whichever vault loaded, if a file happened to sit
    // there. (The one blur: two known vaults sharing the link's name, with no
    // id suffix to part them — the link names both, and which it resolves to
    // here follows the list's order at this claim.) Text and PDF only,
    // handleFileClick's own test for "opens as a tab": anything else would be
    // a window.open on page load.
    const link = linkPendingRef.current ? initialLocation : null;
    linkPendingRef.current = false;
    const linkedNode = link?.file && findLinkedVault(link.vault, recentVaults)?.id === currentVaultId
      ? vaultFiles.find(f => f.path === link.file && (isTextFile(f.name) || isPdfFile(f.name)))
      : undefined;

    // Read the session WHOLE and synchronously, before the file reads below
    // yield: the refs just claimed are what the persist effect checks, so a
    // value read after the awaits could already have been rewritten — and the
    // split would come back silently flattened. restoringRef now also shuts
    // persistence for the reads, but deciding the whole restore from one
    // snapshot is what makes that unreachable rather than merely unreached.
    const stored = readSession(currentVaultId);
    // A linked note the session does not hold joins it at the end, like any
    // newly opened note — restoreLayout gives a path no stored group accounts
    // for a tab of its own. An empty `paths` is a real session ("I closed
    // everything here"); there is simply nothing of its own to open for it. A
    // Set, because a path listed twice (a hand-edited record) would mint two
    // tabs for one document — restoreLayout dedupes the layout, not the tabs.
    const paths = stored ? [...new Set(stored.paths)] : [];
    if (linkedNode && !paths.includes(linkedNode.path)) paths.push(linkedNode.path);
    if (paths.length === 0) return;

    // Persistence stays shut from here until the merge is dispatched — see
    // restoringRef. Released in `finally` too, so no exit leaves it shut.
    const token = {};
    restoringRef.current = token;
    const release = () => { if (restoringRef.current === token) restoringRef.current = null; };
    (async () => {
      try {
        const restored: OpenTab[] = [];
        for (const path of paths) {
          if (path === 'help-guide') {
            restored.push({ id: newTabId(), file: { name: 'Help Guide', isHelp: true, path }, content: HELP_DOC_CONTENT, mode: 'read', dirty: false });
            continue;
          }
          const node = vaultFiles.find(f => f.path === path);
          if (!node) continue; // file deleted/moved externally — skip it
          try {
            // Mirror handleFileClick: a PDF's buffer holds its tldraw snapshot
            // (PdfPane reads the bytes itself) — decoding a PDF as UTF-8 would
            // fill the buffer with garbage.
            const content = isPdfFile(node.name) ? '' : await readFile(node.handle as FileSystemFileHandle);
            restored.push({ id: newTabId(), file: node, content, mode: 'read', dirty: false });
          } catch (err) {
            console.error('Failed to restore tab:', path, err);
          }
        }
        // Nothing of the session came back (every note in it deleted since, or
        // unreadable) and nothing was opened meanwhile: the stored session is
        // left as it was. Something that WAS opened still goes through the
        // merge, with nothing to lay it over — the gate held its write back, and
        // the merge's new layout is the only thing that will write it now.
        if (restored.length === 0 && layoutRef.current.groups.length === 0) return;
        // The reads above yield to the event loop: the vault may have been
        // switched in the meantime, and the switch effect empties the tab set,
        // so the merge below would drop the OLD vault's notes (handles and all)
        // into the new vault's workspace. The HANDLE is checked as well as the
        // id, and it is the half that catches it: `currentVaultId` lags
        // `rootHandle` by a commit, so a switch whose reads land in that window
        // passes an id test comparing the outgoing id with itself (measured:
        // with a 600ms-per-file read, switching away mid-restore put vault A's
        // three tabs on screen over vault B's tree, autosaving through A's
        // handles).
        if (rootHandleRef.current !== rootHandle) return;
        if (currentVaultIdRef.current !== currentVaultId) return;
        // Asset baselines (see handleFileClick) only now that the workspace is
        // known to still be this vault's: seeded during the reads, a switch
        // mid-restore left the old vault's in the map the switch had just
        // cleared. A document already open keeps the baseline its own open took
        // — asked of the map itself, which every open of an asset-tracking
        // document seeds before its setTabs and every close clears, not of
        // tabsRef, which only catches up once a commit's effects have run.
        // (tracksAssets keeps help, PDFs, drawings and notebooks out of the map
        // entirely, so for those this is a no-op whichever way the test goes.)
        for (const tab of restored) {
          if (!assetRefsRef.current.has(tab.file.path)) rememberAssetRefs(tab.file, tab.content);
        }
        // Which of these shared a tab as split panes. A session written before
        // split tabs existed has no record of it, and restoreLayout gives every
        // document a tab of its own — exactly what used to happen. The link is
        // an instruction and the session only a default, so the link's note is
        // what comes to the front — when it actually came back. Built out here,
        // not in an updater, because StrictMode runs updaters twice.
        const restoredPaths = restored.map(t => t.file.path);
        const restoredLayout = restoreLayout(
          restoredPaths,
          stored?.groups,
          stored?.focus,
          stored?.sizes,
          linkedNode && restoredPaths.includes(linkedNode.path) ? linkedNode.path : stored?.active ?? null,
        );
        // Anything opened while the reads were in flight — a click in the file
        // tree — is MERGED, never deferred to. Deferring is what turned
        // 5de752e's separate link opener into data loss: it opened the linked
        // note a moment before these reads finished, this pass saw a tab and
        // gave up, and since the refs were already claimed the persist effect
        // filed that one tab as the vault's whole session (measured: four
        // documents in three tabs, one a 65/35 split, came back from a reload as
        // the one tab the address bar named, with the stored `paths` rewritten
        // from four to that one — so every reload after it restored nothing more
        // either). The saved tabs come first, as they were left; what was opened
        // follows (mergeLayouts), keeping the focus; and a document open on both
        // sides keeps its in-memory tab, which may hold edits. The gate opens
        // BEFORE the merge is dispatched, so the commit carrying it writes the
        // session. One ordering still writes a lone tab first: a click that
        // committed just before this line, its effects not yet run, has them
        // flushed ahead of the merge's render — one tab stored for the task or
        // two until the merge's own write. flushSync would close that, but it
        // warns on the path that never awaits (this block then runs inside the
        // effect), and only a reload landing in that gap could cost anything.
        release();
        setTabs(prev => {
          const open = new Set(prev.map(t => t.file.path));
          return [...restored.filter(t => !open.has(t.file.path)), ...prev];
        });
        setLayout(prev => mergeLayouts(restoredLayout, prev));
      } finally {
        release();
      }
    })();
  }, [fileTree, rootHandle, currentVaultId, readFile, rememberAssetRefs, recentVaults, initialLocation]);

  // A vault taken off the recent list (the minus in the vault menu) mints a new
  // id if it is ever opened again, so its stored session would be unreachable
  // weight. Nothing prunes by staleness — a vault returned to a year later
  // still opens where it was left, the same call fileScrollPositions makes.
  // "Has the list ever loaded" rather than "is it empty now", because those are
  // not the same question and an emptiness test answers the wrong one: forgetting
  // the LAST row is a real transition to zero, and skipping it left that vault's
  // session behind forever — the one case where the help doc's "taking a vault
  // off that list forgets its tabs" was false. (Reachable because the open
  // vault's row has no minus, so a single removable row means the open vault is
  // absent from the list, which is what a failed `recordVault` leaves behind.)
  const sawVaultList = useRef<boolean>(false);
  useEffect(() => {
    if (recentVaults.length > 0) sawVaultList.current = true;
    if (!sawVaultList.current) return;   // the list has not loaded yet
    pruneSessions(recentVaults.map(v => v.id));
  }, [recentVaults]);

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
    const kinds = { pdf: false, drawing: false, notebook: false };
    for (const file of collectFiles(fileTree)) {
      if (isPdfFile(file.name)) kinds.pdf = true;
      else if (isNotebookFile(file.name)) kinds.notebook = true;
      else if (isCanvasFile(file.name)) kinds.drawing = true;
      if (kinds.pdf && kinds.drawing && kinds.notebook) break;
    }
    prefetchPanes(kinds);
  }, [fileTree]);

  /**
   * Keep the address bar describing what is open, so it can be copied at any
   * moment as a link back here.
   *
   * The vault is named rather than identified wherever it can be — a link is
   * something a person reads and types — and only carries an id suffix when two
   * known vaults share a folder name. See utils/appUrl.ts for why a link cannot
   * carry a path on disk, which is the thing it would obviously want to.
   */
  useEffect(() => {
    const vault = recentVaults.find(v => v.id === currentVaultId);
    if (!vault) {
      // Two reasons there may be no vault to name, and neither is a reason to
      // clear the hash. Before a vault is open, the link is what the "Open 'X'"
      // button is about to act on. And `currentVaultId` is set by recordVault
      // BEFORE the tree walk, so "an id but no entry in the list" is one
      // transient render while the labelled list catches up — clearing there
      // wiped the link mid-open, and the file it named never got opened.
      if (!rootHandle || currentVaultId) return;
      writeLocation({});
      return;
    }
    writeLocation({
      vault: vaultLinkName(vault, recentVaults),
      // The help guide is not a file in the vault, so it has no link.
      file: activeFile && !activeFile.isHelp ? activeFile.path : undefined,
    });
  }, [rootHandle, currentVaultId, recentVaults, activeFile]);

  const handleHelpClick = useCallback(() => {
    const path = 'help-guide';
    if (tabsRef.current.some(t => t.file.path === path)) {
      setLayout(l => focusTab(l, path));
      return;
    }
    setTabs(prev => prev.some(t => t.file.path === path) ? prev : [...prev, {
      id: newTabId(),
      file: { name: 'Help Guide', isHelp: true, path },
      content: HELP_DOC_CONTENT,
      mode: 'read',
      dirty: false,
    }]);
    setLayout(l => openTabIn(l, path));
    setSaveStatus('');
  }, []);

  const handleCreateFile = useCallback(async (parentHandle: FileSystemDirectoryHandle | null, name: string, parentPath = '') => {
    const where = parentPath || parentHandle?.name || 'this folder';
    try {
      // Nothing here overwrites a file by accident — the rule the rest of the
      // app keeps with freeEntryName, kept here with a refusal instead,
      // because the user named this file and silently getting "note (1).md"
      // is not what they asked for either.
      if (parentHandle && await nameTaken(parentHandle, name)) {
        await tell({
          title: 'That name is taken',
          confirmLabel: 'OK',
          body: <><strong>{name}</strong> already exists in <code>{where}</code>. Nothing was created — pick another name, or open the one that is there.</>,
        });
        return;
      }
      const newFileHandle = await createFile(parentHandle!, name);
      // Auto-open the newly created file straight into edit mode. Build the path
      // to match buildFileTree's convention (vault-root-relative, no vault-name
      // prefix) so the tab dedups / highlights / restores correctly.
      if (newFileHandle) {
        const newPath = joinVaultPath(parentPath, name);
        const newNode: FileTreeFileNode = {
          name,
          handle: newFileHandle,
          parentHandle: parentHandle!,
          kind: 'file',
          path: newPath,
        };
        await handleFileClick(newNode);
        setTabs(prev => prev.map(t => t.file.path === newPath ? { ...t, mode: 'edit' } : t));
      }
    } catch (err) {
      // Said out loud, not only logged: from the sidebar a create that failed
      // is indistinguishable from one that worked and left the tree alone.
      console.error('Failed to create file:', err);
      await tell({
        title: 'Could not create the note',
        confirmLabel: 'OK',
        body: <><strong>{name}</strong> could not be created in <code>{where}</code>.</>,
      });
    }
  }, [createFile, handleFileClick, tell]);

  const handleCreateFolder = useCallback(async (parentHandle: FileSystemDirectoryHandle | null, name: string) => {
    const where = parentHandle?.name || 'this folder';
    try {
      // createFolder is create-or-open like createFile, so an existing folder
      // would silently be "created" and the reader would be looking at
      // somebody else's notes inside it.
      if (parentHandle && await nameTaken(parentHandle, name)) {
        await tell({
          title: 'That name is taken',
          confirmLabel: 'OK',
          body: <><strong>{name}</strong> already exists in <code>{where}</code>. Nothing was created.</>,
        });
        return;
      }
      await createFolder(parentHandle!, name);
    } catch (err) {
      console.error('Failed to create folder:', err);
      await tell({
        title: 'Could not create the folder',
        confirmLabel: 'OK',
        body: <><strong>{name}</strong> could not be created in <code>{where}</code>.</>,
      });
    }
  }, [createFolder, tell]);

  /**
   * Open a folder in the tree as the vault — the file tree's "Open as Vault"
   * row, and the same switch as picking that folder in the OS picker.
   *
   * Nothing is flushed or closed here: setting `rootHandle` is what makes this a
   * vault switch, and the switch effect above already flushes every open tab
   * (its handles are still good) before emptying the workspace. Every failure is
   * said out loud, because from the sidebar a switch that did not happen is
   * indistinguishable from one that did and found an empty folder — the rule
   * VaultMenu.messageFor states for the vault list.
   *
   * ONE AT A TIME. Two switches in flight are two vault walks racing, and the
   * one that FINISHES last wins the tree — which can be the one that started
   * FIRST, leaving the sidebar on vault A while `rootHandle`, IndexedDB and
   * `currentVaultId` all say vault B. The tree is where that is easiest to
   * start: setRootHandle lands early, but the OLD vault's rows stay on screen
   * until the new walk finishes — seconds on a big vault — so the folder just
   * right-clicked is still sitting there, still offering the row.
   *
   * Racing a DIFFERENT raiser is the provider's `switchInFlightRef`, which is
   * why 'busy' is not an error here. This ref covers the two things that gate
   * cannot: a second click on the tree, and the dialog below — which, like
   * handleTrash's, must not have a second question stacked behind it.
   */
  const openAsVaultInFlightRef = useRef<boolean>(false);

  const handleOpenAsVault = useCallback(async (node: FileTreeNode) => {
    if (node.kind !== 'directory') return;
    if (openAsVaultInFlightRef.current) return;
    openAsVaultInFlightRef.current = true;
    try {
      const result = await openFolderAsVault(node.handle);
      // 'busy' is another raiser's switch still walking, not a failure — the
      // ref above only covers a second click on the TREE. The vault menu says
      // so inline; a tree row has nowhere to put a note, and a modal for "not
      // yet" would be louder than the thing it reports, so here it stays silent.
      if (result === 'ok' || result === 'busy') return;
      await tell({
        title: 'Could not open that folder as a vault',
        confirmLabel: 'OK',
        body: result === 'denied'
          ? <>Permission to read and write <strong>{node.name}</strong> was refused.</>
          : result === 'missing'
            ? <><strong>{node.name}</strong> is no longer on disk.</>
            : <><strong>{node.name}</strong> could not be opened.</>,
      });
    } finally {
      openAsVaultInFlightRef.current = false;
    }
  }, [openFolderAsVault, tell]);

  /**
   * Move a file — or a whole folder, contents and all — to the Trash.
   *
   * A folder takes every document open from anywhere INSIDE it with it, which
   * is the whole difference from deleting one file. Left open, those tabs go on
   * drawing notes that no longer exist, holding handles that resolve to nothing,
   * and are written back into the stored session on the next layout change.
   *
   * ONE AT A TIME, and everything pending is written out FIRST. Both follow from
   * the same fact: unlike every other deletion in this app, trashing a folder is
   * a copy of arbitrary size, and it runs for as long as that takes. See below.
   */
  const trashInFlightRef = useRef<boolean>(false);

  const handleTrash = useCallback(async (node: FileTreeNode) => {
    // A folder copy runs for seconds, and its row stays on screen throughout —
    // so "I clicked delete and nothing happened, click it again" is the natural
    // thing to do, and unguarded it ran two copies at once: one completed, the
    // other was abandoned half-written when the source vanished under it, and
    // the loser's `alert` then told the user a deletion that had SUCCEEDED had
    // failed. Same shape, same reason, as pickDirectory's pickerOpenRef.
    //
    // It covers the QUESTION as well as the copy, which `confirm()` used to get
    // for free by freezing the page: the app's own dialog does not block, so
    // without this a second click would stack a second question behind the
    // first. (The overlay stops the pointer reaching the tree either way; this
    // is what stops anything else from.)
    if (trashInFlightRef.current) return;
    trashInFlightRef.current = true;
    try {
      const isFolder = node.kind === 'directory';
      // Which open documents this takes. A folder's own path is never a
      // document's — except that the Help guide's pseudo-path is a bare name, so
      // a vault folder called "help-guide" closed the Help tab. Only a FILE is
      // matched by equality; a folder is matched by the `path/` prefix and
      // nothing else.
      const doomed = isFolder
        ? (path: string) => path.startsWith(`${node.path}/`)
        : (path: string) => path === node.path;

      // Say what is actually going. "…and everything inside it" reads the same
      // for two notes as for two thousand, and is plainly wrong for an empty one.
      const files = node.kind === 'directory' ? collectFiles(node.children).length : 0;
      const beside = <>the <code>.Garbage</code> folder beside it</>;
      const confirmed = await ask({
        title: isFolder ? 'Move folder to Trash?' : 'Move to Trash?',
        confirmLabel: 'Move to Trash',
        danger: true,
        body: files > 0 ? (
          <>
            <strong>{node.name}</strong> and the {files} file{files === 1 ? '' : 's'} inside it move
            into {beside} — sub-folders, pictures and its own trash included. Notes you have open
            from it are saved first, then closed. Nothing leaves your disk: you can take it all
            back out whenever you like.
          </>
        ) : (
          <>
            <strong>{node.name}</strong> moves into {beside}. Nothing leaves your disk: you can
            take it back out whenever you like.
          </>
        ),
      });
      if (!confirmed) return;

      // Write out what is still in the save debounce BEFORE the copy starts.
      // The tabs inside a folder stay live and editable for the whole copy, and
      // their save timers stay armed — so a debounced write would land on an
      // original that `removeEntry` then destroys, AFTER the walk had already
      // copied the older bytes. Whether the edit survived came down to where the
      // note happened to fall in an arbitrary `entries()` order. Flushed rather
      // than merely cancelled: the copy then carries the reader's last words,
      // which is what a trash folder is for.
      await Promise.all(tabsRef.current
        .filter(t => doomed(t.file.path))
        .map(t => flushTab(t.file.path)));
      // …and let the asset reconciles those saves queued run to completion, so
      // nothing moves a picture between `.Assets` and `.Garbage/.Assets` while
      // copyDirRecursive is walking one of them.
      await reconcileQueueRef.current;

      // The copy has no other outward sign, and an app that looks frozen is one
      // people click again. Re-armed over any "Saved" the flush above left, whose
      // own timer would otherwise clear this line mid-copy.
      if (saveStatusTimerRef.current) {
        clearTimeout(saveStatusTimerRef.current);
        saveStatusTimerRef.current = null;
      }
      setSaveStatus(`Moving "${node.name}" to Trash…`);

      const moved = await moveToTrash(node);
      setSaveStatus('');
      if (!moved) {
        // Never silence: from the outside a click that does nothing is
        // indistinguishable from a broken button. And the reassurance is worth
        // as much as the failure — the move is all-or-nothing, so there is no
        // half-deleted state to go looking for.
        await tell({
          title: 'Nothing was moved',
          confirmLabel: 'OK',
          body: (
            <>
              <strong>{node.name}</strong> is still where it was, and nothing was left half-done.
              Something inside it may be in use; the details are in the browser console. Try again
              in a moment.
            </>
          ),
        });
        return;
      }

      // A trashed row's icon and colour go with it, and a folder's takes
      // everything inside it — otherwise the entry sits in the file forever, and
      // something later given the same name inherits a look nobody chose.
      const remaining = forgetEntry(getEntryStyles(), node.path);
      if (remaining !== getEntryStyles()) void writeEntryStyles(remaining);

      // What the deletion took with it. Read AFTER the move, not before: the
      // predicate is a path test and does not move, but a document opened while
      // the copy was running has to be closed too.
      // Closed WITHOUT flushing — that already happened above, and their handles
      // are gone now.
      for (const tab of tabsRef.current) {
        if (doomed(tab.file.path)) removeTab(tab.file.path, false);
      }
    } finally {
      trashInFlightRef.current = false;
    }
  }, [moveToTrash, removeTab, flushTab, ask, tell, writeEntryStyles]);

  /* ── The Trash bin ──────────────────────────────────────────────────────
   * The panel draws the list and owns nothing else: every one of these asks
   * the question, takes the SAME in-flight ref `handleTrash` does, and drains
   * the asset-reconcile queue first.
   *
   * The shared ref is deliberate. All four are copy-then-delete over the same
   * vault, so two at once is the abandoned-half-written-copy hazard
   * handleTrash documents — and the guard has to cover the QUESTION as well as
   * the copy, because only one dialog fits on screen: a second `ask` raised
   * while one is up leaves the first promise unresolved for the session.
   * Draining `reconcileQueueRef` matters for the same reason it does there —
   * a retire may be moving a picture between `.Assets` and `.Garbage/.Assets`
   * at that moment, which is exactly what the bin is reading and writing.
   * ─────────────────────────────────────────────────────────────────────── */

  /** Put one trashed item back beside the `.Garbage` it was found in. */
  const handleTrashRestore = useCallback(async (item: TrashItem): Promise<TrashRestoreResult> => {
    if (trashInFlightRef.current) return { status: 'error' };
    trashInFlightRef.current = true;
    try {
      await reconcileQueueRef.current;
      // Where the clash actually is — a retired picture goes back INSIDE that
      // folder's `.Assets`, so naming the folder itself would send the reader
      // looking at the wrong one.
      const where = item.origin === 'retired'
        ? joinVaultPath(item.restorePath, ASSETS_DIR)
        : (item.restorePath || 'the vault root');
      // Which open documents a 'replace' would take with it: the entry standing
      // at the destination name, and — when that entry is a FOLDER — every
      // document open from inside it. Both, by one prefix test, because App
      // cannot know which kind is in the way until the copy resolves it, and a
      // file has no children for the `/` branch to match anyway. A retired
      // picture's destination is `.Assets`, which nothing opens as a tab. The
      // Help guide is excluded: its pseudo-path is a bare name (`help-guide`),
      // so a vault folder of that name would otherwise close it.
      const taken = item.origin === 'retired' ? null : joinVaultPath(item.restorePath, item.name);
      const doomed = (tab: typeof tabsRef.current[number]) =>
        !!taken && !tab.file.isHelp &&
        (tab.file.path === taken || tab.file.path.startsWith(`${taken}/`));
      // Asked for without permission to overwrite: a taken name comes back as
      // a collision with nothing touched, and the reader decides.
      let result = await restoreFromTrash(item, 'auto');

      if (result.status === 'collision') {
        const choice = await askChoice({
          title: 'That name is taken',
          confirmLabel: 'Replace',
          altLabel: 'Keep both',
          danger: true,
          body: (
            <>
              {/* `where` is a real path everywhere except one case — a file
                  trashed from the vault root — where it is prose, and prose set
                  in monospace reads as a folder nobody has. */}
              {item.restorePath || item.origin === 'retired' ? <code>{where}</code> : 'The vault root'}
              {' '}already holds something called <strong>{item.name}</strong>.
              Replacing it moves what is there now into that folder’s own <code>.Garbage</code> —
              it will be waiting here in the Trash, not erased. Keeping both puts this one back
              under a numbered name.
            </>
          ),
        });
        if (choice === 'cancel') return { status: 'collision' };

        if (choice === 'confirm') {
          // Write out what is still in the save debounce, so the copy that gets
          // displaced into `.Garbage` carries the reader's last words rather
          // than the disk's — handleTrash's reason, and its ordering.
          await Promise.all(tabsRef.current.filter(doomed).map(t => flushTab(t.file.path)));
          // …and re-drain the reconcile queue: the question above took real time,
          // and a retire can have queued a picture move into the very
          // `.Garbage/.Assets` a retired put-back is about to read.
          await reconcileQueueRef.current;
        }
        result = await restoreFromTrash(item, choice === 'confirm' ? 'replace' : 'keep-both');
        // The displaced entry's bytes have just moved into `.Garbage`, and every
        // tab that was open from it still holds a handle resolving to that
        // DIRECTORY ENTRY — which the restored copy now occupies. Left open,
        // the next keystroke in one of them writes the displaced bytes straight
        // over the note that was just put back (measured: putting a trashed
        // `homework` back over a live one restored its `hw1.md`, and one
        // keystroke in the still-open tab turned it back into the live file's
        // text). releaseOverwritten's hazard exactly. Closed WITHOUT flushing —
        // that already happened above, before the copy.
        if (choice === 'confirm' && result.status === 'ok') {
          for (const tab of tabsRef.current) if (doomed(tab)) removeTab(tab.file.path, false);
          // The displaced entry's icon and colour go into the Trash with it, or
          // the item that just took its path inherits a look nobody chose —
          // handleTrash's reason for forgetting them at trash time.
          if (taken) {
            const remaining = forgetEntry(getEntryStyles(), taken);
            if (remaining !== getEntryStyles()) void writeEntryStyles(remaining);
          }
        }
      }

      if (result.status === 'error') {
        await tell({
          title: 'Nothing was put back',
          confirmLabel: 'OK',
          body: (
            <>
              <strong>{item.name}</strong> is still in the Trash, and nothing was left half-done.
              The details are in the browser console. Try again in a moment.
            </>
          ),
        });
        return result;
      }

      if (result.status === 'ok') {
        // A numbered rename must never be silent — "Keep both" says there will
        // be a number, not what it is. Re-armed over any pending "Saved", the
        // way handleTrash re-arms it.
        if (result.name !== item.name) {
          if (saveStatusTimerRef.current) clearTimeout(saveStatusTimerRef.current);
          setSaveStatus(`Put back as “${result.name}”`);
          saveStatusTimerRef.current = setTimeout(() => setSaveStatus(''), 4000);
        }
      }
      return result;
    } finally {
      trashInFlightRef.current = false;
    }
  }, [restoreFromTrash, askChoice, tell, removeTab, flushTab, writeEntryStyles]);

  /** Erase one trashed item. One of the app's two points of no return. */
  const handleTrashDelete = useCallback(async (item: TrashItem) => {
    if (trashInFlightRef.current) return false;
    trashInFlightRef.current = true;
    try {
      const confirmed = await ask({
        title: 'Delete for good?',
        confirmLabel: 'Delete permanently',
        danger: true,
        body: (
          <>
            <strong>{item.name}</strong>{item.kind === 'directory' ? ' and everything inside it' : ''} is
            erased from your disk. This is one of the only two things in this app that cannot be
            undone — there is no second copy anywhere.
          </>
        ),
      });
      if (!confirmed) return false;

      await reconcileQueueRef.current;
      const done = await deleteFromTrash(item);
      if (!done) {
        await tell({
          title: 'Nothing was deleted',
          confirmLabel: 'OK',
          body: (
            <>
              <strong>{item.name}</strong> is still in the Trash. Something inside it may be in use;
              the details are in the browser console.
            </>
          ),
        });
      }
      return done;
    } finally {
      trashInFlightRef.current = false;
    }
  }, [ask, tell, deleteFromTrash]);

  /** Erase every `.Garbage` in the vault. The other point of no return. */
  const handleTrashEmpty = useCallback(async (count: number) => {
    if (trashInFlightRef.current) return false;
    trashInFlightRef.current = true;
    try {
      const confirmed = await ask({
        title: 'Empty the Trash?',
        confirmLabel: 'Empty bin',
        danger: true,
        body: (
          <>
            All {count} item{count === 1 ? '' : 's'} here are erased from your disk, and so is
            every <code>.Garbage</code> folder in this vault — deleted notes, deleted folders, and
            pictures your notes stopped using. There is no second copy of any of it, and nothing
            brings it back.
          </>
        ),
      });
      if (!confirmed) return false;

      await reconcileQueueRef.current;
      const { removed, failed } = await emptyTrash();
      if (!removed && count > 0) {
        await tell({
          title: 'Nothing was deleted',
          confirmLabel: 'OK',
          body: <>The Trash is still where it was. The details are in the browser console.</>,
        });
        return false;
      }
      // Partly done is not done, and the panel would otherwise clear its list
      // and say the bin was empty while those folders still held their files.
      if (failed) {
        await tell({
          title: 'Some of it is still there',
          confirmLabel: 'OK',
          body: (
            <>
              {failed} folder{failed === 1 ? '' : 's'} would not empty — something inside may be in
              use. The rest is gone. Open the Trash again to see what is left; the details are in
              the browser console.
            </>
          ),
        });
        return false;
      }
      return true;
    } finally {
      trashInFlightRef.current = false;
    }
  }, [ask, tell, emptyTrash]);

  /** The bin's read-only preview of a trashed text file. */
  const handleTrashReadText = useCallback(
    (item: TrashItem) => readFile(item.handle as FileSystemFileHandle), [readFile]);

  /** The bytes behind the bin's picture preview. Here rather than in the panel
   *  so no component calls the File System Access API itself (AGENTS.md). The
   *  cast is sound for the same reason `handleTrashReadText`'s is: the crawl only
   *  ever hands a file handle to an item whose `kind` is 'file', and the preview
   *  asks for nothing else. */
  const handleTrashReadFile = useCallback(
    (item: TrashItem) => (item.handle as FileSystemFileHandle).getFile(), []);

  /**
   * Follow every open document through a rename or a move.
   *
   * For a file that is the file itself. For a FOLDER it is every document open
   * from anywhere INSIDE it, which is the case that used to be missing entirely:
   * the old code looked for a tab at the folder's own path, never found one, and
   * returned. So renaming a folder left its notes open on paths that no longer
   * existed, holding handles into a directory that had just been removed —
   * every later keystroke logged "Auto-save failed" and went nowhere, the tree
   * highlighted nothing, and the stored session named a file that was gone. The
   * documents are the same documents; they are re-pointed, not closed.
   *
   * Handles come from walking down from the VAULT ROOT rather than out of the
   * file tree, because the tree is React state and this runs after an await —
   * the refresh the rename triggered may not have been committed yet, and this
   * has to be exact rather than probably-current.
   */
  const retargetTabs = useCallback(async (node: FileTreeNode, newPath: string) => {
    if (!rootHandle || newPath === node.path) return;
    const isFolder = node.kind === 'directory';
    const prefix = `${node.path}/`;
    /** Where a path under `node` ends up. */
    const to = (path: string) => (isFolder ? newPath + path.slice(node.path.length) : newPath);

    // Every open document this move carries…
    const moving = tabsRef.current
      .filter(t => (isFolder ? t.file.path.startsWith(prefix) : t.file.path === node.path))
      .map(t => ({ from: t.file.path, to: to(t.file.path), dirty: t.dirty }));

    // …and every open document it OVERWRITES. renameFile/moveFile deliberately
    // land on a taken name, and for a folder that is a MERGE: each file inside
    // it overwrites whatever sat at its destination. The tab holding that
    // destination has to be released whether or not the file replacing it is
    // itself open — its handle still resolves to that very directory entry, so
    // its autosave would put the old bytes straight back over the new ones.
    // Read from the node's own children, the last description of the folder
    // before it moved, and done for ALL of them BEFORE the re-keys below (see
    // releaseOverwritten for why that order is load-bearing).
    // Icons and colours are keyed by vault path — a file's as much as a
    // folder's, and a folder's carries everything inside it — so a rename
    // strands every one of them on a path nothing has any more. Done for the
    // node itself, not per open tab: a file nobody has open still has a look.
    const restyled = renameEntry(getEntryStyles(), node.path, newPath);
    if (restyled !== getEntryStyles()) void writeEntryStyles(restyled);

    const open = new Set(tabsRef.current.map(t => t.file.path));
    const sources = isFolder ? collectFiles(node.children).map(f => f.path) : [node.path];
    for (const source of sources) {
      const dest = to(source);
      if (open.has(dest)) releaseOverwritten(dest, source);
    }

    for (const { from, to: dest, dirty } of moving) {
      try {
        const { handle, parentHandle } = await resolveVaultFile(rootHandle, dest);
        clearSaveTimer(from);          // cancel any save pending against the OLD handle
        // An annotated PDF's parked original + overlays are keyed by path; re-key
        // them or the next save finds nothing and silently writes nothing.
        movePdfRenderData(from, dest);
        // Same trap, same fix: an exporter left under the old path means Export
        // to PDF on the renamed notebook silently finds nothing.
        moveNotebookRenderData(from, dest);
        moveAssetRefs(from, dest);
        setTabs(prev => prev
          .filter(t => t.file.path !== dest)
          .map(t => t.file.path === from
            // `handle.name` covers both: a renamed file takes its new name, and
            // a file carried along by its folder keeps the one it had.
            ? { ...t, file: { ...t.file, name: handle.name, path: dest, handle, parentHandle } }
            : t));
        // The tab bar indexes documents by path too — a pane left pointing at
        // the old one would have no document to draw.
        setLayout(l => renamePath(l, from, dest));
        // Buffered edits go to the NEW handle, never the old one. They are not
        // in the copy the rename made: that read the file from disk.
        if (dirty) scheduleSave(dest);
      } catch (err) {
        console.error('Could not follow a document to its new path:', from, '→', dest, err);
      }
    }
  }, [rootHandle, clearSaveTimer, scheduleSave, moveAssetRefs, releaseOverwritten, writeEntryStyles]);

  /**
   * Keep the tree's disclosure state with the folder it describes.
   *
   * `expandedPaths` is keyed by path, so a renamed folder — and everything the
   * reader had opened up inside it — silently collapsed, which after a rename
   * looks like the contents went somewhere. It is the same folder; it answers
   * to a new name.
   */
  const retargetExpanded = useCallback((node: FileTreeNode, newPath: string) => {
    if (node.kind !== 'directory' || newPath === node.path) return;
    setExpandedPaths(prev => {
      const prefix = `${node.path}/`;
      const next = new Set<string>();
      let moved = false;
      for (const path of prev) {
        if (path === node.path || path.startsWith(prefix)) {
          next.add(newPath + path.slice(node.path.length));
          moved = true;
        } else {
          next.add(path);
        }
      }
      if (!moved) return prev;
      writeJSON('expandedPaths', [...next]);
      return next;
    });
  }, []);

  const handleRenameFile = useCallback(async (node: FileTreeNode, newName: string) => {
    const success = await renameFile(node, newName);
    if (!success) return;
    const newPath = joinVaultPath(parentVaultPath(node.path), newName);
    retargetExpanded(node, newPath);
    await retargetTabs(node, newPath);
  }, [renameFile, retargetTabs, retargetExpanded]);

  // Wrap moveFile so a moved document's tab tracks its new path and handle —
  // including every document inside a moved FOLDER.
  const handleMoveFile = useCallback(async (sourceNode: FileTreeNode, targetDirHandle: FileSystemDirectoryHandle, targetPath = '') => {
    const success = await moveFile(sourceNode, targetDirHandle);
    if (success) {
      const newPath = joinVaultPath(targetPath, sourceNode.name);
      retargetExpanded(sourceNode, newPath);
      await retargetTabs(sourceNode, newPath);
    }
    return success;
  }, [moveFile, retargetTabs, retargetExpanded]);

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (isCmdLetter(e, 's')) {
        e.preventDefault();
        flushTab(activeTabPathRef.current, true);
      }
      // Cmd+N — create new note in vault root
      if (isCmdLetter(e, 'n')) {
        e.preventDefault();
        if (rootHandle) {
          const name = prompt('New note name (e.g. "note.md"):');
          if (name) handleCreateFile(rootHandle, name, '');
        }
      }
      // Cmd+E — toggle read/edit mode of the active tab
      if (isCmdLetter(e, 'e')) {
        e.preventDefault();
        toggleTabMode(activeTabPathRef.current);
      }
      // Cmd+\ — collapse/expand the sidebar (Cmd+B is taken by bold)
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault();
        setSidebarCollapsed(c => !c);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [rootHandle, handleCreateFile, flushTab, toggleTabMode]);

  // Auto-save is handled per-tab by scheduleSave/flushTab (see above), so edits
  // to a background tab still persist even while another tab is active.

  // Drag-to-resize sidebar
  const startResize = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    isResizing.current = true;
    setIsDraggingSidebar(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return;
      const newWidth = Math.max(180, Math.min(600, e.clientX));
      setSidebarWidth(newWidth);
    };

    const onMouseUp = () => {
      isResizing.current = false;
      setIsDraggingSidebar(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, []);

  // Welcome screen
  if (!rootHandle && !isLoading) {
    return (
      <div className="welcome-screen">
        <div className="welcome-inner">
          <div className="welcome-icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
            </svg>
          </div>
          <h1 className="welcome-title">Markdown Editor</h1>
          {/* A link named a vault this browser knows, but the grant has lapsed.
              Browsers only let requestPermission ask from a user gesture, so
              the link cannot open itself — this button is that gesture. */}
          <p className="welcome-subtitle">
            {linkedVault
              ? <>This link opens <strong>{linkedVault.label}</strong>. Allow access to it to continue.</>
              : 'Open a vault to start editing your notes.'}
          </p>
          <div style={{ display: 'flex', gap: '12px', marginTop: '12px', flexWrap: 'wrap', justifyContent: 'center' }}>
            {linkedVault && (
              <button className="welcome-btn" style={{ margin: 0 }} onClick={openLinkedVault}>
                Open '{linkedVault.label}'
              </button>
            )}
            <button
              className="welcome-btn"
              style={linkedVault
                ? { margin: 0, background: 'var(--background-modifier-border)', color: 'var(--text-normal)' }
                : { margin: 0 }}
              onClick={pickDirectory}
            >
              Open Vault
            </button>
            {previousVault && (
              <button
                className="welcome-btn"
                style={{ margin: 0, background: 'var(--background-modifier-border)', color: 'var(--text-normal)' }}
                onClick={restoreVault}
              >
                Restore '{previousVault.name}'
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="welcome-screen">
        <div className="welcome-inner">
          <p className="welcome-subtitle">Loading vault...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="workspace">
      {sidebarCollapsed && (
        <div className="sidebar-rail">
          <button
            className="sidebar-rail-btn"
            onClick={() => setSidebarCollapsed(false)}
            title="Expand sidebar (⌘\)"
            aria-label="Expand sidebar"
          >
            <PanelLeft size={16} />
          </button>
        </div>
      )}
      <div
        className={`workspace-sidebar${sidebarCollapsed ? ' collapsed' : ''}${isDraggingSidebar ? ' resizing' : ''}`}
        style={{ width: sidebarCollapsed ? 0 : sidebarWidth }}
      >
        <FileExplorer
          rootHandle={rootHandle}
          fileTree={fileTree}
          onFileClick={handleFileClick}
          onCreateFile={handleCreateFile}
          onCreateFolder={handleCreateFolder}
          onChangeVault={pickDirectory}
          recentVaults={recentVaults}
          currentVaultId={currentVaultId}
          recentVaultLimit={recentVaultLimit}
          onOpenRecentVault={openRecentVault}
          onForgetRecentVault={forgetRecentVault}
          onCollapse={collapseSidebar}
          searchOpen={searchOpen}
          onCloseSearch={closeSearch}
          onTrash={handleTrash}
          onOpenAsVault={handleOpenAsVault}
          onStyleEntry={handleStyleEntry}
          expandedPaths={expandedPaths}
          onToggleExpand={handleToggleExpand}
          onMoveFile={handleMoveFile}
          onRenameFile={handleRenameFile}
          onImportFiles={importFiles}
          onOpenSearchResult={handleOpenSearchResult}
          getOpenTabContent={getOpenTabContent}
        />
        <div className="theme-toggle-container">
          <button
            className="theme-toggle-btn"
            onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
          >
            {theme === 'dark' ? (
              <>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5" /><line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" /><line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" /><line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" /><line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" /></svg>
                Switch to Light Mode
              </>
            ) : (
              <>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></svg>
                Switch to Dark Mode
              </>
            )}
          </button>
        </div>
        <div className="sidebar-bottom-actions">
          <button
            className={`theme-toggle-btn settings-btn${searchOpen ? ' active' : ''}`}
            onClick={() => setSearchOpen(open => !open)}
            aria-pressed={searchOpen}
            title="Search this vault — file names and contents"
          >
            <Search size={16} />
            Search
          </button>
          <button
            className={`theme-toggle-btn settings-btn${mainView === 'graph' ? ' active' : ''}`}
            onClick={() => setMainView(v => (v === 'graph' ? 'editor' : 'graph'))}
            title="Neural Brain — graph view"
          >
            {mainView === 'graph' ? <FileTextOutline size={16} /> : <Network size={16} />}
            {mainView === 'graph' ? 'Editor' : 'Neural Brain'}
          </button>
          <button
            className="theme-toggle-btn settings-btn"
            onClick={handleHelpClick}
            title="Help & Guide"
          >
            <HelpCircle size={16} />
            Help Guide
          </button>
          {/* The bin rides the Settings row rather than taking a row of its
              own: it is the one control down here with nothing to say in words,
              and a fifth full-width row of chrome for it would push the tree up
              for a button most sessions never press. The three rows above are
              deliberately untouched. */}
          <div className="sidebar-bottom-row">
            <button
              className="theme-toggle-btn settings-btn"
              onClick={() => setShowSettings(true)}
              title="Settings"
            >
              <Settings size={16} />
              Settings
            </button>
            <button
              className="tree-action-btn sidebar-trash-btn"
              onClick={() => setShowTrash(true)}
              title="Trash — everything deleted in this vault"
              aria-label="Trash"
              disabled={!rootHandle}
            >
              <Trash2 size={16} />
            </button>
          </div>
        </div>
      </div>
      {!sidebarCollapsed && <div className="workspace-resize-handle" onMouseDown={startResize} />}
      <div className="workspace-main">
        {mainView === 'graph' ? (
          <GraphView
            nodes={graph.nodes}
            links={graph.links}
            activeFilePath={activeFile?.path || null}
            onOpenNode={handleOpenNode}
            theme={theme}
          />
        ) : (
          <EditorPane
            tabs={tabs}
            layout={layout}
            theme={theme}
            tabSize={tabSize}
            saveStatus={saveStatus}
            onSelectGroup={selectTabGroup}
            onCloseGroup={closeTabGroup}
            onReorderGroups={reorderTabGroups}
            onMergeGroups={mergeTabGroups}
            onResizePanes={resizeTabPanes}
            onFocusPane={focusPane}
            onClosePane={closeTab}
            onSplitOffPane={splitOffPane}
            onToggleMode={toggleTabMode}
            onContentChange={updateTabContent}
            onFlushNow={flushTabNow}
            onOpenNotebookSource={handleOpenNotebookSource}
            onExportNotebook={handleExportNotebook}
            onOpenNote={openNoteByName}
            onNotify={notify}
            onConfirm={ask}
            graph={graph}
            onOpenNode={handleOpenNode}
            revealRequest={pendingReveal}
            onRevealHandled={handleRevealHandled}
          />
        )}
      </div>
      {showSettings && (
        <SettingsPanel
          editorFontSize={editorFontSize}
          treeFontSize={treeFontSize}
          editorPadding={editorPadding}
          tabSize={tabSize}
          fontFamily={fontFamily}
          caretStyle={caretStyle}
          caretThickness={caretThickness}
          smoothCaret={smoothCaret}
          caretSpeed={caretSpeed}
          accentColor={accentColor}
          codeBlockColor={codeBlockColor}
          recentVaultLimit={recentVaultLimit}
          onEditorFontSizeChange={setEditorFontSize}
          onTreeFontSizeChange={setTreeFontSize}
          onEditorPaddingChange={setEditorPadding}
          onTabSizeChange={setTabSize}
          onFontFamilyChange={setFontFamily}
          onCaretStyleChange={setCaretStyle}
          onCaretThicknessChange={setCaretThickness}
          onSmoothCaretChange={setSmoothCaret}
          onCaretSpeedChange={setCaretSpeed}
          onAccentColorChange={setAccentColor}
          onCodeBlockColorChange={setCodeBlockColor}
          onRecentVaultLimitChange={setRecentVaultLimit}
          onResetDefaults={handleResetDefaults}
          onClose={() => setShowSettings(false)}
        />
      )}
      {/* Over the workspace like Settings, and before ConfirmDialog for the
          same reason the menu is: nearly everything this panel does raises a
          question, and the dialog has to cover the panel that asked it. */}
      {showTrash && (
        <TrashPanel
          onClose={() => setShowTrash(false)}
          onCrawl={listTrash}
          onRestore={handleTrashRestore}
          onDelete={handleTrashDelete}
          onEmpty={handleTrashEmpty}
          onReadText={handleTrashReadText}
          onReadFile={handleTrashReadFile}
        />
      )}
      {/* Before the dialog, so ConfirmDialog still covers it: a menu row can
          raise a question (Move to Trash), and the menu closes first anyway. */}
      {contextMenu && <ContextMenu request={contextMenu} onClose={closeContextMenu} />}
      {/* Last, so it sits over the settings panel as well as the workspace —
          and outside the editor, because the questions it asks are the file
          tree's (which is visible in the graph view too). */}
      {dialog && (
        <ConfirmDialog
          title={dialog.title}
          confirmLabel={dialog.confirmLabel}
          danger={dialog.danger}
          altLabel={dialog.altLabel}
          onAlt={dialog.onAlt}
          onConfirm={dialog.onConfirm}
          onCancel={dialog.onCancel}
        >
          {dialog.body}
        </ConfirmDialog>
      )}
    </div>
  );
}
