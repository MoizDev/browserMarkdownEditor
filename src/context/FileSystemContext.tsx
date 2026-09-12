import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { get, set } from 'idb-keyval';
import { forgetVault, labelVaults, loadRecentVaults, rememberVault, withVaultPaths } from '../utils/recentVaults';
import { findLinkedVault, readLocation } from '../utils/appUrl';
import { ENTRY_STYLE_FILE, LEGACY_STYLE_FILE } from '../utils/entryStyle';
import { ASSETS_DIR, TRASH_DIR, isAssetName } from '../utils/assets';
import { joinVaultPath } from '../utils/paths';
import { sortTrashChildren, sortTrashRoot } from '../utils/trash';
import type {
    FileTreeNode, FileSystemContextValue, RecentVault, StoredVault, VaultOpenResult,
    TrashItem, TrashRestoreMode, TrashRestoreResult,
} from '../types';

const FileSystemContext = createContext<FileSystemContextValue | null>(null);

const IDB_KEY = 'vault-directory-handle';

/**
 * Whether `dir` already holds an entry called `name` — of EITHER kind.
 *
 * Two positive lookups rather than one lookup and a reading of the failure:
 * `getFileHandle` does reject with TypeMismatchError when the name belongs to a
 * directory, but keying "this name is taken" on an exact DOMException name is a
 * more brittle thing to rest a delete on than simply asking both questions.
 */
async function entryExists(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
    try { await dir.getFileHandle(name); return true; } catch { /* not a file here */ }
    try { await dir.getDirectoryHandle(name); return true; } catch { /* nor a directory */ }
    return false;
}

/**
 * WHAT `name` is in `dir` — its kind and its handle — or null if it is nothing.
 *
 * `entryExists` answers whether, not which, and the two calls that displace an
 * entry standing in a put-back's way need both: the kind decides whether the
 * copy is recursive, and getting it wrong means a `removeEntry` that throws
 * and a duplicate left behind.
 */
async function liveEntry(
    dir: FileSystemDirectoryHandle,
    name: string,
): Promise<{ name: string; kind: 'file' | 'directory'; handle: FileSystemFileHandle | FileSystemDirectoryHandle } | null> {
    try { return { name, kind: 'directory', handle: await dir.getDirectoryHandle(name) }; } catch { /* not a directory */ }
    try { return { name, kind: 'file', handle: await dir.getFileHandle(name) }; } catch { /* nor a file */ }
    return null;
}

/**
 * A name that is free in `dir`: "note.md", then "note (1).md", "note (2).md", …
 *
 * Every write that could land on an existing entry goes through here. Silently
 * overwriting somebody's file is not a recoverable mistake — and for the trash
 * in particular, deleting the same name twice would otherwise destroy the first
 * copy at the exact moment the user was counting on it being kept.
 *
 * A folder and a file cannot share a name, so BOTH kinds count as taken whatever
 * kind is being written. Asking only about files reported a name free while a
 * folder of that name sat there, and the write that followed threw outright —
 * which for the trash meant a deletion that simply failed. That is reachable the
 * moment folders can be deleted: trash the folder "notes", then the file
 * "notes" beside it.
 *
 * `kind` decides only where the number goes: a folder has no extension, so
 * "my.notes" numbers as "my.notes (1)" rather than "my (1).notes".
 */
async function freeEntryName(
    dir: FileSystemDirectoryHandle,
    name: string,
    kind: 'file' | 'directory' = 'file',
): Promise<string> {
    const dot = kind === 'file' ? name.lastIndexOf('.') : -1;
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';

    let candidate = name;
    for (let n = 1; ; n++) {
        if (!(await entryExists(dir, candidate))) return candidate;
        candidate = `${stem} (${n})${ext}`;
    }
}

/** Copy one file's bytes into `dir` under `name`. */
async function copyFileInto(dir: FileSystemDirectoryHandle, name: string, file: File): Promise<void> {
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(file);
    await writable.close();
}

/**
 * Where a folder parks assets whose last reference went away:
 * `<folder>/.Garbage/.Assets`, mirroring where they came from.
 *
 * Deliberately NOT alongside the trashed files in `.Garbage` itself. A retired
 * asset can be brought straight back when its reference returns (an undo, a
 * cut-and-paste), and that round trip has to be exact — parked under the same
 * name a user-trashed file could also hold, restoring one would resurrect the
 * other's bytes into `.Assets`.
 */
async function retiredAssetsDir(dir: FileSystemDirectoryHandle, create: boolean): Promise<FileSystemDirectoryHandle> {
    const trash = await dir.getDirectoryHandle(TRASH_DIR, { create });
    return trash.getDirectoryHandle(ASSETS_DIR, { create });
}

/**
 * Recursively copies all entries from srcDir to destDir.
 */
async function copyDirRecursive(srcDir: FileSystemDirectoryHandle, destDir: FileSystemDirectoryHandle): Promise<void> {
    for await (const [name, handle] of srcDir.entries()) {
        if (handle.kind === 'file') {
            const file = await handle.getFile();
            const newFile = await destDir.getFileHandle(name, { create: true });
            const writable = await newFile.createWritable();
            await writable.write(file);
            await writable.close();
        } else {
            const newSub = await destDir.getDirectoryHandle(name, { create: true });
            await copyDirRecursive(handle, newSub);
        }
    }
}

/**
 * Move `entry` out of `dir` and into `bucket` — a `.Garbage`, or the
 * `.Garbage/.Assets` retired pictures are parked in — under a name free there.
 * Returns the name it was filed under.
 *
 * IT EITHER HAPPENED OR IT DIDN'T. Anything that throws — a copy that dies
 * partway, or a `removeEntry` refused because a file inside is still being
 * written — takes the copy back out again before rethrowing. Without that, the
 * realistic failure (the copy SUCCEEDS and the removal is refused) left a
 * complete second copy of the folder in `.Garbage`, and every retry added
 * another numbered one: megabytes to gigabytes of trash indexed under names
 * indistinguishable, in Finder, from a good backup. Removing it is safe
 * precisely because it is ours — `freeEntryName` certified the name free a
 * moment earlier and nothing else may be copying at the same time (App
 * serializes every one of these through one in-flight ref) — so this can only
 * unmake what it just made. It is not a licence to prune `.Garbage`, which
 * nothing here does.
 *
 * Shared by `moveToTrash` and by the bin's "Replace", which displaces the live
 * entry a put-back would land on instead of overwriting it: one rollback,
 * written once, for both.
 */
async function displaceInto(
    bucket: FileSystemDirectoryHandle,
    dir: FileSystemDirectoryHandle,
    entry: { name: string; kind: 'file' | 'directory'; handle: FileSystemFileHandle | FileSystemDirectoryHandle },
): Promise<string> {
    // What this call has written, so a failure can take it back out. Recorded
    // before a single byte, so a copy that dies on its first file is unmade
    // just as surely as one that dies on its last.
    let wrote: { dir: FileSystemDirectoryHandle; name: string } | null = null;
    try {
        // Deleting the same name twice must not destroy the first copy.
        const name = await freeEntryName(bucket, entry.name, entry.kind);
        wrote = { dir: bucket, name };

        if (entry.kind === 'file') {
            await copyFileInto(bucket, name, await (entry.handle as FileSystemFileHandle).getFile());
        } else {
            const grave = await bucket.getDirectoryHandle(name, { create: true });
            await copyDirRecursive(entry.handle as FileSystemDirectoryHandle, grave);
        }

        // Remove the original. Recursively for a folder — it still holds
        // everything that was just copied out of it.
        await dir.removeEntry(entry.name, { recursive: entry.kind === 'directory' });
        return name;
    } catch (err) {
        if (wrote) {
            try {
                await wrote.dir.removeEntry(wrote.name, { recursive: entry.kind === 'directory' });
            } catch (undoErr) {
                // Nothing is lost — the original is still there — so say so and
                // leave it rather than trying harder at a failing disk.
                console.error('Could not remove the abandoned copy:', undoErr);
            }
        }
        throw err;
    }
}

/**
 * Recursively traverses a FileSystemDirectoryHandle and returns a nested tree.
 */
async function buildFileTree(dirHandle: FileSystemDirectoryHandle, path = ''): Promise<FileTreeNode[]> {
    const children: FileTreeNode[] = [];

    for await (const [name, handle] of dirHandle.entries()) {
        if (name === '.DS_Store') continue;
        // The app's own record of how things look. Hidden for the same reason
        // .Assets and .Garbage are: it is bookkeeping, not something the reader
        // put in their vault. Root-only, unlike those two — see entryStyle.ts.
        // The legacy name goes too: migration reads it forward and deliberately
        // leaves it on disk, and a file this app wrote should not then surface
        // in the tree as though the reader had put it there.
        if (!path && (name === ENTRY_STYLE_FILE || name === LEGACY_STYLE_FILE)) continue;
        // Hide standard system folders from the UI. Every folder may hold its
        // own pair of them (see utils/assets.ts), so this is not a root-only test.
        if (handle.kind === 'directory' && (name === ASSETS_DIR || name === TRASH_DIR)) continue;

        const entryPath = path ? `${path}/${name}` : name;

        if (handle.kind === 'directory') {
            const subtree = await buildFileTree(handle, entryPath);
            children.push({
                name,
                kind: 'directory',
                path: entryPath,
                handle,
                parentHandle: dirHandle,
                children: subtree,
            });
        } else {
            children.push({
                name,
                kind: 'file',
                path: entryPath,
                handle,
                parentHandle: dirHandle,
            });
        }
    }

    // Sort: directories first, then files. Alphabetical within each group.
    children.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    return children;
}

/* ── The trash bin's crawl ───────────────────────────────────────────────────
 * Everything trashed anywhere in the vault, gathered into ONE flat list, on
 * demand. A deletion leaves no record but the copy itself sitting in the
 * `.Garbage` beside where it came from, so finding them all means walking the
 * whole vault — and this is the only place in the app that walks INTO those
 * folders (buildFileTree hides them, and nothing else looks).
 *
 * DELIBERATELY UNCACHED, unlike the other two whole-vault walks
 * (utils/graph.ts, utils/vaultSearch.ts, both `(lastModified, size)`-validated
 * per AGENTS.md): those run after EVERY save, where an uncached walk would be a
 * full vault read per keystroke-triggered autosave. This one runs when the
 * reader clicks the bin and at no other time — it must not subscribe to
 * `saveEpoch` — and the wait was chosen over a second vault-sized index in a
 * tab that already holds one. It reads metadata only: a name, a size and an
 * mtime per entry, never a file's bytes.
 *
 * THE ONE RULE, applied at every depth: an item belongs to the parent of the
 * OUTERMOST `.Garbage` on its path — carried down these functions as
 * `ownerDir`/`ownerPath` from the first `.Garbage` entered and never
 * recomputed, which is the whole of the definition. A trashed folder keeps its own
 * `.Garbage` inside it, so `math/.Garbage/homework/.Garbage/old.md` is a real
 * path and means "old.md was deleted from homework, and then homework itself
 * was deleted". It is listed at the bin's ROOT and goes back to `math/`, flat —
 * never into a recreated `homework`, which is not a folder the reader has.
 *
 * A directory that cannot be read is logged and skipped rather than thrown
 * from: one locked folder must not cost the reader the rest of their trash.
 * ─────────────────────────────────────────────────────────────────────────── */

/** A file's metadata, tolerant of a read that fails mid-crawl — a file being
 *  written as the walk passes it must not take the whole bin down. */
async function statFile(handle: FileSystemFileHandle): Promise<{ mtime: number; size: number }> {
    try {
        const file = await handle.getFile();
        return { mtime: file.lastModified, size: file.size };
    } catch {
        return { mtime: 0, size: 0 };
    }
}

/** Retired pictures — `<owner>/.Garbage/.Assets/*`, parked there by retireAsset
 *  when the last note stopped embedding them. Listed one by one rather than as
 *  a folder (that folder is the app's bookkeeping, not something the reader
 *  deleted), and each goes back into `<owner>/.Assets`: an embed resolves from
 *  nowhere else, so a picture put back beside the notes would be one nothing
 *  could display. */
async function collectRetired(
    assetsDir: FileSystemDirectoryHandle,
    assetsPath: string,
    ownerDir: FileSystemDirectoryHandle,
    ownerPath: string,
    out: TrashItem[],
): Promise<void> {
    try {
        for await (const [name, handle] of assetsDir.entries()) {
            if (handle.kind !== 'file' || name === '.DS_Store' || !isAssetName(name)) continue;
            const { mtime, size } = await statFile(handle);
            const sourcePath = joinVaultPath(assetsPath, name);
            out.push({
                id: sourcePath, name, kind: 'file', origin: 'retired', sourcePath,
                handle, parentHandle: assetsDir,
                restorePath: ownerPath, restoreDirHandle: ownerDir,
                deletedAt: mtime, size,
            });
        }
    } catch (err) {
        console.warn('Could not read the retired pictures in', assetsPath, err);
    }
}

/** Everything one `.Garbage` holds, as rows of the bin's root list. */
async function collectGarbage(
    garbageDir: FileSystemDirectoryHandle,
    garbagePath: string,
    ownerDir: FileSystemDirectoryHandle,
    ownerPath: string,
    out: TrashItem[],
): Promise<void> {
    try {
        for await (const [name, handle] of garbageDir.entries()) {
            if (name === '.DS_Store' || !isAssetName(name)) continue;
            const sourcePath = joinVaultPath(garbagePath, name);

            if (handle.kind === 'directory') {
                if (name === ASSETS_DIR) {
                    await collectRetired(handle, sourcePath, ownerDir, ownerPath, out);
                    continue;
                }
                // A `.Garbage` directly inside a `.Garbage` is unreachable today
                // — moveToTrash refuses to trash either hidden folder — so this
                // is defensive. Treated as more of the same bucket rather than
                // as a folder somebody deleted, because drawing it as one would
                // invite a put-back that recreated a `.Garbage` in the vault.
                if (name === TRASH_DIR) {
                    await collectGarbage(handle, sourcePath, ownerDir, ownerPath, out);
                    continue;
                }
                out.push(await buildTrashedDir(handle, sourcePath, garbageDir, ownerDir, ownerPath, out));
                continue;
            }

            const { mtime, size } = await statFile(handle);
            out.push({
                id: sourcePath, name, kind: 'file', origin: 'trashed', sourcePath,
                handle, parentHandle: garbageDir,
                restorePath: ownerPath, restoreDirHandle: ownerDir,
                deletedAt: mtime, size,
            });
        }
    } catch (err) {
        console.warn('Could not read the trash at', garbagePath, err);
    }
}

/** What a trashed folder's own `.Assets` adds to its weight and its age. Not
 *  listed: those pictures are the folder's, and they travel back with it. */
async function measureLiveAssets(assetsDir: FileSystemDirectoryHandle): Promise<{ newest: number; size: number }> {
    let newest = 0;
    let size = 0;
    try {
        for await (const [name, handle] of assetsDir.entries()) {
            // .DS_Store skipped the way every other walker here skips it: it is
            // Finder's, not the reader's, and weighing it would put a folder's
            // deletion time at whenever macOS last touched that file.
            if (handle.kind !== 'file' || name === '.DS_Store') continue;
            const stat = await statFile(handle);
            newest = Math.max(newest, stat.mtime);
            size += stat.size;
        }
    } catch (err) {
        console.warn('Could not measure a trashed folder’s pictures:', err);
    }
    return { newest, size };
}

/** One trashed folder, and what drilling into it shows. Its deletion time is
 *  the newest mtime anywhere inside it, which is when the copy was made. */
async function buildTrashedDir(
    dir: FileSystemDirectoryHandle,
    path: string,
    parentHandle: FileSystemDirectoryHandle,
    ownerDir: FileSystemDirectoryHandle,
    ownerPath: string,
    out: TrashItem[],
): Promise<TrashItem> {
    const children: TrashItem[] = [];
    let newest = 0;
    let size = 0;

    try {
        for await (const [name, handle] of dir.entries()) {
            if (name === '.DS_Store' || !isAssetName(name)) continue;
            const childPath = joinVaultPath(path, name);

            if (handle.kind === 'directory') {
                if (name === TRASH_DIR) {
                    // Deleted from this folder BEFORE the folder itself was, so
                    // it was never part of what the reader threw away here.
                    // Hoisted to the bin's root, where it reads as the
                    // standalone deletion it was — and goes back to the owner,
                    // not into this folder.
                    await collectGarbage(handle, childPath, ownerDir, ownerPath, out);
                    continue;
                }
                if (name === ASSETS_DIR) {
                    const measured = await measureLiveAssets(handle);
                    newest = Math.max(newest, measured.newest);
                    size += measured.size;
                    continue;
                }
                const sub = await buildTrashedDir(handle, childPath, dir, ownerDir, ownerPath, out);
                newest = Math.max(newest, sub.deletedAt);
                size += sub.size;
                children.push(sub);
                continue;
            }

            const stat = await statFile(handle);
            newest = Math.max(newest, stat.mtime);
            size += stat.size;
            children.push({
                id: childPath, name, kind: 'file', origin: 'trashed', sourcePath: childPath,
                handle, parentHandle: dir,
                restorePath: ownerPath, restoreDirHandle: ownerDir,
                deletedAt: stat.mtime, size: stat.size,
            });
        }
    } catch (err) {
        console.warn('Could not read the trashed folder at', path, err);
    }

    return {
        id: path, name: dir.name, kind: 'directory', origin: 'trashed', sourcePath: path,
        handle: dir, parentHandle,
        restorePath: ownerPath, restoreDirHandle: ownerDir,
        deletedAt: newest, size,
        children: sortTrashChildren(children),
    };
}

/**
 * The bin row for an entry a "Replace" has just displaced into `bucket`.
 *
 * Read back off disk rather than assembled from what was displaced: the copy
 * is what the bin now holds, and its name is whatever `freeEntryName` settled
 * on. Returns undefined if it cannot be read — the put-back itself succeeded,
 * and the row will be there the next time the bin is opened (which re-crawls
 * from scratch anyway).
 */
async function describeDisplaced(
    bucket: FileSystemDirectoryHandle,
    bucketPath: string,
    name: string,
    kind: 'file' | 'directory',
    origin: TrashItem['origin'],
    ownerDir: FileSystemDirectoryHandle,
    ownerPath: string,
): Promise<TrashItem | undefined> {
    const sourcePath = joinVaultPath(bucketPath, name);
    try {
        if (kind === 'file') {
            const handle = await bucket.getFileHandle(name);
            const { mtime, size } = await statFile(handle);
            return {
                id: sourcePath, name, kind: 'file', origin, sourcePath,
                handle, parentHandle: bucket,
                restorePath: ownerPath, restoreDirHandle: ownerDir,
                deletedAt: mtime || Date.now(), size,
            };
        }
        const handle = await bucket.getDirectoryHandle(name);
        // Any nested `.Garbage` this folder carries would be hoisted rows of
        // their own; they are dropped rather than guessed at, and turn up on
        // the bin's next open.
        const hoisted: TrashItem[] = [];
        return await buildTrashedDir(handle, sourcePath, bucket, ownerDir, ownerPath, hoisted);
    } catch (err) {
        console.warn('Could not describe the displaced entry at', sourcePath, err);
        return undefined;
    }
}

/** The live tree, looking for `.Garbage` folders. Never descends into one (that
 *  is collectGarbage's job) and never into a live `.Assets`. */
async function walkForTrash(dir: FileSystemDirectoryHandle, path: string, out: TrashItem[]): Promise<void> {
    try {
        for await (const [name, handle] of dir.entries()) {
            if (handle.kind !== 'directory' || !isAssetName(name)) continue;
            if (name === ASSETS_DIR) continue;             // live pictures, not trash
            const childPath = joinVaultPath(path, name);
            if (name === TRASH_DIR) {
                await collectGarbage(handle, childPath, dir, path, out);
                continue;
            }
            await walkForTrash(handle, childPath, out);
        }
    } catch (err) {
        console.warn('Could not walk', path || 'the vault root', 'for trash:', err);
    }
}

export function FileSystemProvider({ children }: { children: ReactNode }) {
    const [rootHandle, setRootHandle] = useState<FileSystemDirectoryHandle | null>(null);
    const [fileTree, setFileTree] = useState<FileTreeNode[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [previousVault, setPreviousVault] = useState<FileSystemDirectoryHandle | null>(null);
    /** What the address bar asked for and could not be given silently — the
     *  handle is known but its permission has lapsed, and `requestPermission`
     *  needs a click. App renders a one-button screen naming this vault. */
    const [linkedVault, setLinkedVault] = useState<RecentVault | null>(null);
    const [recentVaults, setRecentVaults] = useState<RecentVault[]>([]);
    const [currentVaultId, setCurrentVaultId] = useState<string | null>(null);

    // The open vault, readable from the stable callbacks below without making
    // them depend on it (they are props of the memoized FileExplorer).
    const rootHandleRef = useRef<FileSystemDirectoryHandle | null>(null);
    useEffect(() => { rootHandleRef.current = rootHandle; }, [rootHandle]);

    // True while a native folder picker is up (see pickDirectory).
    const pickerOpenRef = useRef(false);

    /**
     * True while a vault switch is underway — for the picker from the moment it
     * opens (a folder chosen there has to be able to commit, so the gate cannot
     * wait for the pick), for the others from the call — until its tree walk has
     * finished. ONE switch at a time, across every raiser.
     *
     * Each raiser used to guard only itself — VaultMenu's `opening`, the tree
     * row's `openAsVaultInFlightRef`, `pickerOpenRef` — which stops nobody from
     * starting a switch while a DIFFERENT raiser's walk is running. Measured:
     * "Open as Vault" on a 40-file folder (walk ~4.5s), then a recent-vault row
     * clicked 260ms in, left the sidebar listing the first vault's 40 files
     * while the header, the IndexedDB handle and the menu's current-vault check
     * all read the second. A row clicked in that state opens one vault's handle
     * under the other's path — a write into the wrong vault. The gate belongs
     * here, at the one funnel all three raisers pass through, not in any of them.
     */
    const switchInFlightRef = useRef(false);

    /**
     * True when `handle` names the folder that is already open, whatever object
     * it happens to be.
     *
     * Re-opening the CURRENT vault must not look like a switch: App.tsx compares
     * root handles by object identity and empties the workspace when they
     * differ, while the picker mints a fresh handle for the same folder every
     * time — so picking the folder you already have open would otherwise close
     * every tab. `isSameEntry` is the only identity test the platform offers
     * (see utils/recentVaults.ts).
     */
    const isCurrentVault = useCallback(async (handle: FileSystemDirectoryHandle) => {
        const current = rootHandleRef.current;
        if (!current) return false;
        try {
            return await current.isSameEntry(handle);
        } catch {
            return false;
        }
    }, []);

    /**
     * Walk a vault into a tree, or null if the walk failed.
     *
     * Split out of `refreshTree` because a vault SWITCH has to know whether the
     * walk worked BEFORE it commits anything — see openVaultHandle. Swallowing
     * the failure is right for a refresh and wrong for a switch: a switch that
     * kept the old tree standing would have already moved `rootHandle`.
     */
    const loadTree = useCallback(async (handle: FileSystemDirectoryHandle): Promise<FileTreeNode[] | null> => {
        try {
            return await buildFileTree(handle);
        } catch (err) {
            console.error('Failed to build file tree:', err);
            return null;
        }
    }, []);

    /**
     * Refresh the file tree from the current root handle. A failed walk leaves
     * the tree that is up standing: it still describes the vault the app is on,
     * which is more use than an empty sidebar.
     */
    const refreshTree = useCallback(async (handle: FileSystemDirectoryHandle | null | undefined) => {
        if (!handle) return;
        const tree = await loadTree(handle);
        if (tree) setFileTree(tree);
    }, [loadTree]);

    /**
     * Publish a stored list to the menu.
     *
     * Labelling is never optional and never cacheable: `label` is qualified to
     * "parent/name" only while two listed vaults share a folder name, so any
     * change to the list can free — or take — a survivor's bare name. Going
     * through one function is what stops a future writer from setting the state
     * directly and shipping stale labels.
     */
    const publishVaults = useCallback(async (list: StoredVault[], root?: FileSystemDirectoryHandle | null) => {
        const labelled = await labelVaults(list);
        // The root is passed in rather than read from state: every caller has
        // just decided what it is, and the one on mount runs before the state
        // it would read has settled.
        setRecentVaults(root ? await withVaultPaths(labelled, root) : labelled);
    }, []);

    /**
     * Note a vault as just-opened: it moves to the head of the recent list and
     * becomes the one the vault menu marks as current. Every path that changes
     * `rootHandle` goes through here, including the silent restore on mount —
     * the list would otherwise be missing the vault the user is looking at.
     */
    const recordVault = useCallback(async (handle: FileSystemDirectoryHandle) => {
        try {
            const { list, id } = await rememberVault(handle);
            setCurrentVaultId(id);
            await publishVaults(list, handle);
        } catch (err) {
            console.warn('Could not record the opened vault:', err);
        }
    }, [publishVaults]);

    /**
     * On mount, try to restore the previously saved directory handle from IndexedDB.
     */
    useEffect(() => {
        (async () => {
            // The address bar wins over the last-used vault: a link is an
            // instruction, and a stored handle is only a default. Both are read
            // before either is acted on, so a link naming a vault this browser
            // has never opened falls back to the default rather than to nothing.
            const linked = readLocation().vault;
            let stored: StoredVault[] = [];
            try {
                stored = await loadRecentVaults();
            } catch (err) {
                console.warn('Could not load the recent vault list:', err);
            }
            const target = findLinkedVault(linked, stored);

            try {
                if (target) {
                    // queryPermission needs no user gesture; requestPermission
                    // does, and there has been none — this is a page load. So a
                    // lapsed grant is handed to App to ask for with a button.
                    const permission = await target.handle.queryPermission({ mode: 'readwrite' });
                    if (permission === 'granted') {
                        setRootHandle(target.handle);
                        await recordVault(target.handle);
                        await refreshTree(target.handle);
                        setIsLoading(false);
                        return;
                    }
                    setLinkedVault((await labelVaults([target]))[0]);
                    await publishVaults(stored, target.handle);
                    setIsLoading(false);
                    return;
                }

                const storedHandle = await get<FileSystemDirectoryHandle>(IDB_KEY);
                if (storedHandle) {
                    // queryPermission does not require a user gesture, unlike requestPermission
                    const permission = await storedHandle.queryPermission({ mode: 'readwrite' });
                    if (permission === 'granted') {
                        setRootHandle(storedHandle);
                        // Before the tree walk, so the vault menu is already
                        // right on the first render that has a vault to show.
                        await recordVault(storedHandle);
                        await refreshTree(storedHandle);
                        setIsLoading(false); // Fix: Ensure loading state is turned off
                        return;
                    } else if (permission === 'prompt') {
                        // Store it so we can show a "Restore Previous Vault" button
                        setPreviousVault(storedHandle);
                    }
                }
            } catch (err) {
                console.warn('Could not restore directory handle:', err);
            }
            // No vault restored — the list still loads, so whatever the user
            // opens next lands on top of a complete history.
            await publishVaults(stored, null);
            setIsLoading(false);
        })();
    }, [refreshTree, recordVault, publishVaults]);


    /**
     * Prompt the user to pick a directory, store its handle, and scan it.
     *
     * Reports its outcome the way `openVaultHandle` does, and for the same
     * reason: "Open folder…" is a menu row, and the menu closes on the result.
     * A picker refused because another switch is walking has to come back
     * 'busy' and say so — returning void, the row closed the menu, opened no
     * picker and said nothing, which is the dead click messageFor rules out.
     */
    const pickDirectory = useCallback(async (): Promise<VaultOpenResult> => {
        if (!window.showDirectoryPicker) {
            alert(
                "Your browser doesn't support the local File System Access API.\n\n" +
                "This feature is currently only supported in Chromium-based browsers (Chrome, Edge, Opera) on desktop."
            );
            return 'error';
        }
        // One picker at a time: browsing for a vault is a DOUBLE-click on the
        // explorer's vault button, and with nothing in the recent list the first
        // of those two clicks already opens the picker. A second call while one
        // is up rejects with NotAllowedError ("File picker already active").
        if (pickerOpenRef.current || switchInFlightRef.current) return 'busy';
        pickerOpenRef.current = true;
        switchInFlightRef.current = true;

        try {
            const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
            // Picking the folder already open is a no-op, not a vault switch —
            // keep the handle the app (and every open tab) is already using.
            if (await isCurrentVault(handle)) {
                await refreshTree(rootHandleRef.current);
                return 'ok';
            }
            // Walk before committing, exactly as openVaultHandle does — see the
            // reasoning there. The picker reached that split state the least
            // often (its own dialog is tab-modal, so the tree is unclickable
            // until it closes), but the window it opened afterwards was the
            // same one, and it is the same three lines that close it.
            const tree = await loadTree(handle);
            if (!tree) return 'error';

            await set(IDB_KEY, handle);
            setPreviousVault(null);
            setRootHandle(handle);
            setFileTree(tree);
            await recordVault(handle);
            return 'ok';
        } catch (err) {
            // Cancelling the picker is not a failure — nothing was asked for and
            // nothing went wrong — so it reports 'ok' and the menu closes on it,
            // which is what "Open folder…" has always done.
            if ((err as DOMException).name === 'AbortError') return 'ok';
            console.error('Error picking directory:', err);
            return 'error';
        } finally {
            pickerOpenRef.current = false;
            switchInFlightRef.current = false;
        }
    }, [refreshTree, loadTree, recordVault, isCurrentVault]);

    /**
     * Take one vault off the recent list. Nothing on disk is touched: the list
     * only records what has been opened, so the folder stays where it is and
     * the row returns the next time that folder is opened as a vault.
     *
     * Reports whether the list was actually rewritten. An IndexedDB write can
     * fail (blocked storage, a corrupt store), and the row then stays put — the
     * menu has to be able to say so rather than leave a dead click behind.
     */
    const forgetRecentVault = useCallback(async (id: string) => {
        try {
            await publishVaults(await forgetVault(id), rootHandleRef.current);
            return true;
        } catch (err) {
            console.warn('Could not drop the vault from the recent list:', err);
            return false;
        }
    }, [publishVaults]);

    /**
     * Commit the app to `handle` as its vault, from a handle we already hold —
     * no picker, because the point of both callers (the recent list, and "Open
     * as Vault" on a folder in the tree) is not having to find the folder again.
     *
     * Permission is re-requested when Chrome has let the grant lapse (a new
     * session, usually); that call is legal here only because opening a vault
     * is always a click. A folder taken out of the tree is inside a vault whose
     * grant is live, so it answers 'granted' without prompting — asking is what
     * makes the one code path safe for a handle deserialized out of IndexedDB
     * too. Returns why it didn't happen when it didn't, so the caller can say so
     * instead of appearing to do nothing.
     */
    const openVaultHandle = useCallback(async (handle: FileSystemDirectoryHandle): Promise<VaultOpenResult> => {
        if (switchInFlightRef.current) return 'busy';
        switchInFlightRef.current = true;
        try {
            let permission = await handle.queryPermission({ mode: 'readwrite' });
            if (permission !== 'granted') {
                permission = await handle.requestPermission({ mode: 'readwrite' });
            }
            if (permission !== 'granted') return 'denied';

            // Already here. The menu marks the current vault and makes its row
            // inert, but that guard is by id and the id is absent whenever
            // recording the vault failed — and a stored handle is a different
            // OBJECT from the open one for the same folder, so letting it
            // through would read as a switch and close every tab.
            if (await isCurrentVault(handle)) return 'ok';

            // Touch the folder before committing the app to it: one that has
            // been deleted or moved since throws here, whereas swapping the
            // tree first would just blank the sidebar with no explanation. A
            // tree row can be that stale too — the folder may have gone on disk
            // since the last refreshTree.
            await handle.entries().next();

            // Walk the new vault BEFORE committing the app to it. Setting
            // `rootHandle` first and awaiting the walk after left the app split
            // for the whole walk — seconds on a big vault — with `rootHandle`,
            // IndexedDB and the header on the new vault while the sidebar still
            // listed the OLD one's rows. Nothing covers the tree in that window
            // (VaultMenu draws no overlay either), so a row clicked then opened
            // the old vault's handle under the new vault's path: autosave writes
            // through one vault while every path-keyed lookup resolves in the
            // other. It also means a failed walk has committed nothing at all —
            // it used to leave that same split state behind and report 'ok'.
            const tree = await loadTree(handle);
            if (!tree) return 'error';

            // The three setters are synchronous and in one task, so React
            // batches them into a single render: `rootHandle` and `fileTree`
            // cannot be observed describing different vaults.
            await set(IDB_KEY, handle);
            setPreviousVault(null);
            setRootHandle(handle);
            setFileTree(tree);
            await recordVault(handle);
            return 'ok';
        } catch (err) {
            if ((err as DOMException)?.name === 'NotFoundError') return 'missing';
            console.error('Could not open the vault:', err);
            return 'error';
        } finally {
            switchInFlightRef.current = false;
        }
    }, [loadTree, recordVault, isCurrentVault]);

    /**
     * Take the grant a linked vault still needs.
     *
     * Separate from `openRecentVault` only in that it clears the prompt: a link
     * whose vault has been opened is no longer pending. Called from a click,
     * which is the only context `requestPermission` is allowed to ask in.
     */
    const openLinkedVault = useCallback(async (): Promise<VaultOpenResult> => {
        if (!linkedVault) return 'denied';
        const result = await openVaultHandle(linkedVault.handle);
        if (result === 'ok') setLinkedVault(null);
        return result;
    }, [linkedVault, openVaultHandle]);

    /**
     * Switch to a vault the user has opened before, straight from its stored
     * handle. Everything but the recent list's own bookkeeping is
     * `openVaultHandle`.
     */
    const openRecentVault = useCallback(async (vault: RecentVault): Promise<VaultOpenResult> => {
        const result = await openVaultHandle(vault.handle);
        if (result === 'missing') {
            // The folder is gone; keeping a row that can never open again would
            // just be a trap.
            await forgetRecentVault(vault.id);
        }
        return result;
    }, [openVaultHandle, forgetRecentVault]);

    /**
     * Read the text content of a file handle. Line endings are normalized to
     * \n — CodeMirror normalizes its document the same way, so this keeps tab
     * buffers, saved output, and vault-search match offsets all in agreement
     * even for CRLF-authored files.
     */
    const readFile = useCallback(async (fileHandle: FileSystemFileHandle) => {
        const file = await fileHandle.getFile();
        return (await file.text()).replace(/\r\n?/g, '\n');
    }, []);

    /**
     * Write text content to a file handle.
     */
    const writeFile = useCallback(async (fileHandle: FileSystemFileHandle, content: string) => {
        const writable = await fileHandle.createWritable();
        await writable.write(content);
        await writable.close();
    }, []);

    /**
     * Read a file's raw bytes. Binary formats (PDFs) can't ride readFile():
     * decoding arbitrary bytes as UTF-8 and normalizing line endings corrupts
     * them irreversibly.
     */
    const readFileBytes = useCallback(async (fileHandle: FileSystemFileHandle) => {
        const file = await fileHandle.getFile();
        return new Uint8Array(await file.arrayBuffer());
    }, []);

    /** Write raw bytes to a file handle. */
    const writeFileBytes = useCallback(async (fileHandle: FileSystemFileHandle, bytes: Uint8Array) => {
        const writable = await fileHandle.createWritable();
        // Hand over the VIEW, not `.buffer`. write() takes a BufferSource and
        // honours a typed array's byteOffset/byteLength, so the view already
        // denotes exactly the right range — it is `.buffer` that would ignore
        // the view and write the whole underlying buffer. The defensive
        // .slice() this replaces copied the entire document (tens of MB for a
        // large annotated PDF) on every single save.
        //
        // The cast only rules out a SharedArrayBuffer-backed view, which write()
        // does not accept. Nothing in this app allocates one (the PDF bytes come
        // from a File read or a transferred worker buffer), and cross-origin
        // isolation — required before SharedArrayBuffer even exists — is off.
        await writable.write(bytes as Uint8Array<ArrayBuffer>);
        await writable.close();
    }, []);

    /**
     * Copy files dragged in from the OS into the vault, as-is.
     *
     * Writes the Blob straight through rather than going via text, so binaries
     * (PDFs, images) survive. Never overwrites: a colliding name gets " (1)",
     * " (2)", … appended, because a silent overwrite of someone's PDF is not a
     * recoverable mistake.
     *
     * Returns the names actually written.
     */
    const importFiles = useCallback(async (files: FileList | File[], targetDir: FileSystemDirectoryHandle) => {
        const written: string[] = [];
        for (const file of Array.from(files)) {
            // A dropped directory arrives as a File with no type and no size;
            // reading it throws. Skip rather than write a 0-byte stub.
            if (!file.size && !file.type) {
                try { await file.slice(0, 1).arrayBuffer(); } catch { continue; }
            }

            try {
                const name = await freeEntryName(targetDir, file.name);
                await copyFileInto(targetDir, name, file);
                written.push(name);
            } catch (err) {
                console.error(`Could not import "${file.name}":`, err);
            }
        }
        if (written.length) await refreshTree(rootHandle);
        return written;
    }, [rootHandle, refreshTree]);

    /**
     * Create a new file inside a directory handle.
     * Returns the new file handle.
     */
    const createFile = useCallback(async (parentDirHandle: FileSystemDirectoryHandle, fileName: string) => {
        const fileHandle = await parentDirHandle.getFileHandle(fileName, { create: true });
        // Write empty content to initialize
        const writable = await fileHandle.createWritable();
        await writable.write('');
        await writable.close();
        // Refresh the tree to reflect the new file
        await refreshTree(rootHandle);
        return fileHandle;
    }, [rootHandle, refreshTree]);

    /**
     * Create a new folder inside a directory handle.
     * Returns the new directory handle.
     */
    const createFolder = useCallback(async (parentDirHandle: FileSystemDirectoryHandle, folderName: string) => {
        const dirHandle = await parentDirHandle.getDirectoryHandle(folderName, { create: true });
        // Refresh the tree to reflect the new folder
        await refreshTree(rootHandle);
        return dirHandle;
    }, [rootHandle, refreshTree]);

    /**
     * Object URLs handed out by getAssetUrl, keyed by "<scope> <fileName>" and
     * validated by the file's (lastModified, size) — the same staleness signal
     * the vault-search index already trusts.
     *
     * Without this, every call minted a BRAND-NEW url and nothing ever revoked
     * one: an image re-resolved on every scroll-past and every widget rebuild,
     * so the blob registry grew without bound for the session. Worse, a fresh
     * URL is a fresh cache key, so Chrome could not reuse the decoded bitmap
     * and re-decoded the picture every time (and the widget visibly flashed
     * back through its "Loading …" placeholder).
     *
     * Reusing one URL per file VERSION makes growth bounded by the number of
     * distinct assets displayed, keeps the image cache warm, and still picks up
     * an externally-edited image because the (mtime, size) check replaces the
     * entry — revoking the old URL as it goes.
     */
    const assetUrlsRef = useRef<Map<string, { url: string; mtime: number; size: number }>>(new Map());

    /**
     * Vault-relative path of a directory handle, memoized per handle object.
     *
     * The cache key has to distinguish two folders that share a NAME but not a
     * location, or an asset in one could be served for the other. resolve() is
     * the only thing that answers that; the WeakMap keeps it to one call per
     * handle, and because it yields a stable PATH the url cache still hits
     * after refreshTree hands out fresh handle objects for the same folders.
     */
    const dirPathsRef = useRef<WeakMap<FileSystemDirectoryHandle, Promise<string>>>(new WeakMap());

    const dirPath = useCallback(async (dir: FileSystemDirectoryHandle) => {
        let p = dirPathsRef.current.get(dir);
        if (!p) {
            p = (rootHandle
                ? rootHandle.resolve(dir).then(segs => segs?.join('/') ?? `?${dir.name}`)
                : Promise.resolve(`?${dir.name}`)
            ).catch(() => `?${dir.name}`);
            dirPathsRef.current.set(dir, p);
        }
        return p;
    }, [rootHandle]);

    const assetUrlFor = useCallback(async (key: string, fileHandle: FileSystemFileHandle) => {
        const file = await fileHandle.getFile();       // a stat + handle, not a read
        const cached = assetUrlsRef.current.get(key);
        if (cached && cached.mtime === file.lastModified && cached.size === file.size) {
            return cached.url;
        }
        if (cached) URL.revokeObjectURL(cached.url);   // the file changed on disk
        const url = URL.createObjectURL(file);
        assetUrlsRef.current.set(key, { url, mtime: file.lastModified, size: file.size });
        return url;
    }, []);

    /**
     * Let go of every object URL minted for an asset under `path`.
     *
     * The cache is keyed by the asset's vault path (see assetUrlIn), so a
     * folder's own `.Assets` and every descendant's share its prefix. Called
     * when a folder is trashed, for the reason retireAsset revokes when a single
     * asset is: an entry that can never be served again is a pinned blob and a
     * cache key nothing will ever match.
     */
    const revokeAssetUrlsUnder = useCallback((path: string) => {
        const prefix = `${path}/`;
        for (const [key, cached] of assetUrlsRef.current) {
            if (!key.startsWith(prefix)) continue;
            URL.revokeObjectURL(cached.url);
            assetUrlsRef.current.delete(key);
        }
    }, []);

    // A different vault can reuse the same asset names — never serve the old
    // vault's bytes, and let its URLs go rather than pinning them for the session.
    useEffect(() => {
        const urls = assetUrlsRef.current;
        return () => {
            for (const { url } of urls.values()) URL.revokeObjectURL(url);
            urls.clear();
        };
    }, [rootHandle]);

    /** The url for `fileName` in THIS folder's .Assets, or null if it isn't there. */
    const assetUrlIn = useCallback(async (dir: FileSystemDirectoryHandle, fileName: string) => {
        try {
            const assetsDir = await dir.getDirectoryHandle(ASSETS_DIR);
            const fileHandle = await assetsDir.getFileHandle(fileName);
            // Scoped by the folder's vault path, so two folders holding an
            // identically-named asset never collide in the cache.
            return await assetUrlFor(`${joinVaultPath(await dirPath(dir), ASSETS_DIR)}/${fileName}`, fileHandle);
        } catch {
            return null;
        }
    }, [assetUrlFor, dirPath]);

    /**
     * Every folder between the vault root and `dir`, root first — derived by
     * descending from the root, because a handle knows its own name and nothing
     * above it. `dir` itself is excluded, as is everything when `dir` IS the
     * root or isn't inside it at all.
     */
    const ancestorsOf = useCallback(async (dir: FileSystemDirectoryHandle) => {
        if (!rootHandle) return [];
        let segs: string[] | null = null;
        try {
            segs = await rootHandle.resolve(dir);
        } catch {
            return [];
        }
        if (!segs || segs.length === 0) return [];

        const chain: FileSystemDirectoryHandle[] = [rootHandle];
        let cur = rootHandle;
        for (const seg of segs.slice(0, -1)) {       // stop short of `dir` itself
            try {
                cur = await cur.getDirectoryHandle(seg);
            } catch {
                break;
            }
            chain.push(cur);
        }
        return chain;
    }, [rootHandle]);

    /**
     * Resolve an embedded asset NAME to a displayable url.
     *
     * A note owns the `.Assets` folder beside it and no other, so that folder
     * is the only one the hot path consults: one directory lookup whatever the
     * vault's depth, and an image is never served out of a folder the note has
     * nothing to do with.
     *
     * The walk up the ancestors runs ONLY when that misses, and exists purely
     * for backwards compatibility. Assets landed in the VAULT ROOT's `.Assets`
     * before local ones existed, and still do for a document with no folder of
     * its own (the Help guide), so a vault carried forward can have pictures
     * sitting one or more folders above the note that shows them. Walking up
     * from the note is exact for that: an asset can only have been misplaced
     * ABOVE where it belongs — nothing ever wrote one sideways — so this
     * reaches every one of them without ever searching the vault.
     */
    const getAssetUrl = useCallback(async (fileName: string, parentDirHandle?: FileSystemDirectoryHandle | null) => {
        if (!isAssetName(fileName)) return null;
        const home = parentDirHandle || rootHandle;
        if (!home) return null;

        const local = await assetUrlIn(home, fileName);
        if (local) return local;

        // Nearest ancestor first: the closest copy is the one that note was
        // most likely written against.
        const ancestors = await ancestorsOf(home);
        for (let i = ancestors.length - 1; i >= 0; i--) {
            const url = await assetUrlIn(ancestors[i], fileName);
            if (url) return url;
        }
        return null;
    }, [rootHandle, assetUrlIn, ancestorsOf]);

    /**
     * Save a Blob into the `.Assets` folder BESIDE the note being edited,
     * creating it if this is the folder's first asset. Only a document with no
     * folder of its own (the Help guide) falls back to the vault root.
     */
    const saveAsset = useCallback(async (fileName: string, blob: Blob, parentDirHandle?: FileSystemDirectoryHandle | null) => {
        const targetDir = parentDirHandle || rootHandle;
        if (!targetDir) throw new Error('No vault open');

        let assetsDir;
        try {
            assetsDir = await targetDir.getDirectoryHandle(ASSETS_DIR, { create: true });
        } catch (err) {
            console.error('Could not create/access Assets folder:', err);
            throw err;
        }

        const fileHandle = await assetsDir.getFileHandle(fileName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();

        await refreshTree(rootHandle);
    }, [rootHandle, refreshTree]);

    /**
     * Move an asset out of a folder's `.Assets` and into its `.Garbage` — what
     * happens once the last note in that folder stops referring to it (see
     * App.reconcileAssets). Returns whether anything moved.
     *
     * Retired rather than erased, because unlike deleting a file this is not
     * something the user asked for in so many words: it follows from an edit,
     * with no confirmation between the two. The same folder's `.Garbage` is
     * where a deleted file goes, so recovering one by hand is the same motion
     * as recovering the other — and restoreAsset undoes it automatically when
     * the reference comes back.
     */
    const retireAsset = useCallback(async (fileName: string, dirHandle: FileSystemDirectoryHandle) => {
        if (!isAssetName(fileName)) return false;
        try {
            const assetsDir = await dirHandle.getDirectoryHandle(ASSETS_DIR);
            const source = await assetsDir.getFileHandle(fileName);   // throws => nothing to retire
            const file = await source.getFile();

            // Under its own name, not a free one: a retired asset has to be
            // findable again by the name the note used. Two assets that share a
            // name in one folder are the same picture (the second write replaced
            // the first in .Assets), so the newest bytes winning is right.
            const graveyard = await retiredAssetsDir(dirHandle, true);
            await copyFileInto(graveyard, fileName, file);
            await assetsDir.removeEntry(fileName);

            // The url cache pins a blob per file version; this one can't be
            // served again until the asset comes back (which re-mints it).
            const key = `${joinVaultPath(await dirPath(dirHandle), ASSETS_DIR)}/${fileName}`;
            const cached = assetUrlsRef.current.get(key);
            if (cached) {
                URL.revokeObjectURL(cached.url);
                assetUrlsRef.current.delete(key);
            }
            return true;
        } catch {
            return false;
        }
    }, [dirPath]);

    /**
     * Put a retired asset back into `.Assets` — the exact inverse of
     * retireAsset, for when the reference returns (an undo, or the same embed
     * pasted into a sibling note). Returns whether anything moved.
     *
     * Everything here is a miss in the ordinary case, so it opens with the
     * cheapest one: a folder that has never retired an asset has no
     * `.Garbage/.Assets` at all, and the lookup fails at the first step.
     */
    const restoreAsset = useCallback(async (fileName: string, dirHandle: FileSystemDirectoryHandle) => {
        if (!isAssetName(fileName)) return false;
        try {
            const graveyard = await retiredAssetsDir(dirHandle, false);
            const source = await graveyard.getFileHandle(fileName);   // throws => never retired
            const file = await source.getFile();

            // Only now is there anything to restore — and only now is creating
            // the folder's .Assets warranted.
            const assetsDir = await dirHandle.getDirectoryHandle(ASSETS_DIR, { create: true });
            try {
                await assetsDir.getFileHandle(fileName);
                return false;    // a live asset already holds the name; leave both alone
            } catch { /* free — take it back */ }

            await copyFileInto(assetsDir, fileName, file);
            await graveyard.removeEntry(fileName);
            return true;
        } catch {
            return false;
        }
    }, []);

    /**
     * Restore the previous vault by requesting permission with a user gesture
     */
    const restoreVault = useCallback(async () => {
        if (!previousVault) return;
        try {
            const permission = await previousVault.requestPermission({ mode: 'readwrite' });
            if (permission === 'granted') {
                setRootHandle(previousVault);
                setIsLoading(true);
                await recordVault(previousVault);
                await refreshTree(previousVault);
                setPreviousVault(null);
                setIsLoading(false);
            }
        } catch (err) {
            console.error('Error restoring vault permission:', err);
        }
    }, [previousVault, refreshTree, recordVault]);

    /**
     * Move a file — or a whole folder — into the Trash: the `.Garbage` folder
     * BESIDE it, not the vault's. A note deleted from `math/units` lands in
     * `math/units/.Garbage`; the folder `math/units` itself lands in
     * `math/.Garbage/units`, and only an entry at the vault root lands in the
     * root's.
     *
     * Where a deletion is recoverable from should follow the thing deleted, the
     * same way its `.Assets` do: the trash stays next to what it came out of, so
     * moving (or sharing, or archiving) a folder carries its history with it,
     * and two folders each holding a "notes.md" no longer pile their deletions
     * into one bucket at the top of the vault.
     *
     * A FOLDER GOES WHOLESALE, with everything under it — its notes, its
     * sub-folders, and its own `.Assets` and `.Garbage`. That last part is the
     * point rather than an oversight: the trashed copy is as self-contained as
     * the folder was, so recovering it by hand restores its pictures and its own
     * history along with its notes. There is no native move, so this is
     * copy-then-delete like every other move here (copyDirRecursive), which
     * means the copy is only ever as current as the DISK — App.handleTrash
     * flushes every affected buffer before calling this, precisely so that what
     * lands in the trash is what the reader last had rather than what was last
     * autosaved.
     *
     * IT EITHER HAPPENED OR IT DIDN'T — the copy is taken back out again on any
     * failure, which is `displaceInto`'s doing and documented there. Its
     * rollback can never run once the original is gone: `refreshTree` handles
     * its own errors, so `removeEntry` succeeding is the last thing that can
     * fail.
     */
    const moveToTrash = useCallback(async (node: FileTreeNode) => {
        if (!rootHandle || !node.parentHandle) return false;
        // The trash must never be nested inside itself, and a folder must never
        // be trashed into the bucket retired ASSETS are parked in — restoreAsset
        // would then be able to resurrect its bytes into a live `.Assets`.
        // Neither hidden folder is in the file tree, so nothing can ask for this
        // today; the guard is here because the failure if anything ever did is
        // copyDirRecursive walking into the copy it is making, without bound.
        if (node.kind === 'directory' && (node.name === TRASH_DIR || node.name === ASSETS_DIR)) return false;

        try {
            const trashDir = await node.parentHandle.getDirectoryHandle(TRASH_DIR, { create: true });
            await displaceInto(trashDir, node.parentHandle, node);
            // The pictures that folder held can only have been shown by notes
            // inside it (resolution never looks sideways or down), and those are
            // closed. A url that can never be displayed again is a pinned blob —
            // the same reason retireAsset revokes.
            if (node.kind === 'directory') revokeAssetUrlsUnder(node.path);
            await refreshTree(rootHandle);
            return true;
        } catch (err) {
            console.error('Failed to move item to trash:', err);
            return false;
        }
    }, [rootHandle, refreshTree, revokeAssetUrlsUnder]);

    /**
     * Everything trashed anywhere in this vault, newest deletion first — the
     * bin's root list. Built fresh on every call; see the crawl above for why
     * there is deliberately no cache and what the flattening rules are.
     */
    const listTrash = useCallback(async (): Promise<TrashItem[]> => {
        if (!rootHandle) return [];
        const out: TrashItem[] = [];
        await walkForTrash(rootHandle, '', out);
        return sortTrashRoot(out);
    }, [rootHandle]);

    /**
     * Put one item back where the `.Garbage` holding it sits — `item.restorePath`,
     * which the crawl set to the parent of the OUTERMOST `.Garbage` on its path.
     * A file three folders deep inside something that was deleted as a unit
     * therefore comes back flat, beside that `.Garbage`, rather than under a
     * recreation of an ancestry the reader no longer has.
     *
     * Structurally `moveToTrash` in reverse, and deliberately NOT `moveFile` /
     * `renameFile`: those are the documented `freeEntryName` exceptions, so a
     * file put back onto a taken name would silently truncate the live file and
     * a folder would silently merge into the live one — neither with a rollback.
     * Here a taken name is reported ('collision') with nothing touched, and
     * answered by the caller.
     *
     * 'replace' DISPLACES rather than erases: the entry standing in the way is
     * moved into that folder's own `.Garbage` first (a retired picture into its
     * `.Garbage/.Assets`, which is where a retired picture lives) and handed
     * back, so the bin can list it. Nothing the user made is destroyed outright
     * — deleteFromTrash is the one call in here that does that, and only when
     * asked in so many words.
     */
    const restoreFromTrash = useCallback(async (item: TrashItem, mode: TrashRestoreMode): Promise<TrashRestoreResult> => {
        if (!rootHandle) return { status: 'error' };
        // Mirrors moveToTrash's guard, and is unreachable for the same reason:
        // the crawl lists neither hidden folder as an item. If it ever were
        // reached, the failure is copyDirRecursive walking into its own copy.
        if (!isAssetName(item.name)) return { status: 'error' };
        if (item.kind === 'directory' && (item.name === TRASH_DIR || item.name === ASSETS_DIR)) return { status: 'error' };

        // What this call has written at the destination, so a failure can take
        // it back out — the same record-before-the-first-byte rule displaceInto
        // keeps, for the same reason.
        let wrote: { dir: FileSystemDirectoryHandle; name: string } | null = null;

        try {
            const home = item.restoreDirHandle;
            // A retired picture goes back into `.Assets`. Probed rather than
            // created, cheapest miss first (restoreAsset's shape): a folder with
            // no `.Assets` at all cannot have a colliding name, and creating one
            // here would leave an empty folder behind if the reader then
            // cancelled at the collision question.
            let destDir: FileSystemDirectoryHandle | null = home;
            if (item.origin === 'retired') {
                try {
                    destDir = await home.getDirectoryHandle(ASSETS_DIR);
                } catch {
                    destDir = null;
                }
            }

            const taken = destDir ? await entryExists(destDir, item.name) : false;
            if (taken && mode === 'auto') return { status: 'collision' };

            let displaced: TrashItem | undefined;
            if (taken && destDir && mode === 'replace') {
                const live = await liveEntry(destDir, item.name);
                if (!live) return { status: 'error' };
                // A displaced picture is a RETIRED picture: it belongs in the
                // bucket retireAsset uses, not beside the trashed notes, or
                // putting it back later would land it outside `.Assets`.
                const bucket = item.origin === 'retired'
                    ? await retiredAssetsDir(home, true)
                    : await destDir.getDirectoryHandle(TRASH_DIR, { create: true });
                const bucketPath = item.origin === 'retired'
                    ? joinVaultPath(joinVaultPath(item.restorePath, TRASH_DIR), ASSETS_DIR)
                    : joinVaultPath(item.restorePath, TRASH_DIR);
                const filedAs = await displaceInto(bucket, destDir, live);
                // Same reason moveToTrash revokes: the pictures a displaced
                // FOLDER held can only have been shown by notes inside it, and
                // App has just closed those — a url nothing can display again is
                // a pinned blob.
                if (live.kind === 'directory') revokeAssetUrlsUnder(joinVaultPath(item.restorePath, item.name));
                displaced = await describeDisplaced(
                    bucket, bucketPath, filedAs, live.kind, item.origin, home, item.restorePath);
            }

            const finalName = taken && destDir && mode === 'keep-both'
                ? await freeEntryName(destDir, item.name, item.kind)
                : item.name;

            // Only now is there anything to restore, and only now is creating
            // the folder's `.Assets` warranted.
            if (!destDir) {
                destDir = await home.getDirectoryHandle(ASSETS_DIR, { create: true });
                // The probe above read a MISSING `.Assets` as "no collision is
                // possible", which is the one path here where a name was never
                // certified free — and if the create-lookup hands back a folder
                // that does exist after all (the no-create read failed for some
                // other reason, or something outside this tab made it in the
                // meantime), copyFileInto's `getFileHandle(create: true)` would
                // open-or-TRUNCATE whatever is standing there. Ask again now
                // that the real directory is in hand.
                if (await entryExists(destDir, finalName)) return { status: 'collision' };
            }

            wrote = { dir: destDir, name: finalName };
            if (item.kind === 'file') {
                await copyFileInto(destDir, finalName, await (item.handle as FileSystemFileHandle).getFile());
            } else {
                const copy = await destDir.getDirectoryHandle(finalName, { create: true });
                await copyDirRecursive(item.handle as FileSystemDirectoryHandle, copy);
            }

            await item.parentHandle.removeEntry(item.name, { recursive: item.kind === 'directory' });
            await refreshTree(rootHandle);
            return { status: 'ok', name: finalName, displaced };
        } catch (err) {
            console.error('Failed to put the item back:', err);
            if (wrote) {
                try {
                    await wrote.dir.removeEntry(wrote.name, { recursive: item.kind === 'directory' });
                } catch (undoErr) {
                    console.error('Could not remove the abandoned restored copy:', undoErr);
                }
            }
            // A 'replace' that displaced something and THEN failed to copy
            // leaves that entry in the trash rather than putting it back: it is
            // one more row in the bin, one click from home, which is a better
            // failure than a second copy-and-delete run to undo the first while
            // the disk is already refusing writes. Nothing is lost either way.
            return { status: 'error' };
        }
    }, [rootHandle, refreshTree, revokeAssetUrlsUnder]);

    /**
     * Erase one item from the trash for good. With `emptyTrash`, the only thing
     * in this app that destroys something the user made with no copy left
     * anywhere — which is why both are behind a question App words plainly.
     *
     * No `refreshTree`: nothing inside a `.Garbage` is in the file tree.
     */
    const deleteFromTrash = useCallback(async (item: TrashItem) => {
        if (!isAssetName(item.name)) return false;
        // The same refusal restoreFromTrash keeps, and it belongs here more than
        // there: this one is `removeEntry(..., { recursive: true })`, so an item
        // that ever leaked a `.Garbage`/`.Assets` name would erase a whole
        // bucket rather than the thing the reader pointed at. Unreachable today
        // — the crawl diverts both names before it builds an item.
        if (item.kind === 'directory' && (item.name === TRASH_DIR || item.name === ASSETS_DIR)) return false;
        try {
            await item.parentHandle.removeEntry(item.name, { recursive: item.kind === 'directory' });
            return true;
        } catch (err) {
            console.error('Failed to delete the item for good:', err);
            return false;
        }
    }, []);

    /**
     * Remove every `.Garbage` in the vault, retired pictures and all. Returns
     * how many folders were removed AND how many refused.
     *
     * Each removal is its own try/catch, so one folder held open by something
     * else does not cost the reader the rest of the emptying — and the names
     * are collected before anything is removed, because removing entries while
     * an `entries()` iterator is walking them is not something the API
     * promises anything about. `failed` is what keeps that tolerance honest: a
     * caller that saw only the count would empty the panel's list and say the
     * bin was emptied while the folders that refused still held their files.
     */
    const emptyTrash = useCallback(async () => {
        if (!rootHandle) return { removed: 0, failed: 0 };
        let removed = 0;
        let failed = 0;

        const sweep = async (dir: FileSystemDirectoryHandle): Promise<void> => {
            const live: FileSystemDirectoryHandle[] = [];
            let hasTrash = false;
            try {
                for await (const [name, handle] of dir.entries()) {
                    if (handle.kind !== 'directory' || !isAssetName(name)) continue;
                    if (name === ASSETS_DIR) continue;
                    if (name === TRASH_DIR) { hasTrash = true; continue; }
                    live.push(handle);
                }
            } catch (err) {
                console.warn('Could not read a folder while emptying the trash:', err);
                // Unread, so unknown: counted as a failure rather than passed
                // over, since a `.Garbage` it holds is still on disk either way.
                failed++;
                return;
            }

            if (hasTrash) {
                try {
                    await dir.removeEntry(TRASH_DIR, { recursive: true });
                    removed++;
                } catch (err) {
                    console.error('Could not empty the trash in', dir.name, err);
                    failed++;
                }
            }
            for (const sub of live) await sweep(sub);
        };

        await sweep(rootHandle);
        return { removed, failed };
    }, [rootHandle]);

    /**
     * Move a file from its current parent to a target directory handle.
     */
    const moveFile = useCallback(async (sourceNode: FileTreeNode, targetDirHandle: FileSystemDirectoryHandle) => {
        if (!sourceNode.parentHandle || !targetDirHandle) return false;
        // Don't move into the same folder
        if (sourceNode.parentHandle === targetDirHandle) return false;

        try {
            if (sourceNode.kind === 'file') {
                // Copy file content to target
                const file = await sourceNode.handle.getFile();
                const newHandle = await targetDirHandle.getFileHandle(sourceNode.name, { create: true });
                const writable = await newHandle.createWritable();
                await writable.write(file);
                await writable.close();
            } else {
                // For folders: create in target and recursively copy contents
                const newDir = await targetDirHandle.getDirectoryHandle(sourceNode.name, { create: true });
                await copyDirRecursive(sourceNode.handle, newDir);
            }

            // Remove original
            await sourceNode.parentHandle.removeEntry(sourceNode.name, { recursive: sourceNode.kind === 'directory' });
            await refreshTree(rootHandle);
            return true;
        } catch (err) {
            console.error('Failed to move item:', err);
            return false;
        }
    }, [rootHandle, refreshTree]);

    /**
     * Rename a file or folder within its parent directory.
     */
    const renameFile = useCallback(async (sourceNode: FileTreeNode, newName: string) => {
        if (!sourceNode.parentHandle || !newName) return false;
        if (sourceNode.name === newName) return true; // No change

        try {
            if (sourceNode.kind === 'file') {
                // Copy file content to a new file with the new name
                const file = await sourceNode.handle.getFile();
                const newHandle = await sourceNode.parentHandle.getFileHandle(newName, { create: true });
                const writable = await newHandle.createWritable();
                await writable.write(file);
                await writable.close();
            } else {
                // For folders: create a new folder and recursively copy contents
                const newDir = await sourceNode.parentHandle.getDirectoryHandle(newName, { create: true });
                await copyDirRecursive(sourceNode.handle, newDir);
            }

            // Remove original
            await sourceNode.parentHandle.removeEntry(sourceNode.name, { recursive: sourceNode.kind === 'directory' });
            await refreshTree(rootHandle);
            return true;
        } catch (err) {
            console.error('Failed to rename item:', err);
            return false;
        }
    }, [rootHandle, refreshTree]);

    const value: FileSystemContextValue = {
        rootHandle,
        fileTree,
        isLoading,
        previousVault,
        linkedVault,
        recentVaults,
        currentVaultId,
        pickDirectory,
        openRecentVault,
        // Open a folder that is already inside the open vault as a vault of its
        // own — the file tree's "Open as Vault" row. A vault is just a folder,
        // so this is exactly what picking that folder in the OS picker does,
        // minus the picker: the handle is in hand, so showing one would only ask
        // the user to find the folder they have just right-clicked. It lands in
        // the recent list like any other opened vault (recordVault, inside).
        openFolderAsVault: openVaultHandle,
        openLinkedVault,
        forgetRecentVault,
        readFile,
        writeFile,
        readFileBytes,
        writeFileBytes,
        importFiles,
        createFile,
        createFolder,
        getAssetUrl,
        saveAsset,
        retireAsset,
        restoreAsset,
        restoreVault,
        moveToTrash,
        listTrash,
        restoreFromTrash,
        deleteFromTrash,
        emptyTrash,
        moveFile,
        renameFile,
    };

    return (
        <FileSystemContext.Provider value={value}>
            {children}
        </FileSystemContext.Provider>
    );
}

export function useFileSystem(): FileSystemContextValue {
    const context = useContext(FileSystemContext);
    if (!context) {
        throw new Error('useFileSystem must be used within a FileSystemProvider');
    }
    return context;
}
