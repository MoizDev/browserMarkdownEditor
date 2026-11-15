import type React from 'react';
import { useCallback, useEffect } from 'react';
import type { FileSystemContextValue, FileTreeNode, OpenTab, TrashItem } from '../types';
import type { DocumentSessionStore } from '../utils/documentSessions';
import type { NativePolicy } from './types';
import type { Notify } from './useAppDialogs';
import { conversionDigestFromText, registerConversionRestore } from '../utils/conversionRestore';
import { fingerprintSnapshot } from '../utils/snapshotFingerprint';
import { isNativeDrawingFile, isPdfFile } from '../utils/fileTypes';
import { hasHostedNativeOwner } from './nativeOwners';

/**
 * Restoring a file's pre-conversion copy from Trash, found by its recorded
 * digest. Registers the handler the file tree's context menu calls; it gives
 * nothing back to App.
 */
export interface UseConversionRestoreDeps {
  announce: (message: string) => void;
  notify: Notify;
  documentSessions: DocumentSessionStore;
  getVaultActivation: FileSystemContextValue['getVaultActivation'];
  handleIO: FileSystemContextValue['handleIO'];
  listTrash: FileSystemContextValue['listTrash'];
  readFileVersioned: FileSystemContextValue['readFileVersioned'];
  restoreConversionCopy: FileSystemContextValue['restoreConversionCopy'];
  rootHandle: FileSystemContextValue['rootHandle'];
  tabsRef: React.RefObject<OpenTab[]>;
  nativePoliciesRef: React.RefObject<Map<string, NativePolicy>>;
  trashInFlightRef: React.RefObject<boolean>;
  reconcileQueueRef: React.RefObject<Promise<void>>;
}

export function useConversionRestore(deps: UseConversionRestoreDeps): void {
  const {
    announce, notify, documentSessions, getVaultActivation, handleIO, listTrash, readFileVersioned,
    restoreConversionCopy, rootHandle, tabsRef, nativePoliciesRef, trashInFlightRef, reconcileQueueRef,
  } = deps;

  const restoreBeforeConversion = useCallback(async (node: FileTreeNode) => {
    if (trashInFlightRef.current || node.kind !== 'file' || !node.parentHandle || !rootHandle) return;
    trashInFlightRef.current = true;
    const activation = getVaultActivation();
    const controller = new AbortController();
    const nativeKind = isPdfFile(node.name) ? 'pdfInk' : isNativeDrawingFile(node.name) ? 'drawing' : undefined;
    const nativeTab = nativeKind ? tabsRef.current.find(t => t.file.path === node.path) : undefined;
    const current = () => {
      if (getVaultActivation() !== activation) return false;
      if (!nativeKind) return true;
      if (!nativeTab) return false;
      const policy = nativePoliciesRef.current.get(nativeTab.id), session = documentSessions.get(nativeTab.id);
      return nativeTab.representation.nativeCanvasKind === nativeKind && nativeTab.representation.nativeCanvasSession !== undefined
        && policy?.kind === nativeKind && policy.activation === activation && policy.session === nativeTab.representation.nativeCanvasSession
        && session?.serial === policy.session && session.bytesGeneration === policy.retainedThroughGeneration
        && hasHostedNativeOwner(session, nativeTab.id)
        && tabsRef.current.some(t => t.id === nativeTab.id && t.file.path === node.path && t.file.handle === nativeTab.file.handle
          && t.representation.generation === nativeTab.representation.generation && t.representation.legacyOriginalSha256 === nativeTab.representation.legacyOriginalSha256);
    };
    try {
      await reconcileQueueRef.current;
      if (nativeKind && (!nativeTab || !current())) { notify('Open the converted document in its native view first to locate its pre-conversion copy.'); return; }
      const source = nativeKind ? null : await readFileVersioned(node.handle);
      const digest = nativeKind ? nativeTab?.representation.legacyOriginalSha256 : source ? conversionDigestFromText(source.text, node.name) : null;
      if (!digest || !/^[a-f0-9]{64}$/.test(digest)) {
        notify('No pre-conversion copy is recorded for this file.');
        return;
      }
      const items = await listTrash();
      const queue = [...items];
      let match: TrashItem | undefined;
      let unreadable = false;
      for (let i = 0; i < queue.length && current(); i++) {
        const item = queue[i];
        if (item.kind === 'directory') { if (item.children) queue.push(...item.children); continue; }
        if (item.origin !== 'trashed') continue;
        try {
          const file = await handleIO.file(item.handle as FileSystemFileHandle);
          if (await fingerprintSnapshot(file, controller.signal) === digest) { match = item; break; }
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') throw error;
          unreadable = true;
        }
      }
      if (!current()) return;
      if (!match) { notify(unreadable ? 'Some Trash files could not be read; the pre-conversion copy could not be located.' : 'The pre-conversion copy is no longer available in Trash.'); return; }
      if (source && (await readFileVersioned(node.handle)).version.hash !== source.version.hash) {
        notify('The converted file changed; try restoring again.'); return;
      }
      const name = await restoreConversionCopy({ root: rootHandle, parent: node.parentHandle, owner: node.handle,
        hash: digest, signal: controller.signal, isCurrent: current }, match);
      if (current()) announce(`Restored a copy as "${name}". The converted file and Trash backup are unchanged.`);
    } catch (error) {
      console.error('Could not restore pre-conversion copy:', error);
      if (current()) notify('Could not restore the pre-conversion copy. Nothing was replaced.');
    } finally {
      controller.abort();
      trashInFlightRef.current = false;
    }
  }, [announce, documentSessions, getVaultActivation, handleIO, listTrash, notify, readFileVersioned, restoreConversionCopy, rootHandle, nativePoliciesRef, reconcileQueueRef, tabsRef, trashInFlightRef]);
  useEffect(() => registerConversionRestore(node => { void restoreBeforeConversion(node); }), [restoreBeforeConversion]);
}
