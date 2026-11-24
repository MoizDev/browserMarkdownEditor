import type React from 'react';
import { useCallback, useEffect, useRef } from 'react';
import type { ContentChangeOptions, FileSystemContextValue, OpenTab } from '../types';
import type { NativeCanvasHost } from '../types/nativeCanvas';
import type { ReaderIdentity } from '../types/reading';
import { sourceIsNewer, type ContentSource, type DeferredSource, type DocumentBufferStore } from '../utils/documentBuffers';
import type { DocumentSessionStore } from '../utils/documentSessions';
import type { BoardSaveBaselines } from '../utils/assetRetirement';
import type { DiskVersion } from '../utils/diskVersion';
import { canFlushTab, canReadTabText, canUpdateTabContent } from '../utils/documentReading';
import { assetEmbeds, assetReferences } from '../utils/assets';
import { getBaseline, setBaseline } from '../utils/docBaselines';
import { recordFileWritten } from '../utils/fileTimes';
import { bumpSaveEpoch } from '../utils/saveEpoch';
import { notifySearchChanges } from '../utils/searchChanges';
import { isTextFile } from '../utils/vaultSearch';
import { isCanvasFile, isMarkdownFile } from '../utils/fileTypes';
import { getPdfRenderData } from '../utils/pdfRenderCache';
import { canRebuildAnnotatedPdf } from '../utils/pdfRole';
import { PdfBuildRefused, pdfSnapshotRefusal } from '../utils/pdfBuildRefusal';

/** A save a newer revision overtook while it ran (the person kept drawing): not a failure, the newer change saves next. Told as
 *  'not saved' it raised 'Could not continue' on every stroke drawn during a converted notebook's first save (round 8 matrix). */
class SaveSuperseded extends Error {}
import { anyPending, checkpointSessions, drain, drainAll, subscribePending } from '../utils/unloadCoordinator';
import { perfRoot, reportVault } from '../utils/perfHooks';
import type { Notify, Tell } from './useAppDialogs';
import type { IndexGraphRef, NativePolicy, PdfRebuildEntry, ReconcileJob, RecoveryEvent, SetDiskState, SetTabs } from './types';
import { hasHostedNativeOwner, hasWritableHostedNativeOwner } from './nativeOwners';
import { describeReadError } from './readErrors';
import { clearSaveNotice, showSaveNotice } from '../utils/saveNotices';
import { tracksAssets } from './tracksAssets';
import { loadChunk } from '../platform/chunkLoad';

/** Everything the save funnel reads from App. Refs are App's own `useRef`s. */
export interface UseSaveFunnelDeps {
  // useFileSystem()
  writeFile: FileSystemContextValue['writeFile'];
  writeFileBytes: FileSystemContextValue['writeFileBytes'];
  writeFileVersioned: FileSystemContextValue['writeFileVersioned'];
  writeConflictCopy: FileSystemContextValue['writeConflictCopy'];
  getVaultActivation: FileSystemContextValue['getVaultActivation'];
  // App: vault, index graph, recovery journal, trash
  currentVaultIdRef: React.RefObject<string | null>;
  rootHandleRef: React.RefObject<FileSystemDirectoryHandle | null>;
  indexGraphRef: IndexGraphRef;
  recoveryEvent: RecoveryEvent;
  trashInFlightRef: React.RefObject<boolean>;
  // App: dialogs and the status line
  notifyRef: React.RefObject<Notify>;
  tellRef: React.RefObject<Tell>;
  setSaveStatus: (message: string) => void;
  showStatus: (message: string, ms: number) => void;
  // useOpenDocuments
  tabsRef: React.RefObject<OpenTab[]>;
  setTabs: SetTabs;
  documentBuffers: DocumentBufferStore;
  documentSessions: DocumentSessionStore;
  sessionReportRef: React.RefObject<(documentId: string, source: ContentSource, options?: ContentChangeOptions) => void>;
  nativeTransitionRef: React.RefObject<(documentId: string, source: DeferredSource, revision: number, prior: ContentSource) => void>;
  nativePoliciesRef: React.RefObject<Map<string, NativePolicy>>;
  bytesGenerationsRef: React.RefObject<Map<string, number>>;
  bumpBytesGeneration: (id: string, preserveNative?: boolean) => void;
  visiblePathsRef: React.RefObject<string[]>;
  saveTimersRef: React.RefObject<Map<string, ReturnType<typeof setTimeout>>>;
  flushingRef: React.RefObject<Map<string, number>>;
  nativeCanvasHost: NativeCanvasHost;
  // useDiskState
  pdfRebuildRef: React.RefObject<Map<string, PdfRebuildEntry>>;
  diskStateRef: React.RefObject<Map<string, 'conflict' | 'deleted'>>;
  setDiskState: SetDiskState;
  setPdfRebuildNotice: (id: string, notice: OpenTab['pdfRebuild']) => void;
  currentPdfOwner: (identity: ReaderIdentity) => OpenTab | undefined;
  keepPdfBaseline: (entry: PdfRebuildEntry, trashOwned?: boolean) => Promise<boolean>;
  // usePdfSeeds
  pdfSeedForRef: React.RefObject<(id: string) => Promise<DiskVersion | null> | undefined>;
  pdfSeedsRef: React.RefObject<Map<string, Promise<DiskVersion | null>>>;
  // useAssetLifecycle
  assetRefsRef: React.RefObject<Map<string, { saved: Set<string>; references: Set<string> }>>;
  boardBaselinesRef: React.RefObject<BoardSaveBaselines>;
  assetActivationsRef: React.RefObject<WeakMap<FileSystemDirectoryHandle, number>>;
  assetReferenceRevisionRef: React.RefObject<number>;
  reconcileQueueRef: React.RefObject<Promise<void>>;
  queueReconcile: (job: ReconcileJob) => void;
  requeueAssetsAffected: (path: string) => void;
}

export function useSaveFunnel(deps: UseSaveFunnelDeps) {
  const {
    writeFile, writeFileBytes, writeFileVersioned, writeConflictCopy, getVaultActivation,
    currentVaultIdRef, rootHandleRef, indexGraphRef, recoveryEvent, trashInFlightRef,
    notifyRef, tellRef, setSaveStatus, showStatus,
    tabsRef, setTabs, documentBuffers, documentSessions, sessionReportRef, nativeTransitionRef,
    nativePoliciesRef, bytesGenerationsRef, bumpBytesGeneration, visiblePathsRef, saveTimersRef,
    flushingRef, nativeCanvasHost,
    pdfRebuildRef, diskStateRef, setDiskState, setPdfRebuildNotice, currentPdfOwner, keepPdfBaseline,
    pdfSeedForRef, pdfSeedsRef,
    assetRefsRef, boardBaselinesRef, assetActivationsRef, assetReferenceRevisionRef, reconcileQueueRef,
    queueReconcile, requeueAssetsAffected,
  } = deps;

  // ── Per-tab autosave ────────────────────────────────────────────────────
  // Write callbacks stay stable across pane and graph updates.
  const writeFileRef = useRef(writeFile);
  const writeFileBytesRef = useRef(writeFileBytes);
  useEffect(() => { writeFileRef.current = writeFile; }, [writeFile]);
  useEffect(() => { writeFileBytesRef.current = writeFileBytes; }, [writeFileBytes]);

  const clearSaveTimer = useCallback((path: string) => {
    const pending = saveTimersRef.current.get(path);
    if (pending) { clearTimeout(pending); saveTimersRef.current.delete(path); }
  }, [saveTimersRef]);

  // The versioned write and the conflict copy, through refs for the reason
  // writeFile is: flushTab — and every timer downstream of it — keeps its identity.
  const writeFileVersionedRef = useRef(writeFileVersioned);
  const writeConflictCopyRef = useRef(writeConflictCopy);
  useEffect(() => { writeFileVersionedRef.current = writeFileVersioned; }, [writeFileVersioned]);
  useEffect(() => { writeConflictCopyRef.current = writeConflictCopy; }, [writeConflictCopy]);
  /**
   * Writes are SERIALIZED per document (by id, so a rename mid-write cannot
   * split one document's chain in two). Two overlapping writes to one file —
   * a timer and ⌘S, or a long PDF build and the next stroke — used to land in
   * completion order; now each also moves the disk baseline, and the second
   * must check against the version the first wrote, not race it.
   */
  const flushChainsRef = useRef(new Map<string, Promise<unknown>>());
  // Documents whose failed save the person was already told about: told once, until a save of it succeeds again.
  const guardedRef = useRef(false);
  const beforeUnload = useCallback((event: BeforeUnloadEvent) => {
    event.preventDefault();
    event.returnValue = '';
  }, []);
  const syncExitGuard = useCallback(() => {
    const pending = anyPending() || flushingRef.current.size > 0
      || tabsRef.current.some(tab => documentSessions.hasPendingEdits(tab.id));
    if (pending === guardedRef.current) return;
    guardedRef.current = pending;
    if (pending) window.addEventListener('beforeunload', beforeUnload);
    else window.removeEventListener('beforeunload', beforeUnload);
  }, [beforeUnload, documentSessions, flushingRef, tabsRef]);
  const pendingWritesRef = useRef(new Map<string, { revision: number; promise: Promise<'written' | 'changed' | 'deleted' | 'skipped' | 'failed'> }>());

  /**
   * Keep a closing document's unsaved text when its file can no longer take it
   * — it changed on disk, or is gone — as a `(conflict)` copy beside it. The
   * tab is going away, so there is nobody left to ask, and dropping the edits
   * would be the silent loss this whole mechanism exists to prevent.
   */
  const keepClosingEdits = useCallback(async (
    root: FileSystemDirectoryHandle | null, path: string, name: string, data: string | Uint8Array | Blob, guard?: () => boolean,
  ) => {
    try {
      if (__BME_BENCH__) {
        try { reportVault({ op: 'write', path, caller: 'closing-conflict' }); } catch { /* Measurement must not interrupt a write. */ }
      }
      const copy = await writeConflictCopyRef.current(path, data, root, guard);
      // A dialog, not the status line: the tab is gone, and the edits are now in
      // a file the reader did not ask for — they must hear where.
      void tellRef.current({
        title: 'Your unsaved edits were kept',
        confirmLabel: 'OK',
        body: `“${name}” changed or was deleted on disk, so your unsaved edits were kept beside it as “${copy.slice(copy.lastIndexOf('/') + 1)}”.`,
      });
      return true;
    } catch (err) {
      console.error('Could not keep the unsaved edits of a closing document:', path, err);
      notifyRef.current(`Could not keep the unsaved edits to “${name}”: ${describeReadError(err)}`);
      return false;
    }
  }, [notifyRef, tellRef]);

  // Drain a tab's serializer, then write the latest funnel buffer to its OWN handle.
  // Closing callers keep the tab and its canvas alive until this settles.
  //
  // Every write is VERSIONED: it lands only if the file is still what this
  // document last read or wrote (FileSystemContext.writeFileVersioned). A file
  // changed on disk puts the tab into 'conflict', a deleted one into 'deleted'
  // — the DiskBar asks the reader — and nothing autosaves it until they choose.
  // `closing`: the tab is going away (close, trash, vault switch), so a write
  // that cannot land keeps the text as a `(conflict)` copy instead.
  // `vaultRoot`: the vault the document belongs to, for a closing copy — the
  // vault switch passes the one being left, since by then the context already
  // names the next one.
  const flushTab = useCallback(async (
    path: string | null, force: boolean | 'rewrite' = false, closing = false,
    vaultRoot?: FileSystemDirectoryHandle | null, trashOwned = false, serializerCallback = false,
  ): Promise<'written' | 'changed' | 'deleted' | 'skipped' | 'failed'> => {
    if (!path) return 'skipped';
    const initial = tabsRef.current.find(t => t.file.path === path);
    if (!initial || initial.file.isHelp || !initial.file.handle || initial.representation.emergencyReadOnly) return 'skipped';
    // An old-format board is never written, by any route: not a save, a close, a ⌘S or a vault switch (utils/oldBoards.ts).
    // Before the drain and the checkpoint below, whose board source would otherwise read as newer than the file's text.
    if (initial.representation.oldBoard || nativePoliciesRef.current.get(initial.id)?.oldBoard) return 'skipped';
    // Save captures immediately. Only leaving the document awaits unfinished
    // work; legacy serializers retain their migration fallback until attached.
    const initialSource = documentBuffers.get(initial.id)?.source;
    const legacyCanvas = (isCanvasFile(initial.file.name) || initial.representation.loadedKind === 'pdf') && typeof initialSource === 'string';
    if (!serializerCallback && (closing || legacyCanvas)) try { await drain(initial.id); } catch (error) {
      console.error('Could not serialize pending document:', error);
      return 'failed';
    }
    const tab = tabsRef.current.find(t => t.id === initial.id && t.file.path === path);
    if (!tab) return 'skipped';
    clearSaveTimer(path);
    // A tab restored without its text (OpenTab.readError) has an empty buffer
    // that is NOT the file: ⌘S forces a flush of the focused tab, and writing
    // that '' would erase a note the app merely failed to read.
    try {
      const source = documentSessions.checkpoint(tab.id);
      const prior = documentBuffers.get(tab.id)?.source;
      if (source && typeof source !== 'string' && documentSessions.isLiveOwner(tab.id, source.owner)
        && sourceIsNewer(source, prior)) {
        sessionReportRef.current(tab.id, source);
        clearSaveTimer(path);
      }
    } catch (error) { console.error('Could not capture document:', error); return 'failed'; }
    const pendingRevision = documentBuffers.revisionForDocument(tab.id);
    const pending = documentSessions.hasPendingEdits(tab.id);
    const bufferedSource = documentBuffers.get(tab.id)?.source;
    const nativeSource = bufferedSource !== undefined && typeof bufferedSource !== 'string' && documentSessions.get(tab.id)?.kind !== 'markdown';
    const policy = nativePoliciesRef.current.get(tab.id);
    const nativeAuthorized = nativeSource && policy && !policy.emergencyReadOnly && policy.session === bufferedSource.owner.session
      && policy.kind === (tab.representation.loadedKind === 'pdf' ? 'pdfInk' : tab.representation.loadedKind)
      && policy.activation === getVaultActivation() && policy.retainedThroughGeneration === (bytesGenerationsRef.current.get(tab.id) ?? 0)
      && hasWritableHostedNativeOwner(documentSessions.get(tab.id), tab.id) && documentSessions.isLiveOwner(tab.id, bufferedSource.owner);
    if (nativeSource && !nativeAuthorized) return 'skipped';
    // Native pending work includes the own-save source rebind, not just new
    // content. Rewriting an already-acknowledged checkpoint bumps PDF bytes
    // without a second checkpoint acknowledgement, stranding that live source.
    // Keep mine is the exception: the file is somebody else's now, and the saved checkpoint is the version being kept
    // (its caller replaces a PDF's session after the write, so no live source is left stranded).
    const rewrite = force === 'rewrite' && nativeSource;
    if (nativeSource && !documentBuffers.isDirty(tab.id) && !rewrite) return 'skipped';
    const acceptedFlushable = documentBuffers.get(tab.id)?.flushable;
    if (tab.representation?.emergencyReadOnly || (!canFlushTab(tab) && !((pending || documentBuffers.isDirty(tab.id) || rewrite) && acceptedFlushable && tab.representation.status === 'ready'
      && (nativeAuthorized || tab.representation.loadedKind === 'pdf' && getPdfRenderData(path))))) return 'skipped';
    const held = diskStateRef.current.get(tab.id);
    if (!tab.dirty && !documentBuffers.isDirty(tab.id) && !pending && !force) return 'skipped';
    // A drain reports into the synchronous funnel before React commits its tab.
    let captured;
    try { captured = documentBuffers.retainSnapshotOf(path); }
    catch (error) { console.error('Could not capture document:', error); return 'failed'; }
    try {
    if (!captured || (!nativeSource && typeof captured.data !== 'string')) {
      console.error('Could not capture document: its buffer is unavailable.');
      return 'failed';
    }
    const snapshot = typeof captured.data === 'string' ? captured.data : '';
    const revision = captured?.revision ?? pendingRevision?.revision ?? 0;
    const bufferRevision = captured?.revision;
    const sourceRevision = typeof bufferedSource === 'string' ? undefined : bufferedSource?.revision;
    const sessionAtCall = documentSessions.get(tab.id);
    // An old annotated PDF's first rebuild keeps its original in Trash; a drawing or notebook is never converted in place.
    const conversionDigest = nativeSource && tab.representation.loadedKind === 'pdf' ? tab.representation.legacyOriginalSha256 : undefined;
    const conversionIdentity = conversionDigest ? nativeCanvasHost.identity(tab.id) : undefined;
    const existingWrite = pendingWritesRef.current.get(tab.id);
    if (pending && existingWrite?.revision === revision) return existingWrite.promise;
    if (__BME_BENCH__) {
      try {
        const root = perfRoot();
        const funnel = (root.funnel ??= { reports: {}, rejected: {}, ownerlessReports: {}, reads: 0 }) as { reads: number };
        funnel.reads++;
      } catch { /* Measurement must not interrupt a save. */ }
    }
    const { id, file } = tab;
    const handle = tab.file.handle as FileSystemFileHandle;
    const isPdf = tab.representation.status === 'ready' && tab.representation.loadedKind === 'pdf';
    // An annotated PDF tab's buffer is not the file; the file on disk is a
    // real PDF, rebuilt from the pristine original + the overlays the canvas
    // parked for us. No render data yet means the canvas has not reported a
    // change — which is also every PDF only ever read.
    const nativePdf = nativeSource && tab.representation.status === 'ready' && tab.representation.loadedKind === 'pdf';
    const pdfData = isPdf && !nativeSource ? getPdfRenderData(path) : undefined;
    const pdfEntry = isPdf && !nativeSource ? pdfRebuildRef.current.get(id) : undefined;
    const pdfOriginal = pdfData?.original;
    const pdfWriteAllowed = () => {
      if (!isPdf) return true;
      if (!nativeSource) return !!pdfOriginal && canRebuildAnnotatedPdf(pdfOriginal);
      const latest = tabsRef.current.find(item => item.id === id), active = nativePoliciesRef.current.get(id);
      if (!nativePdf || !latest || latest.file.path !== path || latest.file.handle !== handle
        || latest.representation.status !== 'ready' || latest.representation.loadedKind !== 'pdf'
        || active !== policy || !active || active.kind !== 'pdfInk' || active.emergencyReadOnly
        || active.activation !== getVaultActivation() || active.session !== sessionAtCall?.serial
        || active.retainedThroughGeneration !== (bytesGenerationsRef.current.get(id) ?? 0)
        || documentSessions.get(id) !== sessionAtCall || !hasHostedNativeOwner(sessionAtCall, id)
        || !active.pdfWriteAuthority) return false;
      try { return active.pdfWriteAuthority.canWrite(); } catch { return false; }
    };
    const assertPdfWriteAuthority = () => {
      if (!pdfWriteAllowed()) throw new Error('The PDF is now read-only. Its unsaved annotations have not been written.');
    };
    if (!pdfWriteAllowed()) return 'skipped';
    if (isPdf) {
      const refusal = nativeSource ? undefined : pdfSnapshotRefusal(snapshot);
      if (refusal) { setSaveStatus('Not saved'); showSaveNotice(id, new PdfBuildRefused(refusal).message); return 'skipped'; }
      if (!closing && pdfEntry?.value.role.kind === 'annotated' && pdfEntry.value.role.writeMark.kind === 'foreign' && !pdfEntry.approved) return 'skipped';
    }
    // Captured now too: a vault switch clears every baseline right after its
    // flushes, and this write still has to be checked against this one.
    const baselineAtCall = getBaseline(id);
    // A PDF's fingerprint starts here if this is the first write to need one.
    const seedAtCall = pdfSeedForRef.current(id);
    const rootAtCall = vaultRoot ?? rootHandleRef.current;
    const activationAtCall = rootAtCall ? assetActivationsRef.current.get(rootAtCall) ?? -1 : -1;
    const graphAtCall = indexGraphRef.current;

    const buildCaptured = async (): Promise<string | Uint8Array | Blob> => {
      const data = captured?.data ?? snapshot;
      if (typeof data === 'object' && !(data instanceof Uint8Array) && !(data instanceof Blob)) return data.run(new AbortController().signal);
      return data;
    };

    // Held: the DiskBar is asking. Nothing is written over the file — but a tab
    // going away keeps its text beside it rather than taking it along.
    if (held) {
      if (!closing) return 'skipped';
      try {
        const data = isPdf && !nativeSource
          ? await (await loadChunk(() => import('../utils/pdfBuildClient'))).buildAnnotatedPdfAsync(pdfData!.original, snapshot, pdfData!.overlays)
          : await buildCaptured();
        assertPdfWriteAuthority();
        if (nativeSource && (!sessionAtCall || documentSessions.get(id) !== sessionAtCall || !hasWritableHostedNativeOwner(sessionAtCall, id))) return 'failed';
        if (pdfEntry && (!currentPdfOwner(pdfEntry.identity) || pdfRebuildRef.current.get(id) !== pdfEntry || getBaseline(id)?.hash !== pdfEntry.baseline.hash)) return 'failed';
        if (!await keepClosingEdits(rootAtCall, path, file.name, data, isPdf ? pdfWriteAllowed : undefined)) return 'failed';
        return held === 'conflict' ? 'changed' : 'deleted';
      } catch (error) {
        if (error instanceof PdfBuildRefused) { setSaveStatus('Not saved'); notifyRef.current(error.message); return 'skipped'; }
        notifyRef.current(`Could not keep annotations: ${describeReadError(error)}`);
        return 'failed';
      }
    }

    // Capture the record after the drain and before a close can remove it.
    // Queued writes share it and advance its saved set only after a write
    // lands: a failed first write must not become the second's baseline.
    const boardBaseline = !nativeSource && !isPdf && isCanvasFile(file.name) ? boardBaselinesRef.current.capture(path) : undefined;
    const assetBaseline = !nativeSource && !isPdf && tracksAssets(file) ? assetRefsRef.current.get(path) : undefined;
    const embedsAfter = assetBaseline && assetEmbeds(snapshot);
    const referencesAfter = assetBaseline && assetReferences(snapshot);

    const write = async (): Promise<'written' | 'changed' | 'deleted' | 'skipped' | 'failed'> => {
      try {
        // A legacy file's first rebuild is the destructive boundary, not entry
        // to Annotate. An oversized revision above never even creates a copy.
        if (pdfEntry && !closing && !await keepPdfBaseline(pdfEntry, trashOwned)) return diskStateRef.current.get(id) === 'deleted' ? 'deleted' : diskStateRef.current.has(id) ? 'changed' : 'skipped';
        if (pdfEntry && closing && !held && !await keepPdfBaseline(pdfEntry, trashOwned)) return 'skipped';
        if (!closing && diskStateRef.current.has(id)) return 'skipped';
        // Off the main thread: stamping overlays costs ~150ms per annotated
        // page (~4.2s at 30 pages), which would land as stutter under the pen.
        const data = isPdf && !nativeSource
          ? await (await loadChunk(() => import('../utils/pdfBuildClient'))).buildAnnotatedPdfAsync(pdfData!.original, snapshot, pdfData!.overlays)
          : await buildCaptured();
        // A PDF's baseline is hashed in the background at open; never write
        // without it (seedPdfBaseline).
        const seed = pdfSeedsRef.current.get(id) ?? seedAtCall;
        const seeded = seed ? await seed : null;
        const expected = getBaseline(id) ?? baselineAtCall ?? seeded ?? null;
        // An awaited build/baseline must not resurrect a revoked role capability.
        if (!pdfWriteAllowed() || isPdf && !closing && diskStateRef.current.has(id)) return 'skipped';
        if (nativeSource && (!sessionAtCall || documentSessions.get(id) !== sessionAtCall || !hasWritableHostedNativeOwner(sessionAtCall, id))) return 'skipped';
        if (pdfEntry && (!currentPdfOwner(pdfEntry.identity) || pdfRebuildRef.current.get(id) !== pdfEntry || getBaseline(id)?.hash !== pdfEntry.baseline.hash)) return 'skipped';
        if (conversionDigest) {
          if (!expected) throw new Error('The conversion baseline is unavailable.');
          if (expected.hash === conversionDigest) {
            if (!conversionIdentity || conversionIdentity.session !== sessionAtCall?.serial) throw new Error('The conversion session is unavailable.');
            if (trashInFlightRef.current && !trashOwned) throw new Error('Trash is busy; retry the conversion save.');
            if (!trashOwned) trashInFlightRef.current = true;
            try {
              await reconcileQueueRef.current;
              const stillCurrent = () => {
                if (!nativeCanvasHost.isCurrent(conversionIdentity) || !pdfWriteAllowed() || rootHandleRef.current !== rootAtCall
                  || documentSessions.get(id) !== sessionAtCall || !hasWritableHostedNativeOwner(sessionAtCall, id)
                  || !tabsRef.current.some(t => t.id === id && t.file.path === path && t.file.handle === handle)
                  || getBaseline(id)?.hash !== expected.hash || diskStateRef.current.has(id)
                  || documentBuffers.revisionForDocument(id)?.revision !== revision) return false;
                const latest = sessionAtCall.adapter.checkpoint();
                return !sourceIsNewer(latest, bufferedSource);
              };
              if (!stillCurrent()) throw new SaveSuperseded('The conversion source changed');
              const signal = new AbortController().signal;
              const original = await nativeCanvasHost.acquireBytes(conversionIdentity, signal);
              if (!stillCurrent()) throw new SaveSuperseded('The conversion source changed');
              await nativeCanvasHost.keepConversionBackup(conversionIdentity, original, conversionDigest, signal);
              if (!stillCurrent()) throw new SaveSuperseded('The conversion source changed');
            } finally { if (!trashOwned) trashInFlightRef.current = false; }
          }
        }
        if (__BME_BENCH__) {
          try { reportVault({ op: 'write', path, caller: 'flushTab' }); } catch { /* Measurement must not interrupt a write. */ }
        }
        // Conversion backup and the versioned write can both yield after a
        // permission revocation. A kept copy is a write too, not an escape hatch.
        assertPdfWriteAuthority();
        if (nativeSource && (!sessionAtCall || documentSessions.get(id) !== sessionAtCall || !hasWritableHostedNativeOwner(sessionAtCall, id))) return closing ? 'failed' : 'skipped';
        if (pdfEntry && (!currentPdfOwner(pdfEntry.identity) || pdfRebuildRef.current.get(id) !== pdfEntry || getBaseline(id)?.hash !== pdfEntry.baseline.hash)) return closing ? 'failed' : 'skipped';
        const result = await writeFileVersionedRef.current(handle, data, expected);
        if (result.status !== 'written') {
          if (closing) { assertPdfWriteAuthority(); if (!await keepClosingEdits(rootAtCall, path, file.name, data, isPdf ? pdfWriteAllowed : undefined)) return 'failed'; }
          else setDiskState(id, result.status === 'changed' ? 'conflict' : 'deleted');
          return result.status;
        }
        // Only while the document is still open: a close drops its entry, and
        // this must not put one back (getBaseline is set from open to close).
        if (getBaseline(id) || tabsRef.current.some(t => t.id === id)) {
          setBaseline(id, result.version);
          // A self-save of annotated-PDF ink keeps the byte generation: the writer builds every save from the pristine
          // source plus the board's full ink, so the bytes just written are what this pane already shows, and a new
          // generation would rebind the pane — new immutable tokens, an opaque Updating cover with input detached —
          // dropping any press in the ~150 ms after each autosave (whiteboard's person-click matrix: 2 of 6 PDF rows).
          // The versioned baseline above still moves, and any outside change still bumps and rebinds. Original catches
          // up once it is what shows the file, with no board on screen (PdfPane → usePdfActions.adoptSavedPdfInk).
          const selfSave = nativeSource && !!sessionAtCall && documentSessions.get(id) === sessionAtCall
            && typeof bufferedSource !== 'string' && bufferedSource?.owner.session === sessionAtCall.serial;
          if (isPdf && !selfSave) bumpBytesGeneration(id);
        }
        if (isPdf && data instanceof Uint8Array) {
          const aliases = (await loadChunk(() => import('../utils/pdfBuildClient'))).pdfBuildAliases(data);
          if (aliases.length) notifyRef.current(`Attachments with conflicting names were preserved under recovered names: ${aliases.join(', ')}.`);
        }
        if (pdfEntry && pdfRebuildRef.current.get(id) === pdfEntry) {
          pdfEntry.baseline = result.version;
          setPdfRebuildNotice(id, { state: 'kept', generation: pdfEntry.value.role.generation, approved: pdfEntry.approved, copyName: pdfEntry.copyName });
        } else if (isPdf && pdfRebuildRef.current.has(id) && getBaseline(id) === result.version) {
          // A rebuild notice speaks for the file it inspected. A write that did not go through it (converted Classic
          // ink's first save, native ink) replaced that file, so "Before the first save, a copy is kept in Trash" stayed
          // up after the save and after later turns; its entry would also call the next reader version a conflict.
          pdfRebuildRef.current.delete(id);
          setPdfRebuildNotice(id, undefined);
        }
        // Stamped here, the one save funnel, rather than re-statted: the
        // explorer's Modified-time sort then moves the note to the top without
        // a getFile() per save (utils/fileTimes.ts). The write's own stat now.
        recordFileWritten(path, result.version.lastModified);
        // Queued rather than awaited: reconciling reads the note's neighbours,
        // and a save's "Saved" status (and the graph rebuild below) should not
        // wait on that — but two of them must not interleave either.
        requeueAssetsAffected(path);
        if (assetBaseline && embedsAfter && referencesAfter) {
          const before = assetBaseline.saved;
          const restore = new Set([...referencesAfter].filter(name => !assetBaseline.references.has(name)));
          assetBaseline.saved = embedsAfter;
          assetBaseline.references = referencesAfter;
          queueReconcile({ activation: activationAtCall, path, parentHandle: file.parentHandle ?? null,
            text: snapshot, before, after: embedsAfter, restore });
        }
        if (boardBaseline) queueReconcile({
          activation: activationAtCall,
          path, parentHandle: file.parentHandle ?? null, text: snapshot,
          before: new Set(), after: new Set(), board: boardBaselinesRef.current.committed(boardBaseline, snapshot),
        });
        // Only clear `dirty` if the content hasn't changed since we snapshotted.
        // By id: a rename mid-write moved the document, not the write.
        if (sourceRevision !== undefined && documentSessions.get(id) === sessionAtCall) sessionAtCall?.adapter.acknowledge(sourceRevision, 'written');
        if (bufferRevision !== undefined) {
          documentBuffers.markSaved(id, bufferRevision);
          void recoveryEvent({ type: 'written', documentId: id, revision: bufferRevision, fingerprint: result.version.hash });
          const newer = documentBuffers.get(id);
          const liveTab = tabsRef.current.find(t => t.id === id);
          const vaultId = currentVaultIdRef.current;
          if (newer && newer.revision > bufferRevision && liveTab && vaultId) {
            if (typeof newer.source === 'string' && canReadTabText(liveTab)) {
              const text = newer.source;
              void recoveryEvent({ type: 'change', documentId: id, vaultId, path: liveTab.file.path, fingerprint: result.version.hash,
                kind: liveTab.representation.loadedKind, revision: newer.revision, capture: () => ({ payload: text, copy: text, mediaRefs: [] }) });
            } else if (sessionAtCall?.adapter.journalDelta && documentSessions.get(id) === sessionAtCall) {
              void recoveryEvent({ type: 'change', documentId: id, vaultId, path: liveTab.file.path, fingerprint: result.version.hash,
                kind: liveTab.representation.loadedKind, revision: newer.revision, capture: () => {
                  if (documentSessions.get(id) !== sessionAtCall) throw new Error('Recovery session changed before capture');
                  const source = sessionAtCall.adapter.checkpoint(), prior = documentBuffers.get(id)?.source;
                  if (typeof source === 'string' || !documentSessions.isLiveOwner(id, source.owner)) throw new Error('Recovery source owner changed before capture');
                  if (!prior || typeof prior === 'string' || prior.owner.session !== source.owner.session || source.revision > prior.revision) {
                    sessionReportRef.current(id, source);
                  }
                  if (documentSessions.get(id) !== sessionAtCall || documentBuffers.get(id)?.revision !== newer.revision) throw new Error('Recovery revision changed before capture');
                  const capture = sessionAtCall.adapter.journalDelta?.();
                  if (!capture) throw new Error('This session cannot yet capture recovery data');
                  return capture;
                } });
            }
          }
        }
        const current = !documentSessions.hasPendingEdits(id);
        setTabs(prev => prev.map(t =>
          t.id === id && current ? { ...t, dirty: false } : t));
        // Any column on screen, not only the focused one: with the editor split
        // the status line speaks for everything the reader can see.
        if (current && visiblePathsRef.current.includes(path)) {
          // Re-armed, not stacked: rapid saves used to leave a handful of live
          // timers all racing to clear the same message.
          showStatus('Saved', 2000);
        }
        if (graphAtCall && graphAtCall === indexGraphRef.current && graphAtCall.root === rootAtCall
          && graphAtCall.activation === getVaultActivation()) {
          graphAtCall.echo.remember(path, result.version.lastModified, result.version.size);
          if (isMarkdownFile(file.name)) void graphAtCall.client.prime(path, result.version.lastModified, result.version.size, snapshot).catch(() => {});
          else if (!isPdf && isTextFile(file.name) && !isCanvasFile(file.name)) void graphAtCall.client.primeText(path, result.version.lastModified, result.version.size, snapshot).catch(() => {});
        }
        if (current && graphAtCall && graphAtCall === indexGraphRef.current) void graphAtCall.client.dropOverlay(path).catch(() => {});
        notifySearchChanges();
        bumpSaveEpoch();
        clearSaveNotice(id);
        return 'written';
      } catch (err) {
        if (err instanceof PdfBuildRefused) { setSaveStatus('Not saved'); showSaveNotice(id, err.message); return 'skipped'; }
        if (err instanceof SaveSuperseded) return 'failed';
        // A board's first save that put its pictures in .Assets under new names: the names are an edit at a newer revision, whose
        // own save follows at once, so this save is superseded, not failed (whiteboard/host/saveBuild.ts; matched by name, the app
        // does not import the engine). Treated as a failure, every old board with a picture flashed "was not saved" on its first save.
        if (err instanceof Error && err.name === 'MediaLocationsChanged') return 'failed';
        console.error('Auto-save failed:', err);
        // Never silent, for any document: the person is told it was not saved and why; the tab stays dirty, so the next edit's
        // save tries again. A drawing or notebook used to fail into the console alone.
        // A notice, never a dialog: this fires while the person types, and a dialog took their next keys (utils/saveNotices.ts).
        // One per document, replaced by a retry that fails again and removed by the save that succeeds.
        setSaveStatus('Not saved');
        const why = describeReadError(err).replace(/[.\s]+$/, '');
        showSaveNotice(id, isPdf ? `The PDF was not saved: ${why}. Your next change tries again.`
          : `“${path.split('/').pop()}” was not saved: ${why}. Your next change tries again.`);
        return 'failed';
      }
    };

    const chains = flushChainsRef.current;
    const flushing = flushingRef.current;
    flushing.set(id, (flushing.get(id) ?? 0) + 1);
    const run = (chains.get(id) ?? Promise.resolve()).then(write);
    chains.set(id, run);
    const pendingWrite = { revision, promise: run };
    pendingWritesRef.current.set(id, pendingWrite);
    syncExitGuard();
    try {
      const outcome = await run;
      if (sourceRevision !== undefined && documentSessions.get(id) === sessionAtCall && outcome !== 'written' && outcome !== 'skipped') {
        sessionAtCall?.adapter.acknowledge(sourceRevision, outcome === 'failed' ? 'failed' : 'conflict');
      }
      return outcome;
    } finally {
      const left = (flushing.get(id) ?? 1) - 1;
      if (left > 0) flushing.set(id, left); else flushing.delete(id);
      if (chains.get(id) === run) chains.delete(id);
      if (pendingWritesRef.current.get(id) === pendingWrite) pendingWritesRef.current.delete(id);
      syncExitGuard();
    }
    } finally { captured?.release(); }
    // queueReconcile is stable (a useCallback over refs), so flushTab — and
    // every timer and listener downstream of it — keeps its identity.
  }, [bumpBytesGeneration, clearSaveTimer, documentBuffers, documentSessions, indexGraphRef, nativeCanvasHost, recoveryEvent, queueReconcile, requeueAssetsAffected, setDiskState, keepClosingEdits, syncExitGuard, getVaultActivation, keepPdfBaseline, currentPdfOwner, setPdfRebuildNotice,
    assetActivationsRef, assetRefsRef, boardBaselinesRef, bytesGenerationsRef, currentVaultIdRef, diskStateRef,
    flushingRef, nativePoliciesRef, notifyRef, pdfRebuildRef, pdfSeedForRef, pdfSeedsRef, reconcileQueueRef,
    rootHandleRef, sessionReportRef, setSaveStatus, setTabs, tabsRef, trashInFlightRef, visiblePathsRef, showStatus]);

  const scheduleSave = useCallback((path: string) => {
    clearSaveTimer(path);
    // flushTab clears the (now-fired) timer itself, so no delete needed here.
    saveTimersRef.current.set(path, setTimeout(() => flushTab(path), 1000));
  }, [clearSaveTimer, flushTab, saveTimersRef]);

  // Buffer an edit against ONE named document and schedule its save.
  // Path-explicit on purpose, and the only content funnel there is: several
  // documents are editable at once — one per column — and the drawing canvas
  // serializes on a debounce that can fire after its pane has gone away. Either
  // way the text must land in the document it came from — never in whichever
  // pane happens to have focus by then.
  //
  // `fromDisk`: the text was just reloaded from the file (a reload in place —
  // editor/externalReload.ts). It is buffered like any edit, but it IS the file,
  // so the tab stays clean and nothing is scheduled to write it back.
  const updateTabContent = useCallback((path: string, content: ContentSource, options?: ContentChangeOptions & {
    nativeTransition?: { revision: number; prior: ContentSource };
  }) => {
    const target = tabsRef.current.find(t => t.file.path === path);
    const transition = options?.nativeTransition, transitionBuffer = target && transition && documentBuffers.get(target.id);
    if (transition && (!target || typeof content === 'string' || !transitionBuffer || transitionBuffer.revision !== transition.revision
      || transitionBuffer.source !== transition.prior || transitionBuffer.owner.documentId !== content.owner.documentId
      || transitionBuffer.owner.session !== content.owner.session)) return;
    const policy = target && nativePoliciesRef.current.get(target.id);
    // Only its disk's own text reaches an old-format board's buffer (a reload in place); the board shown never reports in.
    if (target && (target.representation.oldBoard || policy?.oldBoard) && !(typeof content === 'string' && options?.fromDisk)) return;
    const liveNativePolicy = !!target && !!policy && policy.kind === (target.representation.loadedKind === 'pdf' ? 'pdfInk' : target.representation.loadedKind)
      && policy.activation === getVaultActivation()
      && policy.retainedThroughGeneration === (bytesGenerationsRef.current.get(target.id) ?? 0)
      && hasHostedNativeOwner(documentSessions.get(target.id), target.id)
      && documentSessions.isLiveOwner(target.id, { documentId: target.id, session: policy.session });
    const ownedNative = !!target && typeof content !== 'string' && !!policy && !policy.emergencyReadOnly
      && policy.kind === (target.representation.loadedKind === 'pdf' ? 'pdfInk' : target.representation.loadedKind)
      && policy.session === content.owner.session && policy.activation === getVaultActivation()
      && policy.retainedThroughGeneration === (bytesGenerationsRef.current.get(target.id) ?? 0)
      && hasHostedNativeOwner(documentSessions.get(target.id), target.id) && documentSessions.isLiveOwner(target.id, content.owner);
    const accepted = !!target && (canUpdateTabContent(target, target.representation.loadedKind === 'pdf' ? 'annotation' : options?.fromDisk ? 'disk' : 'user')
      || ownedNative && !target.readError && target.representation.status === 'ready')
      && (typeof content === 'string' ? !!options?.fromDisk || !liveNativePolicy : documentSessions.isLiveOwner(target.id, content.owner));
    if (__BME_BENCH__) {
      try {
        const kind = target?.representation.loadedKind ?? 'unknown';
        const caller = options?.fromDisk ? 'disk'
          : `pane:${['markdown', 'text', 'code', 'tex'].includes(kind) ? 'note' : kind}`;
        const root = perfRoot();
        const funnel = (root.funnel ??= { reports: {}, rejected: {}, ownerlessReports: {}, reads: 0 }) as {
          reports: Record<string, number>; rejected: Record<string, number>; ownerlessReports: Record<string, number>;
        };
        funnel.reports[caller] = (funnel.reports[caller] ?? 0) + 1;
        if (typeof content === 'string') funnel.ownerlessReports[caller] = (funnel.ownerlessReports[caller] ?? 0) + 1;
        if (!accepted) funnel.rejected[caller] = (funnel.rejected[caller] ?? 0) + 1;
      } catch { /* Measurement must not interrupt a content report. */ }
    }
    if (!accepted) return;
    const prior = documentBuffers.get(target.id)?.source;
    if (!transition && !options?.fromDisk && typeof content !== 'string' && prior && typeof prior !== 'string'
      && prior.owner.documentId === content.owner.documentId && prior.owner.session === content.owner.session
      && content.revision <= prior.revision) {
      if (content.revision === prior.revision && !options?.fromJournal) scheduleSave(path);
      return;
    }
    assetReferenceRevisionRef.current++;
    const wasDirty = documentBuffers.isDirty(target.id);
    const buffer = documentBuffers.report(target.id, content, !!options?.fromDisk, !options?.fromDisk);
    if (!buffer) return;
    // Never into an unreadable tab's buffer: nothing edits one (its pane builds
    // no editor), but the funnel guards itself — see OpenTab.readError.
    // A disk report is saved by definition; tell the funnel, or a capture still pending for the older edit finds the
    // revision moved and reports a failure (measured: DiskBar conflict then Keep mine, 'Recovery revision changed before capture').
    if (options?.fromDisk) {
      void recoveryEvent({ type: 'written', documentId: target.id, revision: buffer.revision, fingerprint: getBaseline(target.id)?.hash ?? '' });
      return;
    }
    syncExitGuard();
    const baseline = getBaseline(target.id), vaultId = currentVaultIdRef.current;
    if (baseline && vaultId) {
      const session = documentSessions.get(target.id);
      if (typeof content === 'string' && canReadTabText(target)) {
        void recoveryEvent({ type: 'change', documentId: target.id, vaultId, path,
          fingerprint: baseline.hash, kind: target.representation.loadedKind, revision: buffer.revision,
          capture: () => ({ payload: content, copy: content, mediaRefs: [] }) });
      } else if (session?.adapter.journalDelta) {
        void recoveryEvent({ type: 'change', documentId: target.id, vaultId, path,
          fingerprint: baseline.hash, kind: target.representation.loadedKind, revision: buffer.revision,
          capture: () => {
            if (documentSessions.get(target.id) !== session) throw new Error('Recovery session changed before capture');
            const source = session.adapter.checkpoint(), prior = documentBuffers.get(target.id)?.source;
            if (typeof source === 'string' || !documentSessions.isLiveOwner(target.id, source.owner)) throw new Error('Recovery source owner changed before capture');
            if (!prior || typeof prior === 'string' || prior.owner.session !== source.owner.session || source.revision > prior.revision) {
              sessionReportRef.current(target.id, source);
            }
            if (documentSessions.get(target.id) !== session || documentBuffers.get(target.id)?.revision !== buffer.revision) throw new Error('Recovery revision changed before capture');
            // undefined: no change past the session's baseline yet, e.g. a legacy board just converted on open.
            return session.adapter.journalDelta?.();
          } });
      }
    }
    notifySearchChanges();
    if (!wasDirty || target.representation.loadedKind === 'pdf' && target.representation.bufferKind !== 'annotationSnapshot') {
      setTabs(prev => prev.map(t => t.id === target.id && !t.readError ? { ...t, dirty: true, representation: t.representation.loadedKind === 'pdf' ? { ...t.representation, bufferKind: 'annotationSnapshot' as const, contentWritable: true } : t.representation } : t));
    }
    if (!options?.fromJournal) scheduleSave(path);
  }, [documentBuffers, documentSessions, getVaultActivation, recoveryEvent, syncExitGuard, scheduleSave,
    assetReferenceRevisionRef, bytesGenerationsRef, currentVaultIdRef, nativePoliciesRef, sessionReportRef, setTabs, tabsRef]);
  nativeTransitionRef.current = (id, source, revision, prior) => {
    const tab = tabsRef.current.find(item => item.id === id), before = documentBuffers.get(id);
    if (!tab || !before || before.revision !== revision || before.source !== prior || !documentBuffers.isDirty(id)
      || !documentSessions.isLiveOwner(id, source.owner)) throw new DOMException('Canvas source changed', 'AbortError');
    try { updateTabContent(tab.file.path, source, { nativeTransition: { revision, prior } }); }
    catch (error) {
      const accepted = documentBuffers.get(id);
      if (!accepted || accepted.source !== source || accepted.revision !== revision + 1) throw error;
      // Once published, the bridge must keep the source even if a subscriber failed.
      console.error('Canvas source notification failed:', error);
      try { syncExitGuard(); scheduleSave(tab.file.path); } catch (notifyError) { console.error('Canvas source follow-up failed:', notifyError); }
    }
    const after = documentBuffers.get(id);
    if (!after || after.source !== source || after.revision !== revision + 1 || !documentBuffers.isDirty(id)) {
      throw new Error('The canvas source transition was not accepted');
    }
  };
  sessionReportRef.current = (id, source, options) => {
    const tab = tabsRef.current.find(t => t.id === id);
    if (tab) updateTabContent(tab.file.path, source, options);
  };

  const checkpointRef = useRef<Promise<void> | null>(null);
  const checkpointAgainRef = useRef(false);
  const checkpointAll = useCallback(() => {
    if (checkpointRef.current) { checkpointAgainRef.current = true; return checkpointRef.current; }
    const activation = getVaultActivation();
    const run = (async () => {
      do {
        checkpointAgainRef.current = false;
        try { await drainAll(); } catch (error) { console.error('Could not serialize pending documents:', error); }
        if (getVaultActivation() !== activation) return;
        const work = tabsRef.current.flatMap(tab => {
          if (!documentSessions.hasPendingEdits(tab.id)) return [];
          return [flushTab(tab.file.path, true)];
        });
        await Promise.allSettled(work);
      } while (checkpointAgainRef.current && getVaultActivation() === activation);
    })();
    checkpointRef.current = run;
    void run.finally(() => { if (checkpointRef.current === run) checkpointRef.current = null; });
    return run;
  }, [flushTab, getVaultActivation, documentSessions, tabsRef]);
  // A write clears `dirty` only when nothing is pending at that moment (above), but a board acknowledges its write while
  // its after-write step is still tracked work, so that check always saw it pending and nothing cleared it afterwards:
  // every drawing drawn on kept `dirty` for good, and closing it said "Could not save" although its file held every
  // stroke (measured: 3 strokes saved, close refused, every time). When the session's pending work settles, a tab with
  // nothing left to write is clean. PDFs keep their own rule (an annotation snapshot is dirty until rebuilt).
  const settleCleanTabs = useCallback(() => {
    if (!tabsRef.current.some(t => t.dirty && t.representation.loadedKind !== 'pdf' && !documentSessions.hasPendingEdits(t.id))) return;
    setTabs(prev => {
      let changed = false;
      const next = prev.map(t => {
        if (!t.dirty || t.readError || t.representation.loadedKind === 'pdf' || documentSessions.hasPendingEdits(t.id)) return t;
        changed = true;
        return { ...t, dirty: false };
      });
      return changed ? next : prev;
    });
  }, [documentSessions, setTabs, tabsRef]);
  /** Write out everything pending now — what leaving the page does — for a reload the app offers (useUpdateNotice). */
  const checkpointNow = useCallback(async () => {
    checkpointSessions((id, source) => {
      const prior = documentBuffers.get(id)?.source;
      if (!sourceIsNewer(source, prior)) return;
      sessionReportRef.current(id, source);
    });
    void recoveryEvent({ type: 'checkpoint' });
    await checkpointAll();
  }, [checkpointAll, documentBuffers, recoveryEvent, sessionReportRef]);
  useEffect(() => {
    const unsubscribe = subscribePending(() => { syncExitGuard(); settleCleanTabs(); });
    syncExitGuard();
    const visibility = () => { if (document.visibilityState === 'hidden') { void recoveryEvent({ type: 'checkpoint' }); void checkpointAll(); } };
    const pagehide = () => { void checkpointNow(); };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', pagehide);
    return () => {
      unsubscribe();
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', pagehide);
      window.removeEventListener('beforeunload', beforeUnload);
      guardedRef.current = false;
    };
  }, [beforeUnload, checkpointAll, checkpointNow, syncExitGuard, settleCleanTabs, recoveryEvent]);

  return {
    writeFileRef, writeFileVersionedRef, clearSaveTimer, flushChainsRef, syncExitGuard, flushTab,
    scheduleSave, updateTabContent, checkpointNow, };
}
