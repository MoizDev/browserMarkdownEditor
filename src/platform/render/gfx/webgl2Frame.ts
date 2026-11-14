import type {
    BufferHandle, BufferSlice, ClipHandle, ClipToken, DrawCommand, FrameEncoder, GpuPass,
    GroupToken, PassDesc, PipelineDesc, PipelineHandle, RectI, RgbaP, SamplerHandle,
    Samples, Submission, TargetHandle, TargetLease, TextureFormat, TextureHandle, UniformSlice,
} from './api';
import { ArenaError } from '../resourceArena';

// Module-private implementation seam. Only webgl2.ts constructs this capability object;
// a layer receives FrameEncoder/GpuPass and never the GL context or these native records.
export interface FrameBuffer {
    readonly handle: BufferHandle;
    readonly buffer: WebGLBuffer;
    readonly bytes: number;
    readonly uses: ReadonlySet<string>;
    maxIndex(offset: number, count: number, format: 'uint16' | 'uint32'): number;
}
export interface FrameTexture {
    readonly handle: TextureHandle;
    readonly texture: WebGLTexture;
    readonly width: number;
    readonly height: number;
    readonly format: TextureFormat;
    readonly uses: readonly string[];
    readonly usedRect: RectI;
}
export interface FrameTarget {
    readonly handle: TargetHandle | 'surface';
    readonly framebuffer: WebGLFramebuffer | null;
    readonly resolveFramebuffer: WebGLFramebuffer | null;
    readonly width: number;
    readonly height: number;
    readonly format: TextureFormat;
    readonly samples: Samples;
    readonly stencil: boolean;
    readonly capture: boolean;
    readonly usedRect: RectI;
    readonly color: FrameTexture | null;
    readonly retained: { colorStored: boolean; stencilStored: boolean };
}
export interface FrameSampler { readonly sampler: WebGLSampler; }
export interface FramePipeline {
    readonly descriptor: PipelineDesc;
    draw(command: EncodedDraw, context: DrawContext): void;
}
export interface DrawContext {
    readonly target: FrameTarget;
    readonly viewport: RectI;
    readonly originX: number;
    readonly originY: number;
}
export interface EncodedDraw {
    readonly pipeline: FramePipeline;
    readonly uniforms: readonly { binding: number; buffer: FrameBuffer; offset: number; bytes: number }[];
    readonly textures: readonly { binding: number; texture: FrameTexture; sampler: FrameSampler }[];
    readonly vertices: readonly { buffer: FrameBuffer; slice: BufferSlice }[];
    readonly index: { buffer: FrameBuffer; offset: number; format: 'uint16' | 'uint32' } | null;
    readonly first: number;
    readonly count: number;
    readonly instances: number;
    readonly scissor: RectI;
}
export interface TargetRequest {
    width: number;
    height: number;
    samples: Samples;
    format?: TextureFormat;
    stencil: boolean;
    purpose: 'mask' | 'group' | 'scene-cache' | 'capture';
}
export interface QuadCommand {
    readonly context: DrawContext;
    readonly source: FrameTexture;
    readonly backdrop: FrameTexture;
    readonly mask: FrameTexture;
    readonly uniforms: { buffer: FrameBuffer; slice: UniformSlice };
    readonly scissor: RectI;
    readonly blend: 'source-over' | 'replace' | 'mask-max';
}
export interface FrameBackend {
    readonly signal: AbortSignal;
    readonly uniformAlignment: number;
    readonly maxViewport: readonly [number, number];
    gl(): WebGL2RenderingContext;
    healthy(): void;
    reset(): void;
    buffer(handle: BufferHandle): FrameBuffer;
    texture(handle: TextureHandle): FrameTexture;
    sampler(handle: SamplerHandle): FrameSampler;
    pipeline(handle: PipelineHandle): FramePipeline;
    target(handle: TargetHandle | 'surface'): FrameTarget;
    clip(handle: ClipHandle): { mask: FrameTexture; bounds: RectI };
    attachment(texture: FrameTexture): FrameTarget;
    white(): FrameTexture;
    uniforms(bytes: ArrayBufferView): UniformSlice;
    uploadUniforms(): void;
    quad(command: QuadCommand): () => void;
    acquireTarget(request: TargetRequest): TargetLease | null;
    releaseTarget(lease: TargetLease): void;
    issue(): number;
    cancel(): void;
    finish(serial: number | null): void;
    failure(error: unknown): ArenaError;
    onPass(surface: boolean): void;
}
export interface ControlledFrame extends FrameEncoder { cancel(): void; }

interface Retention { colorStored: boolean; stencilStored: boolean; }
interface Scope extends DrawContext {
    readonly bounds: RectI;
    readonly capture: boolean;
    readonly empty: boolean;
    coverage: boolean;
}
interface Mask { texture: FrameTexture; bounds: RectI; source: RectI; }
interface Isolation {
    readonly parent: Scope;
    readonly child: Scope;
    readonly lease: TargetLease | null;
    readonly mask: Mask | null;
    readonly options: { opacity: number; blend: 'normal' | 'multiply'; colourEffect: 'none' | 'page-invert' };
}
interface ClipEntry {
    readonly token: ClipToken;
    readonly previous: RectI;
    readonly groupDepth: number;
    readonly isolation: Isolation | null;
}
interface GroupEntry {
    readonly token: GroupToken;
    readonly previous: RectI;
    readonly clipDepth: number;
    readonly isolation: Isolation;
}

function integer(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0x7fffffff) throw new ArenaError('invalid-input');
}
function rect(value: RectI): RectI {
    for (const n of [value.x, value.y, value.width, value.height]) integer(n);
    if (!Number.isSafeInteger(value.x + value.width) || !Number.isSafeInteger(value.y + value.height)) throw new ArenaError('invalid-input');
    return { ...value };
}
function intersect(a: RectI, b: RectI): RectI {
    const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
    return { x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
        height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y) };
}
function colour(value: RgbaP): void {
    if (value.length !== 4 || value.some(n => !Number.isFinite(n) || n < 0 || n > 1) ||
        value.slice(0, 3).some(n => n > value[3])) throw new ArenaError('invalid-input');
}
function opacity(value: number): void {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new ArenaError('invalid-input');
}
function slice(buffer: FrameBuffer, value: BufferSlice | UniformSlice): void {
    integer(value.offset); integer(value.bytes);
    if (value.offset > buffer.bytes - value.bytes) throw new ArenaError('invalid-input');
}
function clearDescriptor(desc: PassDesc, target: FrameTarget, retained: Retention): void {
    rect(desc.viewport);
    if (!['store', 'discard'].includes(desc.store)) throw new ArenaError('invalid-input');
    if (desc.load.kind === 'clear') colour(desc.load.color);
    else if (desc.load.kind !== 'load' || target.handle === 'surface' || !retained.colorStored) throw new ArenaError('invalid-input');
    if (target.handle === 'surface' && (desc.load.kind !== 'clear' || desc.load.color[3] !== 1 || desc.store !== 'store')) {
        throw new ArenaError('invalid-input');
    }
    if (target.stencil !== !!desc.stencil) throw new ArenaError('invalid-input');
    if (desc.stencil) {
        if (!['store', 'discard'].includes(desc.stencil.store)) throw new ArenaError('invalid-input');
        if (desc.stencil.load.kind === 'clear') {
            integer(desc.stencil.load.value);
            if (desc.stencil.load.value > 255) throw new ArenaError('invalid-input');
        } else if (desc.stencil.load.kind !== 'load' || !retained.stencilStored) throw new ArenaError('invalid-input');
    }
}

/** Record first, submit once: failed encoding cannot clear or partially replace the display (design:88, 298). */
export function createWebgl2Frame(backend: FrameBackend): ControlledFrame {
    return new DeviceFrame(backend);
}

class DeviceFrame implements ControlledFrame {
    readonly #backend: FrameBackend;
    readonly #commands: (() => void)[] = [];
    readonly #retained = new Map<FrameTarget['retained'], Retention>();
    readonly #temporaries = new Set<TargetLease>();
    #pass: DevicePass | null = null;
    #closed = false;
    #surface = false;
    #nextToken = 1;

    constructor(backend: FrameBackend) { this.#backend = backend; }

    isClosed(): boolean { return this.#closed; }
    check(): void {
        if (this.#closed || this.#backend.signal.aborted) throw new ArenaError('aborted');
        this.#backend.healthy();
    }
    guard<T>(operation: () => T): T {
        try { this.check(); return operation(); }
        catch (error) {
            let failure = error;
            try { this.cancel(); } catch (cleanup) { failure = cleanup; }
            throw this.#backend.failure(failure);
        }
    }
    uniforms(bytes: ArrayBufferView): UniformSlice {
        return this.guard(() => this.#backend.uniforms(bytes));
    }
    beginPass(desc: PassDesc): GpuPass {
        return this.guard(() => {
            if (this.#pass || desc.target === 'surface' && this.#surface) throw new ArenaError('invalid-input');
            const target = this.#backend.target(desc.target);
            const saved = this.retention(target);
            clearDescriptor(desc, target, saved);
            if (desc.viewport.width > this.#backend.maxViewport[0] || desc.viewport.height > this.#backend.maxViewport[1]) {
                throw new ArenaError('invalid-input');
            }
            // Opaque handles are identity tokens, not serializable descriptor data.
            const copy: PassDesc = { ...desc, viewport: { ...desc.viewport }, load: structuredClone(desc.load),
                ...(desc.stencil ? { stencil: structuredClone(desc.stencil) } : {}) };
            if (desc.target === 'surface') this.#surface = true;
            this.#backend.onPass(desc.target === 'surface');
            this.start(target, copy);
            this.#pass = new DevicePass(this, this.#backend, target, copy);
            return this.#pass;
        });
    }
    resolve(source: TargetHandle, dest: TextureHandle): void {
        this.guard(() => {
            if (this.#pass) throw new ArenaError('invalid-input');
            const src = this.#backend.target(source), dst = this.#backend.texture(dest);
            if (!this.retention(src).colorStored || src.width !== dst.width || src.height !== dst.height || src.format !== dst.format ||
                !dst.uses.includes('copy-dst') && !dst.uses.includes('render')) throw new ArenaError('invalid-input');
            if (src.samples === 1 && src.color?.texture === dst.texture) return;
            const output = src.color?.texture === dst.texture ? { ...src, framebuffer: src.resolveFramebuffer, samples: 1 as const } : this.#backend.attachment(dst);
            this.blit(src, { x: 0, y: 0, width: src.width, height: src.height }, output, 0, 0);
        });
    }
    copyTexture(source: TextureHandle, sourceRect: RectI, dest: TextureHandle, destX: number, destY: number): void {
        this.guard(() => {
            if (this.#pass) throw new ArenaError('invalid-input');
            const src = this.#backend.texture(source), dst = this.#backend.texture(dest), area = rect(sourceRect);
            integer(destX); integer(destY);
            if (!src.uses.includes('copy-src') || !dst.uses.includes('copy-dst') || src.format !== dst.format ||
                area.x > src.width - area.width || area.y > src.height - area.height ||
                destX > dst.width - area.width || destY > dst.height - area.height) throw new ArenaError('invalid-input');
            if (src.texture === dst.texture && intersect(area, { x: destX, y: destY, width: area.width, height: area.height }).width &&
                intersect(area, { x: destX, y: destY, width: area.width, height: area.height }).height) throw new ArenaError('invalid-input');
            this.blit(this.#backend.attachment(src), area, this.#backend.attachment(dst), destX, destY);
        });
    }
    submit(): Submission {
        return this.guard(() => {
            if (this.#pass) throw new ArenaError('invalid-input');
            let serial: number | null = null;
            let executing = false;
            try {
                executing = true;
                this.#backend.uploadUniforms();
                for (const command of this.#commands) command();
                serial = this.#backend.issue();
                for (const [native, state] of this.#retained) Object.assign(native, state);
                this.#closed = true;
                return { serial };
            } catch (error) {
                // A healthy partial submission still needs a fence before its pins can retire.
                for (const native of this.#retained.keys()) { native.colorStored = false; native.stencilStored = false; }
                if (executing && !this.#backend.signal.aborted) {
                    try { serial = this.#backend.issue(); } catch { /* Loss abandons the generation in the backend. */ }
                }
                throw error;
            } finally {
                this.#closed = true;
                this.#commands.length = 0;
                this.#retained.clear();
                this.#cleanup(serial, serial === null);
            }
        });
    }
    cancel(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#commands.length = 0;
        this.#retained.clear();
        this.#cleanup(null, true);
    }
    #cleanup(serial: number | null, cancel: boolean): void {
        const failures: unknown[] = [];
        if (cancel) { try { this.#backend.cancel(); } catch (error) { failures.push(error); } }
        for (const lease of this.#temporaries) {
            try { this.#backend.releaseTarget(lease); } catch (error) { failures.push(error); }
        }
        this.#temporaries.clear();
        try { this.#backend.finish(serial); } catch (error) { failures.push(error); }
        if (failures.length) throw failures[0];
    }
    command(operation: () => void): void { this.#commands.push(operation); }
    token(): number {
        if (!Number.isSafeInteger(this.#nextToken)) throw new ArenaError('allocation');
        return this.#nextToken++;
    }
    retention(target: FrameTarget): Retention {
        let value = this.#retained.get(target.retained);
        if (!value) { value = { ...target.retained }; this.#retained.set(target.retained, value); }
        return value;
    }
    start(target: FrameTarget, desc: PassDesc): void {
        this.command(() => {
            const gl = this.#backend.gl();
            try {
                gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
                gl.disable(gl.SCISSOR_TEST);
                gl.colorMask(true, true, true, true);
                let bits = 0;
                if (desc.load.kind === 'clear') { gl.clearColor(...desc.load.color); bits |= gl.COLOR_BUFFER_BIT; }
                if (desc.stencil?.load.kind === 'clear') {
                    gl.stencilMask(255);
                    gl.clearStencil(desc.stencil.load.value);
                    bits |= gl.STENCIL_BUFFER_BIT;
                }
                if (bits) gl.clear(bits);
            } finally { this.#backend.reset(); }
        });
    }
    end(target: FrameTarget, desc: PassDesc): void {
        const retained = this.retention(target);
        retained.colorStored = desc.store === 'store';
        retained.stencilStored = desc.stencil?.store === 'store';
        this.command(() => {
            const gl = this.#backend.gl();
            try {
                const discard: number[] = [];
                if (desc.store === 'discard') discard.push(gl.COLOR_ATTACHMENT0);
                if (desc.stencil?.store === 'discard') discard.push(gl.DEPTH_ATTACHMENT, gl.STENCIL_ATTACHMENT);
                if (discard.length) {
                    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
                    gl.invalidateFramebuffer(gl.FRAMEBUFFER, discard);
                }
            } finally { this.#backend.reset(); }
        });
    }
    endPass(pass: DevicePass, target: FrameTarget, desc: PassDesc): void {
        if (this.#pass !== pass) throw new ArenaError('invalid-input');
        this.end(target, desc);
        this.#pass = null;
    }
    temporary(request: TargetRequest): TargetLease {
        const lease = this.#backend.acquireTarget(request);
        if (!lease) throw new ArenaError('out-of-budget');
        this.#temporaries.add(lease);
        return lease;
    }
    releaseTemporary(lease: TargetLease): void {
        this.#temporaries.delete(lease);
        this.#backend.releaseTarget(lease);
    }
    blit(source: FrameTarget, area: RectI, dest: FrameTarget, x: number, y: number): void {
        if (!area.width || !area.height) return;
        this.command(() => {
            const gl = this.#backend.gl();
            try {
                gl.disable(gl.SCISSOR_TEST);
                gl.bindFramebuffer(gl.READ_FRAMEBUFFER, source.framebuffer);
                gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dest.framebuffer);
                gl.blitFramebuffer(area.x, source.height - area.y - area.height, area.x + area.width, source.height - area.y,
                    x, dest.height - y - area.height, x + area.width, dest.height - y, gl.COLOR_BUFFER_BIT, gl.NEAREST);
            } finally { this.#backend.reset(); }
        });
    }
    snapshot(scope: Scope, area: RectI): { lease: TargetLease; texture: FrameTexture } {
        const lease = this.temporary({ width: area.width, height: area.height, samples: 1, stencil: false,
            format: scope.target.format, purpose: 'group' });
        const output = this.#backend.target(lease.target);
        let source = scope.target;
        if (source.samples === 4) {
            if (!source.color) throw new ArenaError('invalid-resource');
            const resolve: FrameTarget = { ...source, framebuffer: source.resolveFramebuffer, samples: 1 };
            this.blit(source, { x: 0, y: 0, width: source.width, height: source.height }, resolve, 0, 0);
            source = resolve;
        }
        this.blit(source, { x: area.x - scope.originX, y: area.y - scope.originY, width: area.width, height: area.height }, output, 0, 0);
        return { lease, texture: this.#backend.texture(lease.texture) };
    }
    composite(scope: Scope, clip: RectI, source: FrameTexture, sourceRect: RectI, bounds: RectI,
        options: { opacity: number; blend: 'normal' | 'multiply'; colourEffect: 'none' | 'page-invert' }, mask: Mask | null): void {
        opacity(options.opacity);
        if (!['normal', 'multiply'].includes(options.blend) || !['none', 'page-invert'].includes(options.colourEffect) ||
            scope.capture && options.colourEffect === 'page-invert') throw new ArenaError('invalid-input');
        const area = intersect(intersect(bounds, clip), scope.bounds);
        if (scope.empty || !area.width || !area.height || options.opacity === 0) return;
        if (source.texture === scope.target.color?.texture || mask !== null && mask.texture.texture === scope.target.color?.texture) {
            throw new ArenaError('invalid-resource');
        }
        let backdrop: { lease: TargetLease; texture: FrameTexture } | null = null;
        if (options.blend === 'multiply') backdrop = this.snapshot(scope, area);
        const data = new Float32Array(32);
        data.set([scope.viewport.x, scope.viewport.y, scope.viewport.width, scope.viewport.height], 0);
        data.set([bounds.x, bounds.y, bounds.width, bounds.height], 4);
        data.set([sourceRect.x, sourceRect.y, sourceRect.width, sourceRect.height], 8);
        data.set([source.width, source.height, options.opacity, options.colourEffect === 'page-invert' ? 1 : 0], 12);
        data.set([area.x, area.y, backdrop?.texture.width ?? 1, backdrop?.texture.height ?? 1], 16);
        if (mask) {
            data.set([mask.bounds.x, mask.bounds.y, mask.bounds.width, mask.bounds.height], 20);
            data.set([mask.source.width / mask.texture.width, mask.source.height / mask.texture.height,
                mask.source.x / mask.texture.width, 1 - mask.source.y / mask.texture.height], 24);
        }
        data.set([options.blend === 'multiply' ? 1 : 0, mask ? 1 : 0, scope.coverage ? 1 : 0, 0], 28);
        const packed = this.uniforms(data);
        const command: QuadCommand = {
            context: scope, source, backdrop: backdrop?.texture ?? this.#backend.white(), mask: mask?.texture ?? this.#backend.white(),
            uniforms: { buffer: this.#backend.buffer(packed.buffer), slice: packed }, scissor: area,
            blend: options.blend === 'multiply' ? 'replace' : scope.coverage ? 'mask-max' : 'source-over',
        };
        this.command(this.#backend.quad(command));
        if (backdrop) this.releaseTemporary(backdrop.lease);
    }
}

// Logical scopes expand to sequential backend passes; masks never borrow scene stencil
// bits, and tokens are strict LIFO (rendering-design.md:284–292; vr-lead mask ruling).
class DevicePass implements GpuPass {
    readonly #frame: DeviceFrame;
    readonly #backend: FrameBackend;
    readonly #root: FrameTarget;
    readonly #desc: PassDesc;
    readonly #clips: ClipEntry[] = [];
    readonly #groups: GroupEntry[] = [];
    #scope: Scope;
    #clip: RectI;
    #closed = false;

    constructor(frame: DeviceFrame, backend: FrameBackend, target: FrameTarget, desc: PassDesc) {
        this.#frame = frame;
        this.#backend = backend;
        this.#root = target;
        this.#desc = desc;
        this.#scope = { target, viewport: desc.viewport, originX: 0, originY: 0,
            bounds: { ...target.usedRect }, capture: target.capture,
            empty: false, coverage: target.format === 'r8' };
        this.#clip = intersect(this.#scope.bounds, desc.viewport);
    }
    #guard<T>(operation: () => T): T {
        return this.#frame.guard(() => {
            if (this.#closed) throw new ArenaError('invalid-input');
            return operation();
        });
    }
    draw(cmd: DrawCommand): void {
        this.#guard(() => {
            const pipeline = this.#backend.pipeline(cmd.pipeline), desc = pipeline.descriptor;
            for (const n of [cmd.first, cmd.count, cmd.instances]) integer(n);
            if (desc.colorFormat !== this.#scope.target.format || desc.samples !== this.#scope.target.samples ||
                desc.stencil.enabled && !this.#scope.target.stencil) throw new ArenaError('invalid-input');
            const uniforms = cmd.bindings.uniforms.map(binding => {
                const buffer = this.#backend.buffer(binding.slice.buffer);
                slice(buffer, binding.slice);
                const expected = desc.shader.layout.uniforms.find(item => item.binding === binding.binding);
                if (!expected || !buffer.uses.has('uniform') || binding.slice.offset % this.#backend.uniformAlignment ||
                    binding.slice.bytes < expected.byteSize) throw new ArenaError('invalid-input');
                return { binding: binding.binding, buffer, offset: binding.slice.offset, bytes: expected.byteSize };
            });
            if (new Set(uniforms.map(item => item.binding)).size !== uniforms.length || uniforms.length !== desc.shader.layout.uniforms.length) {
                throw new ArenaError('invalid-input');
            }
            const textures = cmd.bindings.textures.map(binding => {
                const texture = this.#backend.texture(binding.texture), sampler = this.#backend.sampler(binding.sampler);
                const expected = desc.shader.layout.textures.find(item => item.binding === binding.binding);
                if (!expected || texture.format !== expected.format || !texture.uses.includes('sample') ||
                    texture.texture === this.#scope.target.color?.texture) throw new ArenaError('invalid-resource');
                return { binding: binding.binding, texture, sampler };
            });
            if (new Set(textures.map(item => item.binding)).size !== textures.length || textures.length !== desc.shader.layout.textures.length) {
                throw new ArenaError('invalid-input');
            }
            const vertices = cmd.vertices.map(value => {
                const buffer = this.#backend.buffer(value.buffer);
                slice(buffer, value);
                if (!buffer.uses.has('vertex')) throw new ArenaError('invalid-input');
                return { buffer, slice: { ...value } };
            });
            let maxVertex = cmd.count ? cmd.first + cmd.count - 1 : -1;
            if (!cmd.index && maxVertex > 0x7fffffff) throw new ArenaError('invalid-input');
            let index: EncodedDraw['index'] = null;
            if (cmd.index) {
                if (cmd.index.format !== 'uint16' && cmd.index.format !== 'uint32') throw new ArenaError('invalid-input');
                const buffer = this.#backend.buffer(cmd.index.slice.buffer), size = cmd.index.format === 'uint16' ? 2 : 4;
                slice(buffer, cmd.index.slice);
                if (!buffer.uses.has('index') || cmd.index.slice.offset % size ||
                    cmd.first > cmd.index.slice.bytes / size - cmd.count) throw new ArenaError('invalid-input');
                const offset = cmd.index.slice.offset + cmd.first * size;
                maxVertex = cmd.count ? buffer.maxIndex(offset, cmd.count, cmd.index.format) : -1;
                index = { buffer, offset, format: cmd.index.format };
            }
            for (const attribute of desc.shader.layout.attributes) {
                const vertex = vertices[attribute.bufferSlot];
                const size = attribute.format === 'float32x2' ? 8 : attribute.format === 'float32x3' ? 12 : attribute.format === 'float32x4' ? 16 : 4;
                const last = attribute.step === 'instance' ? cmd.instances - 1 : maxVertex;
                const alignment = attribute.format === 'unorm8x4' ? 1 : 4;
                if (!vertex || vertex.slice.offset % alignment || cmd.count > 0 && cmd.instances > 0 &&
                    (attribute.offset > vertex.slice.bytes - size || last >= 0 &&
                    (!Number.isSafeInteger(last * (attribute.stride || size)) ||
                    last * (attribute.stride || size) > vertex.slice.bytes - attribute.offset - size))) throw new ArenaError('invalid-input');
            }
            if (desc.blend === 'mask-max') this.#scope.coverage = true;
            const scissor = intersect(intersect(rect(cmd.scissor), this.#clip), this.#scope.bounds);
            if (this.#scope.empty || !cmd.count || !cmd.instances || !scissor.width || !scissor.height) return;
            const command: EncodedDraw = { pipeline, uniforms, textures, vertices, index,
                first: cmd.first, count: cmd.count, instances: cmd.instances, scissor };
            const context = this.#scope;
            this.#frame.command(() => pipeline.draw(command, context));
        });
    }
    acquireTarget(request: TargetRequest): TargetLease | null {
        return this.#guard(() => this.#backend.acquireTarget(request));
    }
    releaseTarget(lease: TargetLease): void {
        // Destruction is still available from finally after an encode failed or ended.
        if (this.#closed || this.#frame.isClosed()) { this.#backend.releaseTarget(lease); return; }
        this.#guard(() => {
            if (this.#scope.target.handle === lease.target || this.#groups.some(group => group.isolation.child.target.handle === lease.target) ||
                this.#clips.some(clip => clip.isolation?.child.target.handle === lease.target)) throw new ArenaError('invalid-input');
            this.#backend.releaseTarget(lease);
        });
    }
    pushClip(value: RectI | ClipHandle): ClipToken {
        return this.#guard(() => {
            if (this.#clips.length >= 64) throw new ArenaError('invalid-input');
            const token = Object.freeze({ depth: this.#clips.length + 1 });
            const previous = this.#clip;
            let isolation: Isolation | null = null;
            if ('kind' in value) {
                const clip = this.#backend.clip(value);
                const mask: Mask = { texture: clip.mask, bounds: { ...clip.bounds }, source: clip.mask.usedRect };
                // Each nested isolation applies only its LOCAL mask when it pops.
                // Precombining parent*child here, then applying the parent's mask again
                // at its own pop, would square soft parent coverage (vr-lead ruling).
                isolation = this.#isolate(intersect(previous, clip.bounds), { opacity: 1, blend: 'normal', colourEffect: 'none' }, mask);
                this.#scope = isolation.child;
                this.#clip = intersect(previous, isolation.child.bounds);
            } else this.#clip = intersect(previous, rect(value));
            this.#clips.push({ token, previous, groupDepth: this.#groups.length, isolation });
            return token;
        });
    }
    popClip(token: ClipToken): void {
        this.#guard(() => {
            const entry = this.#clips.at(-1);
            if (!entry || entry.token !== token || token.depth !== this.#clips.length || entry.groupDepth !== this.#groups.length) {
                throw new ArenaError('invalid-input');
            }
            this.#clips.pop();
            if (entry.isolation) this.#closeIsolation(entry.isolation, entry.previous);
            this.#clip = entry.previous;
        });
    }
    beginGroup(bounds: RectI, options: { opacity: number; blend: 'normal' | 'multiply'; colourEffect: 'none' | 'page-invert' }): GroupToken {
        return this.#guard(() => {
            const token = Object.freeze({ id: this.#frame.token() });
            const isolation = this.#isolate(intersect(rect(bounds), this.#clip), { ...options }, null);
            this.#groups.push({ token, previous: this.#clip, clipDepth: this.#clips.length, isolation });
            this.#scope = isolation.child;
            this.#clip = intersect(this.#clip, isolation.child.bounds);
            return token;
        });
    }
    endGroup(token: GroupToken): void {
        this.#guard(() => {
            const entry = this.#groups.at(-1);
            if (!entry || entry.token !== token || entry.clipDepth !== this.#clips.length) throw new ArenaError('invalid-input');
            this.#groups.pop();
            this.#closeIsolation(entry.isolation, entry.previous);
            this.#clip = entry.previous;
        });
    }
    composite(source: TextureHandle, bounds: RectI, options: { blend: 'normal' | 'multiply'; opacity: number }): void {
        this.#guard(() => {
            const texture = this.#backend.texture(source);
            if (!texture.uses.includes('sample')) throw new ArenaError('invalid-input');
            this.#frame.composite(this.#scope, this.#clip, texture, texture.usedRect, rect(bounds),
                { ...options, colourEffect: 'none' }, null);
        });
    }
    end(): void {
        this.#guard(() => {
            if (this.#clips.length || this.#groups.length) throw new ArenaError('invalid-input');
            this.#closed = true;
            this.#frame.endPass(this, this.#root, this.#desc);
        });
    }
    #isolate(bounds: RectI, options: Isolation['options'], mask: Mask | null): Isolation {
        opacity(options.opacity);
        if (!['normal', 'multiply'].includes(options.blend) || !['none', 'page-invert'].includes(options.colourEffect) ||
            this.#scope.capture && options.colourEffect === 'page-invert') throw new ArenaError('invalid-input');
        const parent = this.#scope;
        if (!bounds.width || !bounds.height || parent.empty) return { parent, child: { ...parent, bounds, empty: true }, lease: null, mask, options };
        const lease = this.#frame.temporary({ width: bounds.width, height: bounds.height, format: parent.target.format,
            samples: parent.target.samples, stencil: parent.target.stencil, purpose: 'group' });
        const target = this.#backend.target(lease.target);
        const desc: PassDesc = { target: lease.target, viewport: parent.viewport, load: { kind: 'clear', color: [0, 0, 0, 0] }, store: 'store',
            ...(target.stencil ? { stencil: { load: { kind: 'clear', value: 0 }, store: 'store' } as const } : {}) };
        this.#frame.start(target, desc);
        return { parent, child: { ...parent, target, bounds, originX: bounds.x, originY: bounds.y, empty: false, coverage: parent.coverage }, lease, mask, options };
    }
    #closeIsolation(isolation: Isolation, clip: RectI): void {
        if (this.#scope !== isolation.child) throw new ArenaError('invalid-input');
        this.#scope = isolation.parent;
        if (!isolation.lease) return;
        const child = isolation.child;
        const desc: PassDesc = { target: isolation.lease.target, viewport: child.viewport, load: { kind: 'load' }, store: 'store',
            ...(child.target.stencil ? { stencil: { load: { kind: 'load' }, store: 'store' } as const } : {}) };
        this.#frame.end(child.target, desc);
        const texture = this.#backend.texture(isolation.lease.texture);
        if (child.target.samples === 4) {
            const resolve: FrameTarget = { ...child.target, framebuffer: child.target.resolveFramebuffer, samples: 1 };
            this.#frame.blit(child.target, { x: 0, y: 0, width: child.target.width, height: child.target.height }, resolve, 0, 0);
        }
        if (child.coverage) this.#scope.coverage = true;
        this.#frame.composite(this.#scope, clip, texture, { x: 0, y: 0, width: child.bounds.width, height: child.bounds.height },
            child.bounds, isolation.options, isolation.mask);
        this.#frame.releaseTemporary(isolation.lease);
    }
}
