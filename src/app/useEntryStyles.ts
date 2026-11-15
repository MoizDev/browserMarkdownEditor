import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { FileSystemContextValue, FileTreeNode } from '../types';
import { ENTRY_STYLE_FILE, LEGACY_STYLE_FILE, emptyEntryStyles, mergeShard, needsFanOut, parseEntryStyles, serializeEntryStyles, shardEntryStyles, withEntryOrder, withEntryStyle, type IconNode } from '../utils/entryStyle';
import { getEntryStyles, setEntryStyles } from '../utils/entryStyleStore';
import { findDirNode } from '../utils/treeShare';
import { joinVaultPath } from '../utils/paths';
import { reportVault } from '../utils/perfHooks';
import type { Notify } from './useAppDialogs';

/** Every folder in the tree that holds an `.appearance.json`, with the handle
 *  the walk kept for it — depth first, so a parent's looks are read before the
 *  looks of anything inside it. No I/O: the tree already knows. */
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

/**
 * The file tree's icons, colours and Custom order, read from and written to
 * the `.appearance.json` files in the vault (see utils/entryStyle.ts). The
 * store is updated before the write, so a pick shows at once.
 */
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

  /**
   * The looks on disk, as last read or written: folder path → the exact text of
   * its `.appearance.json` ('' = the vault root). It is what the writer diffs
   * against, so a change in one folder writes one small file and leaves every
   * other one untouched — and it is what tells the writer which files to remove
   * when the last icon in a folder is cleared.
   */
  const shardTextRef = useRef<Map<string, string>>(new Map());
  /** Folders whose file has been read into the store, or written from it. A
   *  folder in here is never read again: the store is the newer truth, and this
   *  app is the only writer. */
  const loadedShardsRef = useRef<Set<string>>(new Set());
  /** A pre-shard vault was read (one file at the root, keyed all the way down)
   *  and has still to be fanned out into one file per folder. */
  const fanOutRef = useRef(false);

  // Emptied the moment the vault changes, before the browser paints it — not
  // when the read below lands, and not in a passive effect: switching from the
  // vault menu drew the new vault's tree with the LAST vault's icons and custom
  // order (measured, 6 of 6 switches, even with a passive reset), and a drop or
  // icon pick in that window would have written them into this vault's file.
  // Same reason and shape as resetFileTimes above.
  useLayoutEffect(() => {
    setEntryStyles(emptyEntryStyles());
    shardTextRef.current = new Map();
    loadedShardsRef.current = new Set();
    fanOutRef.current = false;
  }, [rootHandle]);

  /** The migration above runs before `writeEntryStyles` is declared, and a
   *  hoisted reference is the only way to reach it from there. */
  const writeEntryStylesRef = useRef<((next: ReturnType<typeof getEntryStyles>) => Promise<void>) | null>(null);

  /**
   * Read the vault's looks when it opens: `<vault>/.appearance.json` and one
   * more for every folder below it that has one.
   *
   * ONCE PER FOLDER PER VAULT OPEN, not once per tree walk — the walk runs after
   * every save, and a read on that path would be a read per keystroke-triggered
   * autosave (the rule AGENTS.md states for anything that touches the whole
   * vault). The files are held in the store from then on, and this app is the
   * only writer.
   *
   * It waits for the tree because the tree is what KNOWS: `listDir` noticed each
   * `.appearance.json` as it passed and kept the handle, so this opens the few
   * that exist and never gropes for the thousands that do not. Nothing is on
   * screen before the tree is either, so waiting costs no paint. It then re-runs
   * as the tree changes — a folder restored from the trash brings its looks back
   * with it — and does nothing at all when every folder is already loaded.
   */
  useEffect(() => {
    if (!rootHandle) return;
    let cancelled = false;
    (async () => {
      const readText = async (handle: FileSystemFileHandle) => (await handleIO.file(handle)).text();
      const loaded = loadedShardsRef.current;

      // The root's own file first — and the name it had while only folders could
      // be styled, read forward once so a rename we chose costs nobody their
      // icons. The old file is left alone: this app does not delete from a vault
      // to tidy up.
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
          // Not recorded as what is on disk when it came from the legacy name:
          // the writer must then write the file under the name we use now.
          if (!legacy) shardTextRef.current.set('', text);
          if (legacy || needsFanOut(parsed)) fanOutRef.current = true;
          setEntryStyles(mergeShard(getEntryStyles(), '', parsed));
        }
      }

      for (const folder of foldersWithStyleFile(fileTree)) {
        if (loaded.has(folder.path)) continue;
        // Marked before the await, not after: an icon picked in that folder
        // while this read is in flight is the newer truth, and `mergeShard`
        // keeps what the store already holds either way.
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

      // Everything the old layout held is now in the store, and the tree can
      // name a handle for every folder: write it back out, one file per folder.
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

  /**
   * Persist the styles, and put them on screen at once.
   *
   * The store is updated first and the write follows, so a picked icon appears
   * in the sidebar immediately rather than after a round trip to disk — the
   * picker is a live preview, and it is being judged against the real tree.
   *
   * ONLY WHAT CHANGED IS WRITTEN. The merged styles are cut into one file per
   * folder and compared, byte for byte, with what that folder's file last said:
   * an icon picked in one folder writes one small file. A folder left with
   * nothing to say has its file REMOVED — it is ours, we just emptied it, and
   * the alternative is an `.appearance.json` holding `{}` littered through every
   * folder the reader ever tried an icon in.
   *
   * A FOLDER THE TREE CANNOT NAME IS SKIPPED, never an error: that is a folder
   * that has just been renamed, moved or trashed, and its file went with it
   * inside the folder — which is the whole point of storing a look beside the
   * thing it describes.
   *
   * WRITES ARE SERIALIZED, in call order. A drop into another folder under the
   * Custom sort writes twice back to back (the new order, then the move's
   * re-key), and two overlapping `createWritable`s on one file land in
   * COMPLETION order — the older snapshot could win on disk while the screen
   * shows the newer. Each write also captures the vault it was asked for, so one
   * still queued at a vault switch cannot land in the next vault.
   */
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

    // Recorded before the write, so the next pick diffs against what this one is
    // about to put there rather than asking for it all over again.
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
          // A file that is already gone is the ordinary end of a removal.
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

  /** Stable for the app's life: FileExplorer and TreeNode are both memoized. */
  const handleStyleEntry = useCallback((
    path: string,
    icon: string | undefined,
    color: string | undefined,
    nodes?: IconNode[],
  ) => {
    void writeEntryStyles(withEntryStyle(getEntryStyles(), path, { icon, color }, nodes));
  }, [writeEntryStyles]);

  /** One folder's custom order (the tree's Custom sort), from a drop in the
   *  explorer. Stable per vault, for the same memo as handleStyleEntry; an
   *  unchanged list comes back as the same file and costs no write. */
  const handleSetTreeOrder = useCallback((folderPath: string, names: readonly string[] | null) => {
    const current = getEntryStyles();
    const next = withEntryOrder(current, folderPath, names);
    if (next !== current) void writeEntryStyles(next);
  }, [writeEntryStyles]);

  return { writeEntryStyles, handleStyleEntry, handleSetTreeOrder };
}
