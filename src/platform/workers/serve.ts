import { now } from './clock';
import { assertPayload, isPriority, WorkerHostError } from './envelope';
import type { MainMessage, Priority, WorkerMessage } from './envelope';

export interface WorkerContext {
    readonly cancelled: boolean;
    readonly signal: AbortSignal;
    slice(): Promise<void>;
    heartbeat(): void;
    transfer(...items: Transferable[]): void;
    emit(event: string, data: unknown, transfer?: Transferable[]): void;
}

export interface ServeEndpoint {
    postMessage(message: WorkerMessage, transfer: Transferable[]): void;
    addEventListener(type: 'message', handler: (event: MessageEvent<unknown>) => void): void;
    removeEventListener(type: 'message', handler: (event: MessageEvent<unknown>) => void): void;
    start?(): void;
}

export interface ServeSpec {
    protocol: number;
    buildId: string;
    capabilities?: string[];
    handlers: Record<string, (args: unknown, context: WorkerContext) => unknown | Promise<unknown>>;
    endpoint?: ServeEndpoint;
}

// Worker replies can contain an entire board's ordered records. Validate the same allowed
// payload domain as the synchronous input guard, but never monopolize a worker on that walk.
async function assertReply(value: unknown, context: WorkerContext): Promise<void> {
    const seen = new Set<object>();
    const pending: Iterator<unknown>[] = [[value][Symbol.iterator]()];
    let started = now(), count = 0;
    while (pending.length) {
        const next = pending[pending.length - 1].next();
        if (next.done) { pending.pop(); continue; }
        const item = next.value;
        if (item === null || item === undefined || ['string', 'boolean', 'number', 'bigint'].includes(typeof item)) continue;
        if (typeof item !== 'object') throw new WorkerHostError('Protocol', 'Worker payload must be plain data');
        if (seen.has(item)) continue;
        seen.add(item);
        if (item instanceof ArrayBuffer) continue;
        if (ArrayBuffer.isView(item)) { pending.push([item.buffer][Symbol.iterator]()); continue; }
        if (typeof ImageBitmap !== 'undefined' && item instanceof ImageBitmap) continue;
        if (typeof MessagePort !== 'undefined' && item instanceof MessagePort) continue;
        if (typeof Blob !== 'undefined' && item instanceof Blob && !(typeof File !== 'undefined' && item instanceof File)) continue;
        const prototype = Object.getPrototypeOf(item);
        if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) {
            throw new WorkerHostError('Protocol', 'Worker payload contains a forbidden platform object');
        }
        pending.push((function* () {
            for (const key in item) {
                if (!Object.hasOwn(item, key)) continue;
                const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
                if (!('value' in descriptor)) throw new WorkerHostError('Protocol', 'Worker payload must not contain accessors');
                yield descriptor.value;
            }
        })());
        if ((++count & 255) === 0 && now() - started >= 3) { await context.slice(); started = now(); }
    }
}

type Task = {
    cancelled: boolean;
    controller: AbortController;
    paused: boolean;
    priority: Priority;
    heard: number;
    wake?: () => void;
    transfer: Transferable[];
};

function mainMessage(value: unknown): value is MainMessage {
    if (!value || typeof value !== 'object') return false;
    const m = value as Record<string, unknown>;
    const id = m.id ?? m.cancel ?? m.reprioritise ?? m.pause ?? m.resume;
    if (m.v !== 1 || !Number.isSafeInteger(id) || (id as number) < 1) return false;
    if ('id' in m) return typeof m.op === 'string' && 'args' in m && isPriority(m.priority)
        && (m.deadlineMs === undefined || (typeof m.deadlineMs === 'number' && Number.isFinite(m.deadlineMs) && m.deadlineMs >= 0));
    return 'cancel' in m || 'pause' in m || 'resume' in m || ('reprioritise' in m && isPriority(m.priority));
}

// No interval or per-slice permission round trip: a heartbeat is part of a handler's cooperation
// point, and pause/resume are pushed only when the main-thread governor's queue changes.
export function serve(spec: ServeSpec): () => void {
    const endpoint = spec.endpoint ?? globalThis as unknown as ServeEndpoint;
    const tasks = new Map<number, Task>();
    let disposed = false;
    const post = (message: WorkerMessage, transfer: Transferable[] = []) => endpoint.postMessage(message, transfer);
    const stop = (task: Task) => { task.cancelled = true; task.controller.abort(); task.wake?.(); };
    const closeTransfers = (task: Task) => {
        for (const item of task.transfer) {
            if ((typeof ImageBitmap !== 'undefined' && item instanceof ImageBitmap)
                || (typeof MessagePort !== 'undefined' && item instanceof MessagePort)) item.close();
        }
    };
    const receive = ({ data }: MessageEvent<unknown>) => {
        if (disposed || !mainMessage(data)) return;
        if (!('id' in data)) {
            if ('cancel' in data) { const task = tasks.get(data.cancel); if (task) stop(task); }
            else if ('reprioritise' in data) { const task = tasks.get(data.reprioritise); if (task) task.priority = data.priority; }
            else if ('pause' in data) { const task = tasks.get(data.pause); if (task) task.paused = true; }
            else { const task = tasks.get(data.resume); if (task) { task.paused = false; task.wake?.(); } }
            return;
        }
        if (tasks.has(data.id)) return;
        const task: Task = { cancelled: false, controller: new AbortController(), paused: false, priority: data.priority, heard: -Infinity, transfer: [] };
        tasks.set(data.id, task);
        const check = () => { if (task.cancelled || disposed) throw new WorkerHostError('Cancelled', 'Worker request cancelled'); };
        const context: WorkerContext = {
            get cancelled() { return task.cancelled || disposed; },
            signal: task.controller.signal,
            heartbeat() {
                const time = now();
                if (time - task.heard < 250) return;
                task.heard = time;
                post({ v: 1, event: 'heartbeat', data: { id: data.id } });
            },
            async slice() {
                context.heartbeat();
                await new Promise<void>(resolve => setTimeout(resolve, 0));
                while (task.paused && !task.cancelled && !disposed) await new Promise<void>(resolve => { task.wake = resolve; });
                task.wake = undefined;
                check();
            },
            transfer(...items) { task.transfer.push(...items); },
            emit(event, value, transfer = []) { assertPayload(value); post({ v: 1, event, data: value }, transfer); },
        };
        void (async () => {
            try {
                const handler = Object.hasOwn(spec.handlers, data.op) ? spec.handlers[data.op] : undefined;
                if (!handler) throw new WorkerHostError('Protocol', `Unknown worker operation: ${data.op}`);
                check();
                const result = await handler(data.args, context);
                await assertReply(result, context);
                check();
                if (!disposed) post({ v: 1, id: data.id, ok: true, result }, task.transfer);
                else closeTransfers(task);
            } catch (error) {
                closeTransfers(task);
                if (!disposed) {
                    const name = error instanceof Error ? error.name : 'Error';
                    const message = error instanceof Error ? error.message : String(error);
                    post({ v: 1, id: data.id, ok: false, error: { name, message } });
                }
            } finally { tasks.delete(data.id); }
        })().catch(() => {
            // Even the error reply may fail if a contained frame has already been torn down.
            // Its main-thread host owns endpoint liveness and settles the waiting caller.
        });
    };
    endpoint.addEventListener('message', receive);
    endpoint.start?.();
    post({ v: 1, hello: { protocol: spec.protocol, buildId: spec.buildId, capabilities: spec.capabilities ?? Object.keys(spec.handlers) } });
    return () => {
        if (disposed) return;
        disposed = true;
        endpoint.removeEventListener('message', receive);
        for (const task of tasks.values()) stop(task);
        tasks.clear();
    };
}
