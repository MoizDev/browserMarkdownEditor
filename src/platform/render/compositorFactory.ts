import { createGpuCompositor } from './compositor';
import type { GpuCompositor } from './compositor';
import { createWebgl2Factory } from './gfx/webgl2';
import { registerGpuPaneFactory } from './gpuPaneFactory';
import type { GpuPaneFactory } from './gpuPaneFactory';

/** The broker creates and owns the native context; this registration only binds its qualified
 * generation to the shared compositor. Backing admission and resize belong to the attaching actor.
 */
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
        compositor = createGpuCompositor({ owner, canvas: options.preparation.canvas,
            target: { generation: options.preparation.generation, limits: owner.limits, resizeSurface: options.resizeSurface },
            invalidate: options.invalidate, onError: options.onError, onDeferred: options.onDeferred });
        return { owner, compositor };
    } catch (error) {
        owner.dispose(options.preparation.signal.aborted ? 'stale' : 'creation-failed');
        throw error;
    }
};

/** Called once by platform startup; importing a module never creates a context or schedules work. */
export function registerWebgl2PaneFactory(): void { registerGpuPaneFactory(createGpuPane); }
