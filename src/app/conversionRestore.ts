import type React from 'react';
import type { FileSystemContextValue, FileTreeNode, OpenTab, TrashItem } from '../types';
import type { DocumentSessionStore } from '../utils/documentSessions';
import type { NativePolicy } from './types';
import type { Notify } from './useAppDialogs';
import { conversionDigestFromText, conversionEvidenceFromText, matchesConversionEvidence } from '../utils/conversionRestore';
import { startsAsOldBoard } from '../utils/oldBoards';
import { fingerprintSnapshot } from '../utils/snapshotFingerprint';
import { isCanvasFile, isNativeDrawingFile, isNotebookFile, isPdfFile } from '../utils/fileTypes';
import { joinVaultPath, parentVaultPath } from '../utils/paths';
import { TRASH_DIR } from '../utils/assets';
import { hasHostedNativeOwner } from './nativeOwners';
import type { UseConversionRestoreDeps } from './useConversionRestore';

/**
 * Putting a converted file's pre-conversion copy back, found in the Trash by
 * its recorded digest. Reached only from the tree row of a converted document,
 * so it loads on that gesture (useConversionRestore), never at startup.
 */
export type ConversionRestoreDeps = UseConversionRestoreDeps;

export async function restoreBeforeConversion(deps: Pick<ConversionRestoreDeps,
  'announce' | 'notify' | 'documentSessions' | 'getVaultActivation' | 'handleIO' | 'listTrash' |
  'readFileVersioned' | 'restoreConversionCopy' | 'rootHandle' | 'tabsRef' | 'nativePoliciesRef' |
  'trashInFlightRef' | 'reconcileQueueRef'
>, node: FileTreeNode) {
  const {
    announce, notify, documentSessions, getVaultActivation, handleIO, listTrash, readFileVersioned,
    restoreConversionCopy, rootHandle, tabsRef, nativePoliciesRef, trashInFlightRef, reconcileQueueRef,
  } = deps;
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
    const recorded = nativeKind ? nativeTab?.representation.legacyOriginalSha256 : source ? conversionDigestFromText(source.text, node.name) : null;
    // A board an earlier version converted in place records no digest: it is found by what it kept of its old file.
    const evidence = !recorded && source ? conversionEvidenceFromText(source.text, node.name) : null;
    if ((!recorded || !/^[a-f0-9]{64}$/.test(recorded)) && !evidence) {
      notify('No pre-conversion copy is recorded for this file.');
      return;
    }
    const items = await listTrash();
    const queue = [...items];
    let match: TrashItem | undefined, digest = recorded ?? '';
    // Where the earlier version put the backup: this folder's Trash, under the board's name or that name numbered
    // (freeEntryName). A file that fits AND is there is preferred to one elsewhere; the board may have moved since, so
    // a fit elsewhere still counts when it is the only one.
    const boardTrash = joinVaultPath(parentVaultPath(node.path), TRASH_DIR);
    const dot = node.name.lastIndexOf('.'), stem = dot > 0 ? node.name.slice(0, dot) : node.name, extension = dot > 0 ? node.name.slice(dot) : '';
    const keptHere = (item: TrashItem) => parentVaultPath(item.sourcePath) === boardTrash && (item.name === node.name
      || item.name.startsWith(stem) && item.name.endsWith(extension) && /^ \(\d+\)$/.test(item.name.slice(stem.length, item.name.length - extension.length)));
    const found = new Map<string, TrashItem>(), foundHere = new Map<string, TrashItem>();
    let unreadable = false;
    for (let i = 0; i < queue.length && current(); i++) {
      const item = queue[i];
      if (item.kind === 'directory') { if (item.children) queue.push(...item.children); continue; }
      if (item.origin !== 'trashed') continue;
      // The earlier version kept the old file under its own name, so only a drawing or notebook name can be it.
      if (evidence && (!isCanvasFile(item.name) || isNativeDrawingFile(item.name))) continue;
      try {
        const file = await handleIO.file(item.handle as FileSystemFileHandle);
        if (evidence) {
          const text = await file.text();
          if (!startsAsOldBoard(text.slice(0, 512), item.name) || !matchesConversionEvidence(evidence, text)) continue;
          const hash = await fingerprintSnapshot(file, controller.signal);
          if (!found.has(hash)) found.set(hash, item);
          if (keptHere(item) && !foundHere.has(hash)) foundHere.set(hash, item);
        } else if (await fingerprintSnapshot(file, controller.signal) === digest) { match = item; break; }
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        unreadable = true;
      }
    }
    if (!current()) return;
    if (evidence) {
      // Two different files that both fit, in the same standing, are two versions of the board (one trashed by hand):
      // which one was converted is not known, so none is chosen for the person.
      const candidates = foundHere.size ? foundHere : found;
      if (candidates.size > 1) {
        notify(`${candidates.size} files in Trash could each be this ${isNotebookFile(node.name) ? 'notebook' : 'drawing'}'s copy from before conversion, so none was restored. Open Trash to restore the one you want.`);
        return;
      }
      const only = [...candidates][0];
      if (only) [digest, match] = only;
    }
    if (!match) {
      notify(unreadable ? 'Some Trash files could not be read; the pre-conversion copy could not be located.'
        : evidence ? 'The pre-conversion copy is no longer in Trash. It was kept in the Trash of the folder this file was in when it was converted.'
          : 'The pre-conversion copy is no longer available in Trash.');
      return;
    }
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
}
