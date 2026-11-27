import type React from 'react';
import { useEffect, useRef } from 'react';
import type { ActiveFile, FileSystemContextValue, FileTreeFileNode, FileTreeNode, OpenTab, RecentVault, TabLayout } from '../types';
import type { DocumentBufferStore } from '../utils/documentBuffers';
import type { BoardSaveBaselines } from '../utils/assetRetirement';
import type { DiskVersion } from '../utils/diskVersion';
import type { PendingRestore, PendingRestoreEntry } from '../utils/pendingRestore';
import { findLinkedVault, type readLocation } from '../utils/appUrl';
import { collectFiles } from '../utils/tree';
import { classifyRequestedKind, opensInApp, representationFor } from '../utils/documentReading';
import { isEpubFile, isNativeDrawingFile, isPdfFile } from '../utils/fileTypes';
import { loadHelpDoc } from '../utils/helpDocLoader';
import { setBaseline } from '../utils/docBaselines';
import { pruneSessions, readSession } from '../utils/tabSessions';
import { mergeLayouts, relabelPaths, restoreLayout } from '../utils/tabPanes';
import { newTabId } from './documentIds';
import { describeReadError, isNotFound } from './readErrors';
import type { SetLayout, SetTabs } from './types';
import { isFileReadTimeout, withinFileDeadline } from '../utils/fileReadDeadline';

const INDEX_WAIT_MS = 8000;
const MOVES_WAIT_MS = 15_000;

async function movesSettled(moves: Set<Promise<unknown>>): Promise<boolean> {
  const deadline = performance.now() + MOVES_WAIT_MS;
  while (moves.size) {
    const left = deadline - performance.now();
    if (left <= 0) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.allSettled([...moves]), new Promise(resolve => { timer = setTimeout(resolve, left); })]);
    clearTimeout(timer);
  }
  return true;
}

class RestoreIncomplete extends Error {}

export interface UseSessionRestoreDeps {
  fileTree: FileTreeNode[];
  rootHandle: FileSystemDirectoryHandle | null;
  currentVaultId: string | null;
  isLoading: boolean;
  recentVaults: RecentVault[];
  readFileVersioned: FileSystemContextValue['readFileVersioned'];
  resolveVaultFile: FileSystemContextValue['resolveVaultFile'];
  rememberAssetRefs: (file: ActiveFile, content: string) => void;
  seedPdfBaseline: (id: string, handle: FileSystemFileHandle) => void;
  seedDocumentBuffer: (id: string, path: string, content: string, readable: boolean) => void;
  documentBuffers: DocumentBufferStore;
  indexRestoreSettled: () => void;
  initialLocation: ReturnType<typeof readLocation>;
  linkPendingRef: React.MutableRefObject<boolean>;
  setPendingLinkFile: (file: string | null) => void;
  sessionRootRef: React.MutableRefObject<FileSystemDirectoryHandle | null>;
  sessionVaultIdRef: React.MutableRefObject<string | null | undefined>;
  restoringRef: React.MutableRefObject<object | null>;
  sessionSealedRef: React.MutableRefObject<string | null>;
  notifyRef: React.MutableRefObject<(message: string) => void>;
  restorePendingRef: React.MutableRefObject<PendingRestore | null>;
  vaultMovesRef: React.MutableRefObject<Set<Promise<unknown>>>;
  rootHandleRef: React.MutableRefObject<FileSystemDirectoryHandle | null>;
  currentVaultIdRef: React.MutableRefObject<string | null>;
  layoutRef: React.MutableRefObject<TabLayout>;
  assetRefsRef: React.MutableRefObject<Map<string, { saved: Set<string>; references: Set<string> }>>;
  boardBaselinesRef: React.MutableRefObject<BoardSaveBaselines>;
  setTabs: SetTabs;
  setLayout: SetLayout;
}

export function useSessionRestore(deps: UseSessionRestoreDeps): void {
  const {
    fileTree, rootHandle, currentVaultId, isLoading, recentVaults, readFileVersioned, resolveVaultFile,
    rememberAssetRefs, seedPdfBaseline, seedDocumentBuffer, documentBuffers, indexRestoreSettled,
    initialLocation, linkPendingRef, setPendingLinkFile, sessionRootRef, sessionVaultIdRef, restoringRef,
    sessionSealedRef, notifyRef,
    restorePendingRef, vaultMovesRef, rootHandleRef, currentVaultIdRef, layoutRef, assetRefsRef,
    boardBaselinesRef, setTabs, setLayout,
  } = deps;
  useEffect(() => {
    if (!fileTree || fileTree.length === 0) {
      if (rootHandle && !isLoading) indexRestoreSettled();
      return;
    }
    if (sessionRootRef.current === rootHandle) return;
    if (sessionVaultIdRef.current === currentVaultId) return;
    if (!currentVaultId) return;
    // Claimed before every remaining early return — and before any await, since
    // StrictMode runs this effect twice — because persistence stays gated until
    // this pass has run, and a vault with nothing stored must still un-gate it.
    sessionRootRef.current = rootHandle;
    sessionVaultIdRef.current = currentVaultId;
    restoringRef.current = null;
    sessionSealedRef.current = null;
    const vaultFiles = collectFiles(fileTree);

    const link = linkPendingRef.current ? initialLocation : null;
    const linkHere = !!link?.file && findLinkedVault(link.vault, recentVaults)?.id === currentVaultId;
    if (!link?.file || !link.vault || linkHere) linkPendingRef.current = false;
    const linkedNode = link?.file && linkHere
      ? vaultFiles.find(f => f.path === link.file && opensInApp(f.name))
      : undefined;
    if (link && !linkPendingRef.current && !linkedNode) setPendingLinkFile(null);

    const stored = readSession(currentVaultId);
    const paths = stored ? [...new Set(stored.paths)] : [];
    if (linkedNode && !paths.includes(linkedNode.path)) paths.push(linkedNode.path);
    if (paths.length === 0) { indexRestoreSettled(); return; }

    const token = {};
    restoringRef.current = token;
    const release = () => { if (restoringRef.current === token) restoringRef.current = null; };
    const root = rootHandle!;
    const pending: PendingRestore = {
      root,
      epoch: 0,
      entries: paths.map(p => {
        const help = p === 'help-guide';
        return {
          origin: p,
          path: p,
          help,
          content: undefined,
          dropped: !help && !vaultFiles.some(f => f.path === p),
        };
      }),
    };
    restorePendingRef.current = pending;
    const indexTimer = setTimeout(indexRestoreSettled, INDEX_WAIT_MS);
    (async () => {
      try {
        const readVersions = new Map<PendingRestoreEntry, DiskVersion>();
        await Promise.all(pending.entries.map(async entry => {
          if (entry.help) {
            try { entry.content = await loadHelpDoc(); }
            catch (err) { entry.content = ''; entry.readError = describeReadError(err); }
            return;
          }
          if (entry.dropped) return;
          for (;;) {
            const path = entry.path;
            // Mirror handleFileClick: a PDF's bytes are read by its own pane —
            // decoding a PDF as UTF-8 would fill the buffer with garbage.
            if (isPdfFile(path) || isEpubFile(path) || isNativeDrawingFile(path)) {
              entry.content = '';
              break;
            }
            try {
              const { handle } = await withinFileDeadline(resolveVaultFile(root, path), path);
              const { text, version } = await readFileVersioned(handle);
              if (!entry.dropped) {
                entry.content = text;
                entry.readError = undefined;
                readVersions.set(entry, version);
              }
            } catch (err) {
              if (vaultMovesRef.current.size && !await movesSettled(vaultMovesRef.current)) throw new RestoreIncomplete('moves did not settle');
              if (!entry.dropped && entry.path !== path) continue;
              if (entry.dropped) break;
              if (isNotFound(err)) {
                entry.dropped = true;
              } else if (isFileReadTimeout(err)) {
                console.warn('A restored tab did not answer; keeping it:', path, err);
                entry.readError = describeReadError(err);
              } else if (entry.readError === undefined) {
                entry.readError = describeReadError(err);
                continue;
              } else {
                console.warn('Could not read a restored tab; keeping it:', path, err);
                entry.readError = describeReadError(err);
              }
            }
            break;
          }
        }));

        const live = new Map<PendingRestoreEntry, FileTreeFileNode>();
        for (;;) {
          if (!await movesSettled(vaultMovesRef.current)) throw new RestoreIncomplete('moves did not settle');
          const seen = pending.epoch;
          live.clear();
          for (const entry of pending.entries) {
            if (entry.help || entry.dropped || (entry.content === undefined && entry.readError === undefined)) continue;
            try {
              const { handle, parentHandle } = await withinFileDeadline(resolveVaultFile(root, entry.path), entry.path);
              if (classifyRequestedKind(entry.origin) !== classifyRequestedKind(handle.name) || isNativeDrawingFile(entry.origin) !== isNativeDrawingFile(handle.name)) {
                if (isEpubFile(handle.name) || isPdfFile(handle.name) || isNativeDrawingFile(handle.name)) { entry.content=''; entry.readError=undefined; readVersions.delete(entry); }
                else try { const read=await readFileVersioned(handle); entry.content=read.text; entry.readError=undefined; readVersions.set(entry,read.version); }
                catch(error){entry.content='';entry.readError=describeReadError(error);}
              }
              live.set(entry, { name: handle.name, kind: 'file', path: entry.path, handle, parentHandle });
            } catch (error) {
              const node = isFileReadTimeout(error) ? vaultFiles.find(f => f.path === entry.path) : undefined;
              if (node) {
                entry.content = '';
                entry.readError = describeReadError(error);
                readVersions.delete(entry);
                live.set(entry, node);
              }
            }
          }
          if (pending.epoch === seen && vaultMovesRef.current.size === 0) break;
        }
        // ── NO AWAIT from here to the merge's dispatch. ──

        if (rootHandleRef.current !== rootHandle || currentVaultIdRef.current !== currentVaultId || restorePendingRef.current !== pending) return;
        const restored: OpenTab[] = [];
        const origins: string[] = [];
        const relabel = new Map<string, string>();
        const claimed = new Set<string>();
        for (const entry of pending.entries) {
          if (claimed.has(entry.path)) continue;
          if (entry.help) {
            const id = newTabId();
            seedDocumentBuffer(id, entry.path, entry.content!, entry.readError === undefined);
            restored.push(entry.readError !== undefined
              ? { id, file: { name: 'Help Guide', isHelp: true, path: entry.path }, mode: 'read', dirty: false, readError: entry.readError, representation: representationFor('Help Guide', true, 0, true) }
              : { id, file: { name: 'Help Guide', isHelp: true, path: entry.path }, mode: 'read', dirty: false, representation: representationFor('Help Guide', true) });
          } else {
            const node = live.get(entry);
            if (!node) continue;
            const id = newTabId();
            if (entry.readError === undefined) {
              const version = readVersions.get(entry);
              if (version) setBaseline(id, version);
              else if (isPdfFile(node.name) || isNativeDrawingFile(node.name)) seedPdfBaseline(id, node.handle);
            }
            seedDocumentBuffer(id, node.path, entry.readError !== undefined ? '' : entry.content!,
              entry.readError === undefined && representationFor(node.name).bufferKind === 'text');
            restored.push(entry.readError !== undefined
              ? { id, file: node, mode: 'read', dirty: false, readError: entry.readError, representation: representationFor(node.name, false, 0, true) }
              : { id, file: node, mode: 'read', dirty: false, representation: representationFor(node.name) });
            if (entry.path !== entry.origin) relabel.set(entry.origin, entry.path);
          }
          claimed.add(entry.path);
          origins.push(entry.origin);
        }
        if (restored.length === 0 && layoutRef.current.panes.length === 0) return;
        if (rootHandleRef.current !== rootHandle) return;
        if (currentVaultIdRef.current !== currentVaultId) return;
        if (restorePendingRef.current !== pending) return;
        restorePendingRef.current = null;
        // An unreadable tab takes none: '' as a baseline would have its first
        // save after a retry diff every embed as removed. The retry seeds it.
        for (const tab of restored) {
          if (tab.readError) continue;
          const data = documentBuffers.snapshotForDocument(tab.id)?.data;
          if (typeof data === 'string' && !assetRefsRef.current.has(tab.file.path) && !boardBaselinesRef.current.capture(tab.file.path)) rememberAssetRefs(tab.file, data);
        }
        const restoredLayout = relabelPaths(restoreLayout(
          origins,
          stored?.groups,
          stored?.focus,
          stored?.sizes,
          linkedNode && origins.includes(linkedNode.path) ? linkedNode.path : stored?.active ?? null,
        ), relabel);
        release();
        setTabs(prev => {
          const open = new Set(prev.map(t => t.file.path));
          return [...restored.filter(t => !open.has(t.file.path)), ...prev];
        });
        setLayout(prev => mergeLayouts(restoredLayout, prev));
      } catch (err) {
        console.error('The saved tabs could not be restored; the saved session is kept as it was:', err);
        if (sessionRootRef.current === root && sessionVaultIdRef.current === currentVaultId) {
          sessionSealedRef.current = currentVaultId;
          notifyRef.current('Your saved tabs could not be reopened this time. They are kept as they were, and reloading tries again; tabs opened until then are not remembered.');
        }
      } finally {
        release();
        clearTimeout(indexTimer);
        if (restorePendingRef.current === pending) restorePendingRef.current = null;
        if (linkedNode) setPendingLinkFile(null);
        indexRestoreSettled();
      }
    })();
  }, [fileTree, rootHandle, currentVaultId, readFileVersioned, rememberAssetRefs, seedPdfBaseline, recentVaults, initialLocation, resolveVaultFile, isLoading, indexRestoreSettled, seedDocumentBuffer, documentBuffers, assetRefsRef, boardBaselinesRef, currentVaultIdRef, layoutRef, linkPendingRef, restorePendingRef, restoringRef, sessionSealedRef, notifyRef, rootHandleRef, sessionRootRef, sessionVaultIdRef, setLayout, setPendingLinkFile, setTabs, vaultMovesRef]);

  const sawVaultList = useRef<boolean>(false);
  useEffect(() => {
    if (recentVaults.length > 0) sawVaultList.current = true;
    if (!sawVaultList.current) return;
    pruneSessions(recentVaults.map(v => v.id));
  }, [recentVaults]);
}
