import type React from 'react';
import type { ContentChangeOptions, DiskAction, FileSystemContextValue, OpenTab } from '../types';
import type { ReaderIdentity } from '../types/reading';
import { canFlushTab } from '../utils/documentReading';
import { sourceIsNewer, type ContentSource, type DocumentBufferStore } from '../utils/documentBuffers';
import type { DocumentSessionStore } from '../utils/documentSessions';
import type { DiskVersion } from '../utils/diskVersion';
import { getPdfRenderData } from '../utils/pdfRenderCache';
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
  'readBytesVersioned' | 'readFileVersioned' | 'writeConflictCopy' | 'resolvingRef'
>, path: string, action: DiskAction) {
  const {
    tabsRef, rootHandleRef, pdfRebuildRef, diskStateRef, nativePoliciesRef, bytesGenerationsRef,
    sessionReportRef, retryUnreadTabRef, indexGraphRef, setTabs, setDiskState, setPdfRebuildNotice,
    currentPdfOwner, keepPdfBaseline, flushTab, documentBuffers, documentSessions, removeTab, hasUnsaved,
    reloadFromDisk, bumpBytesGeneration, clearSaveTimer, syncExitGuard, recoveryEvent, announce, ask, tell,
    getVaultActivation, recreateFile, resolveFileHandle, resolveVaultFile, readBytesVersioned,
    readFileVersioned, writeConflictCopy, resolvingRef,
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
    const pdf = isPdf && typeof snapshot.data === 'string' ? getPdfRenderData(path) : undefined;
    const nativeOwned = !!session && session.kind !== 'markdown' && !!source && typeof source !== 'string'
      && source.owner.documentId === id && source.owner.session === session.serial;
    return { revision: snapshot.revision, sourceRevision, session, nativeOwned, release: snapshot.release, build: async (): Promise<string | Uint8Array | Blob | null> => {
      let content = snapshot.data;
      if (typeof content === 'object' && !(content instanceof Uint8Array) && !(content instanceof Blob)) {
        content = await content.run(new AbortController().signal);
      }
      if (!isPdf || typeof content !== 'string') return content;
      if (!pdf) return null;
      const { buildAnnotatedPdfAsync } = await import('../utils/pdfBuildClient');
      return buildAnnotatedPdfAsync(pdf.original, content, pdf.overlays);
    } };
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
      const data = await captured.build();
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
      const keep = await captured.build();
      const read = isPdf || isNativeDrawingFile(file.name)
        ? { text: '', version: (await readBytesVersioned(handle)).version }
        : await readFileVersioned(handle);
      if (__BME_BENCH__) {
        try {
          if (keep !== null && keep !== read.text) reportVault({ op: 'write', path, caller: 'disk-reload-conflict' });
        } catch { /* Measurement must not interrupt a write. */ }
      }
      const copy = keep !== null && keep !== read.text ? await writeConflictCopy(path, keep) : null;
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

    // A read-only PDF has no local version to prefer. Reopen the current
    // bytes rather than leave a clean tab behind a revoked preflight.
    if (isPdf && !getPdfRenderData(path)) {
      await drain(id);
      const current = tabsRef.current.find(t => t.id === id);
      if (!current || hasUnsaved(current)) throw new Error('Pending annotations cannot be reloaded yet.');
      const disk = await readBytesVersioned(handle);
      const now = tabsRef.current.find(t => t.id === id);
      if (now) reloadFromDisk(now, '', disk.version);
      return;
    }

    // 'keep': theirs goes beside the file, then mine is saved through the
    // one save funnel — against the version just read, so a disk that moved
    // AGAIN in between raises the conflict again rather than being overwritten.
    await drain(id);
    const disk = await readBytesVersioned(handle);
    if (__BME_BENCH__) {
      try { reportVault({ op: 'write', path, caller: 'disk-keep-conflict' }); } catch { /* Measurement must not interrupt a write. */ }
    }
    const copy = await writeConflictCopy(path, disk.bytes);
    setBaseline(id, disk.version);
    const entry = pdfRebuildRef.current.get(id);
    if (entry) { entry.baseline = disk.version; entry.copyName = undefined; }
    setDiskState(id, null);
    if (entry?.value.role.kind === 'annotated' && entry.value.role.writeMark.kind === 'foreign') {
      if (!await keepPdfBaseline(entry) || !authorizeKeptPdfRole(entry.value.role, entry.value.version.hash)) return;
      entry.approved = true;
      setPdfRebuildNotice(id, { state: 'kept', generation: entry.value.role.generation, approved: true, copyName: entry.copyName });
    }
    const outcome = await flushTab(path, true);
    if (isPdf && outcome === 'written') {
      const now = tabsRef.current.find(t => t.id === id), version = getBaseline(id);
      if (now && version) reloadFromDisk(now, '', version);
    }
    if (outcome === 'changed') announce(`“${file.name}” changed on disk again. The earlier version was kept as “${shortName(copy)}”.`);
    else announce(`The version on disk was kept as “${shortName(copy)}”.`);
  } catch (err) {
    console.error('Could not resolve a document’s disk state:', path, action, err);
    void tell({ title: 'That did not work', confirmLabel: 'OK', body: <>Could not finish for <strong>{file.name}</strong>: {describeReadError(err)}</> });
  } finally {
    capturedMine?.release();
    resolvingRef.current.delete(id);
  }
}
