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
    take(token: AdmittedLoadToken, job: ContentJob): RehydratedLoad;
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
            if (disposed || !authority.isCurrent(context.job)) throw new DOMException('Board load is no longer current', 'AbortError');
            context.assertCurrent();
            const cooperate = async () => { context.assertCurrent(); await ports.cooperate?.(); context.assertCurrent(); };
            const load = await rehydrateLoad(projection, ports.admit, ports.samples, cooperate, context.signal);
            try {
                await validateLoadSources(load.sources, load.removedSources, load.unmapped, baseline, cooperate, context.signal);
                context.assertCurrent();
                if (disposed) throw new DOMException('Board load admission is disposed', 'AbortError');
                const token = Object.freeze({ kind: 'admitted-board-load' }) as AdmittedLoadToken;
                const abort = () => discard(token);
                owned.set(token, { job: context.job, load, signal: context.signal, abort });
                context.signal.addEventListener('abort', abort, { once: true });
                context.assertCurrent();
                return token;
            } catch (error) { load.release(); throw error; }
        },
        take(token, job) {
            const entry = owned.get(token);
            if (!entry || disposed || !authority.isCurrent(job) || entry.signal.aborted
                || entry.job.session !== job.session || entry.job.vaultEpoch !== job.vaultEpoch
                || entry.job.generation !== job.generation || entry.job.request !== job.request) {
                discard(token);
                throw new TypeError('Unvalidated, stale or already-consumed board load');
            }
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
