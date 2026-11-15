import type React from 'react';
import { useCallback, useLayoutEffect, useMemo, useEffect, useRef, useState } from 'react';
import type { FileSystemContextValue, OpenTab } from '../types';
import type { ClosedPdfAgentAccess } from '../types/vaultAgent';
import type { NativeCanvasHost } from '../types/nativeCanvas';
import type { NativeCanvasReady } from '../types/reading';
import type { AgentHostDeps } from '../utils/agentHost';
import { BOARD_Z_MAX } from '../utils/boardZMax';
import { createClosedCanvasVersions } from '../utils/closedCanvasVersions';
import type { AttachCanvasSession } from '../utils/canvasSessionBridge';
import type { DocumentBufferStore } from '../utils/documentBuffers';
import type { DocumentSessionStore } from '../utils/documentSessions';
import type { NativePolicy } from './types';

// The per-process counter behind the closed PDF agent's document identities (see
// closedPdfAccess): a module-level sequence, so it never repeats within a page load.
let closedPdfAgentSeq = 0;

/** The App-scope values `useAgentCanvasAccess` reads, named as App names them. */
export interface UseAgentCanvasAccessDeps {
  rootHandle: FileSystemContextValue['rootHandle'];
  rootHandleRef: React.RefObject<FileSystemDirectoryHandle | null>;
  currentVaultIdRef: React.RefObject<string | null>;
  readerEpochRef: React.RefObject<{ root: FileSystemDirectoryHandle | null; epoch: number }>;
  bufferPathIdsRef: React.RefObject<Map<string, string>>;
  tabs: OpenTab[];
  tabsRef: React.RefObject<OpenTab[]>;
  documentBuffers: DocumentBufferStore;
  documentSessions: DocumentSessionStore;
  nativePoliciesRef: React.RefObject<Map<string, NativePolicy>>;
  nativeCanvasHost: NativeCanvasHost;
  attachNativeCanvasSession: AttachCanvasSession;
  onNativeCanvasReady: NativeCanvasReady;
  ensureCanvasBridge: (tab: OpenTab) => void;
  announce: (message: string) => void;
  getVaultActivation: FileSystemContextValue['getVaultActivation'];
  handleIO: FileSystemContextValue['handleIO'];
  readFileSnapshot: FileSystemContextValue['readFileSnapshot'];
  statFile: FileSystemContextValue['statFile'];
  verifyVaultFileIdentity: FileSystemContextValue['verifyVaultFileIdentity'];
  readBoardAsset: FileSystemContextValue['readBoardAsset'];
  resolveVaultFile: FileSystemContextValue['resolveVaultFile'];
}

export function useAgentCanvasAccess(deps: UseAgentCanvasAccessDeps) {
  const {
    rootHandle, rootHandleRef, currentVaultIdRef, readerEpochRef, bufferPathIdsRef, tabs, tabsRef,
    documentBuffers, documentSessions, nativePoliciesRef, nativeCanvasHost, attachNativeCanvasSession,
    onNativeCanvasReady, ensureCanvasBridge, announce, getVaultActivation, handleIO, readFileSnapshot,
    statFile, verifyVaultFileIdentity, readBoardAsset, resolveVaultFile,
  } = deps;

  const closedPdfAccess = useMemo<ClosedPdfAgentAccess>(() => {
    const prepare = async (signal: AbortSignal) => {
      signal.throwIfAborted();
      const root = rootHandleRef.current, vault = currentVaultIdRef.current;
      const vaultEpoch = readerEpochRef.current.epoch, activation = getVaultActivation();
      if (!root || !vault) throw new DOMException('Vault is unavailable', 'AbortError');
      if (closedPdfAgentSeq === Number.MAX_SAFE_INTEGER) throw new RangeError('PDF agent identity exhausted');
      const serial = ++closedPdfAgentSeq;
      const token = { vaultEpoch, documentId: `agent-pdf-${serial.toString(36)}`, bytesGeneration: 0, session: serial };
      const isCurrent = () => !signal.aborted && rootHandleRef.current === root && currentVaultIdRef.current === vault &&
        readerEpochRef.current.epoch === vaultEpoch && getVaultActivation() === activation;
      const [startup, agent] = await Promise.all([import('../pdf/session/startup'), import('../pdf/text/agentAccess')]);
      if (!isCurrent()) throw new DOMException('Vault changed', 'AbortError');
      const access = agent.createClosedPdfAgentAccess(startup.getSharedPdfPool(), () => ({ token, isCurrent }));
      return { access, isCurrent };
    };
    return {
      async read(...args) {
        const { access, isCurrent } = await prepare(args[5]);
        const result = await access.read(...args);
        if (!isCurrent()) throw new DOMException('Vault changed', 'AbortError');
        return result;
      },
      async render(...args) {
        const { access, isCurrent } = await prepare(args[4]);
        const result = await access.render(...args);
        if (!isCurrent()) throw new DOMException('Vault changed', 'AbortError');
        return result;
      },
    };
  }, [getVaultActivation, currentVaultIdRef, readerEpochRef, rootHandleRef]);

  const ensureNativeAgentRuntime = useCallback<NonNullable<AgentHostDeps['ensureNativeAgentRuntime']>>(async (path, signal) =>
    (await import('./agentCanvas')).ensureNativeAgentRuntime({
      tabsRef, documentBuffers, nativePoliciesRef, nativeCanvasHost, attachNativeCanvasSession,
      onNativeCanvasReady, ensureCanvasBridge, announce,
    }, path, signal), [
      announce, attachNativeCanvasSession, documentBuffers, ensureCanvasBridge, nativeCanvasHost,
      onNativeCanvasReady, nativePoliciesRef, tabsRef,
    ]);

  const [closedCanvasVersions] = useState(() => createClosedCanvasVersions());
  const closedCanvasReads = useRef(new Set<{ root: FileSystemDirectoryHandle; activation: number; path: string; controller: AbortController }>());
  useLayoutEffect(() => {
    for (const read of closedCanvasReads.current) {
      if (read.root !== rootHandle || read.activation !== getVaultActivation() || tabs.some(tab => tab.file.path === read.path)) read.controller.abort();
    }
  }, [rootHandle, tabs, getVaultActivation]);
  useEffect(() => () => { for (const read of closedCanvasReads.current) read.controller.abort(); }, []);
  const acquireClosedAgentCanvas = useCallback<NonNullable<AgentHostDeps['acquireClosedCanvasSource']>>(async (path, handle, kind, guard) =>
    (await import('./agentCanvas')).acquireClosedAgentCanvas({
      rootHandleRef, bufferPathIdsRef, tabsRef, documentSessions, getVaultActivation, handleIO,
      readFileSnapshot, statFile, verifyVaultFileIdentity, closedCanvasVersions, closedCanvasReads,
    }, path, handle, kind, guard), [
      closedCanvasVersions, documentSessions, getVaultActivation, handleIO, readFileSnapshot, statFile,
      verifyVaultFileIdentity, bufferPathIdsRef, rootHandleRef, tabsRef,
    ]);

  /** A closed board's embedded picture, read from its own folder's `.Assets` (the same reader recovery uses). */
  const readClosedAgentCanvasMedia = useCallback<NonNullable<AgentHostDeps['readClosedCanvasMedia']>>(async (path, handle, entry, signal) =>
    (await import('./agentCanvas')).readClosedAgentCanvasMedia({
      rootHandleRef, getVaultActivation, readBoardAsset, resolveVaultFile,
    }, path, handle, entry, signal), [
      getVaultActivation, readBoardAsset, resolveVaultFile, rootHandleRef,
    ]);

  return { closedPdfAccess, ensureNativeAgentRuntime, acquireClosedAgentCanvas, readClosedAgentCanvasMedia };
}
