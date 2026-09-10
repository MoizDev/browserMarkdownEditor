// One stored workspace PER VAULT, so switching vaults and switching back comes
// back to that vault's tabs instead of an empty editor.
//
// This used to be six flat localStorage keys stamped with a single
// `openTabsVaultId`: one session, belonging to whichever vault wrote it last.
// The vault-switch effect empties the workspace, and the persist effect wrote
// that emptiness straight back — so the outgoing vault's session was destroyed
// on the way out, which is exactly why switching back restored nothing. A map
// keyed by vault id has nowhere to lose it: the outgoing vault's entry is
// already on disk and the incoming vault writes a different key.
//
// The key is `StoredVault.id` (utils/recentVaults.ts) — a randomUUID minted per
// folder and re-adopted through `isSameEntry`, so it survives reloads and tells
// apart two vaults whose folders share a name. Forgetting a vault mints a new
// id if it is ever opened again, which is why `pruneSessions` exists.

import { readJSON, readRecord, flushRecord } from './storage';
import { MAX_STORED_VAULTS } from './recentVaults';

/** The one localStorage key this module owns. */
const KEY = 'vaultSessions';

/**
 * One vault's workspace: the flat open-document list, how it was grouped into
 * tabs, which pane each tab was left on, how wide those panes were, and which
 * document had focus. Exactly the five things App's persist effect used to
 * write as five separate localStorage keys — see the migration below.
 */
export interface StoredSession {
    paths: string[];
    groups: string[][];
    focus: string[];
    sizes: (number[] | null)[];
    active: string | null;
}

/* ── Shape guards ──
   localStorage is user-editable and holds whatever an older (or newer) build of
   this app wrote, so nothing read back is trusted. Same posture as
   recentVaults.ts's `isStoredVault` over IndexedDB. A malformed entry reads as
   `null`, i.e. "this vault has no session", rather than reaching restoreLayout
   as an array of who-knows-what. */

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
        && isStringList(s.paths)
        && Array.isArray(s.groups) && s.groups.every(isStringList)
        && isStringList(s.focus)
        && Array.isArray(s.sizes) && s.sizes.every(isSizeRow)
        && (s.active === null || typeof s.active === 'string');
}

/** The live, parsed-once record. `readRecord`'s documented safety condition is
 *  one writer per key, and this module is `vaultSessions`' only one — do not
 *  add a second, or the cache goes stale behind it. */
function sessions(): Record<string, unknown> {
    return readRecord<unknown>(KEY);
}

/* ── Legacy migration, one-way ───────────────────────────────────────────
   The six flat keys (plus `lastFilePath`, the pre-tab-era single file) are read
   once per page load and folded into the map, then deleted. One-way on purpose:
   a per-vault map cannot be written back into flat keys without lying to an
   older build about which vault the session it is reading belongs to. The cost
   is that downgrading loses the stored session — it restores nothing, rather
   than restoring another vault's tabs.
   ─────────────────────────────────────────────────────────────────────── */

const LEGACY_KEYS = [
    'openTabPaths', 'openTabGroups', 'openTabGroupFocus',
    'openTabGroupSizes', 'openTabsVaultId', 'activeTabPath', 'lastFilePath',
];

let migrated = false;

/**
 * Fold the pre-map session into `vaultSessions`, filed under the vault it was
 * stamped with — or, unstamped, under whichever vault is asking, which
 * reproduces the old pass's "a session with no vault stamped on it predates
 * this; restore it as before" rule.
 *
 * Only reached from `readSession`, and that is enough: persistence stays gated
 * until the restore pass has run, and the restore pass reads before it writes.
 */
function migrateLegacy(askingVaultId: string): void {
    if (migrated) return;
    migrated = true;

    try {
        // `openTabPaths` is the tab-era marker; `lastFilePath` alone is a
        // profile from before tabs existed, whose single file the old pass
        // still restored. Either is a session worth carrying over.
        const legacyPaths = localStorage.getItem('openTabPaths');
        const legacyLast = localStorage.getItem('lastFilePath');
        if (legacyPaths === null && legacyLast === null) return;

        // A missing/garbage path list falls back to the single lastFilePath,
        // exactly as the old restore pass did.
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
            } satisfies StoredSession;
            // Only clear the old home once the new one has actually taken. The
            // write can fail for real (quota, a locked-down profile) and
            // flushRecord swallows it, so deleting unconditionally would throw
            // away the ONLY copy of the session on exactly that failure —
            // one-way migration means there is nothing to fall back to. Leaving
            // the legacy keys in place instead costs a retry next load.
            if (!flushRecord(KEY)) {
                delete record[vaultId];   // keep memory and disk agreeing
                return;
            }
        }

        for (const key of LEGACY_KEYS) localStorage.removeItem(key);
    } catch (err) {
        console.warn('Could not migrate the stored tab session:', err);
    }
}

/** This vault's stored workspace, or `null` if it has none (or a malformed one). */
export function readSession(vaultId: string): StoredSession | null {
    migrateLegacy(vaultId);
    const entry = sessions()[vaultId];
    return isStoredSession(entry) ? entry : null;
}

/**
 * Store this vault's workspace.
 *
 * An EMPTY `paths` array is a real session — "I closed everything in this
 * vault" — and must round-trip a switch, so nothing here treats it as "no
 * session" and skips the write.
 */
export function writeSession(vaultId: string, session: StoredSession): void {
    sessions()[vaultId] = session;
    flushRecord(KEY);
}

/**
 * Drop the sessions of vaults that are no longer on the recent list.
 *
 * A forgotten vault mints a fresh id if it is ever opened again, so its entry
 * here is unreachable weight. Sessions are never pruned by STALENESS — a vault
 * you come back to a year later still opens where you left it, the same
 * decision `fileScrollPositions` records.
 */
export function pruneSessions(keepIds: string[]): void {
    // The recent list arrives newest-first and is itself capped at
    // MAX_STORED_VAULTS; slicing it is the backstop against a longer list ever
    // reaching here, and drops the oldest vaults rather than an arbitrary key.
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
