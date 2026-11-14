import type { ContentJob, JobAuthority, JobContext } from '../security/admission';
import type { PointInspectionHeader } from '../format/points';
import type { LoadProjection, RehydratedLoad } from './loadTypes';
import { rehydrateLoad } from './loadProjection';
import { validateLoadSources } from './loadSourceValidation';
import type { SampleLease, SampleStoreReader } from './samples';

declare const loadBrand: unique symbol;
export interface AdmittedLoadToken { readonly kind: 'admitted-board-load'; readonly [loadBrand]: true }
export interface BoardLoadAdmission {
    /** Must run inside the authority's current content job. Original opened bytes
     * are an owned Blob, never a disk File that can change across these awaits. */
    prepare(projection: LoadProjection, baseline: Blob, context: JobContext): Promise<AdmittedLoadToken>;
    take(token: AdmittedLoadToken, context: JobContext): RehydratedLoad;
    discard(token: AdmittedLoadToken): void;
    dispose(): void;
}

/** Only this issuer can authorize a load. A worker marker, cloned token or token
 * from another issuer cannot install a session, and abandoned admissions release
 * every receiving-store creator lease rather than leaving samples resident. */
export function createBoardLoadAdmission(authority: JobAuthority, ports: {
    readonly samples: SampleStoreReader;
    admit(pts: string, header: PointInspectionHeader): SampleLease;
    cooperate?(): Promise<void>;
}): BoardLoadAdmission {
    type Entry = { readonly job: ContentJob; readonly load: RehydratedLoad; readonly signal: AbortSignal; readonly abort: () => void };
    const owned = new Map<AdmittedLoadToken, Entry>();
    let disposed = false;
    const discard = (token: AdmittedLoadToken): void => {
        const entry = owned.get(token);
        if (!entry) return;
        owned.delete(token);
        entry.signal.removeEventListener('abort', entry.abort);
        entry.load.release();
    };
    return {
        async prepare(projection, baseline, context) {
            if (disposed) throw new DOMException('Board load is no longer current', 'AbortError');
            authority.assertContext(context);
            const cooperate = async () => {
                authority.assertContext(context);
                await (ports.cooperate?.() ?? new Promise<void>(resolve => setTimeout(resolve, 0)));
                authority.assertContext(context);
            };
            const load = await rehydrateLoad(projection, ports.admit, ports.samples, cooperate, context.signal);
            let registered: AdmittedLoadToken | undefined;
            try {
                await validateLoadSources(load.sources, load.removedSources, load.unmapped, baseline, cooperate, context.signal);
                authority.assertContext(context);
                if (disposed) throw new DOMException('Board load admission is disposed', 'AbortError');
                const token = Object.freeze({ kind: 'admitted-board-load' }) as AdmittedLoadToken;
                const abort = () => discard(token);
                owned.set(token, { job: context.job, load, signal: context.signal, abort });
                registered = token;
                context.signal.addEventListener('abort', abort, { once: true });
                authority.assertContext(context);
                return token;
            } catch (error) {
                if (registered) discard(registered); else load.release();
                throw error;
            }
        },
        take(token, context) {
            const entry = owned.get(token);
            try {
                authority.assertContext(context);
                if (!entry || disposed || entry.job !== context.job || entry.signal.aborted) throw new TypeError('Unvalidated, stale or already-consumed board load');
            } catch (error) { discard(token); throw error; }
            owned.delete(token);
            entry.signal.removeEventListener('abort', entry.abort);
            return entry.load;
        },
        discard,
        dispose() {
            if (disposed) return;
            disposed = true;
            for (const token of owned.keys()) discard(token);
        },
    };
}
