import React, { useCallback, useLayoutEffect, useRef } from 'react';
import type { FileSystemContextValue, OpenTab } from '../types';
import type { ReaderIdentity } from '../types/reading';
import type { PdfAnnotationPreflight } from '../utils/pdfRole';
import { authorizeKeptPdfRole, revokePdfRole } from '../utils/pdfRole';
import { getBaseline, setBaseline } from '../utils/docBaselines';
import type { DiskVersion } from '../utils/diskVersion';
import { describeReadError, isNotFound } from './readErrors';
import type { PdfRebuildEntry, SetDiskState, SetTabs } from './types';

/** What the disk-state hook reads from App. */
export interface UseDiskStateDeps {
  readBytesVersioned: FileSystemContextValue['readBytesVersioned'];
  keepCopyInGarbage: FileSystemContextValue['keepCopyInGarbage'];
  setTabs: SetTabs;
  tabsRef: React.RefObject<OpenTab[]>;
  rootHandleRef: React.RefObject<FileSystemDirectoryHandle | null>;
  currentVaultIdRef: React.RefObject<string | null>;
  readerEpochRef: React.RefObject<{ root: FileSystemDirectoryHandle | null; epoch: number }>;
  invalidReaderTokens: React.RefObject<Set<string>>;
  reconcileQueueRef: React.RefObject<Promise<void>>;
  trashInFlightRef: React.RefObject<boolean>;
}

export function useDiskState(deps: UseDiskStateDeps) {
  const {
    readBytesVersioned, keepCopyInGarbage, setTabs, tabsRef, rootHandleRef,
    currentVaultIdRef, readerEpochRef, invalidReaderTokens, reconcileQueueRef, trashInFlightRef,
  } = deps;

  /**
   * Each document's standoff with its file, by document id, SYNCHRONOUSLY —
   * the mirror of OpenTab.disk, which reaches tabsRef only a commit later. The
   * save funnel must stop writing the moment a conflict or a deletion is
   * raised, and the resolutions must be able to lift it and save in one step.
   */
  const pdfRebuildRef = useRef(new Map<string, PdfRebuildEntry>());
  const pdfIoRef = useRef({ readBytesVersioned, keepCopyInGarbage });
  useLayoutEffect(() => { pdfIoRef.current = { readBytesVersioned, keepCopyInGarbage }; });
  const setPdfRebuildNotice = useCallback((id: string, notice: OpenTab['pdfRebuild']) => {
    setTabs(prev => prev.map(t => t.id === id ? { ...t, pdfRebuild: notice } : t));
  }, [setTabs]);
  const diskStateRef = useRef(new Map<string, 'conflict' | 'deleted'>());
  const setDiskState = useCallback((id: string, state: 'conflict' | 'deleted' | null) => {
    if (state) diskStateRef.current.set(id, state); else diskStateRef.current.delete(id);
    const entry = pdfRebuildRef.current.get(id);
    if (state && entry) {
      entry.approved = false;
      entry.copyName = undefined;
      const role = entry.value.role;
      if (role.kind === 'annotated' && role.writeMark.kind === 'foreign') {
        setPdfRebuildNotice(id, { state: 'foreign', generation: role.generation, reason: role.writeMark.reason });
      }
    }
    const next = state ?? undefined;
    setTabs(prev => prev.some(t => t.id === id && t.disk !== next)
      ? prev.map(t => (t.id === id ? { ...t, disk: next } : t))
      : prev);
  }, [setPdfRebuildNotice, setTabs]);

  const currentPdfOwner = useCallback((identity: ReaderIdentity) => {
    if (identity.vaultId !== currentVaultIdRef.current || identity.vaultEpoch !== readerEpochRef.current.epoch ||
        invalidReaderTokens.current.has(`${identity.documentId}|${identity.byteGeneration}`)) return undefined;
    return tabsRef.current.find(t => t.id === identity.documentId && t.file.path === identity.path &&
      t.representation.loadedKind === 'pdf' && t.representation.generation === identity.byteGeneration &&
      (t.diskRev ?? 0) === identity.diskRev);
  }, [currentVaultIdRef, invalidReaderTokens, readerEpochRef, tabsRef]);
  const onAnnotationPreflight = useCallback((identity: ReaderIdentity, value: PdfAnnotationPreflight) => {
    const tab = currentPdfOwner(identity), root = rootHandleRef.current;
    if (!tab?.file.handle || !root || value.role.generation !== value.version.hash) { revokePdfRole(value.role); return; }
    const baseline = getBaseline(tab.id);
    if (diskStateRef.current.has(tab.id) || baseline && baseline.hash !== value.version.hash) {
      revokePdfRole(value.role);
      setDiskState(tab.id, diskStateRef.current.get(tab.id) ?? 'conflict');
      return;
    }
    setBaseline(tab.id, value.version);
    const previous = pdfRebuildRef.current.get(tab.id);
    const role = value.role;
    if (role.kind !== 'annotated' || role.writeMark.kind === 'verified') {
      pdfRebuildRef.current.delete(tab.id);
      setPdfRebuildNotice(tab.id, undefined);
      return;
    }
    const same = previous && currentPdfOwner(previous.identity) && previous.root === root &&
      previous.handle === tab.file.handle && previous.baseline.hash === value.version.hash;
    const entry: PdfRebuildEntry = { identity, root, handle: tab.file.handle as FileSystemFileHandle, value,
      baseline: value.version, copyName: same ? previous.copyName : undefined, approved: !!(same && previous.approved && previous.copyName) };
    if (role.writeMark.kind === 'foreign' && entry.approved) authorizeKeptPdfRole(role, value.version.hash);
    pdfRebuildRef.current.set(tab.id, entry);
    setPdfRebuildNotice(tab.id, { state: role.writeMark.kind === 'foreign' && !entry.approved ? 'foreign' : 'kept',
      generation: role.generation, reason: role.writeMark.kind === 'foreign' ? role.writeMark.reason : undefined,
      approved: entry.approved, copyName: entry.copyName });
  }, [currentPdfOwner, setDiskState, setPdfRebuildNotice, rootHandleRef]);

  // The outer bytes, not the embedded original, are what another program edited.
  // Check both sides of the awaited close; a successful copy never grants a
  // source belonging to a tab, vault or generation that changed while copying.
  const keepPdfBaseline = useCallback(async (entry: PdfRebuildEntry, trashOwned = false): Promise<boolean> => {
    const { identity, root, handle } = entry, id = identity.documentId;
    const current = () => pdfRebuildRef.current.get(id) === entry && rootHandleRef.current === root &&
      currentPdfOwner(identity)?.file.handle === handle && !diskStateRef.current.has(id) &&
      getBaseline(id)?.hash === entry.baseline.hash;
    if (!current()) return false;
    if (entry.copyName) return true;
    if (trashInFlightRef.current && !trashOwned) {
      setPdfRebuildNotice(id, { ...tabsRef.current.find(t => t.id === id)!.pdfRebuild!, error: 'Trash is busy. Wait for it to finish, then retry.' });
      return false;
    }
    if (!trashOwned) trashInFlightRef.current = true;
    let copying = false;
    try {
      await reconcileQueueRef.current;
      if (!current()) return false;
      const disk = await pdfIoRef.current.readBytesVersioned(handle);
      if (!current()) return false;
      if (disk.version.hash !== entry.baseline.hash) { setDiskState(id, 'conflict'); return false; }
      const tab = currentPdfOwner(identity)!;
      if (!tab.file.parentHandle) throw new Error('The PDF folder is unavailable.');
      copying = true;
      const copyName = await pdfIoRef.current.keepCopyInGarbage(tab.file.parentHandle, tab.file.name, disk.bytes);
      copying = false;
      if (!current()) return false;
      const after = await pdfIoRef.current.readBytesVersioned(handle);
      if (!current()) return false;
      if (after.version.hash !== entry.baseline.hash) { setDiskState(id, 'conflict'); return false; }
      entry.copyName = copyName;
      return true;
    } catch (error) {
      if (!current()) return false;
      if (!copying && isNotFound(error)) setDiskState(id, 'deleted');
      else {
        // A failed close is not a backup, even if its partial file survived.
        entry.copyName = undefined;
        setPdfRebuildNotice(id, { ...tabsRef.current.find(t => t.id === id)!.pdfRebuild!, error: describeReadError(error) });
      }
      return false;
    } finally { if (!trashOwned) trashInFlightRef.current = false; }
  }, [currentPdfOwner, setDiskState, setPdfRebuildNotice, reconcileQueueRef, rootHandleRef, tabsRef, trashInFlightRef]);

  return {
    pdfRebuildRef,
    setPdfRebuildNotice,
    diskStateRef,
    setDiskState,
    currentPdfOwner,
    onAnnotationPreflight,
    keepPdfBaseline,
  };
}
