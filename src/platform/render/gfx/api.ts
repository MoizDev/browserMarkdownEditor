import type { RenderToken } from '../types';

// Canonical session identity lives with the render types (rendering-design.md:94–95).
export type { RenderToken };

// These declarations implement planning/40-platform/rendering-design.md §2.1.
// Counts, dimensions and byte offsets must be nonnegative safe integers; transforms
// and colours must be finite. Validation belongs to the device, before submission.

// rendering-design.md:93, §11: layers use the same boundary for either GPU backend.
export type Backend = 'webgl2' | 'webgpu';

// rendering-design.md:96: explicit uses also map to WebGPU resource usage flags.
export type BufferUse = 'vertex' | 'index' | 'uniform' | 'copy-src' | 'copy-dst';

// rendering-design.md:97, 239–241: r8 is one-byte coverage, never colour storage.
export type TextureFormat = 'rgba8' | 'r8';

// rendering-design.md:98: writable attachments cannot simultaneously be sampled.
export type TextureUse = 'sample' | 'render' | 'copy-src' | 'copy-dst';

// rendering-design.md:99, 239: unsupported format/sample pairs reject, not degrade silently.
export type Samples = 1 | 4;

// rendering-design.md:100–101: shared stencil comparisons, not backend constants.
export type StencilCompare =
    | 'never'
    | 'less'
    | 'equal'
    | 'less-equal'
    | 'greater'
    | 'not-equal'
    | 'greater-equal'
    | 'always';

// rendering-design.md:102–103: scene winding/parity and stroke-union operations.
export type StencilOp =
    | 'keep'
    | 'zero'
    | 'replace'
    | 'invert'
    | 'increment-clamp'
    | 'decrement-clamp'
    | 'increment-wrap'
    | 'decrement-wrap';

// rendering-design.md:104–106: both faces bind every operation explicitly.
export interface StencilFaceOps {
    fail: StencilOp;
    depthFail: StencilOp;
    pass: StencilOp;
}

// rendering-design.md:107–111, §2.4: enabled stencil requires a stencil-backed target.
export type StencilState = { enabled: false } | {
    enabled: true;
    compare: StencilCompare;
    // Reference and masks are checked 8-bit unsigned values.
    reference: number;
    readMask: number;
    writeMask: number;
    front: StencilFaceOps;
    back: StencilFaceOps;
};

// rendering-design.md:90, 112: top-left physical pixels, half-open bounds.
export type RectI = { x: number; y: number; width: number; height: number };

// rendering-design.md:90, 113, §2.5: premultiplied encoded-sRGB in [0,1], RGB ≤ alpha.
// Unlike platform Rgba (straight channels), transparent zero is always [0,0,0,0].
export type RgbaP = readonly [number, number, number, number];

// rendering-design.md:114–115: typed failure reasons select fallback without raw GPU errors.
export type GfxError =
    | 'lost'
    | 'out-of-budget'
    | 'allocation'
    | 'unsupported'
    | 'invalid-resource'
    | 'invalid-input'
    | 'aborted';

// rendering-design.md:88, 116: opaque public identity; deviceId/generation/slot stay
// in the arena's internal record. Stale or foreign handles reject before submission.
export interface Handle { readonly id: number }

// rendering-design.md:117: kind brands prevent accidentally substituting another resource.
export interface BufferHandle extends Handle { readonly kind: 'buffer' }

// rendering-design.md:118: a texture's lifetime is independent of attached targets.
export interface TextureHandle extends Handle { readonly kind: 'texture' }

// rendering-design.md:119: samplers expose no backend object or mutable sampler state.
export interface SamplerHandle extends Handle { readonly kind: 'sampler' }

// rendering-design.md:120: programs/layouts remain behind opaque pipeline identity.
export interface PipelineHandle extends Handle { readonly kind: 'pipeline' }

// rendering-design.md:121: attachment sets are immutable for the target's lifetime.
export interface TargetHandle extends Handle { readonly kind: 'target' }

// rendering-design.md:122, §2.3: padded slices come from the bounded frame uniform ring.
export interface UniformSlice { buffer: BufferHandle; offset: number; bytes: number }

// rendering-design.md:123, 243: offset slices replace nonportable base-vertex/first-instance APIs.
export interface BufferSlice { buffer: BufferHandle; offset: number; bytes: number }

// rendering-design.md:124–129, §2.3: streams own shaders; no runtime shader translation.
export interface ShaderModule {
    id: string;
    revision: number;
    glsl: { vertex: string; fragment: string };
    wgsl?: { source: string; vertexEntry: string; fragmentEntry: string };
    layout: ShaderLayout;
}

// rendering-design.md:130–136: explicit padded packing/bindings keep backend layouts compatible.
// WebGL2 linking convention (vr-lead ruling): block binding N names GfxUniformsN;
// sampler binding N names gfxTextureN. A declared binding missing from GLSL rejects
// the pipeline. These names bind the manifest, without adding backend objects to it.
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

// rendering-design.md:137–146, 239: mask-max is only for coverage-mask construction;
// multiply is destination-aware composition, not a fixed-function colour blend.
export interface PipelineDesc {
    shader: ShaderModule;
    topology: 'triangles' | 'triangle-strip';
    colorFormat: TextureFormat;
    samples: Samples;
    blend: 'replace' | 'source-over' | 'mask-max';
    alphaToCoverage: boolean;
    colorWrite: readonly [boolean, boolean, boolean, boolean];
    stencil: StencilState;
}

// rendering-design.md:147–151: no implicit bindings survive a previous layer's draw.
export interface Bindings {
    uniforms: readonly { binding: number; slice: UniformSlice }[];
    textures: readonly {
        binding: number;
        texture: TextureHandle;
        sampler: SamplerHandle;
    }[];
}

// rendering-design.md:152–158, 241–243: scissor is required, clipped to target/clip
// bounds; an empty intersection draws nothing. Accessed buffer bytes are validated.
export interface DrawCommand {
    pipeline: PipelineHandle;
    bindings: Bindings;
    vertices: readonly BufferSlice[];
    index?: { slice: BufferSlice; format: 'uint16' | 'uint32' };
    first: number;
    count: number;
    instances: number;
    scissor: RectI;
}

// rendering-design.md:159–168, 241, §2.4: surface contents are discarded; load is
// valid only for a retained stored offscreen attachment owned by the same live lease.
export interface PassDesc {
    target: TargetHandle | 'surface';
    viewport: RectI;
    load: { kind: 'clear'; color: RgbaP } | { kind: 'load' };
    store: 'store' | 'discard';
    // Required on stencil-backed targets, forbidden on the displayed surface.
    stencil?: {
        load: { kind: 'clear'; value: number } | { kind: 'load' };
        store: 'store' | 'discard';
    };
}

// rendering-design.md:169: mask clips carry the same arena validation as other handles.
export interface ClipHandle extends Handle { readonly kind: 'clip' }

// rendering-design.md:170, §2.4: strict LIFO, maximum depth 64; mismatch rejects the frame.
export interface ClipToken { readonly depth: number }

// rendering-design.md:171, §2.4: identifies an explicit isolated effect, not ordinary group opacity.
export interface GroupToken { readonly id: number }

// rendering-design.md:172–176, 241, 284: leases report actual bucketed storage;
// multisample colour and stencil storage are charged in addition to resolve textures.
export interface TargetLease {
    target: TargetHandle;
    texture: TextureHandle;
    width: number;
    height: number;
    format: TextureFormat;
    samples: Samples;
    stencil: boolean;
}

// rendering-design.md:177–192, §2.4; contracts.md C4.3: a logical pass may expand
// into several backend passes to isolate groups, masks and destination snapshots.
export interface GpuPass {
    draw(cmd: DrawCommand): void;
    // Null on non-critical budget refusal; the caller uses its defined banded/2D route.
    // Critical capture admission belongs to capture orchestration, not this descriptor.
    acquireTarget(desc: {
        width: number;
        height: number;
        samples: Samples;
        // Defaults to rgba8; r8 mask storage is charged at one byte per pixel.
        format?: TextureFormat;
        stencil: boolean;
        purpose: 'mask' | 'group' | 'scene-cache' | 'capture';
    }): TargetLease | null;
    // Retire safely; never reuse pooled storage before submission completion.
    releaseTarget(target: TargetLease): void;
    pushClip(clip: RectI | ClipHandle): ClipToken;
    popClip(token: ClipToken): void;
    // Ordinary node/ancestor opacity multiplies emitted paints, without isolation.
    beginGroup(bounds: RectI, options: {
        opacity: number;
        blend: 'normal' | 'multiply';
        colourEffect: 'none' | 'page-invert';
    }): GroupToken;
    endGroup(token: GroupToken): void;
    // Premultiplied encoded-sRGB; multiply samples a separately leased backdrop,
    // never the active attachment. Opacity scales source RGB and alpha together.
    composite(source: TextureHandle, bounds: RectI, options: {
        blend: 'normal' | 'multiply';
        opacity: number;
    }): void;
    end(): void;
}

// rendering-design.md:193–201, §2.4: encoding pins every resource through submit;
// pending frames never overwrite in-flight uniform slices or pooled attachments.
export interface FrameEncoder {
    uniforms(bytes: ArrayBufferView): UniformSlice;
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

// rendering-design.md:202, 298: completion serials guard safe pooled-storage reuse.
export interface Submission { readonly serial: number }

// rendering-design.md:203–206, §2.5: already canonical; the caller closes the bitmap
// explicitly after writeTexture returns. Upload does not repeat colour conversion.
export interface BitmapUpload {
    source: ImageBitmap;
    premultiplied: true;
    colorSpace: 'srgb';
    origin: 'top-left';
}

// rendering-design.md:207–210, §2.2: row pitch is validated, padding handled by the backend.
export interface PixelUpload {
    source: Uint8Array;
    rowBytes: number;
    premultiplied: true;
    colorSpace: 'srgb';
    origin: 'top-left';
}

// rendering-design.md:211–230, §2.4: all objects belong to this device generation;
// destroy is idempotent safe retirement, while loss abandons the whole generation.
export interface GfxDevice {
    readonly backend: Backend;
    readonly generation: number;
    readonly limits: GfxLimits;
    createBuffer(bytes: number, uses: readonly BufferUse[], lease: ByteLease): BufferHandle;
    writeBuffer(dst: BufferHandle, offset: number, src: ArrayBufferView): void;
    createTexture(
        width: number,
        height: number,
        format: TextureFormat,
        uses: readonly TextureUse[],
        lease: ByteLease,
    ): TextureHandle;
    writeTexture(dst: TextureHandle, rect: RectI, src: BitmapUpload | PixelUpload): void;
    // Clamp at the edge; no mip levels.
    createSampler(filter: 'nearest' | 'linear'): SamplerHandle;
    createClip(mask: TextureHandle, deviceBounds: RectI): ClipHandle;
    createPipeline(desc: PipelineDesc): Promise<PipelineHandle>;
    createTarget(
        color: TextureHandle,
        options: { samples: Samples; stencil: boolean },
        lease: ByteLease,
    ): TargetHandle;
    beginFrame(): FrameEncoder;
    readTexture(src: TextureHandle, rect: RectI, signal: AbortSignal): Promise<ImageBitmap>;
    // Nonblocking completion poll, never a GPU wait.
    completed(serial: number): boolean;
    destroy(resource: Handle): void;
    // Context/device loss invalidates handles without assuming valid backend calls.
    abandon(): void;
}

// rendering-design.md:231–235: creation-time limits; never queried per draw.
export interface GfxLimits {
    maxTexture2D: number;
    // Planned as maxRenderbuffer (§2.1); renamed by vr-lead for the §11 seam.
    // Maximum render-attachment width/height in device pixels: WebGL2 uses the
    // minimum of texture/renderbuffer limits; WebGPU uses maxTextureDimension2D.
    maxRenderTargetSize: number;
    maxViewport: readonly [number, number];
    maxSamples: number;
    uniformAlignment: number;
    maxUniformBytes: number;
    maxTextureBindings: number;
}

// rendering-design.md:236, §2.4: pool/retired storage remains charged to its byte grant.
export interface ByteLease { readonly id: number; readonly bytes: number }
