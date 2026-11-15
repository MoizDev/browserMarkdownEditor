import type React from 'react';
import { useCallback, useRef } from 'react';
import type { FileSystemContextValue, FileTreeFileNode, FileTreeNode, OpenTab } from '../types';
import { placeholderFor } from '../utils/createRequest';
import { isDrawingFile, isEpubFile, isNativeDrawingFile, isNotebookFile, isPdfFile } from '../utils/fileTypes';
import { joinVaultPath } from '../utils/paths';
import { reportVault } from '../utils/perfHooks';
import type { AppDialogs, Tell } from './useAppDialogs';
import type { SetTabs } from './types';

/** The App-scope values `useCreateEntries` reads, named as App names them. */
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
      // Explicit names refuse collisions; native drawing imports keep their existing
      // unique-name behavior and carry the actual freeEntryName result forward.
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
        const { createEmptyNativeBytes } = await import('../whiteboard/host/emptyNative');
        nativeBytes = createEmptyNativeBytes(nativeKind);
      }
      // Encode before fresh-file creation. A failed native encoder never creates
      // a blank artifact or authorizes a Classic writer; once IO starts, finish
      // this immutable payload even if its vault goes out of view.
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
        setTabs(prev => prev.map(t => t.file.path === newPath ? { ...t, mode: 'edit' } : t));
      }
    } catch (err) {
      // Said out loud, not only logged: from the sidebar a create that failed
      // is indistinguishable from one that worked and left the tree alone.
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

  /**
   * New note in the vault's top folder — ⌘N, and the `+` on every pane's tab
   * strip. ONE function for both: two entry points to the same action that
   * behaved differently is exactly what the `+` would have reintroduced.
   *
   * ⌘N used to raise a `window.prompt`, the last native dialog in the app.
   * It is gone: AGENTS.md's rule is that the app draws its own `confirm()` and
   * prefers it to a native one, and `prompt()` could not say where the note
   * would land, could not refuse an empty name while it was being typed, and
   * sat outside the theme.
   *
   * THE NAME-TAKEN CASE IS DELIBERATELY NOT CHECKED HERE. `input.validate` runs
   * on every keystroke and must be synchronous; `nameTaken` is a directory walk.
   * `handleCreateFile` already refuses a taken name with a dialog of its own —
   * the one guard standing in front of `createFile`, which opens-or-TRUNCATES —
   * so asking here would only add a second half to keep in step with it.
   *
   * Opens wherever `openTab` opens: the focused pane, as a new tab. A `+` in an
   * unfocused strip focuses its pane first (TabBar), so the note lands in the
   * column whose `+` was pressed.
   */
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
        // `placeholderFor(null)` — the same hint the file tree's own create row
        // shows, from the module that owns "what extension does this kind get".
        // The name is taken AS TYPED here, exactly as a tree-row `file` is, so a
        // reader who wants a note has to write the `.md` themselves; the
        // `prompt()` this replaced said so in its own message ('e.g. "note.md"')
        // and losing that hint would be the one thing the new dialog did worse.
        placeholder: placeholderFor(null),
        validate: v => (v.trim() ? null : 'Give the note a name'),
      },
    });
    if (!name) return;
    // The dialog is an await, and the reader can switch vaults behind it (the
    // vault menu is not covered by it). Re-checked rather than trusted: writing
    // through the captured handle would drop the note into a vault that is no
    // longer on screen, and `parentPath: ''` would then name it in the tree the
    // new vault built. Same re-validation the restore pass does after its reads.
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
