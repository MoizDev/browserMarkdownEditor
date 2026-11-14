import { benchmarkDeviceContext } from './benchmarkDeviceContext';
import { deviceContext } from './canvas2dContext';
import type { CanvasImageCall } from './canvas2dContext';
import { createCoverageCounter } from './coverageCountClient';
import type { CoverageFrameTag } from './coverageCountClient';
import type { ByteLease, RectI } from './gfx/api';
import type { MemoryAllocator } from './memoryGovernor';
import { recordCoverageDrop, recordCoverageFrame } from './renderPerf';
import type { CoverageFrameTag as PerfTag } from './renderPerf';
import type { ScheduledFrame } from './scheduler';

type Domain = { readonly rects: readonly Readonly<RectI>[]; readonly vector: boolean };
type Kind = 'current' | 'standin' | 'none';
interface Witness {
    readonly canvas: HTMLCanvasElement;
    readonly context: CanvasRenderingContext2D;
    readonly lease: ByteLease;
    invalid: boolean;
}

/** Detached benchmark-only evidence; failure never changes the colour drawing path. */
export class BenchmarkCanvas2D {
    private readonly shadows = new Map<CanvasRenderingContext2D, Witness>();
    private readonly pending = new Map<string, PerfTag[]>();
    private outstanding = 0;
    private disposed = false;
    private readonly counter;

    constructor(private readonly allocators: { working: MemoryAllocator; cpu: MemoryAllocator }) {
        this.counter = createCoverageCounter({ memory: allocators.cpu,
            onCount: result => {
                const tag = this.retire(result.frame);
                if (tag) recordCoverageFrame({ ...tag, outside: result.outside, hole: result.hole,
                    standin: result.standin, current: result.current, invalid: result.invalid });
            },
            onDrop: (frame, reason) => { const tag = this.retire(frame); if (tag) recordCoverageDrop(tag, reason); },
        });
    }

    createContext(native: CanvasRenderingContext2D, origin: { x: number; y: number }, imageCallback: CanvasImageCall): CanvasRenderingContext2D {
        if (!__BME_BENCH__ || this.disposed) return deviceContext(native, origin, imageCallback);
        this.close(native);
        const width = native.canvas.width, height = native.canvas.height, bytes = width * height * 4;
        let lease: ByteLease | null = null;
        let canvas: HTMLCanvasElement | null = null;
        try {
            if (!width || !height || !Number.isSafeInteger(bytes)) return deviceContext(native, origin, imageCallback);
            lease = this.allocators.working.reserve(bytes);
            if (!lease) return deviceContext(native, origin, imageCallback);
            canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
            const context = canvas.getContext('2d', { alpha: true, colorSpace: 'srgb' });
            if (!context || context.isContextLost()) throw new Error('Witness context unavailable');
            const witness: Witness = { canvas, context, lease, invalid: false };
            const virtual = benchmarkDeviceContext(native, origin, imageCallback, context, () => { witness.invalid = true; });
            this.shadows.set(native, witness);
            return virtual;
        } catch {
            if (canvas) { canvas.width = 0; canvas.height = 0; }
            if (lease) this.allocators.working.release(lease);
            return deviceContext(native, origin, imageCallback);
        }
    }

    clear(native: CanvasRenderingContext2D): void {
        const witness = this.shadows.get(native);
        if (!witness) return;
        try {
            const width = witness.canvas.width;
            witness.canvas.width = width;
            witness.invalid = witness.context.isContextLost();
        } catch { witness.invalid = true; }
    }

    begin(native: CanvasRenderingContext2D, domain: Domain): void {
        this.clear(native);
        const witness = this.shadows.get(native);
        if (!witness || witness.invalid) return;
        try {
            const ctx = witness.context;
            ctx.resetTransform(); ctx.beginPath();
            for (const rect of domain.rects) {
                if (![rect.x, rect.y, rect.width, rect.height].every(Number.isSafeInteger) || rect.width < 0 || rect.height < 0) throw new Error('Invalid domain');
                ctx.rect(rect.x, rect.y, rect.width, rect.height);
            }
            ctx.clip(); ctx.fillStyle = '#0000ff'; ctx.fillRect(0, 0, witness.canvas.width, witness.canvas.height);
        } catch { witness.invalid = true; }
    }

    push(native: CanvasRenderingContext2D, localRect: Readonly<RectI>): void {
        const witness = this.shadows.get(native);
        if (!witness || witness.invalid) return;
        try {
            const ctx = witness.context;
            ctx.save(); ctx.resetTransform(); ctx.beginPath(); ctx.rect(localRect.x, localRect.y, localRect.width, localRect.height); ctx.clip();
        } catch { witness.invalid = true; }
    }
    pop(native: CanvasRenderingContext2D): void {
        const witness = this.shadows.get(native);
        if (!witness || witness.invalid) return;
        try { witness.context.restore(); } catch { witness.invalid = true; }
    }

    mark(native: CanvasRenderingContext2D, destRect: Readonly<RectI>, kind: Kind, effectiveAlpha: number): void {
        const witness = this.shadows.get(native);
        if (!witness || witness.invalid || kind === 'none' || effectiveAlpha <= 0) return;
        try {
            if (!Number.isFinite(effectiveAlpha) || ![destRect.x, destRect.y, destRect.width, destRect.height].every(Number.isFinite)) throw new Error('Invalid mark');
            const ctx = witness.context;
            ctx.save();
            try {
                ctx.setTransform(native.getTransform()); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
                ctx.fillStyle = kind === 'current' ? '#ff0000' : '#00ff00';
                ctx.fillRect(destRect.x, destRect.y, destRect.width, destRect.height);
            } finally { ctx.restore(); }
        } catch { witness.invalid = true; }
    }

    copy(dstNative: CanvasRenderingContext2D, srcNative: CanvasRenderingContext2D, sourceRect: Readonly<RectI>, destRect: Readonly<RectI>): void {
        const dst = this.shadows.get(dstNative), src = this.shadows.get(srcNative);
        if (!dst || dst.invalid) return;
        if (!src || src.invalid || src.context.isContextLost()) { dst.invalid = true; return; }
        try {
            const ctx = dst.context;
            ctx.save();
            try {
                ctx.resetTransform(); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.imageSmoothingEnabled = false;
                ctx.drawImage(src.canvas, sourceRect.x, sourceRect.y, sourceRect.width, sourceRect.height,
                    destRect.x, destRect.y, destRect.width, destRect.height);
            } finally { ctx.restore(); }
        } catch { dst.invalid = true; }
    }

    observe(native: CanvasRenderingContext2D, frame: ScheduledFrame, domain: Domain): void {
        if (!__BME_BENCH__ || this.disposed) return;
        const witness = this.shadows.get(native);
        const tag: PerfTag = Object.freeze({ frameId: frame.frameId, token: Object.freeze({ ...frame.token }),
            cameraEpoch: frame.view.epoch, sceneRevision: frame.damage.contentRevision, backend: 'canvas2d',
            width: native.canvas.width, height: native.canvas.height });
        if (!witness || witness.invalid || witness.context.isContextLost() || native.isContextLost() ||
            witness.canvas.width !== tag.width || witness.canvas.height !== tag.height) { recordCoverageDrop(tag, 'invalid'); return; }
        if (this.outstanding >= 8) { recordCoverageDrop(tag, 'overflow'); return; }
        let lease: ByteLease | null = null;
        try {
            if (domain.vector) {
                const ctx = witness.context;
                ctx.save();
                try { ctx.resetTransform(); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
                    ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, tag.width, tag.height); }
                finally { ctx.restore(); }
            }
            const bytes = tag.width * tag.height * 4;
            if (!bytes || !Number.isSafeInteger(bytes)) { recordCoverageDrop(tag, 'invalid'); return; }
            lease = this.allocators.cpu.reserve(bytes);
            if (!lease) { recordCoverageDrop(tag, 'memory'); return; }
            const staging = lease;
            this.outstanding++;
            const capture = createImageBitmap(witness.canvas);
            void capture.then(bitmap => {
                this.allocators.cpu.release(staging);
                if (this.disposed) { bitmap.close(); this.outstanding--; recordCoverageDrop(tag, 'disposed'); return; }
                const key = this.key(tag), queue = this.pending.get(key) ?? [];
                queue.push(tag); this.pending.set(key, queue);
                this.counter.count(bitmap, tag, 'rgb');
            }, () => { this.allocators.cpu.release(staging); this.outstanding--; recordCoverageDrop(tag, 'error'); });
        } catch {
            if (lease) { this.allocators.cpu.release(lease); this.outstanding--; }
            witness.invalid = true; recordCoverageDrop(tag, 'error');
        }
    }

    close(native: CanvasRenderingContext2D): void {
        const witness = this.shadows.get(native);
        if (!witness) return;
        this.shadows.delete(native);
        try { witness.canvas.width = 0; witness.canvas.height = 0; }
        finally { this.allocators.working.release(witness.lease); }
    }
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.counter.dispose();
        for (const native of this.shadows.keys()) this.close(native);
    }
    private key(frame: CoverageFrameTag): string {
        const t = frame.token;
        return JSON.stringify([frame.frameId, frame.cameraEpoch, frame.sceneRevision, t.vaultEpoch, t.documentId,
            t.bytesGeneration, t.session, t.viewLease, t.deviceGeneration]);
    }
    private retire(frame: CoverageFrameTag): PerfTag | undefined {
        const key = this.key(frame), queue = this.pending.get(key), tag = queue?.shift();
        if (queue && !queue.length) this.pending.delete(key);
        if (tag) this.outstanding--;
        return tag;
    }
}
