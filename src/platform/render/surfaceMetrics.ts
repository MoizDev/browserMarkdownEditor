import type { Viewport } from '../types';
import { RENDER_CONSTANTS } from './constants';
import type { GfxLimits } from './gfx/api';
import type { GpuGrant, SurfaceResizeResult } from './surfaceBroker.types';

export interface PhysicalBox {
    readonly width: number;
    readonly height: number;
    readonly fallbackSizing: boolean;
}

export interface DevicePixelFragment { inlineSize: number; blockSize: number }

function validDimension(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }

function validateDpr(dpr: number): void {
    if (!Number.isFinite(dpr) || dpr <= 0) throw new RangeError('Nominal DPR must be finite and positive');
}

export function devicePixelBox(fragments: readonly DevicePixelFragment[], writingMode: 'horizontal' | 'vertical' = 'horizontal'): PhysicalBox {
    if (fragments.length !== 1 || (writingMode !== 'horizontal' && writingMode !== 'vertical')) {
        throw new RangeError('A surface must have exactly one content-box fragment and a valid axis');
    }
    const fragment = fragments[0];
    const width = writingMode === 'horizontal' ? fragment.inlineSize : fragment.blockSize;
    const height = writingMode === 'horizontal' ? fragment.blockSize : fragment.inlineSize;
    if (!validDimension(width) || !validDimension(height)) throw new RangeError('Physical box dimensions must be nonnegative safe integers');
    return Object.freeze({ width, height, fallbackSizing: false });
}

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

export interface DormantSurfaceMetrics {
    readonly kind: 'dormant';
    readonly box: PhysicalBox;
    readonly nominalDpr: number;
    readonly reason: 'zero-size' | 'no-drawable-area';
}

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

export type SurfaceMetrics = DormantSurfaceMetrics | ReadySurfaceMetrics;

export const MIN_SURFACE_QUALITY = 0.25;

export function computeSurfaceMetrics(box: PhysicalBox, nominalDpr: number, limits: Readonly<GfxLimits>, pixelGrant: number): SurfaceMetrics {
    validateDpr(nominalDpr);
    if (!validDimension(box.width) || !validDimension(box.height) || !Number.isSafeInteger(pixelGrant) || pixelGrant < 0) {
        throw new RangeError('Surface dimensions/grant must be finite and nonnegative');
    }
    const axes = [limits.maxTexture2D, limits.maxRenderTargetSize, ...limits.maxViewport];
    if (axes.some(value => !Number.isSafeInteger(value) || value <= 0)) throw new RangeError('Device axis limits must be positive safe integers');
    const measured = Object.freeze({ ...box });
    if (!box.width || !box.height) return Object.freeze({ kind: 'dormant', box: measured, nominalDpr, reason: 'zero-size' });
    const maxWidth = Math.min(RENDER_CONSTANTS.maxSurfaceAxisPixels, limits.maxTexture2D, limits.maxRenderTargetSize, limits.maxViewport[0]);
    const maxHeight = Math.min(RENDER_CONSTANTS.maxSurfaceAxisPixels, limits.maxTexture2D, limits.maxRenderTargetSize, limits.maxViewport[1]);
    const grant = Math.floor(pixelGrant);
    const device = Math.min(1, maxWidth / box.width, maxHeight / box.height,
        Math.sqrt(RENDER_CONSTANTS.maxSurfacePixels / box.width / box.height));
    const q = Math.min(device, Math.max(MIN_SURFACE_QUALITY, Math.sqrt(grant / box.width / box.height)));
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

export type SurfaceCommitTarget = Pick<GpuGrant, 'generation' | 'limits' | 'resizeSurface'>;

export interface SurfaceCommitTags {
    readonly frameId: number;
    readonly geometryGeneration: number;
    readonly deviceGeneration: number;
}

export type SurfaceCommit =
    | { readonly kind: 'ready'; readonly tags: SurfaceCommitTags; readonly metrics: ReadySurfaceMetrics; readonly actual: SurfaceResizeResult }
    | { readonly kind: 'dormant'; readonly tags: SurfaceCommitTags; readonly metrics: DormantSurfaceMetrics }
    | { readonly kind: 'failed'; readonly tags: SurfaceCommitTags; readonly metrics: ReadySurfaceMetrics;
        readonly reason: 'stale-limits' | 'resize-failed' | 'stale-generation' | 'incomplete' | 'refused' | 'buffer-mismatch';
        readonly actual: SurfaceResizeResult | null };

export class SurfaceMetricsCommitter {
    private lastFrameId = -1;
    private lastGeometryGeneration = -1;
    private accepted: Exclude<SurfaceCommit, { kind: 'failed' }> | null = null;

    get current(): Exclude<SurfaceCommit, { kind: 'failed' }> | null { return this.accepted; }

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
            this.accepted = Object.freeze({ kind: 'dormant', tags, metrics });
            return this.accepted;
        }
        let reason: Extract<SurfaceCommit, { kind: 'failed' }>['reason'] | null = null;
        let actual: SurfaceResizeResult | null = null;
        if (metrics.limits !== target.limits) reason = 'stale-limits';
        else {
            try {
                actual = Object.freeze({ ...target.resizeSurface(metrics.backingWidth, metrics.backingHeight) });
                if (target.generation !== tags.deviceGeneration || actual.generation !== tags.deviceGeneration) reason = 'stale-generation';
                else if (actual.refused) reason = 'refused';
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
