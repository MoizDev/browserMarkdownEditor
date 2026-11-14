import type { Viewport } from '../types';
import { RENDER_CONSTANTS } from './constants';
import type { GfxLimits } from './gfx/api';
import type { GpuGrant, SurfaceResizeResult } from './surfaceBroker.types';

/** A normalized physical box, not an independently rounded CSS extent (design §3.2:329–333). */
export interface PhysicalBox {
    readonly width: number;
    readonly height: number;
    readonly fallbackSizing: boolean;
}

/** Plain values copied by the adapter from its observation; no ResizeObserver lives here (§3.2:331). */
export interface DevicePixelFragment { inlineSize: number; blockSize: number }

function validDimension(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }

function validateDpr(dpr: number): void {
    if (!Number.isFinite(dpr) || dpr <= 0) throw new RangeError('Nominal DPR must be finite and positive');
}

/** Reject fragmented panes; vertical writing exchanges the physical axes (design §3.2:331). */
export function devicePixelBox(fragments: readonly DevicePixelFragment[], writingMode: 'horizontal' | 'vertical' = 'horizontal'): PhysicalBox {
    if (fragments.length !== 1) throw new RangeError('A surface must have exactly one content-box fragment');
    const fragment = fragments[0];
    const width = writingMode === 'horizontal' ? fragment.inlineSize : fragment.blockSize;
    const height = writingMode === 'horizontal' ? fragment.blockSize : fragment.inlineSize;
    if (!validDimension(width) || !validDimension(height)) throw new RangeError('Physical box dimensions must be nonnegative safe integers');
    return Object.freeze({ width, height, fallbackSizing: false });
}

/** Only the unsupported-device-box path rounds CSS * nominal DPR (design §3.2:333). */
export function cssFallbackBox(cssWidth: number, cssHeight: number, nominalDpr: number): PhysicalBox {
    validateDpr(nominalDpr);
    if (!Number.isFinite(cssWidth) || !Number.isFinite(cssHeight) || cssWidth < 0 || cssHeight < 0) {
        throw new RangeError('CSS box dimensions must be finite and nonnegative');
    }
    const width = Math.round(cssWidth * nominalDpr);
    const height = Math.round(cssHeight * nominalDpr);
    if (!validDimension(width) || !validDimension(height)) throw new RangeError('Fallback box exceeds safe physical dimensions');
    return Object.freeze({ width, height, fallbackSizing: true });
}

/** A zero box/grant never produces a Viewport with dpr=0 or a perpetual 1x1 allocation (§8:731). */
export interface DormantSurfaceMetrics {
    readonly kind: 'dormant';
    readonly box: PhysicalBox;
    readonly nominalDpr: number;
    readonly reason: 'zero-size' | 'no-drawable-area';
}

/** One uniform q; semantic CSS zoom stays unchanged even when raster quality falls (§3.2:337–341). */
export interface ReadySurfaceMetrics {
    readonly kind: 'ready';
    readonly box: PhysicalBox;
    readonly nominalDpr: number;
    readonly limits: Readonly<GfxLimits>;
    readonly pixelGrant: number;
    readonly qualityScale: number;
    readonly backingWidth: number;
    readonly backingHeight: number;
    readonly renderDpr: number;
    readonly viewport: Readonly<Viewport>;
}

/** Dormancy has no zero-DPR viewport to accidentally publish (design §8:731). */
export type SurfaceMetrics = DormantSurfaceMetrics | ReadySurfaceMetrics;

/** Pure planning only; limits belong to the current device generation, grant to the current frame.
 * No source page, canvas or render target is allocated before q has been bounded (design §3.2:335–345).
 */
export function computeSurfaceMetrics(box: PhysicalBox, nominalDpr: number, limits: Readonly<GfxLimits>, pixelGrant: number): SurfaceMetrics {
    validateDpr(nominalDpr);
    if (!validDimension(box.width) || !validDimension(box.height) || !Number.isFinite(pixelGrant) || pixelGrant < 0) {
        throw new RangeError('Surface dimensions/grant must be finite and nonnegative');
    }
    const axes = [limits.maxTexture2D, limits.maxRenderTargetSize, ...limits.maxViewport];
    if (axes.some(value => !Number.isSafeInteger(value) || value <= 0)) throw new RangeError('Device axis limits must be positive safe integers');
    const measured = Object.freeze({ ...box });
    if (!box.width || !box.height) return Object.freeze({ kind: 'dormant', box: measured, nominalDpr, reason: 'zero-size' });
    const maxWidth = Math.min(RENDER_CONSTANTS.maxSurfaceAxisPixels, limits.maxTexture2D, limits.maxRenderTargetSize, limits.maxViewport[0]);
    const maxHeight = Math.min(RENDER_CONSTANTS.maxSurfaceAxisPixels, limits.maxTexture2D, limits.maxRenderTargetSize, limits.maxViewport[1]);
    const grant = Math.floor(pixelGrant);
    const q = Math.min(1, maxWidth / box.width, maxHeight / box.height,
        Math.sqrt(RENDER_CONSTANTS.maxSurfacePixels / box.width / box.height), Math.sqrt(grant / box.width / box.height));
    const backingWidth = Math.floor(box.width * q);
    const backingHeight = Math.floor(box.height * q);
    const renderDpr = nominalDpr * q;
    if (!backingWidth || !backingHeight || !Number.isFinite(renderDpr) || renderDpr <= 0) {
        return Object.freeze({ kind: 'dormant', box: measured, nominalDpr, reason: 'no-drawable-area' });
    }
    const width = backingWidth / renderDpr;
    const height = backingHeight / renderDpr;
    if (!Number.isFinite(width) || !Number.isFinite(height)) throw new RangeError('Surface CSS extent exceeds finite coordinates');
    return Object.freeze({
        kind: 'ready', box: measured, nominalDpr, limits, pixelGrant: grant, qualityScale: q,
        backingWidth, backingHeight, renderDpr,
        // Never divide an integer backing size by a separately rounded layout width (C1.2:99–102).
        viewport: Object.freeze({ width, height, dpr: renderDpr }),
    });
}

/** The sole resize callback/result type is owned by surfaceBroker.types.ts (vr-lead sizing ruling).
 * The same structural target also permits the 2D compositor's canvas-size callback, without a GPU.
 */
export type SurfaceCommitTarget = Pick<GpuGrant, 'generation' | 'limits' | 'resizeSurface'>;

/** Size commits are frame-, geometry- and device-tagged; none is a document content revision (§8:730–737). */
export interface SurfaceCommitTags {
    readonly frameId: number;
    readonly geometryGeneration: number;
    readonly deviceGeneration: number;
}

/** Publish only a complete, generation-matching allocation (design §3.2:335,345; §8:734–737). */
export type SurfaceCommit =
    | { readonly kind: 'ready'; readonly tags: SurfaceCommitTags; readonly metrics: ReadySurfaceMetrics; readonly actual: SurfaceResizeResult }
    | { readonly kind: 'dormant'; readonly tags: SurfaceCommitTags; readonly metrics: DormantSurfaceMetrics }
    | { readonly kind: 'failed'; readonly tags: SurfaceCommitTags; readonly metrics: ReadySurfaceMetrics;
        readonly reason: 'stale-limits' | 'resize-failed' | 'stale-generation' | 'incomplete' | 'buffer-mismatch';
        readonly actual: SurfaceResizeResult | null };

/** The scheduler calls this on geometry/show invalidation, never from an observation callback.
 * Failure never publishes a new viewport; the compositor keeps its last complete 2D/mirror picture
 * while the governor reduces quality. Retaining those pixels is the compositor's job (§3.2:345).
 */
export class SurfaceMetricsCommitter {
    private lastFrameId = -1;
    private lastGeometryGeneration = -1;
    private accepted: Exclude<SurfaceCommit, { kind: 'failed' }> | null = null;

    get current(): Exclude<SurfaceCommit, { kind: 'failed' }> | null { return this.accepted; }

    /** Null means deferred/already attempted this frame, never a successful resize of the new plan.
     * A kept-context show still calls resizeSurface; the broker cannot restore an old grant's size.
     */
    commit(frameId: number, geometryGeneration: number, metrics: SurfaceMetrics, target: SurfaceCommitTarget): SurfaceCommit | null {
        if (![frameId, geometryGeneration, target.generation].every(value => Number.isSafeInteger(value) && value >= 0)) {
            throw new RangeError('Surface generations/frame ids must be nonnegative safe integers');
        }
        if (frameId < this.lastFrameId || geometryGeneration < this.lastGeometryGeneration) return null;
        if (frameId === this.lastFrameId) return null;
        this.lastFrameId = frameId;
        this.lastGeometryGeneration = geometryGeneration;
        const tags = Object.freeze({ frameId, geometryGeneration, deviceGeneration: target.generation });
        if (metrics.kind === 'dormant') {
            // Keep measured CSS geometry truthful: zero-size uses the broker's actual-zero path;
            // no-drawable-area needs pressure/admission handling, never a fabricated zero measurement.
            // This is a geometry record, not a claim that GPU resources have already been released.
            this.accepted = Object.freeze({ kind: 'dormant', tags, metrics });
            return this.accepted;
        }
        let reason: Extract<SurfaceCommit, { kind: 'failed' }>['reason'] | null = null;
        let actual: SurfaceResizeResult | null = null;
        if (metrics.limits !== target.limits) reason = 'stale-limits';
        else {
            try {
                actual = Object.freeze({ ...target.resizeSurface(metrics.backingWidth, metrics.backingHeight) });
                if (actual.generation !== target.generation) reason = 'stale-generation';
                else if (!actual.complete) reason = 'incomplete';
                else if (actual.width !== metrics.backingWidth || actual.height !== metrics.backingHeight) reason = 'buffer-mismatch';
            } catch {
                reason = 'resize-failed';
            }
        }
        if (reason || !actual) return Object.freeze({ kind: 'failed', tags, metrics, reason: reason ?? 'resize-failed', actual });
        this.accepted = Object.freeze({ kind: 'ready', tags, metrics, actual });
        return this.accepted;
    }
}
