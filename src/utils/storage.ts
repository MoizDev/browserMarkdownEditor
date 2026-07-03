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
