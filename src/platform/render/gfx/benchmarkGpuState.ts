import type { BenchmarkPaintDomain } from '../benchmarkPaintDomain';
import type { MemoryAllocator } from '../memoryGovernor';
import type { PipelineHandle, TargetHandle, TextureHandle } from './api';
import type { CoverageFrameTag, Webgl2Coverage } from './webgl2Coverage';

export interface CoverageRoot {
    width: number;
    height: number;
    texture: TextureHandle;
    target: TargetHandle;
}

export interface CoveragePlan {
    tag: CoverageFrameTag;
    domain: BenchmarkPaintDomain;
    root: CoverageRoot | null;
    missing: boolean;
    width: number;
    height: number;
}

export interface BenchmarkGpuState {
    textures: WeakMap<WebGLTexture, TextureHandle>;
    tickets: Map<number, { commit(): void; cancel(): void }>;
    counter: Webgl2Coverage | null;
    programs: { classify: WebGLProgram; reduce: WebGLProgram } | null;
    programHandles: readonly PipelineHandle[];
    compiling: boolean;
    root: CoverageRoot | null;
    plan: CoveragePlan | null;
    working: MemoryAllocator;
    program: MemoryAllocator;
}

export const states = new WeakMap<object, BenchmarkGpuState>();

export function createState(working: MemoryAllocator, program: MemoryAllocator): BenchmarkGpuState {
    return { textures: new WeakMap(), tickets: new Map(), counter: null, programs: null, programHandles: [],
        compiling: false, root: null, plan: null, working, program };
}
