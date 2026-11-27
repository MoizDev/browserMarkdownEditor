import type { ByteLease } from './gfx/api';
import type { MemoryAllocator } from './memoryGovernor';

type Pool = 'gpu' | 'cpu';
const totals = new Map<string, { gpu: number; cpu: number }>();

export function measurementAllocator(paneId: string, pool: Pool, source: MemoryAllocator): MemoryAllocator {
    const owned = new Set<ByteLease>();
    return {
        reserve(bytes, options) {
            const lease = source.reserve(bytes, options);
            if (!lease) return null;
            owned.add(lease);
            const total = totals.get(paneId) ?? { gpu: 0, cpu: 0 };
            total[pool] += lease.bytes; totals.set(paneId, total);
            return lease;
        },
        release(lease) {
            if (!owned.has(lease)) return;
            source.release(lease);
            owned.delete(lease);
            const total = totals.get(paneId)!;
            total[pool] -= lease.bytes;
            if (!total.gpu && !total.cpu) totals.delete(paneId);
        },
    };
}

export function readMeasurementMemory(paneId: string): { measurementGpuBytes: number; measurementCpuBytes: number } {
    const total = totals.get(paneId);
    return { measurementGpuBytes: total?.gpu ?? 0, measurementCpuBytes: total?.cpu ?? 0 };
}
