import type React from 'react';
import type { FileSystemContextValue, OpenTab } from '../types';
import type { ClosedPdfAgentAccess } from '../types/vaultAgent';
import type { NativeCanvasHost } from '../types/nativeCanvas';
import type { NativeCanvasReady } from '../types/reading';
import type { AgentHostDeps } from '../utils/agentHost';
import { BOARD_Z_MAX } from '../utils/boardZMax';
import { createClosedCanvasVersions } from '../utils/closedCanvasVersions';
import type { AttachCanvasSession } from '../utils/canvasSessionBridge';
import { getBaseline } from '../utils/docBaselines';
import type { DocumentBufferStore } from '../utils/documentBuffers';
import type { DocumentSessionStore } from '../utils/documentSessions';
import { newTabId } from './documentIds';
import type { NativePolicy } from './types';
import type { UseAgentCanvasAccessDeps } from './useAgentCanvasAccess';
import { loadChunk } from '../platform/chunkLoad';

export interface AgentCanvasDeps extends UseAgentCanvasAccessDeps {
  closedCanvasVersions: ReturnType<typeof createClosedCanvasVersions>;
  closedCanvasReads: React.MutableRefObject<Set<{ root: FileSystemDirectoryHandle; activation: number; path: string; controller: AbortController }>>;
}

export async function ensureNativeAgentRuntime(deps: Pick<AgentCanvasDeps,
  'tabsRef' | 'documentBuffers' | 'nativePoliciesRef' | 'nativeCanvasHost' | 'attachNativeCanvasSession' |
  'onNativeCanvasReady' | 'ensureCanvasBridge' | 'announce'
>, ...[path, signal]: Parameters<NonNullable<AgentHostDeps['ensureNativeAgentRuntime']>>): ReturnType<NonNullable<AgentHostDeps['ensureNativeAgentRuntime']>> {
  const {
    tabsRef, documentBuffers, nativePoliciesRef, nativeCanvasHost, attachNativeCanvasSession,
    onNativeCanvasReady, ensureCanvasBridge, announce,
  } = deps;
  signal.throwIfAborted();
  const tab = tabsRef.current.find(item => item.file.path === path);
  const kind = tab?.representation.loadedKind;
  if (!tab || tab.readError || tab.representation.status !== 'ready' || (kind !== 'drawing' && kind !== 'notebook' && kind !== 'pdf')) {
    throw new Error('The open canvas representation is not available for native reading.');
  }
  ensureCanvasBridge(tab);
  const identity = nativeCanvasHost.identity(tab.id);
  if (!identity || identity.kind !== (kind === 'pdf' ? 'pdfInk' : kind)) throw new DOMException('Canvas session ended', 'AbortError');
  const pinned = kind === 'pdf' || nativeCanvasHost.session(tab.id) ? undefined : nativeCanvasHost.pinBoardSource(identity);
  const pinCleanPdf = () => {
    const buffer = documentBuffers.get(tab.id), baseline = getBaseline(tab.id);
    if (buffer && buffer.revision > buffer.savedRevision) return { ok: false as const, message: 'Save the PDF before the agent reads or edits its ink.' };
    if (!baseline) return { ok: false as const, message: 'The PDF has no verified disk baseline, so the agent cannot read it.' };
    return { ok: true as const, buffer, revision: buffer?.revision, source: buffer?.source, baseline };
  };
  const pdfPin = kind === 'pdf' ? pinCleanPdf() : undefined;
  const pdfPinHolds = (pin: Extract<ReturnType<typeof pinCleanPdf>, { ok: true }>) => {
    const buffer = documentBuffers.get(tab.id);
    return nativeCanvasHost.isCurrent(identity) && buffer === pin.buffer && buffer?.revision === pin.revision
      && buffer?.source === pin.source && getBaseline(tab.id) === pin.baseline && !(buffer && buffer.revision > buffer.savedRevision);
  };
  let pinTransferred = false;
  try {
  const [{ ensureNativeBoard }, { createNativeAcquisitionOptions }, { prepareNativeRuntime }, { getBoardRuntime }] = await Promise.all([
    loadChunk(() => import('../components/whiteboard/acquireNativeBoard')), loadChunk(() => import('../components/whiteboard/nativeAcquisitionOptions')),
    loadChunk(() => import('../whiteboard/host/prepareNativeRuntime')), loadChunk(() => import('../whiteboard/host/runtime')),
  ]);
  signal.throwIfAborted();
  if (!nativeCanvasHost.isCurrent(identity)) throw new DOMException('Canvas session ended', 'AbortError');
  const reason = 'This native canvas is currently available in read-only mode.';
  const onError = (error: unknown) => console.error('Native canvas session failed:', error);
  const preparePdfAgentSource = async (prepareSignal: AbortSignal) => {
    if (!pdfPin?.ok) throw new Error(pdfPin?.message ?? 'The PDF source is unavailable.');
    const pin = pdfPin;
    const changed = () => new Error('The PDF changed while the agent was reading it; try again.');
    const { preparePdfInkAttempt } = await loadChunk(() => import('../components/whiteboard/preparePdfInkAttempt'));
    if (!pdfPinHolds(pin)) throw changed();
    const prepared = await preparePdfInkAttempt({ host: nativeCanvasHost, identity, deadlineMs: 30_000, zMax: BOARD_Z_MAX,
      legacyConversion: false, requireExistingNative: true, onError,
      onNotice: announce, onHistoryLimit: () => announce('The board history limit was reached.') }, prepareSignal);
    if (!pdfPinHolds(pin)) { await prepared.dispose(); throw changed(); }
    return { ...prepared, take(owner: Parameters<typeof prepared.take>[0], isLiveOwner: Parameters<typeof prepared.take>[1], readOnlyReason: Parameters<typeof prepared.take>[2]) {
      if (!pdfPinHolds(pin)) throw changed();
      return prepared.take(owner, isLiveOwner, readOnlyReason);
    } };
  };
  const options = createNativeAcquisitionOptions({ host: nativeCanvasHost, identity,
    attachCanvasSession: attachNativeCanvasSession, onNativeCanvasReady, emergencyReadOnlyReason: reason,
    emergencyReadOnly: () => !!nativePoliciesRef.current.get(tab.id)?.emergencyReadOnly,
    onError, prepare: prepareSignal => {
      if (kind === 'pdf') return preparePdfAgentSource(prepareSignal);
      pinTransferred = true;
      return prepareNativeRuntime({ host: nativeCanvasHost, identity, representation: kind, sourcePin: pinned,
        signal: prepareSignal, deadlineMs: 30_000, zMax: BOARD_Z_MAX, onError,
        onHistoryLimit: () => announce('The board history limit was reached.') });
    },
  });
  const acquired = await ensureNativeBoard(options, signal);
  signal.throwIfAborted();
  const runtime = getBoardRuntime(acquired.adapter.board);
  if (!runtime || !nativeCanvasHost.isCurrent(identity) || nativeCanvasHost.session(tab.id) !== acquired.adapter) {
    throw new DOMException('Canvas session ended', 'AbortError');
  }
  const isCurrent = () => nativeCanvasHost.isCurrent(identity) && nativeCanvasHost.session(tab.id) === acquired.adapter;
  return { identity, runtime, isCurrent, canWrite: () => isCurrent() && nativeCanvasHost.canWrite(identity),
    writeBlockReason: () => isCurrent() ? nativeCanvasHost.writeBlockReason(identity) : 'The native canvas session has ended.',
    activateEditing() {
      if (!isCurrent() || !nativeCanvasHost.canWriteSource(identity)) throw new Error(nativeCanvasHost.writeBlockReason(identity) ?? 'The native canvas source is not writable.');
      if (!acquired.adapter.activateEditing) throw new Error('The native session has no editing admission.');
      acquired.adapter.activateEditing();
      if (!isCurrent() || !nativeCanvasHost.canWrite(identity)) throw new Error('The native canvas source is no longer writable.');
    },
    async readMedia(entry, mediaSignal) {
      mediaSignal.throwIfAborted();
      if (!isCurrent()) throw new DOMException('Canvas session ended', 'AbortError');
      const pending = runtime.media.get(entry.id);
      if (pending) return pending;
      if (kind === 'pdf') {
        const { getPdfInkSourceState } = await loadChunk(() => import('../whiteboard/host/preparePdfInkSession'));
        const state = getPdfInkSourceState(identity.documentId);
        if (!state) throw new DOMException('Canvas session ended', 'AbortError');
        const blob = await state.readMedia(entry.id, mediaSignal);
        mediaSignal.throwIfAborted();
        if (!isCurrent()) throw new DOMException('Canvas session ended', 'AbortError');
        return blob;
      }
      const result = await nativeCanvasHost.readMedia(identity, { hash: entry.id.slice(7), preferredName: entry.file }, mediaSignal);
      mediaSignal.throwIfAborted();
      if (!isCurrent()) throw new DOMException('Canvas session ended', 'AbortError');
      return result?.blob ?? null;
    } };
  } finally { if (!pinTransferred) pinned?.release(); }
}

export async function acquireClosedAgentCanvas(deps: Pick<AgentCanvasDeps,
  'rootHandleRef' | 'bufferPathIdsRef' | 'tabsRef' | 'documentSessions' | 'getVaultActivation' | 'handleIO' |
  'readFileSnapshot' | 'statFile' | 'verifyVaultFileIdentity' | 'closedCanvasVersions' |
  'closedCanvasReads'
>, ...[path, handle, kind, guard]: Parameters<NonNullable<AgentHostDeps['acquireClosedCanvasSource']>>): ReturnType<NonNullable<AgentHostDeps['acquireClosedCanvasSource']>> {
  const {
    rootHandleRef, bufferPathIdsRef, tabsRef, documentSessions, getVaultActivation, handleIO,
    readFileSnapshot, statFile, verifyVaultFileIdentity, closedCanvasVersions, closedCanvasReads,
  } = deps;
  const root = rootHandleRef.current, activation = getVaultActivation();
  if (!root) throw new DOMException('Vault is closed', 'AbortError');
  const read = { root, activation, path, controller: new AbortController() };
  closedCanvasReads.current.add(read);
  const signal = AbortSignal.any([guard.signal, read.controller.signal]);
  const isCurrent = () => !signal.aborted && guard.isCurrent() && rootHandleRef.current === root
    && getVaultActivation() === activation && !bufferPathIdsRef.current.has(path)
    && !tabsRef.current.some(tab => tab.file.path === path);
  try {
    const { acquireClosedCanvasSource } = await loadChunk(() => import('../utils/closedCanvasSource'));
    const lease = await acquireClosedCanvasSource({ root, activation, path, handle, kind, signal, documentId: newTabId(),
      sessions: documentSessions, versions: closedCanvasVersions, io: { handleIO, readFileSnapshot, statFile, verifyVaultFileIdentity }, isCurrent });
    return { ...lease, async release() { try { await lease.release(); } finally { closedCanvasReads.current.delete(read); } } };
  } catch (error) { closedCanvasReads.current.delete(read); throw error; }
}

export async function readClosedAgentCanvasMedia(deps: Pick<AgentCanvasDeps,
  'rootHandleRef' | 'getVaultActivation' | 'readBoardAsset' | 'resolveVaultFile'
>, ...[path, handle, entry, signal]: Parameters<NonNullable<AgentHostDeps['readClosedCanvasMedia']>>): ReturnType<NonNullable<AgentHostDeps['readClosedCanvasMedia']>> {
  const {
    rootHandleRef, getVaultActivation, readBoardAsset, resolveVaultFile,
  } = deps;
  const root = rootHandleRef.current, activation = getVaultActivation();
  if (!root) throw new DOMException('Vault is closed', 'AbortError');
  const isCurrent = () => !signal.aborted && rootHandleRef.current === root && getVaultActivation() === activation;
  const { parentHandle } = await resolveVaultFile(root, path);
  if (!isCurrent()) throw new DOMException('Vault changed', 'AbortError');
  const found = await readBoardAsset({ root, parent: parentHandle, owner: handle, hash: entry.id.slice(7),
    preferredName: entry.file, signal, isCurrent });
  if (!found) return null;
  return new Response(found.blob.stream()).blob();
}
