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
// 'modulate' is the fixed-function dst·src step of a multiply slice (rgb ZERO, SRC_COLOR; alpha ZERO, ONE): no shader,
// no backdrop copy. It is not the destination-aware multiply of beginGroup/composite, which samples a leased backdrop.
export interface PipelineDesc {
    shader: ShaderModule;
    topology: 'triangles' | 'triangle-strip';
    colorFormat: TextureFormat;
    samples: Samples;
    blend: 'replace' | 'source-over' | 'mask-max' | 'add' | 'modulate';
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
// draw() validates the command and copies every field it records before it returns, so a caller may keep one DrawCommand
// for a whole batch and rewrite its fields between draws: bindings.uniforms[i].slice (via uniformsInto), bindings.textures[i]
// .texture, and scissor. Nothing else holds a reference to the command or to its slices.
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
    /** Benchmark-only executed source scale relative to demand. */
    standInRatio?: number;
    /** Benchmark classification provenance, never a replacement for fragment counting. */
    coverageClass?: 2 | 3;
}

// rendering-design.md:159–168, 241, §2.4: surface contents are discarded; load is
// valid only for a retained stored offscreen attachment owned by the same live lease.
export interface PassDesc {
    target: TargetHandle | 'surface';
    viewport: RectI;
    load: { kind: 'clear'; color: RgbaP } | { kind: 'load' };
    // A clear covers this rectangle only (a shared atlas holds other regions); default is the whole viewport.
    clearViewport?: RectI;
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

// Pre-admitted stencil coverage storage: a colour texture plus a stencil-backed target on the same
// lease. Created in prepare through the device, never inside a draw; the frame borrows it per scope.
// `grid` 4: one texel per subsample, a (4·width)×(4·height) r8 texture with no MSAA. Draws rasterise at 4× device pixels
// inside beginCoverage, and endCoverage box-averages each 4×4 block in the composite ('paint' output). Default 1: the
// rgba8 colour target (MSAA or not) that composites its premultiplied colour, unchanged.
export interface CoverageTargetOptions { readonly grid?: 1 | 4 }
export interface CoverageTarget {
    readonly target: TargetHandle;
    readonly texture: TextureHandle;
    readonly width: number;
    readonly height: number;
    readonly samples: Samples;
    readonly grid: 1 | 4;
}
export interface CoverageToken { readonly id: number }
// 'modulate' lays the resolved slice on the surface by fixed-function dst·src (see PipelineDesc.blend), not by backdrop copy.
// 'paint' (grid targets only) resolves the coverage c first and then composites once: 'normal' is source-over of rgb with
// alpha·c; 'modulate' is one dst·k step with k = mix(1, rgb, alpha·c), so overlapping subsamples never compound.
export type CoverageOutput =
    | { readonly kind: 'composite'; readonly blend: 'normal' | 'multiply' | 'modulate' }
    | { readonly kind: 'paint'; readonly blend: 'normal' | 'modulate'; readonly rgb: readonly [number, number, number]; readonly alpha: number }
    | { readonly kind: 'mask' };
// Exact charge for a coverage target: RGBA8 colour, multisample colour where requested, and at
// least 8 B/px/sample of stencil (the backend's own rule, matching webgl2 #targetBytes).
export function coverageTargetBytes(width: number, height: number, samples: Samples, grid: 1 | 4 = 1): number {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) throw new RangeError('Invalid coverage size');
    if (grid !== 1 && grid !== 4 || grid !== 1 && samples !== 1) throw new RangeError('Invalid coverage grid');
    if (grid === 4) {
        // One r8 byte and the 8 B stencil per texel, at grid² texels per device pixel.
        const texels = width * grid * height * grid;
        if (!Number.isSafeInteger(texels * 9)) throw new RangeError('Coverage target exceeds safe accounting');
        return texels * 9;
    }
    const pixels = width * height;
    const bytes = pixels * 4 + pixels * ((samples === 4 ? 4 * 4 : 0) + 8 * samples);
    if (!Number.isSafeInteger(bytes)) throw new RangeError('Coverage target exceeds safe accounting');
    return bytes;
}

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
    // 'modulate' composites the group's premultiplied colour over white by fixed-function dst·k, k = rgb + (1 − a): the
    // multiply slice of a group drawn normally, with no backdrop copy. It takes colourEffect 'none' only.
    beginGroup(bounds: RectI, options: {
        opacity: number;
        blend: 'normal' | 'multiply' | 'modulate';
        colourEffect: 'none' | 'page-invert';
    }): GroupToken;
    endGroup(token: GroupToken): void;
    // Premultiplied encoded-sRGB; multiply samples a separately leased backdrop,
    // never the active attachment. Opacity scales source RGB and alpha together.
    composite(source: TextureHandle, bounds: RectI, options: {
        blend: 'normal' | 'multiply';
        opacity: number;
    }): void;
    // Stencil-winding coverage (rendering-design §2.4, §5.1). The target was admitted and created
    // during prepare; this scope only BORROWS it. `bounds` may be smaller than the target (a shared scratch drawn
    // one band at a time); only that rectangle, from the target's origin, is drawn, resolved and composited. Draws between beginCoverage and endCoverage use
    // stencil pipelines against the target; endCoverage resolves multisampled colour and composites
    // the coverage into the current colour target with the clip active at begin. Nested or
    // overlapping borrows of one target are rejected; LIFO with clips and groups is enforced.
    beginCoverage(target: CoverageTarget, bounds: RectI): CoverageToken;
    // 'composite' blends the resolved coverage into the current colour target with the clip active
    // at begin; 'mask' leaves it untouched as an R-channel clip mask for createClip (rendering §5.1).
    endCoverage(token: CoverageToken, output: CoverageOutput): void;
    end(): void;
}

// rendering-design.md:193–201, §2.4: encoding pins every resource through submit;
// pending frames never overwrite in-flight uniform slices or pooled attachments.
export interface FrameEncoder {
    uniforms(bytes: ArrayBufferView): UniformSlice;
    /** Copies bytes into this frame's ring and rewrites `into`, a caller-owned record, to name them: no allocation. Draw copies every
     * slice it records, so a caller may rewrite the same record between draws of one DrawCommand. */
    uniformsInto(bytes: ArrayBufferView, into: UniformSlice): void;
    // Outside any pass: a target borrowed for this frame from the slots admitted at prepare (see the pass-level acquireTarget).
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

// rendering-design.md:202, 298: completion serials guard safe pooled-storage reuse.
// `stateSwitches`: program, blend and framebuffer changes the replayed commands made (the audit's gl:state).
export interface Submission { readonly serial: number; readonly stateSwitches: number }

// rendering-design.md:203–206, §2.5: already canonical; the caller closes the bitmap
// explicitly after writeTexture returns. Upload does not repeat colour conversion.
/** A decoded image a quad or an upload may read: an ImageBitmap, or a VideoFrame read directly (no CPU bitmap copy). The caller
 * owns a VideoFrame and closes it once the call that read it has returned. */
export type DrawableImage = ImageBitmap | VideoFrame;

export interface BitmapUpload {
    source: DrawableImage;
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
    // `mips` allocates the full chain down to 1×1, charged to the lease in full (about a third more than level 0).
    createTexture(
        width: number,
        height: number,
        format: TextureFormat,
        uses: readonly TextureUse[],
        lease: ByteLease,
        options?: { mips?: boolean },
    ): TextureHandle;
    writeTexture(dst: TextureHandle, rect: RectI, src: BitmapUpload | PixelUpload): void;
    // Fills levels 1… from level 0 on the GPU. Only for a texture created with `mips`; call after each write to level 0.
    generateMips(texture: TextureHandle): void;
    // Clamp at the edge. 'linear-mipmap' trilinear-filters across the chain; it reads level 0 alone when there is none.
    createSampler(filter: 'nearest' | 'linear' | 'linear-mipmap'): SamplerHandle;
    createClip(mask: TextureHandle, deviceBounds: RectI): ClipHandle;
    // Admitted in prepare on the same lease (texture then stencil target). Destroy both to retire it.
    createCoverageTarget(width: number, height: number, samples: Samples, lease: ByteLease, options?: CoverageTargetOptions): CoverageTarget;
    /** A sampleable rgba8 texture with its own single-sample, stencil-less render target, charged through one lease
     * (width × height × 4): a layer's offscreen tile, composed on the GPU and then sampled by the layer. */
    createRenderTexture(width: number, height: number, lease: ByteLease, options?: { format?: 'rgba8' | 'r8'; copyDst?: boolean }): { texture: TextureHandle; target: TargetHandle };
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
