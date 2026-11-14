import type { GfxError } from './gfx/api';
import type { Webgl2Services } from './gfx/webgl2';
import type { MemoryCacheHandle, MemoryGovernor, MemorySessionOwner } from './memoryGovernor';
import type { FrameScheduler } from './scheduler';

export interface GpuPaneServicesOptions {
    readonly id: string;
    readonly paneId: string;
    readonly owner: MemorySessionOwner;
    readonly governor: MemoryGovernor;
    readonly scheduler: FrameScheduler;
    readonly now: number;
    onFailure(code: GfxError): void;
    onFenceAge(ageMs: number): void;
    evict(): void;
}

/** Each cache receives the exact lease objects the arena returns. Closing a cache stops
 * new admissions; submitted resources keep their charges until the arena reports retirement.
 */
export class GpuPaneServices {
    readonly services: Webgl2Services;
    private readonly handles: readonly MemoryCacheHandle[];
    private closed = false;

    constructor(options: GpuPaneServicesOptions) {
        const common = { paneId: options.paneId, owner: options.owner, hiddenAt: null,
            lastVisibleAt: options.now, lastUsedAt: options.now, class: 'scene-cache' as const,
            // Leases remain charged as queued/retiring until the arena returns them; no free is inferred.
            memory: () => ({ live: 0, retiring: 0 }), evict: options.evict };
        const opened: MemoryCacheHandle[] = [];
        try {
            const register = (suffix: string, pool: 'gpu' | 'cpu', kind: 'working' | 'program'): MemoryCacheHandle => {
                const handle = options.governor.register({ ...common, id: `${options.id}:${suffix}`, pool, kind });
                opened.push(handle);
                return handle;
            };
            const working = register('working', 'gpu', 'working');
            const program = register('program', 'gpu', 'program');
            const gpuStaging = register('gpu-staging', 'gpu', 'working');
            const cpuStaging = register('cpu-staging', 'cpu', 'working');
            this.services = {
                working, program, gpuStaging, cpuStaging,
                returnLease: lease => options.governor.releaseLease(lease),
                schedulePoll: callback => options.scheduler.schedulePoll(callback),
                onFailure: options.onFailure,
                recordUpload: (bytes, ms) => options.scheduler.recordUpload(bytes, ms),
                recordUniformUpload: (bytes, ms) => options.scheduler.recordUniformUpload(bytes, ms),
                observeFenceAge: options.onFenceAge,
            };
        } catch (error) {
            for (const handle of opened) handle.close();
            throw error;
        }
        this.handles = opened;
    }

    setVisible(visible: boolean, now: number): void {
        for (const handle of this.handles) handle.updateActivity({ hiddenAt: visible ? null : now, lastVisibleAt: now, lastUsedAt: now });
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        for (const handle of this.handles) handle.close();
    }
}
