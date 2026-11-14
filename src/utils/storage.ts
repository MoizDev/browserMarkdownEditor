// Helpers for JSON-encoded localStorage values, so the
// get → parse → fallback / stringify → set idiom lives in one place with
// consistent error handling instead of being hand-rolled at each call site.
import { createLocalStorageMirror } from './localStorageMirror';

export const STORAGE_MIRROR_SENTINEL = 'bme.lsMirror';
const MIRROR_VERSION = '1';

// Exact keys only: the old canvas library shares this origin, but restoring
// its own state could bring back the state that caused its reset screen.
export const LOCAL_STORAGE_KEYS = [
    'theme', 'editorFontSize', 'codeFontSize', 'rainbowBrackets', 'treeFontSize',
    'editorPadding', 'tabSize', 'recentVaultLimit', 'showVaultInTitle', 'caretStyle',
    'caretThickness', 'smoothCaret', 'caretSpeed', 'fontFamily', 'accentColor',
    'codeBlockColor', 'sidebarCollapsed', 'agentPanelOpen', 'terminalOpen', 'agentPanelWidth',
    'terminalHeight', 'vaultAgentChoice', 'vaultAgentUpdateDismissed', 'vaultAgentDrafts',
    'terminalFdaNoticeDismissed', 'vaultAgentOpenChat', 'canvasStylePanelCollapsed',
    'pdfThumbnailsOpen', 'pdfInverted', 'readingPreferences', 'vaultAgentConnectedOnce',
    'agentReplyMode', 'penScale', 'terminalFontFamily', 'terminalFontSize',
    'fileTreeSortOrder', 'fileTreeAutoReveal', 'expandedPaths', 'vaultSessions',
    'fileScrollAnchors', 'collapsedHeadings', 'canvasViewPositions', 'pdfViewPositions',
    'readerViewState', 'pdfTextViewState',
    // Migration removals also need tombstones, or an old backup resurrects them.
    'fileScrollPositions', 'openTabPaths', 'openTabGroups', 'openTabGroupFocus',
    'openTabGroupSizes', 'openTabsVaultId', 'activeTabPath', 'lastFilePath',
    STORAGE_MIRROR_SENTINEL,
] as const;
const ownedKeys = new Set<string>(LOCAL_STORAGE_KEYS);
let restoreNotice: string | null = null;
const restoreListeners = new Set<() => void>();
const mirror = createLocalStorageMirror({
    keys: LOCAL_STORAGE_KEYS.filter(key => key !== STORAGE_MIRROR_SENTINEL),
    get: key => localStorage.getItem(key),
    put: (key, value) => { localStorage.setItem(key, value); },
    hasSentinel: () => localStorage.getItem(STORAGE_MIRROR_SENTINEL) === MIRROR_VERSION,
    stamp: () => { localStorage.setItem(STORAGE_MIRROR_SENTINEL, MIRROR_VERSION); },
    restored: () => {
        restoreNotice = 'Settings restored after another tab reset them';
        for (const listener of restoreListeners) listener();
    },
});

export function isRegisteredStorageKey(key: string): boolean { return ownedKeys.has(key); }

/** Raw-string writer for keys whose readers do not JSON-parse their value. */
export function writeStoredValue(key: string, value: string): boolean {
    if (!ownedKeys.has(key)) { console.error(`Unregistered browser setting: ${key}`); return false; }
    try {
        localStorage.setItem(key, value);
        mirror.queue(key, value);
        return true;
    } catch (error) {
        console.error(`Failed to persist "${key}":`, error);
        return false;
    }
}

export function removeStoredValue(key: string): boolean {
    if (!ownedKeys.has(key)) { console.error(`Unregistered browser setting: ${key}`); return false; }
    try {
        localStorage.removeItem(key);
        mirror.queue(key, null);
        return true;
    } catch (error) {
        console.error(`Failed to remove "${key}":`, error);
        return false;
    }
}

/** Consume once, including a restore completed before App mounted. */
export function takeRestoreNotice(): string | null {
    const notice = restoreNotice;
    restoreNotice = null;
    return notice;
}

export function subscribeRestoreNotice(listener: () => void): () => void {
    restoreListeners.add(listener);
    return () => { restoreListeners.delete(listener); };
}

/** The normal boot pays ONE read, and no IndexedDB work before first render. */
export function restoreStorageBeforeRender(): Promise<void> | undefined {
    try {
        if (localStorage.getItem(STORAGE_MIRROR_SENTINEL) === MIRROR_VERSION) return;
        return mirror.restore();
    } catch (error) {
        console.warn('Browser settings are unavailable:', error);
    }
}

let recoveryInstalled = false;
/** Install once outside React; legacy writers get an off-critical-path snapshot. */
export function installStorageRecovery(): () => void {
    if (recoveryInstalled) return () => {};
    recoveryInstalled = true;
    const onStorage = (event: StorageEvent) => {
        if (event.key !== null) return;
        try { if (event.storageArea !== localStorage) return; } catch { return; }
        // A newer write may already have replaced the sentinel. The event is
        // still proof of a clear, so restore per key regardless of its value.
        void mirror.restore();
    };
    const onHidden = () => { if (document.visibilityState === 'hidden') void mirror.reconcile(); };
    const onPageHide = () => { void mirror.reconcile(); };
    window.addEventListener('storage', onStorage);
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('pagehide', onPageHide);
    let idle: number | undefined;
    let fallback: ReturnType<typeof setTimeout> | undefined;
    let secondFrame: number | undefined;
    const firstFrame = requestAnimationFrame(() => {
        secondFrame = requestAnimationFrame(() => {
            if (typeof requestIdleCallback === 'function') idle = requestIdleCallback(() => { void mirror.reconcile(); }, { timeout: 1000 });
            else fallback = setTimeout(() => { void mirror.reconcile(); }, 0);
        });
    });
    return () => {
        recoveryInstalled = false;
        window.removeEventListener('storage', onStorage);
        document.removeEventListener('visibilitychange', onHidden);
        window.removeEventListener('pagehide', onPageHide);
        cancelAnimationFrame(firstFrame);
        if (secondFrame !== undefined) cancelAnimationFrame(secondFrame);
        if (idle !== undefined) cancelIdleCallback(idle);
        if (fallback !== undefined) clearTimeout(fallback);
    };
}

/** Read and JSON-parse a localStorage value, returning `fallback` if it's
 *  missing, null, or unparseable. */
export function readJSON<T>(key: string, fallback: T): T {
    try {
        const raw = localStorage.getItem(key);
        if (raw === null) return fallback;
        const parsed = JSON.parse(raw);
        return (parsed ?? fallback) as T;
    } catch {
        return fallback;
    }
}

/** JSON-stringify and persist a value to localStorage. Reports whether it
 *  landed — quota and private-mode failures are swallowed here, and a caller
 *  that is about to DELETE the value's old home (tabSessions' one-way legacy
 *  migration) has to know the new one actually took. */
export function writeJSON(key: string, value: unknown): boolean {
    try {
        return writeStoredValue(key, JSON.stringify(value));
    } catch (err) {
        console.error(`Failed to persist "${key}":`, err);
        return false;
    }
}

/* ── Cached record accessors ──
   For the path-keyed records that are written on a debounce
   (fileScrollAnchors, pdfViewPositions, collapsedHeadings). The first two
   used to do a full getItem + JSON.parse of the ENTIRE record, mutate one key,
   then stringify the whole thing again — every 300-400ms for as long as the
   user was scrolling, synchronously on the main thread, over a record that
   grows by one entry per file ever opened.

   Holding the parsed object in memory removes the repeated parse entirely; the
   write is unchanged. Each key has one writer in this window. Recovery repairs
   missing backing keys without discarding the live window's record objects;
   ordinary cross-window edits retain their existing last-writer semantics. */

const records = new Map<string, Record<string, unknown>>();

/** The live, mutable record for `key`, parsed at most once per session. */
export function readRecord<T>(key: string): Record<string, T> {
    let record = records.get(key);
    if (!record) {
        const stored = readJSON<unknown>(key, {});
        // readJSON only falls back when the JSON is unparseable. localStorage is
        // user-editable, so `"hello"`, `42` and `[1,2,3]` all parse fine and
        // then reach callers that MUTATE the result. Measured on the three:
        // `record[key] = value` throws TypeError on a primitive in strict mode
        // (which every module here is), taking out whichever handler was
        // writing — a scroll flush, a PDF position, a session write; the ARRAY
        // throws nothing at all and is the quieter bug, since the assignment
        // succeeds and JSON.stringify then silently drops the entry, so
        // positions look saved and never come back. `delete` is innocent on all
        // three (a missing property on a boxed primitive is a no-op), so the
        // assignments are what this guard is for. A record is an object and not
        // an array, or it is nothing.
        record = stored && typeof stored === 'object' && !Array.isArray(stored)
            ? stored as Record<string, unknown>
            : {};
        records.set(key, record);
    }
    return record as Record<string, T>;
}

/** Persist the in-memory record for `key` (after mutating it in place).
 *  Reports whether the write landed, for the same reason writeJSON does. */
export function flushRecord(key: string): boolean {
    const record = records.get(key);
    return record ? writeJSON(key, record) : false;
}

/* ── The vault a path-keyed record entry belongs to ──
   Path-keyed records are keyed by a VAULT-RELATIVE path, and two vaults share
   paths freely — `Notes/index.md` names a different file in each. That was a
   theoretical collision while a switch emptied the workspace for good; per-vault
   tab sessions make "the same path open in two vaults" routine, so switching
   back would scroll a note to an offset measured in a different file.

   Everything else in the app drops its per-vault caches on a switch
   (clearLinkCache, the search cache, the object-URL registry); these records
   deliberately OUTLIVE the session instead, so they carry the vault in the key
   rather than being cleared.

   Two costs, both accepted rather than overlooked:

   · Every entry written BEFORE this scoping is keyed by the bare path, and
     nothing reads those any more — so the first load of a build with this in it
     drops every remembered scroll offset and PDF page, once, and leaves the
     dead entries behind (nothing prunes these). Not migrated on purpose: the
     only vault they could be attributed to is whichever one happens to open
     first, and filing another vault's offsets under it would be a new bug in
     place of a one-time reset.

   · The bare-path fallback below is NOT the failure mode it looks like.
     `currentVaultId` is assigned in exactly one place (FileSystemContext's
     recordVault) and is never reset to null, so "no id" only ever means "the
     first vault of this page load has not been recorded yet". A LATER vault
     whose recordVault throws leaves the scope pointing at the vault before it,
     not at the bare path, and files its positions there — the collision this
     scoping exists to prevent, arriving through the one path that cannot be
     gated from here. Nulling the id in that catch would fix it and clear the
     address bar mid-open (see App's URL writer, which reads exactly that), so
     it is left as the rarer of the two. */

let recordScope = '';

/** Point the path-keyed records at `vaultId`'s entries. */
export function setRecordScope(vaultId: string | null): void {
    recordScope = vaultId ?? '';
}

/** `path` as it is keyed inside a path-keyed record, under the open vault. */
export function scopedKey(path: string): string {
    // U+0000 as the separator: a vault id is a UUID and a path cannot contain a
    // NUL, so the two halves can never be confused. Written as an ESCAPE, never
    // as a literal control character in the source.
    return recordScope ? `${recordScope}\u0000${path}` : path;
}
