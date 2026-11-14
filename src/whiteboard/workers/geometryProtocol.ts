import type { CurveParameters, CurveRange } from '../ink/curve';
import type { CoverageOptions, InkCoverage } from '../ink/outline';
import type { InkWidth } from '../ink/width';

export interface InkCoverageRequest {
    samples: { xy: Float64Array; pressure: Float64Array | null; kinds: Uint8Array; indexOffset: number; totalCount: number };
    parameters: CurveParameters;
    style: InkWidth;
    range: CurveRange;
    options: Omit<CoverageOptions, 'dotMetric'>;
}
export type InkCoverageReply = Omit<InkCoverage, 'radiusAt'>;
