import type { PaneCompositor } from './compositor.types';
import type { Webgl2Owner, Webgl2Services } from './gfx/webgl2';
import type { GpuPreparation, ResizeSurface } from './surfaceBroker.types';

export interface GpuPaneFactoryOptions {
    readonly paneId: string;
    readonly preparation: GpuPreparation;
    readonly services: Webgl2Services;
    readonly resizeSurface: ResizeSurface;
    readonly invalidate: (reason: string) => void;
    readonly onError: (error: unknown) => void;
    readonly onDeferred: () => void;
}

export interface PreparedGpuPane {
    readonly owner: Webgl2Owner;
    readonly compositor: PaneCompositor;
}

export type GpuPaneFactory = (options: GpuPaneFactoryOptions) => Promise<PreparedGpuPane>;

let registered: GpuPaneFactory | null = null;

export function registerGpuPaneFactory(factory: GpuPaneFactory): void {
    if (registered && registered !== factory) throw new Error('The GPU pane factory is already registered');
    registered = factory;
}

export function currentGpuPaneFactory(): GpuPaneFactory | null { return registered; }
