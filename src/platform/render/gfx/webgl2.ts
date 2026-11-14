import type {
    BitmapUpload, BufferHandle, BufferUse, ByteLease, ClipHandle, GfxDevice, GfxError,
    GfxLimits, Handle, PipelineDesc, PipelineHandle, PixelUpload, RectI, SamplerHandle,
    Samples, ShaderLayout, ShaderModule, TargetHandle, TextureFormat, TextureHandle, TextureUse,
} from './api';
import { RENDER_CONSTANTS } from '../constants';
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

/** Part 1 intentionally has no encoder stub. Part 2 will expose the full GfxDevice. */
export type Webgl2Resources = Omit<GfxDevice, 'beginFrame'>;

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
    onFailure(code: GfxError): void;
}

/** Platform-internal owner only; layers never receive an arena or raw GL (design:88). */
export interface Webgl2Owner extends BrokerGpuOwner {
    readonly resources: Webgl2Resources;
    closeLease(lease: ByteLease): void;
    memory(): ArenaMemory;
    leaseMemory(lease: ByteLease): ArenaLeaseMemory;
    cpuStagingMemory(): ArenaMemory;
}

type BufferDesc = { bytes: number; uses: readonly BufferUse[]; pack?: boolean };
type TextureDesc = { width: number; height: number; format: TextureFormat; uses: readonly TextureUse[] };
type TargetDesc = { color: TextureHandle; samples: Samples; stencil: boolean };
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
interface NativeBuffer { buffer: WebGLBuffer; bytes: number; uses: ReadonlySet<BufferUse>; pack: boolean; }
interface NativeTexture extends TextureDesc { texture: WebGLTexture; }
interface NativeTarget extends TargetDesc {
    framebuffer: WebGLFramebuffer;
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
interface NativePipeline { role: 'pipeline'; program: PipelineHandle; descriptor: PipelineDesc; }
interface Objects {
    buffer: NativeBuffer;
    texture: NativeTexture;
    target: NativeTarget;
    sampler: { sampler: WebGLSampler; reference?: SamplerHandle };
    clip: { mask: TextureHandle; bounds: RectI };
    pipeline: NativeProgram | NativePipeline;
}
interface UploadTarget { texture: TextureHandle; target: TargetHandle; width: number; height: number; serial: number; }
interface RawRead { bytes: Uint8Array<ArrayBuffer>; lease: ByteLease; }

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

class Webgl2Device implements Webgl2Resources, Webgl2Owner {
    readonly backend = 'webgl2' as const;
    readonly generation: number;
    readonly limits: GfxLimits;
    readonly resources: Webgl2Resources = this;
    readonly #services: Webgl2Services;
    readonly #arena: ResourceArena<Descriptors, Objects>;
    readonly #parallel: KHR_parallel_shader_compile | null;
    readonly #sampleCounts = new Map<number, ReadonlySet<number>>();
    readonly #uniformBindings: number;
    readonly #maxAttributes: number;
    readonly #handles = new Set<Handle>();
    readonly #ownedLeases = new Map<ByteLease, MemoryAllocator>();
    readonly #cpuLeases = new Map<ByteLease, number>();
    #cpuBytes = 0;
    readonly #programs = new Map<string, Promise<PipelineHandle>>();
    readonly #programSignatures = new Map<string, string>();
    readonly #samplers = new Map<'nearest' | 'linear', SamplerHandle>();
    readonly #attachments = new Map<TextureHandle, TargetHandle>();
    readonly #uploadPool: UploadTarget[] = [];
    readonly #fences = new Map<number, WebGLSync>();
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
        this.#reset();
    }

    createBuffer(bytes: number, uses: readonly BufferUse[], lease: ByteLease): BufferHandle {
        this.#usable();
        count(bytes);
        const checked = uniqueUses(uses, ['vertex', 'index', 'uniform', 'copy-src', 'copy-dst']);
        return this.#allocate('buffer', { bytes, uses: checked }, bytes, lease);
    }

    writeBuffer(dst: BufferHandle, offset: number, src: ArrayBufferView): void {
        const gl = this.#usable();
        const buffer = this.#arena.validate(dst, 'buffer');
        count(offset);
        if (!buffer.uses.has('copy-dst') || offset > buffer.bytes - src.byteLength) throw new ArenaError('invalid-input');
        if (!src.byteLength) return;
        const encoding = this.#arena.beginEncoding();
        try {
            this.#arena.pin(encoding, dst, 'buffer');
            gl.bindBuffer(gl.COPY_WRITE_BUFFER, buffer.buffer);
            gl.bufferSubData(gl.COPY_WRITE_BUFFER, offset, src);
            this.#issue(encoding);
        } catch (error) {
            this.#arena.cancel(encoding);
            throw this.#failure(error);
        } finally { this.#reset(); }
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
        const texture = this.#arena.validate(dst, 'texture');
        rectangle(rect, texture.width, texture.height);
        if (!texture.uses.includes('copy-dst') || src.premultiplied !== true || src.colorSpace !== 'srgb' || src.origin !== 'top-left') {
            throw new ArenaError('invalid-input');
        }
        if (!rect.width || !rect.height) return;
        const encoding = this.#arena.beginEncoding();
        let cpu: ByteLease | null = null;
        try {
            this.#arena.pin(encoding, dst, 'texture');
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
                this.#issue(encoding);
            } else {
                if (src.source.width !== rect.width || src.source.height !== rect.height) throw new ArenaError('invalid-input');
                const staging = this.#uploadTarget(rect.width, rect.height);
                const stageTexture = this.#arena.pin(encoding, staging.texture, 'texture');
                const stageTarget = this.#arena.pin(encoding, staging.target, 'target');
                const dest = this.#arena.pin(encoding, this.#attachment(dst), 'target');
                gl.bindTexture(gl.TEXTURE_2D, stageTexture.texture);
                gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, src.source);
                gl.bindFramebuffer(gl.READ_FRAMEBUFFER, stageTarget.framebuffer);
                gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dest.framebuffer);
                gl.blitFramebuffer(0, 0, rect.width, rect.height, rect.x, texture.height - rect.y,
                    rect.x + rect.width, texture.height - rect.y - rect.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
                staging.serial = this.#issue(encoding);
            }
            this.#usable(); // Upload is not publication after generation loss (design:771).
        } catch (error) {
            this.#arena.cancel(encoding);
            throw this.#failure(error);
        } finally {
            if (cpu) this.#returnCpu(cpu);
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
        return this.#owned('clip', { mask, bounds: { ...deviceBounds } }, 0, this.#services.working, [mask]);
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
        const handle = this.#allocate('target', { color, samples: options.samples, stencil: options.stencil }, bytes, lease, [color]);
        if (options.stencil) {
            const gl = this.#usable();
            const encoding = this.#arena.beginEncoding();
            try {
                const target = this.#arena.pin(encoding, handle, 'target');
                gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
                gl.disable(gl.SCISSOR_TEST);
                gl.stencilMask(255);
                gl.clearStencil(0);
                gl.clear(gl.STENCIL_BUFFER_BIT);
                this.#issue(encoding);
            } catch (error) {
                this.#arena.cancel(encoding);
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
        this.#work.abort();
        this.#work = new AbortController();
        this.#paused = reason === 'hidden';
        this.#arena.releaseAll(reason);
        for (const handle of this.#handles) {
            if ('kind' in handle && handle.kind !== 'pipeline' && handle.kind !== 'sampler') this.#handles.delete(handle);
        }
        this.#attachments.clear();
        this.#uploadPool.length = 0;
        this.#reset();
        this.#collect();
    }

    dispose(reason: ContextDisposeReason): void {
        if (this.#disposed) return;
        this.#disposed = true;
        if (reason === 'context-lost' || this.#lost || this.#gl?.isContextLost()) { this.abandon(); return; }
        this.#work.abort();
        this.#arena.releaseAll('hidden');
        for (const handle of this.#handles) this.#arena.release(handle);
        this.#handles.clear();
        this.#programs.clear();
        this.#programSignatures.clear();
        this.#samplers.clear();
        this.#attachments.clear();
        this.#uploadPool.length = 0;
        this.#collect();
    }

    abandon(): void {
        if (this.#lost) return;
        this.#lost = true;
        this.#work.abort();
        this.#pollCancel?.();
        this.#pollCancel = null;
        this.#fences.clear();
        this.#handles.clear();
        this.#programs.clear();
        this.#programSignatures.clear();
        this.#samplers.clear();
        this.#attachments.clear();
        this.#uploadPool.length = 0;
        this.#arena.abandon();
        this.#gl = null;
        this.#canvas = null;
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
                const output = this.#arena.pin(encoding, target, 'target');
                this.#arena.pin(encoding, programHandle, 'pipeline');
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
            } catch (error) { this.#arena.cancel(encoding); throw this.#failure(error); }
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

    #healthy(): WebGL2RenderingContext {
        if (this.#lost || !this.#gl) throw new ArenaError(this.#lost ? 'lost' : 'aborted');
        if (this.#gl.isContextLost()) { this.abandon(); throw new ArenaError('lost'); }
        return this.#gl;
    }
    #usable(): WebGL2RenderingContext {
        const gl = this.#healthy();
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
        const handle = this.#owned('target', { color: texture, samples: 1, stencil: false }, 0, this.#services.working, [texture]);
        this.#attachments.set(texture, handle);
        return handle;
    }
    #uploadTarget(width: number, height: number): UploadTarget {
        for (const target of this.#uploadPool) {
            if (target.width >= width && target.height >= height && this.#complete(target.serial)) return target;
        }
        const cap = this.limits.maxRenderTargetSize;
        const w = Math.min(cap, Math.ceil(width / 64) * 64);
        const h = Math.min(cap, Math.ceil(height / 64) * 64);
        this.#extent(width, height, cap);
        const lease = this.#reserve(this.#services.gpuStaging, byteSize(w, h, 4));
        let texture: TextureHandle | null = null;
        try {
            texture = this.createTexture(w, h, 'rgba8', ['render', 'copy-src', 'copy-dst'], lease);
            const target = this.createTarget(texture, { samples: 1, stencil: false }, lease);
            const pooled = { texture, target, width: w, height: h, serial: 0 };
            this.#uploadPool.push(pooled);
            return pooled;
        } catch (error) { if (texture) this.destroy(texture); throw this.#failure(error); }
        finally { this.closeLease(lease); }
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
            const pack = this.#arena.pin(encoding, buffer, 'buffer');
            const target = this.#arena.pin(encoding, this.#attachment(src), 'target');
            this.#arena.pin(encoding, src, 'texture');
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
        } catch (error) { if (encoding) this.#arena.cancel(encoding); throw this.#failure(error); }
        finally {
            if (buffer) this.destroy(buffer);
            if (!handedOff) this.#returnCpu(cpu);
            this.#reset();
        }
    }

    #issue(encoding: ArenaEncoding): number {
        const gl = this.#usable();
        const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        if (!fence) { this.#healthy(); throw new ArenaError('allocation'); }
        const serial = ++this.#serial;
        this.#fences.set(serial, fence);
        this.#arena.submit(encoding, serial);
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
        if (!fence) throw new ArenaError('invalid-resource');
        const result = gl.clientWaitSync(fence, 0, 0);
        if (result === gl.WAIT_FAILED) { this.#healthy(); throw new ArenaError('allocation'); }
        if (result !== gl.ALREADY_SIGNALED && result !== gl.CONDITION_SATISFIED) return false;
        this.#completedSerial = serial;
        for (const [id, sync] of this.#fences) {
            if (id <= serial) { gl.deleteSync(sync); this.#fences.delete(id); }
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
                this.abandon();
                // Broker-owned intentional disposal also loses its context; never surface
                // that expected retirement as a failure on a closed or replaced view.
                if (!this.#disposed) this.#services.onFailure(error instanceof ArenaError ? error.code : 'allocation');
            }
        });
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
                try {
                    const target = desc.pack ? gl.PIXEL_PACK_BUFFER : gl.COPY_WRITE_BUFFER;
                    gl.bindBuffer(target, buffer);
                    gl.bufferData(target, desc.bytes, desc.pack ? gl.STREAM_READ : gl.DYNAMIC_DRAW);
                    if (gl.getBufferParameter(target, gl.BUFFER_SIZE) !== desc.bytes) throw new ArenaError('allocation');
                    object = { buffer, bytes: desc.bytes, uses: new Set(desc.uses), pack: !!desc.pack };
                } catch (error) { if (!gl.isContextLost()) gl.deleteBuffer(buffer); throw error; }
                break;
            }
            case 'texture': {
                const desc = descriptor as TextureDesc;
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
            case 'clip': object = descriptor as Objects['clip']; break;
            case 'pipeline': {
                const desc = descriptor as PipelineCreate;
                object = desc.role === 'program' ? this.#compile(desc.shader) : { ...desc };
                break;
            }
            default: throw new ArenaError('invalid-input');
        }
        return object as Objects[K];
    }
    #createTarget(desc: TargetDesc): NativeTarget {
        const gl = this.#usable();
        const texture = this.#arena.validate(desc.color, 'texture');
        this.#targetBytes(texture, desc.samples, desc.stencil);
        const framebuffer = gl.createFramebuffer();
        if (!framebuffer) throw new ArenaError('allocation');
        const target: NativeTarget = { ...desc, framebuffer, multisample: null, depthStencil: null,
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
        gl.deleteFramebuffer(target.framebuffer);
        if (target.multisample) gl.deleteRenderbuffer(target.multisample);
        if (target.depthStencil) gl.deleteRenderbuffer(target.depthStencil);
    }
    #destroyNative<K extends ArenaResourceKind>(kind: K, object: Objects[K]): void {
        const gl = this.#healthy();
        switch (kind) {
            case 'buffer': gl.deleteBuffer((object as NativeBuffer).buffer); break;
            case 'texture': gl.deleteTexture((object as NativeTexture).texture); break;
            case 'sampler': {
                const sampler = object as Objects['sampler'];
                if (!sampler.reference) gl.deleteSampler(sampler.sampler);
                break;
            }
            case 'target': this.#deleteTarget(object as NativeTarget); break;
            case 'pipeline': {
                const pipeline = object as Objects['pipeline'];
                if (pipeline.role === 'program') { this.#dropShaders(pipeline); gl.deleteProgram(pipeline.program); }
                break;
            }
            case 'clip': break;
        }
    }

    /** Known backend baseline, never reconstructed with getParameter (design:276–277).
     * Helpers reset only state they can touch. Pass/draw state caching follows in part 2.
     */
    #reset(): void {
        const gl = this.#gl;
        if (!gl || this.#lost || gl.isContextLost()) return;
        gl.bindBuffer(gl.COPY_WRITE_BUFFER, null);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.bindSampler(0, null);
        gl.bindRenderbuffer(gl.RENDERBUFFER, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.useProgram(null);
        gl.bindVertexArray(null);
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
