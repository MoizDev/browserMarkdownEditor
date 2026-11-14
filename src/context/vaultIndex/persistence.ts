import type { StoredGraphLayout } from '../../utils/graphLayoutStore';

// A schema bump gets a new database name, so an older app never opens a newer schema.
export const INDEX_SCHEMA = 1;
export const INDEX_EXTRACTOR = 2;
export const INDEX_DATABASE = `bme-vault-index-v${INDEX_SCHEMA}`;
export type IndexLayout = StoredGraphLayout;

const forgotten = new Set<string>();
const forgetChannel = new BroadcastChannel('bme-index-layout');
forgetChannel.addEventListener('message', event => {
    const message = event.data as { vaultId?: unknown; forget?: unknown };
    if (message.forget && typeof message.vaultId === 'string') forgotten.add(message.vaultId);
});

let database: Promise<IDBDatabase> | undefined;
export function openIndexDatabase(): Promise<IDBDatabase> {
    if (database) return database;
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(INDEX_DATABASE, 1);
        request.onupgradeneeded = () => {
            for (const name of ['vaults', 'notes', 'texts', 'layouts']) request.result.createObjectStore(name);
        };
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('Index database is blocked'));
        request.onsuccess = () => {
            void indexedDB.databases().then(databases => {
                for (const entry of databases) {
                    const match = /^bme-vault-index-v(\d+)$/.exec(entry.name ?? '');
                    if (match && Number(match[1]) < INDEX_SCHEMA) indexedDB.deleteDatabase(entry.name!);
                }
            }).catch(() => {});
            const db = request.result;
            db.onversionchange = () => { db.close(); database = undefined; };
            resolve(db);
        };
    });
    database = opening.catch(error => { database = undefined; throw error; });
    return database;
}

export function transactionDone(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error('Index transaction failed'));
    });
}
export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

export async function forgetIndex(vaultKey: string): Promise<void> {
    forgotten.add(vaultKey);
    try {
        const channel = new BroadcastChannel('bme-index-layout');
        channel.postMessage({ vaultId: vaultKey, forget: true });
        channel.close();
        await navigator.locks.request(`bme-index:${vaultKey}`, async () => {
            const db = await openIndexDatabase();
            const tx = db.transaction(['vaults', 'notes', 'texts', 'layouts'], 'readwrite');
            const keyRange = IDBKeyRange.bound([vaultKey, ''], [vaultKey, '\uffff']);
            tx.objectStore('vaults').delete(vaultKey);
            tx.objectStore('notes').delete(keyRange);
            tx.objectStore('texts').delete(keyRange);
            tx.objectStore('layouts').delete(vaultKey);
            await transactionDone(tx);
        });
    } catch { /* Forgetting the recent entry must not fail on cache errors. */ }
}

function validLayout(value: unknown): value is IndexLayout {
    if (!value || typeof value !== 'object') return false;
    const layout = value as IndexLayout;
    return typeof layout.topologySignature === 'string' && Array.isArray(layout.positions)
        && layout.positions.every(p => p && typeof p.path === 'string' && Number.isFinite(p.x) && Number.isFinite(p.y))
        && (layout.alpha === undefined || Number.isFinite(layout.alpha));
}

/** Layout is disposable; a missing, old or corrupt value simply starts a new layout. */
export async function loadLayout(vaultKey: string): Promise<IndexLayout | undefined> {
    if (forgotten.has(vaultKey)) return undefined;
    try {
        const db = await openIndexDatabase();
        const value: unknown = await requestResult(db.transaction('layouts').objectStore('layouts').get(vaultKey));
        if (!value || typeof value !== 'object') return undefined;
        const record = value as { schema?: unknown; extractorVersion?: unknown; layout?: unknown };
        return record.schema === INDEX_SCHEMA && record.extractorVersion === INDEX_EXTRACTOR && validLayout(record.layout)
            ? record.layout : undefined;
    } catch { return undefined; }
}

/** A second window never writes the shared index while the first holds its lock. */
export async function saveLayout(vaultKey: string, layout: IndexLayout): Promise<void> {
    if (!vaultKey || forgotten.has(vaultKey) || !validLayout(layout)) return;
    try {
        const channel = new BroadcastChannel('bme-index-layout');
        channel.postMessage({ vaultId: vaultKey, layout });
        channel.close();
        await navigator.locks.request(`bme-index:${vaultKey}`, { ifAvailable: true }, async lock => {
            if (!lock || forgotten.has(vaultKey)) return;
            const db = await openIndexDatabase();
            const transaction = db.transaction('layouts', 'readwrite');
            transaction.objectStore('layouts').put({ schema: INDEX_SCHEMA, extractorVersion: INDEX_EXTRACTOR, layout }, vaultKey);
            await transactionDone(transaction);
        });
    } catch { /* A cache failure must not affect the graph or the vault. */ }
}
