import type { ArenaEncoding } from '../resourceArena';
import type { MemoryAllocator } from '../memoryGovernor';
import type { ByteLease } from './api';
import type { FrameToken } from '../types';
import { Webgl2CoverageResources } from './webgl2CoverageResources';

export interface CoverageFrameTag {
    readonly frameId: number;
    readonly token: FrameToken;
    readonly cameraEpoch: number;
    readonly sceneRevision: string;
}
export interface CoverageResultTag extends CoverageFrameTag {
    readonly width: number;
    readonly height: number;
}
export interface Webgl2CoverageOptions {
    readonly generation: number;
    readonly gl: () => WebGL2RenderingContext;
    readonly memory: MemoryAllocator;
    readonly cpuMemory?: MemoryAllocator;
    readonly reset: () => void;
    readonly schedulePoll: (callback: () => void) => () => void;
    readonly programs: () => { readonly classify: WebGLProgram; readonly reduce: WebGLProgram } | null;
    /** Borrowed four-word view, valid only during this synchronous callback. */
    readonly onCount: (tag: CoverageResultTag, counts: Uint32Array) => void;
    readonly onDrop: (tag: CoverageResultTag) => void;
    readonly onDrained?: () => void;
}
interface ProgramUniforms { program: WebGLProgram; source: WebGLUniformLocation; size: WebGLUniformLocation }
interface Ticket {
    tag: CoverageResultTag;
    serial: number;
    fence: WebGLSync | null;
    pack: WebGLBuffer;
    read: ArenaEncoding;
    slot: number;
    decision: 'pending' | 'committed' | 'cancelled';
    counts: { outside: number; hole: number; standin: number; current: number } | null;
    done: boolean;
    failed: boolean;
    proof: (() => boolean) | null;
}

/** Benchmark-only asynchronous reduction; presentation and readback have separate lifetimes. */
export class Webgl2Coverage {
    readonly #resources: Webgl2CoverageResources;
    readonly #tickets = new Set<Ticket>();
    readonly #slots = new Set<number>();
    #serial = 0;
    #completed = 0;
    #poll: (() => void) | null = null;
    #prepared: { width: number; height: number; classify: ProgramUniforms; reduce: ProgramUniforms } | null = null;
    #closed = false;
    #broken = false;
    #notified = false;
    #readback: Uint32Array | null = null;
    #readbackLease: ByteLease | null = null;

    constructor(private readonly options: Webgl2CoverageOptions) {
        this.#resources = new Webgl2CoverageResources({ generation: options.generation, gl: options.gl, memory: options.memory,
            completed: serial => serial <= this.#completed, schedulePoll: options.schedulePoll, reset: options.reset,
            onDrained: () => this.#notify() });
    }

    get drained(): boolean { return this.#closed && this.#tickets.size === 0 && this.#resources.drained; }

    prepare(width: number, height: number): boolean {
        if (this.#closed || this.#broken) return false;
        const programs = this.options.programs();
        if (!programs) return false;
        if (!this.#readback) {
            const lease = this.options.cpuMemory?.reserve(16) ?? null;
            if (this.options.cpuMemory && (!lease || lease.bytes < 16)) {
                if (lease) this.options.cpuMemory.release(lease);
                return false;
            }
            try { this.#readback = new Uint32Array(4); this.#readbackLease = lease; }
            catch (error) { if (lease) this.options.cpuMemory!.release(lease); throw error; }
        }
        const gl = this.options.gl();
        const uniforms = (program: WebGLProgram): ProgramUniforms | null => {
            const source = gl.getUniformLocation(program, 'u_source');
            const size = gl.getUniformLocation(program, 'u_sourceSize');
            return source && size ? { program, source, size } : null;
        };
        const classify = uniforms(programs.classify), reduce = uniforms(programs.reduce);
        if (!classify || !reduce || !this.#resources.prepare(width, height)) return false;
        this.#prepared = { width, height, classify, reduce };
        return true;
    }

    enqueue(sourceR8: WebGLTexture, width: number, height: number, frameTag: CoverageFrameTag):
        { commit(): void; cancel(): void; retireAfter?(completed: () => boolean): void } | null {
        const prepared = this.#prepared, programs = this.options.programs();
        if (this.#closed || this.#broken || !prepared || !programs || prepared.width !== width || prepared.height !== height ||
            programs.classify !== prepared.classify.program || programs.reduce !== prepared.reduce.program) return null;
        const tag: CoverageResultTag = Object.freeze({ ...frameTag, token: Object.freeze({ ...frameTag.token }), width, height });
        let slot = 0;
        while (this.#slots.has(slot) && slot < 8) slot++;
        if (slot === 8) {
            let decided = false;
            return { commit: () => { if (!decided) { decided = true; this.options.onDrop(tag); } }, cancel: () => { decided = true; } };
        }
        const gl = this.options.gl();
        const frame = this.#resources.begin();
        const read = this.#resources.begin();
        let issued = false;
        try {
            const levels = this.#resources.levels(frame);
            const pack = this.#resources.pack(frame, slot);
            this.#resources.pack(read, slot);
            gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.STENCIL_TEST);
            gl.disable(gl.SCISSOR_TEST); gl.disable(gl.CULL_FACE); gl.disable(gl.RASTERIZER_DISCARD);
            gl.bindVertexArray(null);
            gl.colorMask(true, true, true, true);
            gl.activeTexture(gl.TEXTURE0);
            let source = sourceR8, sourceWidth = width, sourceHeight = height;
            for (let i = 0; i < levels.length; i++) {
                const level = levels[i], program = i === 0 ? prepared.classify : prepared.reduce;
                gl.bindFramebuffer(gl.FRAMEBUFFER, level.framebuffer);
                gl.viewport(0, 0, level.width, level.height);
                gl.useProgram(program.program);
                gl.bindTexture(gl.TEXTURE_2D, source);
                gl.uniform1i(program.source, 0);
                gl.uniform2i(program.size, sourceWidth, sourceHeight);
                gl.drawArrays(gl.TRIANGLES, 0, 3);
                issued = true;
                source = level.texture; sourceWidth = level.width; sourceHeight = level.height;
            }
            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pack);
            gl.readPixels(0, 0, 1, 1, gl.RGBA_INTEGER, gl.UNSIGNED_INT, 0);
            let fence: WebGLSync | null = null;
            try { fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); } catch { /* The owner can provide a later submission fence. */ }
            if (!fence) this.#broken = true;
            gl.flush();
            const serial = ++this.#serial;
            this.#resources.submit(frame, serial);
            const ticket: Ticket = { tag, serial, fence, pack, read, slot, decision: 'pending', counts: null, done: false, failed: !fence, proof: null };
            this.#slots.add(slot); this.#tickets.add(ticket);
            this.#ensurePoll();
            return {
                commit: () => this.#decide(ticket, 'committed'),
                cancel: () => this.#decide(ticket, 'cancelled'),
                retireAfter: completed => { if (!ticket.done) { ticket.proof = completed; this.#ensurePoll(); } },
            };
        } catch (error) {
            // After any GPU command, an absent fence cannot prove either encoding safe to release.
            if (!issued) { this.#resources.cancel(frame); this.#resources.cancel(read); }
            else this.#broken = true;
            throw error;
        } finally { this.options.reset(); }
    }

    dispose(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#prepared = null;
        for (const ticket of this.#tickets) {
            ticket.decision = 'cancelled';
            if (ticket.done) this.#publish(ticket);
        }
        this.#releaseReadback();
        this.#resources.dispose();
        this.#ensurePoll();
        this.#notify();
    }

    abandon(): void {
        this.#closed = true; this.#prepared = null;
        this.#poll?.(); this.#poll = null;
        this.#tickets.clear(); this.#slots.clear();
        this.#releaseReadback();
        this.#resources.abandon();
        this.#notify();
    }

    #decide(ticket: Ticket, decision: 'committed' | 'cancelled'): void {
        if (ticket.decision !== 'pending') return;
        ticket.decision = decision;
        if (ticket.failed && decision === 'committed' && !this.#closed) {
            this.options.onDrop(ticket.tag);
            ticket.decision = 'cancelled';
        }
        if (ticket.done) this.#publish(ticket);
    }

    #publish(ticket: Ticket): void {
        if (ticket.decision === 'pending') return;
        this.#tickets.delete(ticket);
        if (!this.#closed && ticket.decision === 'committed' && ticket.counts && this.#readback) {
            const counts = ticket.counts;
            this.#readback[0] = counts.outside; this.#readback[1] = counts.hole;
            this.#readback[2] = counts.standin; this.#readback[3] = counts.current;
            this.options.onCount(ticket.tag, this.#readback);
        }
        this.#notify();
    }

    #ensurePoll(): void {
        if (this.#poll || ![...this.#tickets].some(ticket => !ticket.done && (!ticket.failed || ticket.proof))) return;
        this.#poll = this.options.schedulePoll(() => this.#collect());
    }

    #collect(): void {
        const gl = this.options.gl();
        try {
            for (const ticket of this.#tickets) {
                if (ticket.done) continue;
                if (ticket.failed) {
                    let completed = false;
                    try { completed = ticket.proof?.() === true; } catch { /* Keep the charge until real proof or loss. */ }
                    if (!completed) continue;
                    this.#completed = Math.max(this.#completed, ticket.serial);
                    if (ticket.fence) gl.deleteSync(ticket.fence);
                    this.#resources.cancel(ticket.read);
                    this.#slots.delete(ticket.slot);
                    ticket.done = true;
                    this.#publish(ticket);
                    continue;
                }
                let status: number;
                try { status = gl.clientWaitSync(ticket.fence!, 0, 0); }
                catch { status = gl.WAIT_FAILED; }
                if (status === gl.WAIT_FAILED) {
                    ticket.failed = true;
                    if (ticket.decision === 'committed' && !this.#closed) {
                        this.options.onDrop(ticket.tag);
                        ticket.decision = 'cancelled';
                    }
                    continue;
                }
                if (status !== gl.ALREADY_SIGNALED && status !== gl.CONDITION_SATISFIED) continue;
                this.#completed = Math.max(this.#completed, ticket.serial);
                if (!this.#closed && ticket.decision !== 'cancelled') {
                    try {
                        const counts = this.#readback!;
                        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, ticket.pack);
                        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, counts);
                        if (gl.getError() !== gl.NO_ERROR) ticket.failed = true;
                        else ticket.counts = { outside: counts[0], hole: counts[1], standin: counts[2], current: counts[3] };
                    } catch { ticket.failed = true; }
                }
                if (ticket.fence) gl.deleteSync(ticket.fence);
                this.#resources.cancel(ticket.read);
                this.#slots.delete(ticket.slot);
                ticket.done = true;
                if (ticket.failed && ticket.decision === 'committed' && !this.#closed) {
                    this.options.onDrop(ticket.tag);
                    ticket.decision = 'cancelled';
                }
                this.#publish(ticket);
            }
        } finally { this.options.reset(); }
        if (![...this.#tickets].some(ticket => !ticket.done && (!ticket.failed || ticket.proof))) { this.#poll?.(); this.#poll = null; }
        this.#notify();
    }

    #releaseReadback(): void {
        this.#readback = null;
        if (this.#readbackLease) this.options.cpuMemory!.release(this.#readbackLease);
        this.#readbackLease = null;
    }

    #notify(): void {
        if (this.drained && !this.#notified) { this.#notified = true; this.options.onDrained?.(); }
    }
}
