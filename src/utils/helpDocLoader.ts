import { loadChunk } from '../platform/chunkLoad';

let cached: string | null = null;
let inFlight: Promise<string> | null = null;

export function loadHelpDoc(): Promise<string> {
    if (cached !== null) return Promise.resolve(cached);
    if (!inFlight) {
        const attempt = loadChunk(() => import('./helpDoc')).then(m => (cached = m.HELP_DOC_CONTENT));
        inFlight = attempt;
        attempt.catch(() => { if (inFlight === attempt) inFlight = null; });
    }
    return inFlight;
}
