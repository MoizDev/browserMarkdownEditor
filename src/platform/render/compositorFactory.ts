import { createGpuCompositor } from './compositor';
import type { GpuCompositor } from './compositor';
import { createWebgl2Factory } from './gfx/webgl2';
import { registerGpuPaneFactory } from './gpuPaneFactory';
import type { GpuPaneFactory } from './gpuPaneFactory';

export const createGpuPane: GpuPaneFactory = async options => {
    let compositor: GpuCompositor | null = null;
    const services = {
        ...options.services,
        schedulePoll: (callback: () => void) => options.services.schedulePoll(() => {
            callback();
            if (compositor?.retryPending) {
                options.invalidate('gpu-resource-retired');
            }
        }),
        recordUniformGrowth: (previous: number, next: number) => {
            options.services.recordUniformGrowth?.(previous, next);
            options.invalidate('gpu-uniform-growth');
        },
    };
    const owner = await createWebgl2Factory(services)(options.preparation);
    try {
        compositor = createGpuCompositor({ owner, canvas: options.preparation.canvas, paneId: options.paneId,
            target: { generation: options.preparation.generation, limits: owner.limits, resizeSurface: options.resizeSurface },
            invalidate: options.invalidate, onError: options.onError, onDeferred: options.onDeferred });
        return { owner, compositor };
    } catch (error) {
        owner.dispose(options.preparation.signal.aborted ? 'stale' : 'creation-failed');
        throw error;
    }
};

export function registerWebgl2PaneFactory(): void { registerGpuPaneFactory(createGpuPane); }
