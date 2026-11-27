import type React from 'react';
import { useCallback, useEffect } from 'react';
import type { FileSystemContextValue, FileTreeNode, OpenTab, TabLayout } from '../types';
import type { NativeCanvasHost } from '../types/nativeCanvas';
import type { NativePolicy, SetLayout, SetTabs } from './types';
import type { Ask, Tell } from './useAppDialogs';
import type { OpenOptions } from './useDocumentOpener';
import { copyCanvasViewPos } from '../utils/canvasViewState';
import { requestDocumentKeyboard } from '../utils/documentKeyboard';
import { focusedPath, focusTab, openTab, renamePath } from '../utils/tabPanes';
import { representationFor } from '../utils/documentReading';
import { setBaseline } from '../utils/docBaselines';
import {
  editableCopyNames, handOffCopyNotice, registerBoardRowPeek, registerEditableCopyOpener, requestEditableCopy, settleEditableCopy,
  startsAsOldBoard,
} from '../utils/oldBoards';
import { isCanvasFile, isNativeDrawingFile } from '../utils/fileTypes';
import { startsAsConvertedBoard } from '../utils/conversionRestore';
import { newTabId } from './documentIds';
import { describeReadError } from './readErrors';

export interface UseEditableCopyDeps {
  ask: Ask;
  tell: Tell;
  announce: (message: string) => void;
  getVaultActivation: FileSystemContextValue['getVaultActivation'];
  writeBoardCopy: FileSystemContextValue['writeBoardCopy'];
  handleIO: FileSystemContextValue['handleIO'];
  rootHandleRef: React.RefObject<FileSystemDirectoryHandle | null>;
  tabsRef: React.RefObject<OpenTab[]>;
  layoutRef: React.RefObject<TabLayout>;
  nativePoliciesRef: React.RefObject<Map<string, NativePolicy>>;
  setTabs: SetTabs;
  setLayout: SetLayout;
  handleFileClick: (node: FileTreeNode, options?: OpenOptions) => Promise<boolean>;
  releaseTab: (path: string) => void;
  seedDocumentBuffer: (id: string, path: string, content: string, readable: boolean) => void;
  editableCopyRef: React.RefObject<NativeCanvasHost['makeEditableCopy'] | null>;
  oldBoardOpenedRef: React.RefObject<((id: string, name: string) => void) | null>;
}

export function useEditableCopy(deps: UseEditableCopyDeps) {
  const {
    ask, tell, announce, getVaultActivation, writeBoardCopy, handleIO, rootHandleRef, tabsRef, layoutRef, nativePoliciesRef,
    setTabs, setLayout, handleFileClick, releaseTab, seedDocumentBuffer, editableCopyRef, oldBoardOpenedRef,
  } = deps;

  const offer = useCallback(async (id: string, name: string) => {
    const noun = /\.notebook$/i.test(name) ? 'notebook' : 'drawing';
    const confirmed = await ask({
      title: `Make an editable copy of this ${noun}?`,
      confirmLabel: 'Make a copy and open it',
      cancelLabel: 'View the original',
      body: <>
        <strong>{name}</strong> was made with an older version of this app. It opens here exactly as it was, but it
        cannot be changed.<br /><br />
        To work on it, make a copy in this app’s format, beside it in the same folder. The copy opens in this tab, and
        the original stays in the folder exactly as it is.
      </>,
    });
    if (!confirmed) return;
    if (!tabsRef.current.some(tab => tab.id === id)) return;
    requestEditableCopy(id);
  }, [ask, tabsRef]);
  useEffect(() => {
    oldBoardOpenedRef.current = (id, name) => { void offer(id, name); };
    return () => { oldBoardOpenedRef.current = null; };
  }, [offer, oldBoardOpenedRef]);

  useEffect(() => registerEditableCopyOpener(node => void (async () => {
    const tab = tabsRef.current.find(item => item.file.path === node.path);
    if (!tab) {
      const id = newTabId();
      if (!await handleFileClick(node, { offerCopy: false, id })) return;
      requestEditableCopy(id);
      return;
    }
    setLayout(layout => focusTab(layout, node.path));
    requestEditableCopy(tab.id);
  })()), [handleFileClick, setLayout, tabsRef]);

  useEffect(() => registerBoardRowPeek(async node => {
    if (node.kind !== 'file' || !isCanvasFile(node.name) || isNativeDrawingFile(node.name)) return 'other';
    const open = tabsRef.current.find(tab => tab.file.path === node.path);
    if (open && (open.representation.oldBoard || nativePoliciesRef.current.get(open.id)?.oldBoard)) return 'old';
    const start = await (await handleIO.file(node.handle)).slice(0, 1024).text();
    return !open && startsAsOldBoard(start, node.name) ? 'old' : startsAsConvertedBoard(start, node.name) ? 'converted' : 'other';
  }), [handleIO, nativePoliciesRef, tabsRef]);

  const make = useCallback<NativeCanvasHost['makeEditableCopy']>(async (identity, copy, signal) => {
    const root = rootHandleRef.current, activation = getVaultActivation();
    const original = tabsRef.current.find(tab => tab.id === identity.documentId && tab.file.path === identity.path);
    const oldBoard = !!original && (original.representation.oldBoard || !!nativePoliciesRef.current.get(original.id)?.oldBoard);
    if (!root || !original || !oldBoard || identity.kind === 'pdfInk' || original.file.kind !== 'file'
      || !original.file.handle || !original.file.parentHandle) throw new DOMException('The board is no longer open', 'AbortError');
    const file = original.file, name = file.name;
    const vaultCurrent = () => getVaultActivation() === activation && rootHandleRef.current === root;
    let written: Awaited<ReturnType<typeof writeBoardCopy>>;
    try {
      written = await writeBoardCopy({ root, parent: file.parentHandle!, owner: file.handle as FileSystemFileHandle, signal,
        isCurrent: vaultCurrent, names: editableCopyNames(name, identity.kind), bytes: files => copy.source.build(files, signal), media: copy.source.media });
    } catch (error) {
      if (!vaultCurrent() || signal.aborted) throw error;
      await tell({ title: 'Could not make an editable copy', confirmLabel: 'OK', body: <>
        {describeReadError(error)}<br /><br />
        No copy was made, and <strong>{name}</strong> is exactly as it was. It stays open to view.
      </> });
      throw error;
    }
    if (!vaultCurrent()) return;
    if (identity.kind === 'notebook') copyCanvasViewPos(file.path, written.path);
    const node: FileTreeNode = { kind: 'file', name: written.name, path: written.path, handle: written.handle, parentHandle: file.parentHandle! };
    const id = newTabId();
    if (copy.notice) handOffCopyNotice(id, copy.notice);
    const representation = representationFor(written.name);
    const text = representation.bufferKind === 'text' ? await written.bytes.text() : '';
    if (!vaultCurrent()) return;
    setBaseline(id, written.version);
    seedDocumentBuffer(id, written.path, text, representation.bufferKind === 'text');
    const opened: OpenTab = { id, file: node, mode: 'read', dirty: false, representation };
    const live = tabsRef.current.find(tab => tab.id === original.id && tab.file.path === file.path);
    const focused = !!live && (copy.focus || focusedPath(layoutRef.current) === file.path);
    if (live) {
      releaseTab(file.path);
      setTabs(previous => [...previous.filter(tab => tab.id !== original.id), opened]);
      setLayout(layout => {
        const next = renamePath(layout, file.path, written.path);
        return copy.focus ? focusTab(next, written.path) : next;
      });
    } else {
      setTabs(previous => previous.some(tab => tab.file.path === written.path) ? previous : [...previous, opened]);
      setLayout(layout => openTab(layout, written.path));
    }
    if (focused) requestDocumentKeyboard(written.path);
    settleEditableCopy(original.id, written.path, file.path);
    announce(`Made an editable copy, “${written.name}”. “${name}” is unchanged.`);
  }, [announce, getVaultActivation, layoutRef, nativePoliciesRef, releaseTab, rootHandleRef, seedDocumentBuffer, setLayout, setTabs, tabsRef, tell, writeBoardCopy]);
  useEffect(() => {
    editableCopyRef.current = make;
    return () => { if (editableCopyRef.current === make) editableCopyRef.current = null; };
  }, [make, editableCopyRef]);
}
