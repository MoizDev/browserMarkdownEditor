import React, { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ContentChangeOptions, FileSystemContextValue, OpenTab, TabLayout } from '../types';
import type { NativeCanvasReady, ReaderIdentity } from '../types/reading';
import { canReadTabText, canUpdateTabContent, classifyLoadedTabs, withNativeCanvasPolicy } from '../utils/documentReading';
import { createDocumentBuffers, type ContentSource } from '../utils/documentBuffers';
import { createDocumentSessions } from '../utils/documentSessions';
import type { MarkdownSessionAdapter, MarkdownSessionHost } from '../editor/markdownSession.types';
import { attachCanvasSession, createCanvasSessionBridge } from '../utils/canvasSessionBridge';
import type { AttachCanvasSession } from '../utils/canvasSessionBridge';
import { installSessionIdentity, getSessionIdentity, prepareBytesChange } from '../utils/sessionIdentity';
import { installDocumentSessions } from '../utils/unloadCoordinator';
import { ensurePdfSessionRoute } from '../utils/pdfSessionRoute';
import { bindRecoveryAdapter } from '../utils/recoveryAdapters';
import { isCanvasFile, isNotebookFile } from '../utils/fileTypes';
import { EMPTY_LAYOUT, focusedPath as focusedPathOf, visiblePaths } from '../utils/tabPanes';
import { setActiveFilePath } from '../utils/activeFile';
import { RECOVERY_SESSION_BINDING, hasHostedNativeOwner } from './nativeOwners';
import type { NativePolicy } from './types';
import { loadChunk } from '../platform/chunkLoad';

/** What the open-documents hook reads from App. */
export interface UseOpenDocumentsDeps {
  getVaultActivation: FileSystemContextValue['getVaultActivation'];
}

export function useOpenDocuments(deps: UseOpenDocumentsDeps) {
  const { getVaultActivation } = deps;

  // Every open document, flat — one entry per file, whatever tab it is drawn
  // in. Autosave, the asset diff, search and rename all index this by path.
  const classificationSourceRef = useRef<(id: string) => ContentSource | undefined>(() => undefined);
  const [tabs, setTabs] = useReducer(
    (previous: OpenTab[], action: React.SetStateAction<OpenTab[]>) =>
      classifyLoadedTabs(typeof action === 'function' ? action(previous) : action, previous, classificationSourceRef.current),
    [],
  );
  const [, setClosingDocumentIds] = useState<ReadonlySet<string>>(() => new Set());
  const closingRef = useRef(new Set<string>());
  const reopenedClosingRef = useRef(new Set<string>());
  // How those documents are arranged on screen: a row of panes — columns, all
  // drawn at once — each holding its own ordered tabs and showing one of them
  // (utils/tabPanes.ts). One pane with a few tabs is the ordinary workspace; up
  // to five columns is the ceiling. The panes, the focused one's id and the
  // columns' widths are ONE piece of state so no update can leave the active id
  // naming a pane it just removed, or a width row indexed against a pane list
  // that moved underneath it; the focused document — the old `activeTabPath` —
  // is derived from it, which is what keeps those from drifting.
  const [layout, setLayout] = useState<TabLayout>(EMPTY_LAYOUT);
  const activeTabPath = focusedPathOf(layout);

  const activeTab = useMemo(
    () => tabs.find(t => t.file.path === activeTabPath) ?? null,
    [tabs, activeTabPath]
  );
  // Keeping `t.file` identity stable across keystrokes (see updateTabContent)
  // means `activeFile` only changes when the focus does, not on every edit.
  // It is what the file tree highlights and what the graph view centres on;
  // the editor derives its own from the layout, pane by pane.
  const activeFile = activeTab?.file ?? null;
  /* Published to a store as well as held in state: the file tree reads "am I
     the active row" from it per row, so switching tabs re-renders the two rows
     that changed instead of every row in the vault. See utils/activeFile.ts. */
  useEffect(() => { setActiveFilePath(activeFile?.path ?? null); }, [activeFile]);

  // Refs mirroring tab state for use inside stable callbacks / timers.
  const tabsRef = useRef<OpenTab[]>(tabs);
  const sessionReportRef = useRef<(documentId: string, source: ContentSource, options?: ContentChangeOptions) => void>(() => {});
  const nativeTransitionRef = useRef<(documentId: string, source: import('../utils/documentBuffers').DeferredSource, revision: number, prior: ContentSource) => void>(() => { throw new Error('Canvas source coordinator is not ready'); });
  const bytesGenerationsRef = useRef(new Map<string, number>());
  const bufferPathIdsRef = useRef(new Map<string, string>());
  const [documentBuffers] = useState(() => createDocumentBuffers(path => bufferPathIdsRef.current.get(path)));
  classificationSourceRef.current = id => documentBuffers.get(id)?.source;
  const seedDocumentBuffer = useCallback((id: string, path: string, content: string, readable: boolean) => {
    documentBuffers.open(id, content, readable);
    if (!bufferPathIdsRef.current.has(path)) bufferPathIdsRef.current.set(path, id);
  }, [documentBuffers]);
  const [documentSessions] = useState(() => createDocumentSessions({
    bufferState: id => documentBuffers.get(id),
    reportChange: (id, source, options) => sessionReportRef.current(id, source, options),
  }));
  useEffect(() => installSessionIdentity(documentSessions), [documentSessions]);
  useEffect(() => installDocumentSessions(documentSessions), [documentSessions]);
  const markdownSessions = useMemo<MarkdownSessionHost>(() => {
    const get = (id: string): MarkdownSessionAdapter | undefined => {
      const entry = documentSessions.get(id);
      return entry?.kind === 'markdown' && 'dispatch' in entry.adapter ? entry.adapter as MarkdownSessionAdapter : undefined;
    };
    const ensure: MarkdownSessionHost['ensure'] = (id, create) => {
      const tab = tabsRef.current.find(candidate => candidate.id === id);
      if (!tab || !canReadTabText(tab)) return undefined;
      const existing = documentSessions.get(id);
      if (existing) return get(id);
      if (!documentBuffers.get(id)) return undefined;
      const entry = documentSessions.ensure(id, 'markdown', bytesGenerationsRef.current.get(id) ?? 0, create);
      documentBuffers.setOwner(id, { documentId: id, session: entry.serial });
      entry.setSlot(RECOVERY_SESSION_BINDING, bindRecoveryAdapter(id, entry.adapter), dispose => dispose());
      return entry.adapter;
    };
    return {
      get, ensure,
      pathOf: id => tabsRef.current.find(tab => tab.id === id)?.file.path,
      parentHandleOf: id => tabsRef.current.find(tab => tab.id === id)?.file.parentHandle ?? null,
      async dispatch(id, spec) {
        const target = tabsRef.current.find(tab => tab.id === id);
        if (!target || !canUpdateTabContent(target)) return false;
        const revision = documentBuffers.revisionForDocument(id)?.revision;
        const activation = getVaultActivation();
        let adapter = get(id);
        if (!adapter) {
          const [{ EditorState }, { history }, { createMarkdownSession }] = await Promise.all([
            loadChunk(() => import('@codemirror/state')), loadChunk(() => import('@codemirror/commands')), loadChunk(() => import('../editor/markdownSession')),
          ]);
          const current = tabsRef.current.find(tab => tab.id === id);
          if (!current || !canUpdateTabContent(current) || getVaultActivation() !== activation
            || documentBuffers.revisionForDocument(id)?.revision !== revision) return false;
          const text = documentBuffers.contentForDocument(id);
          if (text === undefined) return false;
          adapter = ensure(id, owner => createMarkdownSession(owner,
            EditorState.create({ doc: text, extensions: history() }), () => documentBuffers.get(id)?.source));
        }
        if (!adapter) return false;
        adapter.dispatch(spec);
        return true;
      },
    };
  }, [documentBuffers, documentSessions, getVaultActivation]);
  const bumpBytesGeneration = useCallback((id: string, preserveNative = false) => {
    const previous = bytesGenerationsRef.current.get(id) ?? 0;
    const generation = previous + 1;
    prepareBytesChange(id, generation);
    bytesGenerationsRef.current.set(id, generation);
    const session = documentSessions.get(id);
    const policy = nativePoliciesRef.current.get(id);
    const tab = tabsRef.current.find(candidate => candidate.id === id);
    const kind = tab?.representation.loadedKind === 'pdf' ? 'pdfInk' : tab?.representation.loadedKind;
    if (preserveNative && policy && session && policy.session === session.serial && policy.kind === kind
      && session.bytesGeneration === previous && policy.activation === getVaultActivation() && policy.retainedThroughGeneration === previous
      && hasHostedNativeOwner(session, id)) policy.retainedThroughGeneration = generation;
    if (session) documentSessions.setBytesGeneration(id, generation);
  }, [documentSessions, getVaultActivation]);
  const invalidReaderTokens = useRef(new Set<string>());
  const layoutRef = useRef<TabLayout>(layout);
  const activeTabPathRef = useRef<string | null>(activeTabPath);
  // The documents currently on screen — one per column, since a pane shows one
  // of its tabs, and every column not just the focused one, so a save in a
  // neighbouring pane still reports itself. A document merely OPEN behind
  // another tab of the same pane is not here: nothing on screen would show it.
  const visiblePathsRef = useRef<string[]>([]);
  // Per-PATH debounced save timers, so switching or closing one tab never
  // cancels another tab's pending write (fixes the old single-timer data loss).
  const saveTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const ensureCanvasBridge = useCallback((tab: OpenTab) => {
    const kind = tab.representation.loadedKind;
    if (tab.readError || !kind || !['pdf', 'drawing', 'notebook'].includes(kind)) {
      throw new Error('Canvas representation is not ready');
    }
    const entry = documentSessions.ensure(tab.id, kind, bytesGenerationsRef.current.get(tab.id) ?? 0,
      owner => createCanvasSessionBridge(owner, () => documentBuffers.get(tab.id)?.source ?? ''));
    if (kind === 'pdf') ensurePdfSessionRoute(entry);
    documentBuffers.setOwner(tab.id, { documentId: tab.id, session: entry.serial });
    if (!entry.getSlot(RECOVERY_SESSION_BINDING)) {
      entry.setSlot(RECOVERY_SESSION_BINDING, bindRecoveryAdapter(tab.id, entry.adapter), dispose => dispose());
    }
    return entry;
  }, [documentBuffers, documentSessions]);
  // A binary host acquires in its passive effect. Publish the new tab first;
  // lazy dev imports hid this parent/child effect ordering race in production.
  useLayoutEffect(() => {
    tabsRef.current = tabs;
    for (const tab of tabs) {
      if (!bufferPathIdsRef.current.has(tab.file.path)) bufferPathIdsRef.current.set(tab.file.path, tab.id);
      documentBuffers.setReadable(tab.id, canReadTabText(tab));
    }
    // A reader needs its identity before its editable engine mounts. The
    // bridge attaches that engine later without replacing its serial or slots.
    for (const path of visiblePaths(layout)) {
      const tab = tabs.find(t => t.file.path === path);
      const kind = tab?.representation.loadedKind;
      if (!tab || tab.readError || !kind || !['pdf', 'drawing', 'notebook'].includes(kind)) continue;
      ensureCanvasBridge(tab);
    }
  }, [tabs, layout, documentBuffers, ensureCanvasBridge]);
  const attachNativeCanvasSession = useCallback<AttachCanvasSession>(
    (documentId, create, commit) => attachCanvasSession(documentSessions, documentId, create, commit), [documentSessions]);
  const nativePoliciesRef = useRef(new Map<string, NativePolicy>());
  const onNativeCanvasReady = useCallback<NativeCanvasReady>(acquisition => {
    const { owner, vaultActivation, bytesGeneration, kind } = acquisition;
    const live = () => {
      const identity = getSessionIdentity(owner.documentId);
      const policy = nativePoliciesRef.current.get(owner.documentId), session = documentSessions.get(owner.documentId);
      return getVaultActivation() === vaultActivation && identity?.serial === owner.session && (identity.bytesGeneration === bytesGeneration
        || !!policy && policy.session === owner.session && policy.activation === vaultActivation && policy.kind === kind
          && policy.sourceGeneration === bytesGeneration && policy.retainedThroughGeneration === identity.bytesGeneration
          && hasHostedNativeOwner(session, owner.documentId));
    };
    const tab = tabsRef.current.find(t => t.id === owner.documentId);
    if (!live() || !tab || tab.readError || tab.representation.status !== 'ready') return null;
    if (kind === 'pdfInk' ? tab.representation.loadedKind !== 'pdf'
      : kind === 'notebook' ? !isNotebookFile(tab.file.name)
        : !isCanvasFile(tab.file.name) || isNotebookFile(tab.file.name)) return null;
    const prior = nativePoliciesRef.current.get(owner.documentId);
    const same = prior && prior.session === owner.session && prior.sourceGeneration === bytesGeneration && prior.activation === vaultActivation && prior.kind === kind;
    const emergencyReadOnly = same ? prior.emergencyReadOnly : !!withNativeCanvasPolicy(tab.representation, kind).emergencyReadOnly;
    if (!same && kind === 'pdfInk' && !acquisition.pdfWriteAuthority) return null;
    if (!same) nativePoliciesRef.current.set(owner.documentId, { session: owner.session, sourceGeneration: bytesGeneration,
      retainedThroughGeneration: bytesGeneration, activation: vaultActivation, kind, emergencyReadOnly,
      ...(acquisition.pdfWriteAuthority ? { pdfWriteAuthority: acquisition.pdfWriteAuthority } : {}) });
    const digest = acquisition.legacyOriginalSha256;
    const legacyOriginalSha256 = digest && /^[a-f0-9]{64}$/.test(digest) ? digest : undefined;
    // The bridge's initial conversion report follows this callback synchronously,
    // before React commits the representation update.
    tabsRef.current = tabsRef.current.map(current => current.id === owner.documentId && live()
      ? { ...current, representation: { ...current.representation, nativeCanvasKind: kind, nativeCanvasSession: owner.session, emergencyReadOnly, legacyOriginalSha256 } }
      : current);
    setTabs(previous => previous.map(current => current.id === owner.documentId && live()
      ? { ...current, representation: { ...current.representation, nativeCanvasKind: kind, nativeCanvasSession: owner.session, emergencyReadOnly, legacyOriginalSha256 } }
      : current));
    return { emergencyReadOnly };
  }, [documentSessions, getVaultActivation]);

  useEffect(() => {
    const open = new Set(tabs.map(tab => tab.id));
    for (const id of nativePoliciesRef.current.keys()) if (!open.has(id)) nativePoliciesRef.current.delete(id);
  }, [tabs]);
  useEffect(() => {
    layoutRef.current = layout;
    visiblePathsRef.current = visiblePaths(layout);
  }, [layout]);
  useEffect(() => { activeTabPathRef.current = activeTabPath; }, [activeTabPath]);

  const contentOf = useCallback((path: string): string | undefined => documentBuffers.contentOf(path), [documentBuffers]);

  /** Documents with a write queued or running — App.hasUnsaved. */
  const flushingRef = useRef(new Map<string, number>());
  const readerIdentityCache = useRef(new Map<string, ReaderIdentity>());

  return {
    tabs, setTabs,
    setClosingDocumentIds,
    closingRef,
    reopenedClosingRef,
    layout, setLayout,
    activeTabPath,
    activeFile,
    tabsRef,
    sessionReportRef,
    nativeTransitionRef,
    bytesGenerationsRef,
    bufferPathIdsRef,
    documentBuffers,
    seedDocumentBuffer,
    documentSessions,
    markdownSessions,
    bumpBytesGeneration,
    invalidReaderTokens,
    layoutRef,
    activeTabPathRef,
    visiblePathsRef,
    saveTimersRef,
    ensureCanvasBridge,
    attachNativeCanvasSession,
    nativePoliciesRef,
    onNativeCanvasReady,
    contentOf,
    flushingRef,
    readerIdentityCache,
  };
}
