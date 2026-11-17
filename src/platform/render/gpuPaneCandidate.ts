import type { GfxError } from './gfx/api';
import { auditCount } from './renderAudit';
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

/** A GPU failure is never the document's: it demotes its pane to canvas2d, so the board opens. Logged once per failure with
 * its stack, because the harness and the console show only a message otherwise. Returns the typed code it fell back with. */
export function reportGpuFallback(where: string, error: unknown): GfxError {
    const raw = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
    const code: GfxError = typeof raw === 'string' && GFX_CODES.includes(raw as GfxError) ? raw as GfxError : 'invalid-resource';
    auditCount('pane', `fallback:pane-2d:gpu-error:${typeof raw === 'string' ? raw : 'unknown'}`);
    console.error(`GPU ${where} failed; this pane continues on canvas2d:`, error instanceof Error ? error.stack ?? error.message : error);
    return code;
}

const GFX_CODES: readonly GfxError[] = ['lost', 'out-of-budget', 'allocation', 'unsupported', 'invalid-resource', 'invalid-input', 'aborted'];

export interface GpuPaneCandidateOptions {
    readonly runtime: PlatformRuntime;
    readonly paneId: string;
    readonly viewLease: number;
    readonly owner: MemorySessionOwner;
    readonly surface: () => SurfaceLease | null;
    invalidate(reason: string): void;
    onReady(pane: QualifiedGpuPane): void;
    /** Frees up to `bytes` of this pane's GPU residency and returns the bytes it freed; 0 when it frees none. */
    onEvict(bytes: number): number;
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
                // Synchronous: the governor's reservation needs the bytes now. A superseded or disposed generation frees nothing.
                evict: (bytes, pool) => {
                    if (pool !== 'gpu' || this.current !== generationRef.current || generationRef.current?.disposed ||
                        preparation.signal.aborted) return 0;
                    return this.options.onEvict(bytes);
                } });
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
                // Every GPU compositor error demotes this pane; none reaches the owner, so a board never fails to open on one.
                onError: error => defer(() => this.failure(preparation.generation, reportGpuFallback('compositor', error))),
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
            // A budget or allocation refusal is normal flow and is not logged; any other setup failure is, with its stack.
            const refusal = typeof error === 'object' && error !== null && 'code' in error &&
                (error.code === 'out-of-budget' || error.code === 'allocation');
            if (!preparation.signal.aborted && !refusal) reportGpuFallback('setup', error);
            if (!preparation.signal.aborted && !generation.failureReported && typeof error === 'object' && error !== null && 'code' in error) {
                const code = error.code;
                if (code === 'unsupported' || code === 'allocation' || code === 'out-of-budget' || code === 'lost') {
                    this.reportTrouble(generation, code);
                }
            }
            generation.disposed = true;
            generation.services.close();
            // A factory that sized the canvas before it failed keeps the backing charged, and the broker zeroes the canvas only
            // after this rejection: zeroed() then finds no current generation and never releases it. So the failed attempt
            // zeroes and releases its own backing here, as a normal zeroing does.
            preparation.canvas.width = 0;
            preparation.canvas.height = 0;
            generation.backing.releaseZeroed();
            generation.backing.close();
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

    /** The pane's GPU work threw outside the compositor's own callbacks (a frame, a layer, a request). The current device
     * generation falls back to canvas2d; with none current the error is only reported. */
    fail(error: unknown, where: string): void {
        const code = reportGpuFallback(where, error);
        const current = this.current;
        if (current && !current.disposed) this.failure(current.preparation.generation, code);
    }

    presented(generation: number): void {
        if (this.current?.preparation.generation === generation) this.current.deferredReported = false;
    }

    setVisible(visible: boolean, now: number): void {
        const generation = this.current;
        if (!generation || generation.disposed) return;
        generation.services.setVisible(visible, now);
        generation.backing.setVisible(visible, now);
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
