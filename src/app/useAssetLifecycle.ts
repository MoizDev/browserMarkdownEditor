import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { ActiveFile, FileSystemContextValue, OpenTab } from '../types';
import type { DocumentBufferStore } from '../utils/documentBuffers';
import type { DocumentSessionStore } from '../utils/documentSessions';
import { BoardSaveBaselines, RetirementBacklog, boardMediaDiff, decideAssetRetirement, mediaChanges, resolveBoardMedia } from '../utils/assetRetirement';
import { boardMediaRefs } from '../utils/boardMediaRefs';
import { ASSETS_DIR, TRASH_DIR, assetEmbeds, assetReferences } from '../utils/assets';
import { joinVaultPath, parentVaultPath } from '../utils/paths';
import { collectFiles } from '../utils/tree';
import { hashBytes } from '../utils/diskVersion';
import { isCanvasFile } from '../utils/fileTypes';
import { isTextFile } from '../utils/vaultSearch';
import { canReadTabText } from '../utils/documentReading';
import { drain } from '../utils/unloadCoordinator';
import { getView } from '../utils/viewRegistry';
import { perfRoot } from '../utils/perfHooks';
import { retryMissingAssets } from '../editor/imageWidget';
import { tracksAssets } from './tracksAssets';
import type { AssetOutcome, IndexGraphRef, ReconcileJob } from './types';

export interface UseAssetLifecycleDeps {
  rootHandle: FileSystemContextValue['rootHandle'];
  fileTree: FileSystemContextValue['fileTree'];
  getVaultActivation: FileSystemContextValue['getVaultActivation'];
  handleIO: FileSystemContextValue['handleIO'];
  readFile: FileSystemContextValue['readFile'];
  retireAsset: FileSystemContextValue['retireAsset'];
  restoreAsset: FileSystemContextValue['restoreAsset'];
  tabs: OpenTab[];
  tabsRef: React.RefObject<OpenTab[]>;
  documentBuffers: DocumentBufferStore;
  documentSessions: DocumentSessionStore;
  indexGraphRef: IndexGraphRef;
}

export function useAssetLifecycle(deps: UseAssetLifecycleDeps) {
  const {
    rootHandle, fileTree, getVaultActivation, handleIO, readFile, retireAsset, restoreAsset,
    tabs, tabsRef, documentBuffers, documentSessions, indexGraphRef,
  } = deps;

  const assetRefsRef = useRef<Map<string, { saved: Set<string>; references: Set<string> }>>(new Map());
  const boardBaselinesRef = useRef(new BoardSaveBaselines());

  const rememberAssetRefs = useCallback((file: ActiveFile, content: string) => {
    if (tracksAssets(file)) assetRefsRef.current.set(file.path, { saved: assetEmbeds(content), references: assetReferences(content) });
    else if (!file.isHelp && isCanvasFile(file.name)) boardBaselinesRef.current.seed(file.path, content);
  }, []);

  const moveAssetRefs = useCallback((from: string, to: string) => {
    boardBaselinesRef.current.move(from, to);
    const refs = assetRefsRef.current.get(from);
    if (!refs) return;
    assetRefsRef.current.delete(from);
    assetRefsRef.current.set(to, refs);
  }, []);

  const assetActivationsRef = useRef(new WeakMap<FileSystemDirectoryHandle, number>());
  const assetProofTreeRef = useRef(fileTree);
  const assetReferenceRevisionRef = useRef(0);
  const requeueAssetFolderRef = useRef<(folder: string) => void>(() => {});
  const assetBacklogRef = useRef(new RetirementBacklog<ReconcileJob>());
  const assetOwnerRootRef = useRef(rootHandle);
  const assetOwnerActivationRef = useRef(getVaultActivation());
  useLayoutEffect(() => {
    if (assetOwnerRootRef.current !== rootHandle || assetOwnerActivationRef.current !== getVaultActivation()) {
      assetBacklogRef.current.reset();
      assetOwnerRootRef.current = rootHandle;
      assetOwnerActivationRef.current = getVaultActivation();
    }
    if (rootHandle) assetActivationsRef.current.set(rootHandle, getVaultActivation());
    assetProofTreeRef.current = fileTree;
    assetReferenceRevisionRef.current++;
  }, [rootHandle, fileTree, getVaultActivation]);

  const assetNamesIn = useCallback(async (dir: FileSystemDirectoryHandle, activeOnly = false): Promise<Set<string>> => {
    const names = new Set<string>();
    const collect = async (parent: FileSystemDirectoryHandle, name: string) => {
      try {
        const folder = await handleIO.dirIn(parent, name);
        for await (const [entry, handle] of handleIO.entries(folder)) if (handle.kind === 'file') names.add(entry);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
      }
    };
    await collect(dir, ASSETS_DIR);
    if (!activeOnly) {
      try { await collect(await handleIO.dirIn(dir, TRASH_DIR), ASSETS_DIR); }
      catch (error) { if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error; }
    }
    return names;
  }, [handleIO]);

  const reconcileAssets = useCallback(async (job: ReconcileJob): Promise<AssetOutcome> => {
    const { activation, path, parentHandle: dir } = job;
    let { before, after } = job;
    const attached = () => getVaultActivation() === activation;
    if (!attached()) return 'skipped-detached';
    if (!dir) return 'kept';
    const folder = parentVaultPath(path);
    const startRevision = assetReferenceRevisionRef.current;
    const block = (retry: ReconcileJob = job) => {
      if (!attached()) return;
      assetBacklogRef.current.block(folder, retry);
      // An observer event can beat the failing read; don't lose that wakeup.
      if (assetReferenceRevisionRef.current !== startRevision) queueMicrotask(() => requeueAssetFolderRef.current(folder));
    };

    try {
      const treeAtStart = assetProofTreeRef.current;
      const under = folder ? `${folder}/` : '';
      const treeFiles = collectFiles(treeAtStart);
      const boards: Array<{ path: string; handle?: FileSystemFileHandle }> = [];
      const diskBoardPaths = new Set<string>();
      for await (const [name, handle] of handleIO.entries(dir)) {
        if (handle.kind === 'file' && isCanvasFile(name)) {
          const boardPath = joinVaultPath(folder, name);
          diskBoardPaths.add(boardPath);
          boards.push({ path: boardPath, handle: handle as FileSystemFileHandle });
        }
      }
      // Descendant notes can resolve an ancestor's assets. A board of any
      // unknown format there must therefore keep the ancestor's pictures too.
      for (const file of treeFiles) {
        if (file.path.startsWith(under) && isCanvasFile(file.name) && !boards.some(board => board.path === file.path)) boards.push({ path: file.path, handle: file.handle });
      }
      for (const tab of tabsRef.current) {
        if (isCanvasFile(tab.file.name) && tab.file.path.startsWith(under) && !boards.some(board => board.path === tab.file.path)) boards.push({ path: tab.file.path });
      }
      const assetNames = boards.length || job.board ? await assetNamesIn(dir) : new Set<string>();
      if (!attached()) return 'skipped-detached';
      if (assetProofTreeRef.current !== treeAtStart) { block(); return 'kept'; }
      if (job.board) {
        const encoder = new TextEncoder();
        const diff = await boardMediaDiff({ source: encoder.encode(job.board.before) }, { source: encoder.encode(job.board.after) }, assetNames, boardMediaRefs);
        if (!attached()) return 'skipped-detached';
        if (!diff.ok) { block(); return 'kept'; }
        ({ before, after } = diff);
      }
      let reclaimed = false;
      for (const name of new Set([...after].filter(name => !before.has(name)).concat([...(job.restore ?? [])]))) {
        if (!attached()) return 'skipped-detached';
        if (await restoreAsset(name, dir, attached)) reclaimed = true;
      }
      if (reclaimed && attached()) retryMissingAssets();

      if (!attached()) return 'skipped-detached';
      const names = mediaChanges(before, after).removed;
      if (__BME_BENCH__) {
        try { job.measuredNames = [...names]; } catch { /* Measurement cannot interrupt a job. */ }
      }
      if (names.size === 0) return 'kept';
      for (const board of boards) {
        const open = tabsRef.current.find(tab => tab.file.path === board.path);
        if (!open) continue;
        await drain(open.id);
        await getView(board.path)?.flushPending?.();
        if (!attached()) return 'skipped-detached';
      }
      const revision = assetReferenceRevisionRef.current;
      const proofTabs = tabsRef.current;
      const proofContents = new Map(proofTabs.map(tab => {
        if (!canReadTabText(tab)) return [tab.file.path, undefined] as const;
        if (isCanvasFile(tab.file.name)) {
          if (tab.representation.nativeCanvasKind) return [tab.file.path, undefined] as const;
          const data = documentBuffers.snapshotForDocument(tab.id)?.data;
          return [tab.file.path, typeof data === 'string' ? data : undefined] as const;
        }
        return [tab.file.path, documentBuffers.contentForDocument(tab.id)] as const;
      }));
      const proofRevisions = new Map(proofTabs.map(tab => [tab.id, documentBuffers.revisionForDocument(tab.id)?.revision]));
      const proofMedia = new Map(proofTabs.map(tab => {
        const adapter = documentSessions.get(tab.id)?.adapter;
        return [tab.id, adapter?.mediaReferenceIssues?.()?.length ? undefined : adapter?.mediaReferences?.()] as const;
      }));
      const proofCurrent = () => attached() && assetReferenceRevisionRef.current === revision
        && tabsRef.current.length === proofTabs.length && tabsRef.current.every((tab, i) => {
          const old = proofTabs[i];
          return tab.id === old.id && tab.file.path === old.file.path
            && tab.readError === old.readError && tab.representation === old.representation
            && documentBuffers.revisionForDocument(tab.id)?.revision === proofRevisions.get(tab.id)
            && (!isCanvasFile(tab.file.name) || !getView(tab.file.path)?.hasPendingEdits?.());
        });
      let retired = false;
      const abandon = (): AssetOutcome => {
        if (!attached()) return retired ? 'retired' : 'skipped-detached';
        if (names.size) block();
        return retired ? 'retired' : 'kept';
      };
      const own = proofTabs.find(tab => tab.file.path === path);
      const ownFile = treeFiles.find(file => file.path === path);
      const ownText = own ? proofContents.get(path) ?? null
        : ownFile ? await readFile(ownFile.handle).catch(() => null) : null;
      const candidates = treeFiles.filter(f =>
        f.path !== path && isTextFile(f.name) && f.path.startsWith(under));
      const neighbours = [
        ...candidates.filter(f => parentVaultPath(f.path) === folder),
        ...candidates.filter(f => parentVaultPath(f.path) !== folder),
      ];
      const notes = [async () => ownFile ? await readFile(ownFile.handle).catch(() => null) : null, async () => ownText, ...neighbours.map(note => async () => {
        const open = proofTabs.find(t => t.file.path === note.path);
        if (open) {
          const refs = proofMedia.get(open.id);
          return proofContents.get(note.path) ?? (refs ? refs.map(name => `[[${name}]]`).join('\n') : null);
        }
        if (isCanvasFile(note.name)) {
          try { return (await handleIO.file(note.handle)).stream(); } catch { return null; }
        }
        return await readFile(note.handle).catch(() => null);
      })];
      const activeAssetNames = boards.length ? await assetNamesIn(dir, true) : new Set<string>();
      const listingKey = JSON.stringify([...activeAssetNames].sort());
      const indexOwner = indexGraphRef.current;
      const mediaSnapshot = indexOwner?.activation === activation ? await indexOwner.client.mediaSnapshot(folder) : undefined;
      const indexedBoards = new Map(mediaSnapshot?.fresh && mediaSnapshot.listingKey === listingKey
        ? mediaSnapshot.boards.map(board => [board.path, board]) : []);
      if (indexOwner?.activation === activation && mediaSnapshot?.listingKey !== listingKey) {
        void indexOwner.client.setFolderMediaAssets(folder, [...activeAssetNames]).catch(() => {});
      }
      const closedVersions: Array<{ handle: FileSystemFileHandle; modified: number; size: number }> = [];
      const hashedVersions = new Map<string, { handle: FileSystemFileHandle; modified: number; size: number }>();
      // Before I4, a direct read at retirement time is the fresh answer; an
      // unreadable board blocks the folder instead of guessing from stale data.
      const boardReads = boards.map(board => async () => {
        const open = proofTabs.find(t => t.file.path === board.path);
        if (open) {
          const refs = proofMedia.get(open.id);
          if (refs) return { ok: true as const, names: [...refs] };
          if (!canReadTabText(open)) return { ok: false as const, reason: 'unreadable' as const };
          const text = proofContents.get(board.path);
          if (text === undefined) return { ok: false as const, reason: 'unreadable' as const };
          return resolveBoardMedia({ source: new TextEncoder().encode(text) }, assetNames, boardMediaRefs);
        }
        if (!board.handle) return { ok: false as const, reason: 'unreadable' as const };
        try {
          const file = await handleIO.file(board.handle);
          const indexed = indexedBoards.get(board.path);
          const refs = indexed && indexed.mtime === file.lastModified && indexed.size === file.size
            ? { ok: true as const, names: indexed.names }
            : await resolveBoardMedia({ source: file.stream() }, assetNames, boardMediaRefs);
          closedVersions.push({ handle: board.handle, modified: file.lastModified, size: file.size });
          return refs;
        } catch { return { ok: false as const, reason: 'unreadable' as const }; }
      });
      const decision = await decideAssetRetirement({
        candidates: { note: job.board ? new Set() : names, board: job.board ? names : new Set() },
        notes, boards: boardReads, current: proofCurrent,
        hash: async name => {
          try {
            const assets = await handleIO.dirIn(dir, ASSETS_DIR);
            const handle = await handleIO.fileIn(assets, name);
            const file = await handleIO.file(handle);
            const hash = await hashBytes(await file.arrayBuffer());
            hashedVersions.set(name, { handle, modified: file.lastModified, size: file.size });
            return hash;
          } catch { return null; }
        },
      });
      if (decision.blocked.note.size || decision.blocked.board.size) {
        // Keep positive references as pending candidates: their final plain link
        // can disappear in a later save without another embed diff to rediscover it.
        const held = job.board ? decision.blocked.board : decision.blocked.note;
        if (held.size) block(job.board ? job : { ...job, before: new Set(held), after: new Set() });
      }
      for (const name of decision.retire) {
        const currentBoards = new Set<string>();
        for await (const [entry, handle] of handleIO.entries(dir)) {
          if (handle.kind === 'file' && isCanvasFile(entry)) currentBoards.add(joinVaultPath(folder, entry));
        }
        if (currentBoards.size !== diskBoardPaths.size || [...currentBoards].some(boardPath => !diskBoardPaths.has(boardPath))) return abandon();
        if (boards.length && JSON.stringify([...(await assetNamesIn(dir, true))].sort()) !== listingKey) return abandon();
        const hashed = hashedVersions.get(name);
        for (const version of hashed ? [...closedVersions, hashed] : closedVersions) {
          const current = await handleIO.file(version.handle).catch(() => null);
          if (!current || current.lastModified !== version.modified || current.size !== version.size) return abandon();
        }
        if (!proofCurrent()) return abandon();
        if (await retireAsset(name, dir, proofCurrent)) {
          retired = true;
          names.delete(name);
        } else {
          try {
            const assets = await handleIO.dirIn(dir, ASSETS_DIR);
            await handleIO.fileIn(assets, name);
            block();
          } catch (error) {
            if (!(error instanceof DOMException && error.name === 'NotFoundError')) block();
          }
        }
      }
      if (!proofCurrent()) return abandon();
      return retired ? 'retired' : 'kept';
    } catch (err) {
      block();
      console.error('Could not reconcile assets for', path, err);
      return 'failed';
    }
  }, [assetNamesIn, handleIO, readFile, retireAsset, restoreAsset, getVaultActivation, documentBuffers, documentSessions, indexGraphRef, tabsRef]);

  const reconcileAssetsRef = useRef(reconcileAssets);
  useEffect(() => { reconcileAssetsRef.current = reconcileAssets; }, [reconcileAssets]);

  const reconcileQueueRef = useRef<Promise<void>>(Promise.resolve());
  const queueReconcile = useCallback((job: ReconcileJob) => {
    reconcileQueueRef.current = reconcileQueueRef.current.then(async () => {
      let outcome: AssetOutcome = 'failed';
      try { outcome = await reconcileAssetsRef.current(job); }
      finally {
        if (__BME_BENCH__) {
          try {
            const root = perfRoot();
            const jobs = (root.assetJobs ??= { completed: [] }) as { completed: Array<{
              activation: number; path: string; outcome: AssetOutcome; names: string[]; t: number;
            }> };
            jobs.completed.push({ activation: job.activation, path: job.path, outcome,
              names: job.measuredNames ?? [...job.before].filter(name => !job.after.has(name)), t: performance.now() });
          } catch { /* The waiting hook cannot change queue settlement. */ }
        }
      }
    });
  }, []);

  const requeueAssetFolder = useCallback((folder: string) => {
    const backlog = assetBacklogRef.current;
    if (!backlog.schedule(folder)) return;
    reconcileQueueRef.current = reconcileQueueRef.current.then(async () => {
      for (const job of backlog.take(folder)) await reconcileAssetsRef.current(job);
    });
  }, []);
  requeueAssetFolderRef.current = requeueAssetFolder;
  const requeueAssetsAffected = useCallback((path: string) => {
    assetReferenceRevisionRef.current++;
    for (const folder of assetBacklogRef.current.affected(path)) requeueAssetFolder(folder);
  }, [requeueAssetFolder]);
  const requeueAllAssets = useCallback(() => {
    assetReferenceRevisionRef.current++;
    for (const folder of assetBacklogRef.current.all()) requeueAssetFolder(folder);
  }, [requeueAssetFolder]);

  const assetReadableWakeRef = useRef(new Set<string>());
  useLayoutEffect(() => {
    for (const path of assetReadableWakeRef.current) {
      if (tabs.some(tab => tab.file.path === path && !tab.readError)) {
        assetReadableWakeRef.current.delete(path);
        requeueAssetsAffected(path);
      }
    }
  }, [tabs, requeueAssetsAffected]);

  const requeueBackloggedAssets = useCallback(() => {
    for (const folder of assetBacklogRef.current.all()) requeueAssetFolderRef.current(folder);
  }, []);

  return {
    assetRefsRef, boardBaselinesRef, rememberAssetRefs, moveAssetRefs, assetActivationsRef,
    assetReferenceRevisionRef, reconcileQueueRef, queueReconcile, requeueAssetsAffected,
    requeueAllAssets, assetReadableWakeRef, requeueBackloggedAssets,
  };
}
