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

/** One chunk of an `ink.batch` request. Its samples are regions of the batch's `input` buffer (byte offsets, multiples of 8):
 * `count` points of xy (float64 pairs), then pressure (float64, when `pressure`), then segment kinds (uint8). */
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
    /** The stroke's chunk count when a coarser level of detail may answer; absent, the fine coverage is built. */
    readonly lodChunks?: number;
}
export interface InkBatchRequest { readonly input: ArrayBuffer; readonly items: readonly InkBatchItem[] }
/** Each item's packed coverage is a region of `output` (packedCoverage.ts), or the error that item alone failed with. */
export type InkBatchResult = { readonly at: number; readonly bytes: number; readonly level: 'fine' | 'coarse' }
    | { readonly error: string; readonly name: string };
export interface InkBatchReply { readonly output: ArrayBuffer; readonly items: readonly InkBatchResult[] }
/** The error name of a chunk whose geometry crashed the geometry worker when it was asked for alone: the stroke is left out of
 * the picture and never asked for again on this page (inkCoverageClient.ts, services.ts). */
export const INK_GEOMETRY_CRASHED = 'InkGeometryCrashed';

/** Items one batch may carry: a batch is one message, one transfer each way and one reply the main thread unpacks at once. */
export const INK_BATCH_MAX_ITEMS = 256;
/** Bytes of one item's samples in the batch input, padded to whole doubles. */
export function inkBatchSampleBytes(count: number, pressure: boolean): number {
    return 16 * count + (pressure ? 8 * count : 0) + Math.ceil(count / 8) * 8;
}
