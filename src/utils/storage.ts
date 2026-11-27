import { createLocalStorageMirror } from './localStorageMirror';

export const INDEXED_DB_NAMES = { recoveryJournal: 'bme-recovery-journal' } as const;

export const STORAGE_MIRROR_SENTINEL = 'bme.lsMirror';
const MIRROR_VERSION = '1';
const RESTORE_NOTICE = 'Settings restored after another tab reset them';
const RELOAD_NOTICE_KEY = 'bme.lsMirror.restoreNotice';

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
    'bme.developer', 'bme.whiteboard.engine.drawing', 'bme.whiteboard.engine.notebook',
    'bme.whiteboard.engine.pdfInk', 'bme.whiteboard.emergencyReadOnly.drawing',
    'bme.whiteboard.emergencyReadOnly.notebook', 'bme.whiteboard.emergencyReadOnly.pdfInk',
    'bme.pdf.viewer', 'bme.pdf.platformLayer', 'bme.whiteboard.userDictionary', 'bme.editor.incremental', 'bme.whiteboard.preferences',
    // Migration removals also need tombstones, or an old backup resurrects them.
    'fileScrollPositions', 'openTabPaths', 'openTabGroups', 'openTabGroupFocus',
    'openTabGroupSizes', 'openTabsVaultId', 'activeTabPath', 'lastFilePath',
    STORAGE_MIRROR_SENTINEL,
] as const;
const ownedKeys = new Set<string>(LOCAL_STORAGE_KEYS);
const WORKSPACE_KEYS = new Set<string>([
    'vaultSessions', 'fileScrollAnchors', 'collapsedHeadings', 'canvasViewPositions', 'pdfViewPositions',
    'readerViewState', 'pdfTextViewState', 'expandedPaths', 'vaultAgentDrafts', 'vaultAgentOpenChat',
    'fileScrollPositions', 'openTabPaths', 'openTabGroups', 'openTabGroupFocus', 'openTabGroupSizes',
    'openTabsVaultId', 'activeTabPath', 'lastFilePath',
]);
let startupPuts = 0;
let restoreNotice: string | null = null;
const restoreListeners = new Set<() => void>();
const mirror = createLocalStorageMirror({
    keys: LOCAL_STORAGE_KEYS.filter(key => key !== STORAGE_MIRROR_SENTINEL),
    get: key => localStorage.getItem(key),
    put: (key, value) => { localStorage.setItem(key, value); startupPuts++; },
    hasSentinel: () => localStorage.getItem(STORAGE_MIRROR_SENTINEL) === MIRROR_VERSION,
    stamp: () => { localStorage.setItem(STORAGE_MIRROR_SENTINEL, MIRROR_VERSION); },
    restored: () => {
        restoreNotice = RESTORE_NOTICE;
        for (const listener of restoreListeners) listener();
    },
});

export function isRegisteredStorageKey(key: string): boolean { return ownedKeys.has(key); }

// Session data belongs to one tab, especially terminal IDs; never mirror it across windows.
export function writeSessionValue(key: string, value: string): void { sessionStorage.setItem(key, value); }
export function removeSessionValue(key: string): void { sessionStorage.removeItem(key); }

/** Raw-string reader, null when absent OR when the browser refuses storage access: some policies throw on every
 *  localStorage call (measured: a SecurityError from a settings read during App's first render took the whole
 *  app down), and the app then runs on its defaults. */
export function readStoredValue(key: string): string | null {
    try { return localStorage.getItem(key); } catch { return null; }
}

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

export function takeRestoreNotice(): string | null {
    let notice = restoreNotice;
    restoreNotice = null;
    try {
        if (sessionStorage.getItem(RELOAD_NOTICE_KEY) === '1') {
            sessionStorage.removeItem(RELOAD_NOTICE_KEY);
            notice ??= RESTORE_NOTICE;
        }
    } catch { /* recovery still works when session storage is unavailable */ }
    return notice;
}

export function subscribeRestoreNotice(listener: () => void): () => void {
    restoreListeners.add(listener);
    return () => { restoreListeners.delete(listener); };
}

const RESTORE_DEADLINE_MS = 1500;

export function restoreStorageBeforeRender(): Promise<boolean> | undefined {
    try {
        if (localStorage.getItem(STORAGE_MIRROR_SENTINEL) === MIRROR_VERSION) return;
    } catch (error) {
        console.warn('Browser settings are unavailable:', error);
        return;
    }
    let reloadedForRestore = false;
    try { reloadedForRestore = sessionStorage.getItem(RELOAD_NOTICE_KEY) === '1'; } catch { /* no guard key: mount */ }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'late'>(resolve => { timer = setTimeout(() => resolve('late'), RESTORE_DEADLINE_MS); });
    const restore = mirror.restore(key => !WORKSPACE_KEYS.has(key)).then(() => restoreNotice !== null);
    return Promise.race([restore, late]).then(outcome => {
        clearTimeout(timer);
        let restored = outcome === true;
        if (outcome === 'late') {
            mirror.abandonRestore();
            // Keys already put back are under stores that read the old values at import: reload for them too.
            restored = startupPuts > 0;
            console.warn(`The browser settings backup did not answer within ${RESTORE_DEADLINE_MS} ms; starting with the settings as they are${restored ? ' (reloading once for the ones already restored)' : ''}.`);
        }
        if (restored && reloadedForRestore) {
            console.warn('Browser settings were restored again right after a reload for the same; starting without a second reload.');
            return false;
        }
        if (restored) {
            try { sessionStorage.setItem(RELOAD_NOTICE_KEY, '1'); } catch { /* notice only */ }
        }
        return restored;
    }, error => {
        console.warn('Browser settings could not be restored:', error);
        return false;
    });
}

let recoveryInstalled = false;
export function installStorageRecovery(): () => void {
    if (recoveryInstalled) return () => {};
    recoveryInstalled = true;
    const onStorage = (event: StorageEvent) => {
        if (event.key !== null) return;
        try { if (event.storageArea !== localStorage) return; } catch { return; }
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

export function writeJSON(key: string, value: unknown): boolean {
    try {
        return writeStoredValue(key, JSON.stringify(value));
    } catch (err) {
        console.error(`Failed to persist "${key}":`, err);
        return false;
    }
}

const records = new Map<string, Record<string, unknown>>();

export function readRecord<T>(key: string): Record<string, T> {
    let record = records.get(key);
    if (!record) {
        const stored = readJSON<unknown>(key, {});
        record = stored && typeof stored === 'object' && !Array.isArray(stored)
            ? stored as Record<string, unknown>
            : {};
        records.set(key, record);
    }
    return record as Record<string, T>;
}

export function flushRecord(key: string): boolean {
    const record = records.get(key);
    return record ? writeJSON(key, record) : false;
}

let recordScope = '';

export function setRecordScope(vaultId: string | null): void {
    recordScope = vaultId ?? '';
}

export function scopedKey(path: string): string {
    // U+0000 as the separator: a vault id is a UUID and a path cannot contain a
    // NUL, so the two halves can never be confused. Written as an ESCAPE, never
    // as a literal control character in the source.
    return recordScope ? `${recordScope}\u0000${path}` : path;
}
