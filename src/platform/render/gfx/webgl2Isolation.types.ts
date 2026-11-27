import type { Samples, TextureFormat } from './api';

export interface IsolationReservation {
    readonly width: number;
    readonly height: number;
    readonly format: TextureFormat;
    readonly samples: Samples;
    readonly stencil: boolean;
    readonly count: number;
}

export interface GpuIsolationAdmission {
    readonly frameResourcesReady: boolean;
    prepareFrameResources(): void;
    admitIsolation(plan: readonly IsolationReservation[]): boolean;
}
