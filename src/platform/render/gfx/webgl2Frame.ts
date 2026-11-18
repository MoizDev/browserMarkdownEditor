import type {
    AreaOutput, AreaTarget, BufferHandle, BufferSlice, ClipHandle, ClipToken, CoverageOutput, CoverageTarget, CoverageToken, DrawCommand, FrameEncoder, GpuPass,
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
    readonly coverage?: WebGLTexture | null;
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
    readonly coverage?: WebGLTexture | null;
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
/** A quad's pinned objects, opaque to the frame: the backend owns what they are. */
export interface QuadPin { readonly program: unknown; readonly sampler: unknown }

export interface FramePipeline {
    readonly descriptor: PipelineDesc;
    draw(command: EncodedDraw, context: DrawContext): void;
}
export interface DrawContext {
    readonly target: FrameTarget;
    readonly viewport: RectI;
    readonly originX: number;
    readonly originY: number;
    /** Target texels per device pixel: 1, or the grid of a coverage target (draws rasterise at that many subsamples). */
    readonly scale: number;
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
    readonly standInRatio?: number;
    readonly coverageClass?: 2 | 3;
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
    readonly blend: 'source-over' | 'replace' | 'mask-max' | 'add' | 'modulate';
    /** Which composition program lays the quad: the default colour composite, the grid coverage resolve (`source` is then the
     * r8 grid texture), or the modulate composite (`k = rgb + (1 − a)` over white, laid by fixed-function modulate). */
    readonly variant?: 'grid' | 'modulate' | 'area';
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
    uniformsInto(bytes: ArrayBufferView, into: UniformSlice): void;
    uploadUniforms(): void;
    /** The pinned program and sampler for a quad. Cached per frame and variant by the backend, so a quad allocates nothing. */
    quad(command: QuadCommand): QuadPin;
    /** Draws a quad recorded with its pin: the replayed operation, with no closure per quad. */
    runQuad(pin: QuadPin, command: QuadCommand): void;
    acquireTarget(request: TargetRequest): TargetLease | null;
    releaseTarget(lease: TargetLease): void;
    acquireIsolation(request: TargetRequest): TargetLease;
    releaseIsolation(lease: TargetLease): void;
    issue(): number;
    cancel(): void;
    finish(serial: number | null): void;
    failure(error: unknown): ArenaError;
    onPass(surface: boolean): void;
    afterClear?(target: FrameTarget): void;
    /** Replay-only tallies: the state switches the replayed commands make (program, blend, framebuffer). */
    beginReplay(): void;
    endReplay(): number;
    bindTarget(framebuffer: WebGLFramebuffer | null): void;
}

/** One offscreen pass as recorded: its commands are `[start, end)` in the frame's list. Only passes whose commands
 * draw and nothing else are `simple`; their reads and writes are fully known (the target, and the textures the draws
 * sample), so they may be regrouped with each other. Every other pass is a barrier at its own position. */
interface PassBlock {
    readonly start: number;
    end: number;
    simple: boolean;
    readonly written: Set<unknown>;
    readonly read: Set<unknown>;
    first: FramePipeline | null;
    lastPipeline: FramePipeline | null;
}

function intersects(a: ReadonlySet<unknown>, b: ReadonlySet<unknown>): boolean {
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    for (const value of small) if (large.has(value)) return true;
    return false;
}

/** Two passes conflict when one writes what the other reads or writes. Pool reuse of a target shows up here too. */
function conflicts(earlier: PassBlock, later: PassBlock): boolean {
    return intersects(earlier.written, later.written) || intersects(earlier.written, later.read) || intersects(earlier.read, later.written);
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
    readonly options: { opacity: number; blend: 'normal' | 'multiply' | 'modulate'; colourEffect: 'none' | 'page-invert' };
    /** An area scope: the band's rectangle in device px, which its composite is placed by (its child scope is target-local). */
    readonly device?: RectI;
}
interface ClipEntry {
    readonly token: ClipToken;
    readonly previous: RectI;
    readonly groupDepth: number;
    readonly isolation: Isolation | null;
}
interface GroupEntry {
    readonly kind: 'group' | 'coverage' | 'area';
    readonly token: GroupToken | CoverageToken;
    readonly previous: RectI;
    readonly clipDepth: number;
    readonly isolation: Isolation;
}

/** Scratch for packing one composition uniform block (32 floats). `uniforms()` copies the bytes into the ring before it
 * returns, and the slice it hands back points into the ring, so one array serves every composite. By reading: a fresh
 * array and a literal per vector allocated on every composite, and a frame composes once per isolated group. */
const blockScratch = new Float32Array(32);
function setVec4(into: Float32Array, at: number, x: number, y: number, z: number, w: number): void {
    into[at] = x; into[at + 1] = y; into[at + 2] = z; into[at + 3] = w;
}

function integer(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0x7fffffff) throw new ArenaError('invalid-input');
}
/** Validates a rectangle without copying it, for a caller that only reads it (intersect() copies what it keeps). */
function checkRect(value: RectI): void {
    for (const n of [value.x, value.y, value.width, value.height]) integer(n);
    if (!Number.isSafeInteger(value.x + value.width) || !Number.isSafeInteger(value.y + value.height)) throw new ArenaError('invalid-input');
}
function rect(value: RectI): RectI {
    checkRect(value);
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
    if (desc.clearViewport) rect(desc.clearViewport);
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

/** One recorded operation. A draw keeps its pipeline, command and context as plain fields; any other operation (a pass
 * boundary, a blit, a quad) keeps its closure in `run`. Records live in a reused array and are re-filled each frame, so a
 * frame of N draws allocates no closure per draw. By reading: each draw used to allocate `() => pipeline.draw(…)` and
 * the array of replay closures was rebuilt every frame. */
interface Recorded {
    pipeline: FramePipeline | null; command: EncodedDraw | null; context: DrawContext | null; run: (() => void) | null;
    quad: QuadPin | null; quadCommand: QuadCommand | null;
}

class DeviceFrame implements ControlledFrame {
    readonly #backend: FrameBackend;
    readonly #commands: Recorded[] = [];
    #count = 0;
    readonly #replay: Recorded[] = [];
    readonly #blocks: PassBlock[] = [];
    #open: PassBlock | null = null;
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
    uniformsInto(bytes: ArrayBufferView, into: UniformSlice): void {
        this.guard(() => this.#backend.uniformsInto(bytes, into));
    }
    acquireTarget(desc: TargetRequest): TargetLease | null {
        return this.guard(() => this.#backend.acquireTarget(desc));
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
            // The surface is never regrouped: it is composed last, after every offscreen pass has landed.
            const block: PassBlock = { start: this.#count, end: -1, simple: desc.target !== 'surface',
                written: new Set(), read: new Set(), first: null, lastPipeline: null };
            for (const written of [target.color?.texture, target.coverage, target.framebuffer, target.resolveFramebuffer]) {
                if (written) block.written.add(written);
            }
            this.#open = block;
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
                this.#backend.beginReplay();
                for (const record of this.#replayList()) {
                    if (record.pipeline) record.pipeline.draw(record.command!, record.context!);
                    else if (record.quad) this.#backend.runQuad(record.quad, record.quadCommand!);
                    else record.run!();
                }
                const stateSwitches = this.#backend.endReplay();
                serial = this.#backend.issue();
                for (const [native, state] of this.#retained) Object.assign(native, state);
                this.#closed = true;
                return { serial, stateSwitches };
            } catch (error) {
                // A healthy partial submission still needs a fence before its pins can retire.
                for (const native of this.#retained.keys()) { native.colorStored = false; native.stencilStored = false; }
                if (executing && !this.#backend.signal.aborted) {
                    try { serial = this.#backend.issue(); } catch { /* Loss abandons the generation in the backend. */ }
                }
                throw error;
            } finally {
                this.#closed = true;
                this.#clearCommands();
                this.#blocks.length = 0;
                this.#retained.clear();
                this.#cleanup(serial, serial === null);
            }
        });
    }
    cancel(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#clearCommands();
        this.#blocks.length = 0;
        this.#retained.clear();
        this.#cleanup(null, true);
    }
    /** Forgets this frame's records, keeping their slots for the next frame to re-fill (no per-frame allocation). */
    #clearCommands(): void {
        for (let i = 0; i < this.#count; i++) {
            const slot = this.#commands[i];
            slot.pipeline = null; slot.command = null; slot.context = null; slot.run = null; slot.quad = null; slot.quadCommand = null;
        }
        this.#count = 0;
    }
    /** The commands in replay order: each run of consecutive simple offscreen passes regrouped by `#order`, everything
     * else where it was recorded. Filled into one reused array, so a frame allocates no replay list. */
    #replayList(): readonly Recorded[] {
        const commands = this.#commands, blocks = this.#blocks, out = this.#replay;
        out.length = 0;
        let pos = 0, b = 0;
        while (pos < this.#count) {
            if (b >= blocks.length || blocks[b].start !== pos) { out.push(commands[pos++]); continue; }
            let end = b + 1;
            if (blocks[b].simple) {
                while (end < blocks.length && blocks[end].simple && blocks[end].start === blocks[end - 1].end) end++;
            }
            const order = end - b > 1 ? this.#order(b, end) : [b];
            for (const index of order) for (let c = blocks[index].start; c < blocks[index].end; c++) out.push(commands[c]);
            pos = blocks[end - 1].end;
            b = end;
        }
        return out;
    }
    /** Greedy topological order of blocks `[from, to)`: a block waits for every earlier block it conflicts with, and among
     * the ready blocks prefers one whose first draw uses the pipeline the previous block ended with (no program switch at
     * the seam), then the recorded order. Independent passes thus stay together by program, and nothing else moves. */
    #order(from: number, to: number): number[] {
        const blocks = this.#blocks, count = to - from;
        const waits: number[][] = [];
        for (let i = 0; i < count; i++) {
            const list: number[] = [];
            for (let j = 0; j < i; j++) if (conflicts(blocks[from + j], blocks[from + i])) list.push(j);
            waits.push(list);
        }
        const done = new Array<boolean>(count).fill(false);
        const order: number[] = [];
        let previous: PassBlock | null = null;
        while (order.length < count) {
            let pick = -1;
            for (let i = 0; i < count; i++) {
                if (done[i] || !waits[i].every(j => done[j])) continue;
                if (pick < 0) pick = i;
                if (previous && previous.lastPipeline && blocks[from + i].first === previous.lastPipeline) { pick = i; break; }
            }
            done[pick] = true;
            order.push(from + pick);
            previous = blocks[from + pick];
        }
        return order;
    }
    /** A draw of the open pass: its pipeline and the textures it samples, for the conflict test. */
    noteDraw(pipeline: FramePipeline, textures: readonly { texture: FrameTexture }[]): void {
        const block = this.#open;
        if (!block) return;
        block.first ??= pipeline;
        block.lastPipeline = pipeline;
        for (const item of textures) block.read.add(item.texture.texture);
    }
    /** Any other recorded operation of the open pass (clip, group, coverage, composite, temporary) makes it a barrier. */
    markBarrier(): void {
        if (this.#open) this.#open.simple = false;
    }
    #cleanup(serial: number | null, cancel: boolean): void {
        const failures: unknown[] = [];
        if (cancel) { try { this.#backend.cancel(); } catch (error) { failures.push(error); } }
        for (const lease of this.#temporaries) {
            try { this.#backend.releaseIsolation(lease); } catch (error) { failures.push(error); }
        }
        this.#temporaries.clear();
        try { this.#backend.finish(serial); } catch (error) { failures.push(error); }
        if (failures.length) throw failures[0];
    }
    command(operation: () => void): void {
        const slot = this.#slot();
        slot.pipeline = null; slot.command = null; slot.context = null; slot.run = operation; slot.quad = null; slot.quadCommand = null;
    }
    /** Records a quad by its pin and command, as plain fields of a reused slot. */
    recordQuad(pin: QuadPin, command: QuadCommand): void {
        const slot = this.#slot();
        slot.pipeline = null; slot.command = null; slot.context = null; slot.run = null; slot.quad = pin; slot.quadCommand = command;
    }
    /** Records a draw as plain fields of a reused slot, not as a closure. */
    recordDraw(pipeline: FramePipeline, command: EncodedDraw, context: DrawContext): void {
        const slot = this.#slot();
        slot.pipeline = pipeline; slot.command = command; slot.context = context; slot.run = null; slot.quad = null; slot.quadCommand = null;
    }
    #slot(): Recorded {
        let slot = this.#commands[this.#count];
        if (!slot) { slot = { pipeline: null, command: null, context: null, run: null, quad: null, quadCommand: null }; this.#commands.push(slot); }
        this.#count++;
        return slot;
    }
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
                this.#backend.bindTarget(target.framebuffer);
                gl.disable(gl.SCISSOR_TEST);
                gl.colorMask(true, true, true, true);
                let bits = 0;
                if (desc.load.kind === 'clear') { gl.clearColor(...desc.load.color); bits |= gl.COLOR_BUFFER_BIT; }
                if (desc.stencil?.load.kind === 'clear') {
                    gl.stencilMask(255);
                    gl.clearStencil(desc.stencil.load.value);
                    bits |= gl.STENCIL_BUFFER_BIT;
                }
                // A region clear is limited to its rectangle; the scissor is turned off again before any draw of the pass.
                if (bits && desc.clearViewport) {
                    gl.enable(gl.SCISSOR_TEST);
                    gl.scissor(desc.clearViewport.x, target.height - desc.clearViewport.y - desc.clearViewport.height, desc.clearViewport.width, desc.clearViewport.height);
                }
                if (bits) gl.clear(bits);
                if (bits && desc.clearViewport) gl.disable(gl.SCISSOR_TEST);
                if (__BME_BENCH__ && target.coverage && desc.load.kind === 'clear') {
                    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
                    gl.clearBufferfv(gl.COLOR, 1, new Float32Array([0, 0, 0, 0]));
                    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
                }
                if (__BME_BENCH__ && desc.load.kind === 'clear') this.#backend.afterClear?.(target);
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
                    this.#backend.bindTarget(target.framebuffer);
                    gl.invalidateFramebuffer(gl.FRAMEBUFFER, discard);
                }
            } finally { this.#backend.reset(); }
        });
    }
    endPass(pass: DevicePass, target: FrameTarget, desc: PassDesc): void {
        if (this.#pass !== pass) throw new ArenaError('invalid-input');
        this.end(target, desc);
        this.#pass = null;
        const block = this.#open;
        if (block) { block.end = this.#count; this.#blocks.push(block); this.#open = null; }
    }
    temporary(request: TargetRequest): TargetLease {
        const lease = this.#backend.acquireIsolation(request);
        this.#temporaries.add(lease);
        return lease;
    }
    releaseTemporary(lease: TargetLease): void {
        this.#temporaries.delete(lease);
        this.#backend.releaseIsolation(lease);
    }
    blit(source: FrameTarget, area: RectI, dest: FrameTarget, x: number, y: number): void {
        if (!area.width || !area.height) return;
        this.command(() => {
            const gl = this.#backend.gl();
            try {
                gl.disable(gl.SCISSOR_TEST);
                gl.bindFramebuffer(gl.READ_FRAMEBUFFER, source.framebuffer);
                gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dest.framebuffer);
                if (__BME_BENCH__) {
                    gl.readBuffer(source.framebuffer ? gl.COLOR_ATTACHMENT0 : gl.BACK);
                    gl.drawBuffers([dest.framebuffer ? gl.COLOR_ATTACHMENT0 : gl.BACK]);
                }
                gl.blitFramebuffer(area.x, source.height - area.y - area.height, area.x + area.width, source.height - area.y,
                    x, dest.height - y - area.height, x + area.width, dest.height - y, gl.COLOR_BUFFER_BIT, gl.NEAREST);
                if (__BME_BENCH__ && source.coverage && dest.coverage) {
                    gl.readBuffer(gl.COLOR_ATTACHMENT1);
                    gl.drawBuffers([gl.NONE, gl.COLOR_ATTACHMENT1]);
                    gl.blitFramebuffer(area.x, source.height - area.y - area.height, area.x + area.width, source.height - area.y,
                        x, dest.height - y - area.height, x + area.width, dest.height - y, gl.COLOR_BUFFER_BIT, gl.NEAREST);
                    gl.readBuffer(gl.COLOR_ATTACHMENT0);
                    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
                }
            } finally { this.#backend.reset(); }
        });
    }
    snapshot(scope: Scope, area: RectI): { lease: TargetLease; texture: FrameTexture } {
        const lease = this.temporary({ width: area.width, height: area.height, samples: 1, stencil: false,
            format: scope.target.format, purpose: 'group' });
        const output = this.#backend.target(lease.target);
        // Only the copied rectangle is read, so an MSAA target resolves that rectangle, not the whole target: a multiply
        // composite on a large page otherwise resolved every pixel of the target to copy one group's bounds.
        // By reading: the copy below reads `local` alone, so the resolve of the rest of the target was never used.
        const local = { x: area.x - scope.originX, y: area.y - scope.originY, width: area.width, height: area.height };
        let source = scope.target;
        if (source.samples === 4) {
            if (!source.color) throw new ArenaError('invalid-resource');
            const resolve: FrameTarget = { ...source, framebuffer: source.resolveFramebuffer, samples: 1 };
            this.blit(source, local, resolve, local.x, local.y);
            source = resolve;
        }
        this.blit(source, local, output, 0, 0);
        return { lease, texture: this.#backend.texture(lease.texture) };
    }
    composite(scope: Scope, clip: RectI, source: FrameTexture, sourceRect: RectI, bounds: RectI,
        options: { opacity: number; blend: 'normal' | 'multiply' | 'modulate'; colourEffect: 'none' | 'page-invert' }, mask: Mask | null): void {
        opacity(options.opacity);
        if (scope.scale !== 1) throw new ArenaError('invalid-input');
        if (!['normal', 'multiply', 'modulate'].includes(options.blend) || !['none', 'page-invert'].includes(options.colourEffect) ||
            scope.capture && options.colourEffect === 'page-invert') throw new ArenaError('invalid-input');
        if (options.blend === 'modulate' && (options.colourEffect !== 'none' || scope.target.format !== 'rgba8')) throw new ArenaError('invalid-input');
        const area = intersect(intersect(bounds, clip), scope.bounds);
        if (scope.empty || !area.width || !area.height || options.opacity === 0) return;
        if (source.texture === scope.target.color?.texture || mask !== null && mask.texture.texture === scope.target.color?.texture) {
            throw new ArenaError('invalid-resource');
        }
        let backdrop: { lease: TargetLease; texture: FrameTexture } | null = null;
        if (options.blend === 'multiply') backdrop = this.snapshot(scope, area);
        const data = blockScratch;
        setVec4(data, 0, scope.viewport.x, scope.viewport.y, scope.viewport.width, scope.viewport.height);
        setVec4(data, 4, bounds.x, bounds.y, bounds.width, bounds.height);
        setVec4(data, 8, sourceRect.x, sourceRect.y, sourceRect.width, sourceRect.height);
        setVec4(data, 12, source.width, source.height, options.opacity, options.colourEffect === 'page-invert' ? 1 : 0);
        setVec4(data, 16, area.x, area.y, backdrop?.texture.width ?? 1, backdrop?.texture.height ?? 1);
        if (mask) {
            setVec4(data, 20, mask.bounds.x, mask.bounds.y, mask.bounds.width, mask.bounds.height);
            setVec4(data, 24, mask.source.width / mask.texture.width, mask.source.height / mask.texture.height,
                mask.source.x / mask.texture.width, 1 - mask.source.y / mask.texture.height);
        }
        setVec4(data, 28, options.blend === 'multiply' ? 1 : 0, mask ? 1 : 0, scope.coverage ? 1 : 0,
            __BME_BENCH__ ? (source.coverage ? 1 : 0) + (backdrop?.texture.coverage ? 2 : 0) : 0);
        const packed = this.uniforms(data);
        const command: QuadCommand = {
            context: scope, source, backdrop: backdrop?.texture ?? this.#backend.white(), mask: mask?.texture ?? this.#backend.white(),
            uniforms: { buffer: this.#backend.buffer(packed.buffer), slice: packed }, scissor: area,
            blend: options.blend === 'modulate' ? 'modulate' : options.blend === 'multiply' ? 'replace' : scope.coverage ? 'mask-max' : 'source-over',
            ...(options.blend === 'modulate' ? { variant: 'modulate' as const } : {}),
        };
        this.recordQuad(this.#backend.quad(command), command);
        if (backdrop) this.releaseTemporary(backdrop.lease);
    }
    /** Composites an area target: each device px is min(1, |acc|) of its accumulator texel, painted with the paint output. */
    compositeArea(scope: Scope, clip: RectI, source: FrameTexture, bounds: RectI,
        output: { blend: 'normal' | 'modulate'; rgb: readonly [number, number, number]; alpha: number }): void {
        if (scope.scale !== 1 || !output.rgb.every(value => Number.isFinite(value) && value >= 0 && value <= 1) ||
            !Number.isFinite(output.alpha) || output.alpha < 0 || output.alpha > 1) throw new ArenaError('invalid-input');
        const area = intersect(intersect(bounds, clip), scope.bounds);
        if (scope.empty || !area.width || !area.height || output.alpha === 0) return;
        if (source.texture === scope.target.color?.texture || source.width < bounds.width || source.height < bounds.height) {
            throw new ArenaError('invalid-resource');
        }
        const data = blockScratch;
        setVec4(data, 0, scope.viewport.x, scope.viewport.y, scope.viewport.width, scope.viewport.height);
        setVec4(data, 4, area.x, area.y, area.width, area.height);
        setVec4(data, 8, bounds.x, bounds.y, 1, 0);
        setVec4(data, 12, source.width, source.height, 1, 0);
        setVec4(data, 16, output.rgb[0], output.rgb[1], output.rgb[2], output.alpha);
        setVec4(data, 28, output.blend === 'modulate' ? 1 : 0, 0, 0, 0);
        const packed = this.uniforms(data);
        const command: QuadCommand = {
            context: scope, source, backdrop: this.#backend.white(), mask: this.#backend.white(),
            uniforms: { buffer: this.#backend.buffer(packed.buffer), slice: packed }, scissor: area,
            blend: output.blend === 'modulate' ? 'modulate' : 'source-over', variant: 'area',
        };
        this.recordQuad(this.#backend.quad(command), command);
    }
    /** Resolves a grid coverage target and paints it in one composite. The texel block of device pixel p is
     * (p − bounds.origin)·grid, so the scope's destination and the target's origin line up exactly. */
    compositeGrid(scope: Scope, clip: RectI, source: FrameTexture, bounds: RectI, grid: number,
        output: { blend: 'normal' | 'modulate'; rgb: readonly [number, number, number]; alpha: number }): void {
        if (scope.scale !== 1 || grid !== 4 || !['normal', 'modulate'].includes(output.blend) ||
            !output.rgb.every(value => Number.isFinite(value) && value >= 0 && value <= 1) ||
            !Number.isFinite(output.alpha) || output.alpha < 0 || output.alpha > 1) throw new ArenaError('invalid-input');
        const area = intersect(intersect(bounds, clip), scope.bounds);
        if (scope.empty || !area.width || !area.height || output.alpha === 0) return;
        // The texture is the whole band; the borrowed rectangle is a corner of it, so it need only be at least that large.
        if (source.texture === scope.target.color?.texture || source.width < bounds.width * grid || source.height < bounds.height * grid) {
            throw new ArenaError('invalid-resource');
        }
        const data = blockScratch;
        setVec4(data, 0, scope.viewport.x, scope.viewport.y, scope.viewport.width, scope.viewport.height);
        setVec4(data, 4, area.x, area.y, area.width, area.height);
        setVec4(data, 8, bounds.x, bounds.y, grid, 0);
        setVec4(data, 12, source.width, source.height, 1, 0);
        setVec4(data, 16, output.rgb[0], output.rgb[1], output.rgb[2], output.alpha);
        setVec4(data, 28, output.blend === 'modulate' ? 1 : 0, 0, 0, 0);
        const packed = this.uniforms(data);
        const command: QuadCommand = {
            context: scope, source, backdrop: this.#backend.white(), mask: this.#backend.white(),
            uniforms: { buffer: this.#backend.buffer(packed.buffer), slice: packed }, scissor: area,
            blend: output.blend === 'modulate' ? 'modulate' : 'source-over', variant: 'grid',
        };
        this.recordQuad(this.#backend.quad(command), command);
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
    /** One frozen token per depth, reused by every push at that depth. The stack is LIFO, so one token per depth is live at a
     * time; popClip still rejects a token that is not the live entry's or whose depth is not current. What it cannot tell
     * apart is a stale copy of a token for a depth that is live again: callers pair pushes with pops, so that is their error.
     * By reading the clip path: a push allocated a token each time. */
    readonly #clipTokens: ClipToken[] = [];
    /** Mask bounds per depth, written in place. composite() reads them synchronously when the mask pops, so a later push at
     * the same depth cannot change what an earlier composite used. By reading composite(). */
    readonly #maskBounds: RectI[] = [];
    readonly #groups: GroupEntry[] = [];
    #scope: Scope;
    #clip: RectI;
    #closed = false;

    constructor(frame: DeviceFrame, backend: FrameBackend, target: FrameTarget, desc: PassDesc) {
        this.#frame = frame;
        this.#backend = backend;
        this.#root = target;
        this.#desc = desc;
        this.#scope = { target, viewport: desc.viewport, originX: 0, originY: 0, scale: 1,
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
            // MAX into an r8 target is a coverage mask, and its parent then composites it as one. MAX into rgba8 is a colour
            // union (analytic ink pieces in a coverage scratch); marking it a mask made the parent MAX it over white: no ink.
            if (desc.blend === 'mask-max' && this.#scope.target.format === 'r8') this.#scope.coverage = true;
            const scissor = intersect(intersect(rect(cmd.scissor), this.#clip), this.#scope.bounds);
            if (this.#scope.empty || !cmd.count || !cmd.instances || !scissor.width || !scissor.height) return;
            const command: EncodedDraw = { pipeline, uniforms, textures, vertices, index,
                first: cmd.first, count: cmd.count, instances: cmd.instances, scissor,
                ...(__BME_BENCH__ && cmd.standInRatio !== undefined ? { standInRatio: cmd.standInRatio } : {}),
                ...(__BME_BENCH__ && cmd.coverageClass !== undefined ? { coverageClass: cmd.coverageClass } : {}) };
            const context = this.#scope;
            this.#frame.noteDraw(pipeline, textures);
            this.#frame.recordDraw(pipeline, command, context);
        });
    }
    acquireTarget(request: TargetRequest): TargetLease | null {
        this.#frame.markBarrier();
        return this.#guard(() => this.#backend.acquireTarget(request));
    }
    releaseTarget(lease: TargetLease): void {
        this.#frame.markBarrier();
        // Destruction is still available from finally after an encode failed or ended.
        if (this.#closed || this.#frame.isClosed()) { this.#backend.releaseTarget(lease); return; }
        this.#guard(() => {
            if (this.#scope.target.handle === lease.target || this.#groups.some(group => group.isolation.child.target.handle === lease.target) ||
                this.#clips.some(clip => clip.isolation?.child.target.handle === lease.target)) throw new ArenaError('invalid-input');
            this.#backend.releaseTarget(lease);
        });
    }
    pushClip(value: RectI | ClipHandle): ClipToken {
        this.#frame.markBarrier();
        return this.#guard(() => {
            if (this.#clips.length >= 64) throw new ArenaError('invalid-input');
            const depth = this.#clips.length + 1;
            const token = this.#clipTokens[depth - 1] ??= Object.freeze({ depth });
            const previous = this.#clip;
            let isolation: Isolation | null = null;
            if ('kind' in value) {
                const clip = this.#backend.clip(value);
                const bounds = this.#maskBounds[depth - 1] ??= { x: 0, y: 0, width: 0, height: 0 };
                bounds.x = clip.bounds.x; bounds.y = clip.bounds.y; bounds.width = clip.bounds.width; bounds.height = clip.bounds.height;
                const mask: Mask = { texture: clip.mask, bounds, source: clip.mask.usedRect };
                // Each nested isolation applies only its LOCAL mask when it pops.
                // Precombining parent*child here, then applying the parent's mask again
                // at its own pop, would square soft parent coverage (vr-lead ruling).
                isolation = this.#isolate(intersect(previous, clip.bounds), { opacity: 1, blend: 'normal', colourEffect: 'none' }, mask);
                this.#scope = isolation.child;
                this.#clip = intersect(previous, isolation.child.bounds);
            } else {
                checkRect(value);
                this.#clip = intersect(previous, value);
            }
            this.#clips.push({ token, previous, groupDepth: this.#groups.length, isolation });
            return token;
        });
    }
    popClip(token: ClipToken): void {
        this.#frame.markBarrier();
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
    beginGroup(bounds: RectI, options: { opacity: number; blend: 'normal' | 'multiply' | 'modulate'; colourEffect: 'none' | 'page-invert' }): GroupToken {
        this.#frame.markBarrier();
        return this.#guard(() => {
            const token = Object.freeze({ id: this.#frame.token() });
            const isolation = this.#isolate(intersect(rect(bounds), this.#clip), { ...options }, null);
            this.#groups.push({ kind: 'group', token, previous: this.#clip, clipDepth: this.#clips.length, isolation });
            this.#scope = isolation.child;
            this.#clip = intersect(this.#clip, isolation.child.bounds);
            return token;
        });
    }
    endGroup(token: GroupToken): void {
        this.#frame.markBarrier();
        this.#guard(() => {
            const entry = this.#groups.at(-1);
            if (!entry || entry.kind !== 'group' || entry.token !== token || entry.clipDepth !== this.#clips.length) throw new ArenaError('invalid-input');
            this.#groups.pop();
            this.#closeIsolation(entry.isolation, entry.previous);
            this.#clip = entry.previous;
        });
    }
    beginCoverage(target: CoverageTarget, bounds: RectI): CoverageToken {
        this.#frame.markBarrier();
        return this.#guard(() => {
            // A borrowed target is one open scope at a time: a nested borrow could overwrite the
            // stencil counts that an enclosing scope is still covering with.
            if (this.#groups.some(entry => entry.kind === 'coverage')) throw new ArenaError('invalid-input');
            const native = this.#backend.target(target.target), texture = this.#backend.texture(target.texture);
            const parent = this.#scope;
            const grid = target.grid;
            if (!native.stencil || native.samples !== target.samples || native.format !== (grid === 1 ? 'rgba8' : 'r8') ||
                native.width !== target.width * grid || native.height !== target.height * grid || !texture.uses.includes('sample') ||
                texture.texture === parent.target.color?.texture || [bounds.x, bounds.y, bounds.width, bounds.height].some(value => !Number.isSafeInteger(value)) ||
                bounds.width <= 0 || bounds.height <= 0 || bounds.width > target.width || bounds.height > target.height) throw new ArenaError('invalid-input');
            const token = Object.freeze({ id: this.#frame.token() });
            const previous = this.#clip;
            // The scope covers the target's own rectangle; coverage outside the admitted area is never drawn.
            const area = intersect(intersect(bounds, previous), parent.bounds);
            const empty = parent.empty || !area.width || !area.height;
            const options = { opacity: 1, blend: 'normal', colourEffect: 'none' } as const;
            if (!empty) {
                this.#frame.start(native, { target: target.target, viewport: parent.viewport,
                    load: { kind: 'clear', color: [0, 0, 0, 0] }, store: 'store',
                    stencil: { load: { kind: 'clear', value: 0 }, store: 'discard' } });
            }
            const child: Scope = { ...parent, target: native, bounds, originX: bounds.x, originY: bounds.y, scale: grid, empty, coverage: parent.coverage };
            const isolation: Isolation = { parent, child, lease: null, mask: null, options };
            this.#groups.push({ kind: 'coverage', token, previous, clipDepth: this.#clips.length, isolation });
            this.#scope = child;
            this.#clip = intersect(previous, child.bounds);
            return token;
        });
    }
    endCoverage(token: CoverageToken, output: CoverageOutput): void {
        this.#frame.markBarrier();
        this.#guard(() => {
            const entry = this.#groups.at(-1);
            if (!entry || entry.kind !== 'coverage' || entry.token !== token || entry.clipDepth !== this.#clips.length) throw new ArenaError('invalid-input');
            // A grid target resolves only through 'paint'; device-resolution targets never take it.
            const grid = entry.isolation.child.scale > 1;
            const valid = output.kind === 'paint' ? grid
                : output.kind === 'composite' ? !grid && ['normal', 'multiply', 'modulate'].includes(output.blend)
                : output.kind === 'mask' && !grid;
            if (!valid) throw new ArenaError('invalid-input');
            this.#groups.pop();
            this.#closeCoverage(entry.isolation, entry.previous, output);
            this.#clip = entry.previous;
        });
    }
    beginArea(target: AreaTarget, bounds: RectI): CoverageToken {
        this.#frame.markBarrier();
        return this.#guard(() => {
            // One borrowed target is one open scope at a time: a nested borrow would overwrite what the enclosing scope is
            // still accumulating, the same rule as coverage.
            if (this.#groups.some(entry => entry.kind !== 'group')) throw new ArenaError('invalid-input');
            const native = this.#backend.target(target.target), texture = this.#backend.texture(target.texture);
            const parent = this.#scope;
            // The area accumulates in its own texel space: the GL viewport is the target itself, so band-local px map to its texels.
            // (Starting it on the device viewport put every row outside a band-sized target.)
            const local: RectI = { x: 0, y: 0, width: target.width, height: target.height };
            // An area target is one r32f texel per device px with no stencil and no MSAA; anything else is refused.
            if (native.stencil || native.samples !== 1 || native.format !== 'r32f' || native.width !== target.width ||
                native.height !== target.height || !texture.uses.includes('sample') || texture.texture === parent.target.color?.texture ||
                [bounds.x, bounds.y, bounds.width, bounds.height].some(value => !Number.isSafeInteger(value)) ||
                bounds.width <= 0 || bounds.height <= 0 || bounds.width > target.width || bounds.height > target.height) throw new ArenaError('invalid-input');
            const token = Object.freeze({ id: this.#frame.token() });
            const previous = this.#clip;
            const area = intersect(intersect(bounds, previous), parent.bounds);
            const empty = parent.empty || !area.width || !area.height;
            const options = { opacity: 1, blend: 'normal', colourEffect: 'none' } as const;
            if (!empty) {
                // Loaded, not cleared: the scratch is shared, and a whole-target clear costs the target for every stroke. The area's first
                // draw clears its own band to zero (the kit's clear pass), so no span sees a previous area's value.
                this.#frame.start(native, { target: target.target, viewport: local,
                    load: { kind: 'load' }, store: 'store' });
            }
            // Inside the area the scope is the target itself: its bounds and clip are target-local, so a draw's scissor (target px) is
            // intersected with the rectangle it is in. Its device rectangle is kept for the composite alone (see #closeArea). Measured:
            // with device-space bounds every span and clear was intersected with the band's device position and clipped away.
            const child: Scope = { ...parent, target: native, viewport: local, bounds: local, originX: 0, originY: 0, scale: 1, empty, coverage: parent.coverage };
            const isolation: Isolation = { parent, child, lease: null, mask: null, options, device: bounds };
            this.#groups.push({ kind: 'area', token, previous, clipDepth: this.#clips.length, isolation });
            this.#scope = child;
            this.#clip = local;
            return token;
        });
    }
    endArea(token: CoverageToken, output: AreaOutput): void {
        this.#frame.markBarrier();
        this.#guard(() => {
            const entry = this.#groups.at(-1);
            if (!entry || entry.kind !== 'area' || entry.token !== token || entry.clipDepth !== this.#clips.length) throw new ArenaError('invalid-input');
            if (output.kind !== 'area' || !['normal', 'modulate'].includes(output.blend)) throw new ArenaError('invalid-input');
            this.#groups.pop();
            this.#closeArea(entry.isolation, entry.previous, output);
            this.#clip = entry.previous;
        });
    }
    #closeArea(isolation: Isolation, clip: RectI, output: AreaOutput): void {
        if (this.#scope !== isolation.child) throw new ArenaError('invalid-input');
        this.#scope = isolation.parent;
        const child = isolation.child;
        if (child.empty) return;
        this.#frame.end(child.target, { target: child.target.handle, viewport: child.viewport, load: { kind: 'load' }, store: 'store' });
        const texture = child.target.color;
        if (!texture) throw new ArenaError('invalid-resource');
        this.#frame.compositeArea(this.#scope, clip, texture, isolation.device ?? child.bounds, output);
    }
    #closeCoverage(isolation: Isolation, clip: RectI, output: CoverageOutput): void {
        if (this.#scope !== isolation.child) throw new ArenaError('invalid-input');
        this.#scope = isolation.parent;
        const child = isolation.child;
        if (child.empty) return;
        this.#frame.end(child.target, { target: child.target.handle, viewport: child.viewport, load: { kind: 'load' }, store: 'store',
            stencil: { load: { kind: 'load' }, store: 'discard' } });
        if (child.target.samples === 4) {
            const resolve: FrameTarget = { ...child.target, framebuffer: child.target.resolveFramebuffer, samples: 1 };
            // Only the borrowed rectangle: a shared scratch target is larger than one band of one path.
            this.#frame.blit(child.target, { x: 0, y: 0, width: child.bounds.width, height: child.bounds.height }, resolve, 0, 0);
        }
        if (output.kind === 'mask') return;
        if (output.kind === 'paint') {
            if (child.coverage) this.#scope.coverage = true;
            const grid = child.target.color;
            if (!grid) throw new ArenaError('invalid-resource');
            this.#frame.compositeGrid(this.#scope, clip, grid, child.bounds, child.scale, output);
            return;
        }
        if (child.coverage) this.#scope.coverage = true;
        const texture = child.target.color;
        if (!texture) throw new ArenaError('invalid-resource');
        this.#frame.composite(this.#scope, clip, texture, { x: 0, y: 0, width: child.bounds.width, height: child.bounds.height },
            child.bounds, { opacity: 1, blend: output.blend, colourEffect: 'none' }, null);
    }
    composite(source: TextureHandle, bounds: RectI, options: { blend: 'normal' | 'multiply'; opacity: number }): void {
        this.#frame.markBarrier();
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
        // A group or mask needs a device-resolution target; inside a grid scope there is none to composite from.
        if (this.#scope.scale !== 1) throw new ArenaError('invalid-input');
        opacity(options.opacity);
        if (!['normal', 'multiply', 'modulate'].includes(options.blend) || !['none', 'page-invert'].includes(options.colourEffect) ||
            this.#scope.capture && options.colourEffect === 'page-invert') throw new ArenaError('invalid-input');
        // A modulate group is laid by fixed-function blending, so it carries no page inversion and sits on an rgba8 target.
        if (options.blend === 'modulate' && (options.colourEffect !== 'none' || this.#scope.target.format !== 'rgba8')) {
            throw new ArenaError('invalid-input');
        }
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
