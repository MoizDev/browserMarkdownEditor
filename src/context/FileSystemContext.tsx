import { decodeDocumentText } from '../utils/diskVersion';
import { fingerprintSnapshot } from '../utils/snapshotFingerprint';
import { beginForegroundRead } from './vaultIndex/foreground';
import type { ReadOnlyFileSnapshot } from '../types/reading';
import React, { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import { get, set } from 'idb-keyval';
import { forgetVault, labelVaults, loadRecentVaults, rememberVault, setVaultPinned, withVaultPaths } from './recentVaults';
import { ensureVaultId } from './agentVault';
import { requestPersistentStorage } from '../utils/storagePersistence';
import { forgetRecoveryVault } from '../utils/recoveryJournal';
import { findLinkedVault, readLocation } from '../utils/appUrl';
import { ASSETS_DIR, TRASH_DIR, isAssetName } from '../utils/assets';
import { joinVaultPath, parentVaultPath } from '../utils/paths';
import { perfRoot, reportVault } from '../utils/perfHooks';
import { sortTrashChildren, sortTrashRoot } from '../utils/trash';
import { ENTRY_STYLE_FILE } from '../utils/entryStyle';
import { Limiter } from '../utils/pool';
import { beginStartup, finishStartup, startupStep, startupWalk, type WalkProgress } from '../utils/startupProgress';
import { byteReadMs, withinFileDeadline } from '../utils/fileReadDeadline';
import { isGitName, isHiddenEntryName } from '../utils/vaultEntries';
import { findDirNode, shareTree, spliceDir } from '../utils/treeShare';
import { hashBytes, sameStat } from '../utils/diskVersion';
import type { DiskStat, DiskVersion } from '../utils/diskVersion';
import {
    MAX_DIRTY_DIRS, createBatchCoalescer, dirtyDirs, mergeInto, normalizeRecords, rescanBatch, touchedPaths,
} from '../utils/vaultChanges';
import type { VaultChangeBatch } from '../utils/vaultChanges';
import type {
    FileTreeNode, FileSystemContextValue, RecentVault, StoredVault, VaultOpenResult, VaultProblem,
    TrashItem, TrashRestoreMode, TrashRestoreResult, VersionedWriteResult, BoardAssetAccess, BoardOwnerAccess,
} from '../types';

const FileSystemContext = createContext<FileSystemContextValue | null>(null);

const IDB_KEY = 'vault-directory-handle';

const handleIO: FileSystemContextValue['handleIO'] = {
    file: handle => handle.getFile(),
    fileIn: (dir, name, create = false) => dir.getFileHandle(name, { create }),
    dirIn: (dir, name, create = false) => dir.getDirectoryHandle(name, { create }),
    entries: dir => dir.entries(),
    remove: (dir, name) => dir.removeEntry(name),
    relativeTo: (dir, handle) => dir.resolve(handle),
    sameEntry: (a, b) => a.isSameEntry(b),
};

async function resolveVaultDir(root: FileSystemDirectoryHandle, path: string): Promise<FileSystemDirectoryHandle> {
    let dir = root;
    if (path) for (const segment of path.split('/')) dir = await dir.getDirectoryHandle(segment);
    return dir;
}

async function resolveVaultFile(root: FileSystemDirectoryHandle, path: string) {
    const segments = path.split('/');
    const name = segments.pop()!;
    const parentHandle = await resolveVaultDir(root, segments.join('/'));
    return { handle: await parentHandle.getFileHandle(name), parentHandle };
}

async function verifyVaultFileIdentity(root: FileSystemDirectoryHandle, path: string, handle: FileSystemFileHandle): Promise<boolean> {
    if (!path || path.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\\') || part.includes('\0'))) return false;
    try { return await (await resolveVaultFile(root, path)).handle.isSameEntry(handle); }
    catch (error) {
        if (error instanceof DOMException && error.name === 'NotFoundError') return false;
        throw error;
    }
}

async function vaultDirExists(root: FileSystemDirectoryHandle, path: string): Promise<boolean> {
    try { await resolveVaultDir(root, path); return true; } catch { return false; }
}

async function entryExists(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
    try { await dir.getFileHandle(name); return true; } catch { /* not a file here */ }
    try { await dir.getDirectoryHandle(name); return true; } catch { /* nor a directory */ }
    return false;
}

async function liveEntry(
    dir: FileSystemDirectoryHandle,
    name: string,
): Promise<{ name: string; kind: 'file' | 'directory'; handle: FileSystemFileHandle | FileSystemDirectoryHandle } | null> {
    try { return { name, kind: 'directory', handle: await dir.getDirectoryHandle(name) }; } catch { /* not a directory */ }
    try { return { name, kind: 'file', handle: await dir.getFileHandle(name) }; } catch { /* nor a file */ }
    return null;
}

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

async function retireUnusedPicture(dir: FileSystemDirectoryHandle, name: string): Promise<void> {
    const assets = await dir.getDirectoryHandle(ASSETS_DIR);
    const file = await (await assets.getFileHandle(name)).getFile();
    await copyFileInto(await retiredAssetsDir(dir, true), name, file);
    await assets.removeEntry(name);
}

async function copyFileInto(dir: FileSystemDirectoryHandle, name: string, file: File): Promise<void> {
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(file);
    await writable.close();
}

async function retiredAssetsDir(dir: FileSystemDirectoryHandle, create: boolean): Promise<FileSystemDirectoryHandle> {
    const trash = await dir.getDirectoryHandle(TRASH_DIR, { create });
    return trash.getDirectoryHandle(ASSETS_DIR, { create });
}

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

async function displaceInto(
    bucket: FileSystemDirectoryHandle,
    dir: FileSystemDirectoryHandle,
    entry: { name: string; kind: 'file' | 'directory'; handle: FileSystemFileHandle | FileSystemDirectoryHandle },
    benchmark?: { path: string; bucketPath: string; opens: number | undefined; caller: string },
): Promise<string> {
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

        if (__BME_BENCH__) {
            try {
                if (benchmark?.opens !== undefined) reportVault({ op: 'trash-done', opens: benchmark.opens, path: benchmark.path, to: joinVaultPath(benchmark.bucketPath, name), caller: benchmark.caller });
            } catch { /* instrumentation must never interrupt a file operation */ }
        }
        await dir.removeEntry(entry.name, { recursive: entry.kind === 'directory' });
        return name;
    } catch (err) {
        if (wrote) {
            try {
                await wrote.dir.removeEntry(wrote.name, { recursive: entry.kind === 'directory' });
            } catch (undoErr) {
                console.error('Could not remove the abandoned copy:', undoErr);
            }
        }
        throw err;
    }
}

async function buildFileTree(
    dirHandle: FileSystemDirectoryHandle,
    path = '',
    reuse?: ReadonlyMap<string, FileTreeNode>,
    progress?: WalkProgress,
): Promise<FileTreeNode[]> {
    return (await listDir(dirHandle, path, reuse, new Limiter(WALK_CONCURRENCY), progress)).children;
}

function describeError(error: unknown): string {
    if (!(error instanceof Error) || !error.message) return String(error);
    return error.name && error.name !== 'Error' ? `${error.name}: ${error.message}` : error.message;
}

export class FolderReadError extends Error {
    readonly folder: string;
    constructor(folder: string, cause: unknown) {
        super(`${folder || 'The vault folder'}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
        this.name = 'FolderReadError';
        this.folder = folder;
    }
}

const treeNameCollator = new Intl.Collator(undefined, { sensitivity: 'base' });

async function listDir(
    dirHandle: FileSystemDirectoryHandle,
    path = '',
    reuse?: ReadonlyMap<string, FileTreeNode>,
    limiter: Limiter = new Limiter(WALK_CONCURRENCY),
    progress?: WalkProgress,
): Promise<{ children: FileTreeNode[]; styleFile?: FileSystemFileHandle }> {
    const children: FileTreeNode[] = [];
    let styleFile: FileSystemFileHandle | undefined;
    // A permit covers only this directory's enumeration, NEVER its children.
    // Measured: twelve parents held all twelve slots while their children
    // waited, leaving a small finite vault stuck with zero active native IO.
    // The root takes a permit too; descent begins only after it is released.
    const subdirs: { index: number; name: string; handle: FileSystemDirectoryHandle; path: string }[] = [];

    await limiter.run(async () => {
        progress?.begin(path);
        let files = 0;
        try {
            for await (const [name, handle] of dirHandle.entries()) {
                progress?.seen(path);
                if (name === ENTRY_STYLE_FILE && handle.kind === 'file') styleFile = handle;
                if (isHiddenEntryName(name, !path, handle.kind)) continue;

                const entryPath = path ? `${path}/${name}` : name;

                if (handle.kind === 'directory') {
                    const kept = reuse?.get(name);
                    if (kept && kept.kind === 'directory') {
                        children.push(kept);
                        continue;
                    }
                    subdirs.push({ index: children.length, name, handle, path: entryPath });
                    children.push(null as unknown as FileTreeNode);
                } else {
                    files++;
                    children.push({
                        name,
                        kind: 'file',
                        path: entryPath,
                        handle,
                        parentHandle: dirHandle,
                    });
                }
            }
        } catch (error) {
            throw new FolderReadError(path, error);
        }
        progress?.end(path, files);
    });

    await Promise.all(subdirs.map(async dir => {
        const sub = await listDir(dir.handle, dir.path, undefined, limiter, progress);
        children[dir.index] = {
            name: dir.name,
            kind: 'directory',
            path: dir.path,
            handle: dir.handle,
            parentHandle: dirHandle,
            children: sub.children,
            styleFile: sub.styleFile,
        };
    }));

    children.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
        return treeNameCollator.compare(a.name, b.name);
    });

    return { children, styleFile };
}

async function statForTrash(handle: FileSystemFileHandle): Promise<{ mtime: number; size: number }> {
    try {
        const file = await handle.getFile();
        return { mtime: file.lastModified, size: file.size };
    } catch {
        return { mtime: 0, size: 0 };
    }
}

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
            const { mtime, size } = await statForTrash(handle);
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
                if (name === TRASH_DIR) {
                    await collectGarbage(handle, sourcePath, ownerDir, ownerPath, out);
                    continue;
                }
                out.push(await buildTrashedDir(handle, sourcePath, garbageDir, ownerDir, ownerPath, out));
                continue;
            }

            const { mtime, size } = await statForTrash(handle);
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

async function measureLiveAssets(assetsDir: FileSystemDirectoryHandle): Promise<{ newest: number; size: number }> {
    let newest = 0;
    let size = 0;
    try {
        for await (const [name, handle] of assetsDir.entries()) {
            if (handle.kind !== 'file' || name === '.DS_Store') continue;
            const stat = await statForTrash(handle);
            newest = Math.max(newest, stat.mtime);
            size += stat.size;
        }
    } catch (err) {
        console.warn('Could not measure a trashed folder’s pictures:', err);
    }
    return { newest, size };
}

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

            const stat = await statForTrash(handle);
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
            const { mtime, size } = await statForTrash(handle);
            return {
                id: sourcePath, name, kind: 'file', origin, sourcePath,
                handle, parentHandle: bucket,
                restorePath: ownerPath, restoreDirHandle: ownerDir,
                deletedAt: mtime || Date.now(), size,
            };
        }
        const handle = await bucket.getDirectoryHandle(name);
        const hoisted: TrashItem[] = [];
        return await buildTrashedDir(handle, sourcePath, bucket, ownerDir, ownerPath, hoisted);
    } catch (err) {
        console.warn('Could not describe the displaced entry at', sourcePath, err);
        return undefined;
    }
}

async function walkForTrash(dir: FileSystemDirectoryHandle, path: string, out: TrashItem[]): Promise<void> {
    try {
        for await (const [name, handle] of dir.entries()) {
            if (handle.kind !== 'directory' || !isAssetName(name)) continue;
            if (name === ASSETS_DIR) continue;
            if (isGitName(name)) continue;
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

async function menuVaults(list: StoredVault[], root?: FileSystemDirectoryHandle | null): Promise<RecentVault[]> {
    const labelled = await labelVaults(list);
    return root ? withVaultPaths(labelled, root) : labelled;
}

function untilAborted<T>(job: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('Board asset request cancelled', 'AbortError'));
    return new Promise<T>((resolve, reject) => {
        const abort = () => reject(signal.reason ?? new DOMException('Board asset request cancelled', 'AbortError'));
        signal.addEventListener('abort', abort, { once: true });
        job.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
}

function isNotFound(err: unknown): boolean {
    return (err as DOMException | undefined)?.name === 'NotFoundError';
}

function isGone(err: unknown): boolean {
    const name = (err as DOMException | undefined)?.name;
    return name === 'NotFoundError' || name === 'TypeMismatchError';
}

async function readSnapshot(handle: FileSystemFileHandle): Promise<{ file: File; buf: ArrayBuffer }> {
    for (let attempt = 0; ; attempt++) {
        try {
            const file = await withinFileDeadline(handle.getFile(), handle.name);
            return { file, buf: await withinFileDeadline(file.arrayBuffer(), handle.name, byteReadMs(file.size)) };
        } catch (err) {
            if (attempt === 0 && (err as DOMException | undefined)?.name === 'NotReadableError') continue;
            throw err;
        }
    }
}

async function versionOfSnapshot(file: File, buf: ArrayBuffer): Promise<DiskVersion> {
    return { lastModified: file.lastModified, size: file.size, hash: await hashBytes(buf) };
}

/** `{lastModified, size}` from a metadata-only `getFile()`; null when the file
 *  is gone. Any other failure (a lock, a permission lapse) is NOT "deleted" and
 *  is thrown: calling a locked file deleted would tell the user their note was
 *  removed. */
async function statOf(handle: FileSystemFileHandle): Promise<DiskStat | null> {
    try {
        const file = await handle.getFile();
        return { lastModified: file.lastModified, size: file.size };
    } catch (err) {
        if (isGone(err)) return null;
        throw err;
    }
}

function toBytes(data: string | Uint8Array): Uint8Array {
    return typeof data === 'string' ? new TextEncoder().encode(data) : data;
}

async function writeAllBytes(handle: FileSystemFileHandle, bytes: Uint8Array | Blob): Promise<void> {
    const writable = await handle.createWritable();
    await writable.write(bytes instanceof Blob ? bytes : bytes as Uint8Array<ArrayBuffer>);
    await writable.close();
}

async function versionAfterWrite(handle: FileSystemFileHandle, bytes: Uint8Array | Blob): Promise<DiskVersion> {
    const hash = bytes instanceof Blob
        ? bytes.size > 32 * 1024 * 1024 ? await fingerprintSnapshot(bytes) : await hashBytes(await bytes.arrayBuffer())
        : await hashBytes(bytes);
    let stat: DiskStat | null = null;
    try { stat = await statOf(handle); } catch { /* fall through to the forced-recheck stat */ }
    return { lastModified: stat?.lastModified ?? 0, size: stat?.size ?? (bytes instanceof Blob ? bytes.size : bytes.byteLength), hash };
}

function conflictName(name: string, n: number): string {
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    return `${stem} (conflict${n === 1 ? '' : ` ${n}`})${ext}`;
}

async function ensureDirChain(root: FileSystemDirectoryHandle, path: string): Promise<{ dir: FileSystemDirectoryHandle; patchFrom: string | null }> {
    let dir = root;
    let dirPath = '';
    let patchFrom: string | null = null;
    if (path) for (const name of path.split('/')) {
        try {
            dir = await dir.getDirectoryHandle(name);
        } catch (err) {
            if (!isNotFound(err)) throw err;
            if (patchFrom === null) patchFrom = dirPath;
            dir = await dir.getDirectoryHandle(name, { create: true });
        }
        dirPath = joinVaultPath(dirPath, name);
    }
    return { dir, patchFrom };
}

async function relistDirs(
    base: FileTreeNode[],
    root: FileSystemDirectoryHandle,
    dirs: Iterable<string>,
    touched: ReadonlySet<string>,
): Promise<FileTreeNode[] | null> {
    const depth = (d: string) => (d ? d.split('/').length : 0);
    const ordered = [...dirs].sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : 1));
    const walkedAfresh: string[] = [];
    let tree = base;

    for (const dir of ordered) {
        if (walkedAfresh.some(f => dir === f || dir.startsWith(`${f}/`))) continue;
        const node = dir ? findDirNode(tree, dir) : null;
        if (dir && !node) continue;

        const old = node ? node.children : tree;
        const keep = new Map<string, FileTreeNode>();
        for (const c of old) if (c.kind === 'directory' && !touched.has(c.path)) keep.set(c.name, c);

        let children: FileTreeNode[];
        try {
            children = await buildFileTree(node ? node.handle : root, dir, keep);
        } catch {
            return null;
        }
        for (const c of children) if (c.kind === 'directory' && keep.get(c.name) !== c) walkedAfresh.push(c.path);
        tree = spliceDir(tree, dir, children);
    }
    return tree;
}

const WALK_CONCURRENCY = 12;

const RECORD_WAIT_MS = 4000;
const LABEL_WAIT_MS = 1500;

const POLL_THROTTLE_MS = 3000;
const POLL_INTERVAL_MS = 15000;
const REOBSERVE_DELAY_MS = 1000;

export function FileSystemProvider({ children }: { children: ReactNode }) {
    const [rootHandle, setRootHandle] = useState<FileSystemDirectoryHandle | null>(null);
    const [fileTree, setFileTree] = useState<FileTreeNode[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [vaultProblem, setVaultProblem] = useState<VaultProblem | null>(null);
    const startupRef = useRef(0);
    const [previousVault, setPreviousVault] = useState<FileSystemDirectoryHandle | null>(null);
    const [linkedVault, setLinkedVault] = useState<RecentVault | null>(null);
    const [recentVaults, setRecentVaults] = useState<RecentVault[]>([]);
    const [currentVaultId, setCurrentVaultId] = useState<string | null>(null);

    const rootHandleRef = useRef<FileSystemDirectoryHandle | null>(null);
    const vaultActivationRef = useRef(0);
    const getVaultActivation = useCallback(() => vaultActivationRef.current, []);
    const requestIndexPermission = useCallback(async (root: FileSystemDirectoryHandle, activation: number) => {
        if (rootHandleRef.current !== root || vaultActivationRef.current !== activation) return false;
        try {
            const permission = await root.requestPermission({ mode: 'readwrite' });
            return permission === 'granted' && rootHandleRef.current === root && vaultActivationRef.current === activation;
        } catch { return false; }
    }, []);
    const commitRoot = useCallback((handle: FileSystemDirectoryHandle | null) => {
        if (rootHandleRef.current !== handle) {
            vaultActivationRef.current++;
            // A new index must never adopt the outgoing tree while its walk is pending.
            // The ticket fence also rejects an old A walk after returning to A.
            treePublishedRef.current = ++treeTicketRef.current;
            fileTreeRef.current = [];
            treeOwnerRef.current = null;
            setFileTree([]);
        }
        rootHandleRef.current = handle;
        setRootHandle(handle);
    }, []);

    const fileTreeRef = useRef<FileTreeNode[]>([]);
    const treeOwnerRef = useRef<FileSystemDirectoryHandle | null>(null);
    useEffect(() => {
        if (__BME_BENCH__) {
            try {
                perfRoot().tree = {
                    paths: () => {
                        try {
                            const paths: string[] = [];
                            const visit = (nodes: FileTreeNode[]) => {
                                for (const node of nodes) {
                                    paths.push(node.path);
                                    if (node.kind === 'directory') visit(node.children);
                                }
                            };
                            visit(fileTreeRef.current);
                            return paths.sort();
                        } catch { return []; }
                    },
                };
            } catch { /* instrumentation must never interrupt the provider */ }
        }
    }, []);
    const commitTree = useCallback((tree: FileTreeNode[], owner: FileSystemDirectoryHandle) => {
        fileTreeRef.current = tree;
        treeOwnerRef.current = owner;
        setFileTree(tree);
    }, []);

    const treeTicketRef = useRef(0);
    const treePublishedRef = useRef(0);

    const mutationBusyRef = useRef(0);
    const resumeWatcherRef = useRef<(() => void) | null>(null);
    const withMutation = useCallback(async <T,>(run: () => Promise<T>): Promise<T> => {
        mutationBusyRef.current++;
        try {
            return await run();
        } finally {
            if (--mutationBusyRef.current === 0) resumeWatcherRef.current?.();
        }
    }, []);

    const vaultChangeListenersRef = useRef(new Set<(batch: VaultChangeBatch) => void>());
    const subscribeVaultChanges = useCallback((listener: (batch: VaultChangeBatch) => void) => {
        vaultChangeListenersRef.current.add(listener);
        return () => { vaultChangeListenersRef.current.delete(listener); };
    }, []);
    const [liveDetection, setLiveDetection] = useState<'observer' | 'polling' | 'off'>('off');

    const pickerOpenRef = useRef(false);

    const switchInFlightRef = useRef(false);
    const beforeRootChangeRef = useRef<(() => Promise<void>) | null>(null);
    const registerBeforeRootChange = useCallback((callback: () => Promise<void>) => {
        beforeRootChangeRef.current = callback;
        return () => { if (beforeRootChangeRef.current === callback) beforeRootChangeRef.current = null; };
    }, []);

    const isCurrentVault = useCallback(async (handle: FileSystemDirectoryHandle) => {
        const current = rootHandleRef.current;
        if (!current) return false;
        try {
            return await current.isSameEntry(handle);
        } catch {
            return false;
        }
    }, []);

    const loadTree = useCallback(async (handle: FileSystemDirectoryHandle): Promise<FileTreeNode[] | null> => {
        try {
            return await buildFileTree(handle);
        } catch (err) {
            console.error('Failed to build file tree:', err);
            return null;
        }
    }, []);

    const publishTree = useCallback((ticket: number, handle: FileSystemDirectoryHandle, tree: FileTreeNode[]) => {
        if (handle !== rootHandleRef.current) return false;
        if (ticket < treePublishedRef.current) return false;
        treePublishedRef.current = ticket;
        const shown = treeOwnerRef.current === handle ? fileTreeRef.current : null;
        const next = shown ? shareTree(shown, tree) : tree;
        if (next !== shown) commitTree(next, handle);
        return true;
    }, [commitTree]);

    const refreshTree = useCallback(async (handle: FileSystemDirectoryHandle | null | undefined) => {
        if (!handle) return false;
        const ticket = ++treeTicketRef.current;
        const tree = await loadTree(handle);
        return !!tree && publishTree(ticket, handle, tree);
    }, [loadTree, publishTree]);

    const patchTreeDirs = useCallback(async (root: FileSystemDirectoryHandle, dirs: string[]) => {
        const ticket = ++treeTicketRef.current;
        const next = await relistDirs(fileTreeRef.current, root, dirs, new Set());
        if (next) publishTree(ticket, root, next);
        else await refreshTree(root);
    }, [publishTree, refreshTree]);

    const recentListGenRef = useRef(0);
    const publishVaults = useCallback(async (list: StoredVault[], root?: FileSystemDirectoryHandle | null) => {
        const vaults = await menuVaults(list, root);
        recentListGenRef.current++;
        setRecentVaults(vaults);
    }, []);

    const recordVault = useCallback(async (handle: FileSystemDirectoryHandle) => {
        const work = (async () => {
            const { list, id } = await rememberVault(handle);
            const labelling = menuVaults(list, handle);
            let timer: ReturnType<typeof setTimeout> | undefined;
            const vaults = await Promise.race([
                labelling,
                new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), LABEL_WAIT_MS); }),
            ]).finally(() => clearTimeout(timer));
            // Answered after the person moved on (a startup left from its loading screen): this id must not land
            // on the vault open now, or that vault's session and records would be filed under another's id.
            if (rootHandleRef.current !== handle) return;
            const generation = ++recentListGenRef.current;
            setCurrentVaultId(id);
            setRecentVaults(vaults ?? list.map(vault => ({ ...vault, label: vault.name })));
            if (!vaults) void labelling.then(labelled => {
                if (rootHandleRef.current === handle && recentListGenRef.current === generation) setRecentVaults(labelled);
            }, () => {});
        })();
        work.catch(err => { console.warn('Could not record the opened vault:', err); });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const late = await Promise.race([
            work.then(() => false, () => false),
            new Promise<true>(resolve => { timer = setTimeout(() => resolve(true), RECORD_WAIT_MS); }),
        ]).finally(() => clearTimeout(timer));
        if (late) console.warn(`Recording "${handle.name}" in the recent vault list has not finished after ${RECORD_WAIT_MS / 1000} s (browser storage or a stored folder is not answering); going on without it.`);
    }, []);

    const settleStartup = useCallback((ticket: number) => {
        if (startupRef.current !== ticket) return;
        finishStartup();
        setIsLoading(false);
    }, []);

    const supersedeStartup = useCallback(() => {
        startupRef.current++;
        finishStartup();
        setIsLoading(false);
        setVaultProblem(null);
    }, []);

    const openAtStartup = useCallback(async (ticket: number, handle: FileSystemDirectoryHandle) => {
        const live = () => startupRef.current === ticket;
        commitRoot(handle);
        startupStep('record', handle.name);
        await recordVault(handle);
        if (!live()) return;
        startupStep('walk');
        const walkTicket = ++treeTicketRef.current;
        try {
            const tree = await buildFileTree(handle, '', undefined, startupWalk());
            if (live()) publishTree(walkTicket, handle, tree);
        } catch (error) {
            console.error('Failed to build file tree:', error);
            if (!live() || rootHandleRef.current !== handle) return;
            const cause = error instanceof FolderReadError ? error.cause : error;
            setVaultProblem({
                vault: handle.name,
                folder: error instanceof FolderReadError ? error.folder : null,
                message: describeError(cause),
                missing: error instanceof FolderReadError && error.folder === '' && (cause as DOMException)?.name === 'NotFoundError',
            });
        }
    }, [commitRoot, recordVault, publishTree]);

    useEffect(() => {
        const ticket = ++startupRef.current;
        const live = () => startupRef.current === ticket;
        beginStartup('recent-vaults');
        (async () => {
            const linked = readLocation().vault;
            let stored: StoredVault[] = [];
            try {
                try {
                    stored = await loadRecentVaults();
                } catch (err) {
                    console.warn('Could not load the recent vault list:', err);
                }
                if (!live()) return;
                const target = findLinkedVault(linked, stored);

                try {
                    if (target) {
                        startupStep('permission', target.handle.name);
                        const permission = await target.handle.queryPermission({ mode: 'readwrite' });
                        if (!live()) return;
                        if (permission === 'granted') {
                            await openAtStartup(ticket, target.handle);
                            return;
                        }
                        const labelled = (await labelVaults([target]))[0];
                        if (!live()) return;
                        setLinkedVault(labelled);
                        settleStartup(ticket);
                        const vaults = await menuVaults(stored, target.handle);
                        if (live()) { recentListGenRef.current++; setRecentVaults(vaults); }
                        return;
                    }

                    startupStep('stored-vault');
                    const storedHandle = await get<FileSystemDirectoryHandle>(IDB_KEY);
                    if (!live()) return;
                    if (storedHandle) {
                        startupStep('permission', storedHandle.name);
                        const permission = await storedHandle.queryPermission({ mode: 'readwrite' });
                        if (!live()) return;
                        if (permission === 'granted') {
                            await openAtStartup(ticket, storedHandle);
                            return;
                        } else if (permission === 'prompt') {
                            setPreviousVault(storedHandle);
                        }
                    }
                } catch (err) {
                    console.warn('Could not restore directory handle:', err);
                }
                if (!live()) return;
                settleStartup(ticket);
                const vaults = await menuVaults(stored, null);
                if (live()) { recentListGenRef.current++; setRecentVaults(vaults); }
            } catch (err) {
                console.warn('Vault startup failed:', err);
            } finally {
                settleStartup(ticket);
            }
        })();
    }, [openAtStartup, settleStartup]);

    const retryVault = useCallback(async () => {
        const handle = rootHandleRef.current;
        if (!handle) return;
        const ticket = ++startupRef.current;
        beginStartup('walk');
        setVaultProblem(null);
        setIsLoading(true);
        try { await openAtStartup(ticket, handle); }
        catch (err) { console.warn('Could not read the vault again:', err); }
        finally { settleStartup(ticket); }
    }, [openAtStartup, settleStartup]);


    const pickDirectory = useCallback(async (): Promise<VaultOpenResult> => {
        if (!window.showDirectoryPicker) {
            return {
                status: 'error',
                message: "Your browser doesn't support the local File System Access API.\n\n" +
                    "This feature is currently only supported in Chromium-based browsers (Chrome, Edge, Opera) on desktop.",
            };
        }
        if (pickerOpenRef.current || switchInFlightRef.current) return 'busy';
        pickerOpenRef.current = true;
        switchInFlightRef.current = true;
        let held = true;
        const letGo = () => {
            if (!held) return;
            held = false;
            pickerOpenRef.current = false;
            switchInFlightRef.current = false;
        };

        try {
            const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
            if (await isCurrentVault(handle)) {
                letGo();
                if (await refreshTree(rootHandleRef.current)) supersedeStartup();
                return 'ok';
            }
            const tree = await loadTree(handle);
            if (!tree) return 'error';

            const previousRoot = rootHandleRef.current;
            await set(IDB_KEY, handle);
            try { if (previousRoot) await beforeRootChangeRef.current?.(); }
            catch (error) { if (previousRoot) await set(IDB_KEY, previousRoot); throw error; }
            setPreviousVault(null);
            supersedeStartup();
            commitRoot(handle);
            commitTree(tree, handle);
            await recordVault(handle);
            void requestPersistentStorage();
            return 'ok';
        } catch (err) {
            if ((err as DOMException).name === 'AbortError') return 'ok';
            console.error('Error picking directory:', err);
            return 'error';
        } finally {
            letGo();
        }
    }, [refreshTree, loadTree, recordVault, isCurrentVault, commitRoot, commitTree, supersedeStartup]);

    const forgetRecentVault = useCallback(async (id: string) => {
        try {
            await publishVaults(await forgetVault(id), rootHandleRef.current);
            try { await forgetRecoveryVault(id); }
            catch (error) { console.warn('Could not remove forgotten vault recovery records:', error); }
            return true;
        } catch (err) {
            console.warn('Could not drop the vault from the recent list:', err);
            return false;
        }
    }, [publishVaults]);

    const pinRecentVault = useCallback(async (id: string, pinned: boolean) => {
        try {
            await publishVaults(await setVaultPinned(id, pinned), rootHandleRef.current);
            return true;
        } catch (err) {
            console.warn('Could not change the vault pin:', err);
            return false;
        }
    }, [publishVaults]);

    const openVaultHandle = useCallback(async (handle: FileSystemDirectoryHandle): Promise<VaultOpenResult> => {
        if (switchInFlightRef.current) return 'busy';
        switchInFlightRef.current = true;
        try {
            let permission = await handle.queryPermission({ mode: 'readwrite' });
            if (permission !== 'granted') {
                permission = await handle.requestPermission({ mode: 'readwrite' });
            }
            if (permission !== 'granted') return 'denied';

            if (await isCurrentVault(handle)) return 'ok';

            await handle.entries().next();

            const tree = await loadTree(handle);
            if (!tree) return 'error';

            const previousRoot = rootHandleRef.current;
            await set(IDB_KEY, handle);
            try { if (previousRoot) await beforeRootChangeRef.current?.(); }
            catch (error) { if (previousRoot) await set(IDB_KEY, previousRoot); throw error; }
            setPreviousVault(null);
            supersedeStartup();
            commitRoot(handle);
            commitTree(tree, handle);
            await recordVault(handle);
            void requestPersistentStorage();
            return 'ok';
        } catch (err) {
            if ((err as DOMException)?.name === 'NotFoundError') return 'missing';
            console.error('Could not open the vault:', err);
            return 'error';
        } finally {
            switchInFlightRef.current = false;
        }
    }, [loadTree, recordVault, isCurrentVault, commitRoot, commitTree, supersedeStartup]);

    const openLinkedVault = useCallback(async (): Promise<VaultOpenResult> => {
        if (!linkedVault) return 'denied';
        const result = await openVaultHandle(linkedVault.handle);
        if (result === 'ok') setLinkedVault(null);
        return result;
    }, [linkedVault, openVaultHandle]);

    const openRecentVault = useCallback(async (vault: RecentVault): Promise<VaultOpenResult> => {
        const result = await openVaultHandle(vault.handle);
        if (result === 'missing') {
            await forgetRecentVault(vault.id);
        }
        return result;
    }, [openVaultHandle, forgetRecentVault]);

    const readFile = useCallback(async (fileHandle: FileSystemFileHandle) => {
        const { buf } = await readSnapshot(fileHandle);
        return decodeDocumentText(buf).replace(/\r\n?/g, '\n');
    }, []);

    const writeFile = useCallback(async (fileHandle: FileSystemFileHandle, content: string) => {
        const writable = await fileHandle.createWritable();
        await writable.write(content);
        await writable.close();
    }, []);

    const readFileBytes = useCallback(async (fileHandle: FileSystemFileHandle) => {
        const { buf } = await readSnapshot(fileHandle);
        return new Uint8Array(buf);
    }, []);

    const writeFileBytes = useCallback(async (fileHandle: FileSystemFileHandle, bytes: Uint8Array) => {
        const writable = await fileHandle.createWritable();
        // Hand over the VIEW, not `.buffer`. write() takes a BufferSource and
        // honours a typed array's byteOffset/byteLength, so the view already
        // denotes exactly the right range — it is `.buffer` that would ignore
        // the view and write the whole underlying buffer. The defensive
        // .slice() this replaces copied the entire document (tens of MB for a
        // large annotated PDF) on every single save.
        await writable.write(bytes as Uint8Array<ArrayBuffer>);
        await writable.close();
    }, []);

    const importFiles = useCallback((files: FileList | File[], targetDir: FileSystemDirectoryHandle) => withMutation(async () => {
        const written: string[] = [];
        for (const file of Array.from(files)) {
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
    }), [rootHandle, refreshTree, withMutation]);

    const createFile = useCallback((parentDirHandle: FileSystemDirectoryHandle, fileName: string) => withMutation(async () => {
        const fileHandle = await parentDirHandle.getFileHandle(fileName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write('');
        await writable.close();
        await refreshTree(rootHandle);
        return fileHandle;
    }), [rootHandle, refreshTree, withMutation]);

    const createFolder = useCallback((parentDirHandle: FileSystemDirectoryHandle, folderName: string) => withMutation(async () => {
        const dirHandle = await parentDirHandle.getDirectoryHandle(folderName, { create: true });
        await refreshTree(rootHandle);
        return dirHandle;
    }), [rootHandle, refreshTree, withMutation]);

    const assetUrlsRef = useRef<Map<string, { url: string; mtime: number; size: number }>>(new Map());

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

    // withMutation only holds observer batches; it does not stop two backups
    // choosing the same free name. A rejected copy must not poison later ones.
    const garbageCopyQueueRef = useRef<Promise<void>>(Promise.resolve());
    const keepCopyInGarbage = useCallback((dir: FileSystemDirectoryHandle, name: string, bytes: Uint8Array): Promise<string> => {
        const copy = garbageCopyQueueRef.current.then(() => withMutation(async () => {
            let benchmarkHome: string | undefined;
            if (__BME_BENCH__) {
                try {
                    benchmarkHome = await dirPath(dir);
                    reportVault({ op: 'write', path: joinVaultPath(benchmarkHome, TRASH_DIR), caller: 'keepCopyInGarbage' });
                } catch { /* instrumentation must never interrupt a file operation */ }
            }
            const garbage = await dir.getDirectoryHandle(TRASH_DIR, { create: true });
            const copyName = await freeEntryName(garbage, name);
            if (__BME_BENCH__) {
                try {
                    if (benchmarkHome !== undefined) reportVault({
                        op: 'write', path: joinVaultPath(joinVaultPath(benchmarkHome, TRASH_DIR), copyName), caller: 'keepCopyInGarbage',
                    });
                } catch { /* instrumentation must never interrupt a file operation */ }
            }
            const handle = await garbage.getFileHandle(copyName, { create: true });
            // The caller already captured and version-checked these exact bytes.
            // Never reopen the source: it may have changed since that check.
            await writeFileBytes(handle, bytes);
            return copyName;
        }));
        garbageCopyQueueRef.current = copy.then(() => {}, () => {});
        return copy;
    }, [dirPath, withMutation, writeFileBytes]);

    const assetUrlFor = useCallback(async (key: string, fileHandle: FileSystemFileHandle) => {
        const file = await fileHandle.getFile();
        const cached = assetUrlsRef.current.get(key);
        if (cached && cached.mtime === file.lastModified && cached.size === file.size) {
            return cached.url;
        }
        if (cached) URL.revokeObjectURL(cached.url);
        const url = URL.createObjectURL(file);
        assetUrlsRef.current.set(key, { url, mtime: file.lastModified, size: file.size });
        return url;
    }, []);

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

    const assetUrlIn = useCallback(async (dir: FileSystemDirectoryHandle, fileName: string) => {
        try {
            const assetsDir = await dir.getDirectoryHandle(ASSETS_DIR);
            const fileHandle = await assetsDir.getFileHandle(fileName);
            return await assetUrlFor(`${joinVaultPath(await dirPath(dir), ASSETS_DIR)}/${fileName}`, fileHandle);
        } catch {
            return null;
        }
    }, [assetUrlFor, dirPath]);

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
        for (const seg of segs.slice(0, -1)) {
            try {
                cur = await cur.getDirectoryHandle(seg);
            } catch {
                break;
            }
            chain.push(cur);
        }
        return chain;
    }, [rootHandle]);

    const getAssetUrl = useCallback(async (fileName: string, parentDirHandle?: FileSystemDirectoryHandle | null) => {
        if (!isAssetName(fileName)) return null;
        const home = parentDirHandle || rootHandle;
        if (!home) return null;

        const local = await assetUrlIn(home, fileName);
        if (local) return local;

        const ancestors = await ancestorsOf(home);
        for (let i = ancestors.length - 1; i >= 0; i--) {
            const url = await assetUrlIn(ancestors[i], fileName);
            if (url) return url;
        }
        return null;
    }, [rootHandle, assetUrlIn, ancestorsOf]);

    const saveAsset = useCallback((fileName: string, blob: Blob, parentDirHandle?: FileSystemDirectoryHandle | null) => withMutation(async () => {
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
    }), [rootHandle, withMutation]);

    // Serializing puts prevents two in-app imports from choosing the same free
    // name. File System Access has no exclusive create, so another process can
    // still race the final name check; never deliberately replace a squatter.
    const boardAssetQueueRef = useRef<Promise<void>>(Promise.resolve());
    const boardOwnerGuard = useCallback(async (request: BoardOwnerAccess, activation: number) => {
        request.signal.throwIfAborted();
        if (!request.isCurrent() || request.root !== rootHandleRef.current || activation !== vaultActivationRef.current) {
            throw new DOMException('Board session ended', 'AbortError');
        }
        if (await request.root.resolve(request.parent) === null) throw new Error('Board folder is outside the vault');
        const owner = await request.parent.getFileHandle(request.owner.name);
        if (!await owner.isSameEntry(request.owner)) throw new Error('Board file changed');
        request.signal.throwIfAborted();
        if (!request.isCurrent() || request.root !== rootHandleRef.current || activation !== vaultActivationRef.current) {
            throw new DOMException('Board session ended', 'AbortError');
        }
    }, []);
    const boardAssetGuard = useCallback(async (request: BoardAssetAccess, activation: number) => {
        if (!/^[a-f0-9]{64}$/.test(request.hash)) throw new Error('Invalid board media hash');
        await boardOwnerGuard(request, activation);
    }, [boardOwnerGuard]);
    const readLegacyBoardAsset = useCallback(async (request: BoardOwnerAccess & { src: string }): Promise<Blob | null> => {
        const activation = vaultActivationRef.current, src = request.src;
        const hasPathControl = (value: string) => {
            for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) < 32 || value.charCodeAt(i) === 127) return true;
            return false;
        };
        if (typeof src !== 'string' || !src || src.length > 8192 || /^[a-z][a-z0-9+.-]*:/i.test(src)
            || src.startsWith('/') || /[\\?#]/.test(src) || hasPathControl(src)) throw new Error('Legacy asset is not a local relative path');
        await boardOwnerGuard(request, activation);
        const base = await request.root.resolve(request.parent);
        if (!base) throw new Error('Board folder is outside the vault');
        const segments = [...base], parts = src.split('/');
        let first = true;
        for (const [index, raw] of parts.entries()) {
            let segment: string;
            try { segment = decodeURIComponent(raw); } catch { throw new Error('Invalid legacy asset path encoding'); }
            if (index === parts.length - 1 && (!segment || segment === '.' || segment === '..')) throw new Error('Legacy asset path does not name a file');
            if (!segment || segment === '.') continue;
            if (first && /^[a-z][a-z0-9+.-]*:/i.test(segment)) throw new Error('Legacy asset is not a local relative path');
            first = false;
            if (segment === '..') {
                if (!segments.length) throw new Error('Legacy asset path leaves the vault');
                segments.pop(); continue;
            }
            if (segment.length > 255 || /[\\/]/.test(segment) || hasPathControl(segment)) throw new Error('Invalid legacy asset path');
            segments.push(segment);
            if (segments.length > 256) throw new Error('Legacy asset path is too deep');
        }
        if (!segments.length || segments.some(segment => segment.toLowerCase() === '.vaultagent')) throw new Error('Legacy asset path is not accessible');
        await boardOwnerGuard(request, activation);
        try {
            const { handle } = await resolveVaultFile(request.root, segments.join('/'));
            request.signal.throwIfAborted();
            const file = await handle.getFile();
            if (file.size > 10 * 1024 * 1024) throw new RangeError('Legacy asset exceeds 10 MiB');
            await boardOwnerGuard(request, activation);
            return file.slice(0, file.size, file.type);
        } catch (error) {
            if (error instanceof DOMException && (error.name === 'NotFoundError' || error.name === 'TypeMismatchError')) {
                await boardOwnerGuard(request, activation);
                return null;
            }
            throw error;
        }
    }, [boardOwnerGuard]);
    const findBoardAsset = useCallback(async (dir: FileSystemDirectoryHandle, request: BoardAssetAccess) => {
        const names: string[] = [];
        for await (const [name, handle] of dir.entries()) {
            request.signal.throwIfAborted();
            if (handle.kind === 'file' && name.startsWith(`${request.hash}.`)) names.push(name);
        }
        const preferred = request.preferredName;
        if (preferred && preferred !== '.' && preferred !== '..' && !/[\\/\0]/.test(preferred) && !names.includes(preferred)) names.push(preferred);
        for (const name of names) {
            try {
                const file = await (await dir.getFileHandle(name)).getFile();
                if (file.size <= 10 * 1024 * 1024 && await fingerprintSnapshot(file, request.signal) === request.hash) return { name, blob: file as Blob };
            } catch (error) {
                if (!(error instanceof DOMException && (error.name === 'NotFoundError' || error.name === 'TypeMismatchError'))) throw error;
            }
        }
        return null;
    }, []);
    const readBoardAsset = useCallback(async (request: BoardAssetAccess) => {
        const activation = vaultActivationRef.current;
        await boardAssetGuard(request, activation);
        let dir: FileSystemDirectoryHandle;
        try { dir = await request.parent.getDirectoryHandle(ASSETS_DIR); }
        catch (error) {
            if (error instanceof DOMException && error.name === 'NotFoundError') {
                await boardAssetGuard(request, activation);
                return null;
            }
            throw error;
        }
        const found = await findBoardAsset(dir, request);
        await boardAssetGuard(request, activation);
        return found;
    }, [boardAssetGuard, findBoardAsset]);
    const storeBoardAsset = useCallback(async (request: BoardAssetAccess & { extension: string; blob: Blob }, activation: number) => {
            await boardAssetGuard(request, activation);
            if (!/^[a-z0-9]{1,8}$/.test(request.extension)) throw new Error('Invalid board media extension');
            if (request.blob.size > 10 * 1024 * 1024) throw new RangeError('Board media exceeds 10 MiB');
            if (await fingerprintSnapshot(request.blob, request.signal) !== request.hash) throw new Error('Board media hash mismatch');
            await boardAssetGuard(request, activation);
            const dir = await request.parent.getDirectoryHandle(ASSETS_DIR, { create: true });
            const existing = await findBoardAsset(dir, request);
            await boardAssetGuard(request, activation);
            if (existing) return { name: existing.name, created: false };
            const temporaryName = await freeEntryName(dir, `.incoming-${crypto.randomUUID()}`);
            await boardAssetGuard(request, activation);
            const temporary = await dir.getFileHandle(temporaryName, { create: true });
            let tempVersion = await temporary.getFile();
            try {
                const write = await temporary.createWritable();
                try {
                    await write.write(request.blob);
                    await boardAssetGuard(request, activation);
                    await write.close();
                } catch (error) { await write.abort().catch(() => {}); throw error; }
                const prepared = await temporary.getFile();
                tempVersion = prepared;
                if (await fingerprintSnapshot(prepared, request.signal) !== request.hash) throw new Error('Board media staging failed');
                const name = await freeEntryName(dir, `${request.hash}.${request.extension}`);
                await boardAssetGuard(request, activation);
                const target = await dir.getFileHandle(name, { create: true });
                const output = await target.createWritable();
                try {
                    await output.write(prepared);
                    await boardAssetGuard(request, activation);
                    await output.close();
                } catch (error) { await output.abort().catch(() => {}); throw error; }
                await boardAssetGuard(request, activation);
                return { name, created: true };
            } finally {
                // Only remove the temp we created, never a name another actor
                // replaced while the write was in flight.
                try {
                    const current = await dir.getFileHandle(temporaryName);
                    const file = await current.getFile();
                    if (await current.isSameEntry(temporary) && file.lastModified === tempVersion.lastModified && file.size === tempVersion.size
                        && await fingerprintSnapshot(file) === await fingerprintSnapshot(tempVersion)) {
                        await dir.removeEntry(temporaryName);
                    }
                } catch { /* a failed cleanup leaves recoverable staging bytes */ }
            }
    }, [boardAssetGuard, findBoardAsset]);
    const putBoardAsset = useCallback((request: BoardAssetAccess & { extension: string; blob: Blob }) => {
        const activation = vaultActivationRef.current;
        const job = boardAssetQueueRef.current.then(() => withMutation(async () => (await storeBoardAsset(request, activation)).name));
        boardAssetQueueRef.current = job.then(() => {}, () => {});
        return untilAborted(job, request.signal);
    }, [storeBoardAsset, withMutation]);

    const writeBoardCopy = useCallback((request: BoardOwnerAccess & { names: Iterable<string>;
        bytes: (files: ReadonlyMap<string, string>) => Promise<Blob>; media: readonly { hash: string; extension: string; blob: Blob }[] }) => {
        const activation = vaultActivationRef.current;
        const job = boardAssetQueueRef.current.then(() => withMutation(async () => {
            await boardOwnerGuard(request, activation);
            const parentPath = (await request.root.resolve(request.parent))?.join('/');
            if (parentPath === undefined) throw new Error('The board’s folder is no longer in this vault.');
            const added: string[] = [], files = new Map<string, string>();
            let created: FileSystemFileHandle | null = null, createdName = '';
            try {
                for (const picture of request.media) {
                    const stored = await storeBoardAsset({ ...request, hash: picture.hash, preferredName: null,
                        extension: picture.extension, blob: picture.blob }, activation);
                    if (stored.created) added.push(stored.name);
                    files.set(picture.hash, stored.name);
                }
                const bytes = await request.bytes(files);
                await boardOwnerGuard(request, activation);
                let name: string | undefined;
                let tried = 0;
                for (const candidate of request.names) {
                    if (++tried > 10_000) break;
                    if (!candidate || /[\\/\0]/.test(candidate)) continue;
                    if (!await entryExists(request.parent, candidate)) { name = candidate; break; }
                }
                if (!name) throw new Error('No free name was found for the copy.');
                // Proven free (files and folders both) the line above, with nothing awaited in between — a guard here
                // was a gap in which another program could take the name and have its file replaced. Never createFile,
                // which opens-or-truncates.
                created = await request.parent.getFileHandle(name, { create: true });
                createdName = name;
                await writeAllBytes(created, bytes);
                const version = await versionAfterWrite(created, bytes);
                const written = await created.getFile();
                if (written.size !== bytes.size || await fingerprintSnapshot(written) !== version.hash) {
                    throw new Error('The copy did not read back as written.');
                }
                if (rootHandleRef.current === request.root) await patchTreeDirs(request.root, [parentPath]);
                return { name, path: joinVaultPath(parentPath, name), handle: created, version, bytes };
            } catch (error) {
                if (created) {
                    try {
                        const current = await request.parent.getFileHandle(createdName);
                        if (await current.isSameEntry(created)) await request.parent.removeEntry(createdName);
                    } catch { /* already gone */ }
                }
                for (const name of added) {
                    try { await retireUnusedPicture(request.parent, name); }
                    catch { /* a picture that cannot be moved stays in .Assets, where it harms nothing */ }
                }
                if (rootHandleRef.current === request.root) await patchTreeDirs(request.root, [parentPath]).catch(() => {});
                throw error;
            }
        }));
        boardAssetQueueRef.current = job.then(() => {}, () => {});
        return job;
    }, [boardOwnerGuard, storeBoardAsset, withMutation, patchTreeDirs]);

    const keepConversionBackup = useCallback((request: BoardAssetAccess & { blob: Blob }): Promise<TrashItem> => {
        const activation = vaultActivationRef.current;
        const job = garbageCopyQueueRef.current.then(() => withMutation(async () => {
            const check = () => {
                request.signal.throwIfAborted();
                if (activation !== vaultActivationRef.current || request.root !== rootHandleRef.current || !request.isCurrent()) {
                    throw new DOMException('Board session ended', 'AbortError');
                }
            };
            const checkSource = async () => {
                check();
                await boardAssetGuard(request, activation);
                const file = await request.owner.getFile();
                check();
                if (await fingerprintSnapshot(file, request.signal) !== request.hash) throw new Error('The conversion source changed');
                check();
            };
            await boardAssetGuard(request, activation);
            if (await fingerprintSnapshot(request.blob, request.signal) !== request.hash) throw new Error('Conversion backup does not match the source');
            await checkSource();
            const parentPath = await request.root.resolve(request.parent);
            check();
            if (!parentPath) throw new Error('Board folder is outside the vault');
            const garbage = await request.parent.getDirectoryHandle(TRASH_DIR, { create: true });
            check();
            const dot = request.owner.name.lastIndexOf('.');
            const stem = dot > 0 ? request.owner.name.slice(0, dot) : request.owner.name, ext = dot > 0 ? request.owner.name.slice(dot) : '';
            let name: string | undefined, handle: FileSystemFileHandle | undefined;
            for (let n = 0; !handle; n++) {
                const candidate = n ? `${stem} (${n})${ext}` : request.owner.name;
                let existing: FileSystemFileHandle;
                try { existing = await garbage.getFileHandle(candidate); }
                catch (error) {
                    if (error instanceof DOMException && error.name === 'TypeMismatchError') continue;
                    if (error instanceof DOMException && error.name === 'NotFoundError') break;
                    throw error;
                }
                check();
                const kept = await existing.getFile();
                check();
                if (kept.size === request.blob.size && await fingerprintSnapshot(kept, request.signal) === request.hash) { name = candidate; handle = existing; }
            }
            check();
            if (!handle || !name) {
                name = await freeEntryName(garbage, request.owner.name);
                check();
                handle = await garbage.getFileHandle(name, { create: true });
                check();
                const output = await handle.createWritable();
                try {
                    await output.write(request.blob);
                    check();
                    await output.close();
                } catch (error) { await output.abort().catch(() => {}); throw error; }
            }
            await checkSource();
            const backup = await handle.getFile();
            check();
            if (await fingerprintSnapshot(backup, request.signal) !== request.hash) throw new Error('Conversion backup verification failed');
            await checkSource();
            const restorePath = parentPath.join('/');
            const sourcePath = joinVaultPath(joinVaultPath(restorePath, TRASH_DIR), name);
            return { id: sourcePath, name, kind: 'file' as const, origin: 'trashed' as const, sourcePath, handle,
                parentHandle: garbage, restorePath, restoreDirHandle: request.parent,
                deletedAt: backup.lastModified, size: backup.size };
        }));
        garbageCopyQueueRef.current = job.then(() => {}, () => {});
        return job;
    }, [boardAssetGuard, withMutation]);

    const restoreConversionCopy = useCallback((request: BoardAssetAccess, item: TrashItem) => {
        const activation = vaultActivationRef.current;
        const job = boardAssetQueueRef.current.then(() => withMutation(async () => {
            await boardAssetGuard(request, activation);
            if (item.kind !== 'file' || item.origin !== 'trashed') throw new Error('Not a conversion backup');
            const sourcePath = await request.root.resolve(item.handle);
            if (!sourcePath?.includes(TRASH_DIR)) throw new Error('Backup is not in this vault’s Trash');
            const source = await item.parentHandle.getFileHandle(item.name);
            if (!await source.isSameEntry(item.handle)) throw new Error('Backup changed');
            const file = await source.getFile();
            if (await fingerprintSnapshot(file, request.signal) !== request.hash) throw new Error('Backup no longer matches');
            await boardAssetGuard(request, activation);
            const name = await freeEntryName(request.parent, item.name);
            await boardAssetGuard(request, activation);
            const target = await request.parent.getFileHandle(name, { create: true });
            const output = await target.createWritable();
            try {
                await output.write(file);
                await boardAssetGuard(request, activation);
                await output.close();
            } catch (error) { await output.abort().catch(() => {}); throw error; }
            await boardAssetGuard(request, activation);
            const parentPath = await request.root.resolve(request.parent);
            if (parentPath) await patchTreeDirs(request.root, [parentPath.join('/')]);
            return name;
        }));
        boardAssetQueueRef.current = job.then(() => {}, () => {});
        return untilAborted(job, request.signal);
    }, [boardAssetGuard, withMutation, patchTreeDirs]);

    const copyTrashFile = useCallback((item: TrashItem, root: FileSystemDirectoryHandle, isCurrent: () => boolean) => {
        const activation = vaultActivationRef.current;
        const job = boardAssetQueueRef.current.then(() => withMutation(async () => {
            const check = () => {
                if (rootHandleRef.current !== root || activation !== vaultActivationRef.current || !isCurrent()) throw new DOMException('Vault changed', 'AbortError');
            };
            check();
            if (item.kind !== 'file' || item.origin !== 'trashed') throw new Error('Not a trashed file');
            const sourcePath = await root.resolve(item.handle);
            const targetPath = await root.resolve(item.restoreDirHandle);
            if (!sourcePath?.includes(TRASH_DIR) || targetPath === null) throw new Error('Trash item is outside this vault');
            const source = await item.parentHandle.getFileHandle(item.name);
            if (!await source.isSameEntry(item.handle)) throw new Error('Trash item changed');
            const file = await source.getFile();
            const name = await freeEntryName(item.restoreDirHandle, item.name);
            check();
            const target = await item.restoreDirHandle.getFileHandle(name, { create: true });
            const output = await target.createWritable();
            try { await output.write(file); check(); await output.close(); }
            catch (error) { await output.abort().catch(() => {}); throw error; }
            check();
            await patchTreeDirs(root, [targetPath.join('/')]);
            return name;
        }));
        boardAssetQueueRef.current = job.then(() => {}, () => {});
        return job;
    }, [withMutation, patchTreeDirs]);

    const retireAsset = useCallback((fileName: string, dirHandle: FileSystemDirectoryHandle, guard: () => boolean) => withMutation(async () => {
        if (!isAssetName(fileName) || !guard()) return false;
        const activation = vaultActivationRef.current;
        let benchmarkRoot: FileSystemDirectoryHandle | null = null;
        if (__BME_BENCH__) {
            try { benchmarkRoot = rootHandleRef.current; } catch { /* instrumentation only */ }
        }
        try {
            const assetsDir = await dirHandle.getDirectoryHandle(ASSETS_DIR);
            const source = await assetsDir.getFileHandle(fileName);
            const file = await source.getFile();
            if (!guard()) return false;

            if (__BME_BENCH__) {
                try {
                    const home = (await benchmarkRoot?.resolve(dirHandle))?.join('/');
                    if (home !== undefined) reportVault({
                        op: 'retire', path: joinVaultPath(joinVaultPath(home, ASSETS_DIR), fileName),
                        to: joinVaultPath(joinVaultPath(joinVaultPath(home, TRASH_DIR), ASSETS_DIR), fileName), caller: 'retireAsset',
                    });
                } catch { /* instrumentation must never interrupt a file operation */ }
            }
            const graveyard = await retiredAssetsDir(dirHandle, true);
            if (!guard()) return false;
            await copyFileInto(graveyard, fileName, file);
            // A copy may finish after its proof detached. Keeping both copies
            // is safe; removing the live one on that obsolete proof is not.
            if (!guard()) return false;
            await assetsDir.removeEntry(fileName);

            const key = `${joinVaultPath(await dirPath(dirHandle), ASSETS_DIR)}/${fileName}`;
            // An authorized removal can finish after a switch. The new vault
            // may already have put a different blob under this relative key.
            if (vaultActivationRef.current !== activation) return true;
            const cached = assetUrlsRef.current.get(key);
            if (cached) {
                URL.revokeObjectURL(cached.url);
                assetUrlsRef.current.delete(key);
            }
            return true;
        } catch {
            return false;
        }
    }), [dirPath, withMutation]);

    const restoreAsset = useCallback((fileName: string, dirHandle: FileSystemDirectoryHandle, guard: () => boolean) => withMutation(async () => {
        if (!isAssetName(fileName) || !guard()) return false;
        let benchmarkRoot: FileSystemDirectoryHandle | null = null;
        if (__BME_BENCH__) {
            try { benchmarkRoot = rootHandleRef.current; } catch { /* instrumentation only */ }
        }
        try {
            const graveyard = await retiredAssetsDir(dirHandle, false);
            const source = await graveyard.getFileHandle(fileName);
            const file = await source.getFile();

            if (__BME_BENCH__) {
                try {
                    const home = (await benchmarkRoot?.resolve(dirHandle))?.join('/');
                    if (home !== undefined) reportVault({
                        op: 'restore', path: joinVaultPath(joinVaultPath(joinVaultPath(home, TRASH_DIR), ASSETS_DIR), fileName),
                        to: joinVaultPath(joinVaultPath(home, ASSETS_DIR), fileName), caller: 'restoreAsset',
                    });
                } catch { /* instrumentation must never interrupt a file operation */ }
            }
            if (!guard()) return false;
            const assetsDir = await dirHandle.getDirectoryHandle(ASSETS_DIR, { create: true });
            try {
                await assetsDir.getFileHandle(fileName);
                return false;    // a live asset already holds the name; leave both alone
            } catch { /* free — take it back */ }

            if (!guard()) return false;
            await copyFileInto(assetsDir, fileName, file);
            // A switch during the copy must leave the retired source recoverable.
            if (!guard()) return false;
            await graveyard.removeEntry(fileName);
            return true;
        } catch {
            return false;
        }
    }), [withMutation]);

    const restoreVault = useCallback(async () => {
        if (!previousVault) return;
        try {
            const permission = await previousVault.requestPermission({ mode: 'readwrite' });
            if (permission === 'granted') {
                const ticket = ++startupRef.current;
                beginStartup('record');
                setVaultProblem(null);
                setIsLoading(true);
                try {
                    await openAtStartup(ticket, previousVault);
                    if (startupRef.current === ticket) setPreviousVault(null);
                } finally {
                    settleStartup(ticket);
                }
            }
        } catch (err) {
            console.error('Error restoring vault permission:', err);
        }
    }, [previousVault, openAtStartup, settleStartup]);

    const moveToTrash = useCallback((node: FileTreeNode) => withMutation(async () => {
        if (!rootHandle || !node.parentHandle) return false;
        if (node.kind === 'directory' && (node.name === TRASH_DIR || node.name === ASSETS_DIR)) return false;

        try {
            let benchmarkOpen: number | undefined;
            if (__BME_BENCH__) {
                try { benchmarkOpen = reportVault({ op: 'trash', path: node.path, caller: 'moveToTrash' }); } catch { /* instrumentation only */ }
            }
            const trashDir = await node.parentHandle.getDirectoryHandle(TRASH_DIR, { create: true });
            await displaceInto(trashDir, node.parentHandle, node, __BME_BENCH__ ? {
                opens: benchmarkOpen, path: node.path, bucketPath: joinVaultPath(parentVaultPath(node.path), TRASH_DIR), caller: 'moveToTrash',
            } : undefined);
            if (node.kind === 'directory') revokeAssetUrlsUnder(node.path);
            await refreshTree(rootHandle);
            return true;
        } catch (err) {
            console.error('Failed to move item to trash:', err);
            return false;
        }
    }), [rootHandle, refreshTree, revokeAssetUrlsUnder, withMutation]);

    const listTrash = useCallback(async (): Promise<TrashItem[]> => {
        if (!rootHandle) return [];
        const out: TrashItem[] = [];
        await walkForTrash(rootHandle, '', out);
        return sortTrashRoot(out);
    }, [rootHandle]);

    const restoreFromTrash = useCallback((item: TrashItem, mode: TrashRestoreMode): Promise<TrashRestoreResult> => withMutation(async () => {
        if (!rootHandle) return { status: 'error' };
        if (!isAssetName(item.name)) return { status: 'error' };
        if (item.kind === 'directory' && (item.name === TRASH_DIR || item.name === ASSETS_DIR)) return { status: 'error' };

        let wrote: { dir: FileSystemDirectoryHandle; name: string } | null = null;

        try {
            const home = item.restoreDirHandle;
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
                let benchmarkOpen: number | undefined;
                if (__BME_BENCH__) {
                    try {
                        benchmarkOpen = reportVault({ op: item.origin === 'retired' ? 'retire' : 'trash', path: joinVaultPath(item.origin === 'retired' ? joinVaultPath(item.restorePath, ASSETS_DIR) : item.restorePath, live.name), caller: 'restoreFromTrash:displace' });
                    } catch { /* instrumentation must never interrupt a file operation */ }
                }
                const bucket = item.origin === 'retired'
                    ? await retiredAssetsDir(home, true)
                    : await destDir.getDirectoryHandle(TRASH_DIR, { create: true });
                const bucketPath = item.origin === 'retired'
                    ? joinVaultPath(joinVaultPath(item.restorePath, TRASH_DIR), ASSETS_DIR)
                    : joinVaultPath(item.restorePath, TRASH_DIR);
                const filedAs = await displaceInto(bucket, destDir, live, __BME_BENCH__ ? {
                    opens: benchmarkOpen, path: joinVaultPath(item.origin === 'retired' ? joinVaultPath(item.restorePath, ASSETS_DIR) : item.restorePath, live.name),
                    bucketPath, caller: 'restoreFromTrash:displace',
                } : undefined);
                if (live.kind === 'directory') revokeAssetUrlsUnder(joinVaultPath(item.restorePath, item.name));
                displaced = await describeDisplaced(
                    bucket, bucketPath, filedAs, live.kind, item.origin, home, item.restorePath);
            }

            const finalName = taken && destDir && mode === 'keep-both'
                ? await freeEntryName(destDir, item.name, item.kind)
                : item.name;

            if (__BME_BENCH__) {
                try {
                    reportVault({ op: 'restore', path: item.sourcePath, to: joinVaultPath(item.origin === 'retired' ? joinVaultPath(item.restorePath, ASSETS_DIR) : item.restorePath, finalName), caller: 'restoreFromTrash' });
                } catch { /* instrumentation must never interrupt a file operation */ }
            }
            if (!destDir) {
                destDir = await home.getDirectoryHandle(ASSETS_DIR, { create: true });
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
            return { status: 'error' };
        }
    }), [rootHandle, refreshTree, revokeAssetUrlsUnder, withMutation]);

    const deleteFromTrash = useCallback(async (item: TrashItem) => {
        if (!isAssetName(item.name)) return false;
        if (item.kind === 'directory' && (item.name === TRASH_DIR || item.name === ASSETS_DIR)) return false;
        try {
            if (__BME_BENCH__) {
                try { reportVault({ op: 'empty-trash', path: item.sourcePath, caller: 'deleteFromTrash' }); } catch { /* instrumentation only */ }
            }
            await item.parentHandle.removeEntry(item.name, { recursive: item.kind === 'directory' });
            return true;
        } catch (err) {
            console.error('Failed to delete the item for good:', err);
            return false;
        }
    }, []);

    const emptyTrash = useCallback(() => withMutation(async () => {
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
                    if (isGitName(name)) continue;
                    if (name === TRASH_DIR) { hasTrash = true; continue; }
                    live.push(handle);
                }
            } catch (err) {
                console.warn('Could not read a folder while emptying the trash:', err);
                failed++;
                return;
            }

            if (hasTrash) {
                try {
                    if (__BME_BENCH__) {
                        try {
                            const home = await rootHandle.resolve(dir);
                            if (home) reportVault({ op: 'empty-trash', path: joinVaultPath(home.join('/'), TRASH_DIR), caller: 'emptyTrash' });
                        } catch { /* instrumentation must never interrupt a file operation */ }
                    }
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
    }), [rootHandle, withMutation]);

    const moveFile = useCallback((sourceNode: FileTreeNode, targetDirHandle: FileSystemDirectoryHandle) => withMutation(async () => {
        if (!sourceNode.parentHandle || !targetDirHandle) return false;
        // Don't move into the same folder. By isSameEntry as well as identity: a
        // copy-then-delete "move" of a file onto its own folder copies it onto
        // itself and then removes it, so this test must not depend on two
        // handles for one folder being the same OBJECT (the tree's sharing pass
        // keeps them so, but a handle can reach here from anywhere).
        if (sourceNode.parentHandle === targetDirHandle) return false;
        try {
            if (await sourceNode.parentHandle.isSameEntry(targetDirHandle)) return false;
        } catch { /* cannot tell: proceed as before */ }

        try {
            if (__BME_BENCH__) {
                try {
                    const target = await rootHandle?.resolve(targetDirHandle);
                    if (target) {
                        reportVault({ op: 'move', path: sourceNode.path, to: joinVaultPath(target.join('/'), sourceNode.name), caller: 'moveFile' });
                    }
                } catch { /* instrumentation must never interrupt a file operation */ }
            }
            if (sourceNode.kind === 'file') {
                const file = await sourceNode.handle.getFile();
                const newHandle = await targetDirHandle.getFileHandle(sourceNode.name, { create: true });
                const writable = await newHandle.createWritable();
                await writable.write(file);
                await writable.close();
            } else {
                const newDir = await targetDirHandle.getDirectoryHandle(sourceNode.name, { create: true });
                await copyDirRecursive(sourceNode.handle, newDir);
            }

            await sourceNode.parentHandle.removeEntry(sourceNode.name, { recursive: sourceNode.kind === 'directory' });
            await refreshTree(rootHandle);
            return true;
        } catch (err) {
            console.error('Failed to move item:', err);
            return false;
        }
    }), [rootHandle, refreshTree, withMutation]);

    const renameFile = useCallback((sourceNode: FileTreeNode, newName: string) => withMutation(async () => {
        if (!sourceNode.parentHandle || !newName) return false;
        if (sourceNode.name === newName) return true;

        try {
            if (__BME_BENCH__) {
                try {
                    reportVault({ op: 'move', path: sourceNode.path, to: joinVaultPath(parentVaultPath(sourceNode.path), newName), caller: 'renameFile' });
                } catch { /* instrumentation must never interrupt a file operation */ }
            }
            if (sourceNode.kind === 'file') {
                const file = await sourceNode.handle.getFile();
                const newHandle = await sourceNode.parentHandle.getFileHandle(newName, { create: true });
                const writable = await newHandle.createWritable();
                await writable.write(file);
                await writable.close();
            } else {
                const newDir = await sourceNode.parentHandle.getDirectoryHandle(newName, { create: true });
                await copyDirRecursive(sourceNode.handle, newDir);
            }

            await sourceNode.parentHandle.removeEntry(sourceNode.name, { recursive: sourceNode.kind === 'directory' });
            await refreshTree(rootHandle);
            return true;
        } catch (err) {
            console.error('Failed to rename item:', err);
            return false;
        }
    }), [rootHandle, refreshTree, withMutation]);

    const readFileVersioned = useCallback(async (fileHandle: FileSystemFileHandle) => {
        const endRead = beginForegroundRead();
        try {
            const { file, buf } = await readSnapshot(fileHandle);
            const version = await versionOfSnapshot(file, buf);
            return { text: decodeDocumentText(buf).replace(/\r\n?/g, '\n'), version };
        } finally { endRead(); }
    }, []);

    const readFileSnapshot = useCallback(async (handle: FileSystemFileHandle, signal?: AbortSignal): Promise<ReadOnlyFileSnapshot> => {
        signal?.throwIfAborted();
        let blob: File;
        const endRead = beginForegroundRead();
        try {
            try { blob = await withinFileDeadline(handle.getFile(), handle.name); } catch (error) {
                if (!(error instanceof DOMException) || error.name !== 'NotReadableError') throw error;
                blob = await withinFileDeadline(handle.getFile(), handle.name);
            }
        } finally { endRead(); }
        signal?.throwIfAborted();
        const lifetime = new AbortController();
        const abort = () => lifetime.abort();
        signal?.addEventListener('abort', abort, { once: true });
        const stat = { lastModified: blob.lastModified, size: blob.size };
        let version: DiskVersion | undefined;
        return { snapshotId: crypto.randomUUID(), blob, stat,
            fingerprint(requestSignal) {
                requestSignal?.throwIfAborted(); lifetime.signal.throwIfAborted();
                if (version) return Promise.resolve(version);
                const taskSignal = requestSignal ? AbortSignal.any([requestSignal, lifetime.signal]) : lifetime.signal;
                return fingerprintSnapshot(blob, taskSignal).then(hash => {
                    taskSignal.throwIfAborted();
                    return version = { ...stat, hash };
                });
            },
            dispose() { lifetime.abort(); signal?.removeEventListener('abort', abort); },
        };
    }, []);

    const readBytesVersioned = useCallback(async (fileHandle: FileSystemFileHandle) => {
        const endRead = beginForegroundRead();
        try {
            const { file, buf } = await readSnapshot(fileHandle);
            return { bytes: new Uint8Array(buf), version: await versionOfSnapshot(file, buf) };
        } finally { endRead(); }
    }, []);

    /**
     * A file that is MISSING is `deleted` and nothing is written, because
     * `createWritable` on a vanished handle would silently recreate it — a note
     * the user deleted outside the app coming back on the next keystroke.
     */
    const writeFileVersioned = useCallback(async (
        fileHandle: FileSystemFileHandle,
        data: string | Uint8Array | Blob,
        expected: DiskVersion | null,
    ): Promise<VersionedWriteResult> => {
        const bytes = data instanceof Blob ? data : toBytes(data);
        try {
            const stat = await statOf(fileHandle);
            if (!stat) return { status: 'deleted' };

            if (expected && !sameStat(stat, expected)) {
                const { file, buf } = await readSnapshot(fileHandle);
                const disk = await versionOfSnapshot(file, buf);
                if (disk.hash !== expected.hash) {
                    return { status: 'changed', disk: { bytes: new Uint8Array(buf), version: disk } };
                }
            }

            await writeAllBytes(fileHandle, bytes);
        } catch (err) {
            // Vanished between the stat and the swap (or mid-read): still not ours
            // to recreate.
            if (isGone(err)) return { status: 'deleted' };
            throw err;
        }
        const version = await versionAfterWrite(fileHandle, bytes);
        if (version.size !== (bytes instanceof Blob ? bytes.size : bytes.byteLength)) {
            try {
                const { file, buf } = await readSnapshot(fileHandle);
                const disk = await versionOfSnapshot(file, buf);
                if (disk.hash !== version.hash) return { status: 'changed', disk: { bytes: new Uint8Array(buf), version: disk } };
            } catch (err) { if (isGone(err)) return { status: 'deleted' }; throw err; }
        }
        return { status: 'written', version };
    }, []);

    const inspectExportTarget = useCallback(async (dir: FileSystemDirectoryHandle, name: string): Promise<DiskVersion | null> => {
        try {
            const handle = await dir.getFileHandle(name);
            const { file, buf } = await readSnapshot(handle);
            return await versionOfSnapshot(file, buf);
        } catch (error) {
            if (isNotFound(error)) return null;
            throw error;
        }
    }, []);

    const writeNotebookExport = useCallback((dir: FileSystemDirectoryHandle, parentPath: string, name: string, bytes: Uint8Array, expected: DiskVersion | null, isCurrent: () => boolean) => withMutation(async (): Promise<{ status: 'written'; version: DiskVersion } | { status: 'changed' | 'cancelled' }> => {
        const root = rootHandleRef.current;
        const current = () => root === rootHandleRef.current && isCurrent();
        if (!current()) return { status: 'cancelled' };
        if (!expected) {
            if (await entryExists(dir, name)) return { status: 'changed' };
            if (!current()) return { status: 'cancelled' };
            const handle = await dir.getFileHandle(name, { create: true });
            if (!current()) return { status: 'cancelled' };
            const writable = await handle.createWritable();
            try {
                await writable.write(bytes as Uint8Array<ArrayBuffer>);
                if (!current()) { await writable.abort(); return { status: 'cancelled' }; }
                await writable.close();
            } catch (error) { await writable.abort().catch(() => {}); throw error; }
            if (root && rootHandleRef.current === root) await patchTreeDirs(root, [parentPath]);
            return { status: 'written', version: await versionAfterWrite(handle, bytes) };
        }
        let handle: FileSystemFileHandle;
        try { handle = await dir.getFileHandle(name); }
        catch (error) { if (isGone(error)) return { status: 'changed' }; throw error; }
        const { file, buf } = await readSnapshot(handle);
        const observed = await versionOfSnapshot(file, buf);
        if (observed.hash !== expected.hash) return { status: 'changed' };
        const trash = await dir.getDirectoryHandle(TRASH_DIR, { create: true });
        const backupName = await freeEntryName(trash, name);
        // Keep the snapshot even if a later write fails: it is the last known
        // complete version and the existing file is never truncated first.
        await copyFileInto(trash, backupName, file);
        if (!current()) return { status: 'cancelled' };
        const after = await readSnapshot(handle);
        const afterVersion = await versionOfSnapshot(after.file, after.buf);
        if (afterVersion.hash !== observed.hash) return { status: 'changed' };
        if (!current()) return { status: 'cancelled' };
        const result = await writeFileVersioned(handle, bytes, afterVersion);
        if (result.status !== 'written') return { status: 'changed' };
        return { status: 'written', version: result.version };
    }), [patchTreeDirs, withMutation, writeFileVersioned]);

    const writeConflictCopy = useCallback((filePath: string, data: string | Uint8Array | Blob, vaultRoot?: FileSystemDirectoryHandle | null,
        guard?: () => boolean) => withMutation(async () => {
        const root = vaultRoot ?? rootHandleRef.current;
        if (!root) throw new Error('No vault open');
        const parentPath = parentVaultPath(filePath);
        const { dir, patchFrom } = await ensureDirChain(root, parentPath);
        const name = filePath.slice(parentPath ? parentPath.length + 1 : 0);

        let copyName = '';
        for (let n = 1; ; n++) {
            copyName = conflictName(name, n);
            if (!(await entryExists(dir, copyName))) break;
        }
        if (guard && !guard()) throw new DOMException('Copy source is no longer authorized', 'AbortError');
        // Once creation starts, finish the immutable copy rather than leave an empty file.
        const handle = await dir.getFileHandle(copyName, { create: true });
        await writeAllBytes(handle, data instanceof Blob ? data : toBytes(data));
        if (root === rootHandleRef.current) await patchTreeDirs(root, [patchFrom ?? parentPath]);
        return joinVaultPath(parentPath, copyName);
    }), [withMutation, patchTreeDirs]);

    const distinctCopyQueue = useRef<Promise<void>>(Promise.resolve());
    const writeDistinctCopy = useCallback((parent: FileSystemDirectoryHandle, parentPath: string, name: string,
        data: Blob, isCurrent: () => boolean) => {
        const root = rootHandleRef.current;
        const check = () => {
            if (!root || rootHandleRef.current !== root || !isCurrent()) throw new DOMException('Copy source changed', 'AbortError');
        };
        const copy = distinctCopyQueue.current.then(() => withMutation(async () => {
            check();
            const segments = await root!.resolve(parent);
            check();
            if (!segments || segments.join('/') !== parentPath) throw new Error('The copy folder is no longer in this vault');
            const copyName = await freeEntryName(parent, name);
            check();
            const handle = await parent.getFileHandle(copyName, { create: true });
            await writeAllBytes(handle, data);
            const version = await versionAfterWrite(handle, data);
            if (rootHandleRef.current === root) await patchTreeDirs(root!, [parentPath]);
            return { path: joinVaultPath(parentPath, copyName), name: copyName, handle, version };
        }));
        distinctCopyQueue.current = copy.then(() => {}, () => {});
        return copy;
    }, [withMutation, patchTreeDirs]);

    const recreateFile = useCallback((filePath: string, data: string | Uint8Array | Blob) => withMutation(async () => {
        const root = rootHandleRef.current;
        if (!root) throw new Error('No vault open');
        const parentPath = parentVaultPath(filePath);
        const fileName = filePath.slice(parentPath ? parentPath.length + 1 : 0);
        const { dir, patchFrom } = await ensureDirChain(root, parentPath);
        if (await entryExists(dir, fileName)) return { status: 'exists' as const };

        const handle = await dir.getFileHandle(fileName, { create: true });
        const bytes = data instanceof Blob ? data : toBytes(data);
        await writeAllBytes(handle, bytes);
        const version = await versionAfterWrite(handle, bytes);
        await patchTreeDirs(root, [patchFrom ?? parentPath]);
        return { status: 'written' as const, version, handle };
    }), [withMutation, patchTreeDirs]);

    const resolveFileHandle = useCallback(async (filePath: string) => {
        const root = rootHandleRef.current;
        if (!root || !filePath) return null;
        const names = filePath.split('/');
        const fileName = names.pop() as string;
        try {
            let dir = root;
            for (const name of names) dir = await dir.getDirectoryHandle(name);
            return await dir.getFileHandle(fileName);
        } catch (err) {
            if (isGone(err)) return null;
            throw err;
        }
    }, []);

    const emitVaultChanges = useCallback((batch: VaultChangeBatch) => {
        for (const listener of [...vaultChangeListenersRef.current]) {
            try { listener(batch); } catch (err) { console.error('A vault-change listener threw:', err); }
        }
    }, []);

    const processVaultBatch = useCallback(async (
        root: FileSystemDirectoryHandle,
        batch: VaultChangeBatch,
        isCurrent: () => boolean,
    ): Promise<boolean> => {
        const dirs = batch.rescan ? null : dirtyDirs(batch);
        if (dirs === null || dirs.size > 0) {
            const ticket = ++treeTicketRef.current;
            const base = fileTreeRef.current;
            let next: FileTreeNode[] | null = null;
            if (dirs && dirs.size <= MAX_DIRTY_DIRS) next = await relistDirs(base, root, dirs, touchedPaths(batch));
            if (!next) next = await loadTree(root);

            if (!isCurrent()) return true;
            if (mutationBusyRef.current > 0) return false;
            if (fileTreeRef.current !== base) return false;
            if (next) publishTree(ticket, root, next);
        }
        if (!isCurrent()) return true;
        emitVaultChanges(batch);
        return true;
    }, [loadTree, publishTree, emitVaultChanges]);

    useEffect(() => {
        if (!rootHandle) {
            setLiveDetection('off');
            return;
        }
        const root = rootHandle;
        let cancelled = false;
        const isCurrent = () => !cancelled && rootHandleRef.current === root;

        let queued: VaultChangeBatch | null = null;
        let running = false;
        const pump = async () => {
            if (running) return;
            running = true;
            try {
                while (queued && isCurrent()) {
                    if (mutationBusyRef.current > 0) break;
                    const batch: VaultChangeBatch = queued;
                    queued = null;
                    let finished = true;
                    try {
                        finished = await processVaultBatch(root, batch, isCurrent);
                    } catch (err) {
                        console.error('Could not process outside changes:', err);
                    }
                    if (!finished) queued = queued ? mergeInto(batch, queued) : batch;
                }
            } finally {
                running = false;
            }
        };
        const enqueue = (batch: VaultChangeBatch) => {
            queued = queued ? mergeInto(queued, batch) : batch;
            void pump();
        };
        const coalescer = createBatchCoalescer(enqueue);

        // A macrotask later, not synchronously from the mutation's `finally`: the
        // caller's own continuation (App's retargetTabs after `await moveFile`)
        // runs in a microtask right after, and the batch must land after it.
        const resume = () => { setTimeout(() => { if (isCurrent()) void pump(); }, 0); };
        resumeWatcherRef.current = resume;

        let polling = false;
        let stopPolling: (() => void) | null = null;
        const startPolling = () => {
            if (polling || cancelled) return;
            polling = true;
            setLiveDetection('polling');
            let last = 0;
            const tick = () => {
                if (document.visibilityState !== 'visible') return;
                const now = Date.now();
                if (now - last < POLL_THROTTLE_MS) return;
                last = now;
                enqueue(rescanBatch());
            };
            window.addEventListener('focus', tick);
            document.addEventListener('visibilitychange', tick);
            const timer = setInterval(tick, POLL_INTERVAL_MS);
            stopPolling = () => {
                window.removeEventListener('focus', tick);
                document.removeEventListener('visibilitychange', tick);
                clearInterval(timer);
            };
            tick();
        };

        let observer: FileSystemObserver | null = null;
        let reobserving = false;

        const observe = async (): Promise<boolean> => {
            if (typeof FileSystemObserver !== 'function') return false;
            let obs: FileSystemObserver | null = null;
            try {
                obs = new FileSystemObserver((records, source) => {
                    if (cancelled || source !== observer) return;
                    coalescer.push(normalizeRecords(records));
                    if (records.some(r => r.type === 'errored')) void reobserve();
                });
                observer = obs;
                await obs.observe(root, { recursive: true });
            } catch (err) {
                console.warn('Could not watch the vault for outside changes; falling back to polling:', err);
                obs?.disconnect();
                if (observer === obs) observer = null;
                return false;
            }
            if (cancelled) obs.disconnect();
            return true;
        };

        const reobserve = async () => {
            if (reobserving || cancelled) return;
            reobserving = true;
            await new Promise(resolve => setTimeout(resolve, REOBSERVE_DELAY_MS));
            const stale = observer;
            observer = null;
            stale?.disconnect();
            const ok = cancelled ? false : await observe();
            reobserving = false;
            if (cancelled) return;
            if (ok) enqueue(rescanBatch());
            else startPolling();
        };

        setLiveDetection('off');
        void (async () => {
            const ok = await observe();
            if (cancelled) return;
            if (ok) setLiveDetection('observer');
            else startPolling();
        })();

        return () => {
            cancelled = true;
            coalescer.cancel();
            queued = null;
            observer?.disconnect();
            observer = null;
            stopPolling?.();
            if (resumeWatcherRef.current === resume) resumeWatcherRef.current = null;
        };
    }, [rootHandle, processVaultBatch]);

    /* MEMOIZED, and every value in it is a `useCallback` or a piece of state.
       Without this the provider handed out a new object on every one of its own
       renders — a tree publish, a watcher tick, a `recentVaults` update — and a
       context value's identity goes STRAIGHT THROUGH `React.memo`. DocumentPane
       and PdfPane, both memoized precisely so they do not re-render while the
       reader types, re-rendered anyway. */
    const value: FileSystemContextValue = useMemo(() => ({
        requestIndexPermission,
        handleIO,
        ensureVaultId,
        rootHandle,
        getVaultActivation,
        registerBeforeRootChange,
        resolveVaultDir,
        resolveVaultFile,
        verifyVaultFileIdentity,
        vaultDirExists,
        nameTaken: entryExists,
        fileTree,
        isLoading,
        vaultProblem,
        retryVault,
        previousVault,
        linkedVault,
        recentVaults,
        currentVaultId,
        pickDirectory,
        openRecentVault,
        openFolderAsVault: openVaultHandle,
        openLinkedVault,
        forgetRecentVault,
        pinRecentVault,
        readFile,
        readFileSnapshot,
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
        readFileVersioned,
        readBytesVersioned,
        inspectExportTarget,
        writeNotebookExport,
        statFile: statOf,
        writeFileVersioned,
        writeConflictCopy,
        writeDistinctCopy,
        recreateFile,
        resolveFileHandle,
        subscribeVaultChanges,
        liveDetection,
        keepCopyInGarbage,
        readBoardAsset,
        putBoardAsset,
        writeBoardCopy,
        keepConversionBackup,
        restoreConversionCopy,
        copyTrashFile,
        readLegacyBoardAsset,
    }), [
        rootHandle,
        requestIndexPermission,
        getVaultActivation,
        registerBeforeRootChange,
        fileTree,
        isLoading,
        vaultProblem,
        retryVault,
        previousVault,
        linkedVault,
        recentVaults,
        currentVaultId,
        pickDirectory,
        openRecentVault,
        openVaultHandle,
        openLinkedVault,
        forgetRecentVault,
        pinRecentVault,
        readFile,
        readFileSnapshot,
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
        readFileVersioned,
        readBytesVersioned,
        inspectExportTarget,
        writeNotebookExport,
        writeFileVersioned,
        writeConflictCopy,
        writeDistinctCopy,
        recreateFile,
        resolveFileHandle,
        subscribeVaultChanges,
        liveDetection,
        keepCopyInGarbage,
        readBoardAsset,
        putBoardAsset,
        writeBoardCopy,
        keepConversionBackup,
        restoreConversionCopy,
        copyTrashFile,
        readLegacyBoardAsset,
    ]);

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
