import type React from 'react';
import type { FileSystemContextValue, OpenTab } from '../types';
import type { MarkdownSessionHost } from '../editor/markdownSession.types';
import type { DocumentBufferStore } from '../utils/documentBuffers';
import type { RecoveryEntry } from '../utils/recoveryJournal';
import type { RecoveryInspection } from '../components/RecoverySurface';
import { canReadTabText } from '../utils/documentReading';
import { hashBytes } from '../utils/diskVersion';
import { materializeRecoveryCopy, recoveryCopyMedia } from '../utils/recoveryCopy';
import { recoveryAdapter } from '../utils/recoveryAdapters';
import { fingerprintSnapshot } from '../utils/snapshotFingerprint';
import { hasOldBoardName, startsAsOldBoard } from '../utils/oldBoards';
import type { UseRecoveryActionsDeps } from './useRecoveryActions';
import { loadChunk } from '../platform/chunkLoad';

/**
 * The recovery surface's three actions: compare a journal entry with the file,
 * apply it, or save it as a copy. Only an unrecovered entry reaches them, so they
 * load with the first one (useRecoveryActions), never at startup.
 */
export interface RecoveryActionsDeps extends UseRecoveryActionsDeps {
  /** The hook's own wrapper, so a recover re-inspects exactly as before. */
  inspectRecovery: (entry: RecoveryEntry) => Promise<RecoveryInspection>;
}

export async function inspectRecovery(deps: Pick<RecoveryActionsDeps,
  'getVaultActivation' | 'rootHandle' | 'currentVaultId' | 'recentVaults' | 'handleIO' |
  'resolveFileHandle' | 'resolveVaultFile' | 'readFileSnapshot' | 'readBoardAsset' | 'rootHandleRef' |
  'currentVaultIdRef'
>, entry: RecoveryEntry): Promise<RecoveryInspection> {
  const {
    getVaultActivation, rootHandle, currentVaultId, recentVaults, handleIO, resolveFileHandle,
    resolveVaultFile, readFileSnapshot, readBoardAsset, rootHandleRef, currentVaultIdRef,
  } = deps;
  const activation = getVaultActivation();
  const current = () => getVaultActivation() === activation && rootHandleRef.current === rootHandle && currentVaultIdRef.current === entry.vaultId;
  if (!rootHandle || currentVaultId !== entry.vaultId || !current()) return 'unavailable';
  try {
    const vault = recentVaults.find(item => item.id === entry.vaultId);
    if (!vault) return 'unavailable';
    const relative = await handleIO.relativeTo(rootHandle, vault.handle);
    if (!relative || relative.length !== 0 || !current()) return 'unavailable';
    const handle = await resolveFileHandle(entry.path);
    if (!current()) return 'unavailable';
    if (!handle) return 'copy';
    const snapshot = await readFileSnapshot(handle);
    try {
      const version = await snapshot.fingerprint();
      if (!current()) return 'unavailable';
      // A drawing or notebook that is still in the old app's format (the edits were made by an earlier build that would
      // have converted it on save) is never written: its recovered changes can only be kept as a copy (utils/oldBoards.ts).
      if (startsAsOldBoard(await snapshot.blob.slice(0, 512).text(), entry.path)) return 'copy';
      if (!current()) return 'unavailable';
      const copy = await materializeRecoveryCopy(entry, new AbortController().signal);
      const copyHash = copy instanceof Blob ? await fingerprintSnapshot(copy)
        : await hashBytes(typeof copy === 'string' ? new TextEncoder().encode(copy) : copy);
      if (!current()) return 'unavailable';
      if (copyHash === version.hash) {
        const assets = recoveryCopyMedia(entry);
        if (assets.length) {
          const { parentHandle } = await resolveVaultFile(rootHandle, entry.path);
          if (!current()) return 'unavailable';
          for (const asset of assets) {
            const found = await readBoardAsset({ root: rootHandle, parent: parentHandle, owner: handle,
              hash: asset.hash, preferredName: asset.file, signal: new AbortController().signal, isCurrent: current });
            if (!current()) return 'unavailable';
            // Equal document bytes do not make the only durable image backup
            // redundant when its .Assets file disappeared after the save.
            if (!found) return 'copy';
          }
        }
        return 'equal';
      }
      return version.hash === entry.fingerprint ? 'match' : 'copy';
    } finally { snapshot.dispose(); }
  } catch (error) { console.warn('Could not inspect recovery entry:', error); return 'unavailable'; }
}

export async function recoverEntry(deps: Pick<RecoveryActionsDeps,
  'inspectRecovery' | 'getVaultActivation' | 'rootHandleRef' | 'currentVaultIdRef' | 'tabsRef' |
  'documentBuffers' | 'markdownSessions' | 'contentOf' | 'hasUnsaved'
>, entry: RecoveryEntry) {
  const {
    inspectRecovery,
    getVaultActivation, rootHandleRef, currentVaultIdRef, tabsRef, documentBuffers, markdownSessions,
    contentOf, hasUnsaved,
  } = deps;
  const activation = getVaultActivation();
  const root = rootHandleRef.current;
  const tab = tabsRef.current.find(t => t.file.path === entry.path);
  if (!root || currentVaultIdRef.current !== entry.vaultId || !tab || hasUnsaved(tab)) throw new Error('Open the unchanged document and save its current edits first.');
  const current = () => getVaultActivation() === activation && rootHandleRef.current === root && currentVaultIdRef.current === entry.vaultId
    ? tabsRef.current.find(t => t.id === tab.id && t.file.path === entry.path) : undefined;
  if (entry.copyOnly || await inspectRecovery(entry) !== 'match') throw new Error('The file changed; save these changes as a copy instead.');
  const live = current();
  if (!live || hasUnsaved(live)) throw new Error('The document changed while recovery was being prepared.');
  const adapter = recoveryAdapter(tab.id);
  if (adapter?.recover) {
    await adapter.recover(typeof entry.payload === 'string' ? { kind: 'markdown', text: entry.payload } : entry.payload);
    return;
  }
  const payload = entry.payload;
  const recoveredText = typeof payload === 'string' ? payload : payload && typeof payload === 'object' && 'kind' in payload && payload.kind === 'markdown' && 'text' in payload && typeof payload.text === 'string' ? payload.text : undefined;
  if (recoveredText === undefined || !canReadTabText(tab)) throw new Error('This document cannot yet apply its recovered changes; save a copy instead.');
  const expected = contentOf(entry.path), revision = documentBuffers.revisionForDocument(tab.id)?.revision;
  const { isolateHistory } = await loadChunk(() => import('@codemirror/commands'));
  const latest = current();
  if (expected === undefined || !latest || documentBuffers.revisionForDocument(tab.id)?.revision !== revision || hasUnsaved(latest)) throw new Error('The document changed while recovery was being prepared.');
  if (!await markdownSessions.dispatch(tab.id, { changes: { from: 0, to: expected.length, insert: recoveredText }, userEvent: 'input.recover', annotations: isolateHistory.of('full') })) throw new Error('The document changed while recovery was being prepared.');
}

export async function saveRecoveryCopy(deps: Pick<RecoveryActionsDeps,
  'getVaultActivation' | 'recentVaults' | 'handleIO' | 'resolveVaultFile' | 'readFileSnapshot' |
  'putBoardAsset' | 'writeConflictCopy' | 'writeFileVersioned' | 'rootHandleRef' | 'currentVaultIdRef' |
  'announce' | 'tabsRef' | 'hasUnsaved'
>, entry: RecoveryEntry) {
  const {
    getVaultActivation, recentVaults, handleIO, resolveVaultFile, readFileSnapshot, putBoardAsset,
    writeConflictCopy, writeFileVersioned, rootHandleRef, currentVaultIdRef, announce, tabsRef, hasUnsaved,
  } = deps;
  const activation = getVaultActivation();
  const root = rootHandleRef.current;
  if (!root || currentVaultIdRef.current !== entry.vaultId) throw new Error('Return to the original vault first.');
  const vault = recentVaults.find(item => item.id === entry.vaultId);
  const relative = vault && await handleIO.relativeTo(root, vault.handle);
  if (!relative || relative.length !== 0 || getVaultActivation() !== activation || rootHandleRef.current !== root || currentVaultIdRef.current !== entry.vaultId) throw new Error('Return to the original vault first.');
  const current = () => getVaultActivation() === activation && rootHandleRef.current === root && currentVaultIdRef.current === entry.vaultId;
  const check = () => { if (!current()) throw new Error('The vault changed.'); };
  const signal = new AbortController().signal;
  const copyData = await materializeRecoveryCopy(entry, signal);
  check();
  const assets = recoveryCopyMedia(entry);
  const ids = new Set<string>();
  for (const asset of assets) {
    if (!asset.id || ids.has(asset.id)) throw new Error('Invalid or duplicate recovery media.');
    ids.add(asset.id);
  }
  // A board's recovered changes are this app's format: beside an old drawing they are a `.drawing`, never a second
  // `.tldraw` that the old app would try to read (utils/oldBoards.ts).
  const copyPath = entry.kind === 'drawing' && hasOldBoardName(entry.path) ? entry.path.replace(/\.(tldraw|tldr)$/i, '.drawing') : entry.path;
  let copy = await writeConflictCopy(copyPath, copyData, root);
  check();
  if (assets.length) {
    // The generated file is the asset-write owner, never the missing original.
    // A crash mid-restore leaves both a readable capsule and a preserved copy.
    const { handle, parentHandle } = await resolveVaultFile(root, copy);
    check();
    const files = new Map<string, string>();
    for (const asset of assets) {
      const file = await putBoardAsset({ root, parent: parentHandle, owner: handle, hash: asset.hash,
        preferredName: asset.file, extension: asset.extension, blob: asset.blob, signal, isCurrent: current });
      check();
      files.set(asset.id, file);
    }
    if (assets.some(asset => files.get(asset.id) !== asset.file)) {
      const data = await materializeRecoveryCopy(entry, signal, files);
      check();
      const hash = copyData instanceof Blob ? await fingerprintSnapshot(copyData, signal)
        : await hashBytes(typeof copyData === 'string' ? new TextEncoder().encode(copyData) : copyData);
      check();
      let written = false;
      const opened = tabsRef.current.find(tab => tab.file.path === copy);
      if (!opened || !hasUnsaved(opened)) {
        const snapshot = await readFileSnapshot(handle, signal);
        try {
          const expected = await snapshot.fingerprint();
          check();
          // Someone may have opened/edited the copy during media IO. Only
          // our original bytes authorize the filename-remapping write.
          const latest = tabsRef.current.find(tab => tab.file.path === copy);
          if (expected.hash === hash && (!latest || !hasUnsaved(latest))) {
            written = (await writeFileVersioned(handle, data, expected)).status === 'written';
          }
        } finally { snapshot.dispose(); }
      }
      check();
      if (!written) copy = await writeConflictCopy(copyPath, data, root);
    }
  }
  check();
  announce(`Recovered changes were saved as “${copy}”.`);
}
