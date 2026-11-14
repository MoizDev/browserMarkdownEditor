import { now, watchClock } from './clock';
import { assertPayload, isPriority, isWorkerMessage, WorkerHostError } from './envelope';
import { cpuGovernor } from './governor';
import type { ClientState, ContainedPort, CpuPermit, MainMessage, Priority, RequestOptions, WorkerClient, WorkerMessage, WorkerSpec } from './envelope';

const clients = new Map<string, Client>();
const silence = [20000, 20000, 60000, 60000];
const backoff = [0, 250, 1000, 4000];
const marker = 'bme-worker-host-v1';

type Job = {
    id: number;
    op: string;
    args: unknown;
    options: RequestOptions;
    phase: 'queued' | 'sent' | 'running' | 'settled';
    deadline?: number;
    deadlineTimer?: ReturnType<typeof setTimeout>;
    started: number;
    heard: number;
    paused: boolean;
    admitted: boolean;
    bootstrap?: number;
    permit?: CpuPermit;
    admission?: object;
    abort?: () => void;
    resolve(value: unknown): void;
    reject(error: WorkerHostError): void;
};

type Connection = {
    generation: number;
    endpoint: Worker | MessagePort;
    terminate(): void;
    alive?: () => Promise<boolean>;
    detach(): void;
    hello: boolean;
    started: number;
    sent: Map<number, Job>;
    killAt?: number;
    polling: boolean;
    poll: number;
    polled: number;
    pollAt?: number;
    eventsAt: number;
    events: number;
};

export function createWorkerClient(spec: WorkerSpec): WorkerClient {
    const existing = clients.get(spec.name);
    if (existing) return existing;
    const client = new Client(spec);
    clients.set(spec.name, client);
    return client;
}

class Client implements WorkerClient {
    state: ClientState = 'idle';
    generation = 0;
    failure: WorkerHostError | undefined;
    private nextId = 0;
    private pending = new Map<number, Job>();
    private promises = new WeakMap<Promise<unknown>, Job>();
    private handlers = new Map<string, Set<(data: unknown) => void>>();
    private connection?: Connection;
    private stopClock?: () => void;
    private spawningAt = 0;
    private respawnAt = 0;
    private crashes: number[] = [];
    private pumping = false;
    private pumpAgain = false;
    private poison = new Map<string, number>();
    private recyclePromise?: Promise<void>;
    private readyWaiters: { resolve(): void; reject(error: WorkerHostError): void }[] = [];
    constructor(private spec: WorkerSpec) {}

    get inFlight(): number { return this.pending.size; }

    request = <T>(op: string, args: unknown, options: RequestOptions): Promise<T> => this.enqueue<T>(op, args, options);

    private enqueue<T>(op: string, args: unknown, options: RequestOptions, bootstrap?: number): Promise<T> {
        if (this.state === 'disposed') return Promise.reject(this.error('Cancelled', 'Worker disposed'));
        if (this.state === 'failed') return Promise.reject(this.failure);
        if (bootstrap !== undefined && bootstrap !== this.generation) return Promise.reject(this.error('Cancelled', 'Stale worker initialisation'));
        if (!isPriority(options.priority) || (options.deadlineMs !== undefined && (!Number.isFinite(options.deadlineMs) || options.deadlineMs < 0))) {
            return Promise.reject(this.error('Protocol', 'Invalid priority or deadline'));
        }
        const asked = now();
        let resolve!: (value: unknown) => void;
        let reject!: (error: WorkerHostError) => void;
        const promise = new Promise<T>((yes, no) => { resolve = value => yes(value as T); reject = no; });
        const job: Job = {
            id: ++this.nextId, op, args, options: { ...options }, phase: 'queued',
            deadline: options.deadlineMs === undefined ? undefined : asked + options.deadlineMs,
            started: 0, heard: 0, paused: false, admitted: false, bootstrap, resolve, reject,
        };
        this.pending.set(job.id, job);
        this.promises.set(promise, job);
        job.abort = () => this.cancel(job, 'Cancelled', 'Request aborted');
        options.signal?.addEventListener('abort', job.abort, { once: true });
        if (options.signal?.aborted) job.abort();
        if (job.phase === 'settled') return promise;
        this.armDeadline(job);
        if (!this.pending.has(job.id)) return promise;
        if (this.state === 'idle') this.spawn();
        this.pump();
        return promise;
    }

    private syncClock(): void {
        const connection = this.connection;
        const timed = this.state === 'backoff' || (this.state === 'starting' && !connection?.hello)
            || !!connection?.sent.size || connection?.killAt !== undefined;
        if (timed) this.stopClock ??= watchClock(this.tick);
        else if (this.stopClock) {
            this.stopClock();
            this.stopClock = undefined;
            if (connection) {
                ++connection.poll;
                connection.polling = false;
                connection.polled = now();
            }
        }
    }

    private armDeadline(job: Job): void {
        if (job.deadline === undefined || job.phase === 'settled') return;
        const left = job.deadline - now();
        if (left <= 0) this.cancel(job, 'Deadline', 'Worker request deadline elapsed');
        else job.deadlineTimer = setTimeout(() => this.armDeadline(job), Math.min(left, 2147483647));
    }

    private expired(job: Job): boolean {
        if (job.deadline === undefined || now() < job.deadline) return false;
        this.cancel(job, 'Deadline', 'Worker request deadline elapsed');
        return true;
    }

    private pump(): void {
        if (this.pumping) { this.pumpAgain = true; return; }
        this.pumping = true;
        try {
            do {
                this.pumpAgain = false;
                const connection = this.connection;
                if (!connection?.hello || connection.killAt !== undefined || (this.state !== 'ready' && this.state !== 'starting')) return;
                for (const job of this.pending.values()) {
                    if (job.phase !== 'queued' || (this.state !== 'ready' && job.bootstrap !== connection.generation)) continue;
                    if (this.expired(job)) continue;
                    try {
                        if (!job.admitted && !job.permit) {
                            if (job.options.cpu === 'light') job.admitted = true;
                            else {
                                const admission = job.admission = {};
                                job.permit = (this.spec.permits ?? cpuGovernor).acquire({
                                    name: this.spec.name, id: job.id, priority: job.options.priority,
                                    start: () => {
                                        if (job.admission !== admission) return;
                                        job.admitted = true;
                                        if (job.permit) this.pump();
                                    },
                                    pause: () => { if (job.admission === admission) this.pause(job, true); },
                                    resume: () => { if (job.admission === admission) this.pause(job, false); },
                                });
                                // Admission callbacks can synchronously settle another job and re-enter
                                // the client. The pump serialises them; a cancelled admission releases too.
                                if (!this.pending.has(job.id)) { job.permit.release(); continue; }
                            }
                        }
                        if (!job.admitted || job.paused) continue;
                        assertPayload(job.args);
                        if (!this.pending.has(job.id) || this.connection !== connection) continue;
                        job.phase = 'sent';
                        connection.sent.set(job.id, job);
                        const remaining = job.deadline === undefined ? undefined : Math.max(0, job.deadline - now());
                        connection.endpoint.postMessage({ v: 1, id: job.id, op: job.op, args: job.args, priority: job.options.priority, deadlineMs: remaining } satisfies MainMessage, job.options.transfer ?? []);
                        job.phase = 'running';
                        job.started = job.heard = now();
                    } catch (error) {
                        connection.sent.delete(job.id);
                        this.settle(job, this.error('Protocol', `Cannot post worker request: ${String(error)}`));
                    }
                }
            } while (this.pumpAgain);
        } finally { this.pumping = false; this.syncClock(); }
    }

    reprioritise = (promise: Promise<unknown>, priority: Priority): void => {
        const job = this.promises.get(promise);
        if (!job || job.phase === 'settled' || !isPriority(priority)) return;
        job.options.priority = priority;
        if (job.phase !== 'queued') this.control({ v: 1, reprioritise: job.id, priority });
        job.permit?.reprioritise(priority);
        this.pump();
    };

    private pause(job: Job, paused: boolean): void {
        if (job.phase === 'settled') return;
        job.paused = paused;
        if (!paused) job.heard = now();
        if (job.phase !== 'queued') this.control(paused ? { v: 1, pause: job.id } : { v: 1, resume: job.id });
        else if (!paused) this.pump();
    }

    cancelAll = (match: (op: string, args: unknown) => boolean): void => {
        for (const job of [...this.pending.values()]) if (match(job.op, job.args)) this.cancel(job, 'Cancelled', 'Request cancelled');
    };

    private cancel(job: Job, name: 'Cancelled' | 'Deadline', message: string): void {
        if (job.phase === 'settled') return;
        if (job.phase !== 'queued') this.control({ v: 1, cancel: job.id });
        this.settle(job, this.error(name, message));
    }

    // The only promise-settling site. Sent cancelled jobs stay in connection.sent until their one
    // late reply (disposed) or termination, so a non-cooperating cancelled job is still watched.
    private settle(job: Job, error?: WorkerHostError, result?: unknown): void {
        if (job.phase === 'settled') return;
        job.phase = 'settled';
        this.pending.delete(job.id);
        clearTimeout(job.deadlineTimer);
        if (job.abort) job.options.signal?.removeEventListener('abort', job.abort);
        // A caller can keep the returned promise for the document's life. Its WeakMap entry must
        // not keep that request's Blob, transferred buffers or abort signal alive along with it.
        job.args = undefined;
        job.options.signal = undefined;
        job.options.transfer = undefined;
        job.abort = undefined;
        this.release(job);
        if (error) job.reject(error);
        else job.resolve(result);
        job.resolve = () => {};
        job.reject = () => {};
        this.syncClock();
    }

    private release(job: Job): void {
        job.admission = undefined;
        job.permit?.release();
        job.permit = undefined;
    }

    // Never replay work a worker may already have performed. Unposted caller jobs belong to the
    // client, not the dead generation; keep their deadline and args, but reacquire a CPU ticket.
    private retainQueued(): void {
        for (const job of [...this.pending.values()]) {
            if (job.phase !== 'queued') continue;
            if (job.bootstrap !== undefined) this.cancel(job, 'Cancelled', 'Worker initialisation superseded');
            else {
                this.release(job);
                job.admitted = job.paused = false;
            }
        }
    }

    on = (event: string, handler: (data: unknown) => void): (() => void) => {
        let set = this.handlers.get(event);
        if (!set) this.handlers.set(event, set = new Set());
        set.add(handler);
        return () => { set.delete(handler); if (!set.size) this.handlers.delete(event); };
    };

    private control(message: MainMessage): void {
        try { this.connection?.endpoint.postMessage(message); }
        catch { /* Control envelopes contain no caller values. A lost endpoint is caught by alive/silence. */ }
    }

    private spawn(): void {
        if (this.state === 'disposed' || this.state === 'failed') return;
        this.state = 'starting';
        const generation = ++this.generation;
        this.spawningAt = now();
        this.syncClock();
        let spawned: Worker | Promise<ContainedPort>;
        try { spawned = this.spec.spawn(); }
        catch (error) { this.fail(`Cannot spawn worker: ${String(error)}`); return; }
        void Promise.resolve(spawned).then(placement => {
            const contained = 'port' in placement;
            const endpoint = contained ? placement.port : placement;
            const terminate = () => {
                if (contained) placement.port.close();
                placement.terminate();
            };
            if (this.generation !== generation || this.state !== 'starting') { terminate(); return; }
            const connection: Connection = {
                generation, endpoint, terminate, alive: contained ? () => placement.alive() : undefined,
                detach: () => {
                    endpoint.removeEventListener('message', message as EventListener);
                    endpoint.removeEventListener('messageerror', messageerror);
                    endpoint.removeEventListener('error', error);
                },
                hello: false, started: this.spawningAt, sent: new Map(), polling: false, poll: 0, polled: now(), eventsAt: now(), events: 0,
            };
            const message = (event: MessageEvent<unknown>) => this.receive(connection, event.data);
            const messageerror = () => this.crash(connection, 'Worker message could not be deserialised');
            const error = (event: Event) => {
                if (this.connection !== connection) return;
                event.preventDefault();
                if (!connection.hello) this.fail('Worker failed before its hello');
                else this.crash(connection, 'Worker error');
            };
            this.connection = connection;
            endpoint.addEventListener('message', message as EventListener);
            endpoint.addEventListener('messageerror', messageerror);
            endpoint.addEventListener('error', error);
            if (contained) placement.port.start();
        }).catch(error => {
            if (this.generation === generation && this.state === 'starting') this.fail(`Cannot create contained worker: ${String(error)}`);
        });
    }

    private receive(connection: Connection, data: unknown): void {
        if (this.connection !== connection) return;
        if (!isWorkerMessage(data)) {
            if (!connection.hello) this.fail('Malformed worker hello');
            else this.crash(connection, 'Malformed worker reply');
            return;
        }
        if (!connection.hello) {
            if (!('hello' in data) || data.hello.protocol !== this.spec.protocol) { this.fail('Worker protocol mismatch'); return; }
            connection.hello = true;
            this.syncClock();
            // A bootstrap facade marks initialisation requests without letting unrelated callers
            // jump ahead of onStart. Its generation fence also catches an async hook after a crash.
            const bootstrap = Object.create(this) as WorkerClient;
            bootstrap.request = <T>(op: string, args: unknown, options: RequestOptions) => this.enqueue<T>(op, args, options, connection.generation);
            void Promise.resolve().then(() => this.spec.onStart?.(bootstrap)).then(() => {
                if (this.connection !== connection || this.state !== 'starting') return;
                this.state = 'ready';
                for (const waiter of this.readyWaiters.splice(0)) waiter.resolve();
                this.pump();
            }, error => {
                if (this.connection === connection) this.fail(`Worker initialisation failed: ${String(error)}`);
            });
            return;
        }
        if ('hello' in data) { this.crash(connection, 'Duplicate worker hello'); return; }
        if (connection.alive) {
            try {
                if ('event' in data) assertPayload(data.data);
                else if (data.ok) assertPayload(data.result);
            } catch { this.crash(connection, 'Forbidden value in worker reply'); return; }
        }
        if ('event' in data) { this.event(connection, data); return; }
        const job = connection.sent.get(data.id);
        if (!job) {
            if (data.ok) this.discard('', data.result);
            this.crash(connection, 'Unknown or duplicate worker reply');
            return;
        }
        connection.sent.delete(data.id);
        if (job.phase !== 'settled') this.expired(job);
        if (job.phase === 'settled') {
            if (data.ok) this.discard(job.op, data.result);
        } else if (data.ok) this.settle(job, undefined, data.result);
        else this.settle(job, new WorkerHostError(data.error.name, data.error.message));
        this.syncClock();
    }

    private event(connection: Connection, message: Extract<WorkerMessage, { event: string }>): void {
        if (connection.alive) {
            const time = now();
            if (time - connection.eventsAt >= 1000) { connection.eventsAt = time; connection.events = 0; }
            if (++connection.events > (this.spec.eventLimit ?? 1000) || (message.event !== 'heartbeat' && !this.spec.events?.includes(message.event))) {
                this.crash(connection, 'Contained worker event policy violation');
                return;
            }
        }
        if (message.event === 'heartbeat') {
            const id = (message.data as { id?: unknown } | null)?.id;
            if (typeof id === 'number') {
                const job = connection.sent.get(id);
                if (job) job.heard = now();
            }
            return;
        }
        const handlers = this.handlers.get(message.event);
        if (!handlers) { console.debug(`${marker}: ignored unknown event ${message.event}`); return; }
        for (const handler of [...handlers]) {
            try { handler(message.data); }
            catch (error) { console.warn(`${marker}: event listener failed`, error); }
        }
    }

    private tick = (time: number, restarted: boolean, suspended: boolean): void => {
        const connection = this.connection;
        if (restarted) {
            this.spawningAt = time;
            if (connection) {
                connection.started = connection.polled = time;
                if (connection.polling) connection.pollAt = time;
                if (connection.killAt !== undefined) connection.killAt = time + 2000;
                for (const job of connection.sent.values()) job.started = job.heard = time;
            }
        }
        if (suspended) return;
        if (this.state === 'backoff' && time >= this.respawnAt) { this.spawn(); return; }
        if (this.state === 'starting' && !connection?.hello && time - this.spawningAt >= 10000) { this.fail('Worker hello timed out after 10 seconds'); return; }
        if (!connection) return;
        if (connection.killAt !== undefined) {
            if (time >= connection.killAt) this.crash(connection, 'Worker hung');
            return;
        }
        for (const job of connection.sent.values()) {
            if ((!job.paused && time - job.heard >= (this.spec.silenceMs?.[job.options.priority] ?? silence[job.options.priority]))
                || time - job.started >= (this.spec.absoluteMs ?? 120000)) {
                connection.killAt = time + 2000;
                for (const active of connection.sent.values()) this.control({ v: 1, cancel: active.id });
                return;
            }
        }
        if (connection.alive) {
            if (connection.polling && time - (connection.pollAt ?? time) >= 2000) { this.fail('Contained worker liveness check timed out'); return; }
            if (!connection.polling && time - connection.polled >= 1000) {
                connection.polling = true;
                connection.pollAt = connection.polled = time;
                const poll = ++connection.poll;
                void Promise.resolve().then(() => connection.alive!()).then(alive => {
                    if (this.connection !== connection || connection.poll !== poll) return;
                    connection.polling = false;
                    if (!alive) this.fail('Contained worker frame is no longer alive');
                }, () => {
                    if (this.connection === connection && connection.poll === poll) this.fail('Contained worker liveness check failed');
                });
            }
        }
    };

    private crash(connection: Connection, reason: string): void {
        if (this.connection !== connection) return;
        const keyed = new Set<string>();
        for (const job of connection.sent.values()) if (job.options.key !== undefined) keyed.add(`${job.op}\0${job.options.key}`);
        for (const key of keyed) this.poison.set(key, (this.poison.get(key) ?? 0) + 1);
        const posted = [...connection.sent.values()];
        this.disconnect();
        for (const job of posted) {
            const poisoned = job.options.key !== undefined && (this.poison.get(`${job.op}\0${job.options.key}`) ?? 0) >= 2;
            this.settle(job, this.error('WorkerCrashed', reason, poisoned));
        }
        this.retainQueued();
        const time = now();
        this.crashes = this.crashes.filter(t => time - t < 60000);
        this.crashes.push(time);
        if (this.crashes.length >= 4) { this.fail(`Four worker crashes in 60 seconds: ${reason}`); return; }
        this.state = 'backoff';
        this.respawnAt = time + backoff[this.crashes.length - 1];
        if (this.respawnAt === time) this.spawn();
        else this.syncClock();
    }

    private disconnect(): void {
        const connection = this.connection;
        this.connection = undefined;
        if (!connection) return;
        connection.detach();
        try { connection.terminate(); } catch { /* A removed contained frame may already be gone. */ }
        connection.sent.clear();
    }

    private fail(reason: string): void {
        this.state = 'failed';
        this.failure = this.error('WorkerFailed', reason);
        this.disconnect();
        this.stopClock?.();
        this.stopClock = undefined;
        for (const job of [...this.pending.values()]) this.settle(job, this.failure);
        for (const waiter of this.readyWaiters.splice(0)) waiter.reject(this.failure);
    }

    reset = (): void => {
        if (this.state !== 'failed') return;
        this.failure = undefined;
        this.crashes = [];
        this.poison.clear();
        this.state = 'idle';
        this.spawn();
    };

    recycle = (reason: string, options: { lazy?: boolean } = {}): Promise<void> => {
        if (this.state === 'disposed') return Promise.reject(this.error('Cancelled', 'Worker disposed'));
        if (this.state === 'failed') return Promise.reject(this.failure);
        if (this.recyclePromise && !options.lazy) return this.recyclePromise;
        this.state = 'recycling';
        // Cancel posted work rather than drain forever on WASM; unposted calls survive.
        const posted = [...(this.connection?.sent.values() ?? [])];
        this.disconnect();
        for (const job of posted) this.cancel(job, 'Cancelled', `Worker recycled: ${reason}`);
        this.retainQueued();
        if (options.lazy && !this.pending.size) {
            this.state = 'idle';
            this.syncClock();
            const error = this.error('Cancelled', 'Worker restart deferred');
            for (const waiter of this.readyWaiters.splice(0)) waiter.reject(error);
            this.recyclePromise = undefined;
            return Promise.resolve();
        }
        const promise = this.recyclePromise ?? new Promise<void>((resolve, reject) => this.readyWaiters.push({ resolve, reject }));
        this.recyclePromise = promise;
        const clear = () => { if (this.recyclePromise === promise) this.recyclePromise = undefined; };
        void promise.then(clear, clear);
        this.spawn();
        return promise;
    };

    dispose = (): void => {
        if (this.state === 'disposed') return;
        this.state = 'disposed';
        this.disconnect();
        this.stopClock?.();
        this.stopClock = undefined;
        const error = this.error('Cancelled', 'Worker disposed');
        for (const job of [...this.pending.values()]) this.settle(job, error);
        for (const waiter of this.readyWaiters.splice(0)) waiter.reject(error);
        this.handlers.clear();
        if (clients.get(this.spec.name) === this) clients.delete(this.spec.name);
    };

    private discard(op: string, result: unknown): void {
        try { this.spec.disposeResult?.(op, result); }
        catch (error) { console.warn(`${marker}: result disposal failed`, error); }
    }

    private error(name: string, message: string, poisoned = false): WorkerHostError {
        return new WorkerHostError(name, `${marker}: ${message}`, name === 'WorkerCrashed', poisoned);
    }

}
