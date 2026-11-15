import type React from 'react';
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { flushSync } from 'react-dom';
import type { ActiveFile, EditorMode, FileSystemContextValue, FileTreeNode, MainView, OpenTab, TabLayout } from '../types';
import { isEpubFile, isCanvasFile, isMarkdownFile, isNativeDrawingFile, isPdfFile } from '../utils/fileTypes';
import { isTextFile } from '../utils/vaultSearch';
import type { AgentHostDeps } from '../utils/agentHost';
import { assetEmbeds, assetReferences } from '../utils/assets';
import { setBaseline } from '../utils/docBaselines';
import type { ClosedPdfAgentAccess } from '../types/vaultAgent';
import { representationFor } from '../utils/documentReading';
import type { DocumentBufferStore } from '../utils/documentBuffers';
import { routeEngines } from '../utils/engineRouting';
import { recordFileWritten } from '../utils/fileTimes';
import { collectFiles } from '../utils/tree';
import { bumpSaveEpoch } from '../utils/saveEpoch';
import { notifySearchChanges } from '../utils/searchChanges';
import { openInSidePane } from '../utils/tabPanes';
import type { MarkdownSessionHost } from '../editor/markdownSession.types';
import { newTabId } from './documentIds';
import { tracksAssets } from './tracksAssets';
import type { IndexGraphRef, ReconcileJob, SetLayout, SetTabs } from './types';
import type { Ask, Notify } from './useAppDialogs';

/** The App-scope values `useAgentHostDeps` reads, named as App names them. */
export interface UseAgentHostDepsDeps {
  rootHandle: FileSystemContextValue['rootHandle'];
  rootHandleRef: React.RefObject<FileSystemDirectoryHandle | null>;
  tabs: OpenTab[];
  tabsRef: React.RefObject<OpenTab[]>;
  layout: TabLayout;
  mainView: MainView;
  setMainView: React.Dispatch<React.SetStateAction<MainView>>;
  setTabs: SetTabs;
  setLayout: SetLayout;
  fileTreeRef: React.RefObject<FileTreeNode[]>;
  assetActivationsRef: React.RefObject<WeakMap<FileSystemDirectoryHandle, number>>;
  indexGraphRef: IndexGraphRef;
  searchToken: { activation: number };
  searchAgent: AgentHostDeps['searchAgent'];
  markdownSessions: MarkdownSessionHost;
  documentBuffers: DocumentBufferStore;
  contentOf: (path: string) => string | undefined;
  closedPdfAccess: ClosedPdfAgentAccess;
  acquireClosedAgentCanvas: NonNullable<AgentHostDeps['acquireClosedCanvasSource']>;
  readClosedAgentCanvasMedia: NonNullable<AgentHostDeps['readClosedCanvasMedia']>;
  ensureNativeAgentRuntime: NonNullable<AgentHostDeps['ensureNativeAgentRuntime']>;
  seedPdfBaseline: (id: string, handle: FileSystemFileHandle) => void;
  seedDocumentBuffer: (id: string, path: string, content: string, readable: boolean) => void;
  rememberAssetRefs: (file: ActiveFile, content: string) => void;
  queueReconcile: (job: ReconcileJob) => void;
  requeueAssetsAffected: (path: string) => void;
  handleRenameFile: (node: FileTreeNode, newName: string) => Promise<boolean>;
  handleMoveFile: (sourceNode: FileTreeNode, targetDirHandle: FileSystemDirectoryHandle, targetPath?: string) => Promise<boolean>;
  handleFileClick: (node: FileTreeNode) => Promise<boolean>;
  trashForAgent: (node: FileTreeNode) => Promise<'ok' | 'busy' | 'failed'>;
  changeTabMode: (path: string | null, requestedMode?: EditorMode) => void;
  ask: Ask;
  notify: Notify;
  currentVaultId: FileSystemContextValue['currentVaultId'];
  handleIO: FileSystemContextValue['handleIO'];
  ensureVaultId: FileSystemContextValue['ensureVaultId'];
  fileTree: FileSystemContextValue['fileTree'];
  readFile: FileSystemContextValue['readFile'];
  readFileBytes: FileSystemContextValue['readFileBytes'];
  readFileVersioned: FileSystemContextValue['readFileVersioned'];
  writeFile: FileSystemContextValue['writeFile'];
  writeFileVersioned: FileSystemContextValue['writeFileVersioned'];
  statFile: FileSystemContextValue['statFile'];
  createFile: FileSystemContextValue['createFile'];
  createFolder: FileSystemContextValue['createFolder'];
  nameTaken: FileSystemContextValue['nameTaken'];
  getVaultActivation: FileSystemContextValue['getVaultActivation'];
}

export function useAgentHostDeps(deps: UseAgentHostDepsDeps) {
  const {
    rootHandle, rootHandleRef, tabs, tabsRef, layout, mainView, setMainView, setTabs, setLayout, fileTreeRef,
    assetActivationsRef, indexGraphRef, searchToken, searchAgent, markdownSessions, documentBuffers, contentOf,
    closedPdfAccess, acquireClosedAgentCanvas, readClosedAgentCanvasMedia, ensureNativeAgentRuntime,
    seedPdfBaseline, seedDocumentBuffer, rememberAssetRefs, queueReconcile, requeueAssetsAffected,
    handleRenameFile, handleMoveFile, handleFileClick, trashForAgent, changeTabMode, ask, notify,
    currentVaultId, handleIO, ensureVaultId, fileTree, readFile, readFileBytes, readFileVersioned, writeFile,
    writeFileVersioned, statFile, createFile, createFolder, nameTaken, getVaultActivation,
  } = deps;

  // ── The AI agent's hands ────────────────────────────────────────────────
  // Everything the agent panel and its tool executor can do to the vault goes
  // through these two hosts (utils/agentHost.ts), built ONCE — in the panel's
  // lazy chunk, so the main bundle does not carry them (measured: +26 kB when
  // App built them) — so the panel's WebSocket and in-flight runs never
  // restart on an App re-render. They read
  // this ref, refreshed after every commit, so each call sees the current vault,
  // tabs and layout — and goes through the very handlers the reader's own
  // gestures use.
  const addTabQuietly = useCallback(async (node: FileTreeNode, mode: EditorMode): Promise<boolean> => {
    if (node.kind !== 'file') return false;
    if (tabsRef.current.some(t => t.file.path === node.path)) return true;
    const rootAtOpen = rootHandleRef.current;
    try {
      // As handleFileClick: a PDF's bytes are read by its pane, and decoding one
      // as UTF-8 would corrupt it.
      const read = (isPdfFile(node.name) || isEpubFile(node.name) || isNativeDrawingFile(node.name)) ? null : await readFileVersioned(node.handle);
      if (rootHandleRef.current !== rootAtOpen) return false;
      const content = read?.text ?? '';
      if (!isNativeDrawingFile(node.name)) rememberAssetRefs(node, content);
      // The disk baseline, as handleFileClick takes it.
      const id = newTabId();
      if (read) setBaseline(id, read.version); else if (isPdfFile(node.name) || isNativeDrawingFile(node.name)) seedPdfBaseline(id, node.handle);
      seedDocumentBuffer(id, node.path, content, representationFor(node.name).bufferKind === 'text');
      // Session-only tools acquire immediately after this resolves; commit the tab
      // and its source classification before handing them the live App owner.
      flushSync(() => setTabs(prev => prev.some(t => t.file.path === node.path)
        ? prev
        : [...prev, { id, file: node, mode: isEpubFile(node.name) ? 'read' : mode, dirty: false, representation: representationFor(node.name) }]));
      return true;
    } catch (err) {
      console.error('Agent could not open a file:', err);
      return false;
    }
  }, [readFileVersioned, rememberAssetRefs, seedPdfBaseline, seedDocumentBuffer, rootHandleRef, setTabs, tabsRef]);

  const agentDepsRef = useRef<AgentHostDeps | null>(null);
  useLayoutEffect(() => {
    const activation = rootHandle ? assetActivationsRef.current.get(rootHandle) ?? -1 : -1;
    agentDepsRef.current = {
      vaultId: currentVaultId,
      handleIO,
      ensureVaultId,
      root: rootHandle,
      searchToken,
      searchAgent,
      fileTree,
      tabs,
      layout,
      mainView,
      markdownSessions,
      readFile,
      readFileBytes,
      closedPdfAgent: () => routeEngines().pdfViewer === 'tiled' ? closedPdfAccess : null,
      acquireClosedCanvasSource: acquireClosedAgentCanvas,
      readClosedCanvasMedia: readClosedAgentCanvasMedia,
      ensureNativeAgentRuntime,
      readFileVersioned,
      statFile,
      writeFileVersioned,
      writeFile,
      createFile,
      createFolder,
      nameTaken,
      contentOf,
      snapshotOf: documentBuffers.retainSnapshotOf,
      afterWrite: (file, before, after, version) => {
        // The tail of flushTab, for a file written with no tab to flush.
        notifySearchChanges();
        recordFileWritten(file.path);
        requeueAssetsAffected(file.path);
        if (isCanvasFile(file.name)) queueReconcile({ activation, path: file.path, parentHandle: file.parentHandle ?? null,
          text: after, before: new Set(), after: new Set(), board: { before, after } });
        if (tracksAssets(file)) queueReconcile({ activation, path: file.path, parentHandle: file.parentHandle ?? null,
          text: after, before: assetEmbeds(before), after: assetEmbeds(after),
          restore: new Set([...assetReferences(after)].filter(name => !assetReferences(before).has(name))) });
        const graphOwner = indexGraphRef.current;
        if (graphOwner && graphOwner.root === rootHandle && graphOwner.activation === activation && activation === getVaultActivation()) {
          if (version) {
            graphOwner.echo.remember(file.path, version.lastModified, version.size);
            if (isMarkdownFile(file.name)) void graphOwner.client.prime(file.path, version.lastModified, version.size, after).catch(() => {});
            else if (isTextFile(file.name) && !isCanvasFile(file.name)) void graphOwner.client.primeText(file.path, version.lastModified, version.size, after).catch(() => {});
          } else void graphOwner.client.invalidate([file.path]).catch(() => {});
        }
        bumpSaveEpoch();
      },
      renameEntry: handleRenameFile,
      moveEntry: handleMoveFile,
      trashEntry: trashForAgent,
      addTabQuietly,
      setTabMode: changeTabMode,
      showBeside: path => {
        // A canvas only exists while the editor is on screen; the graph view
        // unmounts every pane.
        setMainView('editor');
        setLayout(l => openInSidePane(l, path));
      },
      openFile: path => {
        const node = collectFiles(fileTreeRef.current).find(f => f.path === path);
        if (!node) return;
        void handleFileClick(node);
        setMainView('editor');
      },
      ask,
      notify,
    };
  });
  // The hosts themselves are built in the panel's lazy chunk from this getter.
  const getAgentHostDeps = useCallback(() => agentDepsRef.current!, []);
  const agentVault = useMemo(
    () => (rootHandle ? { key: currentVaultId ?? rootHandle.name, name: rootHandle.name } : null),
    [rootHandle, currentVaultId]);

  return { addTabQuietly, getAgentHostDeps, agentVault };
}
