// The origin's localStorage is shared with old windows/libraries. Its backup
// deliberately lives in a separate database, not idb-keyval's vault handles.
export interface LocalMirrorAccess {
    keys: readonly string[];
    get: (key: string) => string | null;
    put: (key: string, value: string) => void;
    hasSentinel: () => boolean;
    stamp: () => void;
    restored: (count: number) => void;
}

type Value = string | null; // null is a durable removal, not a missing backup
interface Entry { key: string; value: Value }
const DATABASE = 'bme-local-mirror';
const STORE = 'entries';

export function createLocalStorageMirror(access: LocalMirrorAccess) {
    const owned = new Set(access.keys);
    const pending = new Map<string, Value>();
    let database: Promise<IDBDatabase> | null = null;
    let known = new Map<string, Value>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let tail: Promise<void> = Promise.resolve();
    let generation = 0;
    let warned = false;
    // Set when the startup restore missed its deadline (storage.ts): this page then neither restores nor backs up,
    // and the next load tries again before it renders. A restore landing after the page has read its settings would
    // put keys under stores that already cached the old ones, and the page's next write of such a store (a session
    // record) would overwrite what was just put back.
    let abandoned = false;

    const warn = (error: unknown) => {
        if (!warned) console.warn('Browser settings could not be backed up:', error);
        warned = true;
    };
    const enqueue = (job: () => Promise<void>) => {
        const next = tail.then(job);
        tail = next.catch(warn); // a failed transaction must not poison later writes
        return tail;
    };
    const open = () => {
        if (!database) {
            database = new Promise<IDBDatabase>((resolve, reject) => {
                const request = indexedDB.open(DATABASE, 1);
                let refused = false;
                request.onupgradeneeded = () => {
                    if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'key' });
                };
                request.onerror = () => { database = null; reject(request.error); };
                // Another connection is holding the database through a version change (nothing in this app upgrades
                // it, but an old tab or a pending deletion can): refuse rather than wait, and close the connection
                // if it is granted after all, so nothing is left holding it.
                request.onblocked = () => {
                    refused = true;
                    database = null;
                    reject(new DOMException('The settings backup is held by another connection.', 'InvalidStateError'));
                };
                request.onsuccess = () => {
                    const db = request.result;
                    if (refused) { db.close(); return; }
                    db.onversionchange = event => {
                        db.close();
                        database = null;
                        known.clear();
                        if (event.newVersion === null) {
                            // Browser site-data deletion is the user's real reset:
                            // never re-create its deleted backup from an old queue.
                            generation++;
                            pending.clear();
                            if (timer) clearTimeout(timer);
                            timer = null;
                        }
                    };
                    resolve(db);
                };
            });
        }
        return database;
    };
    const readAll = async () => {
        const db = await open();
        return new Promise<Map<string, Value>>((resolve, reject) => {
            const tx = db.transaction(STORE, 'readonly');
            const request = tx.objectStore(STORE).getAll();
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const values = new Map<string, Value>();
                for (const entry of request.result as Entry[]) {
                    if (entry && owned.has(entry.key) && (typeof entry.value === 'string' || entry.value === null)) values.set(entry.key, entry.value);
                }
                resolve(values);
            };
            tx.onabort = () => reject(tx.error);
        });
    };
    const store = async (values: Map<string, Value>, epoch: number) => {
        if (!values.size || epoch !== generation) return;
        const db = await open();
        if (epoch !== generation) return;
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            const objectStore = tx.objectStore(STORE);
            for (const [key, value] of values) objectStore.put({ key, value } satisfies Entry);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
        if (epoch === generation) for (const [key, value] of values) known.set(key, value);
        warned = false;
    };

    /** `include` limits which missing keys may be put back (the startup restore's preferences-only rule, storage.ts);
     *  every key is still backed up from the live store. */
    const restore = async (include?: (key: string) => boolean) => {
        if (abandoned) return;
        const epoch = generation;
        const values = await readAll(); // one getAll; present keys are checked individually below
        if (epoch !== generation) return;
        const updates = new Map<string, Value>();
        for (const [key, value] of pending) { values.set(key, value); updates.set(key, value); }
        pending.clear();
        known = values;
        let restored = 0;
        for (const key of access.keys) {
            const current = access.get(key);
            const backup = values.get(key);
            if (current !== null) {
                if (backup !== current) updates.set(key, current);
            } else if (typeof backup === 'string' && (!include || include(key))) {
                access.put(key, backup);
                restored++;
            }
        }
        await store(updates, epoch);
        if (epoch !== generation) return;
        access.stamp();
        if (restored) access.restored(restored);
    };
    const flush = async () => {
        if (timer) clearTimeout(timer);
        timer = null;
        if (abandoned) return;
        if (!access.hasSentinel()) { await restore(); return; }
        const epoch = generation;
        const queued = new Map(pending);
        const values = new Map(queued);
        pending.clear();
        // The shared live store may have a newer value than this window's
        // queued write. Never let an older delayed batch put it back.
        for (const key of values.keys()) values.set(key, access.get(key));
        if (!access.hasSentinel()) {
            for (const [key, value] of queued) if (!pending.has(key)) pending.set(key, value);
            await restore();
            return;
        }
        try { await store(values, epoch); }
        catch (error) {
            for (const [key, value] of values) if (!pending.has(key)) pending.set(key, value);
            throw error;
        }
        if (epoch !== generation) return;
        if (!access.hasSentinel()) await restore();
        else access.stamp();
    };
    const reconcile = async () => {
        if (abandoned) return;
        if (!access.hasSentinel()) { await restore(); return; }
        const epoch = generation;
        known = await readAll();
        if (epoch !== generation) return;
        if (!access.hasSentinel()) { await restore(); return; }
        const differences = new Map<string, Value>();
        for (const key of access.keys) {
            const value = access.get(key);
            if (known.get(key) !== value && (value !== null || known.has(key))) differences.set(key, value);
        }
        // A clear during the snapshot is NOT fifty individual removals.
        if (!access.hasSentinel()) { await restore(); return; }
        for (const [key, value] of differences) pending.set(key, value);
        await flush();
    };
    return {
        queue(key: string, value: Value) {
            if (!owned.has(key) || abandoned) return;
            pending.set(key, value);
            if (!timer) timer = setTimeout(() => { timer = null; void enqueue(flush); }, 1000);
        },
        restore: (include?: (key: string) => boolean) => enqueue(() => restore(include)),
        /** Stop restoring and backing up for this page (see `abandoned`); a restore in flight puts nothing more. */
        abandonRestore() {
            abandoned = true;
            generation++;
            pending.clear();
            if (timer) clearTimeout(timer);
            timer = null;
        },
        reconcile: () => enqueue(reconcile),
        flush: () => enqueue(flush),
    };
}
