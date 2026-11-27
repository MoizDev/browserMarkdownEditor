import { INDEXED_DB_NAMES } from './storage';
import { requestPersistentStorage } from './storagePersistence';

export type RecoveryCopy = string | Uint8Array | Blob | { kind: 'recipe'; payload: unknown };

export interface RecoveryEntry {
    vaultId: string;
    journalId: string;
    path: string;
    fingerprint: string;
    kind: string;
    revision: number;
    updatedAt: number;
    payload: unknown;
    copy: RecoveryCopy;
    mediaRefs: string[];
    copyOnly?: boolean;
}

let database: Promise<IDBDatabase> | undefined;
function open(): Promise<IDBDatabase> {
    if (!database) {
        database = new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(INDEXED_DB_NAMES.recoveryJournal, 1);
            request.onupgradeneeded = () => {
                const entries = request.result.createObjectStore('entries', { keyPath: ['vaultId', 'journalId'] });
                entries.createIndex('vault', 'vaultId');
                entries.createIndex('path', ['vaultId', 'path']);
            };
            request.onsuccess = () => {
                const db = request.result;
                db.onversionchange = () => { db.close(); database = undefined; };
                resolve(db);
            };
            request.onerror = () => reject(request.error);
            request.onblocked = () => reject(new Error('Recovery journal database is blocked'));
        }).catch(error => { database = undefined; throw error; });
    }
    return database;
}

function done(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error ?? new Error('Recovery journal transaction aborted'));
        tx.onerror = () => { /* onabort reports the transaction's final outcome */ };
    });
}

let persistence: Promise<unknown> | undefined;
function requestDurability(): void {
    persistence ??= requestPersistentStorage();
}

export function newJournalId(): string { return crypto.randomUUID(); }

const known = new Map<string, { revision: number; copyOnly: boolean }>();
const knownKey = (vaultId: string, journalId: string) => JSON.stringify([vaultId, journalId]);
let leaving = false;

export function markLeaving(): void {
    leaving = true;
    setTimeout(() => { leaving = false; });
}

/** Atomic per-key revision comparison prevents a late checkpoint replacing a newer one. */
export async function writeRecoveryEntry(entry: RecoveryEntry): Promise<void> {
    const db = await open();
    const id = knownKey(entry.vaultId, entry.journalId);
    if (leaving) {
        const prior = known.get(id);
        if (prior && prior.revision > entry.revision) return;
        const tx = db.transaction('entries', 'readwrite');
        const finished = done(tx);
        tx.objectStore('entries').put(prior?.copyOnly ? { ...entry, copyOnly: true } : entry);
        tx.commit();
        await finished;
        known.set(id, { revision: entry.revision, copyOnly: !!prior?.copyOnly });
        return;
    }
    const tx = db.transaction('entries', 'readwrite');
    const finished = done(tx);
    const store = tx.objectStore('entries');
    const request = store.get([entry.vaultId, entry.journalId]);
    request.onsuccess = () => {
        const old = request.result as RecoveryEntry | undefined;
        if (!old || old.revision <= entry.revision) store.put(old?.copyOnly ? { ...entry, copyOnly: true } : entry);
        known.set(id, old && old.revision > entry.revision
            ? { revision: old.revision, copyOnly: !!old.copyOnly }
            : { revision: entry.revision, copyOnly: !!old?.copyOnly });
    };
    await finished;
    requestDurability();
}

/** An acknowledgement cannot erase or rebase a newer checkpoint. */
export async function acknowledgeRecovery(vaultId: string, journalId: string, revision: number): Promise<void> {
    const db = await open();
    const tx = db.transaction('entries', 'readwrite');
    const finished = done(tx);
    const store = tx.objectStore('entries');
    const request = store.get([vaultId, journalId]);
    request.onsuccess = () => {
        const entry = request.result as RecoveryEntry | undefined;
        if (!entry) return;
        if (entry.revision <= revision) store.delete([vaultId, journalId]);
    };
    await finished;
}

export async function listRecovery(vaultId: string): Promise<RecoveryEntry[]> {
    const db = await open();
    const tx = db.transaction('entries', 'readonly');
    const finished = done(tx);
    const request = tx.objectStore('entries').index('vault').getAll(vaultId);
    await finished;
    return request.result as RecoveryEntry[];
}

export async function markRecoveryCopies(vaultId: string, ids: readonly string[]): Promise<void> {
    if (!ids.length) return;
    const db = await open();
    const tx = db.transaction('entries', 'readwrite');
    const finished = done(tx);
    const store = tx.objectStore('entries');
    for (const id of ids) {
        const request = store.get([vaultId, id]);
        request.onsuccess = () => {
            const entry = request.result as RecoveryEntry | undefined;
            if (entry && !entry.copyOnly) store.put({ ...entry, copyOnly: true });
        };
    }
    await finished;
}

/** Explicit discard; never used to make room or to resolve a path collision. */
export async function discardRecovery(vaultId: string, journalId: string, revision?: number): Promise<void> {
    const db = await open();
    const tx = db.transaction('entries', 'readwrite');
    const finished = done(tx);
    const store = tx.objectStore('entries');
    if (revision === undefined) store.delete([vaultId, journalId]);
    else {
        const request = store.get([vaultId, journalId]);
        request.onsuccess = () => {
            const entry = request.result as RecoveryEntry | undefined;
            if (entry && entry.revision !== revision) tx.abort();
            else if (entry) store.delete([vaultId, journalId]);
        };
    }
    await finished;
}

export async function forgetRecoveryVault(vaultId: string): Promise<void> {
    const db = await open();
    const tx = db.transaction('entries', 'readwrite');
    const finished = done(tx);
    const request = tx.objectStore('entries').index('vault').openCursor(IDBKeyRange.only(vaultId));
    request.onsuccess = () => { const cursor = request.result; if (cursor) { cursor.delete(); cursor.continue(); } };
    await finished;
}

function moved(path: string, from: string, to: string, folder: boolean): string {
    if (path === from) return to;
    return folder && path.startsWith(`${from}/`) ? to + path.slice(from.length) : path;
}

/** In one transaction re-point records and references; collisions never overwrite another journal. */
export async function retargetRecovery(vaultId: string, from: string, to: string, folder: boolean): Promise<void> {
    const db = await open();
    const tx = db.transaction('entries', 'readwrite');
    const finished = done(tx);
    const request = tx.objectStore('entries').index('vault').openCursor(IDBKeyRange.only(vaultId));
    request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const entry = cursor.value as RecoveryEntry;
        const path = moved(entry.path, from, to, folder);
        const mediaRefs = entry.mediaRefs.map(ref => moved(ref, from, to, folder));
        if (path !== entry.path || mediaRefs.some((ref, i) => ref !== entry.mediaRefs[i])) cursor.update({ ...entry, path, mediaRefs });
        cursor.continue();
    };
    await finished;
}
