import type React from 'react';
import { useCallback, useRef } from 'react';
import type { FileSystemContextValue, OpenTab } from '../types';
import type { ReaderIdentity } from '../types/reading';
import type { DocumentBufferStore } from '../utils/documentBuffers';
import type { DocumentSessionStore } from '../utils/documentSessions';
import type { DiskVersion } from '../utils/diskVersion';
import type { Ask, Notify, Tell } from './useAppDialogs';
import type { FlushTab, NativePolicy, SetDiskState, SetTabs } from './types';
import { getSessionIdentity } from '../utils/sessionIdentity';
import { parentVaultPath } from '../utils/paths';
import { pdfEngineAvailableInBuild } from '../utils/pdfEngineAvailability';
import { drain } from '../utils/unloadCoordinator';
import { getView } from '../utils/viewRegistry';
import { getBaseline, setBaseline } from '../utils/docBaselines';
import { recordFileWritten } from '../utils/fileTimes';
import { bumpSaveEpoch } from '../utils/saveEpoch';
import { clearPdfRenderData } from '../utils/pdfRenderCache';
import { canRotatePdfRole, pdfRoleNotice } from '../utils/pdfRole';
import { PdfBuildRefused, pdfSnapshotRefusal } from '../utils/pdfBuildRefusal';
import { reportVault } from '../utils/perfHooks';
import { beginPdfRotation, endPdfRotation } from '../utils/pdfRotating';
import { publishPdfRotation, takePdfRotation } from '../utils/pdfRotationPreview';
import { ensurePdfSessionRoute, readPdfSessionRoute } from '../utils/pdfSessionRoute';
import { createCanvasSessionBridge } from '../utils/canvasSessionBridge';
import { bindRecoveryAdapter } from '../utils/recoveryAdapters';
import { describeReadError } from './readErrors';
import { hasHostedNativeOwner, RECOVERY_SESSION_BINDING } from './nativeOwners';

/** Everything the PDF actions read from App. Refs are App's own `useRef`s. */
export interface UsePdfActionsDeps {
  // useFileSystem()
  getVaultActivation: FileSystemContextValue['getVaultActivation'];
  readFileBytes: FileSystemContextValue['readFileBytes'];
  readFileSnapshot: FileSystemContextValue['readFileSnapshot'];
  readBytesVersioned: FileSystemContextValue['readBytesVersioned'];
  writeDistinctCopy: FileSystemContextValue['writeDistinctCopy'];
  // App: dialogs, vault, reader epoch
  ask: Ask;
  tell: Tell;
  notifyRef: React.RefObject<Notify>;
  rootHandleRef: React.RefObject<FileSystemDirectoryHandle | null>;
  currentVaultIdRef: React.RefObject<string | null>;
  readerEpochRef: React.RefObject<{ root: FileSystemDirectoryHandle | null; epoch: number }>;
  // useOpenDocuments
  tabsRef: React.RefObject<OpenTab[]>;
  activeTabPathRef: React.RefObject<string | null>;
  documentBuffers: DocumentBufferStore;
  documentSessions: DocumentSessionStore;
  setTabs: SetTabs;
  nativePoliciesRef: React.RefObject<Map<string, NativePolicy>>;
  bytesGenerationsRef: React.RefObject<Map<string, number>>;
  bumpBytesGeneration: (id: string, preserveNative?: boolean) => void;
  flushingRef: React.RefObject<Map<string, number>>;
  // useSaveFunnel
  flushTab: FlushTab;
  flushChainsRef: React.RefObject<Map<string, Promise<unknown>>>;
  writeFileVersionedRef: React.RefObject<FileSystemContextValue['writeFileVersioned']>;
  // useDiskState
  diskStateRef: React.RefObject<Map<string, 'conflict' | 'deleted'>>;
  setDiskState: SetDiskState;
  currentPdfOwner: (identity: ReaderIdentity) => OpenTab | undefined;
  // usePdfSeeds
  pdfSeedForRef: React.RefObject<(id: string) => Promise<DiskVersion | null> | undefined>;
}

export function usePdfActions(deps: UsePdfActionsDeps) {
  const {
    getVaultActivation, readFileBytes, readFileSnapshot, readBytesVersioned, writeDistinctCopy,
    ask, tell, notifyRef, rootHandleRef, currentVaultIdRef, readerEpochRef,
    tabsRef, activeTabPathRef, documentBuffers, documentSessions, setTabs, nativePoliciesRef,
    bytesGenerationsRef, bumpBytesGeneration, flushingRef,
    flushTab, flushChainsRef, writeFileVersionedRef,
    diskStateRef, setDiskState, currentPdfOwner,
    pdfSeedForRef,
  } = deps;

  const unsignedCopyInFlight = useRef(false);
  const handleUnsignedPdfCopy = useCallback(async (identity: ReaderIdentity, displayed: DiskVersion) => {
    if (unsignedCopyInFlight.current) return;
    const source = currentPdfOwner(identity), root = rootHandleRef.current;
    const session = source && getSessionIdentity(source.id), activation = getVaultActivation();
    if (!source?.file.handle || !source.file.parentHandle || !root || !session) throw new Error('The signed PDF is no longer open.');
    const { handle, parentHandle, name, path } = source.file;
    const current = () => {
      const tab = currentPdfOwner(identity);
      return rootHandleRef.current === root && getVaultActivation() === activation && getSessionIdentity(source.id) === session &&
        tab?.file.handle === handle && tab.file.parentHandle === parentHandle && !diskStateRef.current.has(source.id) &&
        !documentBuffers.isDirty(source.id) && !documentSessions.hasPendingEdits(source.id);
    };
    const check = () => { if (!current()) throw new DOMException('The signed PDF changed. Open it again before creating a copy.', 'AbortError'); };
    const signal = new AbortController().signal;
    let snapshot: import('../types/reading').ReadOnlyFileSnapshot | undefined;
    unsignedCopyInFlight.current = true;
    try {
      check();
      if (!pdfEngineAvailableInBuild()) throw new Error('The native PDF engine is unavailable in this build.');
      const confirmed = await ask({ title: 'Create an unsigned PDF copy?', confirmLabel: 'Create unsigned copy',
        body: 'The new copy will have no valid digital signatures. The signed original stays unchanged and is also kept as an attachment in the copy. Use the original, not the copy, to verify signatures.' });
      if (!confirmed) return;
      check();
      snapshot = await readFileSnapshot(handle as FileSystemFileHandle, signal);
      const version = await snapshot.fingerprint(signal);
      check();
      if (version.hash !== displayed.hash) { setDiskState(source.id, 'conflict'); throw new Error('The PDF changed on disk. Resolve that change before creating an unsigned copy.'); }
      const [{ prepareUnsignedPdfCopy }, { getSharedPdfPool }] = await Promise.all([
        import('../pdf/writing/unsignedCopyClient'), import('../pdf/session/startup'),
      ]);
      check();
      const prepared = await prepareUnsignedPdfCopy({ pool: getSharedPdfPool(), source: snapshot.blob.slice(0, snapshot.blob.size, 'application/pdf'),
        originalSha: version.hash, isCurrent: current, signal });
      check();
      if (prepared.kind !== 'unsigned-copy-only' || prepared.originalSha !== version.hash) throw new Error('The writer did not return a verified unsigned copy.');
      const fresh = await readFileSnapshot(handle as FileSystemFileHandle, signal);
      try {
        if ((await fresh.fingerprint(signal)).hash !== version.hash) {
          setDiskState(source.id, 'conflict'); throw new Error('The signed original changed while the copy was prepared. Nothing has been written.');
        }
      } finally { fresh.dispose(); }
      check();
      const copy = await writeDistinctCopy(parentHandle, parentVaultPath(path), name.replace(/\.pdf$/i, '') + ' (unsigned).pdf',
        new Blob([prepared.bytes], { type: 'application/pdf' }), current);
      if (current()) void tell({ title: 'Unsigned PDF copy created', confirmLabel: 'OK',
        body: `"${copy.name}" is in the same folder. The signed original is unchanged; its exact bytes are attached to the copy as "${prepared.attachmentName}".` });
    } finally { snapshot?.dispose(); unsignedCopyInFlight.current = false; }
  }, [ask, currentPdfOwner, documentBuffers, documentSessions, getVaultActivation, readFileSnapshot, setDiskState, tell, writeDistinctCopy, diskStateRef, rootHandleRef]);

  const preparePdfPrint = useCallback(async (path: string) => {
    const tab = tabsRef.current.find(t => t.file.path === path);
    const root = rootHandleRef.current;
    if (!tab || !root || tab.representation.loadedKind !== 'pdf' || !tab.file.handle) throw new Error('This PDF is no longer open.');
    const { id } = tab, generation = tab.representation.generation, handle = tab.file.handle;
    const current = () => {
      const now = tabsRef.current.find(t => t.id === id);
      return rootHandleRef.current === root && activeTabPathRef.current === path && now?.file.path === path &&
        now.file.handle === handle && now.representation.generation === generation && !diskStateRef.current.get(id);
    };
    if (!current()) throw new Error('Return to this PDF and resolve any disk conflict before printing.');
    // Native Annotate and classic canvases hold strokes the App cannot see until
    // they report them; push those into the save funnel before reading any bytes.
    try { await getView(path)?.flushPending?.(); }
    catch { throw new Error('The PDF annotations could not be saved. Keep the file open and retry before printing.'); }
    await drain(id);
    await flushChainsRef.current.get(id);
    if (!current()) throw new Error('The document changed while preparing to print.');
    const revision = documentBuffers.revisionForDocument(id)?.revision;
    // A native ink edit lives in the document session, not the buffer: the buffer can be clean while it is pending.
    const needsSave = tabsRef.current.find(t => t.id === id)?.dirty || documentBuffers.isDirty(id) || documentSessions.hasPendingEdits(id);
    if (needsSave) {
      const outcome = await flushTab(path, true);
      // 'skipped' with clean bytes is a finished save: the combined dirty flag also counts
      // background session work, which refused every print after an annotation save.
      if (outcome !== 'written' && (outcome !== 'skipped' || documentBuffers.isDirty(id))) throw new Error('The annotations could not be saved. Resolve the PDF notice before printing.');
    }
    if (!current() || documentBuffers.revisionForDocument(id)?.revision !== revision || getView(path)?.hasPendingEdits?.()
        || documentSessions.hasPendingEdits(id)) throw new Error('The document changed while preparing to print.');
    const baseline = getBaseline(id) ?? await pdfSeedForRef.current(id);
    let disk: Awaited<ReturnType<typeof readBytesVersioned>>;
    try { disk = await readBytesVersioned(handle as FileSystemFileHandle); }
    catch (error) {
      if (current() && error instanceof DOMException && error.name === 'NotFoundError') setDiskState(id, 'deleted');
      throw error;
    }
    if (current() && baseline && disk.version.hash !== baseline.hash) setDiskState(id, 'conflict');
    if (!current() || !baseline || disk.version.hash !== baseline.hash || getBaseline(id)?.hash !== baseline.hash ||
        documentBuffers.revisionForDocument(id)?.revision !== revision || getView(path)?.hasPendingEdits?.() || documentSessions.hasPendingEdits(id)) throw new Error('The saved PDF changed. Reload or resolve its disk conflict before printing.');
    const valid = () => current() && getBaseline(id)?.hash === disk.version.hash && documentBuffers.revisionForDocument(id)?.revision === revision &&
      !getView(path)?.hasPendingEdits?.() && !documentSessions.hasPendingEdits(id) && !flushingRef.current.has(id);
    const validate = async () => {
      if (!valid()) return false;
      try {
        const latest = await readBytesVersioned(handle as FileSystemFileHandle);
        if (valid() && latest.version.hash !== disk.version.hash) setDiskState(id, 'conflict');
        return valid() && latest.version.hash === disk.version.hash;
      } catch (error) {
        if (valid() && error instanceof DOMException && error.name === 'NotFoundError') setDiskState(id, 'deleted');
        return false;
      }
    };
    return { bytes: disk.bytes, valid, validate };
  }, [documentBuffers, documentSessions, flushTab, readBytesVersioned, setDiskState, activeTabPathRef, diskStateRef, flushChainsRef, flushingRef, pdfSeedForRef, rootHandleRef, tabsRef]);

  /**
   * Turn a PDF's pages a quarter at a time, and write it.
   *
   * A REAL EDIT, not a view setting (utils/pdfRotate.ts says why): the angle
   * goes into each page's `/Rotate`, so a sideways scan is fixed for the
   * reader, the annotate canvas, the thumbnails and every other app at once,
   * through the one attribute all of them already honour.
   *
   * It writes through `writeFileVersioned` against the tab's disk baseline and
   * queues on the same per-tab chain `flushTab` uses — a rotation is a save
   * like any other, and must not overtake or interleave with one.
   *
   * REFUSED on a PDF this app has annotated. Its strokes are authored against
   * the pages as they were, and `/Rotate` would turn the paper out from under
   * every mark; the honest answer is to say so rather than move the ink. The
   * role read that decides it happens HERE, at the moment of the gesture, so
   * that merely opening a PDF to read still costs no attachment read.
   */
  const rotatePdf = useCallback(async (path: string, delta: number, pageIndex?: number) => {
    const tab = tabsRef.current.find(t => t.file.path === path);
    const handle = tab?.file.handle as FileSystemFileHandle | undefined;
    const preview = tab ? takePdfRotation(tab.id) : undefined;
    if (!tab || !handle) return;
    const rootAtCall = rootHandleRef.current, vaultAtCall = currentVaultIdRef.current;
    const activationAtCall = getVaultActivation(), readerEpochAtCall = readerEpochRef.current.epoch;
    const sessionAtCall = documentSessions.get(tab.id), generationAtCall = sessionAtCall?.bytesGeneration;
    const revisionAtCall = documentBuffers.revisionForDocument(tab.id)?.revision;
    const routeAtCall = sessionAtCall ? readPdfSessionRoute(sessionAtCall) : undefined;
    if (!routeAtCall || !sessionAtCall || generationAtCall === undefined || !rootAtCall || !vaultAtCall) {
      notifyRef.current('This PDF is not ready to rotate. Try again in a moment.'); return;
    }
    // Do this before taking the per-tab write chain: a canvas checkpoint itself
    // uses that chain and would deadlock if awaited from inside a rotation.
    try { await getView(path)?.flushPending?.(); }
    catch { notifyRef.current('The PDF annotations could not be saved. Keep the file open and retry before rotating.'); return; }
    if (rootHandleRef.current !== rootAtCall || currentVaultIdRef.current !== vaultAtCall || getVaultActivation() !== activationAtCall ||
      readerEpochRef.current.epoch !== readerEpochAtCall || documentSessions.get(tab.id) !== sessionAtCall ||
      sessionAtCall.bytesGeneration !== generationAtCall || documentBuffers.revisionForDocument(tab.id)?.revision !== revisionAtCall ||
      !tabsRef.current.some(current => current.id === tab.id && current.file.path === path && current.file.handle === handle)) return;
    if (diskStateRef.current.get(tab.id)) {
      notifyRef.current('This PDF has changed on disk. Deal with that first, then rotate it.');
      return;
    }
    if (tabsRef.current.find(current => current.id === tab.id)?.dirty || documentSessions.hasPendingEdits(tab.id) || flushingRef.current.has(tab.id) || getView(path)?.hasPendingEdits?.()) {
      notifyRef.current('This PDF has annotations still being saved. Try again in a moment.');
      return;
    }

    const { id } = tab;
    const rotationRevision = documentBuffers.revisionForDocument(id)?.revision;
    const rotationSession = sessionAtCall;
    const annotationsChanged = () => documentBuffers.revisionForDocument(id)?.revision !== rotationRevision
      || documentSessions.get(id) !== rotationSession || !!rotationSession?.adapter.hasPendingEdits();
    const nativeCurrent = () => rootHandleRef.current === rootAtCall && currentVaultIdRef.current === vaultAtCall &&
      getVaultActivation() === activationAtCall && readerEpochRef.current.epoch === readerEpochAtCall &&
      documentSessions.get(id) === rotationSession && rotationSession.bytesGeneration === generationAtCall &&
      readPdfSessionRoute(rotationSession) === 'tiled' && !diskStateRef.current.has(id) && !annotationsChanged() &&
      !documentSessions.hasPendingEdits(id) && !getView(path)?.hasPendingEdits?.() &&
      tabsRef.current.some(current => current.id === id && current.file.path === path && current.file.handle === handle && !current.dirty);
    const run = async (): Promise<void> => {
      try {
        let rotated: Uint8Array;
        let expected: import('../utils/diskVersion').DiskVersion | null = null;
        if (routeAtCall === 'tiled') {
          const controller = new AbortController();
          const check = () => {
            const baseline = getBaseline(id);
            if (!nativeCurrent() || (expected && baseline && baseline.hash !== expected.hash)) {
              throw new DOMException('The PDF rotation source changed', 'AbortError');
            }
          };
          let snapshot: Awaited<ReturnType<typeof readFileSnapshot>> | undefined;
          let acquisition: Awaited<ReturnType<typeof import('../pdf/session/inkAcquisition').acquirePdfInkSource>> | undefined;
          try {
            check();
            const seed = pdfSeedForRef.current(id);
            const seeded = seed ? await seed : null;
            check();
            expected = getBaseline(id) ?? seeded ?? null;
            if (!expected) throw new Error('The PDF disk baseline is unavailable.');
            snapshot = await readFileSnapshot(handle, controller.signal);
            check();
            const version = await snapshot.fingerprint(controller.signal);
            check();
            if (version.hash !== expected.hash) { setDiskState(id, 'conflict'); return; }
            const outer = snapshot.blob.slice(0, snapshot.blob.size, snapshot.blob.type);
            const { acquirePdfInkSource } = await import('../pdf/session/inkAcquisition');
            check();
            acquisition = await acquirePdfInkSource({ outer, signal: controller.signal, isCurrent: nativeCurrent,
              token: { vaultEpoch: readerEpochAtCall, documentId: id, session: rotationSession.serial, bytesGeneration: generationAtCall } });
            check();
            if (acquisition.kind === 'read-only') {
              notifyRef.current(`This PDF cannot be rotated safely. ${acquisition.reason}`); return;
            }
            if (!acquisition.isCurrent() || acquisition.source.outerFingerprint !== expected.hash) throw new Error('The PDF source does not match its disk baseline.');
            if (acquisition.kind !== 'plain') {
              notifyRef.current('This PDF carries annotations made here, and they are drawn against the pages as they are. Rotating would move every mark, so it is left alone.'); return;
            }
            const { rotateNativePdfSource } = await import('../pdf/writing/rotationClient');
            check();
            if (!acquisition.isCurrent()) throw new DOMException('The PDF rotation source changed', 'AbortError');
            rotated = await rotateNativePdfSource({ acquisition, delta, ...(pageIndex === undefined ? {} : { pageIndices: [pageIndex] }), signal: controller.signal });
            check();
            if (!acquisition.isCurrent()) throw new DOMException('The PDF rotation source changed', 'AbortError');
          } finally {
            try { if (acquisition) await acquisition.release(); }
            finally { snapshot?.dispose(); controller.abort(); }
          }
          check();
        } else {
          const bytes = await readFileBytes(handle);
          const { readPdfRole } = await import('../utils/pdfRoleRead');
          const role = await readPdfRole(bytes);
          if (!canRotatePdfRole(role)) {
            notifyRef.current(role.kind === 'annotated'
              ? 'This PDF carries annotations made here, and they are drawn against the pages as they are. Rotating would move every mark, so it is left alone.'
              : `This PDF cannot be rotated safely. ${pdfRoleNotice(role) ?? 'Open its source notebook to change its pages.'}`);
            return;
          }
          // The classic worker owns this transferred byte array after the role read.
          const { rotatePdfAsync } = await import('../utils/pdfBuildClient');
          rotated = await rotatePdfAsync(bytes, delta, pageIndex);
          const seed = pdfSeedForRef.current(id);
          const seeded = seed ? await seed : null;
          expected = getBaseline(id) ?? seeded ?? null;
        }
        if (annotationsChanged() || documentSessions.hasPendingEdits(id) || getView(path)?.hasPendingEdits?.()) {
          notifyRef.current('This PDF has annotations still being saved. Try again in a moment.');
          return;
        }
        if (__BME_BENCH__) {
          try { reportVault({ op: 'write', path, caller: 'rotate' }); } catch { /* Measurement must not interrupt a write. */ }
        }
        const result = await writeFileVersionedRef.current(handle, rotated, expected);
        if (result.status !== 'written') {
          setDiskState(id, result.status === 'changed' ? 'conflict' : 'deleted');
          return;
        }
        if (annotationsChanged() || getView(path)?.hasPendingEdits?.()) {
          // The rotated bytes landed, but the newer ink still belongs to the
          // original geometry. Keep its owner and baseline for conflict handling.
          bumpBytesGeneration(id, documentSessions.get(id) === rotationSession);
          setDiskState(id, 'conflict');
          recordFileWritten(path, result.version.lastModified);
          notifyRef.current('The PDF rotation was saved, but newer annotations are held in conflict. Resolve the conflict to preserve your edits.');
          return;
        }
        let replacedNative = false;
        if (getBaseline(id) || tabsRef.current.some(t => t.id === id)) {
          setBaseline(id, result.version);
          const existing = documentSessions.get(id);
          const replaceNative = existing?.kind === 'pdf' && hasHostedNativeOwner(existing, id);
          const route = replaceNative ? readPdfSessionRoute(existing) : undefined;
          bumpBytesGeneration(id);
          if (replaceNative) {
            nativePoliciesRef.current.delete(id);
            documentBuffers.report(id, '', true);
            const next = documentSessions.replace(id, 'pdf', bytesGenerationsRef.current.get(id) ?? 0,
              owner => createCanvasSessionBridge(owner, () => documentBuffers.get(id)?.source ?? ''));
            ensurePdfSessionRoute(next, route);
            documentBuffers.setOwner(id, { documentId: id, session: next.serial });
            next.setSlot(RECOVERY_SESSION_BINDING, bindRecoveryAdapter(id, next.adapter), dispose => dispose());
            replacedNative = true;
          }
        }
        if (tabsRef.current.some(t => t.id === id)) publishPdfRotation(id, preview, expected?.hash, result.version.hash);
        recordFileWritten(path, result.version.lastModified);
        // The parked original predates the rotation, and the next annotation
        // save would rebuild the old orientation over this one.
        clearPdfRenderData(path);
        // `diskRev` is how a PDF pane is told its bytes are not the bytes any
        // more: it remounts on the new file, exactly as a reload from disk
        // does, and comes back on the page that was being read.
        setTabs(prev => prev.map(t => (t.id === id
          ? { ...t, dirty: false, disk: undefined, diskRev: (t.diskRev ?? 0) + 1,
              representation: replacedNative ? { ...t.representation, nativeCanvasKind: undefined, nativeCanvasSession: undefined, emergencyReadOnly: undefined } : t.representation }
          : t)));
        bumpSaveEpoch();
      } catch (err) {
        console.error('Could not rotate the PDF:', err);
        notifyRef.current(`Could not rotate this PDF: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    // The buttons say a turn is pending from here until it settles, every way
    // it can (a refusal and a conflict included) — utils/pdfRotating.ts.
    beginPdfRotation(path);
    const chains = flushChainsRef.current;
    const chained = (chains.get(id) ?? Promise.resolve()).then(run);
    chains.set(id, chained);
    try {
      await chained;
    } finally {
      if (chains.get(id) === chained) chains.delete(id);
      endPdfRotation(path);
    }
  }, [readFileBytes, readFileSnapshot, setDiskState, bumpBytesGeneration, documentSessions, documentBuffers, getVaultActivation, bytesGenerationsRef, currentVaultIdRef, diskStateRef, flushChainsRef, flushingRef, nativePoliciesRef, notifyRef, pdfSeedForRef, readerEpochRef, rootHandleRef, setTabs, tabsRef, writeFileVersionedRef]);

  const pdfDeparturesRef = useRef(new Set<string>());
  const preparePdfDeparture = useCallback(async (paths: readonly string[], trashOwned = false): Promise<boolean> => {
    for (const path of paths) {
      const tab = tabsRef.current.find(t => t.file.path === path);
      if (tab?.representation.loadedKind !== 'pdf') continue;
      if (pdfDeparturesRef.current.has(tab.id)) return false;
      pdfDeparturesRef.current.add(tab.id);
      try {
        await drain(tab.id);
        const revision = documentBuffers.revisionForDocument(tab.id)?.revision;
        const data = documentBuffers.snapshotForDocument(tab.id)?.data;
        const refusal = typeof data === 'string' ? pdfSnapshotRefusal(data) : undefined;
        const needsSave = tabsRef.current.find(t => t.id === tab.id)?.dirty || documentBuffers.isDirty(tab.id);
        const outcome = await flushTab(path, !!needsSave, true, undefined, trashOwned);
        const now = tabsRef.current.find(t => t.id === tab.id);
        if (!now || now.file.path !== path || now.representation.generation !== tab.representation.generation) return false;
        if (outcome === 'failed' || documentBuffers.revisionForDocument(tab.id)?.revision !== revision || getView(path)?.hasPendingEdits?.() ||
            // Unsaved bytes only: now.dirty also counts native session journalling, which
            // refused every trash/close of an annotated PDF whose ink had already been written.
            outcome === 'skipped' && documentBuffers.isDirty(now.id)) {
          if (outcome === 'skipped' && !refusal) notifyRef.current('These annotations have not been saved. Keep this PDF open and resolve its notice before closing it.');
          return false;
        }
      } catch (error) { notifyRef.current(`Could not finish PDF annotations: ${describeReadError(error)}`); return false; }
      finally { pdfDeparturesRef.current.delete(tab.id); }
    }
    return true;
  }, [documentBuffers, flushTab, notifyRef, tabsRef]);

  // Keep the gesture synchronous for the directory picker/permission prompt.
  // A refused PDF revision stays in its current vault instead of being dropped
  // by the workspace reset before an asynchronous refusal can reach it.
  const canLeavePdfVault = useCallback(() => {
    const tab = tabsRef.current.find(t => t.representation.loadedKind === 'pdf' &&
      (t.dirty || documentBuffers.isDirty(t.id) || flushingRef.current.has(t.id) || getView(t.file.path)?.hasPendingEdits?.()));
    if (!tab) return true;
    const snapshot = documentBuffers.snapshotForDocument(tab.id)?.data;
    const refusal = typeof snapshot === 'string' ? pdfSnapshotRefusal(snapshot) : undefined;
    notifyRef.current(refusal ? new PdfBuildRefused(refusal).message : 'Keep this vault open until its PDF annotations are saved. Resolve any notice first, or wait for the pending save.');
    return false;
  }, [documentBuffers, flushingRef, notifyRef, tabsRef]);

  return {
    handleUnsignedPdfCopy, preparePdfPrint, rotatePdf, preparePdfDeparture, canLeavePdfVault,
  };
}
