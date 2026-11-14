import type { ProbeFailure, ProbeGeometryResult } from './types';

export const EMPHASIS_ALGORITHM = 'latin-prefix-v1' as const;
export const EMPHASIS_REVISION = 'pdf-prefix-cells-v1' as const;
export const EMPHASIS_STROKE_EM = 0.035 as const;
export const EMPHASIS_PROBE_PROFILE = 'page-probe-v1' as const;
export const EMPHASIS_MAX_PROBE_PIXELS = 1_048_576;

export interface EmphasisVerdictIdentity {
    docKey: string;
    page: number;
    locale: string;
    engineBuild: string;
    assetsRevision: string;
    geometryRevision: string;
    renderProfile: string;
    backgroundProfile: string;
}

/** JSON tuple encoding keeps independent fields unambiguous, including arbitrary doc keys. */
export function emphasisVerdictKey(identity: EmphasisVerdictIdentity): string {
    if (!Number.isSafeInteger(identity.page) || identity.page < 0 ||
        ![identity.docKey, identity.locale, identity.engineBuild, identity.assetsRevision,
            identity.geometryRevision, identity.renderProfile, identity.backgroundProfile].every(value => typeof value === 'string' && value.length > 0)) {
        throw new RangeError('Invalid immutable PDF emphasis verdict identity');
    }
    return JSON.stringify([identity.docKey, identity.page, EMPHASIS_ALGORITHM, EMPHASIS_REVISION,
        identity.locale, EMPHASIS_STROKE_EM, identity.engineBuild, identity.assetsRevision,
        identity.geometryRevision, identity.renderProfile, identity.backgroundProfile, EMPHASIS_PROBE_PROFILE]);
}

const failure = (name: ProbeFailure['name'], code: ProbeFailure['code'], message: string): ProbeGeometryResult =>
    ({ ok: false, error: { name, code, message, retryable: false } });

/** Fixed whole-page geometry. Neither view state nor a user preference enters
 * the profile; exceptional dimensions produce an engine-mappable failure. */
export function planEmphasisProbeGeometry(width: number, height: number, maxPixels: number, maxEdge: number): ProbeGeometryResult {
    if (![width, height].every(value => Number.isFinite(value) && value > 0))
        return failure('RangeError', 'invalid-geometry', 'Invalid emphasis page geometry');
    if (!Number.isSafeInteger(maxPixels) || maxPixels <= 0 || !Number.isSafeInteger(maxEdge) || maxEdge <= 0)
        return failure('RangeError', 'invalid-limits', 'Invalid emphasis probe limits');
    const budget = Math.min(maxPixels, EMPHASIS_MAX_PROBE_PIXELS), area = width * height;
    if (!Number.isFinite(area) || area <= 0) return failure('ResourceLimit', 'area-overflow', 'Emphasis page area exceeds supported geometry');
    let scale = Math.min(1.5, Math.sqrt(budget / area));
    const dimensions = (s: number) => ({ w: Math.max(1, Math.ceil(width * s)), h: Math.max(1, Math.ceil(height * s)) });
    let size = dimensions(scale);
    if (size.w * size.h > budget) {
        let low = 0, high = scale;
        for (let i = 0; i < 60; i++) {
            const mid = (low + high) / 2, candidate = dimensions(mid);
            if (candidate.w * candidate.h <= budget) low = mid;
            else high = mid;
        }
        scale = low;
        size = dimensions(scale);
    }
    if (!(scale > 0) || !Number.isSafeInteger(size.w) || !Number.isSafeInteger(size.h) || size.w * size.h > budget)
        return failure('ResourceLimit', 'pixel-limit', 'Emphasis probe exceeds its pixel budget');
    if (size.w > maxEdge || size.h > maxEdge)
        return failure('ResourceLimit', 'edge-limit', 'Emphasis probe exceeds the maximum raster edge');
    return { ok: true, geometry: { profile: EMPHASIS_PROBE_PROFILE, scale, ...size } };
}

/** Compatibility for callers already using width/height; the thrown name is
 * the typed engine error, not an unsupported-page verdict. */
export function emphasisProbeGeometry(width: number, height: number, maxPixels: number, maxEdge: number): {
    scale: number; width: number; height: number;
} {
    const result = planEmphasisProbeGeometry(width, height, maxPixels, maxEdge);
    if (!result.ok) {
        const error = new Error(result.error.message);
        error.name = result.error.name;
        throw error;
    }
    return { scale: result.geometry.scale, width: result.geometry.w, height: result.geometry.h };
}
