import { cpuGovernor, createWorkerClient, WorkerHostError } from '../../platform/workers';
import type { BoardKind } from '../model/doc';
import type { BoardLoadAdmission } from '../model/loadAdmission';
import type { RehydratedLoad } from '../model/loadTypes';
import type { JobAuthority } from '../security/admission';
import type { NativeLoadReply } from './nativeLoad';
import { validateNativeRequest } from './nativeRequest';
import { boardEnvelope, closeWorkerResult, matchingIdentity, validBoardIdentity } from './protocol';
import type { BoardJobIdentity } from './protocol';

// Provenance: worker-host C5, board envelope and load admission contracts;
// independent session client, no third-party source.
let serial = 0;
function validReply(value: unknown): value is NativeLoadReply {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const v = value as Record<string, unknown>;
    const count = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
    if (!(v.format === 'native' || v.format === 'empty' || v.format === 'other')
        || typeof v.readOnly !== 'boolean' || typeof v.complete !== 'boolean' || typeof v.reformatted !== 'boolean'
        || !count(v.issueCount) || !count(v.recordsSeen) || !count(v.recordsRecovered) || !count(v.bytesRead)
        || !Array.isArray(v.issues) || !Array.isArray(v.sources) || !Array.isArray(v.unmapped) || !Array.isArray(v.coldBounds)) return false;
    if (v.repaired === null) return v.readOnly;
    if (!v.repaired || typeof v.repaired !== 'object' || Array.isArray(v.repaired)) return false;
    const repair = v.repaired as Record<string, unknown>;
    if (!Array.isArray(repair.repairs) || !Array.isArray(repair.issues)) return false;
    if (repair.status === 'read-only') return v.readOnly && repair.projection === null;
    return repair.status === 'editable' && !v.readOnly && v.complete && (v.format === 'native' || v.format === 'empty')
        && !!repair.projection && typeof repair.projection === 'object' && !Array.isArray(repair.projection);
}

export function createNativeLoadClient(config: { authority: JobAuthority; identity: { session: string; epoch: number }; admission: BoardLoadAdmission }): {
    load(bytes: Blob, expectedKind: BoardKind, pdfPages: readonly (readonly [number, number])[] | undefined,
        options: { signal?: AbortSignal; deadlineMs: number }): Promise<{ reply: NativeLoadReply; load: RehydratedLoad | null }>;
    dispose(): void;
} {
    const { authority, admission } = config;
    const owner = { session: config.identity.session, epoch: config.identity.epoch };
    if (!validBoardIdentity({ ...owner, revision: 0 })) throw new TypeError('Invalid native load identity');
    const worker = createWorkerClient({ name: `board-native-load-${++serial}`, protocol: 1, permits: cpuGovernor,
        spawn: () => new Worker(new URL('./parse.worker.ts', import.meta.url), { type: 'module' }),
        disposeResult: (_op, result) => closeWorkerResult(result) });
    const active = new Set<AbortController>();
    let disposed = false;
    return {
        async load(bytes, expectedKind, pdfPages, options) {
            if (disposed) throw new DOMException('Native load client disposed', 'AbortError');
            if (expectedKind !== 'whiteboard' && expectedKind !== 'notebook' && expectedKind !== 'pdf-ink') throw new TypeError('Invalid expected board kind');
            const request = validateNativeRequest({ bytes, expectedKind, ...(pdfPages === undefined ? {} : { pdfPages }) });
            const controller = new AbortController();
            active.add(controller);
            const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
            let acquired: RehydratedLoad | null = null;
            let workSignal: AbortSignal | undefined;
            const release = () => { acquired?.release(); acquired = null; };
            try {
                const result = await authority.run(async context => {
                    context.assertCurrent();
                    if (disposed || context.job.session !== owner.session || context.job.vaultEpoch !== owner.epoch) throw new DOMException('Stale native load identity', 'AbortError');
                    const identity: BoardJobIdentity = { ...owner, revision: context.job.generation };
                    const response: unknown = await worker.request('nativeLoad', { identity, payload: request },
                        { priority: 0, cpu: 'governed', deadlineMs: options.deadlineMs, terminateOnDeadline: true, signal: context.signal });
                    try {
                        context.assertCurrent();
                        if (disposed) throw new DOMException('Native load client disposed', 'AbortError');
                        if (!boardEnvelope(response) || !matchingIdentity(identity, response.identity) || !validReply(response.payload)) throw new WorkerHostError('Protocol', 'Invalid native load reply');
                        const reply = response.payload;
                        if (reply.bytesRead > bytes.size) throw new WorkerHostError('Protocol', 'Native load byte count exceeds baseline');
                        if (reply.repaired?.status !== 'editable') return { reply, load: null };
                        const projection = reply.repaired.projection;
                        if (!projection || projection.kind !== expectedKind) throw new WorkerHostError('Protocol', 'Native load kind mismatch');
                        const token = await admission.prepare(projection, bytes, context);
                        try {
                            context.assertCurrent();
                            if (disposed) throw new DOMException('Native load client disposed', 'AbortError');
                            acquired = admission.take(token, context.job);
                            workSignal = context.signal;
                            workSignal.addEventListener('abort', release, { once: true });
                            context.assertCurrent();
                            return { reply, load: acquired };
                        } catch (error) { admission.discard(token); throw error; }
                    } catch (error) { closeWorkerResult(response); throw error; }
                }, { signal, deadlineMs: options.deadlineMs });
                if (disposed || signal.aborted) throw new DOMException('Native load client disposed or cancelled', 'AbortError');
                workSignal?.removeEventListener('abort', release);
                acquired = null;
                return result;
            } catch (error) {
                workSignal?.removeEventListener('abort', release);
                release();
                throw error;
            } finally { active.delete(controller); }
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            for (const controller of active) controller.abort();
            active.clear();
            worker.dispose();
        },
    };
}
