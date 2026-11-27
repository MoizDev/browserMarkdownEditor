import type { Rect, ViewState } from '../types';
import type { FrameEncoder, GpuPass } from './gfx/api';
import type { Webgl2Owner } from './gfx/webgl2';
import type { MemoryAllocator } from './memoryGovernor';
import type { Layer, RenderToken } from './types';
import type { IsolationReservation } from './compositor.types';
import { CaptureError, captureAbort } from './captureError';
import { CaptureQueue } from './captureQueue';
import { captureIsolation2d } from './captureIsolation2d';
import { renderCaptureExport } from './captureExport';
import type { CaptureExportOptions, CapturePngEncoder } from './captureExport';
export type { CaptureExportOptions, CaptureExportTile, CaptureExportRenderer, CapturePngEncoder } from './captureExport';

export { CaptureError } from './captureError';
export type { CaptureErrorCode } from './captureError';
export { CaptureQueue } from './captureQueue';

const defaultDeadlineMs = 15000;
const maxAxisPixels = 4096;
const maxPixels = 16 * 1024 * 1024;

export interface CaptureOptions {
    readonly layers: readonly string[];
    readonly theme: 'light';
    readonly inverted: false;
    readonly signal?: AbortSignal;
    readonly policy?: 'exact' | 'allow-standin';
    readonly thumbnailKey?: string;
    readonly deadlineMs?: number;
}

export interface CaptureRequest {
    readonly worldRect: Readonly<Rect>;
    readonly view: ViewState;
    readonly layers: readonly string[];
    readonly theme: 'light';
    readonly inverted: false;
    readonly policy: 'exact' | 'allow-standin';
    readonly chrome: false;
    readonly unsealedInput: false;
}

export interface CapturedLayer {
    readonly id: string;
    readonly draw2d: Layer['draw2d'];
    readonly drawGpu?: Layer['drawGpu'];
}

export interface CaptureSnapshot {
    readonly token: RenderToken;
    readonly revision: string;
    readonly signal: AbortSignal;
    readonly layers: readonly CapturedLayer[];
    readonly isolation?: readonly IsolationReservation[];
    prepare(request: CaptureRequest, route: '2d' | 'gpu', signal: AbortSignal): Promise<'exact' | 'standin' | 'incomplete'>;
    prepareTile?(request: CaptureRequest, signal: AbortSignal): Promise<'exact' | 'standin' | 'incomplete'>;
    release(): void | Promise<void>;
}

export type CaptureGpuOwner = Pick<Webgl2Owner, 'resources' | 'acquireTarget' | 'releaseTarget' | 'discardFrame'> & {
    readonly prepareIsolation?: (view: ViewState, inventory: readonly IsolationReservation[]) => boolean;
    readonly withCapturePass?: (encoder: FrameEncoder, pass: GpuPass, view: ViewState, paint: (scope: GpuPass) => void) => void;
};

export interface PaneCapturerOptions {
    readonly paneId: string;
    readonly queue: CaptureQueue;
    readonly memory: MemoryAllocator;
    snapshot(request: CaptureRequest): CaptureSnapshot;
    tryGpu?(snapshot: CaptureSnapshot): CaptureGpuOwner | null;
    readonly encodePngTiles?: CapturePngEncoder;
}

type CaptureOutput = ImageBitmap | Blob;
type CaptureOutputKind = 'bitmap' | 'png';

function frozenIsolation(snapshot: CaptureSnapshot): readonly IsolationReservation[] {
    return Object.freeze((snapshot.isolation ?? []).map(item => Object.freeze({ ...item,
        bounds: Object.freeze({ ...item.bounds }), targets: item.targets ? Object.freeze({ ...item.targets,
            bounds: Object.freeze({ ...item.targets.bounds }) }) : undefined })));
}

interface CaptureScope {
    readonly signal: AbortSignal;
    check(): void;
    link(signal: AbortSignal, code: 'aborted' | 'disposed'): () => void;
    dispose(): void;
}

function scope(deadlineMs: number): CaptureScope {
    const controller = new AbortController(), detach: (() => void)[] = [];
    const deadline = performance.now() + deadlineMs;
    const timer = setTimeout(() => controller.abort(new CaptureError('timeout')), deadlineMs);
    return {
        signal: controller.signal,
        check: () => {
            if (performance.now() >= deadline && !controller.signal.aborted) controller.abort(new CaptureError('timeout'));
            if (controller.signal.aborted) throw captureAbort(controller.signal);
        },
        link: (signal, code) => {
            const abort = () => controller.abort(new CaptureError(code));
            const unlink = () => signal.removeEventListener('abort', abort);
            if (signal.aborted) abort();
            else {
                signal.addEventListener('abort', abort, { once: true });
                detach.push(unlink);
            }
            return unlink;
        },
        dispose: () => { clearTimeout(timer); detach.forEach(remove => remove()); },
    };
}

function requestFor(rect: Rect, maxSidePx: number, options: CaptureOptions,
    limits = { axis: maxAxisPixels, pixels: maxPixels }): CaptureRequest {
    if (!rect || ![rect.x, rect.y, rect.width, rect.height, maxSidePx].every(Number.isFinite) ||
        rect.width <= 0 || rect.height <= 0 || maxSidePx <= 0 ||
        !Number.isFinite(rect.x + rect.width) || !Number.isFinite(rect.y + rect.height) ||
        options.theme !== 'light' || options.inverted !== false ||
        (options.policy !== undefined && options.policy !== 'exact' && options.policy !== 'allow-standin') ||
        !Array.isArray(options.layers) || options.layers.some(id => typeof id !== 'string' || !id) ||
        new Set(options.layers).size !== options.layers.length ||
        (options.thumbnailKey !== undefined && (typeof options.thumbnailKey !== 'string' || !options.thumbnailKey))) {
        throw new CaptureError('invalid-input');
    }
    const scale = Math.min(maxSidePx / rect.width, maxSidePx / rect.height);
    const width = Math.max(1, Math.ceil(rect.width * scale)), height = Math.max(1, Math.ceil(rect.height * scale));
    if (!Number.isFinite(scale) || scale <= 0 || !Number.isFinite(rect.x * scale) || !Number.isFinite(rect.y * scale)) {
        throw new CaptureError('invalid-input');
    }
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width > limits.axis || height > limits.axis || width * height > limits.pixels) {
        throw new CaptureError('too-large');
    }
    const view = Object.freeze({
        camera: Object.freeze({ x: rect.x, y: rect.y, z: scale }),
        viewport: Object.freeze({ width, height, dpr: 1 }), epoch: 0, moving: false,
    });
    return Object.freeze({
        worldRect: Object.freeze({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }),
        view, layers: Object.freeze([...options.layers]), theme: 'light', inverted: false,
        policy: options.policy ?? 'exact', chrome: false, unsealedInput: false,
    });
}

function renderError(error: unknown): CaptureError {
    if (error instanceof CaptureError) return error;
    if (error instanceof DOMException && error.name === 'SecurityError') return new CaptureError('not-origin-clean', { cause: error });
    if (hasCode(error, 'out-of-budget')) return new CaptureError('out-of-budget', { cause: error });
    return new CaptureError('render-failed', { cause: error });
}

function hasCode(error: unknown, code: string): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

export class PaneCapturer {
    private readonly lifetime = new AbortController();
    private readonly pending = new Set<Promise<void>>();

    private trackRetirement(): () => void {
        let finish = () => {};
        const retired = new Promise<void>(resolve => { finish = resolve; });
        this.pending.add(retired);
        return () => { this.pending.delete(retired); finish(); };
    }

    constructor(private readonly options: PaneCapturerOptions) {
        if (!options.paneId) throw new CaptureError('invalid-input');
    }

    captureRegion(worldRect: Rect, maxSidePx: number, options: CaptureOptions): Promise<ImageBitmap> {
        return this.capture(worldRect, maxSidePx, options, 'bitmap');
    }

    captureBlob(worldRect: Rect, maxSidePx: number, options: CaptureOptions): Promise<Blob> {
        return this.capture(worldRect, maxSidePx, options, 'png');
    }

    captureExportBlob(worldRect: Rect, maxSidePx: number, options: CaptureExportOptions): Promise<Blob> {
        let active: CaptureScope | null = null, snapshot: CaptureSnapshot | null = null;
        try {
            const encoder = this.options.encodePngTiles;
            if (!encoder) throw new CaptureError('incomplete');
            if ((options.clipboard !== undefined && typeof options.clipboard !== 'boolean')
                || (options.pixelsPerWorldUnit !== undefined && (!Number.isFinite(options.pixelsPerWorldUnit) || options.pixelsPerWorldUnit <= 0))) {
                throw new CaptureError('invalid-input');
            }
            const request = requestFor(worldRect, maxSidePx, options,
                options.clipboard ? { axis: 8192, pixels: 2 ** 28 } : { axis: 65535, pixels: 2 ** 32 });
            const deadline = options.deadlineMs ?? 60_000;
            if (!Number.isFinite(deadline) || deadline <= 0 || deadline > 2147483647) throw new CaptureError('invalid-input');
            active = scope(deadline); active.link(this.lifetime.signal, 'disposed');
            if (options.signal) active.link(options.signal, 'aborted');
            active.check();
            snapshot = this.options.snapshot(request);
            const unlinkSnapshot = active.link(snapshot.signal, 'disposed'); active.check();
            if (!snapshot.prepareTile) throw new CaptureError('incomplete');
            const selected = new Set(request.layers);
            if (snapshot.layers.length !== selected.size || snapshot.layers.some(layer => !selected.delete(layer.id)) || selected.size) {
                throw new CaptureError('incomplete');
            }
            const lease = snapshot, operation = active;
            const layers = Object.freeze(lease.layers.map(layer => Object.freeze({ id: layer.id, draw2d: layer.draw2d.bind(layer) })));
            let started = false, released = false;
            const retire = this.trackRetirement();
            const release = async () => {
                if (released) return; released = true;
                unlinkSnapshot();
                try { await lease.release(); } finally { operation.dispose(); retire(); }
            };
            return this.options.queue.run(this.options.paneId, operation.signal, async () => {
                started = true;
                try {
                    return await renderCaptureExport(request, lease, layers, this.options.memory, encoder,
                        operation.signal, operation.check, options);
                } catch (error) { operation.check(); throw renderError(error); }
                finally { await release(); }
            }).finally(() => { if (!started) void release().catch(() => {}); });
        } catch (error) {
            try { void Promise.resolve(snapshot?.release()).catch(() => {}); } finally { active?.dispose(); }
            return Promise.reject(renderError(error));
        }
    }

    private capture(worldRect: Rect, maxSidePx: number, options: CaptureOptions, output: 'bitmap'): Promise<ImageBitmap>;
    private capture(worldRect: Rect, maxSidePx: number, options: CaptureOptions, output: 'png'): Promise<Blob>;
    private capture(worldRect: Rect, maxSidePx: number, options: CaptureOptions, output: CaptureOutputKind): Promise<CaptureOutput> {
        let operation: CaptureScope | null = null, snapshot: CaptureSnapshot | null = null;
        try {
            const request = requestFor(worldRect, maxSidePx, options);
            const deadline = options.deadlineMs ?? defaultDeadlineMs;
            if (!Number.isFinite(deadline) || deadline <= 0 || deadline > 2147483647) throw new CaptureError('invalid-input');
            operation = scope(deadline);
            operation.link(this.lifetime.signal, 'disposed');
            if (options.signal) operation.link(options.signal, 'aborted');
            operation.check();
            // No await before the session has retained ONE revision and selected render plan.
            snapshot = this.options.snapshot(request);
            const unlinkSnapshot = operation.link(snapshot.signal, 'disposed');
            operation.check();
            const selected = new Set(request.layers);
            if (snapshot.layers.length !== selected.size || snapshot.layers.some(layer => !selected.delete(layer.id)) || selected.size) {
                throw new CaptureError('incomplete');
            }
            const lease = snapshot, active = operation;
            const layers = Object.freeze(snapshot.layers.map(layer => Object.freeze({
                id: layer.id, draw2d: layer.draw2d.bind(layer), drawGpu: layer.drawGpu?.bind(layer),
            })));
            let started = false, released = false;
            const retire = this.trackRetirement();
            const release = async () => {
                if (released) return;
                released = true;
                unlinkSnapshot();
                try { await lease.release(); } finally { active.dispose(); retire(); }
            };
            return this.options.queue.run(this.options.paneId, active.signal, async () => {
                started = true;
                try { return await this.render(request, lease, layers, active, output); }
                finally { await release(); }
            }, options.thumbnailKey).finally(() => {
                if (!started) void release().catch(() => {});
            });
        } catch (error) {
            try { void Promise.resolve(snapshot?.release()).catch(() => {}); } finally { operation?.dispose(); }
            return Promise.reject(renderError(error));
        }
    }

    async dispose(): Promise<void> {
        this.lifetime.abort(new CaptureError('disposed'));
        await Promise.allSettled([...this.pending]);
    }

    private async prepare(request: CaptureRequest, snapshot: CaptureSnapshot, route: '2d' | 'gpu', active: CaptureScope): Promise<void> {
        active.check();
        const completeness = await snapshot.prepare(request, route, active.signal);
        active.check();
        if (completeness !== 'exact' && !(request.policy === 'allow-standin' && completeness === 'standin')) throw new CaptureError('incomplete');
    }

    private async render(request: CaptureRequest, snapshot: CaptureSnapshot, layers: readonly CapturedLayer[],
        active: CaptureScope, output: CaptureOutputKind): Promise<CaptureOutput> {
        try {
            active.check();
            const owner = output === 'bitmap' && layers.every(layer => layer.drawGpu) ? this.options.tryGpu?.(snapshot) : null;
            if (owner?.withCapturePass) {
                try {
                    await this.prepare(request, snapshot, 'gpu', active);
                    // Preparation can yield while the user begins input or the pane changes
                    // generations. Never submit to an owner no longer selected for capture.
                    const current = this.options.tryGpu?.(snapshot);
                    if (current?.withCapturePass && current.resources === owner.resources &&
                        current.prepareIsolation?.(request.view, frozenIsolation(snapshot))) {
                        return await this.drawGpu(request, layers, current, active);
                    }
                } catch (error) {
                    active.check();
                    if (!hasCode(error, 'lost') && !hasCode(error, 'aborted') && !hasCode(error, 'out-of-budget')) throw error;
                }
            }
            await this.prepare(request, snapshot, '2d', active);
            return await this.draw2d(request, layers, active, output);
        } catch (error) {
            active.check();
            throw renderError(error);
        }
    }

    private async draw2d(request: CaptureRequest, layers: readonly CapturedLayer[], active: CaptureScope,
        output: CaptureOutputKind): Promise<CaptureOutput> {
        const { width, height } = request.view.viewport;
        const memory = this.options.memory.reserve(width * height * 8);
        if (!memory) throw new CaptureError('out-of-budget');
        let canvas: HTMLCanvasElement | null = null, bitmap: ImageBitmap | null = null;
        try {
            active.check();
            canvas = document.createElement('canvas');
            canvas.width = width; canvas.height = height;
            const ctx = canvas.getContext('2d', { alpha: true, colorSpace: 'srgb' });
            if (!ctx || ctx.isContextLost()) throw new CaptureError('render-failed');
            captureIsolation2d(ctx, this.options.memory);
            for (const layer of layers) {
                active.check();
                ctx.save();
                try { layer.draw2d(ctx, request.view); } finally { ctx.restore(); }
            }
            if (ctx.isContextLost()) throw new CaptureError('render-failed');
            // This checks origin cleanliness without reading back an entire capture.
            ctx.getImageData(0, 0, 1, 1);
            if (output === 'png') {
                const target = canvas;
                const blob = await new Promise<Blob>((resolve, reject) => target.toBlob(value => {
                    if (value?.size && value.type === 'image/png') resolve(value);
                    else reject(new CaptureError('render-failed'));
                }, 'image/png'));
                active.check();
                return blob;
            }
            bitmap = await createImageBitmap(canvas, { premultiplyAlpha: 'premultiply', colorSpaceConversion: 'none' });
            active.check();
            const result = bitmap; bitmap = null;
            return result;
        } finally {
            bitmap?.close();
            if (canvas) { canvas.width = 0; canvas.height = 0; }
            this.options.memory.release(memory);
        }
    }

    private async drawGpu(request: CaptureRequest, layers: readonly CapturedLayer[], owner: CaptureGpuOwner, active: CaptureScope): Promise<ImageBitmap> {
        const { width, height } = request.view.viewport;
        active.check();
        const target = owner.acquireTarget({ width, height, samples: 1, format: 'rgba8', stencil: false, purpose: 'capture' });
        if (!target) throw new CaptureError('out-of-budget');
        let bitmap: ImageBitmap | null = null;
        try {
            const encoder = owner.resources.beginFrame();
            try {
                const pass: GpuPass = encoder.beginPass({
                    target: target.target, viewport: { x: 0, y: 0, width, height },
                    load: { kind: 'clear', color: [0, 0, 0, 0] }, store: 'store',
                });
                for (const layer of layers) {
                    active.check();
                    owner.withCapturePass!(encoder, pass, request.view, scoped => layer.drawGpu!(scoped, request.view));
                }
                pass.end();
                encoder.submit();
            } catch (error) { owner.discardFrame(encoder); throw error; }
            bitmap = await owner.resources.readTexture(target.texture, { x: 0, y: 0, width, height }, active.signal);
            active.check();
            const result = bitmap; bitmap = null;
            return result;
        } finally {
            bitmap?.close();
            owner.releaseTarget(target);
        }
    }
}
