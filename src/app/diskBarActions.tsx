import type React from 'react';
import type { ContentChangeOptions, DiskAction, FileSystemContextValue, OpenTab } from '../types';
import type { ReaderIdentity } from '../types/reading';
import { canFlushTab } from '../utils/documentReading';
import { sourceIsNewer, type ContentSource, type DocumentBufferStore } from '../utils/documentBuffers';
import type { DocumentSessionStore } from '../utils/documentSessions';
import type { DiskVersion } from '../utils/diskVersion';
import { hashBytes } from '../utils/diskVersion';
import { fingerprintSnapshot } from '../utils/snapshotFingerprint';
import { authorizeKeptPdfRole } from '../utils/pdfRole';
import { recordFileWritten } from '../utils/fileTimes';
import { getBaseline, setBaseline } from '../utils/docBaselines';
import { bumpSaveEpoch } from '../utils/saveEpoch';
import { notifySearchChanges } from '../utils/searchChanges';
import { reportVault } from '../utils/perfHooks';
import { drain } from '../utils/unloadCoordinator';
import { isCanvasFile, isMarkdownFile, isNativeDrawingFile, isPdfFile } from '../utils/fileTypes';
import { isTextFile } from '../utils/vaultSearch';
import { hasHostedNativeOwner } from './nativeOwners';
import { describeReadError } from './readErrors';
import type { Ask, Tell } from './useAppDialogs';
import type { FlushTab, IndexGraphRef, NativePolicy, PdfRebuildEntry, RecoveryEvent, SetDiskState, SetTabs } from './types';
import type { UseDiskBarActionsDeps } from './useDiskBarActions';
import { loadChunk } from '../platform/chunkLoad';

/**
 * The DiskBar's buttons. A document only gets a DiskBar when its file changed
 * or went away on disk, so these load with the first click (useDiskBarActions).
 */
export interface DiskBarActionDeps extends UseDiskBarActionsDeps {
  resolvingRef: React.MutableRefObject<Set<string>>
}

export async function handleDiskAction(deps: Pick<DiskBarActionDeps,
  'tabsRef' | 'rootHandleRef' | 'pdfRebuildRef' | 'diskStateRef' | 'nativePoliciesRef' |
  'bytesGenerationsRef' | 'sessionReportRef' | 'retryUnreadTabRef' | 'indexGraphRef' | 'setTabs' |
  'setDiskState' | 'setPdfRebuildNotice' | 'currentPdfOwner' | 'keepPdfBaseline' | 'flushTab' |
  'documentBuffers' | 'documentSessions' | 'removeTab' | 'hasUnsaved' | 'reloadFromDisk' |
  'bumpBytesGeneration' | 'clearSaveTimer' | 'syncExitGuard' | 'recoveryEvent' | 'announce' | 'ask' |
  'tell' | 'getVaultActivation' | 'recreateFile' | 'resolveFileHandle' | 'resolveVaultFile' |
  'readBytesVersioned' | 'readFileVersioned' | 'writeFileVersioned' | 'writeConflictCopy' | 'resolvingRef'
>, path: string, action: DiskAction) {
  const {
    tabsRef, rootHandleRef, pdfRebuildRef, diskStateRef, nativePoliciesRef, bytesGenerationsRef,
    sessionReportRef, retryUnreadTabRef, indexGraphRef, setTabs, setDiskState, setPdfRebuildNotice,
    currentPdfOwner, keepPdfBaseline, flushTab, documentBuffers, documentSessions, removeTab, hasUnsaved,
    reloadFromDisk, bumpBytesGeneration, clearSaveTimer, syncExitGuard, recoveryEvent, announce, ask, tell,
    getVaultActivation, recreateFile, resolveFileHandle, resolveVaultFile, readBytesVersioned,
    readFileVersioned, writeFileVersioned, writeConflictCopy, resolvingRef,
  } = deps;
  const tab = tabsRef.current.find(t => t.file.path === path);
  if (!tab || resolvingRef.current.has(tab.id)) return;
  const { id, file } = tab;
  const graphAtCall = indexGraphRef.current;
  if (action === 'keep-pdf' || action === 'rebuild-pdf') {
    const entry = pdfRebuildRef.current.get(id);
    if (!entry || diskStateRef.current.has(id) || !currentPdfOwner(entry.identity)) return;
    if (action === 'keep-pdf') {
      setTabs(prev => prev.map(t => t.id === id ? { ...t, mode: 'read' } : t));
      return;
    }
    resolvingRef.current.add(id);
    try {
      if (!await keepPdfBaseline(entry)) return;
      const role = entry.value.role;
      if (role.kind === 'annotated' && role.writeMark.kind === 'foreign') {
        if (!authorizeKeptPdfRole(role, entry.value.version.hash)) return;
        entry.approved = true;
        setTabs(prev => prev.map(t => t.id === id ? { ...t, mode: 'edit' } : t));
      }
      setPdfRebuildNotice(id, { state: 'kept', generation: role.generation, approved: entry.approved, copyName: entry.copyName });
      if (tab.dirty) await flushTab(path, true);
    } finally { resolvingRef.current.delete(id); }
    return;
  }
  const conflictSource = documentBuffers.get(id)?.source, conflictPolicy = nativePoliciesRef.current.get(id);
  const nativeConflict = !!conflictSource && typeof conflictSource !== 'string' && !!conflictPolicy && !conflictPolicy.emergencyReadOnly
    && conflictPolicy.kind === (tab.representation.loadedKind === 'pdf' ? 'pdfInk' : tab.representation.loadedKind)
    && conflictPolicy.session === conflictSource.owner.session && conflictPolicy.activation === getVaultActivation()
    && conflictPolicy.retainedThroughGeneration === (bytesGenerationsRef.current.get(id) ?? 0)
    && hasHostedNativeOwner(documentSessions.get(id), id) && documentSessions.isLiveOwner(id, conflictSource.owner);
  if (tab.representation.loadedKind === 'epub' || !canFlushTab(tab) && tab.representation.loadedKind !== 'pdf' && !nativeConflict) {
    if (action === 'close') removeTab(path);
    else if (action === 'retry' || action === 'reload') await retryUnreadTabRef.current(path);
    return;
  }
  const isPdf = isPdfFile(file.name);
  resolvingRef.current.add(id);
  const shortName = (p: string) => p.slice(p.lastIndexOf('/') + 1);
  /** Capture before any asynchronous build; later edits belong to another revision. */
  const captureMine = () => {
    const session = documentSessions.get(id);
    const checkpoint = documentSessions.checkpoint(id);
    const prior = documentBuffers.get(id)?.source;
    if (checkpoint && typeof checkpoint !== 'string') {
      if (!documentSessions.isLiveOwner(id, checkpoint.owner)) throw new Error('The document session changed.');
      if (sourceIsNewer(checkpoint, prior)) {
        sessionReportRef.current(id, checkpoint);
      }
    }
    const source = documentBuffers.get(id)?.source;
    if (checkpoint && typeof checkpoint !== 'string' && sourceIsNewer(checkpoint, source)) {
      throw new Error('The current document revision could not be captured.');
    }
    const snapshot = documentBuffers.retainSnapshotForDocument(id);
    if (!snapshot) throw new Error('The document buffer is unavailable.');
    const sourceRevision = typeof source === 'string' ? undefined : source?.revision;
    const nativeOwned = !!session && session.kind !== 'markdown' && !!source && typeof source !== 'string'
      && source.owner.documentId === id && source.owner.session === session.serial;
    return { revision: snapshot.revision, sourceRevision, session, nativeOwned, release: snapshot.release, build: async (): Promise<string | Uint8Array | Blob | null> => {
      let content = snapshot.data;
      if (typeof content === 'object' && !(content instanceof Uint8Array) && !(content instanceof Blob)) {
        content = await content.run(new AbortController().signal);
      }
      // A PDF's text buffer is not the file: with no Annotate session there is no ink of the tab's own to build.
      return isPdf && typeof content === 'string' ? null : content;
    } };
  };
  // A PDF with no Annotate session has nothing unsaved, and its version is the bytes Original shows: the reader's
  // memory-backed copy, the only place they still exist once another program has replaced the file (it may hold saved
  // ink). Used only while it is provably the version this document last read or wrote (the baseline). Measured before:
  // every PDF took the read-only route here (it asked for the pre-native `pdfRenderCache`, which nothing fills), so Keep
  // mine reloaded the other program's file and kept no copy, and with unsaved ink it failed outright.
  const readerMine = async (): Promise<Blob | null> => {
    if (!isPdf || nativeConflict) return null;
    const { pdfReaderBytes } = await loadChunk(() => import('../pdf/session/sourceFactory'));
    const held = await pdfReaderBytes(id), baseline = getBaseline(id);
    return held && baseline && held.version.hash === baseline.hash ? held.blob : null;
  };
  let capturedMine: ReturnType<typeof captureMine> | undefined;
  try {
    if (action === 'close') {
      if (hasUnsaved(tab) && !await ask({
        title: `Close “${file.name}”?`,
        body: 'Its file was deleted on disk, so your unsaved edits exist only in this tab. Closing discards them.',
        confirmLabel: 'Close',
        danger: true,
      })) return;
      removeTab(path);
      return;
    }

    if (action === 'save') {
      await drain(id);
      const captured = capturedMine = captureMine();
      const dataRevision = captured.revision;
      const data = await captured.build() ?? await readerMine();
      if (data === null) {
        void tell({ title: 'Nothing to save', confirmLabel: 'OK', body: <>This PDF has no annotations of yours to write back. Close the tab, or put <strong>{file.name}</strong> back from wherever it went.</> });
        return;
      }
      if (__BME_BENCH__) {
        try { reportVault({ op: 'write', path, caller: 'recreate' }); } catch { /* Measurement must not interrupt a write. */ }
      }
      const result = await recreateFile(path, data);
      if (result.status === 'exists') {
        // Something new took the name meanwhile: that is a conflict to choose
        // through, not a file to write over.
        setDiskState(id, 'conflict');
        announce(`Something new is at “${file.name}” now — choose which version to keep.`);
        return;
      }
      const root = rootHandleRef.current;
      let parentHandle = file.parentHandle;
      try { if (root) ({ parentHandle } = await resolveVaultFile(root, path)); } catch { /* keep the old one */ }
      setBaseline(id, result.version);
      if (isPdf) bumpBytesGeneration(id, captured.nativeOwned && !!captured.session && documentSessions.get(id) === captured.session);
      diskStateRef.current.delete(id);
      documentBuffers.markSaved(id, dataRevision);
      if (captured.sourceRevision !== undefined && captured.session && documentSessions.get(id) === captured.session) {
        captured.session.adapter.acknowledge(captured.sourceRevision, 'written');
      }
      void recoveryEvent({ type: 'written', documentId: id, revision: dataRevision, fingerprint: result.version.hash });
      syncExitGuard();
      if (documentBuffers.revisionForDocument(id)?.revision === dataRevision) clearSaveTimer(path);
      recordFileWritten(path, result.version.lastModified);
      notifySearchChanges();
      setTabs(prev => prev.map(t => (t.id === id ? {
        ...t,
        file: { ...t.file, handle: result.handle, parentHandle },
        dirty: documentBuffers.isDirty(id),
        disk: undefined,
      } : t)));
      if (graphAtCall && graphAtCall === indexGraphRef.current && graphAtCall.activation === getVaultActivation()) {
        graphAtCall.echo.remember(path, result.version.lastModified, result.version.size);
        if (typeof data === 'string' && isMarkdownFile(file.name)) void graphAtCall.client.prime(path, result.version.lastModified, result.version.size, data).catch(() => {});
        else if (typeof data === 'string' && isTextFile(file.name) && !isCanvasFile(file.name)) void graphAtCall.client.primeText(path, result.version.lastModified, result.version.size, data).catch(() => {});
      }
      bumpSaveEpoch();
      return;
    }

    // A conflict: re-read the disk NOW — it may have moved again since.
    const handle = await resolveFileHandle(path);
    if (!handle) { setDiskState(id, 'deleted'); return; }

    if (action === 'reload') {
      await drain(id);
      const captured = capturedMine = captureMine();
      const keep = await captured.build() ?? await readerMine();
      const read = isPdf || isNativeDrawingFile(file.name)
        ? { text: '', version: (await readBytesVersioned(handle)).version }
        : await readFileVersioned(handle);
      // Bytes equal to the disk's are not a second version to keep (hashed only at the same size: a PDF can be hundreds of MB).
      const same = typeof keep === 'string' ? keep === read.text
        : !!keep && (keep instanceof Blob ? keep.size : keep.byteLength) === read.version.size
          // A Blob (a PDF, possibly hundreds of MB) goes through the chunked worker hash, never one whole-file buffer here.
          && (keep instanceof Blob ? await fingerprintSnapshot(keep) : await hashBytes(keep)) === read.version.hash;
      if (__BME_BENCH__) {
        try {
          if (keep !== null && !same) reportVault({ op: 'write', path, caller: 'disk-reload-conflict' });
        } catch { /* Measurement must not interrupt a write. */ }
      }
      const copy = keep !== null && !same ? await writeConflictCopy(path, keep) : null;
      const now = tabsRef.current.find(t => t.id === id);
      if (!now) return;
      const latest = documentSessions.checkpoint(id);
      if (documentBuffers.revisionForDocument(id)?.revision !== captured.revision || documentSessions.get(id) !== captured.session
        || (latest && typeof latest !== 'string' && latest.revision !== captured.sourceRevision)) {
        throw new Error('The document changed while its earlier version was being preserved. Keep this tab open and retry.');
      }
      reloadFromDisk(now, read.text, read.version);
      if (copy) announce(`Your version was kept as “${shortName(copy)}”.`);
      return;
    }

    // 'keep': theirs goes beside the file, then mine is written — against the version just read, so a disk that moved
    // AGAIN in between raises the conflict again rather than being overwritten.
    await drain(id);
    // The reader's copy is the tab's version only while nothing is unsaved: a board that is not live (emergency read-only,
    // a generation it no longer matches) can still hold unsaved ink in its buffer, and writing the last SAVED bytes
    // would call that version kept. Unsaved bytes go the save funnel's way below, which says so if it cannot write them.
    const unsaved = documentBuffers.isDirty(id);
    const reader = isPdf && !nativeConflict && !unsaved ? await readerMine() : null;
    if (isPdf && !nativeConflict && !unsaved && !reader) {
      // Nothing to write back: offering Keep mine would leave the other program's file under a tab that claims otherwise.
      setTabs(prev => prev.map(t => t.id === id ? { ...t, diskMineLost: true } : t));
      return;
    }
    const disk = await readBytesVersioned(handle);
    if (__BME_BENCH__) {
      try { reportVault({ op: 'write', path, caller: 'disk-keep-conflict' }); } catch { /* Measurement must not interrupt a write. */ }
    }
    const copy = await writeConflictCopy(path, disk.bytes);
    const baselineBefore = getBaseline(id);
    if (reader) {
      // The version Original shows goes back as it was, byte for byte, so the reader stays on it with nothing to reload.
      const result = await writeFileVersioned(handle, reader, disk.version);
      if (result.status === 'deleted') { setDiskState(id, 'deleted'); return; }
      if (result.status === 'changed') { announce(`“${file.name}” changed on disk again. The earlier version was kept as “${shortName(copy)}”.`); return; }
      setBaseline(id, result.version);
      const entry = pdfRebuildRef.current.get(id);
      if (entry) entry.baseline = result.version;
      recordFileWritten(path, result.version.lastModified);
      setDiskState(id, null);
      bumpSaveEpoch();
      announce(`The version on disk was kept as “${shortName(copy)}”.`);
      return;
    }
    setBaseline(id, disk.version);
    const entry = pdfRebuildRef.current.get(id);
    if (entry) { entry.baseline = disk.version; entry.copyName = undefined; }
    setDiskState(id, null);
    // Nothing was written: the file is still theirs. Put the question back rather than call it kept.
    const putBack = () => {
      if (baselineBefore) setBaseline(id, baselineBefore);
      if (entry && baselineBefore) entry.baseline = baselineBefore;
      setDiskState(id, 'conflict');
      void tell({ title: 'Your version was not saved', confirmLabel: 'OK', body: <>Could not write your version of <strong>{file.name}</strong>, so the file is still the one on disk. A copy of that one was kept as “{shortName(copy)}”.</> });
    };
    if (entry?.value.role.kind === 'annotated' && entry.value.role.writeMark.kind === 'foreign') {
      if (!await keepPdfBaseline(entry) || !authorizeKeptPdfRole(entry.value.role, entry.value.version.hash)) { putBack(); return; }
      entry.approved = true;
      setPdfRebuildNotice(id, { state: 'kept', generation: entry.value.role.generation, approved: true, copyName: entry.copyName });
    }
    // 'rewrite': a board whose ink is all saved is still the version being kept, and its checkpoint is written again.
    const rewritten = !documentBuffers.isDirty(id);
    const outcome = await flushTab(path, 'rewrite');
    if (outcome === 'written') {
      // Unsaved ink went out as the board's own save, which its live source already paints (useSaveFunnel), so the board
      // stays as it is. A rewritten checkpoint carries a write id its PDF source never acknowledged, and a later rebind
      // would refuse the file as not its own: that one reopens on the bytes, once the board's after-write step has run
      // (replaced under it, the step failed as stale and logged "PDF ink rebind failed").
      if (isPdf && rewritten) {
        try { await documentSessions.get(id)?.adapter.drain?.(); } catch { /* the reopen below replaces it either way */ }
        const now = tabsRef.current.find(t => t.id === id), version = getBaseline(id);
        if (now && version) reloadFromDisk(now, '', version);
      }
      announce(`The version on disk was kept as “${shortName(copy)}”.`);
    } else if (outcome === 'changed') announce(`“${file.name}” changed on disk again. The earlier version was kept as “${shortName(copy)}”.`);
    else if (outcome !== 'deleted') putBack();
  } catch (err) {
    console.error('Could not resolve a document’s disk state:', path, action, err);
    void tell({ title: 'That did not work', confirmLabel: 'OK', body: <>Could not finish for <strong>{file.name}</strong>: {describeReadError(err)}</> });
  } finally {
    capturedMine?.release();
    resolvingRef.current.delete(id);
  }
}
