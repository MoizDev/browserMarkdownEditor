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
export type InkCoverageReply = InkCoverage;

export interface InkBatchItem {
    readonly at: number;
    readonly count: number;
    readonly pressure: boolean;
    readonly indexOffset: number;
    readonly totalCount: number;
    readonly parameters: CurveParameters;
    readonly style: InkWidth;
    readonly range: CurveRange;
    readonly options: Omit<CoverageOptions, 'dotMetric'>;
    readonly lodChunks?: number;
}
export interface InkBatchRequest { readonly input: ArrayBuffer; readonly items: readonly InkBatchItem[] }
export type InkBatchResult = { readonly at: number; readonly bytes: number; readonly level: 'fine' | 'coarse' }
    | { readonly error: string; readonly name: string };
export interface InkBatchReply { readonly output: ArrayBuffer; readonly items: readonly InkBatchResult[] }
export const INK_GEOMETRY_CRASHED = 'InkGeometryCrashed';

export const INK_BATCH_MAX_ITEMS = 256;
export function inkBatchSampleBytes(count: number, pressure: boolean): number {
    return 16 * count + (pressure ? 8 * count : 0) + Math.ceil(count / 8) * 8;
}
