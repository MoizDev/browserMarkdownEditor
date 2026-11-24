import { onWorkerStop, subscribeWorkerMemory, workerMemoryReports, workerOwnedBytes } from '../workers/lifecycle';
import { getPlatformRuntime } from './platformRuntime';
import type { MemoryGovernor } from './memoryGovernor';

let activeGovernor: MemoryGovernor | null = null;
const governor = () => activeGovernor ??= getPlatformRuntime().governor;

// The worker host remains render-free and may have reported before this lazy module loaded.
// Register first, then replay only still-current values so reentrant callbacks cannot resurrect
// a stopped endpoint or overwrite a newer estimate.
subscribeWorkerMemory((worker, bytes) => {
    if (bytes === null) activeGovernor?.releaseWorkerMemory(worker);
    else {
        const target = governor();
        if (workerOwnedBytes(worker) === (bytes || undefined)) target.reportWorkerMemory(worker, bytes);
    }
});
for (const [worker, bytes] of workerMemoryReports()) {
    const target = governor();
    if (workerOwnedBytes(worker) === bytes) target.reportWorkerMemory(worker, bytes);
}

/** Report only worker-owned bytes not already represented by governor leases. */
export function reportWorkerMemory(worker: object, ownedBytes: number): void {
    const target = governor();
    if (onWorkerStop(worker, () => target.releaseWorkerMemory(worker))) {
        target.reportWorkerMemory(worker, ownedBytes);
    }
}

/** Call when that worker stops; repeated release is harmless. */
export function releaseWorkerMemory(worker: object): void {
    activeGovernor?.releaseWorkerMemory(worker);
}
