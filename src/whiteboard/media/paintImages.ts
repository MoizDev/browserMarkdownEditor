import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { RenderToken } from '../../platform/render/types';
import type { MediaEntry, MediaId } from '../model/media';
import type { PaintImageLease, PaintImageProvider } from '../render/resources';
import type { BoardJobIdentity } from '../workers/protocol';
import { inspectMedia } from './inspect';
import type { InspectedMedia } from './ingest';
import { MediaStore } from './store';

// Provenance: media inspection, isolated SVG and paint-lease contracts; independent
// sharing/lifetime adapter with an explicit safe full-frame decoder boundary.
export interface SafeFullFrameLease {
    readonly bitmap: ImageBitmap;
    /** Decoder-owned reservation attributable to the shared backing. */
    readonly cpuBytes: number;
    release(): void;
}
export interface BoardPaintImageOptions {
    readonly media: MediaStore;
    readonly memory: MemoryAllocator;
    entry?(id: MediaId): MediaEntry | undefined;
    readBlob(id: MediaId, signal: AbortSignal): Promise<Blob>;
    identity(token: RenderToken): BoardJobIdentity;
    isCurrent(token: RenderToken, identity: BoardJobIdentity): boolean;
    /** Receives hash-verified inspected bytes. SVG MUST use the network-denied
     * isolated SVG profile; video MUST use a safe poster decoder. It owns its
     * allocations and keeps the bitmap alive until the returned lease releases. */
    decodeFullFrame(blob: Blob, info: InspectedMedia, identity: BoardJobIdentity, signal: AbortSignal): Promise<SafeFullFrameLease>;
}
type Job = {
    readonly key: string; readonly id: MediaId; readonly token: RenderToken; readonly identity: BoardJobIdentity;
    readonly controller: AbortController; readonly promise: Promise<SafeFullFrameLease>;
    resolve(lease: SafeFullFrameLease): void; reject(error: unknown): void;
    waiters: number; refs: number; resource?: SafeFullFrameLease; closed: boolean;
};
function imageId(key: string): MediaId {
    const match = /^(?:sha256:([0-9a-f]{64})(?::0)?|media:([0-9a-f]{64}):0)$/.exec(key);
    if (!match) throw new TypeError('Expected a static frame-zero media key');
    return `sha256:${match[1] ?? match[2]}`;
}
function sameToken(a: RenderToken, b: RenderToken): boolean {
    return a.vaultEpoch === b.vaultEpoch && a.documentId === b.documentId && a.bytesGeneration === b.bytesGeneration && a.session === b.session;
}
function aborted(): DOMException { return new DOMException('Media image request cancelled', 'AbortError'); }

export function createBoardPaintImages(options: BoardPaintImageOptions): PaintImageProvider & { dispose(): void } {
    const jobs = new Map<string, Job>(), queue: Job[] = [];
    let running = 0, disposed = false;
    const keyFor = (id: MediaId, token: RenderToken, identity: BoardJobIdentity) =>
        JSON.stringify([id, token.vaultEpoch, token.documentId, token.bytesGeneration, token.session, identity.session, identity.epoch, identity.revision]);
    const current = (job: Job) => !disposed && !job.controller.signal.aborted && options.isCurrent(job.token, job.identity);
    const drop = (job: Job) => {
        if (job.closed) return;
        job.closed = true;
        if (jobs.get(job.key) === job) jobs.delete(job.key);
        job.resource?.release(); job.resource = undefined;
    };
    const unused = (job: Job) => {
        if (job.waiters || job.refs) return;
        if (job.resource) drop(job);
        else job.controller.abort(aborted());
    };
    const decode = async (job: Job): Promise<SafeFullFrameLease> => {
        const signal = job.controller.signal;
        let blob = options.media.get(job.id) ?? await options.readBlob(job.id, signal);
        signal.throwIfAborted();
        if (!(blob instanceof Blob) || (typeof File !== 'undefined' && blob instanceof File)) throw new TypeError('Media source must be copied Blob bytes');
        blob = blob.slice(0, blob.size, blob.type);
        const info = await inspectMedia(blob, { signal, memory: options.memory, identity: job.identity,
            isCurrent: identity => current(job) && identity.session === job.identity.session && identity.epoch === job.identity.epoch && identity.revision === job.identity.revision });
        if (!current(job)) throw aborted();
        if (info.id !== job.id) throw new Error('Media bytes do not match their content hash');
        if (options.entry) {
            const entry = options.entry(job.id);
            if (!entry || entry.id !== job.id || entry.mime !== info.mime || entry.bytes !== blob.size
                || entry.w !== info.width || entry.h !== info.height || entry.animated !== info.animated) throw new Error('Media bytes do not match their board entry');
        }
        const lease = await options.decodeFullFrame(blob, info, job.identity, signal);
        try {
            if (!current(job)) throw aborted();
            if (!lease || !(lease.bitmap instanceof ImageBitmap) || lease.bitmap.width !== info.width || lease.bitmap.height !== info.height
                || !Number.isSafeInteger(lease.cpuBytes) || lease.cpuBytes < 0 || typeof lease.release !== 'function') throw new Error('Invalid full-frame media decode');
            return lease;
        } catch (error) { if (typeof lease?.release === 'function') lease.release(); throw error; }
    };
    const pump = () => {
        while (!disposed && running < 2 && queue.length) {
            const job = queue.shift()!;
            if (job.controller.signal.aborted) { job.reject(aborted()); if (jobs.get(job.key) === job) jobs.delete(job.key); continue; }
            running++;
            void decode(job).then(lease => {
                job.resource = lease;
                job.resolve(lease);
                if (!job.waiters && !job.refs) drop(job);
            }, error => { if (jobs.get(job.key) === job) jobs.delete(job.key); job.closed = true; job.reject(error); }).finally(() => { running--; pump(); });
        }
    };
    return {
        acquire(imageKey, token, signal) {
            try {
                signal.throwIfAborted();
                if (disposed) throw aborted();
                const id = imageId(imageKey), pinned = Object.freeze({ ...token }), identity = Object.freeze({ ...options.identity(pinned) });
                if (!options.isCurrent(pinned, identity)) throw aborted();
                const key = keyFor(id, pinned, identity);
                let job = jobs.get(key);
                if (!job || job.closed || job.controller.signal.aborted || !sameToken(job.token, pinned)) {
                    if (jobs.size >= 128) throw new RangeError('Too many pending or retained media images');
                    let resolve!: (lease: SafeFullFrameLease) => void, reject!: (error: unknown) => void;
                    const promise = new Promise<SafeFullFrameLease>((yes, no) => { resolve = yes; reject = no; });
                    job = { key, id, token: pinned, identity, controller: new AbortController(), promise, resolve, reject, waiters: 0, refs: 0, closed: false };
                    jobs.set(key, job); queue.push(job);
                }
                const selected = job;
                selected.waiters++;
                const result = new Promise<PaintImageLease>((resolve, reject) => {
                    let done = false;
                    const finish = () => { selected.waiters--; signal.removeEventListener('abort', abort); };
                    const abort = () => { if (done) return; done = true; finish(); unused(selected); reject(signal.reason ?? aborted()); };
                    signal.addEventListener('abort', abort, { once: true });
                    if (signal.aborted) abort();
                    void selected.promise.then(resource => {
                        if (done) return;
                        done = true; finish();
                        if (!current(selected) || selected.closed) { unused(selected); reject(aborted()); return; }
                        selected.refs++;
                        let held = true;
                        resolve({ source: resource.bitmap, width: resource.bitmap.width, height: resource.bitmap.height, cpuBytes: 0,
                            release() { if (!held) return; held = false; selected.refs--; unused(selected); } });
                    }, error => { if (!done) { done = true; finish(); unused(selected); reject(error); } });
                });
                pump();
                return result;
            } catch (error) { return Promise.reject(error); }
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            for (const job of jobs.values()) { job.controller.abort(aborted()); if (!job.refs && job.resource) drop(job); }
            for (const job of queue.splice(0)) { if (jobs.get(job.key) === job) jobs.delete(job.key); job.closed = true; job.reject(aborted()); }
        },
    };
}
