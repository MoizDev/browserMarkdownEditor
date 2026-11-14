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
    return JSON.stringify([identity.docKey, identity.page, EMPHASIS_ALGORITHM, EMPHASIS_REVISION,
        identity.locale, EMPHASIS_STROKE_EM, identity.engineBuild, identity.assetsRevision,
        identity.geometryRevision, identity.renderProfile, identity.backgroundProfile, EMPHASIS_PROBE_PROFILE]);
}

/** Fixed, whole-page proof geometry; independent of zoom, DPR and preference. */
export function emphasisProbeGeometry(width: number, height: number, maxPixels: number, maxEdge: number): {
    scale: number; width: number; height: number;
} {
    if (![width, height].every(value => Number.isFinite(value) && value > 0) ||
        !Number.isSafeInteger(maxPixels) || maxPixels <= 0 || maxPixels > EMPHASIS_MAX_PROBE_PIXELS ||
        !Number.isSafeInteger(maxEdge) || maxEdge <= 0) throw new RangeError('Invalid emphasis probe geometry');
    const area = width * height;
    if (!Number.isFinite(area) || area <= 0) throw new RangeError('Invalid emphasis page area');
    let scale = Math.min(1.5, Math.sqrt(maxPixels / area));
    const dimensions = (s: number) => ({ width: Math.max(1, Math.ceil(width * s)), height: Math.max(1, Math.ceil(height * s)) });
    let size = dimensions(scale);
    if (size.width * size.height > maxPixels) {
        let low = 0, high = scale;
        for (let i = 0; i < 60; i++) {
            const mid = (low + high) / 2, candidate = dimensions(mid);
            if (candidate.width * candidate.height <= maxPixels) low = mid;
            else high = mid;
        }
        scale = low;
        size = dimensions(scale);
    }
    if (!(scale > 0) || size.width * size.height > maxPixels || size.width > maxEdge || size.height > maxEdge) {
        throw new RangeError('Emphasis probe exceeds raster limits');
    }
    return { scale, ...size };
}
