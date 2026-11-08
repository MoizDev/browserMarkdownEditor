// The user guide, fetched when it is asked for.
//
// `helpDoc.ts` is ~76KB of prose — a quarter of the main bundle's app code —
// and it is read by opening one tab that most sessions never open. Static, it
// was parsed on every cold start before anybody could type. Behind this it is
// its own chunk, fetched on the click (and on a session restore that had the
// guide open), cached in the module from then on.

let cached: string | null = null;
let inFlight: Promise<string> | null = null;

/** The guide, loading it the first time. Concurrent callers share one fetch. */
export function loadHelpDoc(): Promise<string> {
    if (cached !== null) return Promise.resolve(cached);
    inFlight ??= import('./helpDoc').then(m => (cached = m.HELP_DOC_CONTENT));
    return inFlight;
}
