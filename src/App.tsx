import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useFileSystem } from './context/FileSystemContext';
import { HELP_DOC_CONTENT } from './utils/helpDoc';
import { buildGraph, collectMarkdownFiles, baseName, clearLinkCache } from './utils/graph';
import { readJSON, writeJSON } from './utils/storage';
import { joinVaultPath, parentVaultPath } from './utils/paths';
import { assetEmbeds, referencesAsset } from './utils/assets';
import { collectFiles } from './utils/tree';
import { bumpSaveEpoch } from './utils/saveEpoch';
import { isTextFile } from './utils/vaultSearch';
import { isDrawingFile, isPdfFile, isAnnotatedPdf, annotatedNameFor } from './utils/fileTypes';
import { clampRecentVaultLimit, DEFAULT_RECENT_VAULT_LIMIT } from './utils/recentVaults';
import { clampTabSize } from './editor/lists';
import { retryMissingAssets } from './editor/imageWidget';
// Cache only — importing utils/pdfAnnotation here would pull pdf-lib + pdf.js
// (~1.3MB) into the main bundle, which a markdown-only session never needs.
// The builder itself is import()ed at the two points that actually write a PDF.
import { getPdfRenderData, clearPdfRenderData, movePdfRenderData } from './utils/pdfRenderCache';
import './index.css';
import FileExplorer from './components/FileExplorer';
import EditorPane from './components/EditorPane';
import SettingsPanel from './components/SettingsPanel';
import GraphView from './components/GraphView';
import { Settings, HelpCircle, Network, FileTextOutline, PanelLeft } from './components/icons';
import type {
  ActiveFile,
  FileTreeNode,
  FileTreeFileNode,
  OpenTab,
  GraphData,
  GraphNode,
  SettingsDefaults,
  Theme,
  EditorMode,
  MainView,
  CaretStyle,
  EditorRevealRequest,
  TextRange,
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

/**
 * Whether a document's text can embed a picture — i.e. whether its `.Assets`
 * folder has to be kept in step with it. A drawing and a PDF are text on disk
 * but a canvas on screen, and the Help guide has no folder of its own.
 */
function tracksAssets(file: ActiveFile): boolean {
  return !file.isHelp && !!file.parentHandle && isTextFile(file.name) && !isDrawingFile(file.name);
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

export default function App() {
  const {
    rootHandle,
    fileTree,
    isLoading,
    previousVault,
    recentVaults,
    currentVaultId,
    pickDirectory,
    openRecentVault,
    readFile,
    writeFile,
    readFileBytes,
    writeFileBytes,
    importFiles,
    createFile,
    createFolder,
    retireAsset,
    restoreAsset,
    restoreVault,
    moveToTrash,
    moveFile,
    renameFile,
  } = useFileSystem();

  // Open tabs (one per open document) + the path of the active tab. This
  // replaces the former single (activeFile + fileContent + editorMode) trio;
  // those three are now DERIVED from the active tab below and still fed to
  // EditorPane, so most downstream code is unchanged.
  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const [activeTabPath, setActiveTabPath] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<string>('');

  const activeTab = useMemo(
    () => tabs.find(t => t.file.path === activeTabPath) ?? null,
    [tabs, activeTabPath]
  );
  // Keeping `t.file` identity stable across keystrokes (see updateActiveTabContent)
  // means `activeFile` only changes on an actual tab switch, not on every edit.
  const activeFile = activeTab?.file ?? null;
  const fileContent = activeTab?.content ?? '';
  const editorMode: EditorMode = activeTab?.mode ?? 'read';

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
  const activeTabPathRef = useRef<string | null>(activeTabPath);
  // Per-PATH debounced save timers, so switching or closing one tab never
  // cancels another tab's pending write (fixes the old single-timer data loss).
  const saveTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const saveStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { tabsRef.current = tabs; }, [tabs]);
  useEffect(() => { activeTabPathRef.current = activeTabPath; }, [activeTabPath]);

  // True once the restore pass below has consumed the stored session.
  const hasRestoredTabs = useRef<boolean>(false);

  // The open vault, for the async restore pass to re-check after its awaits.
  const currentVaultIdRef = useRef<string | null>(currentVaultId);
  useEffect(() => { currentVaultIdRef.current = currentVaultId; }, [currentVaultId]);

  // Persist the open tabs + active tab so they can be restored on reload. Keyed
  // on the joined path string (not `tabs`) so it does NOT run on every keystroke
  // — only when the set/order of open files, or the active one, changes.
  //
  // GATED until the restore pass has run: this effect also fires on mount, with
  // zero tabs, and writing that out would clobber the stored tab list moments
  // before restore reads it — which is exactly what reduced every reload to
  // "only the last-active file comes back" (via the lastFilePath fallback).
  const openTabPathsKey = tabs.map(t => t.file.path).join('\n');
  useEffect(() => {
    if (!hasRestoredTabs.current) return;
    const paths = openTabPathsKey ? openTabPathsKey.split('\n') : [];
    writeJSON('openTabPaths', paths);
    // Which vault this session belongs to. These paths index ONE vault's tree,
    // so the restore pass below has to know whether it is looking at that vault
    // (see there) — a session with no vault stamped on it predates this.
    if (currentVaultId) localStorage.setItem('openTabsVaultId', currentVaultId);
    if (activeTabPath) {
      localStorage.setItem('activeTabPath', activeTabPath);
      localStorage.setItem('lastFilePath', activeTabPath); // back-compat
    } else {
      localStorage.removeItem('activeTabPath');
    }
  }, [openTabPathsKey, activeTabPath, currentVaultId]);

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

      // Already open? Just focus its tab — don't re-read (preserves the tab's
      // unsaved edits and its own undo history).
      if (tabsRef.current.some(t => t.file.path === node.path)) {
        setActiveTabPath(node.path);
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
        : [...prev, { file: node, content, mode: 'read', dirty: false }]);
      setActiveTabPath(node.path);
      setSaveStatus('');
      return true;
    } catch (err) {
      console.error('Failed to read file:', err);
      return false;
    }
  }, [readFile, rememberAssetRefs]);

  /**
   * Start annotating a plain PDF. Creates "<name> (annotated).pdf" beside it —
   * a real PDF carrying the pristine original + an empty snapshot — then opens
   * it in annotate mode. The source PDF is never modified.
   *
   * Re-annotating an existing annotated file just reopens it, so the button is
   * safe to press twice and existing strokes are never blown away.
   */
  const handleAnnotatePdf = useCallback(async (file: ActiveFile) => {
    if (!file.handle || !file.parentHandle) return;
    const targetName = annotatedNameFor(file.name);
    const targetPath = joinVaultPath(parentVaultPath(file.path), targetName);

    try {
      // Adopt an existing annotated file rather than overwriting it.
      let handle: FileSystemFileHandle;
      try {
        handle = await file.parentHandle.getFileHandle(targetName);
      } catch {
        const original = await readFileBytes(file.handle as FileSystemFileHandle);
        const { buildAnnotatedPdfAsync } = await import('./utils/pdfBuildClient');
        const bytes = await buildAnnotatedPdfAsync(original, '', []);
        // createFile refreshes the tree, so the new file shows up right away.
        handle = await createFile(file.parentHandle, targetName);
        await writeFileBytes(handle, bytes);
      }

      const node: ActiveFile = {
        name: targetName,
        path: targetPath,
        kind: 'file',
        handle,
        parentHandle: file.parentHandle,
      };
      setTabs(prev => prev.some(t => t.file.path === targetPath)
        ? prev
        : [...prev, { file: node, content: '', mode: 'edit', dirty: false }]);
      setActiveTabPath(targetPath);
      setMainView('editor');
    } catch (err) {
      console.error('Could not create the annotated PDF:', err);
      alert(`Could not create "${targetName}".`);
    }
  }, [createFile, readFileBytes, writeFileBytes]);

  // Flat index of markdown files for resolving wikilinks by note name
  const mdFiles = useMemo(() => collectMarkdownFiles(fileTree), [fileTree]);

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
      if (isAnnotatedPdf(tab.file.name)) {
        // An annotated PDF's buffer is a tldraw snapshot; the file on disk is a
        // real PDF. Rebuild it from the pristine original + the overlays the
        // canvas parked for us. No render data yet means the canvas hasn't
        // reported a change, so there is nothing to write.
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
      if (activeTabPathRef.current === path) {
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

  // Buffer an edit against ONE named tab and schedule its save. Path-explicit
  // on purpose: the drawing canvas serializes on a debounce that can fire after
  // the user has switched tabs, and that JSON must land in the drawing's own
  // buffer — never in whichever tab happens to be active by then.
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

  // Wired to EditorPane's onContentChange. CodeMirror only ever edits the
  // visible document, so "the active tab" is the right target there.
  const updateActiveTabContent = useCallback((content: string) => {
    const path = activeTabPathRef.current;
    if (!path) return;
    updateTabContent(path, content);
  }, [updateTabContent]);

  const removeTab = useCallback((path: string, flush: boolean) => {
    // flushTab captures the tab synchronously, clears the timer, and no-ops for
    // non-dirty / Help / handle-less tabs, so calling it whenever we flush is safe.
    if (flush) flushTab(path); else clearSaveTimer(path);
    // Safe to drop now: flushTab reads the render data synchronously, before its
    // first await, so a flush already in flight has what it needs.
    clearPdfRenderData(path);
    // Same: the flush above captured its own diff before this ran. A closed
    // note has no unsaved edits left to attribute an asset change to.
    assetRefsRef.current.delete(path);

    if (activeTabPathRef.current === path) {
      const list = tabsRef.current;
      const i = list.findIndex(t => t.file.path === path);
      setActiveTabPath(list[i + 1]?.file.path ?? list[i - 1]?.file.path ?? null);
    }
    setTabs(prev => prev.filter(t => t.file.path !== path));
  }, [clearSaveTimer, flushTab]);

  const closeTab = useCallback((path: string) => removeTab(path, true), [removeTab]);

  const reorderTabs = useCallback((path: string, toIndex: number) => {
    setTabs(prev => {
      const from = prev.findIndex(t => t.file.path === path);
      if (from === -1) return prev;
      const next = prev.slice();
      const [moved] = next.splice(from, 1);
      // `toIndex` indexes the PRE-removal array; adjust when moving rightward.
      const insertAt = toIndex > from ? toIndex - 1 : toIndex;
      next.splice(insertAt, 0, moved);
      return next;
    });
  }, []);

  const toggleTabMode = useCallback((path: string | null) => {
    if (!path) return;
    setTabs(prev => prev.map(t =>
      t.file.path === path && !t.file.isHelp
        ? { ...t, mode: t.mode === 'edit' ? 'read' : 'edit' }
        : t));
  }, []);

  // Open a note by its name (used by [[wikilinks]], graph nodes, backlinks).
  const openNoteByName = useCallback((name: string | null) => {
    if (!name) return;
    const key = baseName(name).toLowerCase();
    const match = mdFiles.find(f => baseName(f.name).toLowerCase() === key);
    if (match) {
      handleFileClick(match);
      setMainView('editor');
    }
  }, [mdFiles, handleFileClick]);

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
    if (range && !isDrawingFile(node.name)) {
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
    }
    // Those flushes captured what they needed synchronously (see flushTab); the
    // paths themselves index the vault being left.
    assetRefsRef.current.clear();
    setTabs([]);
    setActiveTabPath(null);
    setSaveStatus('');
    setPendingReveal(null);
  }, [rootHandle, flushTab]);

  // Search reads open-tab buffers through this accessor (via tabsRef) so its
  // results reflect unsaved edits without re-rendering the sidebar on typing.
  const getOpenTabContent = useCallback(
    (path: string) => tabsRef.current.find(t => t.file.path === path)?.content ?? null,
    []
  );

  // Auto-restore previously-open tabs once the file tree has loaded.
  useEffect(() => {
    if (hasRestoredTabs.current || !fileTree || fileTree.length === 0) return;
    // Consume the stored session exactly once per app load — and flip the flag
    // BEFORE any early return, because persistence stays gated until this pass
    // has run and a fresh profile with nothing stored must still un-gate it.
    hasRestoredTabs.current = true;

    // The stored session belongs to ONE vault: its paths index that vault's
    // tree, and nothing else about them says so. A cold start can land on a
    // DIFFERENT vault — the last one's permission lapsed, or the user opened
    // another from the vault menu before this pass ran — and restoring then
    // opens whichever of the new vault's files happen to sit at those paths.
    // That is precisely what the vault-switch effect above exists to prevent,
    // arriving by another road. A session with no vault stamped on it was
    // written by an older build; restore it as before rather than discard it.
    const sessionVaultId = localStorage.getItem('openTabsVaultId');
    if (sessionVaultId && currentVaultId && sessionVaultId !== currentVaultId) return;

    // A missing key (pre-tab-era profile) falls back to its single
    // lastFilePath; a present-but-empty list means the last session really
    // ended with no tabs open, so nothing should be restored.
    let storedPaths = readJSON<string[] | null>('openTabPaths', null);
    if (!Array.isArray(storedPaths)) {
      const last = localStorage.getItem('lastFilePath');
      storedPaths = last ? [last] : [];
    }
    if (storedPaths.length === 0) return;

    (async () => {
      const vaultFiles = collectFiles(fileTree);
      const restored: OpenTab[] = [];
      for (const path of storedPaths) {
        if (path === 'help-guide') {
          restored.push({ file: { name: 'Help Guide', isHelp: true, path }, content: HELP_DOC_CONTENT, mode: 'read', dirty: false });
          continue;
        }
        const node = vaultFiles.find(f => f.path === path);
        if (!node) continue; // file deleted/moved externally — skip it
        try {
          // Mirror handleFileClick: a PDF's buffer holds its tldraw snapshot
          // (PdfPane reads the bytes itself) — decoding a PDF as UTF-8 would
          // fill the buffer with garbage.
          const content = isPdfFile(node.name) ? '' : await readFile(node.handle as FileSystemFileHandle);
          rememberAssetRefs(node, content);   // see handleFileClick
          restored.push({ file: node, content, mode: 'read', dirty: false });
        } catch (err) {
          console.error('Failed to restore tab:', path, err);
        }
      }
      if (restored.length === 0) return;
      // The reads above yield to the event loop; if the user opened something
      // in the meantime, leave their workspace alone rather than clobber it.
      if (tabsRef.current.length > 0) return;
      // Or switched vaults in the meantime — the switch effect empties the tab
      // set, so the check above would wave these through and drop the OLD
      // vault's notes (handles and all) into the new vault's workspace.
      if (currentVaultIdRef.current !== currentVaultId) return;
      setTabs(restored);
      const wantActive = localStorage.getItem('activeTabPath');
      const active = restored.some(t => t.file.path === wantActive) ? wantActive : restored[0].file.path;
      setActiveTabPath(active);
    })();
  }, [fileTree, readFile, currentVaultId, rememberAssetRefs]);

  const handleHelpClick = useCallback(() => {
    const path = 'help-guide';
    if (tabsRef.current.some(t => t.file.path === path)) {
      setActiveTabPath(path);
      return;
    }
    setTabs(prev => [...prev, {
      file: { name: 'Help Guide', isHelp: true, path },
      content: HELP_DOC_CONTENT,
      mode: 'read',
      dirty: false,
    }]);
    setActiveTabPath(path);
    setSaveStatus('');
  }, []);

  const handleCreateFile = useCallback(async (parentHandle: FileSystemDirectoryHandle | null, name: string, parentPath = '') => {
    try {
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
      console.error('Failed to create file:', err);
    }
  }, [createFile, handleFileClick]);

  const handleCreateFolder = useCallback(async (parentHandle: FileSystemDirectoryHandle | null, name: string) => {
    try {
      await createFolder(parentHandle!, name);
    } catch (err) {
      console.error('Failed to create folder:', err);
    }
  }, [createFolder]);

  const handleTrash = useCallback(async (node: FileTreeNode) => {
    if (confirm(`Move "${node.name}" to Trash?`)) {
      const moved = await moveToTrash(node);
      if (moved && tabsRef.current.some(t => t.file.path === node.path)) {
        // Close the trashed file's tab WITHOUT flushing (its handle is gone).
        removeTab(node.path, false);
        setSaveStatus('');
      }
    }
  }, [moveToTrash, removeTab]);

  const handleRenameFile = useCallback(async (node: FileTreeNode, newName: string) => {
    const success = await renameFile(node, newName);
    if (!success) return;
    const openTab = tabsRef.current.find(t => t.file.path === node.path);
    if (!openTab) return;

    const segs = node.path.split('/');
    segs.pop();
    segs.push(newName);
    const newPath = segs.join('/');

    try {
      const fileHandle = await node.parentHandle.getFileHandle(newName);
      clearSaveTimer(node.path); // cancel any pending save against the OLD handle
      // An annotated PDF's parked original + overlays are keyed by path; re-key
      // them or the next save finds nothing and silently writes nothing.
      movePdfRenderData(node.path, newPath);
      moveAssetRefs(node.path, newPath);
      setTabs(prev => prev.map(t => t.file.path === node.path
        ? { ...t, file: { ...t.file, name: newName, path: newPath, handle: fileHandle } }
        : t));
      setActiveTabPath(prev => prev === node.path ? newPath : prev);
      // Flush buffered edits to the NEW handle (never the old one).
      if (openTab.dirty) scheduleSave(newPath);
      localStorage.setItem('lastFilePath', newPath);
    } catch (err) {
      console.error('Could not get handle for renamed file', err);
    }
  }, [renameFile, clearSaveTimer, scheduleSave, moveAssetRefs]);

  // Wrap moveFile so a moved open file's tab tracks its new path/handle (also
  // fixes the pre-existing stale-path-after-move for the active document).
  const handleMoveFile = useCallback(async (sourceNode: FileTreeNode, targetDirHandle: FileSystemDirectoryHandle, targetPath = '') => {
    const openTab = tabsRef.current.find(t => t.file.path === sourceNode.path);
    const success = await moveFile(sourceNode, targetDirHandle);
    if (success && openTab) {
      const newPath = joinVaultPath(targetPath, sourceNode.name);
      try {
        const newHandle = await targetDirHandle.getFileHandle(sourceNode.name);
        clearSaveTimer(sourceNode.path);
        movePdfRenderData(sourceNode.path, newPath);   // see handleRenameFile
        moveAssetRefs(sourceNode.path, newPath);
        setTabs(prev => prev.map(t => t.file.path === sourceNode.path
          ? { ...t, file: { ...t.file, path: newPath, handle: newHandle, parentHandle: targetDirHandle } }
          : t));
        setActiveTabPath(prev => prev === sourceNode.path ? newPath : prev);
        if (openTab.dirty) scheduleSave(newPath);
      } catch (err) {
        console.error('Could not update moved tab handle:', err);
      }
    }
    return success;
  }, [moveFile, clearSaveTimer, scheduleSave, moveAssetRefs]);

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        flushTab(activeTabPathRef.current, true);
      }
      // Cmd+N — create new note in vault root
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault();
        if (rootHandle) {
          const name = prompt('New note name (e.g. "note.md"):');
          if (name) handleCreateFile(rootHandle, name, '');
        }
      }
      // Cmd+E — toggle read/edit mode of the active tab
      if ((e.metaKey || e.ctrlKey) && e.key === 'e') {
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
          <p className="welcome-subtitle">Open a vault to start editing your notes.</p>
          <div style={{ display: 'flex', gap: '12px', marginTop: '12px', flexWrap: 'wrap', justifyContent: 'center' }}>
            <button className="welcome-btn" style={{ margin: 0 }} onClick={pickDirectory}>
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
          activeFilePath={activeFile?.path || null}
          onFileClick={handleFileClick}
          onCreateFile={handleCreateFile}
          onCreateFolder={handleCreateFolder}
          onChangeVault={pickDirectory}
          recentVaults={recentVaults}
          currentVaultId={currentVaultId}
          recentVaultLimit={recentVaultLimit}
          onOpenRecentVault={openRecentVault}
          onCollapse={() => setSidebarCollapsed(true)}
          onTrash={handleTrash}
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
          <button
            className="theme-toggle-btn settings-btn"
            onClick={() => setShowSettings(true)}
            title="Settings"
          >
            <Settings size={16} />
            Settings
          </button>
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
            activeFile={activeFile}
            fileContent={fileContent}
            theme={theme}
            editorMode={editorMode}
            tabSize={tabSize}
            saveStatus={saveStatus}
            tabs={tabs}
            activeTabPath={activeTabPath}
            onSelectTab={(path) => setActiveTabPath(path)}
            onCloseTab={closeTab}
            onReorderTabs={reorderTabs}
            onToggleMode={toggleTabMode}
            onContentChange={updateActiveTabContent}
            onDrawingChange={updateTabContent}
            onFlushNow={flushTabNow}
            onAnnotatePdf={handleAnnotatePdf}
            onOpenNote={openNoteByName}
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
    </div>
  );
}
