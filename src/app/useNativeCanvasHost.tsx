import React, { useEffect, useMemo, useState } from 'react';
import type { ContentChangeOptions, FileSystemContextValue, OpenTab } from '../types';
import type { NativeCanvasHost, NativeCanvasIdentity } from '../types/nativeCanvas';
import type { CanvasSessionBridge } from '../utils/canvasSessionBridge';
import { awaitSessionDisposals } from '../utils/sessionIdentity';

import { sourceIsNewer, type ContentSource, type DeferredSource, type DocumentBufferStore } from '../utils/documentBuffers';
import type { DocumentSessionStore } from '../utils/documentSessions';
import { getBaseline, setBaseline } from '../utils/docBaselines';
import { pdfTurnHeld } from '../utils/pdfTurnHold';
import { isNativeDrawingFile } from '../utils/fileTypes';
import { getView } from '../utils/viewRegistry';
import { createClipboardCache } from '../utils/clipboardCache';
import { createNativeEmbedHost } from '../utils/nativeEmbedHost';
import { hasHostedNativeOwner, hasWritableHostedNativeOwner } from './nativeOwners';
import type { AppDialog, Ask } from './useAppDialogs';
import type { DiskHold, NativePolicy, RecoveryEvent, RecoveryJournal } from './types';
import { byteReadMs, withinFileDeadline } from '../utils/fileReadDeadline';
import { loadChunk } from '../platform/chunkLoad';
import { oldBoardReadOnlyReason } from '../utils/oldBoards';
import { DISK_CHANGED_BOARD_NOTICE, DISK_DELETED_BOARD_NOTICE } from '../utils/diskHeldNotice';

/** What the native-canvas host hook reads from App. */
export interface UseNativeCanvasHostDeps {
  getVaultActivation: FileSystemContextValue['getVaultActivation'];
  tabsRef: React.RefObject<OpenTab[]>;
  documentSessions: DocumentSessionStore;
  documentBuffers: DocumentBufferStore;
  nativePoliciesRef: React.RefObject<Map<string, NativePolicy>>;
  diskStateRef: React.RefObject<Map<string, DiskHold>>;
  rootHandleRef: React.RefObject<FileSystemDirectoryHandle | null>;
  currentVaultIdRef: React.RefObject<string | null>;
  flushingRef: React.RefObject<Map<string, number>>;
  saveTimersRef: React.RefObject<Map<string, ReturnType<typeof setTimeout>>>;
  nativeTransitionRef: React.RefObject<(documentId: string, source: DeferredSource, revision: number, prior: ContentSource) => void>;
  sessionReportRef: React.RefObject<(documentId: string, source: ContentSource, options?: ContentChangeOptions) => void>;
  dialogRef: React.RefObject<AppDialog | null>;
  ask: Ask;
  recoveryEvent: RecoveryEvent;
  recoveryJournal: RecoveryJournal;
  readFileSnapshot: FileSystemContextValue['readFileSnapshot'];
  readBoardAsset: FileSystemContextValue['readBoardAsset'];
  readLegacyBoardAsset: FileSystemContextValue['readLegacyBoardAsset'];
  putBoardAsset: FileSystemContextValue['putBoardAsset'];
  keepConversionBackup: FileSystemContextValue['keepConversionBackup'];
  /** The App side of "Make an editable copy" (useEditableCopy), composed after this hook. */
  editableCopyRef: React.RefObject<NativeCanvasHost['makeEditableCopy'] | null>;
}

export function useNativeCanvasHost(deps: UseNativeCanvasHostDeps) {
  const {
    getVaultActivation, tabsRef, documentSessions, documentBuffers, nativePoliciesRef, diskStateRef,
    rootHandleRef, currentVaultIdRef, flushingRef, saveTimersRef, nativeTransitionRef, sessionReportRef,
    dialogRef, ask, recoveryEvent, recoveryJournal, readFileSnapshot, readBoardAsset, readLegacyBoardAsset,
    putBoardAsset, keepConversionBackup, editableCopyRef,
  } = deps;

  const [nativeClipboard] = useState(() => createClipboardCache(error => console.error('Could not release clipboard resources:', error)));
  const [nativeEmbeds] = useState(createNativeEmbedHost);
  useEffect(() => { nativeClipboard.setActive(true); return () => nativeClipboard.setActive(false); }, [nativeClipboard]);
  const nativeCanvasHost = useMemo<NativeCanvasHost>(() => {
    const current = (identity: NativeCanvasIdentity) => {
      if (identity.vaultActivation !== getVaultActivation()) return undefined;
      const tab = tabsRef.current.find(tab => tab.id === identity.documentId);
      const entry = documentSessions.get(identity.documentId);
      const loaded = identity.kind === 'pdfInk' ? 'pdf' : identity.kind;
      const policy = nativePoliciesRef.current.get(identity.documentId);
      const retained = entry && policy && policy.session === identity.session && policy.activation === identity.vaultActivation
        && policy.kind === identity.kind && policy.sourceGeneration === identity.bytesGeneration
        && policy.retainedThroughGeneration === entry.bytesGeneration && hasHostedNativeOwner(entry, identity.documentId);
      return tab && !tab.readError && tab.representation.status === 'ready' && tab.representation.loadedKind === loaded
        && entry?.serial === identity.session && (entry.bytesGeneration === identity.bytesGeneration || retained) ? tab : undefined;
    };
    // The first failing guard names the refusal; a null result is the only state in which the source may be written.
    const writeBlockSource = (identity: NativeCanvasIdentity): string | null => {
      const policy = nativePoliciesRef.current.get(identity.documentId);
      const entry = documentSessions.get(identity.documentId);
      if (!current(identity)) return 'The native canvas session has ended.';
      // The turn will replace this owner with one on the turned pages; ink taken now would be lost (pdfTurnHold.ts).
      if (identity.kind === 'pdfInk' && pdfTurnHeld(identity.documentId)) return 'The PDF’s pages are being turned. Try again once they have turned.';
      if (!policy) return 'The native canvas is not available for editing.';
      if (policy.emergencyReadOnly) return 'This canvas is in emergency read-only mode.';
      if (policy.oldBoard) return oldBoardReadOnlyReason(identity.kind === 'notebook' ? 'notebook' : 'drawing');
      if (policy.session !== identity.session || policy.activation !== identity.vaultActivation || policy.kind !== identity.kind
        || policy.sourceGeneration !== identity.bytesGeneration || policy.retainedThroughGeneration !== entry?.bytesGeneration)
        return 'The native canvas changed; reopen it to continue.';
      if (!hasHostedNativeOwner(entry, identity.documentId)) return 'The native canvas has no active editor.';
      if (!getBaseline(identity.documentId)) return 'The file has no disk baseline yet.';
      const held = diskStateRef.current.get(identity.documentId);
      if (held) return held === 'deleted' ? DISK_DELETED_BOARD_NOTICE : DISK_CHANGED_BOARD_NOTICE;
      if (identity.kind === 'pdfInk' && policy.pdfWriteAuthority?.canWriteSource() !== true) return 'The PDF source is locked for writing.';
      return null;
    };
    const writableSource = (identity: NativeCanvasIdentity) => writeBlockSource(identity) === null;
    const writeBlockReason = (identity: NativeCanvasIdentity): string | null => writeBlockSource(identity)
      ?? (hasWritableHostedNativeOwner(documentSessions.get(identity.documentId), identity.documentId) ? null : 'Another editor holds this canvas for writing.');
    const writable = (identity: NativeCanvasIdentity) => writeBlockReason(identity) === null;
    const request = (identity: NativeCanvasIdentity, media: { hash: string; preferredName?: string | null }, signal: AbortSignal, write = false) => {
      signal.throwIfAborted();
      const tab = current(identity), root = rootHandleRef.current;
      if (!tab?.file.handle || !tab.file.parentHandle || !root || write && !writable(identity)) throw new DOMException('Canvas session ended or read-only', 'AbortError');
      return { root, parent: tab.file.parentHandle, owner: tab.file.handle as FileSystemFileHandle,
        hash: media.hash, preferredName: media.preferredName, signal, isCurrent: () => !!current(identity) && (!write || writable(identity)) };
    };
    return {
      clipboard: nativeClipboard,
      embeds: nativeEmbeds,
      async createEditingCapabilities(context) {
        const { createNativeEditingCapabilities } = await loadChunk(() => import('../components/whiteboard/nativeEditingCapabilityFactory'));
        return createNativeEditingCapabilities(context);
      },
      identity(id) {
        const tab = tabsRef.current.find(tab => tab.id === id), entry = documentSessions.get(id);
        if (!tab || tab.readError || tab.representation.status !== 'ready' || !entry) return undefined;
        const loaded = tab.representation.loadedKind;
        if (loaded !== 'pdf' && loaded !== 'drawing' && loaded !== 'notebook') return undefined;
        const kind = loaded === 'pdf' ? 'pdfInk' : loaded;
        const activation = getVaultActivation(), policy = nativePoliciesRef.current.get(id);
        const retained = policy && policy.session === entry.serial && policy.activation === activation && policy.kind === kind
          && policy.retainedThroughGeneration === entry.bytesGeneration && hasHostedNativeOwner(entry, id);
        return { documentId: id, session: entry.serial, bytesGeneration: retained ? policy.sourceGeneration : entry.bytesGeneration,
          vaultActivation: activation, kind, path: tab.file.path, name: tab.file.name };
      },
      outerIdentity(id) {
        const tab = tabsRef.current.find(tab => tab.id === id), entry = documentSessions.get(id);
        if (!tab || tab.readError || tab.representation.status !== 'ready' || !entry) return undefined;
        const loaded = tab.representation.loadedKind;
        if (loaded !== 'pdf' && loaded !== 'drawing' && loaded !== 'notebook') return undefined;
        return { documentId: id, session: entry.serial, bytesGeneration: entry.bytesGeneration,
          vaultActivation: getVaultActivation(), kind: loaded === 'pdf' ? 'pdfInk' : loaded, path: tab.file.path, name: tab.file.name };
      },
      isCurrent: identity => !!current(identity),
      canWriteSource: identity => writableSource(identity),
      canWrite: identity => writable(identity),
      writeBlockReason: identity => writeBlockReason(identity),
      session(id) {
        const adapter = documentSessions.get(id)?.adapter;
        return adapter && 'peek' in adapter ? (adapter as CanvasSessionBridge).peek() : undefined;
      },
      async acquireBytes(identity, signal) {
        await awaitSessionDisposals(identity.documentId);
        const bridge = documentSessions.get(identity.documentId)?.adapter;
        if (bridge && 'settled' in bridge && typeof bridge.settled === 'function') await (bridge as CanvasSessionBridge).settled();
        signal.throwIfAborted();
        const tab = current(identity);
        if (!tab?.file.handle) throw new DOMException('Canvas session ended', 'AbortError');
        const baseline = getBaseline(tab.id);
        const snapshot = await readFileSnapshot(tab.file.handle as FileSystemFileHandle, signal);
        try {
          // getFile() is bounded by readFileSnapshot; the bytes behind it are not, and a cloud placeholder can answer one and
          // never deliver the other, which left the board on "Preparing canvas…" for good (lane E, injected never-settling read).
          const bytes = await withinFileDeadline(new Response(snapshot.blob.stream()).blob(), identity.name, byteReadMs(snapshot.blob.size));
          const version = await snapshot.fingerprint(signal);
          signal.throwIfAborted();
          const latest = current(identity), currentBaseline = getBaseline(identity.documentId);
          if (!latest || latest.file.handle !== tab.file.handle) throw new DOMException('Canvas session ended', 'AbortError');
          if ((baseline && baseline.hash !== version.hash) || (currentBaseline && currentBaseline.hash !== version.hash)) throw new Error('The canvas changed on disk. Reload it before editing.');
          if (isNativeDrawingFile(latest.file.name) && !currentBaseline) setBaseline(identity.documentId, version);
          return bytes;
        } finally { snapshot.dispose(); }
      },
      pinBoardSource(identity) {
        const tab = current(identity), buffer = documentBuffers.get(identity.documentId);
        if (!tab || identity.kind === 'pdfInk' || !buffer) throw new DOMException('Canvas source is unavailable', 'AbortError');
        const captured = documentBuffers.retainSnapshotForDocument(identity.documentId);
        if (!captured || captured.revision !== buffer.revision) { captured?.release(); throw new DOMException('Canvas source changed', 'AbortError'); }
        const dirty = buffer.revision > buffer.savedRevision, prior = buffer.source, revision = buffer.revision;
        const baselineAtPin = getBaseline(identity.documentId);
        if (dirty && !baselineAtPin) { captured.release(); throw new Error('The unsaved canvas has no verified disk baseline.'); }
        const acquireDisk = (signal: AbortSignal) => this.acquireBytes(identity, signal);
        let released = false, observedDiskHash: string | undefined;
        const isCurrent = () => {
          const latest = documentBuffers.get(identity.documentId);
          return !released && !!current(identity) && !!latest && latest.revision === revision && latest.source === prior
            && (!dirty || getBaseline(identity.documentId) === baselineAtPin)
            && latest.owner.documentId === identity.documentId && latest.owner.session === identity.session;
        };
        return { dirty, isCurrent,
          async read(signal) {
            signal.throwIfAborted();
            if (!isCurrent()) throw new DOMException('Canvas source changed', 'AbortError');
            const disk = await acquireDisk(signal);
            const baseline = getBaseline(identity.documentId);
            if (!isCurrent() || signal.aborted) throw new DOMException('Canvas source changed', 'AbortError');
            if (dirty && (!baseline || baseline !== baselineAtPin)) throw new Error('The canvas disk baseline changed during acquisition.');
            let diskHash: string;
            if (baseline) diskHash = baseline.hash;
            else { const { hashBytes } = await loadChunk(() => import('../utils/diskVersion')); diskHash = await hashBytes(await withinFileDeadline(disk.arrayBuffer(), identity.name, byteReadMs(disk.size))); }
            if (!isCurrent() || signal.aborted) throw new DOMException('Canvas source changed', 'AbortError');
            observedDiskHash = diskHash;
            if (!dirty) return { input: disk, diskHash };
            const data = captured.data;
            const resolved = typeof data === 'object' && data !== null && 'kind' in data && data.kind === 'build'
              ? await data.run(signal) : data;
            if (!isCurrent() || signal.aborted) throw new DOMException('Canvas source changed', 'AbortError');
            const input = typeof resolved === 'string' ? new Blob([resolved]) : resolved instanceof Blob ? resolved
              : resolved instanceof Uint8Array ? new Blob([resolved.slice().buffer as ArrayBuffer]) : null;
            if (!input) throw new Error('The captured canvas source is not binary or text.');
            return { input, diskHash };
          },
          async verify(signal) {
            signal.throwIfAborted();
            if (!isCurrent() || !observedDiskHash) throw new DOMException('Canvas source changed', 'AbortError');
            const disk = await acquireDisk(signal);
            const { hashBytes } = await loadChunk(() => import('../utils/diskVersion'));
            const hash = await hashBytes(await withinFileDeadline(disk.arrayBuffer(), identity.name, byteReadMs(disk.size)));
            if (!isCurrent() || signal.aborted || hash !== observedDiskHash) throw new DOMException('Canvas disk baseline changed', 'AbortError');
          },
          accept(source) {
            if (!dirty || !isCurrent()) throw new DOMException('Canvas source changed', 'AbortError');
            nativeTransitionRef.current(identity.documentId, source, revision, prior);
          },
          release() { if (!released) { released = true; captured.release(); } },
        };
      },
      async confirmLegacyPdfConversion(identity, request, signal) {
        signal.throwIfAborted();
        if (identity.kind !== 'pdfInk' || !/^[a-f0-9]{64}$/.test(request.originalSha256)
          || (request.foreign !== null && (request.foreign.kind !== 'foreign'
            || !['mismatch', 'unsupported', 'malformed'].includes(request.foreign.reason)))) throw new Error('Invalid PDF conversion request');
        const initial = current(identity), root = rootHandleRef.current;
        if (!initial?.file.handle || !initial.file.parentHandle || !root) throw new DOMException('PDF session ended', 'AbortError');
        const path = initial.file.path, handle = initial.file.handle as FileSystemFileHandle, parent = initial.file.parentHandle;
        const stillCurrent = () => {
          const tab = current(identity), entry = documentSessions.get(identity.documentId);
          return !!tab && rootHandleRef.current === root && tab.file.path === path && tab.file.handle === handle
            && tab.file.parentHandle === parent && entry?.serial === identity.session && entry.bytesGeneration === identity.bytesGeneration
            && getBaseline(identity.documentId)?.hash === request.originalSha256 && !tab.dirty
            && !documentBuffers.isDirty(identity.documentId) && !documentSessions.hasPendingEdits(identity.documentId)
            && !diskStateRef.current.has(identity.documentId) && !flushingRef.current.has(identity.documentId)
            && !saveTimersRef.current.has(path) && !getView(path)?.hasPendingEdits?.();
        };
        const verify = async () => {
          signal.throwIfAborted();
          if (!stillCurrent()) throw new DOMException('PDF changed before conversion', 'AbortError');
          const snapshot = await readFileSnapshot(handle, signal);
          try {
            const version = await snapshot.fingerprint(signal);
            signal.throwIfAborted();
            if (!stillCurrent() || version.hash !== request.originalSha256) throw new Error('The PDF changed on disk. Reload it before conversion.');
          } finally { snapshot.dispose(); }
        };
        await verify();
        const question = ask({ title: 'Convert PDF annotations?', confirmLabel: 'Convert',
          body: <>{request.foreign && <><strong>This PDF was changed by another program or its write mark could not be verified.</strong> Converting may replace those changes when the PDF is next saved.<br /><br /></>}
            The existing annotations will be converted for this editor. A copy of the original PDF will be kept in this folder’s Trash before any replacement.</> });
        const shown = dialogRef.current;
        const cancel = () => { if (shown && dialogRef.current === shown) shown.onCancel?.(); };
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
        let accepted: boolean;
        try { accepted = await question; } finally { signal.removeEventListener('abort', cancel); }
        signal.throwIfAborted();
        if (!accepted) return false;
        await verify();
        return true;
      },
      async keepConversionBackup(identity, original, digest, signal) {
        // An old drawing or notebook is never converted, so nothing of one is ever "backed up" before an overwrite.
        if (identity.kind !== 'pdfInk') throw new Error('Only an annotated PDF is converted in place.');
        const tab = current(identity);
        if (!tab) throw new DOMException('Canvas session ended', 'AbortError');
        const path = tab.file.path, handle = tab.file.handle;
        const access = request(identity, { hash: digest }, signal);
        const result = await keepConversionBackup({ ...access, blob: original, isCurrent: () => {
          const latest = current(identity);
          return !!latest && latest.file.path === path && latest.file.handle === handle && getBaseline(identity.documentId)?.hash === digest;
        } });
        signal.throwIfAborted();
        if (!access.isCurrent() || getBaseline(identity.documentId)?.hash !== digest
          || current(identity)?.file.path !== path || current(identity)?.file.handle !== handle) {
          throw new DOMException('Canvas session ended', 'AbortError');
        }
        return result;
      },
      acceptConvertedSource(identity, source, digest) {
        const tab = current(identity);
        if (identity.kind !== 'pdfInk' || !tab || !writable(identity) || !/^[a-f0-9]{64}$/.test(digest)
          || getBaseline(identity.documentId)?.hash !== digest || tab.representation.legacyOriginalSha256 !== digest
          || tab.representation.nativeCanvasKind !== identity.kind || tab.representation.nativeCanvasSession !== identity.session
          || source.kind !== 'deferred' || source.owner.documentId !== identity.documentId || source.owner.session !== identity.session
          || !documentSessions.isLiveOwner(identity.documentId, source.owner)) {
          throw new DOMException('Legacy conversion is no longer authorized', 'AbortError');
        }
        const prior = documentBuffers.get(identity.documentId);
        // The converted PDF source IS the disk bytes, re-expressed: install it as the clean baseline.
        // As an edit it marked the tab dirty and autosaved, converting every legacy PDF on mere
        // open; the first real change converts it (with its .Garbage backup).
        sessionReportRef.current(identity.documentId, source, { fromDisk: true });
        const accepted = documentBuffers.get(identity.documentId);
        if (!accepted || accepted.revision === prior?.revision || accepted.source !== source) {
          throw new Error('Legacy conversion source was not accepted');
        }
      },
      async appendJournal(identity, source, capture) {
        if (!current(identity) || !writable(identity) || typeof source === 'string' || source.kind !== 'deferred'
          || source.owner.documentId !== identity.documentId || source.owner.session !== identity.session
          || !documentSessions.isLiveOwner(identity.documentId, source.owner)) {
          throw new DOMException('Canvas session ended or read-only', 'AbortError');
        }
        const prior = documentBuffers.get(identity.documentId)?.source;
        if (sourceIsNewer(source, prior)) sessionReportRef.current(identity.documentId, source, { fromJournal: true });
        const tab = current(identity), buffered = documentBuffers.get(identity.documentId);
        if (!tab || !writable(identity)) throw new DOMException('Canvas session ended or read-only', 'AbortError');
        if (!buffered || typeof buffered.source === 'string' || buffered.source.kind !== source.kind
          || buffered.source.owner.documentId !== source.owner.documentId || buffered.source.owner.session !== source.owner.session
          || buffered.source.revision !== source.revision) return;
        const baseline = getBaseline(identity.documentId), vaultId = currentVaultIdRef.current;
        if (!baseline || !vaultId) throw new Error('Recovery baseline is unavailable');
        void recoveryEvent({ type: 'change', documentId: identity.documentId, vaultId, path: tab.file.path,
          fingerprint: baseline.hash, kind: tab.representation.loadedKind, revision: buffered.revision, capture: () => capture });
        void recoveryEvent({ type: 'checkpoint', documentId: identity.documentId });
        await recoveryJournal.flush();
      },
      async readMedia(identity, media, signal) {
        const found = await readBoardAsset(request(identity, media, signal));
        if (!found) return null;
        const blob = await new Response(found.blob.stream()).blob();
        signal.throwIfAborted();
        if (!current(identity)) throw new DOMException('Canvas session ended', 'AbortError');
        return { name: found.name, blob };
      },
      async readLegacyAsset(identity, src, signal) {
        signal.throwIfAborted();
        const tab = current(identity), root = rootHandleRef.current;
        if (!tab?.file.handle || !tab.file.parentHandle || !root) throw new DOMException('Canvas session ended', 'AbortError');
        const path = tab.file.path, owner = tab.file.handle as FileSystemFileHandle, parent = tab.file.parentHandle;
        const isCurrent = () => {
          const latest = current(identity);
          return !!latest && rootHandleRef.current === root && latest.file.path === path
            && latest.file.handle === owner && latest.file.parentHandle === parent;
        };
        const blob = await readLegacyBoardAsset({ root, parent, owner, src, signal, isCurrent });
        signal.throwIfAborted();
        if (!isCurrent()) throw new DOMException('Canvas session ended', 'AbortError');
        return blob;
      },
      async makeEditableCopy(identity, copy, signal) {
        const make = editableCopyRef.current;
        if (!make) throw new Error('Copies cannot be made yet.');
        await make(identity, copy, signal);
      },
      async putMedia(identity, media, blob, signal) {
        const name = await putBoardAsset({ ...request(identity, media, signal, true), extension: media.extension, blob });
        signal.throwIfAborted();
        if (!current(identity) || !writable(identity)) throw new DOMException('Canvas session ended or read-only', 'AbortError');
        return name;
      },
    };
  }, [nativeClipboard, nativeEmbeds, documentBuffers, documentSessions, getVaultActivation, readFileSnapshot, readBoardAsset, readLegacyBoardAsset, putBoardAsset, keepConversionBackup, recoveryEvent, recoveryJournal, ask, currentVaultIdRef, dialogRef, editableCopyRef, diskStateRef, flushingRef, nativePoliciesRef, nativeTransitionRef, rootHandleRef, saveTimersRef, sessionReportRef, tabsRef]);

  return { nativeCanvasHost };
}
