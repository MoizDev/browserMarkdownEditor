import type { GfxError } from './gfx/api';
import { currentGpuPaneFactory } from './gpuPaneFactory';
import type { PreparedGpuPane } from './gpuPaneFactory';
import { GpuPaneServices } from './gpuPaneServices';
import type { MemorySessionOwner } from './memoryGovernor';
import type { PlatformRuntime } from './platformRuntime';
import type { BrokerGpuOwner, ContextDisposeReason, GpuGrant, GpuPreparation, SurfaceLease } from './surfaceBroker.types';
import { SurfaceBacking } from './surfaceBacking';
import type { GpuReleaseReason } from './types';

export interface QualifiedGpuPane {
    readonly bundle: PreparedGpuPane;
    readonly grant: GpuGrant;
    readonly backing: SurfaceBacking;
}

export interface GpuPaneCandidateOptions {
    readonly runtime: PlatformRuntime;
    readonly paneId: string;
    readonly viewLease: number;
    readonly owner: MemorySessionOwner;
    readonly surface: () => SurfaceLease | null;
    invalidate(reason: string): void;
    onError(error: unknown): void;
    onReady(pane: QualifiedGpuPane): void;
    onEvict(): void;
    inputHealthy(): boolean;
    frameInterval(): number | null;
}

interface Generation {
    readonly preparation: GpuPreparation;
    readonly services: GpuPaneServices;
    readonly backing: SurfaceBacking;
    bundle: PreparedGpuPane | null;
    grant: GpuGrant | null;
    disposed: boolean;
    failureReported: boolean;
    deferredReported: boolean;
}

/** Qualified devices are built against the broker's context and kept detached until the lifecycle
 * authorizes a complete current frame. A failed/old generation can never resize its successor.
 */
export class GpuPaneCandidate {
    private current: Generation | null = null;
    private serial = 0;

    constructor(private readonly options: GpuPaneCandidateOptions) {}

    async prepare(preparation: GpuPreparation): Promise<BrokerGpuOwner> {
        const factory = currentGpuPaneFactory();
        if (!factory) throw new Error('No GPU compositor is registered');
        const id = `${this.options.paneId}:${this.options.viewLease}:gpu:${preparation.generation}:${++this.serial}`;
        const now = performance.now();
        const backing = new SurfaceBacking({ governor: this.options.runtime.governor, paneId: this.options.paneId,
            owner: this.options.owner, id, canvas: preparation.canvas, displayed: false, now });
        const generationRef: { current: Generation | null } = { current: null };
        const defer = (action: () => void): void => {
            const expected = generationRef.current;
            if (!expected) return;
            queueMicrotask(() => {
                if (this.current === expected && !expected.disposed && !preparation.signal.aborted) action();
            });
        };
        let services: GpuPaneServices;
        try {
            services = new GpuPaneServices({ id, paneId: this.options.paneId, owner: this.options.owner,
                governor: this.options.runtime.governor, scheduler: this.options.runtime.scheduler, now,
                onFailure: code => defer(() => this.failure(preparation.generation, code)),
                onFenceAge: age => {
                    const healthy = this.options.inputHealthy();
                    defer(() => this.options.runtime.observeFence(this.options.paneId, age, healthy));
                },
                onGpuTiming: (p95, samples, disjoint) => {
                    const interval = this.options.frameInterval();
                    if (interval !== null) defer(() => this.options.runtime.observeGpuTiming(this.options.paneId, p95, interval, samples, disjoint));
                },
                onFramebufferFailure: () => defer(() => this.options.runtime.trouble('framebuffer')),
                evict: () => defer(this.options.onEvict) });
        } catch (error) { backing.close(); throw error; }
        const generation: Generation = { preparation, services, backing, bundle: null, grant: null,
            disposed: false, failureReported: false, deferredReported: false };
        generationRef.current = generation;
        this.current = generation;
        try {
            const bundle = await factory({ preparation, services: services.services,
                resizeSurface: (width, height) => {
                    const grant = generation.grant;
                    if (this.current !== generation || generation.disposed || !grant || preparation.signal.aborted) {
                        return { width: 0, height: 0, complete: false, generation: preparation.generation };
                    }
                    return backing.resize(width, height, grant.resizeSurface) ??
                        { width: 0, height: 0, complete: false, generation: preparation.generation };
                },
                invalidate: this.options.invalidate,
                onError: error => defer(() => {
                    try { this.options.onError(error); }
                    finally {
                        const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
                        this.failure(preparation.generation, code === 'allocation' || code === 'out-of-budget' ||
                            code === 'unsupported' || code === 'lost' ? code : 'invalid-resource');
                    }
                }),
                onDeferred: () => {
                    const compositor = generation.bundle?.compositor;
                    if (!compositor || !('retryPending' in compositor) || compositor.retryPending !== true || generation.deferredReported) return;
                    generation.deferredReported = true;
                    defer(() => this.options.runtime.trouble('allocation'));
                },
            });
            generation.bundle = bundle;
            if (this.current !== generation || generation.disposed || preparation.signal.aborted) {
                bundle.compositor.dispose();
                bundle.owner.dispose('stale');
                throw new Error('GPU preparation was superseded');
            }
            const owner = bundle.owner;
            return {
                limits: owner.limits,
                resizeSurface: (width, height) => owner.resizeSurface(width, height),
                releaseGpu: reason => this.release(generation, reason),
                dispose: reason => this.disposeGeneration(generation, reason),
            };
        } catch (error) {
            if (!preparation.signal.aborted && !generation.failureReported && typeof error === 'object' && error !== null && 'code' in error) {
                const code = error.code;
                if (code === 'unsupported' || code === 'allocation' || code === 'out-of-budget' || code === 'lost') {
                    this.reportTrouble(generation, code);
                }
            }
            generation.disposed = true;
            generation.services.close();
            if (!preparation.canvas.width && !preparation.canvas.height) generation.backing.close();
            if (this.current === generation) this.current = null;
            throw error;
        }
    }

    ready(grant: GpuGrant): void {
        const generation = this.current;
        if (!generation || generation.disposed || !generation.bundle || generation.preparation.generation !== grant.generation ||
            generation.preparation.canvas !== grant.canvas) return;
        generation.grant = grant;
        this.options.runtime.clearCapabilityFailure(this.options.paneId);
        this.options.onReady({ bundle: generation.bundle, grant, backing: generation.backing });
    }

    presented(generation: number): void {
        if (this.current?.preparation.generation === generation) this.current.deferredReported = false;
    }

    /** Called only by the broker after it has actually set the native canvas to zero. */
    zeroed(canvas: HTMLCanvasElement): void {
        const generation = this.current;
        if (!generation || generation.preparation.canvas !== canvas) return;
        generation.backing.releaseZeroed();
        if (generation.disposed) generation.backing.close();
    }

    private reportTrouble(generation: Generation, code: GfxError): void {
        if (generation.failureReported) return;
        generation.failureReported = true;
        if (code === 'unsupported') this.options.runtime.observeCapabilityFailure(this.options.paneId);
        else if (code === 'lost') this.options.runtime.trouble('context-loss');
        else if (code === 'allocation' || code === 'out-of-budget') this.options.runtime.trouble('allocation');
    }

    private failure(generation: number, code: GfxError): void {
        const current = this.current;
        if (!current || current.preparation.generation !== generation) return;
        this.reportTrouble(current, code);
        const surface = this.options.surface();
        if (!surface) return;
        surface.failGpu(surface.stamp, generation, code === 'out-of-budget' ? 'out-of-budget' : 'creation-failed');
    }

    private release(generation: Generation, reason: GpuReleaseReason): void {
        const bundle = generation.bundle;
        if (!bundle) return;
        if (reason === 'context-lost') { bundle.owner.releaseGpu(reason); bundle.compositor.releaseGpu(reason); }
        else { bundle.compositor.releaseGpu(reason); bundle.owner.releaseGpu(reason); }
        this.options.runtime.clearDeviceTrouble(this.options.paneId);
    }

    private disposeGeneration(generation: Generation, reason: ContextDisposeReason): void {
        if (generation.disposed) return;
        generation.disposed = true;
        generation.grant = null;
        try { generation.bundle?.compositor.dispose(); }
        finally { try { generation.bundle?.owner.dispose(reason); } finally { generation.services.close(); } }
    }
}
