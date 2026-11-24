// The list of folders the user has opened as vaults, persisted in IndexedDB
// beside the current vault's handle (FileSystemContext's `vault-directory-handle`).
//
// A "vault" is just a folder, so ~/Notes and ~/Notes/mathnotes are two vaults
// even though one contains the other — nesting says nothing about whether a
// folder was ever opened in its own right.
//
// Directory handles are structured-cloneable, so the handle itself is what gets
// stored: re-opening a vault from this list needs the real handle, and there is
// no path to rebuild one from (see NAMES below).

import { createStore, get, set, type UseStore } from 'idb-keyval';
import type { RecentVault, StoredVault } from '../types';
import { MAX_STORED_VAULTS } from '../utils/recentVaults';
import { forgetIndex } from './vaultIndex/persistence';

const IDB_KEY = 'recent-vaults';

/**
 * IDB mutations run one at a time.
 *
 * Every mutation is read-modify-write, and two of them overlap for real:
 * React.StrictMode runs the provider's mount effect twice, so the restored
 * vault is recorded twice concurrently. Interleaved, both calls read the same
 * list, both mint a fresh id for the same folder, and the second write wins —
 * leaving the id the provider is holding as "the current vault" absent from
 * storage. Serialized, the second call sees the first one's entry and adopts
 * its id, which is what makes rememberVault idempotent.
 */
let queue: Promise<unknown> = Promise.resolve();

function serialize<T>(op: () => Promise<T>): Promise<T> {
    // .then(op, op) — a failed predecessor must not cancel the next mutation.
    const next = queue.then(op, op);
    queue = next.catch(() => undefined);
    return next;
}

/** Shape guard: IndexedDB holds whatever an older build of this app wrote. */
function isStoredVault(v: unknown): v is StoredVault {
    const entry = v as StoredVault | null;
    return !!entry
        && typeof entry.id === 'string'
        && typeof entry.name === 'string'
        && !!entry.handle
        && entry.handle.kind === 'directory';
    // `pinned` is deliberately not checked: an older build wrote entries
    // without it, and a newer one may write keys this build has never heard of.
    // Both read back as "not pinned" rather than as a broken record.
}

/** How long one stored handle may take to say whether it is the folder being opened. */
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
    // randomUUID needs a secure context; this app is served over https/localhost
    // (the File System Access API requires it too), but never fail over an id.
    return crypto.randomUUID?.() ?? `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The list as stored, or a THROW when it cannot be read — never `[]` for "unreadable".
 *
 * Every mutation below writes back what it read, so an unreadable list taken for an empty one was destructive:
 * `rememberVault` then minted a fresh id for the open vault and wrote a one-entry list over the whole history,
 * orphaning that vault's saved tabs and every record kept under its id, and the session pruning that follows a
 * list change deleted every other vault's saved tabs (measured: one failed `get` on reload → new id, the vault's
 * three saved tabs gone for good, its session pruned). So a failed read is retried, the second time over a
 * connection of its own (a connection the browser has closed keeps failing until it is replaced), and only a
 * missing or malformed record reads as empty. The connection is opened without a version, as idb-keyval's own:
 * an explicit version would wait behind every older tab that holds the database, and those cannot release it.
 */
async function readList(): Promise<{ list: StoredVault[]; store: UseStore | undefined }> {
    let lastError: unknown;
    for (const [attempt, delay] of READ_RETRY_DELAYS.entries()) {
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        const store = attempt ? (fallbackStore ??= createStore('keyval-store', 'keyval')) : undefined;
        try {
            const list = await get<StoredVault[]>(IDB_KEY, store);
            if (!Array.isArray(list)) return { list: [], store };
            // Newest first. The writes below already unshift, so this only matters
            // if a record ever lands out of order.
            return { list: list.filter(isStoredVault).sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0)), store };
        } catch (err) {
            lastError = err;
        }
    }
    console.warn('Could not read the recent vault list:', lastError);
    throw lastError;
}
const READ_RETRY_DELAYS = [0, 250, 1000];
/** One spare connection for the retries, opened on the first failure and kept (a connection per retry would leak). */
let fallbackStore: UseStore | undefined;

/** Every folder ever opened as a vault, newest first. */
export function loadRecentVaults(): Promise<StoredVault[]> {
    return serialize(async () => (await readList()).list);
}

/**
 * Record `handle` as the most recently opened vault and return the updated list
 * plus that vault's id (a fresh one, or the id it already had).
 *
 * Identity is `isSameEntry`, which is the only reliable test available: two
 * handles for one folder are distinct objects (a reload deserializes a new one
 * from IndexedDB, and a re-pick mints another), and names collide freely across
 * folders. So the same folder re-opened moves up the list instead of doubling.
 */
export function rememberVault(handle: FileSystemDirectoryHandle): Promise<{ list: StoredVault[]; id: string }> {
    return serialize(async () => {
        // Unreadable throws, and the vault then runs without an id (nothing is filed under one) rather than under
        // a new one that forks its identity — see readList.
        const { list, store } = await readList();

        // Asked of every stored vault at once, each with a deadline: one stored handle on a volume that never
        // answers (measured with an injected never-settling isSameEntry) held the queue — and with it the open
        // vault's id and every later list change — for good. A handle that throws can't match and is skipped, as
        // before; one that does not ANSWER might be this very folder, so if no other entry matched, the vault is
        // left without an id for this load rather than given a new one (which would orphan its saved tabs).
        const answers = await Promise.all(list.map(vault => sameEntryWithin(vault.handle, handle)));
        const existing = answers.indexOf('same');
        if (existing < 0 && answers.includes('unknown')) {
            throw new Error('A stored vault did not answer whether it is this folder; not recording it under a new id.');
        }

        // The freshly-picked handle replaces the stored one: it is the object
        // permission was just granted against, and its `name` picks up a folder
        // that was renamed on disk since it was last opened.
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

/**
 * The stored list, capped — but counting only the vaults the cap is FOR.
 *
 * Pinned entries are kept whatever happens and in their existing order, and the
 * cap is then spent on the rest. A user who pins more vaults than the cap keeps
 * all of them: they asked for each one by name, which is the opposite of the
 * runaway the cap guards against.
 */
function trim(list: StoredVault[]): StoredVault[] {
    const pinned = list.filter(v => v.pinned);
    const rest = list.filter(v => !v.pinned).slice(0, Math.max(0, MAX_STORED_VAULTS - pinned.length));
    // Rebuilt in the ORIGINAL order, not pinned-first: this is the storage
    // order (newest first), and where the menu puts a pinned row is the menu's
    // business — see SidebarFooter.
    const keep = new Set([...pinned, ...rest]);
    return list.filter(v => keep.has(v));
}

/** Pin or unpin one vault, and return the list as it now stands. */
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

/**
 * Drop one vault from the list and return what is left. The folder itself is
 * untouched: this list is only a record of what was opened, so the vault comes
 * straight back the next time it is.
 */
export function forgetVault(id: string): Promise<StoredVault[]> {
    return serialize(async () => {
        const { list, store } = await readList();
        const next = list.filter(v => v.id !== id);
        await set(IDB_KEY, next, store);
        void forgetIndex(id);
        return next;
    });
}

/* ── NAMES ────────────────────────────────────────────────────────────────
 * A vault is listed by its folder name alone, and only a folder name that two
 * vaults share is qualified with its parent ("school/math" vs "work/math").
 *
 * The parent has to be DERIVED, because the File System Access API hands out no
 * path: a directory handle exposes `name` (the basename) and nothing above it —
 * deliberately, since a path is itself information about the user's disk. The
 * one thing it does expose is ancestry BETWEEN two handles we already hold:
 * `a.resolve(b)` returns b's path segments relative to a, or null if b isn't
 * inside a. So a duplicate can be qualified whenever some other known vault
 * contains it — which covers exactly the case that produces most duplicates
 * here, opening sub-folders of a vault as vaults of their own.
 *
 * Two same-named folders with no opened vault above either of them therefore
 * both list as the bare name. There is no API that would do better, so the row
 * says what is actually known rather than inventing a qualifier.
 * ───────────────────────────────────────────────────────────────────────── */

/** `parent/name`, using the deepest known vault that contains this one. */
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
        // null = unrelated; [] = the same folder (a duplicate entry).
        if (!segments?.length) continue;
        // Fewest segments = closest ancestor = the most accurate parent name.
        if (!best || segments.length < best.length) { best = segments; bestRoot = other.name; }
    }

    if (!best) return vault.name;
    // The last segment is the vault itself, so its parent is the one before it —
    // or, when the ancestor IS the parent, that ancestor's own name.
    return `${best.length > 1 ? best[best.length - 2] : bestRoot}/${vault.name}`;
}

/**
 * Attach each vault's menu label. Resolving ancestry is a handle round-trip per
 * candidate pair, so it runs only for names that actually collide — which is
 * almost never, leaving this a plain map in the common case.
 */
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

/**
 * Note where each vault sits INSIDE the open one, when it does.
 *
 * A vault is just a folder, and the folders people open as vaults are usually
 * folders of the vault they are already in — so most rows in the vault menu
 * name something the file tree is also showing, icon and all. `resolve` is the
 * only thing the File System Access API offers here (see NAMES above): it
 * answers "where is b inside a", or null when b is not inside a at all.
 *
 * One handle round trip per vault, on a list that changes only when a vault is
 * opened or forgotten — not on the tree walk, which runs after every save.
 */
export async function withVaultPaths(
    vaults: RecentVault[],
    root: FileSystemDirectoryHandle,
): Promise<RecentVault[]> {
    return Promise.all(vaults.map(async vault => {
        try {
            const segments = await root.resolve(vault.handle);
            // [] means "this IS the root", which has no entry of its own to
            // carry a look; null means it is somewhere else entirely.
            return segments?.length ? { ...vault, vaultPath: segments.join('/') } : vault;
        } catch {
            return vault;
        }
    }));
}
