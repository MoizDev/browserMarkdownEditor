import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { FileSystemContextValue, FileTreeNode } from '../types';
import { ENTRY_STYLE_FILE, LEGACY_STYLE_FILE, emptyEntryStyles, mergeShard, needsFanOut, parseEntryStyles, serializeEntryStyles, shardEntryStyles, withEntryOrder, withEntryStyle, type IconNode } from '../utils/entryStyle';
import { getEntryStyles, setEntryStyles } from '../utils/entryStyleStore';
import { findDirNode } from '../utils/treeShare';
import { joinVaultPath } from '../utils/paths';
import { reportVault } from '../utils/perfHooks';
import type { Notify } from './useAppDialogs';

function foldersWithStyleFile(
    nodes: readonly FileTreeNode[],
): { path: string; styleFile: FileSystemFileHandle }[] {
    const out: { path: string; styleFile: FileSystemFileHandle }[] = [];
    const walk = (list: readonly FileTreeNode[]) => {
        for (const node of list) {
            if (node.kind !== 'directory') continue;
            if (node.styleFile) out.push({ path: node.path, styleFile: node.styleFile });
            walk(node.children);
        }
    };
    walk(nodes);
    return out;
}

export interface UseEntryStylesDeps {
  rootHandle: FileSystemContextValue['rootHandle'];
  handleIO: FileSystemContextValue['handleIO'];
  fileTree: FileSystemContextValue['fileTree'];
  fileTreeRef: React.RefObject<FileTreeNode[]>;
  writeFile: FileSystemContextValue['writeFile'];
  notify: Notify;
}

export function useEntryStyles(deps: UseEntryStylesDeps) {
  const { rootHandle, handleIO, fileTree, fileTreeRef, writeFile, notify } = deps;

  const shardTextRef = useRef<Map<string, string>>(new Map());
  const loadedShardsRef = useRef<Set<string>>(new Set());
  const fanOutRef = useRef(false);

  useLayoutEffect(() => {
    setEntryStyles(emptyEntryStyles());
    shardTextRef.current = new Map();
    loadedShardsRef.current = new Set();
    fanOutRef.current = false;
  }, [rootHandle]);

  const writeEntryStylesRef = useRef<((next: ReturnType<typeof getEntryStyles>) => Promise<void>) | null>(null);

  useEffect(() => {
    if (!rootHandle) return;
    let cancelled = false;
    (async () => {
      const readText = async (handle: FileSystemFileHandle) => (await handleIO.file(handle)).text();
      const loaded = loadedShardsRef.current;

      if (!loaded.has('')) {
        loaded.add('');
        let text: string | null = null;
        let legacy = false;
        try {
          text = await readText(await handleIO.fileIn(rootHandle, ENTRY_STYLE_FILE));
        } catch {
          try {
            text = await readText(await handleIO.fileIn(rootHandle, LEGACY_STYLE_FILE));
            legacy = true;
          } catch {
            // No file at all is the ordinary case — a vault has none until
            // something is given a look.
          }
        }
        if (cancelled) return;
        if (text !== null) {
          const parsed = parseEntryStyles(text);
          if (!legacy) shardTextRef.current.set('', text);
          if (legacy || needsFanOut(parsed)) fanOutRef.current = true;
          setEntryStyles(mergeShard(getEntryStyles(), '', parsed));
        }
      }

      for (const folder of foldersWithStyleFile(fileTree)) {
        if (loaded.has(folder.path)) continue;
        loaded.add(folder.path);
        try {
          const text = await readText(folder.styleFile);
          if (cancelled) return;
          shardTextRef.current.set(folder.path, text);
          setEntryStyles(mergeShard(getEntryStyles(), folder.path, parseEntryStyles(text)));
        } catch {
          // One unreadable file costs that folder its icons, nothing more.
        }
      }

      // NOT before the tree has landed — the writer can only reach a folder the
      // tree names, and fanning out against an empty one would write the root's
      // file and drop every deeper entry on the floor.
      if (fanOutRef.current && fileTree.length && !cancelled) {
        fanOutRef.current = false;
        void writeEntryStylesRef.current?.(getEntryStyles());
      }
    })();
    return () => { cancelled = true; };
  }, [rootHandle, fileTree, handleIO]);

  const entryStyleWritesRef = useRef<Promise<void>>(Promise.resolve());
  const writeEntryStyles = useCallback((next: ReturnType<typeof getEntryStyles>): Promise<void> => {
    setEntryStyles(next);
    const root = rootHandle;
    if (!root) return Promise.resolve();
    const tree = fileTreeRef.current;

    const wanted = new Map<string, string>();
    for (const [folder, shard] of shardEntryStyles(next)) wanted.set(folder, serializeEntryStyles(shard));
    const todo: { folder: string; text: string | null }[] = [];
    for (const [folder, text] of wanted) {
      if (shardTextRef.current.get(folder) !== text) todo.push({ folder, text });
    }
    for (const folder of shardTextRef.current.keys()) {
      if (!wanted.has(folder)) todo.push({ folder, text: null });
    }
    if (!todo.length) return Promise.resolve();

    for (const { folder, text } of todo) {
      if (text === null) shardTextRef.current.delete(folder);
      else shardTextRef.current.set(folder, text);
      loadedShardsRef.current.add(folder);
    }

    const write = entryStyleWritesRef.current.then(async () => {
      for (const { folder, text } of todo) {
        const dir = folder ? findDirNode(tree, folder)?.handle : root;
        if (!dir) continue;
        try {
          if (text === null) {
            await handleIO.remove(dir, ENTRY_STYLE_FILE);
          } else {
            // NOT createFile: that truncates to '' in a writable of its own (a
            // tab closed in between would lose every icon and the custom order)
            // and then walks the entire vault to refresh a tree this hidden file
            // never appears in. Measured under Custom: that walk, landing
            // mid-moveFile, rendered a dropped file in BOTH folders plus its
            // `.crswap`, and a write queued past a vault switch repainted the
            // OLD vault's tree. One writable replaces the file whole, atomically
            // on close.
            const handle = await handleIO.fileIn(dir, ENTRY_STYLE_FILE, true);
            if (__BME_BENCH__) {
              try { reportVault({ op: 'write', path: joinVaultPath(folder, ENTRY_STYLE_FILE), caller: 'appearance' }); } catch { /* Measurement must not interrupt a write. */ }
            }
            await writeFile(handle, text);
          }
        } catch (err) {
          if (text === null && err instanceof DOMException && err.name === 'NotFoundError') continue;
          console.error(`Could not save ${ENTRY_STYLE_FILE}:`, err);
          notify('Could not save the file tree’s icons, colours or order.');
        }
      }
    });
    entryStyleWritesRef.current = write;
    return write;
  }, [notify, rootHandle, writeFile, handleIO, fileTreeRef]);
  useEffect(() => { writeEntryStylesRef.current = writeEntryStyles; }, [writeEntryStyles]);

  const handleStyleEntry = useCallback((
    path: string,
    icon: string | undefined,
    color: string | undefined,
    nodes?: IconNode[],
  ) => {
    void writeEntryStyles(withEntryStyle(getEntryStyles(), path, { icon, color }, nodes));
  }, [writeEntryStyles]);

  const handleSetTreeOrder = useCallback((folderPath: string, names: readonly string[] | null) => {
    const current = getEntryStyles();
    const next = withEntryOrder(current, folderPath, names);
    if (next !== current) void writeEntryStyles(next);
  }, [writeEntryStyles]);

  return { writeEntryStyles, handleStyleEntry, handleSetTreeOrder };
}
