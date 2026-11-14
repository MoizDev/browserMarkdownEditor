import { RENDER_CONSTANTS } from '../constants';
import { ArenaError, ResourceArena } from '../resourceArena';
import type { ArenaEncoding, ArenaResourceMap, ResourceArenaBackend } from '../resourceArena';
import type { MemoryAllocator } from '../memoryGovernor';
import type { BufferHandle, ByteLease, Handle, TargetHandle, TextureHandle } from './api';

interface Descriptors extends ArenaResourceMap {
    texture: { width: number; height: number };
    target: { texture: WebGLTexture };
    buffer: Record<string, never>;
}
interface Objects extends ArenaResourceMap {
    texture: WebGLTexture;
    target: WebGLFramebuffer;
    buffer: WebGLBuffer;
}
interface Level { texture: TextureHandle; target: TargetHandle; width: number; height: number }
interface Allocation { width: number; height: number; lease: ByteLease; levels: Level[]; packs: BufferHandle[]; handles: Handle[] }

export interface Webgl2CoverageResourcesOptions {
    generation: number;
    gl: () => WebGL2RenderingContext;
    memory: MemoryAllocator;
    completed: (serial: number) => boolean;
    schedulePoll: (callback: () => void) => () => void;
    reset: () => void;
}

/** Private benchmark storage; its leases remain fenced until submitted work retires. */
export class Webgl2CoverageResources {
    readonly #arena: ResourceArena<Descriptors, Objects>;
    readonly #retired = new Set<ByteLease>();
    #allocation: Allocation | null = null;
    #cancelPoll: (() => void) | null = null;
    #closed = false;

    constructor(private readonly options: Webgl2CoverageResourcesOptions) {
        const backend: ResourceArenaBackend<Descriptors, Objects> = {
            create: (kind, descriptor) => {
                const gl = options.gl();
                try {
                    if (kind === 'texture') {
                        const { width, height } = descriptor as Descriptors['texture'];
                        const texture = gl.createTexture();
                        if (!texture) throw new ArenaError('allocation');
                        try {
                            gl.bindTexture(gl.TEXTURE_2D, texture);
                            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
                            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
                            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                            gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32UI, width, height);
                            if (gl.getError() !== gl.NO_ERROR) throw new ArenaError('allocation');
                            return texture as Objects[typeof kind];
                        } catch (error) { gl.deleteTexture(texture); throw error; }
                    }
                    if (kind === 'target') {
                        const framebuffer = gl.createFramebuffer();
                        if (!framebuffer) throw new ArenaError('allocation');
                        try {
                            gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
                            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, (descriptor as Descriptors['target']).texture, 0);
                            if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new ArenaError('unsupported');
                            return framebuffer as Objects[typeof kind];
                        } catch (error) { gl.deleteFramebuffer(framebuffer); throw error; }
                    }
                    if (kind === 'buffer') {
                        const buffer = gl.createBuffer();
                        if (!buffer) throw new ArenaError('allocation');
                        try {
                            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
                            gl.bufferData(gl.PIXEL_PACK_BUFFER, 16, gl.STREAM_READ);
                            if (gl.getError() !== gl.NO_ERROR) throw new ArenaError('allocation');
                            return buffer as Objects[typeof kind];
                        } catch (error) { gl.deleteBuffer(buffer); throw error; }
                    }
                    throw new ArenaError('unsupported');
                } finally { options.reset(); }
            },
            destroy: (kind, object) => {
                const gl = options.gl();
                try {
                    if (kind === 'texture') gl.deleteTexture(object as WebGLTexture);
                    else if (kind === 'target') gl.deleteFramebuffer(object as WebGLFramebuffer);
                    else if (kind === 'buffer') gl.deleteBuffer(object as WebGLBuffer);
                    else throw new ArenaError('unsupported');
                } finally { options.reset(); }
            },
            completed: options.completed,
        };
        this.#arena = new ResourceArena({ generation: options.generation, backend, releaseLease: lease => options.memory.release(lease) });
    }

    prepare(width: number, height: number): boolean {
        if (this.#closed || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 ||
            width > RENDER_CONSTANTS.maxSurfaceAxisPixels || height > RENDER_CONSTANTS.maxSurfaceAxisPixels ||
            width * height > RENDER_CONSTANTS.maxSurfacePixels) return false;
        if (this.#allocation?.width === width && this.#allocation.height === height) return true;
        const sizes: Array<{ width: number; height: number }> = [];
        let w = width, h = height, bytes = 8 * 16;
        do {
            w = Math.ceil(w / 16); h = Math.ceil(h / 16);
            sizes.push({ width: w, height: h });
            bytes += w * h * 16;
        } while (w > 1 || h > 1);
        if (!Number.isSafeInteger(bytes)) return false;
        const lease = this.options.memory.reserve(bytes);
        if (!lease) return false;
        const next: Allocation = { width, height, lease, levels: [], packs: [], handles: [] };
        try {
            for (const size of sizes) {
                const texture = this.#arena.create('texture', size, size.width * size.height * 16, lease);
                next.handles.push(texture);
                const target = this.#arena.create('target', { texture: this.#arena.validate(texture, 'texture') }, 0, lease, [texture]);
                next.handles.push(target);
                next.levels.push({ texture, target, ...size });
            }
            for (let i = 0; i < 8; i++) {
                const pack = this.#arena.create('buffer', {}, 16, lease);
                next.handles.push(pack); next.packs.push(pack);
            }
        } catch {
            this.#retire(next);
            return false;
        }
        const previous = this.#allocation;
        this.#allocation = next;
        if (previous) this.#retire(previous);
        return true;
    }

    begin(): ArenaEncoding {
        if (this.#closed || !this.#allocation) throw new ArenaError('invalid-resource');
        return this.#arena.beginEncoding();
    }

    levels(encoding: ArenaEncoding): readonly { texture: WebGLTexture; framebuffer: WebGLFramebuffer; width: number; height: number }[] {
        if (!this.#allocation || this.#closed) throw new ArenaError('invalid-resource');
        return this.#allocation.levels.map(level => ({ texture: this.#arena.pin(encoding, level.texture, 'texture'),
            framebuffer: this.#arena.pin(encoding, level.target, 'target'), width: level.width, height: level.height }));
    }

    pack(encoding: ArenaEncoding, index: number): WebGLBuffer {
        if (!this.#allocation || this.#closed || !Number.isInteger(index) || index < 0 || index >= 8) throw new ArenaError('invalid-resource');
        return this.#arena.pin(encoding, this.#allocation.packs[index], 'buffer');
    }

    submit(encoding: ArenaEncoding, serial: number): void { this.#arena.submit(encoding, serial); this.#collect(); }
    cancel(encoding: ArenaEncoding): void { this.#arena.cancel(encoding); this.#collect(); }

    dispose(): void {
        if (this.#closed) return;
        this.#closed = true;
        if (this.#allocation) { this.#retire(this.#allocation); this.#allocation = null; }
        this.#arena.releaseAll('hidden');
        this.#collect();
    }

    abandon(): void {
        if (this.#allocation) { this.#arena.closeLease(this.#allocation.lease); this.#allocation = null; }
        this.#closed = true;
        this.#cancelPoll?.(); this.#cancelPoll = null;
        this.#arena.abandon();
        this.#retired.clear();
    }

    #retire(allocation: Allocation): void {
        for (const handle of allocation.handles) this.#arena.release(handle);
        this.#arena.closeLease(allocation.lease);
        this.#retired.add(allocation.lease);
        this.#collect();
    }

    #collect(): void {
        this.#arena.collect();
        for (const lease of this.#retired) if (this.#arena.leaseMemory(lease).returned) this.#retired.delete(lease);
        if (this.#retired.size && !this.#cancelPoll) {
            this.#cancelPoll = this.options.schedulePoll(() => {
                this.#collect();
                if (!this.#retired.size) { this.#cancelPoll?.(); this.#cancelPoll = null; }
            });
        }
    }
}
