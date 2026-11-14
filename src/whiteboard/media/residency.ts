import type { ByteLease } from '../../platform/render/gfx/api';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { RenderToken } from '../../platform/render/types';
import { MEDIA_MIMES, type MediaId, type MediaMime } from '../model/media';
import { checkMediaBytes } from '../security/limits';
import type { PaintImageLease, PaintImageProvider } from '../render/resources';
import { boardWorker } from '../workers/client';
import { matchingIdentity, type BoardJobIdentity } from '../workers/protocol';
import { mediaRasterGeometry, parseMediaTileKey } from './mips';
import { createSvgAdmissionProfile, rasterSvgInProfile } from './svgProfile';
import { svgFrameFactory } from './svgFrameHost';
import { svgParseBudget } from './svgBudget';

export interface MediaRasterSource {
    readonly blob: Blob;
    readonly mime: MediaMime;
    readonly width: number;
    readonly height: number;
    readonly animated: boolean;
}
export interface MediaResidencyHost {
    readonly memory: MemoryAllocator;
    /** Local session bytes only, previously admitted and hash-verified; never fetch a URL. */
    source(id: MediaId, signal: AbortSignal): Promise<MediaRasterSource | null>;
    identity(token: RenderToken): BoardJobIdentity;
    isCurrent(token: RenderToken, identity: BoardJobIdentity): boolean;
    onAnimationFrame?(id: MediaId, frame: number, durationMs: number, frameCount: number): void;
}
interface Cached {
    readonly bitmap: ImageBitmap;
    readonly memory: ByteLease;
    readonly token: RenderToken;
    readonly identity: BoardJobIdentity;
    readonly durationMs: number;
    readonly frameCount: number;
    refs: number;
    retired: boolean;
    closed: boolean;
}
interface Pending {
    readonly key: string;
    readonly token: RenderToken;
    readonly identity: BoardJobIdentity;
    readonly controller: AbortController;
    readonly promise: Promise<Cached>;
    resolve(value: Cached): void;
    reject(error: unknown): void;
    workerRequest?: Promise<unknown>;
}

export class MediaResidency implements PaintImageProvider {
    private readonly cache = new Map<string, Cached>();
    private readonly pending = new Map<string, Pending>();
    private readonly queue: Pending[] = [];
    private readonly svgBytes = new Map<MediaId, number>();
    private active = 0;
    private visible = true;
    private disposed = false;
    private wanted: ReadonlySet<string> | null = null;
    private near: ReadonlySet<string> = new Set();
    private readonly worker = boardWorker('decode');
    constructor(private readonly host: MediaResidencyHost) {}

    acquire(imageKey: string, token: RenderToken, signal: AbortSignal): Promise<PaintImageLease> {
        if (signal.aborted) return Promise.reject(signal.reason);
        if (!this.visible || this.disposed) return Promise.reject(new DOMException('Pane hidden', 'AbortError'));
        parseMediaTileKey(imageKey);
        const identity = this.host.identity(token);
        if (!this.host.isCurrent(token, identity)) return Promise.reject(new DOMException('Stale media request', 'AbortError'));
        let cached = this.cache.get(imageKey);
        if (cached && (!matchingIdentity(cached.identity, identity) || !sameToken(cached.token, token))) {
            this.drop(imageKey, cached);
            cached = undefined;
        }
        const work = cached && !cached.closed ? Promise.resolve(cached) : this.queueDecode(imageKey, token, identity);
        return new Promise((resolve, reject) => {
            let done = false;
            const abort = () => { if (!done) { done = true; reject(signal.reason ?? new DOMException('Media request cancelled', 'AbortError')); } };
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
            void work.then(entry => {
                if (done) return;
                done = true; signal.removeEventListener('abort', abort);
                if (entry.closed || !this.visible || !this.host.isCurrent(token, identity)) { reject(new DOMException('Stale media result', 'AbortError')); return; }
                entry.refs++;
                const tile = parseMediaTileKey(imageKey);
                try {
                    if (entry.durationMs > 0) this.host.onAnimationFrame?.(tile.id, tile.frame, entry.durationMs, entry.frameCount);
                } catch (error) { entry.refs--; reject(error); return; }
                let held = true;
                resolve({ source: entry.bitmap, width: entry.bitmap.width, height: entry.bitmap.height, cpuBytes: 0,
                    release: () => {
                        if (!held) return;
                        held = false; entry.refs--;
                        if (!entry.refs && (entry.retired || this.wanted && !this.wanted.has(imageKey))) this.drop(imageKey, entry);
                    } });
            }, error => {
                if (done) return;
                done = true; signal.removeEventListener('abort', abort); reject(error);
            });
        });
    }

    /** Called from visibility planning, not from paint. Near keys get the coarser mip. */
    setDemand(visible: ReadonlySet<string>, near: ReadonlySet<string>): void {
        this.wanted = new Set([...visible, ...near]);
        this.near = new Set(near);
        for (const [key, entry] of this.cache) if (!this.wanted.has(key) && !entry.refs) this.drop(key, entry);
        for (const [key, job] of this.pending) {
            if (!this.wanted.has(key)) job.controller.abort();
            else if (job.workerRequest) this.worker.reprioritise(job.workerRequest, visible.has(key) ? 0 : 2);
        }
        this.queue.sort((a, b) => Number(this.near.has(a.key)) - Number(this.near.has(b.key)));
    }

    setVisible(visible: boolean): void {
        if (this.disposed || this.visible === visible) return;
        this.visible = visible;
        if (!visible) {
            for (const job of this.pending.values()) job.controller.abort();
            // Termination is synchronous even when the replacement worker starts later.
            if (this.active) void this.worker.recycle('pane hidden').catch(() => undefined);
            // A cancelled frame may still own decoder scratch until its promise actually settles.
            for (const [key, entry] of this.cache) this.drop(key, entry);
        }
    }

    evict(bytes: number): void {
        for (const [key, entry] of this.cache) {
            if (bytes <= 0) break;
            if (entry.refs) continue;
            bytes -= entry.bitmap.width * entry.bitmap.height * 4;
            this.drop(key, entry);
        }
    }

    dispose(): void { if (!this.disposed) { this.setVisible(false); this.svgBytes.clear(); this.disposed = true; } }

    private drop(key: string, entry: Cached): void {
        if (entry.closed) return;
        entry.retired = true;
        if (this.cache.get(key) === entry) this.cache.delete(key);
        // An in-flight capture owns its image lease even after the pane becomes hidden.
        if (entry.refs) return;
        entry.closed = true;
        entry.bitmap.close();
        this.host.memory.release(entry.memory);
    }

    private queueDecode(key: string, token: RenderToken, identity: BoardJobIdentity): Promise<Cached> {
        const previous = this.pending.get(key);
        if (previous && !previous.controller.signal.aborted && matchingIdentity(previous.identity, identity)
            && sameToken(previous.token, token) && this.host.isCurrent(previous.token, previous.identity)) return previous.promise;
        previous?.controller.abort();
        const controller = new AbortController();
        let resolve!: (entry: Cached) => void, reject!: (error: unknown) => void;
        const promise = new Promise<Cached>((yes, no) => { resolve = yes; reject = no; });
        const job: Pending = { key, token, identity, controller, promise, resolve, reject };
        this.pending.set(key, job);
        if (this.near.has(key)) this.queue.push(job);
        else {
            const index = this.queue.findIndex(item => this.near.has(item.key));
            this.queue.splice(index < 0 ? this.queue.length : index, 0, job);
        }
        this.pump();
        return promise;
    }

    private pump(): void {
        while (this.active < 2 && this.queue.length) {
            const job = this.queue.shift()!;
            if (job.controller.signal.aborted) {
                if (this.pending.get(job.key) === job) this.pending.delete(job.key);
                job.reject(new DOMException('Media request cancelled', 'AbortError'));
                continue;
            }
            this.active++;
            void this.decode(job).then(job.resolve, job.reject).finally(() => {
                this.active--;
                if (this.pending.get(job.key) === job) this.pending.delete(job.key);
                this.pump();
            });
        }
    }

    private async decode(job: Pending): Promise<Cached> {
        const signal = job.controller.signal;
        const current = () => !signal.aborted && this.visible && !this.disposed
            && (!this.wanted || this.wanted.has(job.key)) && this.host.isCurrent(job.token, job.identity);
        const source = await this.host.source(parseMediaTileKey(job.key).id, signal);
        if (!current()) throw new DOMException('Stale media request', 'AbortError');
        if (!source) throw new Error('Missing picture');
        if (!MEDIA_MIMES.includes(source.mime) || !source.mime.startsWith('image/') || typeof source.animated !== 'boolean'
            || !checkMediaBytes(source.blob.size, source.mime === 'image/svg+xml' ? 'svg' : 'raster').ok) throw new Error('Invalid picture source');
        const tile = parseMediaTileKey(job.key);
        const geometry = mediaRasterGeometry(tile, source.width, source.height);
        const outputBytes = 4 * geometry.width * geometry.height;
        let intermediate = source.animated ? 4 * source.width * source.height : 0;
        if (source.mime === 'image/svg+xml') {
            let bytes = this.svgBytes.get(tile.id);
            if (bytes === undefined) {
                const parsing = this.host.memory.reserve(svgParseBudget(source.blob.size));
                if (!parsing) throw new Error('Not enough memory to inspect this SVG');
                try {
                    const typed = source.blob.slice(0, source.blob.size, 'image/svg+xml');
                    const passed = await this.worker.request<boolean>('svgPreflight', { blob: typed }, job.identity,
                        { priority: 1, deadlineMs: 5000, signal }, () => current());
                    if (passed !== true) throw new Error('Invalid SVG preflight response');
                    const profile = createSvgAdmissionProfile(svgFrameFactory, job.identity, () => current());
                    const dimensions = await profile.header(typed, AbortSignal.any([signal, AbortSignal.timeout(5000)]));
                    if (!current()) throw new DOMException('Stale media request', 'AbortError');
                    if (dimensions.width !== source.width || dimensions.height !== source.height) throw new Error('SVG dimensions do not match admitted media');
                    bytes = dimensions.rgbaBytes;
                    this.svgBytes.set(tile.id, bytes);
                } finally { this.host.memory.release(parsing); }
            }
            intermediate = bytes;
        }
        const memory = this.host.memory.reserve(outputBytes);
        if (!memory) throw new Error('Not enough memory to decode this picture');
        const scratch = intermediate ? this.host.memory.reserve(intermediate) : null;
        if (intermediate && !scratch) {
            this.host.memory.release(memory);
            throw new Error('Not enough memory to decode this picture');
        }
        const svgScratch = source.mime === 'image/svg+xml' ? this.host.memory.reserve(svgParseBudget(source.blob.size)) : null;
        if (source.mime === 'image/svg+xml' && !svgScratch) {
            this.host.memory.release(memory); if (scratch) this.host.memory.release(scratch);
            throw new Error('Not enough memory to rasterize this SVG');
        }
        let outputHeld = true, scratchHeld = !!scratch, svgHeld = !!svgScratch;
        const releaseMemory = () => {
            if (outputHeld) { outputHeld = false; this.host.memory.release(memory); }
            if (scratchHeld && scratch) { scratchHeld = false; this.host.memory.release(scratch); }
            if (svgHeld && svgScratch) { svgHeld = false; this.host.memory.release(svgScratch); }
        };
        let bitmap: ImageBitmap | undefined, durationMs = 0, frameCount = 1;
        try {
            const blob = source.blob.slice(0, source.blob.size, source.mime);
            try {
                const request = this.worker.request<{ bitmap: ImageBitmap; durationMs: number; frameCount: number }>('raster', { blob, mime: source.mime, animated: source.animated, frame: tile.frame,
                    sourceWidth: source.width, sourceHeight: source.height, x: geometry.sourceX, y: geometry.sourceY,
                    width: geometry.sourceWidth, height: geometry.sourceHeight, outputWidth: geometry.width, outputHeight: geometry.height },
                job.identity, { priority: this.near.has(job.key) ? 2 : 0, deadlineMs: 10000, signal }, () => current());
                job.workerRequest = request;
                const result = await request;
                job.workerRequest = undefined;
                bitmap = result.bitmap;
                durationMs = result.durationMs;
                frameCount = result.frameCount;
            } catch (error) {
                job.workerRequest = undefined;
                if (!current()) {
                    // A cancelled native decode may still hold scratch in the shared worker.
                    if (this.visible && !this.disposed) await this.worker.recycle('media raster cancelled').catch(() => undefined);
                    throw error;
                }
                if (source.mime !== 'image/svg+xml') throw error;
                bitmap = await rasterSvgInProfile(svgFrameFactory, blob, source.width, source.height, geometry, job.identity, () => current(), signal);
            }
            if (!current()) throw new DOMException('Stale media result', 'AbortError');
            if (!(bitmap instanceof ImageBitmap) || bitmap.width !== geometry.width || bitmap.height !== geometry.height
                || !Number.isFinite(durationMs) || durationMs < 0 || !Number.isSafeInteger(frameCount) || frameCount < 1) throw new Error('Invalid media raster');
            const existing = this.cache.get(job.key);
            if (existing && !existing.closed && matchingIdentity(existing.identity, job.identity) && sameToken(existing.token, job.token)) {
                bitmap.close(); releaseMemory(); return existing;
            }
            if (existing) this.drop(job.key, existing);
            const entry: Cached = { bitmap, memory, token: job.token, identity: job.identity, durationMs, frameCount, refs: 0, retired: false, closed: false };
            this.cache.set(job.key, entry);
            outputHeld = false;
            bitmap = undefined;
            return entry;
        } catch (error) {
            bitmap?.close();
            throw error;
        } finally {
            releaseMemory();
        }
    }
}

function sameToken(a: RenderToken, b: RenderToken): boolean {
    return a.vaultEpoch === b.vaultEpoch && a.documentId === b.documentId
        && a.bytesGeneration === b.bytesGeneration && a.session === b.session;
}
