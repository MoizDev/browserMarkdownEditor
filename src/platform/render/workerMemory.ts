import { onWorkerStop } from '../workers/lifecycle';
import { getPlatformRuntime } from './platformRuntime';

/** Report only worker-owned bytes not already represented by governor leases. */
export function reportWorkerMemory(worker: object, ownedBytes: number): void {
    const governor = getPlatformRuntime().governor;
    if (onWorkerStop(worker, () => governor.releaseWorkerMemory(worker))) {
        governor.reportWorkerMemory(worker, ownedBytes);
    }
}

/** Call when that worker stops; repeated release is harmless. */
export function releaseWorkerMemory(worker: object): void {
    getPlatformRuntime().governor.releaseWorkerMemory(worker);
}
