import type { Camera } from '../types';
import type { FrameToken } from './types';

/** Passive benchmark observations only. Pixel coverage must come from executed-paint witnesses. */
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

export interface RenderPerfSnapshot {
    readonly frames: readonly RenderPerfFrame[];
    /** Number of older frames discarded; a consumer must not mistake overflow for complete data. */
    readonly overflow: number;
}

const capacity = 4096;
let frames: RenderPerfFrame[] | undefined;
let overflow = 0;
let oldest = 0;

/** Record only after the caller has observed a frame; no drawing, readback or verdict is done here. */
export function recordRenderFrame(frame: RenderPerfFrame): void {
    if (!__BME_BENCH__) return;
    frames ??= [];
    const copy = Object.freeze({ ...frame, token: Object.freeze({ ...frame.token }), camera: Object.freeze({ ...frame.camera }),
        memory: Object.freeze({ ...frame.memory }), grants: Object.freeze({ ...frame.grants }) });
    if (frames.length < capacity) frames.push(copy);
    else { frames[oldest] = copy; oldest = (oldest + 1) % capacity; overflow++; }
    exposeRenderPerf();
}

export function readRenderPerf(): RenderPerfSnapshot | null {
    if (!__BME_BENCH__) return null;
    const values = frames ?? [];
    return Object.freeze({ frames: Object.freeze([...values.slice(oldest), ...values.slice(0, oldest)]), overflow });
}

function exposeRenderPerf(): void {
    if (!__BME_BENCH__ || typeof window === 'undefined') return;
    const w = window as unknown as { __perf?: Record<string, unknown> };
    w.__perf ??= { plant: 'bme-perf-hooks-plant-7f3a' };
    w.__perf.render ??= Object.freeze({ snapshot: readRenderPerf });
}
