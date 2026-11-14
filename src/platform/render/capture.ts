import type { Rect, ViewState } from '../types';
import type { FrameEncoder, GpuPass } from './gfx/api';
import type { Webgl2Owner } from './gfx/webgl2';
import type { MemoryAllocator } from './memoryGovernor';
import type { Layer, RenderToken } from './types';
import { CaptureError, captureAbort } from './captureError';
import { CaptureQueue } from './captureQueue';

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
    /** Only thumbnails opt into replacement; user/agent captures never supply this key. */
    readonly thumbnailKey?: string;
    /** An explicit writer/export deadline, not an exemption from bounded output. */
    readonly deadlineMs?: number;
}

/** Frozen before acquiring the source lease; independent of the displayed camera. */
export interface CaptureRequest {
    readonly worldRect: Readonly<Rect>;
    readonly view: ViewState;
    readonly layers: readonly string[];
    readonly theme: 'light';
    readonly inverted: false;
    readonly policy: 'exact' | 'allow-standin';
    readonly predictions: false;
    readonly chrome: false;
    readonly unsealedInput: false;
}

/** Uses the stream's ordinary layer paint path, bound to one leased revision.
 * The source adapter removes predictions, selection/chrome and unsealed input,
 * but retains document effects (including per-image inversion). No undo is sealed here.
 */
export interface CapturedLayer {
    readonly id: string;
    readonly draw2d: Layer['draw2d'];
    readonly drawGpu?: Layer['drawGpu'];
}

/** The session retains immutable content/layout and read-only resources under its
 * CPU cap before returning this lease. An edit does not invalidate it; vault switch,
 * document disposal and loss of its resources abort signal. Hide must NOT abort it.
 */
export interface CaptureSnapshot {
    readonly token: RenderToken;
    readonly revision: string;
    readonly signal: AbortSignal;
    readonly layers: readonly CapturedLayer[];
    /** Prepare offscreen tiles, never Layer.prepare's view jobs. Must honor signal;
     * all temporary resources belong to this lease, including late worker arrivals.
     * A missing exact tile is incomplete, never a successful white image.
     */
    prepare(request: CaptureRequest, route: '2d' | 'gpu', signal: AbortSignal): Promise<'exact' | 'standin' | 'incomplete'>;
    /** Idempotent, nonthrowing; closes temporary bitmaps and releases retained resources. */
    release(): void;
}

export type CaptureGpuOwner = Pick<Webgl2Owner, 'resources' | 'acquireTarget' | 'releaseTarget' | 'discardFrame'> & {
    /** Installs the existing compositor's frame-scoped LayerHost services for this offscreen pass. */
    readonly withCapturePass?: (encoder: FrameEncoder, pass: GpuPass, view: ViewState, paint: () => void) => void;
};

export interface PaneCapturerOptions {
    readonly paneId: string;
    /** Exactly one queue per App, shared by all pane instances. */
    readonly queue: CaptureQueue;
    /** CPU capture cache allocator from the governor; source leases are charged separately. */
    readonly memory: MemoryAllocator;
    /** Synchronous revision + render-plan snapshot and resource/read lease; never reads live
     * bindings later. Reject if any requested layer is unavailable or is presentation-only.
     */
    snapshot(request: CaptureRequest): CaptureSnapshot;
    /** Optional opt-in only while the pane's EXISTING owner is current and healthy,
     * and capture will not delay input. Null/default selects 2D; never create a context.
     */
    tryGpu?(snapshot: CaptureSnapshot): CaptureGpuOwner | null;
}

interface CaptureScope {
    readonly signal: AbortSignal;
    check(): void;
    link(signal: AbortSignal, code: 'aborted' | 'disposed'): void;
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
            if (signal.aborted) abort();
            else {
                signal.addEventListener('abort', abort, { once: true });
                detach.push(() => signal.removeEventListener('abort', abort));
            }
        },
        dispose: () => { clearTimeout(timer); detach.forEach(remove => remove()); },
    };
}

function requestFor(rect: Rect, maxSidePx: number, options: CaptureOptions): CaptureRequest {
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
    // Reject rather than silently resize: exact exports negotiate bands with their stream (§4.6).
    const scale = Math.min(maxSidePx / rect.width, maxSidePx / rect.height);
    const width = Math.max(1, Math.ceil(rect.width * scale)), height = Math.max(1, Math.ceil(rect.height * scale));
    if (!Number.isFinite(scale) || scale <= 0 || !Number.isFinite(rect.x * scale) || !Number.isFinite(rect.y * scale)) {
        throw new CaptureError('invalid-input');
    }
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width > maxAxisPixels || height > maxAxisPixels || width * height > maxPixels) {
        throw new CaptureError('too-large');
    }
    const view = Object.freeze({
        camera: Object.freeze({ x: rect.x, y: rect.y, z: scale }),
        viewport: Object.freeze({ width, height, dpr: 1 }), epoch: 0, moving: false,
    });
    return Object.freeze({
        worldRect: Object.freeze({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }),
        view, layers: Object.freeze([...options.layers]), theme: 'light', inverted: false,
        policy: options.policy ?? 'exact', predictions: false, chrome: false, unsealedInput: false,
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

/** Session-bound delegate for compositor.captureRegion (C4.5; design §4.6).
 * Neither route samples the displayed surface or creates a GPU context. Dispose on
 * document/vault disposal, not pane-hide; awaited session captures survive hiding.
 */
export class PaneCapturer {
    private readonly lifetime = new AbortController();

    constructor(private readonly options: PaneCapturerOptions) {
        if (!options.paneId) throw new CaptureError('invalid-input');
    }

    captureRegion(worldRect: Rect, maxSidePx: number, options: CaptureOptions): Promise<ImageBitmap> {
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
            operation.link(snapshot.signal, 'disposed');
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
            const release = () => {
                if (released) return;
                released = true;
                try { lease.release(); } finally { active.dispose(); }
            };
            return this.options.queue.run(this.options.paneId, active.signal, async () => {
                started = true;
                try { return await this.render(request, lease, layers, active); }
                finally { release(); }
            }, options.thumbnailKey).finally(() => {
                // An active abort may reject before prepare/readback has unwound. The
                // active work, not this caller's promise, owns its resources until then.
                if (!started) release();
            });
        } catch (error) {
            try { snapshot?.release(); } finally { operation?.dispose(); }
            return Promise.reject(renderError(error));
        }
    }

    dispose(): void { this.lifetime.abort(new CaptureError('disposed')); }

    private async prepare(request: CaptureRequest, snapshot: CaptureSnapshot, route: '2d' | 'gpu', active: CaptureScope): Promise<void> {
        active.check();
        const completeness = await snapshot.prepare(request, route, active.signal);
        active.check();
        if (completeness !== 'exact' && !(request.policy === 'allow-standin' && completeness === 'standin')) throw new CaptureError('incomplete');
    }

    private async render(request: CaptureRequest, snapshot: CaptureSnapshot, layers: readonly CapturedLayer[], active: CaptureScope): Promise<ImageBitmap> {
        try {
            active.check();
            const owner = layers.every(layer => layer.drawGpu) ? this.options.tryGpu?.(snapshot) : null;
            if (owner?.withCapturePass) {
                try {
                    await this.prepare(request, snapshot, 'gpu', active);
                    return await this.drawGpu(request, layers, owner, active);
                } catch (error) {
                    active.check();
                    // Retry this SAME retained revision once. A GPU budget refusal also
                    // uses the default CPU route; neither path asks the broker for a slot.
                    if (!hasCode(error, 'lost') && !hasCode(error, 'out-of-budget')) throw error;
                }
            }
            await this.prepare(request, snapshot, '2d', active);
            return await this.draw2d(request, layers, active);
        } catch (error) {
            active.check();
            throw renderError(error);
        }
    }

    private async draw2d(request: CaptureRequest, layers: readonly CapturedLayer[], active: CaptureScope): Promise<ImageBitmap> {
        const { width, height } = request.view.viewport;
        // Canvas backing and its snapshot can coexist. The returned bitmap becomes
        // caller-owned; only our temporary storage is charged to this operation.
        const memory = this.options.memory.reserve(width * height * 8);
        if (!memory) throw new CaptureError('out-of-budget');
        let canvas: HTMLCanvasElement | null = null, bitmap: ImageBitmap | null = null;
        try {
            active.check();
            canvas = document.createElement('canvas');
            canvas.width = width; canvas.height = height;
            const ctx = canvas.getContext('2d', { alpha: true, colorSpace: 'srgb' });
            if (!ctx) throw new CaptureError('render-failed');
            for (const layer of layers) {
                active.check();
                ctx.save();
                try { layer.draw2d(ctx, request.view); } finally { ctx.restore(); }
            }
            // This checks origin cleanliness without reading back an entire capture.
            ctx.getImageData(0, 0, 1, 1);
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
                owner.withCapturePass!(encoder, pass, request.view, () => {
                    for (const layer of layers) { active.check(); layer.drawGpu!(pass, request.view); }
                });
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
