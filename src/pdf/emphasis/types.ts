import type { EMPHASIS_ALGORITHM, EMPHASIS_PROBE_PROFILE, EMPHASIS_REVISION, EMPHASIS_STROKE_EM } from './profile';

/** Refinements of the existing worker operations, not a second transport. */
export interface EmphasisSpec {
    algorithm: typeof EMPHASIS_ALGORITHM;
    revision: typeof EMPHASIS_REVISION;
    strokeEm: typeof EMPHASIS_STROKE_EM;
    locale?: string;
}
export type TileEmphasisArgs =
    | { variant: 'plain'; profileKey: string; emphasis?: never }
    | { variant: 'emphasis'; profileKey: string; emphasis: EmphasisSpec };
export interface PageProbeArgs extends EmphasisSpec {
    docKey: string;
    page: number;
    profileKey: string;
    maxPixels: number;
}
export type ProbeReason = 'no-text' | 'no-eligible-prefixes' | 'ambiguous-glyphs' | 'no-visible-change';
export interface ProbeGeometry {
    profile: typeof EMPHASIS_PROBE_PROFILE;
    scale: number;
    w: number;
    h: number;
}
export interface PageProbeResult {
    complete: true;
    candidates: number;
    eligibleGlyphs: number;
    changedPixels: number;
    capability: 'supported' | 'unavailable';
    reason?: ProbeReason;
    probe: ProbeGeometry & { rendered: boolean };
}
export type ProbeErrorName = 'AbortError' | 'PasswordRequired' | 'UnsupportedSecurity' | 'InvalidPdf' | 'FileError' |
    'PageError' | 'NotFoundError' | 'NotSupported' | 'RangeError' | 'ResourceLimit' | 'EngineBroken' | 'WorkerDied';
/** A failed operation is never a completed, negative capability verdict. Names
 * match the existing engine error vocabulary; transport envelopes remain C5. */
export interface ProbeOperationalFailure { name: ProbeErrorName; message: string; retryable: boolean }
export interface ProbeFailure extends ProbeOperationalFailure {
    name: 'RangeError' | 'ResourceLimit';
    code: 'invalid-geometry' | 'invalid-limits' | 'area-overflow' | 'edge-limit' | 'pixel-limit';
}
export type ProbeGeometryResult =
    | { ok: true; geometry: ProbeGeometry }
    | { ok: false; error: ProbeFailure };
