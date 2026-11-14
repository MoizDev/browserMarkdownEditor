import type { Priority } from './envelope';

/** Library-scoped events: callers provide observed times and ledger values, never document data. */
export interface WorkerPerfRecord {
    readonly worker: string;
    readonly generation: number;
    readonly requestId: number;
    readonly priority: Priority;
    readonly phase: 'request' | 'post' | 'settle' | 'permit';
    readonly time: number;
    readonly requestTime: number;
    readonly postTime: number | null;
    readonly inFlight: number;
    readonly permitsHeld: number;
    readonly permitsQueued: number;
}

export interface WorkerPerfSnapshot {
    readonly records: readonly WorkerPerfRecord[];
    readonly overflow: number;
}

const capacity = 8192;
let records: WorkerPerfRecord[] | undefined;
let overflow = 0;
let oldest = 0;

export function recordWorkerPerf(record: WorkerPerfRecord): void {
    if (!__BME_BENCH__) return;
    records ??= [];
    const copy = Object.freeze({ ...record });
    if (records.length < capacity) records.push(copy);
    else { records[oldest] = copy; oldest = (oldest + 1) % capacity; overflow++; }
    exposeWorkerPerf();
}

export function readWorkerPerf(): WorkerPerfSnapshot | null {
    if (!__BME_BENCH__) return null;
    const values = records ?? [];
    return Object.freeze({ records: Object.freeze([...values.slice(oldest), ...values.slice(0, oldest)]), overflow });
}

function exposeWorkerPerf(): void {
    if (!__BME_BENCH__ || typeof window === 'undefined') return;
    const w = window as unknown as { __perf?: Record<string, unknown> };
    w.__perf ??= { plant: 'bme-perf-hooks-plant-7f3a' };
    w.__perf.workers ??= Object.freeze({ snapshot: readWorkerPerf });
}
