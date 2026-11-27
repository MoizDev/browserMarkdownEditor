import type { RenderToken } from '../types';

export type { RenderToken };

export type Backend = 'webgl2' | 'webgpu';

export type BufferUse = 'vertex' | 'index' | 'uniform' | 'copy-src' | 'copy-dst';

export type TextureFormat = 'rgba8' | 'r8' | 'r32f';

export type TextureUse = 'sample' | 'render' | 'copy-src' | 'copy-dst';

export type Samples = 1 | 4;

export type StencilCompare =
    | 'never'
    | 'less'
    | 'equal'
    | 'less-equal'
    | 'greater'
    | 'not-equal'
    | 'greater-equal'
    | 'always';

export type StencilOp =
    | 'keep'
    | 'zero'
    | 'replace'
    | 'invert'
    | 'increment-clamp'
    | 'decrement-clamp'
    | 'increment-wrap'
    | 'decrement-wrap';

export interface StencilFaceOps {
    fail: StencilOp;
    depthFail: StencilOp;
    pass: StencilOp;
}

export type StencilState = { enabled: false } | {
    enabled: true;
    compare: StencilCompare;
    reference: number;
    readMask: number;
    writeMask: number;
    front: StencilFaceOps;
    back: StencilFaceOps;
};

export type RectI = { x: number; y: number; width: number; height: number };

export type RgbaP = readonly [number, number, number, number];

export type GfxError =
    | 'lost'
    | 'out-of-budget'
    | 'allocation'
    | 'unsupported'
    | 'invalid-resource'
    | 'invalid-input'
    | 'aborted';

export interface Handle { readonly id: number }

export interface BufferHandle extends Handle { readonly kind: 'buffer' }

export interface TextureHandle extends Handle { readonly kind: 'texture' }

export interface SamplerHandle extends Handle { readonly kind: 'sampler' }

export interface PipelineHandle extends Handle { readonly kind: 'pipeline' }

export interface TargetHandle extends Handle { readonly kind: 'target' }

export interface UniformSlice { buffer: BufferHandle; offset: number; bytes: number }

export interface BufferSlice { buffer: BufferHandle; offset: number; bytes: number }

export interface ShaderModule {
    id: string;
    revision: number;
    glsl: { vertex: string; fragment: string };
    wgsl?: { source: string; vertexEntry: string; fragmentEntry: string };
    layout: ShaderLayout;
}

export interface ShaderLayout {
    uniforms: readonly { binding: number; byteSize: number }[];
    textures: readonly { binding: number; format: TextureFormat }[];
    attributes: readonly {
        location: number;
        bufferSlot: number;
        offset: number;
        stride: number;
        format: 'float32x2' | 'float32x3' | 'float32x4' | 'unorm8x4' | 'uint32';
        step: 'vertex' | 'instance';
    }[];
}

export interface PipelineDesc {
    shader: ShaderModule;
    topology: 'triangles' | 'triangle-strip';
    colorFormat: TextureFormat;
    samples: Samples;
    blend: 'replace' | 'source-over' | 'mask-max' | 'add' | 'modulate' | 'min' | 'max';
    alphaToCoverage: boolean;
    colorWrite: readonly [boolean, boolean, boolean, boolean];
    stencil: StencilState;
}

export interface Bindings {
    uniforms: readonly { binding: number; slice: UniformSlice }[];
    textures: readonly {
        binding: number;
        texture: TextureHandle;
        sampler: SamplerHandle;
    }[];
}

export interface DrawCommand {
    pipeline: PipelineHandle;
    bindings: Bindings;
    vertices: readonly BufferSlice[];
    // v1 has no primitive-restart semantics: 0xFFFF (uint16) and 0xFFFFFFFF
    // (uint32) are invalid indices. Use uint32 before addressing vertex 65535.
    index?: { slice: BufferSlice; format: 'uint16' | 'uint32' };
    first: number;
    count: number;
    instances: number;
    scissor: RectI;
    standInRatio?: number;
    coverageClass?: 2 | 3;
}

export interface PassDesc {
    target: TargetHandle | 'surface';
    viewport: RectI;
    load: { kind: 'clear'; color: RgbaP } | { kind: 'load'; orClear?: RgbaP };
    clearViewport?: RectI;
    store: 'store' | 'discard';
    stencil?: {
        load: { kind: 'clear'; value: number } | { kind: 'load' };
        store: 'store' | 'discard';
    };
}

export interface ClipHandle extends Handle { readonly kind: 'clip' }

export interface ClipToken { readonly depth: number }

export interface GroupToken { readonly id: number }

export interface CoverageTargetOptions { readonly grid?: 1 | 4 }
export const COVERAGE_ATLAS_TILE = 8;
export interface CoverageTarget {
    readonly target: TargetHandle;
    readonly texture: TextureHandle;
    readonly width: number;
    readonly height: number;
    readonly samples: Samples;
    readonly grid: 1 | 4 | 16;
}
export interface CoverageToken { readonly id: number }
export interface AreaTarget {
    readonly target: TargetHandle;
    readonly texture: TextureHandle;
    readonly width: number;
    readonly height: number;
}
export type AreaOutput = { readonly kind: 'area'; readonly blend: 'normal' | 'modulate'; readonly rgb: readonly [number, number, number]; readonly alpha: number };
export type CoverageOutput =
    | { readonly kind: 'composite'; readonly blend: 'normal' | 'multiply' | 'modulate' }
    | { readonly kind: 'paint'; readonly blend: 'normal' | 'modulate'; readonly rgb: readonly [number, number, number]; readonly alpha: number }
    | { readonly kind: 'coverage'; readonly target: TargetHandle; readonly at: RectI }
    | { readonly kind: 'mask' };
export function coverageTargetBytes(width: number, height: number, samples: Samples, grid: 1 | 4 | 16 = 1): number {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) throw new RangeError('Invalid coverage size');
    if (grid !== 1 && grid !== 4 && grid !== 16 || grid !== 1 && samples !== 1) throw new RangeError('Invalid coverage grid');
    if (grid === 4 || grid === 16) {
        const texels = width * grid * height * grid;
        if (!Number.isSafeInteger(texels * 9)) throw new RangeError('Coverage target exceeds safe accounting');
        return texels * 9;
    }
    const pixels = width * height;
    const bytes = pixels * 4 + pixels * ((samples === 4 ? 4 * 4 : 0) + 8 * samples);
    if (!Number.isSafeInteger(bytes)) throw new RangeError('Coverage target exceeds safe accounting');
    return bytes;
}

export interface TargetLease {
    target: TargetHandle;
    texture: TextureHandle;
    width: number;
    height: number;
    format: TextureFormat;
    samples: Samples;
    stencil: boolean;
}

export interface GpuPass {
    draw(cmd: DrawCommand): void;
    acquireTarget(desc: {
        width: number;
        height: number;
        samples: Samples;
        format?: TextureFormat;
        stencil: boolean;
        purpose: 'mask' | 'group' | 'scene-cache' | 'capture';
    }): TargetLease | null;
    // Retire safely; never reuse pooled storage before submission completion.
    releaseTarget(target: TargetLease): void;
    pushClip(clip: RectI | ClipHandle): ClipToken;
    popClip(token: ClipToken): void;
    clipRect(): Readonly<RectI>;
    beginGroup(bounds: RectI, options: {
        opacity: number;
        blend: 'normal' | 'multiply' | 'modulate';
        colourEffect: 'none' | 'page-invert';
    }): GroupToken;
    endGroup(token: GroupToken): void;
    composite(source: TextureHandle, bounds: RectI, options: {
        blend: 'normal' | 'multiply';
        opacity: number;
    }): void;
    beginCoverage(target: CoverageTarget, bounds: RectI): CoverageToken;
    endCoverage(token: CoverageToken, output: CoverageOutput): void;
    beginArea(target: AreaTarget): CoverageToken;
    endArea(token: CoverageToken): void;
    compositeArea(target: AreaTarget, at: Readonly<{ x: number; y: number }>, bounds: RectI, output: AreaOutput): void;
    end(): void;
}

export interface FrameEncoder {
    uniforms(bytes: ArrayBufferView): UniformSlice;
    uniformsInto(bytes: ArrayBufferView, into: UniformSlice): void;
    acquireTarget(desc: {
        width: number;
        height: number;
        samples: Samples;
        format?: TextureFormat;
        stencil: boolean;
        purpose: 'mask' | 'group' | 'scene-cache' | 'capture';
    }): TargetLease | null;
    beginPass(desc: PassDesc): GpuPass;
    resolve(source: TargetHandle, dest: TextureHandle): void;
    copyTexture(
        src: TextureHandle,
        srcRect: RectI,
        dest: TextureHandle,
        destX: number,
        destY: number,
    ): void;
    submit(): Submission;
}

export interface Submission { readonly serial: number; readonly stateSwitches: number }

export type DrawableImage = ImageBitmap | VideoFrame;

export interface BitmapUpload {
    source: DrawableImage;
    premultiplied: true;
    colorSpace: 'srgb';
    origin: 'top-left';
}

export interface PixelUpload {
    source: Uint8Array;
    rowBytes: number;
    premultiplied: true;
    colorSpace: 'srgb';
    origin: 'top-left';
}

export interface GfxDevice {
    readonly backend: Backend;
    readonly generation: number;
    readonly limits: GfxLimits;
    readonly areaTargets: boolean;
    createBuffer(bytes: number, uses: readonly BufferUse[], lease: ByteLease): BufferHandle;
    writeBuffer(dst: BufferHandle, offset: number, src: ArrayBufferView): void;
    createTexture(
        width: number,
        height: number,
        format: TextureFormat,
        uses: readonly TextureUse[],
        lease: ByteLease,
        options?: { mips?: boolean },
    ): TextureHandle;
    writeTexture(dst: TextureHandle, rect: RectI, src: BitmapUpload | PixelUpload): void;
    generateMips(texture: TextureHandle): void;
    createSampler(filter: 'nearest' | 'linear' | 'linear-mipmap'): SamplerHandle;
    createClip(mask: TextureHandle, deviceBounds: RectI): ClipHandle;
    createCoverageTarget(width: number, height: number, samples: Samples, lease: ByteLease, options?: CoverageTargetOptions): CoverageTarget;
    createCoverageAtlas(slotsAcross: number, slotsDown: number, lease: ByteLease): CoverageTarget;
    createRenderTexture(width: number, height: number, lease: ByteLease, options?: { format?: TextureFormat; copyDst?: boolean }): { texture: TextureHandle; target: TargetHandle };
    createPipeline(desc: PipelineDesc): Promise<PipelineHandle>;
    createTarget(
        color: TextureHandle,
        options: { samples: Samples; stencil: boolean },
        lease: ByteLease,
    ): TargetHandle;
    beginFrame(): FrameEncoder;
    readTexture(src: TextureHandle, rect: RectI, signal: AbortSignal): Promise<ImageBitmap>;
    completed(serial: number): boolean;
    destroy(resource: Handle): void;
    abandon(): void;
}

export interface GfxLimits {
    maxTexture2D: number;
    maxRenderTargetSize: number;
    maxViewport: readonly [number, number];
    maxSamples: number;
    uniformAlignment: number;
    maxUniformBytes: number;
    maxTextureBindings: number;
}

export interface ByteLease { readonly id: number; readonly bytes: number }
