import type { Samples, TextureFormat } from './api';

/** One charged target class, bounded to the union of declared physical device rectangles. */
export interface IsolationReservation {
    readonly width: number;
    readonly height: number;
    readonly format: TextureFormat;
    readonly samples: Samples;
    readonly stencil: boolean;
    readonly count: number;
}

/** Platform-only device admission, always called before a draw callback. */
export interface GpuIsolationAdmission {
    readonly frameResourcesReady: boolean;
    prepareFrameResources(): void;
    admitIsolation(plan: readonly IsolationReservation[]): boolean;
}
