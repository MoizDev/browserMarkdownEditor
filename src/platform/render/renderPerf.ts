import type { Camera } from '../types';
import type { FrameToken } from './types';

export interface RenderPerfFrame {
    readonly frameId: number;
    readonly token: FrameToken;
    readonly camera: Readonly<Camera>;
    readonly sceneRevision: string;
    readonly deviceGeneration: number;
    readonly memory: Readonly<Record<string, number>>;
    readonly grants: Readonly<Record<string, number>>;
    readonly uploadedBytes: number;
    readonly uploadCalls: number;
    readonly uploadMs: number;
}

export interface CoverageFrameRecord {
    readonly frameId: number;
    readonly token: FrameToken;
    readonly cameraEpoch: number;
    readonly sceneRevision: string;
    readonly backend: 'canvas2d' | 'webgl2';
    readonly width: number;
    readonly height: number;
    readonly outside: number;
    readonly hole: number;
    readonly standin: number;
    readonly current: number;
    readonly invalid: number;
    readonly countMs?: number;
    readonly standInRatio?: number;
}

export type CoverageFrameTag = Pick<CoverageFrameRecord, 'frameId' | 'token' | 'cameraEpoch' | 'sceneRevision' | 'backend' | 'width' | 'height'>;
export type CoverageDropRecord = CoverageFrameTag & { readonly reason?: string };

export interface RenderPerfSnapshot {
    readonly frames: readonly RenderPerfFrame[];
    readonly coverageFrames: readonly CoverageFrameRecord[];
    readonly coverageDrops: readonly CoverageDropRecord[];
    readonly coverageDropCount: number;
    readonly coverageDropOverflow: number;
    readonly overflow: number;
}

const capacity = 4096;
let frames: RenderPerfFrame[] | undefined;
let overflow = 0;
let oldest = 0;
let coverageFrames: CoverageFrameRecord[] | undefined;
let coverageOldest = 0;
let coverageDrops: CoverageDropRecord[] | undefined;
let dropOldest = 0;
let coverageDropCount = 0;
let coverageDropOverflow = 0;

export function recordRenderFrame(frame: RenderPerfFrame): void {
    if (!__BME_BENCH__) return;
    frames ??= [];
    const copy = Object.freeze({ ...frame, token: Object.freeze({ ...frame.token }), camera: Object.freeze({ ...frame.camera }),
        memory: Object.freeze({ ...frame.memory }), grants: Object.freeze({ ...frame.grants }) });
    if (frames.length < capacity) frames.push(copy);
    else { frames[oldest] = copy; oldest = (oldest + 1) % capacity; overflow++; }
    exposeRenderPerf();
}

export function recordCoverageDrop(tag: CoverageFrameTag, reason?: string): void {
    if (!__BME_BENCH__) return;
    coverageDrops ??= [];
    const copy = Object.freeze({ frameId: tag.frameId, token: Object.freeze({ ...tag.token }), cameraEpoch: tag.cameraEpoch,
        sceneRevision: tag.sceneRevision, backend: tag.backend, width: tag.width, height: tag.height, reason });
    coverageDropCount++;
    if (coverageDrops.length < capacity) coverageDrops.push(copy);
    else { coverageDrops[dropOldest] = copy; dropOldest = (dropOldest + 1) % capacity; coverageDropOverflow++; }
    exposeRenderPerf();
}

export function recordCoverageFrame(frame: CoverageFrameRecord): void {
    if (!__BME_BENCH__) return;
    coverageFrames ??= [];
    const copy = Object.freeze({ ...frame, token: Object.freeze({ ...frame.token }) });
    if (coverageFrames.length < capacity) coverageFrames.push(copy);
    else {
        recordCoverageDrop(coverageFrames[coverageOldest], 'overflow');
        coverageFrames[coverageOldest] = copy;
        coverageOldest = (coverageOldest + 1) % capacity;
    }
    exposeRenderPerf();
}

export function readRenderPerf(): RenderPerfSnapshot | null {
    if (!__BME_BENCH__) return null;
    const values = frames ?? [];
    const coverage = coverageFrames ?? [], drops = coverageDrops ?? [];
    return Object.freeze({ frames: Object.freeze([...values.slice(oldest), ...values.slice(0, oldest)]), overflow,
        coverageFrames: Object.freeze([...coverage.slice(coverageOldest), ...coverage.slice(0, coverageOldest)]),
        coverageDrops: Object.freeze([...drops.slice(dropOldest), ...drops.slice(0, dropOldest)]),
        coverageDropCount, coverageDropOverflow });
}

function exposeRenderPerf(): void {
    if (!__BME_BENCH__ || typeof window === 'undefined') return;
    const w = window as unknown as { __perf?: Record<string, unknown> };
    w.__perf ??= { plant: 'bme-perf-hooks-plant-7f3a' };
    w.__perf.render ??= Object.freeze({ snapshot: readRenderPerf });
}
