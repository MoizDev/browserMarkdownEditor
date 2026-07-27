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

/** JSON-stringify and persist a value to localStorage. */
export function writeJSON(key: string, value: unknown): void {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch (err) {
        console.error(`Failed to persist "${key}":`, err);
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
        record = readJSON<Record<string, unknown>>(key, {});
        records.set(key, record);
    }
    return record as Record<string, T>;
}

/** Persist the in-memory record for `key` (after mutating it in place). */
export function flushRecord(key: string): void {
    const record = records.get(key);
    if (record) writeJSON(key, record);
}
