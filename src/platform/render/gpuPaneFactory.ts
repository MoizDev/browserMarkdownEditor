import type { PaneCompositor, LayerHost } from './compositor.types';
import type { MemoryAllocator } from './memoryGovernor';
import type { Webgl2Owner, Webgl2Services } from './gfx/webgl2';
import type { GpuPreparation, ResizeSurface } from './surfaceBroker.types';

/** Internal registration seam; consumers enter through attachPlatformPane, never a backend factory. */
export interface GpuPaneFactoryOptions {
    readonly preparation: GpuPreparation;
    readonly services: Webgl2Services;
    /** Bound to this preparation; rejects before/after its current broker grant. Never the raw owner callback. */
    readonly resizeSurface: ResizeSurface;
    readonly invalidate: (reason: string) => void;
    /** Backing reservation is supplied by the runtime, not an unbounded native resize. */
    readonly surface: MemoryAllocator;
}

/** Qualification has finished, but the displayed canvas may still be the frozen 2D bridge.
 * The lifecycle alone owns layers. The compositor and resource owner never end a layer's life.
 */
export interface PreparedGpuPane {
    readonly owner: Webgl2Owner;
    readonly compositor: PaneCompositor;
    readonly host: Pick<LayerHost, 'uniforms' | 'drawTexturedQuad'>;
}

export type GpuPaneFactory = (options: GpuPaneFactoryOptions) => Promise<PreparedGpuPane>;

let registered: GpuPaneFactory | null = null;

/** Registration is explicit and creates no context, observer, timer or animation frame. */
export function registerGpuPaneFactory(factory: GpuPaneFactory): void {
    if (registered && registered !== factory) throw new Error('The GPU pane factory is already registered');
    registered = factory;
}

export function currentGpuPaneFactory(): GpuPaneFactory | null { return registered; }
