// Helpers for JSON-encoded localStorage values, so the
// get → parse → fallback / stringify → set idiom lives in one place with
// consistent error handling instead of being hand-rolled at each call site.

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
        localStorage.setItem(key, JSON.stringify(value));
        return true;
    } catch (err) {
        console.error(`Failed to persist "${key}":`, err);
        return false;
    }
}

/* ── Cached record accessors ──
   For the two path-keyed records that are written on a scroll debounce
   (fileScrollPositions, pdfViewPositions). Both used to do a full
   getItem + JSON.parse of the ENTIRE record, mutate one key, then stringify the
   whole thing again — every 300-400ms for as long as the user was scrolling,
   synchronously on the main thread, over a record that grows by one entry per
   file ever opened.

   Holding the parsed object in memory removes the repeated parse entirely; the
   write is unchanged. Safe because each key has exactly one writer in the app,
   so nothing else can modify the stored value behind this cache's back. */

const records = new Map<string, Record<string, unknown>>();

/** The live, mutable record for `key`, parsed at most once per session. */
export function readRecord<T>(key: string): Record<string, T> {
    let record = records.get(key);
    if (!record) {
        const stored = readJSON<unknown>(key, {});
        // readJSON only falls back when the JSON is unparseable. localStorage is
        // user-editable, so `"hello"`, `42` and `[1,2,3]` all parse fine and
        // then reach callers that MUTATE the result: `delete record[id]` on a
        // String object throws in strict mode, and every caller of this is
        // inside a React effect, so that threw before the first paint and left
        // an empty #root that no reload could clear (the bad value is still
        // there). A record is an object and not an array, or it is nothing.
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
   rather than being cleared. A vault whose id could not be recorded degrades to
   the bare path — which is exactly what every entry written before this looked
   like. */

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
