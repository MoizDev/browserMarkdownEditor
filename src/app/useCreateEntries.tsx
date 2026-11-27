import type React from 'react';
import { useCallback, useRef } from 'react';
import type { FileSystemContextValue, FileTreeFileNode, FileTreeNode, OpenTab } from '../types';
import { placeholderFor } from '../utils/createRequest';
import { isDrawingFile, isEpubFile, isNativeDrawingFile, isNotebookFile, isPdfFile } from '../utils/fileTypes';
import { joinVaultPath } from '../utils/paths';
import { requestDocumentKeyboard } from '../utils/documentKeyboard';
import { reportVault } from '../utils/perfHooks';
import type { AppDialogs, Tell } from './useAppDialogs';
import type { SetTabs } from './types';
import { loadChunk } from '../platform/chunkLoad';

export interface UseCreateEntriesDeps {
  rootHandleRef: React.RefObject<FileSystemDirectoryHandle | null>;
  setTabs: SetTabs;
  tell: Tell;
  askForName: AppDialogs['askForName'];
  getVaultActivation: FileSystemContextValue['getVaultActivation'];
  createFile: FileSystemContextValue['createFile'];
  createFolder: FileSystemContextValue['createFolder'];
  importFiles: FileSystemContextValue['importFiles'];
  resolveVaultFile: FileSystemContextValue['resolveVaultFile'];
  nameTaken: FileSystemContextValue['nameTaken'];
  handleFileClick: (node: FileTreeNode) => Promise<boolean>;
}

export function useCreateEntries(deps: UseCreateEntriesDeps) {
  const {
    rootHandleRef, setTabs, tell, askForName, getVaultActivation, createFile, createFolder, importFiles,
    resolveVaultFile, nameTaken, handleFileClick,
  } = deps;

  const createInFlightRef = useRef(false);
  const handleCreateFile = useCallback(async (parentHandle: FileSystemDirectoryHandle | null, name: string, parentPath = '') => {
    if (isEpubFile(name) || isPdfFile(name)) { void tell({title:'Import an existing document',body:'EPUB and PDF documents must be imported as original binary files.',confirmLabel:'OK'}); return; }
    if (!parentHandle || !rootHandleRef.current || createInFlightRef.current) return;
    createInFlightRef.current = true;
    const where = parentPath || parentHandle.name || 'this folder';
    const root = rootHandleRef.current, activation = getVaultActivation();
    const current = () => root === rootHandleRef.current && activation === getVaultActivation();
    const nativeKind = isNativeDrawingFile(name) || isDrawingFile(name) ? 'whiteboard'
      : isNotebookFile(name) ? 'notebook' : null;
    try {
      if (!isNativeDrawingFile(name) && await nameTaken(parentHandle, name)) {
        if (!current()) return;
        await tell({
          title: 'That name is taken',
          confirmLabel: 'OK',
          body: <><strong>{name}</strong> already exists in <code>{where}</code>. Nothing was created — pick another name, or open the one that is there.</>,
        });
        return;
      }
      let nativeBytes: Blob | undefined;
      if (nativeKind) {
        const { createEmptyNativeBytes } = await loadChunk(() => import('../whiteboard/host/emptyNative'));
        nativeBytes = createEmptyNativeBytes(nativeKind);
      }
      if (!current()) return;
      if (__BME_BENCH__) {
        try { reportVault({ op: 'write', path: joinVaultPath(parentPath, name), caller: 'create' }); } catch { /* Measurement must not interrupt a write. */ }
      }
      let createdName = name;
      let newFileHandle: FileSystemFileHandle | null;
      if (nativeBytes) {
        const created = await importFiles([new File([nativeBytes], name)], parentHandle);
        if (!created.length) throw new Error('Could not create the native canvas.');
        createdName = created[0];
        if (!current()) return;
        ({ handle: newFileHandle } = await resolveVaultFile(root, joinVaultPath(parentPath, createdName)));
      } else {
        newFileHandle = await createFile(parentHandle, name);
      }
      if (!current()) return;
      if (newFileHandle) {
        const newPath = joinVaultPath(parentPath, createdName);
        const newNode: FileTreeFileNode = {
          name: createdName,
          handle: newFileHandle,
          parentHandle,
          kind: 'file',
          path: newPath,
        };
        await handleFileClick(newNode);
        if (!current()) return;
        if (isNativeDrawingFile(createdName) || isNotebookFile(createdName)) requestDocumentKeyboard(newPath);
        setTabs(prev => prev.map(t => t.file.path === newPath ? { ...t, mode: 'edit' } : t));
      }
    } catch (err) {
      console.error('Failed to create file:', err);
      await tell({
        title: 'Could not create the file',
        confirmLabel: 'OK',
        body: <><strong>{name}</strong> could not be created in <code>{where}</code>.</>,
      });
    } finally {
      createInFlightRef.current = false;
    }
  }, [createFile, getVaultActivation, handleFileClick, importFiles, resolveVaultFile, tell, nameTaken, rootHandleRef, setTabs]);

  const handleNewNote = useCallback(async () => {
    const root = rootHandleRef.current;
    if (!root) return;
    const name = await askForName({
      title: 'New note',
      body: <>It will be created in the vault’s top folder.</>,
      confirmLabel: 'Create',
      input: {
        label: 'Name',
        initialValue: '',
        placeholder: placeholderFor(null),
        validate: v => (v.trim() ? null : 'Give the note a name'),
      },
    });
    if (!name) return;
    if (rootHandleRef.current !== root) return;
    await handleCreateFile(root, name, '');
  }, [askForName, handleCreateFile, rootHandleRef]);

  const handleCreateFolder = useCallback(async (parentHandle: FileSystemDirectoryHandle | null, name: string) => {
    const where = parentHandle?.name || 'this folder';
    try {
      // createFolder is create-or-open like createFile, so an existing folder
      // would silently be "created" and the reader would be looking at
      // somebody else's notes inside it.
      if (parentHandle && await nameTaken(parentHandle, name)) {
        await tell({
          title: 'That name is taken',
          confirmLabel: 'OK',
          body: <><strong>{name}</strong> already exists in <code>{where}</code>. Nothing was created.</>,
        });
        return;
      }
      await createFolder(parentHandle!, name);
    } catch (err) {
      console.error('Failed to create folder:', err);
      await tell({
        title: 'Could not create the folder',
        confirmLabel: 'OK',
        body: <><strong>{name}</strong> could not be created in <code>{where}</code>.</>,
      });
    }
  }, [createFolder, tell, nameTaken]);

  return { handleCreateFile, handleNewNote, handleCreateFolder };
}
