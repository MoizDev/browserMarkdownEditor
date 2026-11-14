import type {
    BitmapUpload, BufferHandle, BufferUse, ByteLease, ClipHandle, GfxDevice, GfxError,
    FrameEncoder, GfxLimits, Handle, PipelineDesc, PipelineHandle, PixelUpload, RectI, SamplerHandle,
    Samples, ShaderLayout, ShaderModule, TargetHandle, TargetLease, TextureFormat, TextureHandle, TextureUse, UniformSlice,
} from './api';
import { RENDER_CONSTANTS } from '../constants';
import { createWebgl2Frame } from './webgl2Frame';
import type { ControlledFrame, DrawContext, EncodedDraw, FrameBackend, FrameTarget, FrameTexture, QuadCommand, TargetRequest } from './webgl2Frame';
import { Webgl2TargetPool } from './webgl2Pool';
import type { PoolStorage } from './webgl2Pool';
import { COMPOSITION_SHADER } from './webgl2Shaders';
import { Webgl2IndexMirror } from './webgl2Index';
import { ArenaError, ResourceArena } from '../resourceArena';
import type { ArenaEncoding, ArenaLeaseMemory, ArenaMemory, ArenaResourceKind, ResourceArenaBackend } from '../resourceArena';
import type { MemoryAllocator } from '../memoryGovernor';
import type {
    BrokerGpuOwner, ContextDisposeReason, GpuPreparation, SurfaceResizeResult,
} from '../surfaceBroker.types';
import type { GpuReleaseReason } from '../types';

// One native storage convention (rendering-design.md §2.2/2.5; vr-lead ruling):
// textures and render targets are GL-native bottom-left. Canonical top-left bitmaps
// upload into budgeted, fenced staging targets, then Y-reversed framebuffer blits.
// Byte uploads reverse rows; readback reverses once. No ImageBitmap pixel-store flip
// is assumed: WebGL explicitly ignores that flag for ImageBitmap sources.

/** Cache-bound allocators reserve actual bytes before any native/CPU allocation (design:603).
 * returnLease is the governor's FINAL return, not the layer-facing close adapter.
 * schedulePoll registers shared-frame maintenance and returns cancellation; each wait
 * cancels its registration after one callback. No backend rAF exists.
 */
export interface Webgl2Services {
    working: MemoryAllocator;
    program: MemoryAllocator;
    gpuStaging: MemoryAllocator;
    cpuStaging: MemoryAllocator;
    returnLease(lease: ByteLease): void;
    schedulePoll(callback: () => void): () => void;
    /** Unrecoverable device fault: stop view GPU work and permanently abandon the broker
     * reservation, preserving the document session and presenting its 2D path. */
    onFailure(code: GfxError): void;
    /** Runtime adaptive-budget feedback, never a benchmark-only hook or guessed prepare time. */
    recordUpload?(bytes: number, elapsedMs: number): void;
    /** Called only when a failed encode schedules the next bounded ring capacity. */
    recordUniformGrowth?(previousBytes: number, nextBytes: number): void;
}

/** Platform-internal owner only; layers never receive an arena or raw GL (design:88). */
export interface Webgl2Owner extends BrokerGpuOwner {
    readonly resources: GfxDevice;
    /** Availability only; per-frame completeness comes from the scheduler's observed calls,
     * never a claim that an unobserved frame had zero upload cost. */
    readonly uploadMeterAvailable: boolean;
    readonly uniformRingBytes: number;
    discardFrame(encoder: FrameEncoder): void;
    acquireTarget(request: TargetRequest): TargetLease | null;
    releaseTarget(lease: TargetLease): void;
    closeLease(lease: ByteLease): void;
    memory(): ArenaMemory;
    leaseMemory(lease: ByteLease): ArenaLeaseMemory;
    cpuStagingMemory(): ArenaMemory;
}

type BufferDesc = { bytes: number; uses: readonly BufferUse[]; pack?: boolean };
type TextureDesc = { width: number; height: number; format: TextureFormat; uses: readonly TextureUse[] } | { reference: TextureHandle };
type TargetDesc = { color: TextureHandle; samples: Samples; stencil: boolean } |
    { reference: TargetHandle; color: TextureHandle; purpose: TargetRequest['purpose'] };
type SamplerDesc = { filter: 'nearest' | 'linear' } | { reference: SamplerHandle };
type PipelineCreate = { role: 'program'; shader: ShaderModule } |
    { role: 'pipeline'; program: PipelineHandle; descriptor: PipelineDesc };
interface Descriptors {
    buffer: BufferDesc;
    texture: TextureDesc;
    target: TargetDesc;
    sampler: SamplerDesc;
    clip: { mask: TextureHandle; bounds: RectI };
    pipeline: PipelineCreate;
}
interface NativeBuffer {
    buffer: WebGLBuffer;
    bytes: number;
    uses: ReadonlySet<BufferUse>;
    pack: boolean;
    indices: Webgl2IndexMirror | null;
    indexLease: ByteLease | null;
}
interface NativeTexture {
    texture: WebGLTexture;
    width: number;
    height: number;
    format: TextureFormat;
    uses: readonly TextureUse[];
    reference?: TextureHandle;
    usedRect?: RectI;
}
interface NativeTarget {
    color: TextureHandle;
    colorTexture: NativeTexture;
    samples: Samples;
    stencil: boolean;
    capture: boolean;
    reference?: TargetHandle;
    releaseDependency?: () => void;
    framebuffer: WebGLFramebuffer;
    resolveFramebuffer: WebGLFramebuffer;
    multisample: WebGLRenderbuffer | null;
    depthStencil: WebGLRenderbuffer | null;
    width: number;
    height: number;
    format: TextureFormat;
    colorStored: boolean;
    stencilStored: boolean;
}
interface NativeProgram {
    role: 'program';
    program: WebGLProgram;
    vertex: WebGLShader | null;
    fragment: WebGLShader | null;
    layout: ShaderLayout;
    linked: boolean;
}
interface NativePipeline {
    role: 'pipeline';
    program: PipelineHandle;
    descriptor: PipelineDesc;
    vao: WebGLVertexArrayObject | null;
    vertexBindings: readonly { id: number; offset: number }[] | null;
    buffers: Set<WebGLBuffer>;
}
interface NativeClip {
    mask: TextureHandle;
    texture: NativeTexture;
    bounds: RectI;
    releaseDependency?: () => void;
}
interface Objects {
    buffer: NativeBuffer;
    texture: NativeTexture;
    target: NativeTarget;
    sampler: { sampler: WebGLSampler; reference?: SamplerHandle };
    clip: NativeClip;
    pipeline: NativeProgram | NativePipeline;
}
interface RawRead { bytes: Uint8Array<ArrayBuffer>; lease: ByteLease; }
interface UniformSlot {
    handle: BufferHandle;
    native: NativeBuffer;
    data: Uint8Array<ArrayBuffer>;
    lease: ByteLease;
    serial: number;
    owner: FrameWork | null;
    valid: boolean;
}
interface FrameWork {
    encoding: ArenaEncoding;
    controller: ControlledFrame | null;
    signal: AbortSignal;
    slot: UniformSlot | null;
    offset: number;
    passes: boolean;
    surface: boolean;
    surfaceRevision: number;
    issued: number | null;
    finished: boolean;
}

const CAPABILITY_SHADER: ShaderModule = {
    id: 'platform-colour-capability', revision: 1,
    glsl: {
        vertex: `#version 300 es
void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`,
        fragment: `#version 300 es
precision highp float;
out vec4 colour;
void main() {
    if (gl_FragCoord.y < 1.0) {
        colour = gl_FragCoord.x < 1.0 ? vec4(0.5, 0.0, 0.0, 0.5) : vec4(0.0, 0.25, 0.0, 0.5);
    } else {
        colour = gl_FragCoord.x < 1.0 ? vec4(0.0, 0.0, 0.125, 0.5) : vec4(0.0);
    }
}`,
    },
    layout: { uniforms: [], textures: [], attributes: [] },
};

function count(value: number, positive = false): void {
    if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) throw new ArenaError('invalid-input');
}
function byteSize(...factors: number[]): number {
    const bytes = factors.reduce((a, b) => a * b, 1);
    count(bytes);
    return bytes;
}
function rectangle(rect: RectI, width: number, height: number): void {
    for (const value of [rect.x, rect.y, rect.width, rect.height]) count(value);
    if (rect.x > width - rect.width || rect.y > height - rect.height) throw new ArenaError('invalid-input');
}
function uniqueUses<T extends string>(uses: readonly T[], allowed: readonly T[]): readonly T[] {
    if (!uses.length || uses.some(use => !allowed.includes(use))) throw new ArenaError('invalid-input');
    return [...new Set(uses)];
}

/** The broker alone creates contexts; this adapter binds generation-scoped budget services. */
export function createWebgl2Factory(services: Webgl2Services): (preparation: GpuPreparation) => Promise<Webgl2Owner> {
    return preparation => Webgl2Device.prepare(preparation, services);
}

class Webgl2Device implements GfxDevice, Webgl2Owner {
    readonly backend = 'webgl2' as const;
    readonly generation: number;
    readonly limits: GfxLimits;
    readonly resources: GfxDevice = this;
    readonly uploadMeterAvailable: boolean;
    readonly #services: Webgl2Services;
    readonly #arena: ResourceArena<Descriptors, Objects>;
    readonly #parallel: KHR_parallel_shader_compile | null;
    readonly #sampleCounts = new Map<number, ReadonlySet<number>>();
    readonly #uniformBindings: number;
    readonly #maxAttributes: number;
    readonly #maxElementIndex: number;
    readonly #handles = new Set<Handle>();
    readonly #ownedLeases = new Map<ByteLease, MemoryAllocator>();
    readonly #cpuLeases = new Map<ByteLease, number>();
    #cpuBytes = 0;
    readonly #programs = new Map<string, Promise<PipelineHandle>>();
    readonly #programSignatures = new Map<string, string>();
    readonly #samplers = new Map<'nearest' | 'linear', SamplerHandle>();
    readonly #attachments = new Map<TextureHandle, TargetHandle>();
    readonly #pool: Webgl2TargetPool;
    readonly #frames = new Map<ArenaEncoding, FrameWork>();
    readonly #controlledFrames = new WeakMap<FrameEncoder, ControlledFrame>();
    readonly #uniformSlots: UniformSlot[] = [];
    readonly #pipelines = new Set<NativePipeline>();
    readonly #indexBuffers = new Set<NativeBuffer>();
    readonly #textureUnits = new Set<number>();
    readonly #uniformUnits = new Set<number>();
    readonly #uniformGrowths: { previous: number; next: number }[] = [];
    #uniformBytes = 1 << 20;
    #surfaceRevision = 0;
    #composition: PipelineHandle | null = null;
    #white: TextureHandle | null = null;
    readonly #fences = new Map<number, WebGLSync | null>();
    #brokenFence = false;
    #gl: WebGL2RenderingContext | null;
    #canvas: HTMLCanvasElement | null;
    #work = new AbortController();
    #serial = 0;
    #completedSerial = 0;
    #pollCancel: (() => void) | null = null;
    #lost = false;
    #disposed = false;
    #paused = false;

    static async prepare(preparation: GpuPreparation, services: Webgl2Services): Promise<Webgl2Owner> {
        const owner = new Webgl2Device(preparation, services);
        try {
            await owner.#qualify(preparation.signal);
            await owner.#prepareComposition(preparation.signal);
            return owner;
        } catch (error) {
            owner.dispose(error instanceof ArenaError && error.code === 'lost' ? 'context-lost' : 'creation-failed');
            throw error;
        }
    }

    constructor(preparation: GpuPreparation, services: Webgl2Services) {
        count(preparation.generation);
        if (preparation.signal.aborted) throw new ArenaError('aborted');
        const gl = preparation.context;
        if (gl.isContextLost()) throw new ArenaError('lost');
        this.#gl = gl;
        this.#canvas = preparation.canvas;
        this.generation = preparation.generation;
        this.#services = services;
        this.uploadMeterAvailable = typeof services.recordUpload === 'function';
        // Query once per generation, never to reconstruct state in a frame (design:276–277).
        const parameter = (name: number): number => {
            const value: unknown = gl.getParameter(name);
            if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new ArenaError('unsupported');
            return value;
        };
        const viewport: unknown = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
        if (!(viewport instanceof Int32Array) || viewport.length !== 2 || viewport.some(value => value <= 0)) {
            throw new ArenaError('unsupported');
        }
        this.#uniformBindings = parameter(gl.MAX_UNIFORM_BUFFER_BINDINGS);
        this.#maxAttributes = parameter(gl.MAX_VERTEX_ATTRIBS);
        this.#maxElementIndex = parameter(gl.MAX_ELEMENT_INDEX);
        const maxTexture2D = parameter(gl.MAX_TEXTURE_SIZE);
        this.limits = Object.freeze({
            maxTexture2D,
            maxRenderTargetSize: Math.min(maxTexture2D, parameter(gl.MAX_RENDERBUFFER_SIZE)),
            maxViewport: Object.freeze([viewport[0], viewport[1]]) as readonly [number, number],
            maxSamples: parameter(gl.MAX_SAMPLES),
            uniformAlignment: Math.max(256, parameter(gl.UNIFORM_BUFFER_OFFSET_ALIGNMENT)),
            maxUniformBytes: parameter(gl.MAX_UNIFORM_BLOCK_SIZE),
            maxTextureBindings: Math.min(parameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS), parameter(gl.MAX_TEXTURE_IMAGE_UNITS)),
        });
        for (const format of [gl.RGBA8, gl.R8, gl.DEPTH24_STENCIL8]) {
            const samples: unknown = gl.getInternalformatParameter(gl.RENDERBUFFER, format, gl.SAMPLES);
            this.#sampleCounts.set(format, new Set(samples instanceof Int32Array ? samples : []));
        }
        this.#parallel = gl.getExtension('KHR_parallel_shader_compile');
        gl.drawingBufferColorSpace = RENDER_CONSTANTS.colorSpace;
        gl.unpackColorSpace = RENDER_CONSTANTS.colorSpace;
        const backend: ResourceArenaBackend<Descriptors, Objects> = {
            create: (kind, descriptor) => this.#createNative(kind, descriptor),
            destroy: (kind, object) => this.#destroyNative(kind, object),
            completed: serial => this.#complete(serial),
        };
        this.#arena = new ResourceArena({ generation: this.generation, backend, releaseLease: lease => {
            const allocator = this.#ownedLeases.get(lease);
            this.#ownedLeases.delete(lease);
            if (allocator) allocator.release(lease);
            else this.#services.returnLease(lease);
        } });
        this.#pool = new Webgl2TargetPool({
            generation: this.generation, maxSize: this.limits.maxRenderTargetSize,
            create: request => this.#createPoolStorage(request),
            alias: (storage, request) => this.#createPoolAliases(storage, request),
            releaseAlias: lease => { this.#destroyDirect(lease.target); this.#destroyDirect(lease.texture); },
            destroy: storage => { this.destroy(storage.target); this.destroy(storage.texture); },
            completed: serial => this.#complete(serial),
        });
        // This is the broker's reservation signal, not the pane-hide work signal.
        // After its abort the broker may synchronously destroy a context whose canvas
        // listeners are already removed; observe actual loss after that task, not zero
        // the retirement ledger merely because healthy disposal was requested.
        const abandoned = () => queueMicrotask(() => {
            if (!this.#lost && this.#gl?.isContextLost()) this.abandon();
        });
        preparation.signal.addEventListener('abort', abandoned, { once: true });
        if (preparation.signal.aborted) abandoned();
        this.#reset();
    }

    get uniformRingBytes(): number { return this.#uniformBytes; }

    beginFrame(): FrameEncoder {
        this.#usable();
        this.#ensureWhite();
        const encoding = this.#arena.beginEncoding();
        const work: FrameWork = { encoding, controller: null, signal: this.#work.signal, slot: null,
            offset: 0, passes: false, surface: false, surfaceRevision: this.#surfaceRevision, issued: null, finished: false };
        this.#frames.set(encoding, work);
        const frame = createWebgl2Frame(this.#frameBackend(work));
        work.controller = frame;
        this.#controlledFrames.set(frame, frame);
        return frame;
    }

    discardFrame(encoder: FrameEncoder): void {
        const frame = this.#controlledFrames.get(encoder);
        if (!frame) throw new ArenaError('invalid-resource');
        frame.cancel();
    }

    acquireTarget(request: TargetRequest): TargetLease | null { this.#usable(); return this.#pool.acquire(request); }
    releaseTarget(lease: TargetLease): void { this.#pool.release(lease); this.#collect(); }

    createBuffer(bytes: number, uses: readonly BufferUse[], lease: ByteLease): BufferHandle {
        this.#usable();
        count(bytes);
        const checked = uniqueUses(uses, ['vertex', 'index', 'uniform', 'copy-src', 'copy-dst']);
        return this.#allocate('buffer', { bytes, uses: checked }, bytes, lease);
    }

    writeBuffer(dst: BufferHandle, offset: number, src: ArrayBufferView): void {
        const gl = this.#usable();
        this.#beforeUpload();
        const started = performance.now();
        const buffer = this.#arena.validate(dst, 'buffer');
        count(offset);
        if (!buffer.uses.has('copy-dst') || offset > buffer.bytes - src.byteLength) throw new ArenaError('invalid-input');
        if (!src.byteLength) return;
        const encoding = this.#arena.beginEncoding();
        let snapshotLease: ByteLease | null = null;
        try {
            this.#pin(encoding, dst, 'buffer');
            let upload: ArrayBufferView = src;
            let snapshot: Uint8Array<ArrayBuffer> | null = null;
            if (buffer.indices) {
                snapshotLease = this.#reserve(this.#services.cpuStaging, src.byteLength, false);
                snapshot = new Uint8Array(src.byteLength);
                snapshot.set(new Uint8Array(src.buffer, src.byteOffset, src.byteLength));
                if (src instanceof Uint16Array && offset % 2 === 0) Webgl2IndexMirror.validateTypedUpload(snapshot, 2);
                else if (src instanceof Uint32Array && offset % 4 === 0) Webgl2IndexMirror.validateTypedUpload(snapshot, 4);
                upload = snapshot;
            }
            gl.bindBuffer(gl.COPY_WRITE_BUFFER, buffer.buffer);
            gl.bufferSubData(gl.COPY_WRITE_BUFFER, offset, upload);
            this.#checkUpload();
            if (snapshot) buffer.indices!.write(offset, snapshot);
            this.#issue(encoding);
        } catch (error) {
            this.#cancelEncoding(encoding);
            throw this.#failure(error);
        } finally {
            if (snapshotLease) this.#returnCpu(snapshotLease);
            this.#services.recordUpload?.(src.byteLength, performance.now() - started);
            this.#reset();
        }
    }

    createTexture(width: number, height: number, format: TextureFormat, uses: readonly TextureUse[], lease: ByteLease): TextureHandle {
        this.#usable();
        this.#extent(width, height, this.limits.maxTexture2D);
        if (format !== 'rgba8' && format !== 'r8') throw new ArenaError('invalid-input');
        const checked = uniqueUses(uses, ['sample', 'render', 'copy-src', 'copy-dst']);
        return this.#allocate('texture', { width, height, format, uses: checked }, byteSize(width, height, format === 'r8' ? 1 : 4), lease);
    }

    writeTexture(dst: TextureHandle, rect: RectI, src: BitmapUpload | PixelUpload): void {
        const gl = this.#usable();
        this.#beforeUpload();
        const started = performance.now();
        const texture = this.#arena.validate(dst, 'texture');
        rectangle(rect, texture.width, texture.height);
        if (!texture.uses.includes('copy-dst') || src.premultiplied !== true || src.colorSpace !== 'srgb' || src.origin !== 'top-left') {
            throw new ArenaError('invalid-input');
        }
        if (!rect.width || !rect.height) return;
        const encoding = this.#arena.beginEncoding();
        let cpu: ByteLease | null = null;
        let staging: TargetLease | null = null;
        try {
            this.#pin(encoding, dst, 'texture');
            if ('rowBytes' in src) {
                const channels = texture.format === 'r8' ? 1 : 4;
                const row = byteSize(rect.width, channels);
                count(src.rowBytes);
                const needed = byteSize(src.rowBytes, rect.height - 1) + row;
                if (src.rowBytes < row || !Number.isSafeInteger(needed) || src.source.byteLength < needed) throw new ArenaError('invalid-input');
                cpu = this.#reserve(this.#services.cpuStaging, byteSize(row, rect.height), false);
                const flipped = new Uint8Array(row * rect.height);
                for (let y = 0; y < rect.height; y++) {
                    flipped.set(src.source.subarray(y * src.rowBytes, y * src.rowBytes + row), (rect.height - 1 - y) * row);
                }
                gl.bindTexture(gl.TEXTURE_2D, texture.texture);
                gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
                gl.texSubImage2D(gl.TEXTURE_2D, 0, rect.x, texture.height - rect.y - rect.height,
                    rect.width, rect.height, channels === 1 ? gl.RED : gl.RGBA, gl.UNSIGNED_BYTE, flipped);
                this.#checkUpload();
                this.#issue(encoding);
            } else {
                if (src.source.width !== rect.width || src.source.height !== rect.height) throw new ArenaError('invalid-input');
                staging = this.acquireTarget({ width: rect.width, height: rect.height, format: 'rgba8', samples: 1, stencil: false, purpose: 'group' });
                if (!staging) throw new ArenaError('out-of-budget');
                const stageTexture = this.#pin(encoding, staging.texture, 'texture');
                const stageTarget = this.#pin(encoding, staging.target, 'target');
                const dest = this.#pin(encoding, this.#attachment(dst), 'target');
                gl.bindTexture(gl.TEXTURE_2D, stageTexture.texture);
                gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, src.source);
                gl.bindFramebuffer(gl.READ_FRAMEBUFFER, stageTarget.framebuffer);
                gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dest.framebuffer);
                gl.blitFramebuffer(0, 0, rect.width, rect.height, rect.x, texture.height - rect.y,
                    rect.x + rect.width, texture.height - rect.y - rect.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
                this.#checkUpload();
                this.#issue(encoding);
            }
            this.#usable(); // Upload is not publication after generation loss (design:771).
        } catch (error) {
            this.#cancelEncoding(encoding);
            throw this.#failure(error);
        } finally {
            if (cpu) this.#returnCpu(cpu);
            if (staging) this.releaseTarget(staging);
            this.#services.recordUpload?.(byteSize(rect.width, rect.height, 'rowBytes' in src ? texture.format === 'r8' ? 1 : 4 : 4), performance.now() - started);
            this.#reset();
        }
    }

    createSampler(filter: 'nearest' | 'linear'): SamplerHandle {
        this.#usable();
        if (filter !== 'nearest' && filter !== 'linear') throw new ArenaError('invalid-input');
        let cached = this.#samplers.get(filter);
        if (!cached) {
            cached = this.#owned('sampler', { filter }, 0, this.#services.program);
            this.#samplers.set(filter, cached);
        }
        // Two native samplers, but independent public handles: destroying one layer's
        // handle must not invalidate another layer's reference to the same descriptor.
        return this.#owned('sampler', { reference: cached }, 0, this.#services.program);
    }

    createClip(mask: TextureHandle, deviceBounds: RectI): ClipHandle {
        this.#usable();
        const texture = this.#arena.validate(mask, 'texture');
        if (!texture.uses.includes('sample')) throw new ArenaError('invalid-input');
        // Red carries coverage in R8 or an explicitly charged RGBA8 mask fallback;
        // creating a clip never silently substitutes a four-byte colour allocation.
        for (const value of [deviceBounds.x, deviceBounds.y, deviceBounds.width, deviceBounds.height]) count(value);
        return this.#owned('clip', { mask, bounds: { ...deviceBounds } }, 0, this.#services.working, [mask, ...this.#textureBacking(mask)]);
    }

    async createPipeline(desc: PipelineDesc): Promise<PipelineHandle> {
        this.#usable();
        const descriptor = this.#pipeline(desc);
        const signal = this.#work.signal;
        const program = await this.#program(descriptor.shader, signal);
        this.#usable();
        if (signal.aborted) throw new ArenaError('aborted');
        return this.#owned('pipeline', { role: 'pipeline', program, descriptor }, 0, this.#services.program);
    }

    createTarget(color: TextureHandle, options: { samples: Samples; stencil: boolean }, lease: ByteLease): TargetHandle {
        this.#usable();
        const texture = this.#arena.validate(color, 'texture');
        if (!texture.uses.includes('render')) throw new ArenaError('invalid-input');
        const bytes = this.#targetBytes(texture, options.samples, options.stencil);
        const handle = this.#allocate('target', { color, samples: options.samples, stencil: options.stencil }, bytes, lease, [color, ...this.#textureBacking(color)]);
        if (options.stencil) {
            const gl = this.#usable();
            const encoding = this.#arena.beginEncoding();
            try {
                const target = this.#pin(encoding, handle, 'target');
                gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
                gl.disable(gl.SCISSOR_TEST);
                gl.stencilMask(255);
                gl.clearStencil(0);
                gl.clear(gl.STENCIL_BUFFER_BIT);
                this.#issue(encoding);
            } catch (error) {
                this.#cancelEncoding(encoding);
                this.destroy(handle);
                throw this.#failure(error);
            } finally { this.#reset(); }
        }
        return handle;
    }

    async readTexture(src: TextureHandle, rect: RectI, signal: AbortSignal): Promise<ImageBitmap> {
        const combined = AbortSignal.any([signal, this.#work.signal]);
        const raw = await this.#readRaw(src, rect, combined, 8);
        try {
            this.#usable();
            if (combined.aborted) throw new ArenaError('aborted');
            const straight = new Uint8ClampedArray(rect.width * rect.height * 4);
            for (let y = 0; y < rect.height; y++) {
                for (let x = 0; x < rect.width; x++) {
                    const from = (y * rect.width + x) * 4;
                    const to = ((rect.height - 1 - y) * rect.width + x) * 4;
                    const alpha = raw.bytes[from + 3];
                    for (let c = 0; c < 3; c++) straight[to + c] = alpha ? Math.min(255, Math.round(raw.bytes[from + c] * 255 / alpha)) : 0;
                    straight[to + 3] = alpha;
                }
            }
            const bitmap = await createImageBitmap(new ImageData(straight, rect.width, rect.height, { colorSpace: 'srgb' }), {
                premultiplyAlpha: 'premultiply', colorSpaceConversion: 'none', imageOrientation: 'none',
            });
            if (combined.aborted || this.#lost || this.#disposed) {
                bitmap.close();
                throw new ArenaError(this.#lost ? 'lost' : 'aborted');
            }
            return bitmap;
        } catch (error) { throw this.#failure(error); }
        finally { this.#returnCpu(raw.lease); }
    }

    completed(serial: number): boolean { return this.#complete(serial); }

    destroy(resource: Handle): void {
        if (this.#pool.releaseHandle(resource)) return;
        this.#destroyDirect(resource);
    }

    #destroyDirect(resource: Handle): void {
        for (const slot of this.#uniformSlots) if (slot.handle === resource) slot.valid = false;
        if (this.#handles.has(resource) && 'kind' in resource && resource.kind === 'buffer') {
            this.#dropIndexData(this.#arena.validate(resource, 'buffer'));
        }
        if (this.#attachments.has(resource as TextureHandle)) {
            const target = this.#attachments.get(resource as TextureHandle)!;
            this.#arena.release(target);
            this.#handles.delete(target);
            this.#attachments.delete(resource as TextureHandle);
        }
        for (const [filter, handle] of this.#samplers) if (handle === resource) this.#samplers.delete(filter);
        this.#arena.release(resource);
        this.#handles.delete(resource);
        this.#collect();
    }

    closeLease(lease: ByteLease): void { this.#arena.closeLease(lease); }
    memory(): ArenaMemory { return this.#arena.memory(); }
    leaseMemory(lease: ByteLease): ArenaLeaseMemory { return this.#arena.leaseMemory(lease); }
    cpuStagingMemory(): ArenaMemory { return { live: this.#cpuBytes, retiring: 0 }; }

    resizeSurface(width: number, height: number): SurfaceResizeResult {
        const gl = this.#healthy();
        if (this.#disposed) throw new ArenaError('aborted');
        count(width); count(height);
        if (width > Math.min(this.limits.maxRenderTargetSize, this.limits.maxViewport[0], RENDER_CONSTANTS.maxSurfaceAxisPixels) ||
            height > Math.min(this.limits.maxRenderTargetSize, this.limits.maxViewport[1], RENDER_CONSTANTS.maxSurfaceAxisPixels) ||
            byteSize(width, height) > RENDER_CONSTANTS.maxSurfacePixels) throw new ArenaError('invalid-input');
        const canvas = this.#canvas!;
        canvas.width = width;
        canvas.height = height;
        this.#surfaceRevision++;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
        this.#healthy();
        this.#paused = width === 0 || height === 0;
        this.#reset();
        return { width: gl.drawingBufferWidth, height: gl.drawingBufferHeight, complete, generation: this.generation };
    }

    releaseGpu(reason: GpuReleaseReason): void {
        if (reason === 'context-lost') { this.abandon(); return; }
        if (this.#lost || this.#disposed) return;
        this.#paused = true;
        this.#work.abort();
        try {
            this.#cleanup([
                ...[...this.#frames.values()].map(frame => () => frame.controller?.cancel()),
                () => this.#dropUniformSlots(), () => this.#dropVaos(), () => this.#pool.clear(),
                () => this.#arena.releaseAll(reason),
                () => {
                    for (const handle of this.#handles) {
                        if ('kind' in handle && handle.kind !== 'pipeline' && handle.kind !== 'sampler') this.#handles.delete(handle);
                    }
                },
                () => this.#attachments.clear(), () => this.#reset(), () => this.#collect(),
            ]);
        } finally {
            this.#white = null;
            if (!this.#lost && !this.#disposed) {
                this.#work = new AbortController();
                this.#paused = reason === 'hidden';
            }
        }
    }

    dispose(reason: ContextDisposeReason): void {
        if (this.#disposed) return;
        this.#disposed = true;
        if (reason === 'context-lost' || this.#lost || this.#gl?.isContextLost()) { this.abandon(); return; }
        this.#work.abort();
        this.#cleanup([
            ...[...this.#frames.values()].map(frame => () => frame.controller?.cancel()),
            () => this.#dropUniformSlots(), () => this.#dropVaos(), () => this.#pool.clear(),
            () => this.#arena.releaseAll('hidden'),
            () => { for (const handle of this.#handles) this.#arena.release(handle); },
            () => this.#handles.clear(), () => this.#programs.clear(), () => this.#programSignatures.clear(),
            () => this.#samplers.clear(), () => this.#attachments.clear(),
            () => { this.#white = null; this.#composition = null; }, () => this.#collect(),
        ]);
    }

    abandon(): void {
        if (this.#lost) return;
        this.#lost = true;
        this.#work.abort();
        try {
            this.#cleanup([
                ...[...this.#frames.values()].map(frame => () => frame.controller?.cancel()),
                () => this.#pool.abandon(),
                ...this.#uniformSlots.map(slot => () => this.#returnCpu(slot.lease)),
                () => { this.#uniformSlots.length = 0; },
                ...[...this.#indexBuffers].map(buffer => () => this.#dropIndexData(buffer)),
                () => this.#pipelines.clear(), () => this.#pollCancel?.(),
                () => { this.#pollCancel = null; this.#white = null; this.#composition = null; },
                () => this.#fences.clear(), () => this.#handles.clear(), () => this.#programs.clear(),
                () => this.#programSignatures.clear(), () => this.#samplers.clear(), () => this.#attachments.clear(),
                () => this.#textureUnits.clear(), () => this.#uniformUnits.clear(), () => this.#arena.abandon(),
            ]);
        } finally { this.#gl = null; this.#canvas = null; }
    }

    #cleanup(steps: readonly (() => void)[]): void {
        const failures: unknown[] = [];
        for (const step of steps) { try { step(); } catch (error) { failures.push(error); } }
        if (failures.length) throw this.#failure(failures[0]);
    }

    /** Required runtime fallback decision, only during normal generation preparation (design:368).
     * This is private product startup work, not an exported verification entry point.
     */
    async #qualify(signal: AbortSignal): Promise<void> {
        const combined = AbortSignal.any([signal, this.#work.signal]);
        if (combined.aborted) throw new ArenaError('aborted');
        const lease = this.#reserve(this.#services.working, 16);
        let texture: TextureHandle | null = null;
        let target: TargetHandle | null = null;
        try {
            texture = this.createTexture(2, 2, 'rgba8', ['render', 'copy-src'], lease);
            target = this.createTarget(texture, { samples: 1, stencil: false }, lease);
            this.closeLease(lease);
            const programHandle = await this.#program(CAPABILITY_SHADER, combined);
            if (combined.aborted) throw new ArenaError('aborted');
            const program = this.#arena.validate(programHandle, 'pipeline');
            if (program.role !== 'program') throw new ArenaError('invalid-resource');
            const gl = this.#usable();
            const encoding = this.#arena.beginEncoding();
            try {
                const output = this.#pin(encoding, target, 'target');
                this.#pin(encoding, programHandle, 'pipeline');
                gl.bindFramebuffer(gl.FRAMEBUFFER, output.framebuffer);
                gl.viewport(0, 0, 2, 2);
                gl.clearColor(0.125, 0.25, 0.5, 0.5);
                gl.clear(gl.COLOR_BUFFER_BIT);
                gl.useProgram(program.program);
                gl.enable(gl.BLEND);
                gl.blendEquation(gl.FUNC_ADD);
                gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
                gl.drawArrays(gl.TRIANGLES, 0, 3);
                this.#issue(encoding);
            } catch (error) { this.#cancelEncoding(encoding); throw this.#failure(error); }
            finally { this.#reset(); }
            const raw = await this.#readRaw(texture, { x: 0, y: 0, width: 2, height: 2 }, combined, 4);
            try {
                // Two channel levels tolerate fixed-point clear/blend rounding, not wrong alpha/colour.
                const expected = [143, 32, 64, 191, 16, 96, 64, 191, 16, 32, 96, 191, 32, 64, 128, 128];
                if (raw.bytes.some((value, i) => Math.abs(value - expected[i]) > 2)) throw new ArenaError('unsupported');
            } finally { this.#returnCpu(raw.lease); }
            if (combined.aborted) throw new ArenaError('aborted');
            this.#usable();
        } finally {
            this.closeLease(lease);
            if (target) this.destroy(target);
            if (texture) this.destroy(texture);
        }
    }

    async #prepareComposition(signal: AbortSignal): Promise<void> {
        this.#composition = await this.#program(COMPOSITION_SHADER, AbortSignal.any([signal, this.#work.signal]));
        const sampler = this.createSampler('linear');
        this.destroy(sampler);
        this.#ensureWhite();
    }

    #ensureWhite(): TextureHandle {
        if (this.#white) return this.#white;
        const lease = this.#reserve(this.#services.working, 1);
        let handle: TextureHandle | null = null;
        try {
            handle = this.createTexture(1, 1, 'r8', ['sample', 'copy-dst'], lease);
            this.writeTexture(handle, { x: 0, y: 0, width: 1, height: 1 }, {
                source: new Uint8Array([255]), rowBytes: 1, premultiplied: true, colorSpace: 'srgb', origin: 'top-left',
            });
            this.#white = handle;
            return handle;
        } catch (error) { if (handle) this.destroy(handle); throw error; }
        finally { this.closeLease(lease); }
    }

    #checkUpload(): void {
        // Upload admission is separate from draw submission. A failed copy must not
        // publish a new CPU index summary or stale uniforms as if the GPU accepted it.
        const gl = this.#healthy();
        const error = gl.getError();
        if (error !== gl.NO_ERROR) {
            this.#healthy();
            throw new ArenaError(error === gl.OUT_OF_MEMORY ? 'allocation' : 'invalid-input');
        }
    }

    #beforeUpload(): void {
        for (const frame of this.#frames.values()) if (frame.passes && !frame.finished) throw new ArenaError('invalid-input');
    }

    #textureBacking(handle: TextureHandle): TextureHandle[] {
        const texture = this.#arena.validate(handle, 'texture');
        return texture.reference ? [texture.reference] : [];
    }

    #createPoolStorage(request: TargetRequest): PoolStorage {
        const format = request.format ?? 'rgba8';
        const colorBytes = byteSize(request.width, request.height, format === 'r8' ? 1 : 4);
        const extra = byteSize(request.width, request.height,
            (request.samples === 4 ? (format === 'r8' ? 1 : 4) * 4 : 0) + (request.stencil ? request.samples * 8 : 0));
        const lease = this.#reserve(this.#services.working, colorBytes + extra);
        let texture: TextureHandle | null = null;
        try {
            texture = this.#allocate('texture', { width: request.width, height: request.height, format,
                uses: ['sample', 'render', 'copy-src', 'copy-dst'] }, colorBytes, lease);
            const target = this.#allocate('target', { color: texture, samples: request.samples, stencil: request.stencil }, extra, lease, [texture]);
            return { texture, target, request };
        } catch (error) { if (texture) this.destroy(texture); throw error; }
        finally { this.closeLease(lease); }
    }

    #createPoolAliases(storage: PoolStorage, request: TargetRequest): { texture: TextureHandle; target: TargetHandle } {
        const texture = this.#owned('texture', { reference: storage.texture }, 0, this.#services.working);
        this.#arena.validate(texture, 'texture').usedRect = { x: 0, y: 0, width: request.width, height: request.height };
        try {
            const target = this.#owned('target', { reference: storage.target, color: texture, purpose: request.purpose }, 0,
                this.#services.working, [texture, storage.texture]);
            return { texture, target };
        } catch (error) { this.#destroyDirect(texture); throw error; }
    }

    #cancelEncoding(encoding: ArenaEncoding): void {
        this.#arena.cancel(encoding);
        this.#pool.finish(encoding, this.#frames.get(encoding)?.issued ?? null);
    }

    #pin<K extends ArenaResourceKind>(encoding: ArenaEncoding, handle: Handle, kind: K): Objects[K] {
        const native = this.#arena.pin(encoding, handle, kind);
        this.#pool.touch(handle, encoding);
        if (kind === 'texture') {
            const texture = native as NativeTexture;
            if (texture.reference) this.#arena.pin(encoding, texture.reference, 'texture');
        } else if (kind === 'target') {
            const target = native as NativeTarget;
            if (target.reference) this.#arena.pin(encoding, target.reference, 'target');
            if (target.colorTexture.reference) this.#arena.pin(encoding, target.colorTexture.reference, 'texture');
            this.#pool.touch(target.color, encoding);
        } else if (kind === 'clip') {
            const clip = native as NativeClip;
            if (clip.texture.reference) this.#arena.pin(encoding, clip.texture.reference, 'texture');
            this.#pool.touch(clip.mask, encoding);
        } else if (kind === 'pipeline') {
            const pipeline = native as Objects['pipeline'];
            if (pipeline.role === 'pipeline') this.#arena.pin(encoding, pipeline.program, 'pipeline');
        } else if (kind === 'sampler') {
            const sampler = native as Objects['sampler'];
            if (sampler.reference) this.#arena.pin(encoding, sampler.reference, 'sampler');
        }
        return native;
    }

    #frameBackend(work: FrameWork): FrameBackend {
        const check = () => {
            this.#usable();
            if (work.finished || work.signal.aborted || work.surface && work.surfaceRevision !== this.#surfaceRevision) {
                throw new ArenaError('aborted');
            }
        };
        const texture = (handle: TextureHandle): FrameTexture => this.#frameTexture(handle, this.#pin(work.encoding, handle, 'texture'));
        const target = (handle: TargetHandle | 'surface'): FrameTarget => {
            if (handle === 'surface') {
                const gl = this.#usable();
                return { handle, framebuffer: null, resolveFramebuffer: null, width: gl.drawingBufferWidth, height: gl.drawingBufferHeight,
                    format: 'rgba8', samples: 1, stencil: false, capture: false, color: null,
                    usedRect: { x: 0, y: 0, width: gl.drawingBufferWidth, height: gl.drawingBufferHeight }, retained: { colorStored: false, stencilStored: false } };
            }
            const native = this.#pin(work.encoding, handle, 'target');
            return { handle, framebuffer: native.framebuffer, resolveFramebuffer: native.resolveFramebuffer,
                width: native.width, height: native.height, format: native.format, samples: native.samples,
                stencil: native.stencil, capture: native.capture, retained: native,
                usedRect: native.colorTexture.usedRect ?? { x: 0, y: 0, width: native.width, height: native.height },
                color: this.#frameTexture(native.color, native.colorTexture) };
        };
        return {
            signal: work.signal, uniformAlignment: this.limits.uniformAlignment, maxViewport: this.limits.maxViewport,
            healthy: check, gl: () => { check(); return this.#healthy(); }, reset: () => this.#reset(),
            buffer: handle => {
                const native = this.#pin(work.encoding, handle, 'buffer');
                return { handle, buffer: native.buffer, bytes: native.bytes, uses: native.uses,
                    maxIndex: (offset, length, format) => this.#maxIndex(native, offset, length, format) };
            },
            texture, target,
            sampler: handle => ({ sampler: this.#pin(work.encoding, handle, 'sampler').sampler }),
            pipeline: handle => {
                const native = this.#pin(work.encoding, handle, 'pipeline');
                if (native.role !== 'pipeline') throw new ArenaError('invalid-resource');
                const program = this.#arena.validate(native.program, 'pipeline');
                if (program.role !== 'program' || !program.linked) throw new ArenaError('invalid-resource');
                this.#ensureVao(native);
                return { descriptor: native.descriptor, draw: (command, context) => this.#draw(native, program, command, context) };
            },
            clip: handle => {
                const clip = this.#pin(work.encoding, handle, 'clip');
                return { mask: this.#frameTexture(clip.mask, clip.texture), bounds: clip.bounds };
            },
            attachment: value => target(this.#attachment(value.handle)),
            white: () => texture(this.#white!),
            uniforms: bytes => this.#frameUniforms(work, bytes),
            uploadUniforms: () => this.#uploadUniforms(work),
            quad: command => {
                if (!this.#composition) throw new ArenaError('invalid-resource');
                const program = this.#pin(work.encoding, this.#composition, 'pipeline');
                const samplerHandle = this.#samplers.get('linear');
                if (program.role !== 'program' || !samplerHandle) throw new ArenaError('invalid-resource');
                const sampler = this.#pin(work.encoding, samplerHandle, 'sampler');
                return () => this.#drawQuad(program, sampler, command);
            },
            acquireTarget: request => this.acquireTarget(request), releaseTarget: lease => this.releaseTarget(lease),
            issue: () => this.#issue(work.encoding),
            cancel: () => this.#cancelEncoding(work.encoding),
            finish: serial => {
                if (work.finished) return;
                work.finished = true;
                if (work.slot) { work.slot.owner = null; work.slot.serial = serial ?? work.issued ?? 0; work.slot = null; }
                this.#frames.delete(work.encoding);
            },
            failure: error => this.#failure(error), onPass: surface => { work.passes = true; work.surface ||= surface; },
        };
    }

    #frameTexture(handle: TextureHandle, texture: NativeTexture): FrameTexture {
        return { handle, texture: texture.texture, width: texture.width, height: texture.height, format: texture.format, uses: texture.uses,
            usedRect: texture.usedRect ?? { x: 0, y: 0, width: texture.width, height: texture.height } };
    }

    #frameUniforms(work: FrameWork, bytes: ArrayBufferView): UniformSlice {
        count(bytes.byteLength, true);
        if (!work.slot) work.slot = this.#uniformSlot(work);
        const offset = Math.ceil(work.offset / this.limits.uniformAlignment) * this.limits.uniformAlignment;
        if (offset > work.slot.data.byteLength - bytes.byteLength) {
            const next = Math.min(8 << 20, this.#uniformBytes * 2);
            if (next !== this.#uniformBytes) {
                const growth = { previous: this.#uniformBytes, next };
                this.#uniformGrowths.push(growth);
                this.#uniformBytes = next;
                this.#services.recordUniformGrowth?.(growth.previous, growth.next);
            }
            throw new ArenaError('out-of-budget');
        }
        work.slot.data.set(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), offset);
        work.offset = offset + bytes.byteLength;
        this.#pin(work.encoding, work.slot.handle, 'buffer');
        return { buffer: work.slot.handle, offset, bytes: bytes.byteLength };
    }

    #uniformSlot(work: FrameWork): UniformSlot {
        // Three nonblocking slots (rendering-design.md:281). The ruled 1→8 MiB growth
        // changes a future encode, never the current frame's budget or in-flight bytes.
        // A growth retires old buffers; it never resizes storage that a prior submission uses.
        for (let i = this.#uniformSlots.length - 1; i >= 0; i--) {
            const slot = this.#uniformSlots[i];
            if (!slot.owner && (!slot.valid || slot.data.byteLength !== this.#uniformBytes)) {
                this.destroy(slot.handle);
                this.#returnCpu(slot.lease);
                this.#uniformSlots.splice(i, 1);
            }
        }
        let slot = this.#uniformSlots.find(candidate => candidate.valid && !candidate.owner && this.#complete(candidate.serial));
        if (!slot) {
            if (this.#uniformSlots.length >= 3) throw new ArenaError('out-of-budget');
            const cpu = this.#reserve(this.#services.cpuStaging, this.#uniformBytes, false);
            let handle: BufferHandle | null = null;
            try {
                const data = new Uint8Array(this.#uniformBytes);
                handle = this.#owned('buffer', { bytes: this.#uniformBytes, uses: ['uniform', 'copy-dst'] }, this.#uniformBytes, this.#services.working);
                slot = { handle, native: this.#arena.validate(handle, 'buffer'), data, lease: cpu, serial: 0, owner: null, valid: true };
                this.#uniformSlots.push(slot);
            } catch (error) { if (handle) this.destroy(handle); this.#returnCpu(cpu); throw error; }
        }
        slot.owner = work;
        return slot;
    }

    #uploadUniforms(work: FrameWork): void {
        if (!work.slot || !work.offset) return;
        const gl = this.#usable();
        const started = performance.now();
        try {
            gl.bindBuffer(gl.COPY_WRITE_BUFFER, work.slot.native.buffer);
            gl.bufferSubData(gl.COPY_WRITE_BUFFER, 0, work.slot.data.subarray(0, work.offset));
            this.#checkUpload();
        } finally {
            this.#services.recordUpload?.(work.offset, performance.now() - started);
            this.#reset();
        }
    }

    #dropUniformSlots(): void {
        for (const slot of this.#uniformSlots) { this.destroy(slot.handle); this.#returnCpu(slot.lease); }
        this.#uniformSlots.length = 0;
    }

    #maxIndex(buffer: NativeBuffer, offset: number, length: number, format: 'uint16' | 'uint32'): number {
        if (!buffer.indices) throw new ArenaError('invalid-resource');
        return buffer.indices.maximum(offset, length, format, this.#maxElementIndex);
    }

    #dropIndexData(buffer: NativeBuffer): void {
        if (buffer.indexLease) this.#returnCpu(buffer.indexLease);
        buffer.indices = null;
        buffer.indexLease = null;
        this.#indexBuffers.delete(buffer);
    }

    #detachBuffer(buffer: WebGLBuffer): void {
        const gl = this.#healthy();
        for (const pipeline of this.#pipelines) {
            if (!pipeline.buffers.has(buffer)) continue;
            if (pipeline.vao) gl.deleteVertexArray(pipeline.vao);
            pipeline.vao = null;
            pipeline.vertexBindings = null;
            pipeline.buffers.clear();
        }
    }

    #ensureVao(pipeline: NativePipeline): WebGLVertexArrayObject {
        if (!pipeline.vao) {
            pipeline.vao = this.#usable().createVertexArray();
            if (!pipeline.vao) throw new ArenaError('allocation');
            pipeline.vertexBindings = null;
        }
        return pipeline.vao;
    }

    #dropVaos(): void {
        const gl = this.#healthy();
        for (const pipeline of this.#pipelines) {
            if (pipeline.vao) gl.deleteVertexArray(pipeline.vao);
            pipeline.vao = null;
            pipeline.vertexBindings = null;
            pipeline.buffers.clear();
        }
        for (const handle of this.#handles) {
            if ('kind' in handle && handle.kind === 'buffer') this.#dropIndexData(this.#arena.validate(handle, 'buffer'));
        }
    }

    #viewport(context: DrawContext, scissor: RectI): void {
        const gl = this.#usable();
        gl.bindFramebuffer(gl.FRAMEBUFFER, context.target.framebuffer);
        gl.viewport(context.viewport.x - context.originX, context.target.height - (context.viewport.y - context.originY) - context.viewport.height,
            context.viewport.width, context.viewport.height);
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(scissor.x - context.originX, context.target.height - (scissor.y - context.originY) - scissor.height, scissor.width, scissor.height);
    }

    #bindUniform(binding: number, buffer: WebGLBuffer, offset: number, bytes: number): void {
        const gl = this.#healthy();
        gl.bindBufferRange(gl.UNIFORM_BUFFER, binding, buffer, offset, bytes);
        this.#uniformUnits.add(binding);
    }

    #bindTexture(binding: number, texture: WebGLTexture, sampler: WebGLSampler): void {
        const gl = this.#healthy();
        gl.activeTexture(gl.TEXTURE0 + binding);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.bindSampler(binding, sampler);
        this.#textureUnits.add(binding);
    }

    #blend(blend: 'replace' | 'source-over' | 'mask-max'): void {
        const gl = this.#usable();
        if (blend === 'replace') gl.disable(gl.BLEND);
        else {
            gl.enable(gl.BLEND);
            gl.blendEquation(blend === 'mask-max' ? gl.MAX : gl.FUNC_ADD);
            gl.blendFunc(gl.ONE, blend === 'source-over' ? gl.ONE_MINUS_SRC_ALPHA : gl.ONE);
        }
    }

    #draw(pipeline: NativePipeline, program: NativeProgram, command: EncodedDraw, context: DrawContext): void {
        const gl = this.#usable();
        try {
            this.#viewport(context, command.scissor);
            gl.useProgram(program.program);
            gl.bindVertexArray(this.#ensureVao(pipeline));
            const bindings = pipeline.vertexBindings;
            if (!bindings || bindings.length !== command.vertices.length ||
                bindings.some((binding, i) => binding.id !== command.vertices[i].buffer.handle.id || binding.offset !== command.vertices[i].slice.offset)) {
                for (const attribute of pipeline.descriptor.shader.layout.attributes) {
                    const vertex = command.vertices[attribute.bufferSlot];
                    gl.bindBuffer(gl.ARRAY_BUFFER, vertex.buffer.buffer);
                    gl.enableVertexAttribArray(attribute.location);
                    if (attribute.format === 'uint32') gl.vertexAttribIPointer(attribute.location, 1, gl.UNSIGNED_INT, attribute.stride, vertex.slice.offset + attribute.offset);
                    else {
                        const components = attribute.format === 'float32x2' ? 2 : attribute.format === 'float32x3' ? 3 : 4;
                        gl.vertexAttribPointer(attribute.location, components, attribute.format === 'unorm8x4' ? gl.UNSIGNED_BYTE : gl.FLOAT,
                            attribute.format === 'unorm8x4', attribute.stride, vertex.slice.offset + attribute.offset);
                    }
                    gl.vertexAttribDivisor(attribute.location, attribute.step === 'instance' ? 1 : 0);
                }
                pipeline.vertexBindings = command.vertices.map(vertex => ({ id: vertex.buffer.handle.id, offset: vertex.slice.offset }));
            }
            for (const uniform of command.uniforms) this.#bindUniform(uniform.binding, uniform.buffer.buffer, uniform.offset, uniform.bytes);
            for (const texture of command.textures) this.#bindTexture(texture.binding, texture.texture.texture, texture.sampler.sampler);
            this.#blend(pipeline.descriptor.blend);
            gl.colorMask(...pipeline.descriptor.colorWrite);
            if (pipeline.descriptor.alphaToCoverage) gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);
            else gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
            const stencil = pipeline.descriptor.stencil;
            if (stencil.enabled) {
                const compares = { never: gl.NEVER, less: gl.LESS, equal: gl.EQUAL, 'less-equal': gl.LEQUAL, greater: gl.GREATER,
                    'not-equal': gl.NOTEQUAL, 'greater-equal': gl.GEQUAL, always: gl.ALWAYS };
                const operations = { keep: gl.KEEP, zero: gl.ZERO, replace: gl.REPLACE, invert: gl.INVERT,
                    'increment-clamp': gl.INCR, 'decrement-clamp': gl.DECR, 'increment-wrap': gl.INCR_WRAP, 'decrement-wrap': gl.DECR_WRAP };
                gl.enable(gl.STENCIL_TEST);
                gl.stencilFunc(compares[stencil.compare], stencil.reference, stencil.readMask);
                gl.stencilMask(stencil.writeMask);
                gl.stencilOpSeparate(gl.FRONT, operations[stencil.front.fail], operations[stencil.front.depthFail], operations[stencil.front.pass]);
                gl.stencilOpSeparate(gl.BACK, operations[stencil.back.fail], operations[stencil.back.depthFail], operations[stencil.back.pass]);
            } else gl.disable(gl.STENCIL_TEST);
            pipeline.buffers.clear();
            for (const vertex of command.vertices) pipeline.buffers.add(vertex.buffer.buffer);
            const topology = pipeline.descriptor.topology === 'triangles' ? gl.TRIANGLES : gl.TRIANGLE_STRIP;
            if (command.index) {
                pipeline.buffers.add(command.index.buffer.buffer);
                gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, command.index.buffer.buffer);
                gl.drawElementsInstanced(topology, command.count, command.index.format === 'uint16' ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT,
                    command.index.offset, command.instances);
            } else {
                gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
                gl.drawArraysInstanced(topology, command.first, command.count, command.instances);
            }
        } finally { this.#reset(); }
    }

    #drawQuad(program: NativeProgram, sampler: Objects['sampler'], command: QuadCommand): void {
        const gl = this.#usable();
        try {
            this.#viewport(command.context, command.scissor);
            gl.useProgram(program.program);
            gl.bindVertexArray(null);
            this.#bindUniform(0, command.uniforms.buffer.buffer, command.uniforms.slice.offset, 128);
            this.#bindTexture(0, command.source.texture, sampler.sampler);
            this.#bindTexture(1, command.backdrop.texture, sampler.sampler);
            this.#bindTexture(2, command.mask.texture, sampler.sampler);
            this.#blend(command.blend);
            gl.colorMask(true, true, true, true);
            gl.disable(gl.STENCIL_TEST);
            gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        } finally { this.#reset(); }
    }

    #healthy(): WebGL2RenderingContext {
        if (this.#lost || !this.#gl) throw new ArenaError(this.#lost ? 'lost' : 'aborted');
        if (this.#gl.isContextLost()) { this.abandon(); throw new ArenaError('lost'); }
        return this.#gl;
    }
    #usable(): WebGL2RenderingContext {
        const gl = this.#healthy();
        if (this.#brokenFence) throw new ArenaError('allocation');
        if (this.#disposed || this.#paused) throw new ArenaError('aborted');
        return gl;
    }
    #failure(error: unknown): ArenaError {
        if (this.#lost || this.#gl?.isContextLost()) {
            this.abandon();
            return new ArenaError('lost');
        }
        if (error instanceof DOMException && error.name === 'SecurityError') return new ArenaError('unsupported');
        return error instanceof ArenaError ? error : new ArenaError('allocation');
    }
    #extent(width: number, height: number, cap: number): void {
        count(width, true); count(height, true);
        if (width > cap || height > cap) throw new ArenaError('unsupported');
    }
    #reserve(allocator: MemoryAllocator, bytes: number, owned = true): ByteLease {
        count(bytes);
        const lease = allocator.reserve(bytes);
        if (!lease || lease.bytes < bytes) {
            if (lease) allocator.release(lease);
            throw new ArenaError('out-of-budget');
        }
        if (owned) this.#ownedLeases.set(lease, allocator);
        else { this.#cpuLeases.set(lease, bytes); this.#cpuBytes += bytes; }
        return lease;
    }
    #returnCpu(lease: ByteLease): void {
        const bytes = this.#cpuLeases.get(lease);
        if (bytes === undefined) return;
        this.#cpuLeases.delete(lease);
        this.#cpuBytes -= bytes;
        this.#services.cpuStaging.release(lease);
    }
    #allocate<K extends ArenaResourceKind>(kind: K, descriptor: Descriptors[K], bytes: number, lease: ByteLease, dependencies: readonly Handle[] = []): import('../resourceArena').ArenaHandleMap[K] {
        try {
            const handle = this.#arena.create(kind, descriptor, bytes, lease, dependencies);
            this.#healthy();
            this.#handles.add(handle);
            return handle;
        } catch (error) { throw this.#failure(error); }
        finally { this.#reset(); }
    }
    #owned<K extends ArenaResourceKind>(kind: K, descriptor: Descriptors[K], bytes: number, allocator: MemoryAllocator, dependencies: readonly Handle[] = []): import('../resourceArena').ArenaHandleMap[K] {
        const lease = this.#reserve(allocator, bytes);
        try { return this.#allocate(kind, descriptor, bytes, lease, dependencies); }
        finally { this.closeLease(lease); }
    }

    #targetBytes(texture: NativeTexture, samples: Samples, stencil: boolean): number {
        this.#extent(texture.width, texture.height, this.limits.maxRenderTargetSize);
        if (samples !== 1 && samples !== 4 || typeof stencil !== 'boolean') throw new ArenaError('invalid-input');
        const gl = this.#healthy();
        const internal = texture.format === 'rgba8' ? gl.RGBA8 : gl.R8;
        if (samples === 4 && (!this.#sampleCounts.get(internal)?.has(4) || stencil && !this.#sampleCounts.get(gl.DEPTH24_STENCIL8)?.has(4))) {
            throw new ArenaError('unsupported');
        }
        // Resolve texture is already charged separately; unknown native depth/stencil uses 8 B/px/sample.
        return byteSize(texture.width, texture.height,
            (samples === 4 ? (texture.format === 'r8' ? 1 : 4) * 4 : 0) + (stencil ? 8 * samples : 0));
    }

    #attachment(texture: TextureHandle): TargetHandle {
        const cached = this.#attachments.get(texture);
        if (cached) return cached;
        this.#arena.validate(texture, 'texture');
        const handle = this.#owned('target', { color: texture, samples: 1, stencil: false }, 0, this.#services.working, [texture, ...this.#textureBacking(texture)]);
        this.#attachments.set(texture, handle);
        return handle;
    }
    #pipeline(desc: PipelineDesc): PipelineDesc {
        if (typeof desc.shader.id !== 'string' || !desc.shader.id ||
            typeof desc.shader.glsl.vertex !== 'string' || !desc.shader.glsl.vertex ||
            typeof desc.shader.glsl.fragment !== 'string' || !desc.shader.glsl.fragment) throw new ArenaError('invalid-input');
        count(desc.shader.revision);
        if (!['triangles', 'triangle-strip'].includes(desc.topology) || !['rgba8', 'r8'].includes(desc.colorFormat) ||
            ![1, 4].includes(desc.samples) || !['replace', 'source-over', 'mask-max'].includes(desc.blend) ||
            typeof desc.alphaToCoverage !== 'boolean' ||
            desc.colorWrite.length !== 4 || desc.colorWrite.some(value => typeof value !== 'boolean')) throw new ArenaError('invalid-input');
        const gl = this.#healthy();
        if (desc.samples === 4 && !this.#sampleCounts.get(desc.colorFormat === 'rgba8' ? gl.RGBA8 : gl.R8)?.has(4)) {
            throw new ArenaError('unsupported');
        }
        if (typeof desc.stencil.enabled !== 'boolean') throw new ArenaError('invalid-input');
        if (desc.stencil.enabled) {
            if (!['never', 'less', 'equal', 'less-equal', 'greater', 'not-equal', 'greater-equal', 'always'].includes(desc.stencil.compare)) {
                throw new ArenaError('invalid-input');
            }
            for (const face of [desc.stencil.front, desc.stencil.back]) {
                for (const operation of [face.fail, face.depthFail, face.pass]) {
                    if (!['keep', 'zero', 'replace', 'invert', 'increment-clamp', 'decrement-clamp', 'increment-wrap', 'decrement-wrap'].includes(operation)) {
                        throw new ArenaError('invalid-input');
                    }
                }
            }
            for (const value of [desc.stencil.reference, desc.stencil.readMask, desc.stencil.writeMask]) {
                count(value); if (value > 255) throw new ArenaError('invalid-input');
            }
        }
        const bindings = new Set<number>();
        for (const uniform of desc.shader.layout.uniforms) {
            count(uniform.binding); count(uniform.byteSize, true);
            if (uniform.byteSize > this.limits.maxUniformBytes || uniform.binding >= this.#uniformBindings ||
                bindings.has(uniform.binding)) throw new ArenaError('invalid-input');
            bindings.add(uniform.binding);
        }
        bindings.clear();
        for (const texture of desc.shader.layout.textures) {
            count(texture.binding);
            if (texture.binding >= this.limits.maxTextureBindings || bindings.has(texture.binding) ||
                texture.format !== 'rgba8' && texture.format !== 'r8') throw new ArenaError('invalid-input');
            bindings.add(texture.binding);
        }
        bindings.clear();
        for (const attribute of desc.shader.layout.attributes) {
            for (const value of [attribute.location, attribute.bufferSlot, attribute.offset, attribute.stride]) count(value);
            const alignment = attribute.format === 'unorm8x4' ? 1 : 4;
            if (attribute.location >= this.#maxAttributes || bindings.has(attribute.location) ||
                attribute.stride > 255 || attribute.offset % alignment || attribute.stride % alignment ||
                !['float32x2', 'float32x3', 'float32x4', 'unorm8x4', 'uint32'].includes(attribute.format) ||
                attribute.step !== 'vertex' && attribute.step !== 'instance') throw new ArenaError('invalid-input');
            bindings.add(attribute.location);
        }
        // Snapshot at creation, not a deep-equality comparison in the per-draw hot path.
        return structuredClone(desc);
    }

    #program(shader: ShaderModule, signal: AbortSignal): Promise<PipelineHandle> {
        if (signal.aborted) return Promise.reject(new ArenaError('aborted'));
        const key = JSON.stringify([shader.id, shader.revision]);
        const signature = JSON.stringify([shader.glsl, shader.layout]);
        const known = this.#programSignatures.get(key);
        if (known !== undefined && known !== signature) return Promise.reject(new ArenaError('invalid-input'));
        this.#programSignatures.set(key, signature);
        const cached = this.#programs.get(key);
        if (cached) return cached;
        const promise = (async () => {
            await this.#task(signal);
            this.#usable();
            const handle = this.#owned('pipeline', { role: 'program', shader }, 0, this.#services.program);
            try {
                const native = this.#arena.validate(handle, 'pipeline');
                if (native.role !== 'program') throw new ArenaError('invalid-resource');
                if (this.#parallel) {
                    while (!this.#healthy().getProgramParameter(native.program, this.#parallel.COMPLETION_STATUS_KHR)) await this.#nextPoll(signal);
                } else await this.#task(signal);
                this.#usable();
                if (signal.aborted) throw new ArenaError('aborted');
                const gl = this.#healthy();
                if (!gl.getProgramParameter(native.program, gl.LINK_STATUS)) throw new ArenaError('unsupported');
                gl.useProgram(native.program);
                for (const uniform of shader.layout.uniforms) {
                    const index = gl.getUniformBlockIndex(native.program, `GfxUniforms${uniform.binding}`);
                    if (index === gl.INVALID_INDEX || gl.getActiveUniformBlockParameter(native.program, index, gl.UNIFORM_BLOCK_DATA_SIZE) !== uniform.byteSize) {
                        throw new ArenaError('unsupported');
                    }
                    gl.uniformBlockBinding(native.program, index, uniform.binding);
                }
                for (const texture of shader.layout.textures) {
                    const location = gl.getUniformLocation(native.program, `gfxTexture${texture.binding}`);
                    if (location === null) throw new ArenaError('unsupported');
                    gl.uniform1i(location, texture.binding);
                }
                native.linked = true;
                this.#dropShaders(native);
                return handle;
            } catch (error) { this.destroy(handle); throw this.#failure(error); }
            finally { this.#reset(); }
        })();
        this.#programs.set(key, promise);
        void promise.catch(() => { if (this.#programs.get(key) === promise) this.#programs.delete(key); });
        return promise;
    }

    async #readRaw(src: TextureHandle, rect: RectI, signal: AbortSignal, cpuBytesPerPixel: number): Promise<RawRead> {
        const gl = this.#usable();
        if (signal.aborted) throw new ArenaError('aborted');
        const texture = this.#arena.validate(src, 'texture');
        rectangle(rect, texture.width, texture.height);
        if (!rect.width || !rect.height || !texture.uses.includes('copy-src')) throw new ArenaError('invalid-input');
        const bytes = byteSize(rect.width, rect.height, 4);
        const cpu = this.#reserve(this.#services.cpuStaging, byteSize(rect.width, rect.height, cpuBytesPerPixel), false);
        let buffer: BufferHandle | null = null;
        let handedOff = false;
        let encoding: ArenaEncoding | null = null;
        try {
            encoding = this.#arena.beginEncoding();
            buffer = this.#owned('buffer', { bytes, uses: ['copy-dst'], pack: true }, bytes, this.#services.gpuStaging);
            const pack = this.#pin(encoding, buffer, 'buffer');
            const target = this.#pin(encoding, this.#attachment(src), 'target');
            this.#pin(encoding, src, 'texture');
            gl.bindFramebuffer(gl.READ_FRAMEBUFFER, target.framebuffer);
            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pack.buffer);
            gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
            gl.readPixels(rect.x, texture.height - rect.y - rect.height, rect.width, rect.height, gl.RGBA, gl.UNSIGNED_BYTE, 0);
            // Readback is not a hot draw path; refuse unsupported/failed reads, not a blank success.
            if (gl.getError() !== gl.NO_ERROR) { this.#healthy(); throw new ArenaError('unsupported'); }
            const serial = this.#issue(encoding);
            this.#reset();
            while (!this.#complete(serial)) await this.#nextPoll(signal);
            this.#usable();
            if (signal.aborted) throw new ArenaError('aborted');
            const result = new Uint8Array(bytes);
            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pack.buffer);
            gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, result);
            this.#usable();
            handedOff = true;
            return { bytes: result, lease: cpu };
        } catch (error) { if (encoding) this.#cancelEncoding(encoding); throw this.#failure(error); }
        finally {
            try { if (buffer) this.destroy(buffer); }
            finally {
                try { if (!handedOff) this.#returnCpu(cpu); }
                finally { this.#reset(); }
            }
        }
    }

    #issue(encoding: ArenaEncoding): number {
        const gl = this.#usable();
        const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        this.#healthy();
        const serial = ++this.#serial;
        this.#fences.set(serial, fence);
        this.#arena.submit(encoding, serial);
        this.#pool.finish(encoding, serial);
        const frame = this.#frames.get(encoding);
        if (frame) frame.issued = serial;
        if (!fence) {
            // Commands may already be queued. Keep an unsignallable serial charged;
            // only real context abandonment can free it, never a fake completion.
            this.#parkFenceFailure();
            throw new ArenaError('allocation');
        }
        gl.flush();
        this.#healthy();
        this.#collect();
        return serial;
    }
    #complete(serial: number): boolean {
        const gl = this.#healthy();
        count(serial);
        if (serial > this.#serial) throw new ArenaError('invalid-input');
        if (serial <= this.#completedSerial) return true;
        const fence = this.#fences.get(serial);
        if (fence === null) return false;
        if (fence === undefined) throw new ArenaError('invalid-resource');
        const result = gl.clientWaitSync(fence, 0, 0);
        if (result === gl.WAIT_FAILED) {
            this.#healthy();
            gl.deleteSync(fence);
            this.#fences.set(serial, null);
            this.#parkFenceFailure();
            throw new ArenaError('allocation');
        }
        if (result !== gl.ALREADY_SIGNALED && result !== gl.CONDITION_SATISFIED) return false;
        this.#completedSerial = serial;
        for (const [id, sync] of this.#fences) {
            if (id <= serial) { if (sync) gl.deleteSync(sync); this.#fences.delete(id); }
        }
        return true;
    }
    #collect(): void {
        if (this.#lost) return;
        this.#arena.collect();
        if (!this.#fences.size && this.#arena.memory().retiring === 0) {
            this.#pollCancel?.();
            this.#pollCancel = null;
            if (this.#disposed) { this.#gl = null; this.#canvas = null; }
            return;
        }
        if (this.#brokenFence) { this.#pollCancel?.(); this.#pollCancel = null; return; }
        if (this.#pollCancel) return;
        this.#pollCancel = this.#services.schedulePoll(() => {
            const cancel = this.#pollCancel;
            this.#pollCancel = null;
            cancel?.();
            try {
                const latest = this.#fences.size ? this.#serial : 0;
                if (latest) this.#complete(latest);
                this.#collect();
            } catch (error) {
                const failure = this.#failure(error);
                if (failure.code !== 'lost') this.#parkFenceFailure();
                else if (!this.#disposed) this.#services.onFailure('lost');
            }
        });
    }
    #parkFenceFailure(): void {
        if (this.#brokenFence || this.#lost) return;
        this.#brokenFence = true;
        this.#pollCancel?.();
        this.#pollCancel = null;
        // Do not spin or reuse storage whose completion is unknowable. The host moves
        // to 2D and abandons the broker reservation; the abort observer above then drops
        // the ledger only after actual loss. Document/model state is never touched.
        this.#work.abort();
        for (const frame of this.#frames.values()) frame.controller?.cancel();
        if (!this.#disposed) this.#services.onFailure('allocation');
    }

    #nextPoll(signal: AbortSignal): Promise<void> {
        if (signal.aborted) return Promise.reject(new ArenaError('aborted'));
        return new Promise((resolve, reject) => {
            const abort = () => { cancel(); signal.removeEventListener('abort', abort); reject(new ArenaError('aborted')); };
            const cancel = this.#services.schedulePoll(() => { cancel(); signal.removeEventListener('abort', abort); resolve(); });
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
        });
    }
    async #task(signal: AbortSignal): Promise<void> {
        // Admission belongs to the shared scheduler. A separate task keeps the no-KHR
        // link-status fallback out of a draw callback; a hidden window cannot start it.
        do {
            await this.#nextPoll(signal);
            await new Promise<void>((resolve, reject) => {
                const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new ArenaError('aborted')); };
                const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 0);
                signal.addEventListener('abort', abort, { once: true });
                if (signal.aborted) abort();
            });
            if (signal.aborted) throw new ArenaError('aborted');
        } while (document.visibilityState === 'hidden');
    }

    #createNative<K extends ArenaResourceKind>(kind: K, descriptor: Descriptors[K]): Objects[K] {
        const gl = this.#usable();
        let object: Objects[ArenaResourceKind];
        switch (kind) {
            case 'buffer': {
                const desc = descriptor as BufferDesc;
                const buffer = gl.createBuffer();
                if (!buffer) throw new ArenaError('allocation');
                let indexLease: ByteLease | null = null;
                try {
                    let indices: Webgl2IndexMirror | null = null;
                    if (desc.uses.includes('index')) {
                        indexLease = this.#reserve(this.#services.cpuStaging, Webgl2IndexMirror.bytes(desc.bytes), false);
                        indices = new Webgl2IndexMirror(desc.bytes);
                    }
                    const target = desc.pack ? gl.PIXEL_PACK_BUFFER : gl.COPY_WRITE_BUFFER;
                    gl.bindBuffer(target, buffer);
                    gl.bufferData(target, desc.bytes, desc.pack ? gl.STREAM_READ : gl.DYNAMIC_DRAW);
                    if (gl.getBufferParameter(target, gl.BUFFER_SIZE) !== desc.bytes) throw new ArenaError('allocation');
                    const native: NativeBuffer = { buffer, bytes: desc.bytes, uses: new Set(desc.uses), pack: !!desc.pack,
                        indices, indexLease };
                    if (indices) this.#indexBuffers.add(native);
                    object = native;
                } catch (error) { if (indexLease) this.#returnCpu(indexLease); if (!gl.isContextLost()) gl.deleteBuffer(buffer); throw error; }
                break;
            }
            case 'texture': {
                const desc = descriptor as TextureDesc;
                if ('reference' in desc) {
                    object = { ...this.#arena.validate(desc.reference, 'texture'), reference: desc.reference };
                    break;
                }
                const texture = gl.createTexture();
                if (!texture) throw new ArenaError('allocation');
                try {
                    gl.bindTexture(gl.TEXTURE_2D, texture);
                    gl.texStorage2D(gl.TEXTURE_2D, 1, desc.format === 'rgba8' ? gl.RGBA8 : gl.R8, desc.width, desc.height);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                    // Allocation only, never per draw: refuse OOM before publishing a texture.
                    if (gl.getError() !== gl.NO_ERROR) { this.#healthy(); throw new ArenaError('allocation'); }
                    object = { ...desc, texture };
                } catch (error) { if (!gl.isContextLost()) gl.deleteTexture(texture); throw error; }
                break;
            }
            case 'sampler': {
                const desc = descriptor as SamplerDesc;
                if ('reference' in desc) {
                    object = { sampler: this.#arena.validate(desc.reference, 'sampler').sampler, reference: desc.reference };
                    break;
                }
                const filter = desc.filter;
                const sampler = gl.createSampler();
                if (!sampler) throw new ArenaError('allocation');
                try {
                    gl.samplerParameteri(sampler, gl.TEXTURE_MIN_FILTER, filter === 'nearest' ? gl.NEAREST : gl.LINEAR);
                    gl.samplerParameteri(sampler, gl.TEXTURE_MAG_FILTER, filter === 'nearest' ? gl.NEAREST : gl.LINEAR);
                    gl.samplerParameteri(sampler, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                    gl.samplerParameteri(sampler, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                    object = { sampler };
                } catch (error) { if (!gl.isContextLost()) gl.deleteSampler(sampler); throw error; }
                break;
            }
            case 'target': object = this.#createTarget(descriptor as TargetDesc); break;
            case 'clip': {
                const desc = descriptor as Descriptors['clip'];
                object = { ...desc, texture: this.#arena.validate(desc.mask, 'texture'), releaseDependency: this.#pool.retainDependency(desc.mask) };
                break;
            }
            case 'pipeline': {
                const desc = descriptor as PipelineCreate;
                if (desc.role === 'program') object = this.#compile(desc.shader);
                else {
                    const pipeline: NativePipeline = { ...desc, vao: null, vertexBindings: null, buffers: new Set() };
                    this.#pipelines.add(pipeline);
                    object = pipeline;
                }
                break;
            }
            default: throw new ArenaError('invalid-input');
        }
        return object as Objects[K];
    }
    #createTarget(desc: TargetDesc): NativeTarget {
        const gl = this.#usable();
        const texture = this.#arena.validate(desc.color, 'texture');
        if ('reference' in desc) {
            const source = this.#arena.validate(desc.reference, 'target');
            return { ...source, color: desc.color, colorTexture: texture, reference: desc.reference,
                capture: desc.purpose === 'capture', releaseDependency: undefined, colorStored: false, stencilStored: false };
        }
        this.#targetBytes(texture, desc.samples, desc.stencil);
        const framebuffer = gl.createFramebuffer();
        if (!framebuffer) throw new ArenaError('allocation');
        const target: NativeTarget = { ...desc, colorTexture: texture, capture: false, framebuffer, resolveFramebuffer: framebuffer,
            releaseDependency: this.#pool.retainDependency(desc.color), multisample: null, depthStencil: null,
            width: texture.width, height: texture.height, format: texture.format, colorStored: false, stencilStored: false };
        try {
            gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
            if (desc.samples === 4) {
                target.multisample = gl.createRenderbuffer();
                if (!target.multisample) throw new ArenaError('allocation');
                gl.bindRenderbuffer(gl.RENDERBUFFER, target.multisample);
                gl.renderbufferStorageMultisample(gl.RENDERBUFFER, 4, texture.format === 'rgba8' ? gl.RGBA8 : gl.R8, texture.width, texture.height);
                gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, target.multisample);
            } else gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture.texture, 0);
            if (desc.stencil) {
                target.depthStencil = gl.createRenderbuffer();
                if (!target.depthStencil) throw new ArenaError('allocation');
                gl.bindRenderbuffer(gl.RENDERBUFFER, target.depthStencil);
                if (desc.samples === 4) gl.renderbufferStorageMultisample(gl.RENDERBUFFER, 4, gl.DEPTH24_STENCIL8, texture.width, texture.height);
                else gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, texture.width, texture.height);
                gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, target.depthStencil);
            }
            if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new ArenaError('unsupported');
            if (desc.samples === 4) {
                const resolve = gl.createFramebuffer();
                if (!resolve) throw new ArenaError('allocation');
                target.resolveFramebuffer = resolve;
                gl.bindFramebuffer(gl.FRAMEBUFFER, resolve);
                gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture.texture, 0);
                if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new ArenaError('unsupported');
            }
            return target;
        } catch (error) { if (!gl.isContextLost()) this.#deleteTarget(target); throw error; }
    }
    #compile(shader: ShaderModule): NativeProgram {
        const gl = this.#usable();
        const program = gl.createProgram();
        if (!program) throw new ArenaError('allocation');
        const native: NativeProgram = { role: 'program', program, vertex: null, fragment: null, layout: shader.layout, linked: false };
        try {
            native.vertex = gl.createShader(gl.VERTEX_SHADER);
            native.fragment = gl.createShader(gl.FRAGMENT_SHADER);
            if (!native.vertex || !native.fragment) throw new ArenaError('allocation');
            gl.shaderSource(native.vertex, shader.glsl.vertex);
            gl.shaderSource(native.fragment, shader.glsl.fragment);
            gl.compileShader(native.vertex);
            gl.compileShader(native.fragment);
            gl.attachShader(program, native.vertex);
            gl.attachShader(program, native.fragment);
            gl.linkProgram(program);
            return native;
        } catch (error) {
            if (!gl.isContextLost()) { this.#dropShaders(native); gl.deleteProgram(program); }
            throw error;
        }
    }
    #dropShaders(program: NativeProgram): void {
        const gl = this.#healthy();
        if (program.vertex) { gl.detachShader(program.program, program.vertex); gl.deleteShader(program.vertex); program.vertex = null; }
        if (program.fragment) { gl.detachShader(program.program, program.fragment); gl.deleteShader(program.fragment); program.fragment = null; }
    }
    #deleteTarget(target: NativeTarget): void {
        const gl = this.#healthy();
        if (!target.reference) {
            gl.deleteFramebuffer(target.framebuffer);
            if (target.resolveFramebuffer !== target.framebuffer) gl.deleteFramebuffer(target.resolveFramebuffer);
        }
        target.releaseDependency?.();
        target.releaseDependency = undefined;
        if (target.multisample && !target.reference) gl.deleteRenderbuffer(target.multisample);
        if (target.depthStencil && !target.reference) gl.deleteRenderbuffer(target.depthStencil);
    }
    #destroyNative<K extends ArenaResourceKind>(kind: K, object: Objects[K]): void {
        const gl = this.#healthy();
        switch (kind) {
            case 'buffer': {
                const buffer = object as NativeBuffer;
                this.#detachBuffer(buffer.buffer);
                this.#dropIndexData(buffer);
                gl.deleteBuffer(buffer.buffer);
                break;
            }
            case 'texture': {
                const texture = object as NativeTexture;
                if (!texture.reference) gl.deleteTexture(texture.texture);
                break;
            }
            case 'sampler': {
                const sampler = object as Objects['sampler'];
                if (!sampler.reference) gl.deleteSampler(sampler.sampler);
                break;
            }
            case 'target': this.#deleteTarget(object as NativeTarget); break;
            case 'pipeline': {
                const pipeline = object as Objects['pipeline'];
                if (pipeline.role === 'program') { this.#dropShaders(pipeline); gl.deleteProgram(pipeline.program); }
                else {
                    if (pipeline.vao) gl.deleteVertexArray(pipeline.vao);
                    pipeline.vao = null;
                    pipeline.buffers.clear();
                    this.#pipelines.delete(pipeline);
                }
                break;
            }
            case 'clip': (object as NativeClip).releaseDependency?.(); break;
        }
    }

    /** Known backend baseline, never reconstructed with getParameter (design:276–277).
     * Touched binding sets are bounded by device limits; cached VAOs never keep a deleted buffer alive.
     */
    #reset(): void {
        const gl = this.#gl;
        if (!gl || this.#lost || gl.isContextLost()) return;
        gl.bindBuffer(gl.COPY_WRITE_BUFFER, null);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
        for (const binding of this.#uniformUnits) gl.bindBufferBase(gl.UNIFORM_BUFFER, binding, null);
        this.#uniformUnits.clear();
        for (const binding of this.#textureUnits) {
            gl.activeTexture(gl.TEXTURE0 + binding);
            gl.bindTexture(gl.TEXTURE_2D, null);
            gl.bindSampler(binding, null);
        }
        this.#textureUnits.clear();
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.bindSampler(0, null);
        gl.bindRenderbuffer(gl.RENDERBUFFER, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.useProgram(null);
        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
        gl.disable(gl.BLEND);
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFunc(gl.ONE, gl.ZERO);
        gl.disable(gl.SCISSOR_TEST);
        gl.disable(gl.DEPTH_TEST);
        gl.depthMask(false);
        gl.disable(gl.STENCIL_TEST);
        gl.stencilFunc(gl.ALWAYS, 0, 0);
        gl.stencilMask(0);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
        gl.clearStencil(0);
        gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
        gl.colorMask(true, true, true, true);
        gl.clearColor(0, 0, 0, 0);
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        gl.pixelStorei(gl.PACK_ALIGNMENT, 4);
        gl.pixelStorei(gl.PACK_ROW_LENGTH, 0);
        gl.pixelStorei(gl.PACK_SKIP_PIXELS, 0);
        gl.pixelStorei(gl.PACK_SKIP_ROWS, 0);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
        gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT, 0);
        gl.pixelStorei(gl.UNPACK_SKIP_IMAGES, 0);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    }
}
