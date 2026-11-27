export type Priority = 0 | 1 | 2 | 3;
export type WorkerErrorName = 'Cancelled' | 'Deadline' | 'WorkerCrashed' | 'WorkerFailed' | 'Protocol';

export type MainMessage =
    | { v: 1; id: number; op: string; args: unknown; priority: Priority; deadlineMs?: number }
    | { v: 1; cancel: number }
    | { v: 1; reprioritise: number; priority: Priority }
    | { v: 1; pause: number }
    | { v: 1; resume: number };

export type WorkerMessage =
    | { v: 1; hello: { protocol: number; buildId: string; capabilities: string[] } }
    | { v: 1; id: number; ok: true; result: unknown; ms?: Record<string, number> }
    | { v: 1; id: number; ok: false; error: { name: string; message: string } }
    | { v: 1; event: string; data: unknown };

export class WorkerHostError extends Error {
    constructor(name: WorkerErrorName | string, message: string, readonly retryable = false, readonly poisoned = false, options?: ErrorOptions) {
        super(message, options);
        this.name = name;
    }
}

export function isCancellation(error: unknown): boolean {
    if (typeof DOMException !== 'undefined' && error instanceof DOMException) return error.name === 'AbortError';
    return error instanceof Error && (error.name === 'AbortError' || error.name === 'Cancelled');
}

export interface ContainedPort {
    port: MessagePort;
    terminate(): void;
    alive(): Promise<boolean>;
}

export interface RequestOptions {
    priority: Priority;
    deadlineMs?: number;
    terminateOnDeadline?: boolean;
    signal?: AbortSignal;
    transfer?: Transferable[];
    cpu?: 'governed' | 'light';
    key?: string;
}

export interface CpuPermit {
    readonly held: boolean;
    reprioritise(priority: Priority): void;
    release(): void;
}

export interface CpuAdmission {
    name: string;
    id: number;
    priority: Priority;
    start(): void;
    pause(): void;
    resume(): void;
}

export interface CpuPermits {
    acquire(admission: CpuAdmission): CpuPermit;
}

export interface WorkerSpec {
    name: string;
    protocol: number;
    spawn(): Worker | Promise<Worker | ContainedPort>;
    onStart?(client: WorkerClient): Promise<void>;
    silenceMs?: Record<Priority, number>;
    absoluteMs?: number;
    restartPolicy?: { delaysMs: readonly number[]; maxFailures: number; windowMs: number };
    disposeResult?(op: string, result: unknown): void;
    events?: readonly string[];
    eventLimit?: number;
    permits?: CpuPermits;
    fileHandleOps?: readonly string[];
}

export type ClientState = 'idle' | 'starting' | 'ready' | 'recycling' | 'backoff' | 'failed' | 'disposed';

export interface WorkerClient {
    request<T>(op: string, args: unknown, options: RequestOptions): Promise<T>;
    whenRetired(request: Promise<unknown>): Promise<void>;
    reprioritise(request: Promise<unknown>, priority: Priority): void;
    cancelAll(match: (op: string, args: unknown) => boolean): void;
    on(event: string, handler: (data: unknown) => void): () => void;
    recycle(reason: string, options?: { lazy?: boolean }): Promise<void>;
    reset(): void;
    dispose(): void;
    readonly state: ClientState;
    readonly generation: number;
    readonly inFlight: number;
    readonly failure: WorkerHostError | undefined;
}

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object';
}

export function isPriority(value: unknown): value is Priority {
    return value === 0 || value === 1 || value === 2 || value === 3;
}

export function isWorkerMessage(value: unknown): value is WorkerMessage {
    if (!record(value) || value.v !== 1) return false;
    if (['hello', 'id', 'event'].filter(key => key in value).length !== 1) return false;
    if ('hello' in value) {
        const h = value.hello;
        return record(h) && Number.isInteger(h.protocol) && typeof h.buildId === 'string'
            && Array.isArray(h.capabilities) && h.capabilities.every(c => typeof c === 'string');
    }
    if ('id' in value) {
        if (!Number.isSafeInteger(value.id) || (value.id as number) < 1) return false;
        if (value.ok === true) return 'result' in value && (value.ms === undefined
            || (record(value.ms) && Object.values(value.ms).every(n => typeof n === 'number' && Number.isFinite(n))));
        return value.ok === false && record(value.error)
            && typeof value.error.name === 'string' && typeof value.error.message === 'string';
    }
    return typeof value.event === 'string' && 'data' in value;
}

// Walk containers only; never scan the bytes of a buffer, bitmap or Blob.
export function assertPayload(value: unknown, seen = new Set<object>(), allowFileHandles = false): void {
    if (value === null || value === undefined || ['string', 'boolean', 'number', 'bigint'].includes(typeof value)) return;
    if (typeof value !== 'object') throw new WorkerHostError('Protocol', 'Worker payload must be plain data');
    if (seen.has(value)) return;
    seen.add(value);
    if (allowFileHandles && typeof FileSystemFileHandle !== 'undefined' && value instanceof FileSystemFileHandle) return;
    if (value instanceof ArrayBuffer) return;
    if (ArrayBuffer.isView(value)) {
        assertPayload(value.buffer, seen, allowFileHandles);
        return;
    }
    if (typeof ImageBitmap !== 'undefined' && value instanceof ImageBitmap) return;
    if (typeof MessagePort !== 'undefined' && value instanceof MessagePort) return;
    if (typeof Blob !== 'undefined' && value instanceof Blob && !(typeof File !== 'undefined' && value instanceof File)) return;
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
        throw new WorkerHostError('Protocol', `Worker payload contains a forbidden platform object (${String(prototype?.constructor?.name ?? 'unknown')})`);
    }
    for (const key of Object.keys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (!('value' in descriptor)) throw new WorkerHostError('Protocol', 'Worker payload must not contain accessors');
        assertPayload(descriptor.value, seen, allowFileHandles);
    }
}
