import { readJSON, readRecord, flushRecord, removeStoredValue } from './storage';
import { MAX_STORED_VAULTS } from './recentVaults';

const KEY = 'vaultSessions';

export interface StoredSession {
    v: 2;
    paths: string[];
    groups: string[][];
    focus: string[];
    sizes: number[] | null;
    active: string | null;
}

function isStringList(v: unknown): v is string[] {
    return Array.isArray(v) && v.every(s => typeof s === 'string');
}

function isSizeRow(v: unknown): v is number[] | null {
    return v === null || (Array.isArray(v) && v.every(n => typeof n === 'number' && Number.isFinite(n)));
}

function isStoredSession(v: unknown): v is StoredSession {
    const s = v as StoredSession | null;
    return !!s
        && typeof s === 'object'
        && s.v === 2
        && isStringList(s.paths)
        && Array.isArray(s.groups) && s.groups.every(isStringList)
        && isStringList(s.focus)
        && isSizeRow(s.sizes)
        && (s.active === null || typeof s.active === 'string');
}

function migrateV1(entry: unknown): StoredSession | null {
    const s = entry as { paths?: unknown; active?: unknown; v?: unknown } | null;
    if (!s || typeof s !== 'object' || (s.v !== undefined && s.v !== 1)) return null;
    if (!isStringList(s.paths)) return null;
    const active = typeof s.active === 'string' ? s.active : null;
    return {
        v: 2,
        paths: s.paths,
        groups: s.paths.length ? [s.paths] : [],
        focus: s.paths.length ? [active && s.paths.includes(active) ? active : s.paths[0]] : [],
        sizes: null,
        active,
    };
}

/** The live, parsed-once record. `readRecord`'s documented safety condition is
 *  one writer per key, and this module is `vaultSessions`' only one — do not
 *  add a second, or the cache goes stale behind it. */
function sessions(): Record<string, unknown> {
    return readRecord<unknown>(KEY);
}

const LEGACY_KEYS = [
    'openTabPaths', 'openTabGroups', 'openTabGroupFocus',
    'openTabGroupSizes', 'openTabsVaultId', 'activeTabPath', 'lastFilePath',
];

let migrated = false;

function migrateLegacy(askingVaultId: string): void {
    if (migrated) return;
    migrated = true;

    try {
        const legacyPaths = localStorage.getItem('openTabPaths');
        const legacyLast = localStorage.getItem('lastFilePath');
        if (legacyPaths === null && legacyLast === null) return;

        const stored = readJSON<unknown>('openTabPaths', null);
        const paths = isStringList(stored) ? stored : (legacyLast ? [legacyLast] : []);

        const groups = readJSON<unknown>('openTabGroups', null);
        const focus = readJSON<unknown>('openTabGroupFocus', null);
        const sizes = readJSON<unknown>('openTabGroupSizes', null);

        const vaultId = localStorage.getItem('openTabsVaultId') || askingVaultId;
        const record = sessions();
        // Never over an entry the new format already holds: the map is the
        // truth the moment it has anything to say about a vault.
        if (!(vaultId in record)) {
            record[vaultId] = {
                paths,
                groups: Array.isArray(groups) && groups.every(isStringList) ? groups : [],
                focus: isStringList(focus) ? focus : [],
                sizes: Array.isArray(sizes) && sizes.every(isSizeRow) ? sizes : [],
                active: localStorage.getItem('activeTabPath'),
            };
            // Only clear the old home once the new one has actually taken. The
            // write can fail for real (quota, a locked-down profile) and
            // flushRecord swallows it, so deleting unconditionally would throw
            // away the ONLY copy of the session on exactly that failure —
            // one-way migration means there is nothing to fall back to. Leaving
            // the legacy keys in place instead costs a retry next load.
            if (!flushRecord(KEY)) {
                delete record[vaultId];
                return;
            }
        }

        for (const key of LEGACY_KEYS) removeStoredValue(key);
    } catch (err) {
        console.warn('Could not migrate the stored tab session:', err);
    }
}

export function readSession(vaultId: string): StoredSession | null {
    migrateLegacy(vaultId);
    const entry = sessions()[vaultId];
    if (isStoredSession(entry)) return entry;
    return migrateV1(entry);
}

export function writeSession(vaultId: string, session: StoredSession): void {
    sessions()[vaultId] = session;
    flushRecord(KEY);
}

export function pruneSessions(keepIds: string[]): void {
    const keep = new Set(keepIds.slice(0, MAX_STORED_VAULTS));
    const record = sessions();
    let changed = false;
    for (const id of Object.keys(record)) {
        if (keep.has(id)) continue;
        delete record[id];
        changed = true;
    }
    if (changed) flushRecord(KEY);
}
