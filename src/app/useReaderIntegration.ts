import type React from 'react';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { FileSystemContextValue, OpenTab, TabLayout } from '../types';
import type { ReaderIdentity, ReaderIntegration, ReaderToken } from '../types/reading';
import { getBaseline, setBaseline } from '../utils/docBaselines';
import { getReadingSurface, runReaderHostCommand } from '../utils/documentReading';
import { writePdfTextViewState, writeReaderViewState } from '../utils/readerViewState';
import { closeContextMenu } from '../utils/contextMenu';
import { getView } from '../utils/viewRegistry';
import { focusTab } from '../utils/tabPanes';
import type { Notify } from './useAppDialogs';
import type { PdfRebuildEntry, SetDiskState, SetLayout, SetTabs } from './types';

export interface UseReaderIntegrationDeps {
  readFileSnapshot: FileSystemContextValue['readFileSnapshot'];
  currentVaultIdRef: React.RefObject<string | null>;
  readerEpochRef: React.RefObject<{ root: FileSystemDirectoryHandle | null; epoch: number }>;
  notify: Notify;
  announce: (message: string) => void;
  tabsRef: React.RefObject<OpenTab[]>;
  setTabs: SetTabs;
  layoutRef: React.RefObject<TabLayout>;
  setLayout: SetLayout;
  activeTabPathRef: React.RefObject<string | null>;
  invalidReaderTokens: React.RefObject<Set<string>>;
  readerIdentityCache: React.RefObject<Map<string, ReaderIdentity>>;
  diskStateRef: React.RefObject<Map<string, 'conflict' | 'deleted'>>;
  pdfRebuildRef: React.RefObject<Map<string, PdfRebuildEntry>>;
  setDiskState: SetDiskState;
  closeTab: (path: string) => void;
  reopenClosedTab: () => Promise<string | undefined>;
  checkOpenDocs: (scope: ReadonlySet<string> | 'all') => Promise<void>;
}

export function useReaderIntegration(deps: UseReaderIntegrationDeps) {
  const {
    readFileSnapshot, currentVaultIdRef, readerEpochRef, notify, announce,
    tabsRef, setTabs, layoutRef, setLayout, activeTabPathRef, invalidReaderTokens, readerIdentityCache,
    diskStateRef, pdfRebuildRef, setDiskState,
    closeTab, reopenClosedTab, checkOpenDocs,
  } = deps;

  useEffect(() => {
    const report = () => announce('Reading works, but this browser could not save reading preferences or position.');
    window.addEventListener('reading-persistence-unavailable', report);
    return () => window.removeEventListener('reading-persistence-unavailable', report);
  }, [announce]);

  const readerDeps = useRef({ readFileSnapshot, notify, announce, closeTab, reopenClosedTab, checkOpenDocs });
  useLayoutEffect(() => { readerDeps.current = { readFileSnapshot, notify, announce, closeTab, reopenClosedTab, checkOpenDocs }; });
  const readerIntegration = useMemo<ReaderIntegration>(() => {
    const current = (token: ReaderToken) => {
      if (invalidReaderTokens.current.has(`${token.documentId}|${token.byteGeneration}`)) return undefined;
      if (token.vaultId !== currentVaultIdRef.current || token.vaultEpoch !== readerEpochRef.current.epoch) return undefined;
      return tabsRef.current.find(t => t.id === token.documentId && t.representation.generation === token.byteGeneration);
    };
    const identityForTab = (tab: OpenTab): ReaderIdentity => {
      const key = `${currentVaultIdRef.current}|${readerEpochRef.current.epoch}|${tab.id}|${tab.file.path}|${tab.representation.generation}`;
      let identity = readerIdentityCache.current.get(key);
      if (!identity) { identity = { vaultId: currentVaultIdRef.current ?? '', vaultEpoch: readerEpochRef.current.epoch, documentId: tab.id, byteGeneration: tab.representation.generation, path: tab.file.path, diskRev: tab.diskRev ?? 0, rawVersion: getBaseline(tab.id) }; readerIdentityCache.current.set(key, identity); }
      return identity;
    };
    return { identityForTab,
      async acquireSnapshot(identity, signal) { const tab = current(identity); if (!tab?.file.handle || tab.file.path !== identity.path) throw new DOMException('Reader changed', 'AbortError'); return readerDeps.current.readFileSnapshot(tab.file.handle as FileSystemFileHandle, signal); },
      onReaderVersion(token, version) {
        const tab = current(token);
        if (!tab || tab.dirty || diskStateRef.current.has(tab.id) || getView(tab.file.path)?.hasPendingEdits?.()) return;
        const entry = pdfRebuildRef.current.get(tab.id);
        if (entry && entry.baseline.hash !== version.hash) { setDiskState(tab.id, 'conflict'); return; }
        const late = !getBaseline(tab.id);
        setBaseline(tab.id, version);
        if (late) void readerDeps.current.checkOpenDocs(new Set([tab.file.path]));
      },
      onReaderSourceLost(token, stat) {
        const tab = current(token);
        if (!tab) return;
        if (!getBaseline(tab.id)) setBaseline(tab.id, { ...stat, hash: '' });
        void readerDeps.current.checkOpenDocs(new Set([tab.file.path]));
      },
      onReaderStatus(token, status) { if(!current(token))return; setTabs(prev=>{
        if(!current(token))return prev;
        const tab=prev.find(t=>t.id===token.documentId&&t.representation.generation===token.byteGeneration);
        return !tab||JSON.stringify(tab.readerStatus)===JSON.stringify(status)?prev:prev.map(t=>t===tab?{...t,readerStatus:status}:t);
      }); },
      onReaderCapabilities(token, caps) { if(!current(token))return; setTabs(prev=>{
        if(!current(token))return prev;
        const tab=prev.find(t=>t.id===token.documentId&&t.representation.generation===token.byteGeneration);
        return !tab||JSON.stringify(tab.readerCapabilities)===JSON.stringify(caps)?prev:prev.map(t=>t===tab?{...t,readerCapabilities:caps}:t);
      }); },
      onReaderLocation(token, location) { const tab = current(token); if (!tab) return; const identity = identityForTab(tab); if (location.kind === 'epub') writeReaderViewState(identity, location.value); else writePdfTextViewState(identity, location.value); },
      onReaderCommand(token, command) { const tab = current(token); if (!tab || tab.file.path !== activeTabPathRef.current) return;
        if (['close-document','reopen-document','next-document','previous-document'].includes(command) && runReaderHostCommand(command)) return;
        if (command === 'close-document') readerDeps.current.closeTab(tab.file.path);
        else if (command === 'read-only-mode') readerDeps.current.announce('EPUB books are read-only. Reading appearance changes only this browser.');
        else if (command === 'find') getReadingSurface(token)?.findReading?.();
        else if (command === 'dismiss') closeContextMenu();
        else if (command === 'reopen-document') void readerDeps.current.reopenClosedTab();
        else if (command === 'next-document' || command === 'previous-document') { const paths=layoutRef.current.panes.flatMap(p=>p.paths);if(!paths.length)return;const index=paths.indexOf(tab.file.path);setLayout(l=>focusTab(l,paths[(index+(command==='next-document'?1:paths.length-1))%paths.length])); }
      },
      onNotify(message) { readerDeps.current.notify(message); },
    };
  }, [setDiskState, activeTabPathRef, currentVaultIdRef, diskStateRef, invalidReaderTokens, layoutRef, pdfRebuildRef, readerEpochRef, readerIdentityCache, setLayout, setTabs, tabsRef]);

  return { readerIntegration };
}
