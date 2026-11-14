import { createWorkerClient } from '../workers/client';
import type { WorkerClient } from '../workers/envelope';
import type { ByteLease } from './gfx/api';
import type { MemoryAllocator } from './memoryGovernor';
import type { FrameToken } from './types';

export interface CoverageFrameTag {
    readonly frameId: number;
    readonly token: FrameToken;
    readonly cameraEpoch: number;
}
export interface CoverageCount {
    readonly frame: CoverageFrameTag;
    readonly outside: number;
    readonly hole: number;
    readonly standin: number;
    readonly current: number;
    readonly invalid: number;
    readonly pixels: number;
    readonly ownedScratchBytes: number;
}
export type CoverageDropReason = 'disabled' | 'overflow' | 'memory' | 'invalid' | 'deadline' | 'stale' | 'error' | 'disposed';
export interface CoverageCounterOptions {
    readonly memory: MemoryAllocator;
    onCount(result: CoverageCount): void;
    onDrop(frame: CoverageFrameTag, reason: CoverageDropReason): void;
}
export interface CoverageCounter {
    count(bitmap: ImageBitmap, frameTag: CoverageFrameTag): boolean;
    dispose(): void;
}

interface Pending {
    readonly bitmap: ImageBitmap;
    readonly frame: CoverageFrameTag;
    readonly pixels: number;
    readonly lease: ByteLease;
    readonly deadline: number;
    timer: ReturnType<typeof setTimeout> | null;
    closed: boolean;
}

let nextCounter = 0;
const deadlineMs = 15000;
const maxOwned = 8;

function validFrame(frame: CoverageFrameTag): boolean {
    const token = frame?.token;
    return !!token && typeof token.documentId === 'string' &&
        [frame.frameId, frame.cameraEpoch, token.vaultEpoch, token.bytesGeneration, token.session, token.viewLease, token.deviceGeneration]
            .every(value => Number.isSafeInteger(value) && value >= 0);
}
function copyFrame(frame: CoverageFrameTag): CoverageFrameTag {
    return Object.freeze({ frameId: frame.frameId, cameraEpoch: frame.cameraEpoch, token: Object.freeze({ ...frame.token }) });
}
function sameFrame(a: CoverageFrameTag, b: CoverageFrameTag): boolean {
    return validFrame(a) && a.frameId === b.frameId && a.cameraEpoch === b.cameraEpoch &&
        a.token.vaultEpoch === b.token.vaultEpoch && a.token.documentId === b.token.documentId &&
        a.token.bytesGeneration === b.token.bytesGeneration && a.token.session === b.token.session &&
        a.token.viewLease === b.token.viewLease && a.token.deviceGeneration === b.token.deviceGeneration;
}
function validCount(result: CoverageCount, pixels: number): boolean {
    if (!result || typeof result !== 'object' || result.pixels !== pixels || result.ownedScratchBytes !== pixels * 16) return false;
    const counts = [result.outside, result.hole, result.standin, result.current, result.invalid];
    return counts.every(value => Number.isSafeInteger(value) && value >= 0) && counts.reduce((sum, value) => sum + value, 0) === pixels;
}

/** Benchmark-only ownership boundary: the caller gives up the bitmap even on refusal. */
export function createCoverageCounter(options: CoverageCounterOptions): CoverageCounter {
    let disposed = false;
    let client: WorkerClient | null = null;
    let active: Pending | null = null;
    const queue: Pending[] = [];
    const notifyDrop = (frame: CoverageFrameTag, reason: CoverageDropReason) => {
        try { options.onDrop(frame, reason); } catch (error) { console.error('Coverage drop callback failed:', error); }
    };
    const close = (item: Pending) => {
        if (item.closed) return;
        item.closed = true;
        if (item.timer !== null) clearTimeout(item.timer);
        item.timer = null;
        try { item.bitmap.close(); } finally { options.memory.release(item.lease); }
    };
    const pump = () => {
        if (disposed || active || !queue.length) return;
        const item = queue.shift()!;
        if (item.timer !== null) clearTimeout(item.timer);
        item.timer = null;
        const remaining = item.deadline - performance.now();
        if (remaining <= 0) { close(item); notifyDrop(item.frame, 'deadline'); pump(); return; }
        active = item;
        try {
            client ??= createWorkerClient({ name: `coverage-count:${++nextCounter}`, protocol: 1,
                spawn: () => {
                    if (!__BME_BENCH__) throw new Error('Coverage counting is disabled');
                    return new Worker(new URL('./coverageCount.worker.ts', import.meta.url), { type: 'module' });
                } });
            const request = client.request<CoverageCount>('count', { bitmap: item.bitmap, frame: item.frame }, {
                priority: 3, cpu: 'governed', deadlineMs: remaining, terminateOnDeadline: true, transfer: [item.bitmap],
            });
            void request.then(result => {
                if (disposed || item.closed) return;
                close(item); if (active === item) active = null;
                if (!sameFrame(result?.frame, item.frame)) notifyDrop(item.frame, 'stale');
                else if (!validCount(result, item.pixels)) notifyDrop(item.frame, 'invalid');
                else {
                    try { options.onCount(result); } catch (error) { console.error('Coverage count callback failed:', error); }
                }
                pump();
            }, error => {
                if (disposed || item.closed) return;
                close(item); if (active === item) active = null;
                notifyDrop(item.frame, error instanceof Error && error.name === 'Deadline' ? 'deadline' : 'error');
                pump();
            });
        } catch {
            close(item); active = null; notifyDrop(item.frame, 'error'); pump();
        }
    };
    return {
        count(bitmap, frameTag) {
            if (!__BME_BENCH__ || disposed || !validFrame(frameTag)) {
                bitmap.close();
                notifyDrop(frameTag, !__BME_BENCH__ ? 'disabled' : disposed ? 'disposed' : 'invalid');
                return false;
            }
            const frame = copyFrame(frameTag);
            const pixels = bitmap.width * bitmap.height, bytes = pixels * 20;
            if (!bitmap.width || !bitmap.height || !Number.isSafeInteger(bytes)) {
                bitmap.close(); notifyDrop(frame, 'invalid'); return false;
            }
            if (queue.length + Number(active !== null) >= maxOwned) {
                bitmap.close(); notifyDrop(frame, 'overflow'); return false;
            }
            let lease: ByteLease | null;
            try { lease = options.memory.reserve(bytes); }
            catch { bitmap.close(); notifyDrop(frame, 'memory'); return false; }
            if (!lease) { bitmap.close(); notifyDrop(frame, 'memory'); return false; }
            const item: Pending = { bitmap, frame, pixels, lease, deadline: performance.now() + deadlineMs, timer: null, closed: false };
            item.timer = setTimeout(() => {
                const index = queue.indexOf(item);
                if (index < 0) return;
                queue.splice(index, 1); close(item); notifyDrop(frame, 'deadline');
            }, deadlineMs);
            queue.push(item); pump();
            return true;
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            client?.dispose(); client = null;
            const pending = active ? [active, ...queue] : [...queue];
            active = null; queue.length = 0;
            for (const item of pending) close(item);
            for (const item of pending) notifyDrop(item.frame, 'disposed');
        },
    };
}
