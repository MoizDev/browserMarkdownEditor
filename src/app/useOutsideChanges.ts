import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { createCanvasSessionBridge } from '../utils/canvasSessionBridge';
import { ASSETS_DIR } from '../utils/assets';
import { getBaseline, setBaseline } from '../utils/docBaselines';
import { sameStat, type DiskVersion } from '../utils/diskVersion';
import { canReadTabText, representationFor } from '../utils/documentReading';
import type { ContentSource, DocumentBufferStore } from '../utils/documentBuffers';
import type { DocumentSessionStore } from '../utils/documentSessions';
import { getFileTimes, stampFileTimes } from '../utils/fileTimes';
import { isCanvasFile, isEpubFile, isNativeDrawingFile, isPdfFile } from '../utils/fileTypes';
import { bumpSaveEpoch } from '../utils/saveEpoch';
import { notifySearchChanges } from '../utils/searchChanges';
import { pairMoveCandidates, type VaultChangeBatch } from '../utils/vaultChanges';
import { clearPdfRenderData } from '../utils/pdfRenderCache';
import { ensurePdfSessionRoute, readPdfSessionRoute } from '../utils/pdfSessionRoute';
import { bindRecoveryAdapter } from '../utils/recoveryAdapters';
import { getView } from '../utils/viewRegistry';
import { reloadSpec } from '../editor/externalReload';
import type { MarkdownSessionHost } from '../editor/markdownSession.types';
import type { ActiveFile, ContentChangeOptions, FileSystemContextValue, FileTreeNode, OpenTab } from '../types';
import { RECOVERY_SESSION_BINDING } from './nativeOwners';
import type { IndexGraphRef, PdfRebuildEntry, SetDiskState, SetTabs } from './types';

/** The App-scope values `useOutsideChanges` reads, named as App names them. */
export interface UseOutsideChangesDeps {
  rootHandleRef: React.RefObject<FileSystemDirectoryHandle | null>;
  tabsRef: React.RefObject<OpenTab[]>;
  setTabs: SetTabs;
  setDiskState: SetDiskState;
  documentBuffers: DocumentBufferStore;
  documentSessions: DocumentSessionStore;
  markdownSessions: MarkdownSessionHost;
  invalidReaderTokens: React.RefObject<Set<string>>;
  saveTimersRef: React.RefObject<Map<string, ReturnType<typeof setTimeout>>>;
  flushingRef: React.RefObject<Map<string, number>>;
  diskStateRef: React.RefObject<Map<string, 'conflict' | 'deleted'>>;
  pdfRebuildRef: React.RefObject<Map<string, PdfRebuildEntry>>;
  bytesGenerationsRef: React.RefObject<Map<string, number>>;
  indexGraphRef: IndexGraphRef;
  fileTreeRef: React.RefObject<FileTreeNode[]>;
  assetReferenceRevisionRef: React.RefObject<number>;
  vaultMovesRef: React.RefObject<Set<Promise<unknown>>>;
  trashInFlightRef: React.RefObject<boolean>;
  restoringRef: React.RefObject<object | null>;
  bumpBytesGeneration: (id: string, preserveNative?: boolean) => void;
  clearSaveTimer: (path: string) => void;
  scheduleSave: (path: string) => void;
  seedDocumentBuffer: (id: string, path: string, content: string, readable: boolean) => void;
  rememberAssetRefs: (file: ActiveFile, content: string) => void;
  syncExitGuard: () => void;
  updateTabContent: (
    path: string, content: ContentSource,
    options?: ContentChangeOptions & { nativeTransition?: { revision: number; prior: ContentSource } },
  ) => void;
  retargetPaths: (
    fromPath: string, isFolder: boolean, newPath: string, sources: readonly string[], fromDisk?: boolean,
  ) => Promise<Array<{ from: string; to: string }>>;
  retargetExpandedPaths: (fromPath: string, newPath: string) => void;
  trackVaultMove: <T>(work: () => Promise<T>) => Promise<T>;
  requeueAllAssets: () => void;
  requeueAssetsAffected: (path: string) => void;
  indexMediaAssets: (tree: FileTreeNode[]) => Promise<[string, string[]][]>;
  getVaultActivation: FileSystemContextValue['getVaultActivation'];
  liveDetection: FileSystemContextValue['liveDetection'];
  subscribeVaultChanges: FileSystemContextValue['subscribeVaultChanges'];
  resolveFileHandle: FileSystemContextValue['resolveFileHandle'];
  resolveVaultDir: FileSystemContextValue['resolveVaultDir'];
  vaultDirExists: FileSystemContextValue['vaultDirExists'];
  statFile: FileSystemContextValue['statFile'];
  readFileSnapshot: FileSystemContextValue['readFileSnapshot'];
  readBytesVersioned: FileSystemContextValue['readBytesVersioned'];
  readFileVersioned: FileSystemContextValue['readFileVersioned'];
}

export function useOutsideChanges(deps: UseOutsideChangesDeps) {
  const {
    rootHandleRef, tabsRef, setTabs, setDiskState, documentBuffers, documentSessions, markdownSessions,
    invalidReaderTokens, saveTimersRef, flushingRef, diskStateRef, pdfRebuildRef, bytesGenerationsRef,
    indexGraphRef, fileTreeRef, assetReferenceRevisionRef, vaultMovesRef, trashInFlightRef, restoringRef,
    bumpBytesGeneration, clearSaveTimer, scheduleSave, seedDocumentBuffer, rememberAssetRefs, syncExitGuard,
    updateTabContent, retargetPaths, retargetExpandedPaths, trackVaultMove, requeueAllAssets,
    requeueAssetsAffected, indexMediaAssets, getVaultActivation, liveDetection, subscribeVaultChanges,
    resolveFileHandle, resolveVaultDir, vaultDirExists, statFile, readFileSnapshot, readBytesVersioned,
    readFileVersioned,
  } = deps;

  // ── Changes made OUTSIDE the app ────────────────────────────────────────
  // A `git pull` in the terminal, a formatter, a sync client, another editor.
  // FileSystemObserver records (FileSystemContext) are HINTS that say where to
  // look; a stat — and a hash of the bytes when the stat moved — is the truth,
  // compared with each open document's baseline (utils/docBaselines.ts). A
  // document with nothing unsaved reloads in place; one with unsaved edits gets
  // the DiskBar, and neither version is ever dropped. The save-time check in
  // flushTab stands on its own: with no observer at all, nothing is overwritten.

  /** Whether a document holds anything that is not on disk yet. `dirty` alone
   *  is not enough: an edit's save timer is armed before its render commits,
   *  a write may be in flight, and a canvas keeps strokes in its own debounce
   *  App cannot see (the reporter's hasPendingEdits). */
  const hasUnsaved = useCallback((tab: OpenTab): boolean => {
    return documentSessions.hasPendingEdits(tab.id)
      || saveTimersRef.current.has(tab.file.path)
      || flushingRef.current.has(tab.id)
      || !!getView(tab.file.path)?.hasPendingEdits?.();
  }, [documentSessions, flushingRef, saveTimersRef]);
  /**
   * Put the file's new contents into an open document that had nothing unsaved.
   *
   * Text: one minimal transaction annotated `externalReload` — through the live
   * view when there is one, else into the cached EditorState and the buffer
   * (a hidden tab, the graph view, a typeset .tex) — so the caret, the scroll
   * place and the undo history outside the change survive, ⌘Z steps back over
   * the reload, and nothing marks the tab dirty or writes it back. Canvases:
   * the buffer is replaced and `diskRev` remounts the pane on it; its camera
   * and view position are per path and come back.
   */
  const reloadFromDisk = useCallback((tab: OpenTab, text: string, version: DiskVersion) => {
    const { id, file } = tab;
    const path = file.path;
    if (isEpubFile(file.name) || isPdfFile(file.name)) invalidReaderTokens.current.add(`${id}|${tab.representation.generation}`);
    bumpBytesGeneration(id);
    clearSaveTimer(path);
    setBaseline(id, version);
    diskStateRef.current.delete(id);
    pdfRebuildRef.current.delete(id);
    syncExitGuard();
    if (!documentBuffers.get(id)) seedDocumentBuffer(id, path, text, canReadTabText(tab));
    if (isCanvasFile(file.name) || isPdfFile(file.name) || isEpubFile(file.name)) {
      // The parked original would otherwise be rebuilt over the new file by
      // the next annotation save.
      if (isPdfFile(file.name)) clearPdfRenderData(path);
      documentBuffers.report(id, text, true);
      const existing = documentSessions.get(id);
      if (existing && (isCanvasFile(file.name) || isPdfFile(file.name))) {
        const pdfRoute = isPdfFile(file.name) ? readPdfSessionRoute(existing) : undefined;
        const next = documentSessions.replace(id, existing.kind, bytesGenerationsRef.current.get(id) ?? 0,
          owner => createCanvasSessionBridge(owner, () => documentBuffers.get(id)?.source ?? ''));
        if (isPdfFile(file.name)) ensurePdfSessionRoute(next, pdfRoute);
        documentBuffers.setOwner(id, { documentId: id, session: next.serial });
        next.setSlot(RECOVERY_SESSION_BINDING, bindRecoveryAdapter(id, next.adapter), dispose => dispose());
      }
      setTabs(prev => prev.map(t => (t.id === id
        ? { ...t, dirty: false, disk: undefined, pdfRebuild: undefined, diskRev: (t.diskRev ?? 0) + 1, representation: representationFor(t.file.name, false, t.representation.generation + 1) }
        : t)));
      return;
    }
    const markdown = markdownSessions.get(id);
    if (markdown) {
      const spec = reloadSpec(markdown.state, text);
      if (spec) markdown.dispatch(spec);
      else updateTabContent(path, markdown.checkpoint(), { fromDisk: true });
    } else updateTabContent(path, text, { fromDisk: true });
    // The asset diff's baseline is the file as it now is.
    rememberAssetRefs(file, text);
    setTabs(prev => prev.map(t => (t.id === id && (t.dirty || t.disk) ? { ...t, dirty: false, disk: undefined } : t)));
  }, [bumpBytesGeneration, clearSaveTimer, documentBuffers, documentSessions, markdownSessions, updateTabContent, rememberAssetRefs, syncExitGuard, seedDocumentBuffer, bytesGenerationsRef, diskStateRef, invalidReaderTokens, pdfRebuildRef, setTabs]);

  /**
   * Follow a rename/move made on disk: open documents, expanded folders, icons,
   * colours and custom order all move with it — through the code an in-app
   * rename uses, minus the copy. Only when it is CERTAIN: the old path is gone
   * and the new one is there (a move is never followed on a guess).
   */
  // Resolves to the open documents it moved (old path → new): their tabs only
  // reach tabsRef a commit later, so the caller must not take them for missing.
  const followDiskMove = useCallback(async (root: FileSystemDirectoryHandle, from: string, to: string): Promise<Array<{ from: string; to: string }>> => {
    if (from === to || to.startsWith(`${from}/`)) return [];
    let isFolder = false;
    try {
      if (!await resolveFileHandle(to)) {
        await resolveVaultDir(root, to);
        isFolder = true;
      }
      if (isFolder ? await vaultDirExists(root, from) : await resolveFileHandle(from)) return [];
    } catch {
      return [];
    }
    if (rootHandleRef.current !== root) return [];
    const sources = tabsRef.current
      .filter(t => (isFolder ? t.file.path.startsWith(`${from}/`) : t.file.path === from))
      .map(t => t.file.path);
    let moved: Array<{ from: string; to: string }> = [];
    await trackVaultMove(async () => {
      if (isFolder) retargetExpandedPaths(from, to);
      moved = await retargetPaths(from, isFolder, to, sources, true);
    });
    return moved;
  }, [resolveFileHandle, trackVaultMove, retargetExpandedPaths, retargetPaths, resolveVaultDir, vaultDirExists, rootHandleRef, tabsRef]);

  /**
   * Re-verify open documents against the disk — those `scope` names (or that
   * sit under a folder it names), or all of them.
   *
   * Serialized (one pass at a time, in order), and it waits out the app's own
   * moves, trashes and the session restore: each is copy → delete → fix-up, and
   * mid-span the old file is simply gone — read then, it would be a false
   * "deleted". A document with a write in flight is checked again once it lands.
   */
  const checkQueueRef = useRef<Promise<void>>(Promise.resolve());
  const fullCheckQueuedRef = useRef(false);
  const runCheckRef = useRef<(scope: ReadonlySet<string> | 'all', batch?: VaultChangeBatch) => Promise<void>>(async () => {});
  const checkOpenDocs = useCallback((scope: ReadonlySet<string> | 'all', batch?: VaultChangeBatch): Promise<void> => {
    // Focus and visibilitychange arrive together, and a poll can land beside
    // them: one queued full pass answers all of them.
    if (scope === 'all' && !batch) {
      if (fullCheckQueuedRef.current) return checkQueueRef.current;
      fullCheckQueuedRef.current = true;
    }
    const run = checkQueueRef.current.then(() => {
      if (scope === 'all' && !batch) fullCheckQueuedRef.current = false;
      return runCheckRef.current(scope, batch);
    }).catch(err => { console.error('Could not check open documents against the disk:', err); });
    checkQueueRef.current = run;
    return run;
  }, []);

  useLayoutEffect(() => {
    runCheckRef.current = async (scope, batch) => {
      const root = rootHandleRef.current;
      if (!root) return;
      for (;;) {
        if (vaultMovesRef.current.size) { await Promise.allSettled([...vaultMovesRef.current]); continue; }
        if (trashInFlightRef.current || restoringRef.current) { await new Promise(r => setTimeout(r, 100)); continue; }
        break;
      }
      const stillHere = () => rootHandleRef.current === root;
      if (!stillHere()) return;

      const retry = new Set<string>();
      // Documents a move below re-pointed. tabsRef still shows them at the OLD
      // path until React commits, which read as missing — a false "deleted"
      // (measured: a root-level `mv a.md a2.md` raised it). They are verified at
      // their new path by the retry pass, which runs after that commit.
      const followed = new Set<string>();
      const follow = async (from: string, to: string) => {
        for (const m of await followDiskMove(root, from, to)) {
          followed.add(m.from);
          retry.add(m.to);
        }
      };
      // Disk and document agree again (it came back, or was put back as it
      // was): the bar goes, and whatever was typed while it was up gets saved.
      const lift = (id: string, path: string) => {
        setDiskState(id, null);
        scheduleSave(path);
      };
      // Search and the graph re-read a document whose file really changed —
      // once per pass (the subscriber leaves open documents to this pass, so
      // the echo of the app's own autosave costs no second rebuild).
      let contentChanged = false;

      // Renames the platform reported outright (not on Windows, nor in polling).
      if (batch?.moved.length) {
        for (const { from, to } of batch.moved.slice(0, 64)) {
          await follow(from, to);
          if (!stillHere()) return;
        }
      }

      const prefixes = scope === 'all' ? [] : [...scope].map(p => `${p}/`);
      const inScope = (path: string) => scope === 'all' || scope.has(path) || prefixes.some(p => path.startsWith(p));
      const missing: OpenTab[] = [];
      for (const tab of [...tabsRef.current]) {
        const { id, file } = tab;
        const path = file.path;
        if (file.isHelp || !file.handle || tab.readError) continue;
        if (followed.has(path)) continue;
        // A deleted document is re-examined whenever anything appeared — the
        // delete and the create of a move can land in separate batches.
        if (!inScope(path) && !(diskStateRef.current.get(id) === 'deleted' && batch?.appeared.size)) continue;
        if (flushingRef.current.has(id)) { retry.add(path); continue; }
        const baseline = getBaseline(id);
        if (!baseline) continue;
        let handle: FileSystemFileHandle | null;
        let stat: Awaited<ReturnType<typeof statFile>>;
        try {
          handle = await resolveFileHandle(path);
          stat = handle ? await statFile(handle) : null;
        } catch (err) {
          // Locked, or mid-write by someone else: not an answer. Ask again.
          console.warn('Could not stat an open document; will retry:', path, err);
          retry.add(path);
          continue;
        }
        if (!stillHere()) return;
        const now = tabsRef.current.find(t => t.id === id);
        if (!now || now.file.path !== path) continue;
        if (!handle || !stat) { missing.push(now); continue; }
        const held = diskStateRef.current.has(id);
        // The echo of the app's own save, or nothing happened at all.
        if (sameStat(stat, baseline)) { if (held) lift(id, path); continue; }
        let read: { text: string; version: DiskVersion };
        try {
          read = (isPdfFile(file.name) || isEpubFile(file.name) || isNativeDrawingFile(file.name))
            ? { text: '', version: isEpubFile(file.name) ? await (async () => { const snap = await readFileSnapshot(handle); try { return await snap.fingerprint(); } finally { snap.dispose(); } })() : (await readBytesVersioned(handle)).version }
            : await readFileVersioned(handle);
        } catch (err) {
          if (!hasUnsaved(now) && err instanceof Error && /binary data|valid UTF-8/.test(err.message)) { setTabs(prev => prev.map(t=>t.id===id?{...t,readError:err.message,representation:{...t.representation,status:'unavailable' as const,contentWritable:false}}:t)); continue; }
          console.warn('Could not read an open document that changed on disk; will retry:', path, err);
          retry.add(path);
          continue;
        }
        if (!stillHere()) return;
        const latest = tabsRef.current.find(t => t.id === id);
        if (!latest || latest.file.path !== path) continue;
        // Only the timestamps moved (`touch`, a checkout writing equal bytes).
        if (read.version.hash === baseline.hash) {
          setBaseline(id, read.version);
          if (held) lift(id, path);
          continue;
        }
        notifySearchChanges();
        const graphOwner = indexGraphRef.current;
        if (graphOwner?.root === root && graphOwner.activation === getVaultActivation()) {
          void graphOwner.client.invalidate([path]).catch(() => {});
        }
        if (diskStateRef.current.get(id) === 'conflict') continue;
        if (flushingRef.current.has(id)) { retry.add(path); continue; }
        contentChanged = true;
        if (hasUnsaved(latest)) setDiskState(id, 'conflict');
        else reloadFromDisk(latest, read.text, read.version);
      }

      // Missing: a rename the platform did not name (Windows, polling, a copy
      // then delete) is followed only when a file that appeared in the same
      // batch is the ONLY one of that size and has the very same hash.
      // Anything less certain is shown as deleted, never moved on a guess.
      if (missing.length) {
        const pairs = new Map<string, string>();
        const appearedPaths = batch ? [...batch.appeared]
          .filter(p => !tabsRef.current.some(t => t.file.path === p))
          .slice(0, 64) : [];
        if (appearedPaths.length) {
          const appeared: Array<{ path: string; size: number }> = [];
          for (const p of appearedPaths) {
            try {
              const h = await resolveFileHandle(p);
              const st = h ? await statFile(h) : null;
              if (st) appeared.push({ path: p, size: st.size });
            } catch { /* not a file we can read: not a candidate */ }
          }
          const candidates = pairMoveCandidates(
            missing.map(t => ({ path: t.file.path, size: getBaseline(t.id)?.size ?? -1 })),
            appeared,
          );
          for (const tab of missing) {
            const dest = candidates.get(tab.file.path);
            if (!dest) continue;
            try {
              const h = await resolveFileHandle(dest);
              const v = h ? await (async()=>{const snapshot=await readFileSnapshot(h);try{return await snapshot.fingerprint()}finally{snapshot.dispose()}})() : null;
              if (v && v.hash === getBaseline(tab.id)?.hash) pairs.set(tab.file.path, dest);
            } catch { /* unreadable: no proof, no move */ }
          }
        }
        if (!stillHere()) return;
        for (const tab of missing) {
          const dest = pairs.get(tab.file.path);
          if (dest) await follow(tab.file.path, dest);
          else if (diskStateRef.current.get(tab.id) !== 'deleted') setDiskState(tab.id, 'deleted');
          if (!stillHere()) return;
        }
      }

      if (contentChanged) bumpSaveEpoch();
      if (retry.size) setTimeout(() => { void checkOpenDocs(retry); }, 750);
    };
  });

  // Every batch of outside changes, after the context has patched the tree.
  useEffect(() => subscribeVaultChanges(batch => {
    indexGraphRef.noteMoves(batch.moved);
    assetReferenceRevisionRef.current++;
    if (batch.rescan) requeueAllAssets();
    else for (const changed of [...batch.modified, ...batch.appeared, ...batch.disappeared, ...batch.moved.flatMap(m => [m.from, m.to])]) requeueAssetsAffected(changed);
    void checkOpenDocs(batch.rescan ? 'all' : new Set([
      ...batch.modified, ...batch.appeared, ...batch.disappeared,
      ...batch.moved.flatMap(m => [m.from, m.to]),
    ]), batch);
    // Search and the graph re-validate by (lastModified, size), so one nudge
    // per batch is all a file edited elsewhere needs. Structural changes move
    // the tree, which re-runs both on its own. OPEN documents are left to
    // checkOpenDocs, which nudges only when one really changed: every autosave
    // comes back here as `modified`, and nudging on that echo doubled the
    // graph's vault-wide stat pass per save.
    const open = new Set(tabsRef.current.map(t => t.file.path));
    if (batch.rescan || batch.modified.size) notifySearchChanges();
    const graphOwner = indexGraphRef.current;
    if (graphOwner && graphOwner.activation === getVaultActivation()) {
      const changedPaths = [...batch.modified, ...batch.appeared, ...batch.disappeared, ...batch.moved.flatMap(move => [move.from, move.to])];
      if (batch.rescan || changedPaths.some(path => path.split('/').includes(ASSETS_DIR))) {
        graphOwner.client.suspendMedia();
        const tree = fileTreeRef.current;
        void indexMediaAssets(tree).then(entries => {
          if (indexGraphRef.current === graphOwner && graphOwner.activation === getVaultActivation() && fileTreeRef.current === tree) return graphOwner.client.setMediaAssets(entries);
        }).catch(() => {});
      }
      if (batch.rescan) void graphOwner.client.sweep('rescan').catch(() => {});
      else graphOwner.echo.hints([...batch.modified]);
    }
    if (batch.rescan || [...batch.modified].some(p => !open.has(p))) bumpSaveEpoch();
    // The Modified-time sort, without re-statting the vault: only the files the
    // batch names, and only while a time sort has loaded any times at all.
    if (batch.modified.size && getFileTimes().size) {
      void (async () => {
        const stamps: Array<[string, number]> = [];
        for (const path of [...batch.modified].slice(0, 512)) {
          try {
            const h = await resolveFileHandle(path);
            const st = h ? await statFile(h) : null;
            if (st) stamps.push([path, st.lastModified]);
          } catch { /* gone again, or unreadable: the next walk sorts it */ }
        }
        stampFileTimes(stamps);
      })();
    }
  }), [subscribeVaultChanges, checkOpenDocs, resolveFileHandle, statFile, requeueAllAssets, requeueAssetsAffected, indexMediaAssets, indexGraphRef, getVaultActivation, assetReferenceRevisionRef, fileTreeRef, tabsRef]);

  // The belt to the observer's braces: coming back to the window re-checks
  // every open document (one stat each). Without an observer at all — an older
  // Chrome, or one whose observe() failed — open documents are also polled
  // every 2 s while the page is visible; the context polls the tree itself.
  useEffect(() => {
    if (liveDetection === 'off') return;
    const recheck = () => { if (document.visibilityState === 'visible') void checkOpenDocs('all'); };
    window.addEventListener('focus', recheck);
    document.addEventListener('visibilitychange', recheck);
    const poll = liveDetection === 'polling' ? setInterval(recheck, 2000) : null;
    return () => {
      window.removeEventListener('focus', recheck);
      document.removeEventListener('visibilitychange', recheck);
      if (poll) clearInterval(poll);
    };
  }, [liveDetection, checkOpenDocs]);

  return { hasUnsaved, reloadFromDisk, checkOpenDocs };
}
