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

import { get, set } from 'idb-keyval';
import type { RecentVault, StoredVault } from '../types';

const IDB_KEY = 'recent-vaults';

/** Hard cap on the stored list, so it can't grow without bound across a
 *  lifetime of vault-hopping. The user's "Recent vaults shown" setting decides
 *  how many of these the menu prints, and it can be raised up to this cap —
 *  which is why the store deliberately keeps more entries than the default. */
export const MAX_STORED_VAULTS = 30;

/** How many recent vaults the menu lists until the user says otherwise. */
export const DEFAULT_RECENT_VAULT_LIMIT = 10;

/** Clamp the persisted "Recent vaults shown" setting. localStorage is
 *  user-editable and a NaN would reach `Array.prototype.slice`. */
export function clampRecentVaultLimit(n: number): number {
    if (!Number.isFinite(n)) return DEFAULT_RECENT_VAULT_LIMIT;
    return Math.min(MAX_STORED_VAULTS, Math.max(1, Math.round(n)));
}

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
}

function newId(): string {
    // randomUUID needs a secure context; this app is served over https/localhost
    // (the File System Access API requires it too), but never fail over an id.
    return crypto.randomUUID?.() ?? `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

async function readList(): Promise<StoredVault[]> {
    try {
        const list = await get<StoredVault[]>(IDB_KEY);
        if (!Array.isArray(list)) return [];
        // Newest first. The writes below already unshift, so this only matters
        // if a record ever lands out of order.
        return list.filter(isStoredVault).sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0));
    } catch (err) {
        console.warn('Could not read the recent vault list:', err);
        return [];
    }
}

/** Every folder ever opened as a vault, newest first. */
export function loadRecentVaults(): Promise<StoredVault[]> {
    return serialize(readList);
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
        const list = await readList();

        let existing = -1;
        for (let i = 0; i < list.length; i++) {
            try {
                if (await list[i].handle.isSameEntry(handle)) { existing = i; break; }
            } catch {
                // A handle that can't answer is one we can't match on — skip it
                // rather than abandon the whole record.
            }
        }

        // The freshly-picked handle replaces the stored one: it is the object
        // permission was just granted against, and its `name` picks up a folder
        // that was renamed on disk since it was last opened.
        const entry: StoredVault = {
            id: existing >= 0 ? list[existing].id : newId(),
            name: handle.name,
            handle,
            openedAt: Date.now(),
        };

        const next = [entry, ...list.filter((_, i) => i !== existing)].slice(0, MAX_STORED_VAULTS);
        await set(IDB_KEY, next);
        return { list: next, id: entry.id };
    });
}

/** Drop one vault from the list — used when its folder turns out to be gone. */
export function forgetVault(id: string): Promise<StoredVault[]> {
    return serialize(async () => {
        const next = (await readList()).filter(v => v.id !== id);
        await set(IDB_KEY, next);
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
