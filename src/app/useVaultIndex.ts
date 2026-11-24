import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FileSystemContextValue, FileTreeNode, GraphData, OpenTab } from '../types';
import type { WikiLinkTarget } from '../editor/wikiLinkComplete';
import { useIndexGraph, type IndexProgress } from '../context/vaultIndex/useIndexGraph';
import type { DocumentBufferStore } from '../utils/documentBuffers';
import { canReadTabText } from '../utils/documentReading';
import { setIndexProgress, setIndexUnavailable } from '../utils/indexProgress';
import { markIndexTimesReady, stampIndexedFileTimes } from '../utils/fileTimes';
import { notifySearchChanges, subscribeSearchChanges } from '../utils/searchChanges';
import type { SearchController } from '../utils/searchController';
import { collectFiles } from '../utils/tree';
import { parentVaultPath } from '../utils/paths';
import { ASSETS_DIR } from '../utils/assets';
import { isCanvasFile } from '../utils/fileTypes';
import { mapPool } from '../utils/pool';

/**
 * Structural equality for two link graphs.
 *
 * The index graph is deterministic for a given vault — nodes follow the file list and
 * links follow document order — so an element-wise walk is exact, and it lets a
 * rebuild that found nothing new keep the previous object identity instead of
 * cascading a re-render (and a graph re-simulation) through the app.
 */
const EMPTY_GRAPH: GraphData = { nodes: [], links: [], backlinks: {}, outlinks: {} };

/**
 * Is this graph the same one we already handed out?
 *
 * `publishIndexGraph` keeps the PREVIOUS GraphData object when the answer is yes, and
 * that identity is load-bearing: a fresh object propagates into GraphView's
 * effects, which re-seed the simulation (alpha = 1) and tear down and rebuild
 * the RAF loop and the ResizeObserver. Without this, an unrelated tab
 * autosaving visibly re-heated the graph the user was looking at. Only changed
 * link facts/tree revisions request new work; equivalent worker publications
 * must still leave the running layout alone.
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

export interface UseVaultIndexDeps {
  rootHandle: FileSystemDirectoryHandle | null;
  currentVaultId: string | null;
  fileTree: FileTreeNode[];
  getVaultActivation: FileSystemContextValue['getVaultActivation'];
  resolveFileHandle: FileSystemContextValue['resolveFileHandle'];
  statFile: FileSystemContextValue['statFile'];
  handleIO: FileSystemContextValue['handleIO'];
  requestIndexPermission: FileSystemContextValue['requestIndexPermission'];
  /** A folder's media listing turned fresh: requeue the asset folders waiting
   *  on it (useAssetLifecycle — bound late, it is declared after this). */
  indexMediaChanged: () => void;
  tabsRef: React.MutableRefObject<OpenTab[]>;
  documentBuffers: DocumentBufferStore;
  contentOf: (path: string) => string | undefined;
}

/**
 * The vault index (context/vaultIndex): the link graph behind the graph view,
 * backlinks and the `[[` autocomplete; the search the sidebar and the agent
 * run; and what the reader is told while it builds or cannot.
 */
export function useVaultIndex(deps: UseVaultIndexDeps) {
  const {
    rootHandle, currentVaultId, fileTree, getVaultActivation, resolveFileHandle, statFile, handleIO,
    requestIndexPermission, indexMediaChanged, tabsRef, documentBuffers, contentOf,
  } = deps;
  const searchActivation = getVaultActivation();
  const searchToken = useMemo(() => ({ activation: searchActivation }), [searchActivation]);

  // The link graph powering the Neural Brain view and backlinks panel
  const [graphState, setGraph] = useState<{ activation: number; data: GraphData }>(() => ({ activation: getVaultActivation(), data: EMPTY_GRAPH }));
  const graph = graphState.activation === getVaultActivation() ? graphState.data : EMPTY_GRAPH;
  const [graphFreshness, setGraphFreshness] = useState<{ activation: number; stale: boolean } | null>(null);
  useLayoutEffect(() => { setIndexProgress(null); setIndexUnavailable(false); }, [searchActivation]);
  const reportGraphFreshness = useCallback((stale: boolean) => {
    if (getVaultActivation() === searchActivation) setGraphFreshness({ activation: searchActivation, stale });
  }, [getVaultActivation, searchActivation]);
  const reportIndexProgress = useCallback((value: IndexProgress) => {
    if (getVaultActivation() === searchActivation) setIndexProgress(value);
  }, [getVaultActivation, searchActivation]);
  const publishIndexGraph = useCallback((next: GraphData | null, activation: number, current: () => boolean) => {
    const value = next ?? EMPTY_GRAPH;
    if (getVaultActivation() !== activation || !current()) return;
    // A reply can be superseded between receipt and React executing its updater.
    setGraph(previous => getVaultActivation() !== activation || !current() ? previous
      : previous.activation === activation && sameGraph(previous.data, value) ? previous
        : { activation, data: value });
  }, [getVaultActivation]);
  const [indexProblem, setIndexProblem] = useState<{ activation: number; kind: string } | null>(null);
  const reportIndexProblem = useCallback((value: unknown) => {
    const problem = value as { kind?: string } | null;
    const kind = problem?.kind ?? 'unavailable';
    // The index client's word that its worker came back by itself: the same clearing as the sidebar's Retry.
    if (kind === 'available') {
      setIndexUnavailable(false);
      setIndexProblem(previous => previous?.kind === 'unavailable' ? null : previous);
      return;
    }
    if (kind === 'unavailable' || kind === 'replaced') setIndexUnavailable(true);
    setIndexProblem({ activation: getVaultActivation(), kind });
  }, [getVaultActivation]);
  const [indexStartupActivation, setIndexStartupActivation] = useState<number | null>(null);
  const indexRestoreSettled = useCallback(() => {
    if (getVaultActivation() === searchActivation) setIndexStartupActivation(searchActivation);
  }, [getVaultActivation, searchActivation]);
  const reportIndexTimes = useCallback((changes: [string, number, number][], complete: boolean) => {
    stampIndexedFileTimes(changes);
    if (complete) markIndexTimesReady();
  }, []);
  const indexMediaAssets = useCallback(async (tree: FileTreeNode[]): Promise<[string, string[]][]> => {
    const folders = new Map<string, FileSystemDirectoryHandle>();
    for (const file of collectFiles(tree)) if (isCanvasFile(file.name) && file.parentHandle) folders.set(parentVaultPath(file.path), file.parentHandle);
    const listings = await mapPool([...folders], async ([folder, parent]): Promise<[string, string[]] | undefined> => {
      try {
        const names: string[] = [];
        const assets = await handleIO.dirIn(parent, ASSETS_DIR).catch(error => {
          if (error instanceof DOMException && error.name === 'NotFoundError') return null;
          throw error;
        });
        if (assets) for await (const [name, handle] of handleIO.entries(assets)) if (handle.kind === 'file') names.push(name);
        return [folder, names];
      } catch { return undefined; } // An omitted listing cannot authorize retirement.
    }, 2);
    return listings.filter((entry): entry is [string, string[]] => entry !== undefined);
  }, [handleIO]);
  const indexGraphRef = useIndexGraph({ root: rootHandle, vaultId: currentVaultId, activation: searchActivation,
    getActivation: getVaultActivation, autoStart: indexStartupActivation === searchActivation, tree: fileTree, resolve: resolveFileHandle, stat: statFile,
    publish: publishIndexGraph, onSnapshot: reportGraphFreshness, onStatus: reportIndexProgress, onProblem: reportIndexProblem, onTimes: reportIndexTimes,
    mediaAssets: indexMediaAssets, onMediaChanged: indexMediaChanged });
  const retryIndex = useCallback(async () => {
    const owner = indexGraphRef.current;
    if (!owner || !indexProblem || owner.activation !== indexProblem.activation || owner.activation !== getVaultActivation()) return;
    if (indexProblem.kind === 'permission' && !await requestIndexPermission(owner.root, owner.activation)) return;
    try {
      await owner.regrant();
      if (indexGraphRef.current === owner) { setIndexProblem(null); setIndexUnavailable(false); }
    } catch { /* Keep Retry available. */ }
  }, [indexGraphRef, indexProblem, getVaultActivation, requestIndexPermission]);

  const rebuildIndex = useCallback(() => {
    const activation = getVaultActivation();
    void indexGraphRef.whenReady().then(owner => {
      if (owner.activation === activation && activation === getVaultActivation()) return owner.client.rebuild();
    }).catch(() => {});
  }, [indexGraphRef, getVaultActivation]);

  // The [[ autocomplete's targets, deduped by link name since wikilinks
  // resolve by name, not path. It is baked into each document's EditorState
  // (outside any compartment), and that session-owned state outlives
  // EditorPane, so the getter must be stable for the APP's life: one created in
  // EditorPane would go on reading that EditorPane's graph once a graph-view
  // trip unmounted it, and a note created afterwards would never be offered.
  // Same rule as openNoteByName, and the same ref-mirror to keep it current.
  const graphRef = useRef<GraphData>(graph);
  useEffect(() => { graphRef.current = graph; }, [graph]);
  const [getWikiLinkTargets] = useState(() => (): WikiLinkTarget[] => {
    const seen = new Set<string>();
    const targets: WikiLinkTarget[] = [];
    for (const node of graphRef.current.nodes) {
      const key = node.name.toLowerCase();
      if (!node.name || seen.has(key)) continue;
      seen.add(key);
      targets.push({ name: node.name, unresolved: node.unresolved });
    }
    return targets;
  });

  useEffect(() => { notifySearchChanges(); }, [fileTree]);
  const searchBuffers = useCallback(() => tabsRef.current.flatMap(tab => {
    const revision = documentBuffers.revisionForDocument(tab.id);
    if (!revision || revision.revision <= revision.savedRevision || !canReadTabText(tab) || isCanvasFile(tab.file.name)) return [];
    const text = contentOf(tab.file.path);
    return text === undefined ? [] : [{ path: tab.file.path, revision: revision.revision, text }];
  }), [contentOf, documentBuffers, tabsRef]);
  const searchController = useMemo<SearchController>(() => ({
    subscribe: subscribeSearchChanges,
    async search(query, onBatch, signal) {
      const activation = getVaultActivation();
      const owner = await indexGraphRef.whenReady();
      if (owner.activation !== activation || activation !== getVaultActivation()) throw new DOMException('Vault changed', 'AbortError');
      return owner.client.searchSidebar(query, searchBuffers(), onBatch, signal);
    },
    retry() {
      const owner = indexGraphRef.current;
      if (!owner || owner.activation !== getVaultActivation()) return;
      setIndexUnavailable(false);
      setIndexProblem(previous => previous?.kind === 'unavailable' ? null : previous);
      owner.client.retry();
    },
  }), [getVaultActivation, indexGraphRef, searchBuffers]);
  const searchAgent = useCallback(async (config: { query: string; regex: boolean; caseSensitive: boolean; scope: string; maxResults: number }, signal?: AbortSignal) => {
    const activation = getVaultActivation();
    const owner = await indexGraphRef.whenReady();
    if (owner.activation !== activation || activation !== getVaultActivation()) throw new DOMException('Vault changed', 'AbortError');
    return owner.client.searchAgent(config, searchBuffers(), signal);
  }, [getVaultActivation, indexGraphRef, searchBuffers]);
  return {
    searchActivation, searchToken, graph, graphFreshness, indexProblem, indexGraphRef, indexMediaAssets,
    retryIndex, rebuildIndex, indexRestoreSettled, getWikiLinkTargets, searchController, searchAgent,
  };
}
