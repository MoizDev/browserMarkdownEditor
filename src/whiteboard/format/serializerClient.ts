import { cpuGovernor, createWorkerClient, WorkerHostError } from '../../platform/workers';
import type { WorkerClient } from '../../platform/workers';
import type { ExtBag } from '../model/json';
import type { PinnedBoardBuild } from '../session/contentSource';
import type { RecordIntegrity } from './lineTable';
import type { SerializerBuild, SerializerChange, SerializerDelta, SerializerPrime, SerializerProduct, SerializerReply } from './serializerProtocol';

interface Root { readonly prime: SerializerPrime; readonly header: string; }
interface Revision {
    readonly root: Root;
    readonly parent: Revision | null;
    readonly delta: SerializerDelta | null;
    readonly revision: number;
    readonly header: string;
}
export interface SerializerCheckpoint extends PinnedBoardBuild {
    /** Called only after the versioned write succeeded, never on conflict or a failed write. */
    written(): Promise<void>;
    product(): SerializerProduct | undefined;
}
export interface SerializerSession {
    /** O(changed): records are already encoded from a pinned revision on the calling thread. */
    update(delta: SerializerDelta): void;
    checkpoint(expected: RecordIntegrity, end: ExtBag | null): SerializerCheckpoint;
    dispose(): void;
}
let nextSerializer = 0;
function take<T>(reply: SerializerReply<T>): T {
    if (!reply.ok) throw new WorkerHostError(reply.error.code, reply.error.reason);
    return reply.value;
}
function copiedDelta(delta: SerializerDelta): SerializerDelta {
    return {
        revision: delta.revision, previous: delta.previous,
        ...(delta.header === undefined ? {} : { header: delta.header }),
        removed: delta.removed.map(identity => ({ ...identity })),
        changed: delta.changed.map(change => ({ identity: { ...change.identity }, revision: change.revision, bytes: change.bytes.slice() })),
    };
}
function transferable(delta: SerializerDelta): { args: SerializerDelta; transfer: Transferable[]; } {
    const transfer: Transferable[] = [];
    const changed: SerializerChange[] = delta.changed.map(change => {
        const bytes = change.bytes.slice();
        transfer.push(bytes.buffer);
        return { identity: change.identity, revision: change.revision, bytes };
    });
    return { args: { ...delta, changed }, transfer };
}

/** One board session owns one serializer, independent of pane and export-worker lifetimes. */
export function createSerializerSession(prime: SerializerPrime, onFailure: (error: unknown) => void): SerializerSession {
    if (!Number.isSafeInteger(prime.revision) || prime.revision < 0) throw new RangeError('Invalid baseline revision');
    if (!(prime.baseline instanceof Blob) || (typeof File !== 'undefined' && prime.baseline instanceof File)) {
        throw new TypeError('Baseline must be the Blob made from parsed bytes, never the File');
    }
    const ownedPrime: SerializerPrime = {
        ...prime,
        ...(prime.lines ? { lines: prime.lines.map(line => ({ ...line, identity: { ...line.identity } })) } : {}),
    };
    const root: Root = { prime: ownedPrime, header: prime.header };
    let current: Revision = { root, parent: null, delta: null, revision: prime.revision, header: prime.header };
    let loaded: Revision | undefined;
    let loadedGeneration = 0;
    let disposed = false;
    let queue: Promise<void> = Promise.resolve();
    const client: WorkerClient = createWorkerClient({
        name: `board-serializer-${++nextSerializer}`, protocol: 1, permits: cpuGovernor,
        spawn: () => new Worker(new URL('./serializer.worker.ts', import.meta.url), { type: 'module' }),
    });
    function serial<T>(work: () => Promise<T>): Promise<T> {
        const next = queue.then(work, work);
        queue = next.then(() => { }, () => { });
        return next;
    }
    async function request<T>(op: string, args: unknown, signal?: AbortSignal, transfer?: Transferable[]): Promise<T> {
        if (disposed) throw new WorkerHostError('Cancelled', 'Board serializer is disposed');
        try {
            return take(await client.request<SerializerReply<T>>(op, args, { priority: 2, signal, transfer }));
        } catch (error) { loaded = undefined; throw error; }
    }
    async function sync(target: Revision, signal?: AbortSignal): Promise<void> {
        if (loadedGeneration !== client.generation) loaded = undefined;
        if (loaded === target) return;
        const pending: Revision[] = [];
        let cursor: Revision | null = target;
        while (cursor && cursor !== loaded) { pending.push(cursor); cursor = cursor.parent; }
        if (!cursor) {
            await request<void>('prime', target.root.prime, signal);
            loadedGeneration = client.generation;
            loaded = pending.pop(); // the root revision has no delta
        }
        while (pending.length) {
            const next = pending.pop()!;
            if (!next.delta) throw new WorkerHostError('Protocol', 'Serializer revision chain is incomplete');
            const message = transferable(next.delta);
            await request<void>('delta', message.args, signal, message.transfer);
            loaded = next;
            loadedGeneration = client.generation;
        }
    }
    async function assemble(target: Revision, expected: RecordIntegrity, endFields: SerializerBuild['endFields'], signal: AbortSignal): Promise<SerializerProduct> {
        let retried = false;
        for (; ;) {
            try {
                await sync(target, signal);
                const product = await request<SerializerProduct>('build', { revision: target.revision, expected, endFields }, signal);
                if (product.revision !== target.revision || !(product.blob instanceof Blob) || !(product.index instanceof Blob)
                    || !/^[0-9a-f]{64}$/u.test(product.sha256)) throw new WorkerHostError('Protocol', 'Invalid serializer product');
                return product;
            } catch (error) {
                loaded = undefined;
                // Exactly one re-prime on integrity mismatch or a worker crash; no retry of IO,
                // cancellation or a failed baseline, and no bypass of the versioned write.
                if (retried || signal.aborted || !(error instanceof WorkerHostError)
                    || (error.name !== 'integrity' && error.name !== 'WorkerCrashed')) throw error;
                retried = true;
            }
        }
    }
    function advanceBaseline(target: Revision, product: SerializerProduct): void {
        const remaining: SerializerDelta[] = [];
        let cursor: Revision | null = current;
        while (cursor && cursor !== target) {
            if (!cursor.delta) return; // A different branch/rebase was already acknowledged.
            remaining.push(cursor.delta);
            cursor = cursor.parent;
        }
        if (!cursor) return;
        const nextRoot: Root = { header: target.header, prime: { revision: target.revision, baseline: product.blob, header: target.header, index: product.index } };
        let next: Revision = { root: nextRoot, parent: null, delta: null, revision: target.revision, header: target.header };
        for (let i = remaining.length - 1; i >= 0; i--) {
            const delta = remaining[i];
            next = { root: nextRoot, parent: next, delta, revision: delta.revision, header: delta.header ?? next.header };
        }
        current = next;
        // Old checkpoint objects retain their own root and chain. The next build re-primes its
        // pinned branch if needed, so an older source never silently returns newer bytes.
        loaded = undefined;
    }
    return {
        update(delta) {
            if (disposed) throw new WorkerHostError('Cancelled', 'Board serializer is disposed');
            if (!Number.isSafeInteger(delta.revision) || delta.revision <= current.revision || delta.previous !== current.revision) {
                throw new RangeError('Invalid serializer revision sequence');
            }
            const frozen = copiedDelta(delta);
            const next: Revision = { root: current.root, parent: current, delta: frozen, revision: frozen.revision, header: frozen.header ?? current.header };
            current = next;
            // Posting is eager, but the immutable chain remains the recovery journal since the
            // last durable baseline. A crash before the reply never causes an empty re-prime.
            void serial(() => sync(next)).catch(onFailure);
        },
        checkpoint(expected, end) {
            const target = current;
            const integrity = { count: expected.count, digest: expected.digest };
            const endFields = [...(end?.fields ?? [])].map(([key, value]) => [key, value] as const);
            if (end?.raw.size) throw new Error('A preserved footer cannot override its derived count');
            let built: SerializerProduct | undefined;
            return Object.freeze({
                revision: target.revision,
                async build(signal: AbortSignal) {
                    const product = await serial(() => assemble(target, integrity, endFields, signal));
                    built = product;
                    return product.blob;
                },
                written() {
                    if (!built) return Promise.reject(new Error('Cannot acknowledge a board revision before building it'));
                    const product = built;
                    // A PDF wraps these board bytes; the host calls this only after its complete
                    // version-checked document write succeeds, not merely after assembling ink.
                    return serial(async () => advanceBaseline(target, product));
                },
                product() { return built; },
            });
        },
        dispose() { if (!disposed) { disposed = true; loaded = undefined; client.dispose(); } },
    };
}
