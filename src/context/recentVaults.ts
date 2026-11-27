import { createStore, get, set, type UseStore } from 'idb-keyval';
import type { RecentVault, StoredVault } from '../types';
import { MAX_STORED_VAULTS } from '../utils/recentVaults';
import { forgetIndex } from './vaultIndex/persistence';

const IDB_KEY = 'recent-vaults';

let queue: Promise<unknown> = Promise.resolve();

function serialize<T>(op: () => Promise<T>): Promise<T> {
    // .then(op, op) — a failed predecessor must not cancel the next mutation.
    const next = queue.then(op, op);
    queue = next.catch(() => undefined);
    return next;
}

function isStoredVault(v: unknown): v is StoredVault {
    const entry = v as StoredVault | null;
    return !!entry
        && typeof entry.id === 'string'
        && typeof entry.name === 'string'
        && !!entry.handle
        && entry.handle.kind === 'directory';
}

const SAME_ENTRY_MS = 3000;

async function sameEntryWithin(stored: FileSystemDirectoryHandle, handle: FileSystemDirectoryHandle): Promise<'same' | 'other' | 'unknown'> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            stored.isSameEntry(handle).then(same => (same ? 'same' as const : 'other' as const), () => 'other' as const),
            new Promise<'unknown'>(resolve => { timer = setTimeout(() => resolve('unknown'), SAME_ENTRY_MS); }),
        ]);
    } finally { clearTimeout(timer); }
}

function newId(): string {
    return crypto.randomUUID?.() ?? `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The list as stored, or a THROW when it cannot be read — never `[]` for "unreadable".
 */
async function readList(): Promise<{ list: StoredVault[]; store: UseStore | undefined }> {
    let lastError: unknown;
    for (const [attempt, delay] of READ_RETRY_DELAYS.entries()) {
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        const store = attempt ? (fallbackStore ??= createStore('keyval-store', 'keyval')) : undefined;
        try {
            const list = await get<StoredVault[]>(IDB_KEY, store);
            if (!Array.isArray(list)) return { list: [], store };
            return { list: list.filter(isStoredVault).sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0)), store };
        } catch (err) {
            lastError = err;
        }
    }
    console.warn('Could not read the recent vault list:', lastError);
    throw lastError;
}
const READ_RETRY_DELAYS = [0, 250, 1000];
let fallbackStore: UseStore | undefined;

export function loadRecentVaults(): Promise<StoredVault[]> {
    return serialize(async () => (await readList()).list);
}

export function rememberVault(handle: FileSystemDirectoryHandle): Promise<{ list: StoredVault[]; id: string }> {
    return serialize(async () => {
        // Unreadable throws, and the vault then runs without an id (nothing is filed under one) rather than under
        // a new one that forks its identity — see readList.
        const { list, store } = await readList();

        const answers = await Promise.all(list.map(vault => sameEntryWithin(vault.handle, handle)));
        const existing = answers.indexOf('same');
        if (existing < 0 && answers.includes('unknown')) {
            throw new Error('A stored vault did not answer whether it is this folder; not recording it under a new id.');
        }

        const entry: StoredVault = {
            id: existing >= 0 ? list[existing].id : newId(),
            name: handle.name,
            handle,
            openedAt: Date.now(),
            // A re-open must not unpin what was pinned.
            ...(existing >= 0 && list[existing].pinned ? { pinned: true } : {}),
        };

        const next = trim([entry, ...list.filter((_, i) => i !== existing)]);
        await set(IDB_KEY, next, store);
        const retained = new Set(next.map(vault => vault.id));
        for (const vault of list) if (!retained.has(vault.id)) void forgetIndex(vault.id);
        return { list: next, id: entry.id };
    });
}

function trim(list: StoredVault[]): StoredVault[] {
    const pinned = list.filter(v => v.pinned);
    const rest = list.filter(v => !v.pinned).slice(0, Math.max(0, MAX_STORED_VAULTS - pinned.length));
    const keep = new Set([...pinned, ...rest]);
    return list.filter(v => keep.has(v));
}

export function setVaultPinned(id: string, pinned: boolean): Promise<StoredVault[]> {
    return serialize(async () => {
        const { list, store } = await readList();
        if (!list.some(v => v.id === id)) return list;
        const next = list.map(v => (v.id === id
            ? (pinned ? { ...v, pinned: true } : (() => { const { pinned: _was, ...rest } = v; return rest; })())
            : v));
        await set(IDB_KEY, next, store);
        return next;
    });
}

export function forgetVault(id: string): Promise<StoredVault[]> {
    return serialize(async () => {
        const { list, store } = await readList();
        const next = list.filter(v => v.id !== id);
        await set(IDB_KEY, next, store);
        void forgetIndex(id);
        return next;
    });
}

async function qualifiedLabel(vault: StoredVault, list: StoredVault[]): Promise<string> {
    let best: string[] | null = null;
    let bestRoot = '';

    for (const other of list) {
        if (other.id === vault.id) continue;
        let segments: string[] | null = null;
        try {
            segments = await other.handle.resolve(vault.handle);
        } catch {
            continue;
        }
        if (!segments?.length) continue;
        if (!best || segments.length < best.length) { best = segments; bestRoot = other.name; }
    }

    if (!best) return vault.name;
    return `${best.length > 1 ? best[best.length - 2] : bestRoot}/${vault.name}`;
}

export function labelVaults(list: StoredVault[]): Promise<RecentVault[]> {
    const seen = new Set<string>();
    const shared = new Set<string>();
    for (const v of list) {
        const key = v.name.toLowerCase();
        if (seen.has(key)) shared.add(key);
        else seen.add(key);
    }

    return Promise.all(list.map(async v => ({
        ...v,
        label: shared.has(v.name.toLowerCase()) ? await qualifiedLabel(v, list) : v.name,
    })));
}

export async function withVaultPaths(
    vaults: RecentVault[],
    root: FileSystemDirectoryHandle,
): Promise<RecentVault[]> {
    return Promise.all(vaults.map(async vault => {
        try {
            const segments = await root.resolve(vault.handle);
            return segments?.length ? { ...vault, vaultPath: segments.join('/') } : vault;
        } catch {
            return vault;
        }
    }));
}
