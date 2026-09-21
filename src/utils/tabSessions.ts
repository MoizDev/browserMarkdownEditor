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
 * One vault's workspace: the flat open-document list, how it was split into
 * columns, which tab each column was left showing, how wide the columns were,
 * and which document had focus. Exactly the five things App's persist effect
 * used to write as five separate localStorage keys — see the migration below.
 *
 * Per-pane back/forward history is deliberately NOT here: it names documents a
 * pane may no longer hold, and a restored pane starts over at its showing tab
 * (see TabPane.history).
 */
export interface StoredSession {
    /** Format version. 1 — written as an ABSENT `v` — is the pre-transposition
     *  shape, where each `groups` row was one TAB's side-by-side panes. */
    v: 2;
    paths: string[];
    /** One row per COLUMN: that column's tabs, in strip order. */
    groups: string[][];
    /** Each column's showing tab, positionally. */
    focus: string[];
    /** The columns' widths, one entry per column. `null` = equal columns. */
    sizes: number[] | null;
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
        && s.v === 2
        && isStringList(s.paths)
        && Array.isArray(s.groups) && s.groups.every(isStringList)
        && isStringList(s.focus)
        && isSizeRow(s.sizes)
        && (s.active === null || typeof s.active === 'string');
}

/**
 * Read a v1 record — one written before panes and tabs swapped axes — as a v2
 * one: ONE column holding every document that was open, focused where it was.
 *
 * Collapsing rather than expanding, because under the new meaning each v1
 * `groups` row would become a COLUMN: a reader with eight ordinary tabs would
 * come back to eight columns, far past MAX_PANES, and the cap would then fold
 * most of them together anyway. What is lost is an arrangement, never a
 * document — and the next persist writes v2, so this runs once.
 */
function migrateV1(entry: unknown): StoredSession | null {
    const s = entry as { paths?: unknown; active?: unknown; v?: unknown } | null;
    // v1 is written as an ABSENT `v`, but accept an explicit 1 too: `localStorage`
    // is user-editable and a hand-written (or later-stamped) legacy record should
    // migrate rather than read as "no session" and silently drop the tabs. A
    // future v3 still falls through to null, which is the point of the check.
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
            // The V1 SHAPE, deliberately: the flat keys are a v1 session by
            // definition, and readSession's migrateV1 turns whatever lands
            // here into v2 on the way out. Writing v2 directly would have to
            // reproduce that transposition in a second place.
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
    // After migrateLegacy, so the flat-key path — which writes the v1 shape it
    // was reading — funnels through the version migration too.
    if (isStoredSession(entry)) return entry;
    return migrateV1(entry);
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
    // The boolean is deliberately dropped here, unlike in migrateLegacy: there
    // is nothing to roll back (the map IS the only home) and nothing to tell,
    // since the app has no place to report "your tabs stopped being
    // remembered". writeJSON has already logged it. If that ever needs
    // surfacing, this is the call site to read.
    flushRecord(KEY);
}

/**
 * Drop the sessions of vaults that are no longer on the recent list.
 *
 * A forgotten vault mints a fresh id if it is ever opened again, so its entry
 * here is unreachable weight. Sessions are never pruned by STALENESS — a vault
 * you come back to a year later still opens where you left it, the same
 * decision `fileScrollAnchors` records.
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
