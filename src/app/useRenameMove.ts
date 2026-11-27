import type React from 'react';
import { useCallback } from 'react';
import { flushSync } from 'react-dom';
import type { ActiveFile, FileSystemContextValue, FileTreeNode, OpenTab } from '../types';
import type { BoardSaveBaselines } from '../utils/assetRetirement';
import { sourceIsNewer, type DocumentBufferStore } from '../utils/documentBuffers';
import type { DocumentSessionStore } from '../utils/documentSessions';
import { setBaseline } from '../utils/docBaselines';
import { classifyRequestedKind, getReadingSurface, representationFor } from '../utils/documentReading';
import { retargetDocumentViewRecords } from '../utils/documentViewRetarget';
import { renameEntry } from '../utils/entryStyle';
import { getEntryStyles } from '../utils/entryStyleStore';
import { isEpubFile, isNativeDrawingFile, isPdfFile } from '../utils/fileTypes';
import { retargetExpandedPaths } from '../utils/expandedPaths';
import { moveNotebookRenderData } from '../utils/notebookRenderCache';
import { clearPdfRenderData, getPdfRenderData, movePdfRenderData } from '../utils/pdfRenderCache';
import { joinVaultPath, parentVaultPath } from '../utils/paths';
import { retargetPending, type PendingRestore } from '../utils/pendingRestore';
import { reportVault } from '../utils/perfHooks';
import { moveReaderViewState } from '../utils/readerViewState';
import { renamePath } from '../utils/tabPanes';
import { collectFiles } from '../utils/tree';
import { drain } from '../utils/unloadCoordinator';
import { getView, moveView } from '../utils/viewRegistry';
import { describeReadError } from './readErrors';
import type { FlushTab, IndexGraphRef, RecoveryEvent, SetLayout, SetTabs } from './types';
import type { Notify } from './useAppDialogs';
import { loadChunk } from '../platform/chunkLoad';
import { pdfTurnSettled } from '../utils/pdfTurnHold';

export interface UseRenameMoveDeps {
  rootHandle: FileSystemContextValue['rootHandle'];
  rootHandleRef: React.RefObject<FileSystemDirectoryHandle | null>;
  currentVaultIdRef: React.RefObject<string | null>;
  readerEpochRef: React.RefObject<{ root: FileSystemDirectoryHandle | null; epoch: number }>;
  tabsRef: React.RefObject<OpenTab[]>;
  setTabs: SetTabs;
  setLayout: SetLayout;
  documentBuffers: DocumentBufferStore;
  documentSessions: DocumentSessionStore;
  invalidReaderTokens: React.RefObject<Set<string>>;
  saveTimersRef: React.RefObject<Map<string, ReturnType<typeof setTimeout>>>;
  assetRefsRef: React.RefObject<Map<string, { saved: Set<string>; references: Set<string> }>>;
  boardBaselinesRef: React.RefObject<BoardSaveBaselines>;
  diskStateRef: React.RefObject<Map<string, 'conflict' | 'deleted'>>;
  bufferPathIdsRef: React.RefObject<Map<string, string>>;
  flushChainsRef: React.RefObject<Map<string, Promise<unknown>>>;
  notifyRef: React.RefObject<Notify>;
  announce: (message: string) => void;
  pendingFor: (root: FileSystemDirectoryHandle | null) => PendingRestore | null;
  trackVaultMove: <T>(work: () => Promise<T>) => Promise<T>;
  indexGraphRef: IndexGraphRef;
  recoveryEvent: RecoveryEvent;
  contentOf: (path: string) => string | undefined;
  seedDocumentBuffer: (id: string, path: string, content: string, readable: boolean) => void;
  flushTab: FlushTab;
  syncExitGuard: () => void;
  clearSaveTimer: (path: string) => void;
  scheduleSave: (path: string) => void;
  preparePdfDeparture: (paths: readonly string[], trashOwned?: boolean) => Promise<boolean>;
  releaseOverwritten: (path: string, movedFrom: string, keep?: boolean) => Promise<void>;
  writeEntryStyles: (next: ReturnType<typeof getEntryStyles>) => Promise<void>;
  writeConflictCopy: FileSystemContextValue['writeConflictCopy'];
  readFileVersioned: FileSystemContextValue['readFileVersioned'];
  resolveVaultFile: FileSystemContextValue['resolveVaultFile'];
  renameFile: FileSystemContextValue['renameFile'];
  moveFile: FileSystemContextValue['moveFile'];
  requeueAssetsAffected: (path: string) => void;
  moveAssetRefs: (from: string, to: string) => void;
  rememberAssetRefs: (file: ActiveFile, content: string) => void;
}

export function useRenameMove(deps: UseRenameMoveDeps) {
  const {
    rootHandle, rootHandleRef, currentVaultIdRef, readerEpochRef, tabsRef, setTabs, setLayout,
    documentBuffers, documentSessions, invalidReaderTokens, saveTimersRef, assetRefsRef, boardBaselinesRef,
    diskStateRef, bufferPathIdsRef, flushChainsRef, notifyRef, announce, pendingFor, trackVaultMove,
    indexGraphRef, recoveryEvent, contentOf, seedDocumentBuffer, flushTab, syncExitGuard, clearSaveTimer,
    scheduleSave, preparePdfDeparture, releaseOverwritten, writeEntryStyles, writeConflictCopy,
    readFileVersioned, resolveVaultFile, renameFile, moveFile, requeueAssetsAffected, moveAssetRefs,
    rememberAssetRefs,
  } = deps;

  const retargetPaths = useCallback(async (
    fromPath: string, isFolder: boolean, newPath: string, sources: readonly string[], fromDisk = false,
  ): Promise<Array<{ from: string; to: string }>> => {
    if (!rootHandle || rootHandleRef.current !== rootHandle || newPath === fromPath) return [];
    const vaultIdAtMove = currentVaultIdRef.current ?? '';
    const prefix = `${fromPath}/`;
    const to = (path: string) => (isFolder ? newPath + path.slice(fromPath.length) : newPath);

    const pending = pendingFor(rootHandle);
    if (pending) retargetPending(pending, fromPath, isFolder, newPath, sources.map(to));

    const moving = tabsRef.current
      .filter(t => (isFolder ? t.file.path.startsWith(prefix) : t.file.path === fromPath))
      .map(t => ({ from: t.file.path, to: to(t.file.path), dirty: t.dirty, doc: t,
        revisionAtMoveStart: documentBuffers.revisionForDocument(t.id)?.revision }));

    const restyled = renameEntry(getEntryStyles(), fromPath, newPath);
    if (restyled !== getEntryStyles()) void writeEntryStyles(restyled);

    const open = new Set(tabsRef.current.map(t => t.file.path));
    for (const source of sources) {
      const dest = to(source);
      if (open.has(dest)) {
        if (!await preparePdfDeparture([dest])) return [];
        await releaseOverwritten(dest, source, fromDisk);
      }
    }

    for (const { from, to: dest, doc, revisionAtMoveStart } of moving) {
      try {
        await getReadingSurface({vaultId:vaultIdAtMove,vaultEpoch:readerEpochRef.current.epoch,documentId:doc.id,byteGeneration:doc.representation.generation})?.captureReading?.().catch(()=>{});
        if(rootHandleRef.current!==rootHandle)return [];
        invalidReaderTokens.current.add(`${doc.id}|${doc.representation.generation}`);
        const { handle, parentHandle } = await resolveVaultFile(rootHandle, dest);
        if (rootHandleRef.current !== rootHandle) return [];
        const changedKind = classifyRequestedKind(handle.name) !== doc.representation.loadedKind
          || isNativeDrawingFile(handle.name) !== isNativeDrawingFile(doc.file.name);
        if (changedKind) {
          await drain(doc.id);
          if (rootHandleRef.current !== rootHandle) return [];
          if (!tabsRef.current.some(t => t.id === doc.id && t.file.path === from)) continue;
          if (documentSessions.get(doc.id)?.adapter.hasPendingEdits()) throw new Error('Pending edits could not be drained. Keep this tab open.');
        }
        const sessionSource = documentSessions.checkpoint(doc.id);
        const buffered = documentBuffers.get(doc.id)?.source;
        if (sessionSource && typeof sessionSource !== 'string' && documentSessions.isLiveOwner(doc.id, sessionSource.owner)
          && sourceIsNewer(sessionSource, buffered)) {
          documentBuffers.report(doc.id, sessionSource);
          syncExitGuard();
        }
        let replacement: { content: string; readError?: string } | undefined;
        if (changedKind) {
          if (isEpubFile(handle.name) || isPdfFile(handle.name) || isNativeDrawingFile(handle.name)) replacement = { content: '' };
          else try { const read = await readFileVersioned(handle); replacement = { content: read.text }; setBaseline(doc.id, read.version); }
          catch (error) { replacement = { content: '', readError: describeReadError(error) }; }
        }
        let needsSave = false;
        for (;;) {
          if (rootHandleRef.current !== rootHandle) return [];
          const live = tabsRef.current.find(t => t.id === doc.id && t.file.path === from);
          if (!live) break;
          needsSave = live.dirty || documentSessions.hasPendingEdits(doc.id) || !!getView(from)?.hasPendingEdits?.() || saveTimersRef.current.has(from)
            || documentBuffers.revisionForDocument(doc.id)?.revision !== revisionAtMoveStart;
          if (!changedKind || !needsSave) break;
          await drain(doc.id);
          await getView(from)?.flushPending?.();
          if (rootHandleRef.current !== rootHandle) return [];
          if (!tabsRef.current.some(t => t.id === doc.id && t.file.path === from)) break;
          if (documentSessions.get(doc.id)?.adapter.hasPendingEdits()) throw new Error('Pending edits could not be drained. Keep this tab open.');
          const captured = documentBuffers.retainSnapshotOf(from);
          try {
          const textRevision = captured?.revision;
          const snapshot = captured?.data ?? contentOf(from);
          if (snapshot === undefined) throw Error('Pending source edits cannot be preserved. Keep this tab open.');
          let data: string | Uint8Array | Blob;
          if (typeof snapshot === 'object' && !(snapshot instanceof Uint8Array) && !(snapshot instanceof Blob)) {
            data = await snapshot.run(new AbortController().signal);
          } else if (live.representation.loadedKind === 'pdf' && typeof snapshot === 'string') {
            const pdf = getPdfRenderData(from);
            if (!pdf) throw Error('Pending PDF edits cannot be preserved yet. Keep this tab open and retry.');
            data = await (await loadChunk(() => import('../utils/pdfBuildClient'))).buildAnnotatedPdfAsync(pdf.original, snapshot, pdf.overlays);
          } else data = snapshot;
          if (data instanceof Blob) data = new Uint8Array(await data.arrayBuffer());
          if (__BME_BENCH__) {
            try { reportVault({ op: 'write', path: from, caller: 'cross-kind' }); } catch { /* Measurement must not interrupt a write. */ }
          }
          const kept = await writeConflictCopy(from, data, rootHandle);
          announce(`Your edits were kept as “${kept.slice(kept.lastIndexOf('/') + 1)}” before changing document kind.`);
          if (rootHandleRef.current !== rootHandle) return [];
          const latest = tabsRef.current.find(t => t.id === doc.id && t.file.path === from);
          if (!latest) break;
          if (documentBuffers.revisionForDocument(doc.id)?.revision === textRevision && !getView(from)?.hasPendingEdits?.()
            && !documentSessions.get(doc.id)?.adapter.hasPendingEdits()) break;
          } finally { captured?.release(); }
        }
        if (rootHandleRef.current !== rootHandle || !tabsRef.current.some(t => t.id === doc.id && t.file.path === from)) continue;
        if (changedKind && documentSessions.get(doc.id)?.adapter.hasPendingEdits()) throw new Error('Pending edits could not be drained. Keep this tab open.');
        if (tabsRef.current.some(t => t.file.path === dest)) {
          if (!await preparePdfDeparture([dest])) return [];
          await releaseOverwritten(dest, from, true);
        }
        if (changedKind && documentSessions.get(doc.id)?.adapter.hasPendingEdits()) throw new Error('Pending edits could not be drained. Keep this tab open.');
        retargetDocumentViewRecords(from, dest);
        moveReaderViewState({vaultId:vaultIdAtMove,vaultEpoch:0,documentId:doc.id,byteGeneration:doc.representation.generation,path:from,diskRev:doc.diskRev??0},from,dest);
        clearSaveTimer(from);          // cancel any save pending against the OLD handle
        // An annotated PDF's parked original + overlays are keyed by path; re-key
        // them or the next save finds nothing and silently writes nothing.
        if (changedKind) { clearPdfRenderData(from); assetRefsRef.current.delete(from); boardBaselinesRef.current.remove(from); }
        movePdfRenderData(from, dest);
        moveNotebookRenderData(from, dest);
        moveView(from, dest);
        moveAssetRefs(from, dest);
        if (bufferPathIdsRef.current.get(from) === doc.id) bufferPathIdsRef.current.delete(from);
        bufferPathIdsRef.current.set(dest, doc.id);
        if (changedKind) {
          documentSessions.release(doc.id, 'kind-change');
          if (replacement) {
            if (!documentBuffers.get(doc.id)) seedDocumentBuffer(doc.id, dest, replacement.content, !replacement.readError && representationFor(handle.name).bufferKind === 'text');
            documentBuffers.report(doc.id, replacement.content, true);
          }
          documentBuffers.setOwner(doc.id, { documentId: doc.id, session: 0 });
          documentBuffers.setReadable(doc.id, !replacement?.readError && representationFor(handle.name).bufferKind === 'text');
          void recoveryEvent({ type: 'release', documentId: doc.id });
        }
        flushSync(() => {
        setTabs(prev => prev
          .filter(t => t.file.path !== dest)
          .map(t => t.id === doc.id && t.file.path === from
            ? { ...t, file: { ...t.file, name: handle.name, path: dest, handle, parentHandle }, readerCapabilities: undefined,
                representation: changedKind ? representationFor(handle.name,false,t.representation.generation+1,!!replacement?.readError) : {...t.representation,generation:t.representation.generation+1},
                ...(replacement ? {readError: replacement.readError,dirty:false,disk:undefined,mode:'read' as const} : {}), diskRev:(t.diskRev??0)+1 }
            : t));
        setLayout(l => renamePath(l, from, dest));
        });
        if (changedKind) {
          clearPdfRenderData(from);
          assetRefsRef.current.delete(from);
          diskStateRef.current.delete(doc.id);
          if (replacement && !replacement.readError && !isNativeDrawingFile(handle.name)) rememberAssetRefs({ ...doc.file, name: handle.name, path: dest, handle, parentHandle }, replacement.content);
        }
        // Buffered edits go to the NEW handle, never the old one. They are not
        // in the copy the rename made: that read the file from disk.
        if (needsSave && !changedKind) scheduleSave(dest);
      } catch (err) {
        console.error('Could not follow a document to its new path:', from, '→', dest, err);
        notifyRef.current(`Could not finish following “${from}”. Your editor is still open: ${describeReadError(err)}`);
      }
    }
    if (vaultIdAtMove) {
      try { await recoveryEvent({ type: 'retarget', vaultId: vaultIdAtMove, from: fromPath, to: newPath, folder: isFolder }); }
      catch (error) { console.error('Could not move recovery records:', error); }
    }
    return moving.map(({ from, to: dest }) => ({ from, to: dest }));
  }, [rootHandle, pendingFor, clearSaveTimer, scheduleSave, moveAssetRefs, rememberAssetRefs, releaseOverwritten, writeEntryStyles, writeConflictCopy, contentOf, readFileVersioned, announce, resolveVaultFile, preparePdfDeparture, recoveryEvent, documentBuffers, documentSessions, syncExitGuard, seedDocumentBuffer,
    assetRefsRef, boardBaselinesRef, bufferPathIdsRef, currentVaultIdRef, diskStateRef, invalidReaderTokens, notifyRef, readerEpochRef, rootHandleRef, saveTimersRef, setLayout, setTabs, tabsRef]);
  const retargetTabs = useCallback(async (node: FileTreeNode, newPath: string) => { await retargetPaths(
    node.path, node.kind === 'directory', newPath,
    node.kind === 'directory' ? collectFiles(node.children).map(f => f.path) : [node.path],
  ); }, [retargetPaths]);

  const retargetExpanded = useCallback((node: FileTreeNode, newPath: string) => {
    if (node.kind === 'directory') retargetExpandedPaths(node.path, newPath);
  }, []);

  const pdfTurnsSettled = useCallback(async (paths: readonly string[]) => {
    for (const path of paths) {
      const tab = tabsRef.current.find(t => t.file.path === path);
      if (tab) await pdfTurnSettled(tab.id);
    }
  }, [tabsRef]);

  const handleRenameFile = useCallback((node: FileTreeNode, newName: string) => trackVaultMove(async () => {
    if (node.kind === 'file' && classifyRequestedKind(node.name) !== classifyRequestedKind(newName)) {
      const tab = tabsRef.current.find(t => t.file.path === node.path);
      if (tab) {
        await getView(node.path)?.flushPending?.();
        const result = await flushTab(node.path);
        await flushChainsRef.current.get(tab.id);
        if (['failed','changed','deleted'].includes(result) || diskStateRef.current.has(tab.id)) return false;
      }
    }
    const newPath = joinVaultPath(parentVaultPath(node.path), newName);
    const sources = node.kind === 'directory' ? collectFiles(node.children).map(f => f.path) : [node.path];
    const destinations = sources.map(path => node.kind === 'directory' ? newPath + path.slice(node.path.length) : newPath).filter(path => path !== node.path);
    await pdfTurnsSettled(sources);
    if (!await preparePdfDeparture(destinations)) return false;
    const cancelIndexMoves = indexGraphRef.noteMoves([{ from: node.path, to: newPath }]);
    let success: boolean;
    try { success = await renameFile(node, newName); }
    catch (error) { cancelIndexMoves(); throw error; }
    if (!success) { cancelIndexMoves(); return false; }
    requeueAssetsAffected(node.path);
    requeueAssetsAffected(newPath);
    retargetExpanded(node, newPath);
    await retargetTabs(node, newPath);
    return true;
  }), [renameFile, retargetTabs, retargetExpanded, trackVaultMove, flushTab, requeueAssetsAffected, preparePdfDeparture, pdfTurnsSettled, indexGraphRef, diskStateRef, flushChainsRef, tabsRef]);

  const handleMoveFile = useCallback((sourceNode: FileTreeNode, targetDirHandle: FileSystemDirectoryHandle, targetPath = '') => trackVaultMove(async () => {
    const newPath = joinVaultPath(targetPath, sourceNode.name);
    const sources = sourceNode.kind === 'directory' ? collectFiles(sourceNode.children).map(f => f.path) : [sourceNode.path];
    const destinations = sources.map(path => sourceNode.kind === 'directory' ? newPath + path.slice(sourceNode.path.length) : newPath).filter(path => path !== sourceNode.path);
    await pdfTurnsSettled(sources);
    if (!await preparePdfDeparture(destinations)) return false;
    const cancelIndexMoves = indexGraphRef.noteMoves([{ from: sourceNode.path, to: newPath }]);
    let success: boolean;
    try { success = await moveFile(sourceNode, targetDirHandle); }
    catch (error) { cancelIndexMoves(); throw error; }
    if (!success) cancelIndexMoves();
    if (success) {
      requeueAssetsAffected(sourceNode.path);
      requeueAssetsAffected(newPath);
      retargetExpanded(sourceNode, newPath);
      await retargetTabs(sourceNode, newPath);
    }
    return success;
  }), [moveFile, retargetTabs, retargetExpanded, trackVaultMove, requeueAssetsAffected, preparePdfDeparture, pdfTurnsSettled, indexGraphRef]);

  return { retargetPaths, retargetExpandedPaths, handleRenameFile, handleMoveFile };
}
