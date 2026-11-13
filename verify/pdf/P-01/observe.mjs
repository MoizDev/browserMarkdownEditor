// Outside browser observations and a controller for *scratch hold builds only*.
// No app state, function, module or renderer object is read/called by this code.
export async function installPdfObservations(context) {
    await context.addInitScript(() => {
        let sequence = 0, nextCanvas = 0, plan = null;
        const canvases = new Map(), ids = new WeakMap(), events = [];
        const log = (op, fields = {}) => { events.push({ sequence: ++sequence, time: performance.now(), op, ...fields }); };
        const pageOf = canvas => {
            const page = canvas.closest?.('.pdf-viewer-page');
            return page ? [...document.querySelectorAll('.pdf-viewer-page')].indexOf(page) : null;
        };
        const canvasId = canvas => {
            if (!(canvas instanceof HTMLCanvasElement)) return null;
            let id = ids.get(canvas);
            if (!id) {
                id = ++nextCanvas;
                ids.set(canvas, id);
                canvases.set(id, { canvas, id, stack: '', depth: 0, everDisplayed: false, firstSequence: sequence + 1 });
            }
            return id;
        };
        const live = () => [...canvases.values()].map(({ id, canvas, depth }) => ({ id, width: canvas.width, height: canvas.height, depth }));
        const getContext = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
            const result = getContext.call(this, kind, ...args), id = canvasId(this), entry = canvases.get(id);
            if (!entry.stack && kind === '2d' && result) entry.stack = new Error().stack;
            entry.everDisplayed ||= pageOf(this) !== null;
            log('context', { id, kind, ok: Boolean(result), width: this.width, height: this.height, connected: this.isConnected, page: pageOf(this), live: live() });
            return result;
        };
        const proto = CanvasRenderingContext2D.prototype;
        const drawImage = proto.drawImage;
        proto.drawImage = function (source, ...args) {
            const result = drawImage.call(this, source, ...args), canvas = this.canvas;
            const page = pageOf(canvas), id = canvasId(canvas);
            if (page !== null) {
                canvases.get(id).everDisplayed = true;
                const event = { id, source: canvasId(source), page, connected: canvas.isConnected,
                    visibility: getComputedStyle(canvas).visibility, width: canvas.width, height: canvas.height, dpr: devicePixelRatio };
                log('displayBlit', event);
            }
            return result;
        };
        for (const method of ['save', 'restore']) {
            const original = proto[method];
            proto[method] = function (...args) {
                const result = original.apply(this, args), id = canvasId(this.canvas), entry = canvases.get(id);
                entry.depth = Math.max(0, entry.depth + (method === 'save' ? 1 : -1));
                log(method, { id, live: live() });
                return result;
            };
        }
        // Resizing is the browser's backing-store release and also clears its
        // drawing-state stack. Observe the native setter, never change its value.
        for (const axis of ['width', 'height']) {
            const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, axis);
            Object.defineProperty(HTMLCanvasElement.prototype, axis, { ...descriptor,
                set(value) {
                    descriptor.set.call(this, value);
                    const id = ids.get(this);
                    if (id) { canvases.get(id).depth = 0; log('resize', { id, axis, value, live: live() }); }
                },
            });
        }
        const WorkerClass = window.Worker;
        let workerId = 0;
        window.Worker = new Proxy(WorkerClass, {
            construct(Target, args, NewTarget) {
                const worker = Reflect.construct(Target, args, NewTarget), id = ++workerId;
                const message = (direction, data) => {
                    if (!data || typeof data !== 'object') return;
                    log('workerMessage', { worker: id, direction, action: data.action ?? null,
                        stream: data.stream ?? null, streamId: data.streamId ?? null, sourceName: data.sourceName ?? null,
                        targetName: data.targetName ?? null, pageIndex: data.data?.pageIndex ?? null,
                        intent: data.data?.intent ?? null, cacheKey: data.data?.cacheKey ?? null });
                };
                const send = worker.postMessage;
                worker.postMessage = function (data, ...args) { message('out', data); return send.call(this, data, ...args); };
                worker.addEventListener('message', event => message('in', event.data));
                return worker;
            },
        });
        document.addEventListener('scroll', event => {
            const target = event.target;
            if (target instanceof HTMLElement && target.matches('.pdf-viewer-scroll')) log('scroll', { top: target.scrollTop, left: target.scrollLeft });
        }, true);
        window.__d1Hold = (phase, page) => {
            if (!plan || plan.released || phase !== plan.phase || page !== plan.page) return Promise.resolve();
            plan.arrivals++;
            log('hold', { phase, page, arrivals: plan.arrivals });
            if (!plan.promise) plan.promise = new Promise(resolve => { plan.release = resolve; });
            return plan.promise;
        };
        window.__d1Outside = {
            arm(phase, page) {
                if (!['page', 'bind', 'render', 'verify'].includes(phase) || !Number.isInteger(page) || page < 0) throw new Error('Invalid hold arm');
                if (plan && !plan.released) throw new Error('A previous hold is still armed');
                plan = { phase, page, arrivals: 0, released: false, promise: null, release: null };
                log('arm', { phase, page });
                return { sequence };
            },
            release() {
                if (!plan || !plan.arrivals) throw new Error('Requested hold never fired');
                plan.released = true; plan.release(); log('release', { phase: plan.phase, page: plan.page });
            },
            releaseForCleanup() { if (plan && !plan.released) { plan.released = true; plan.release?.(); } },
            mark() { return sequence; },
            snapshot() {
                return { sequence, hold: plan ? { phase: plan.phase, page: plan.page, arrivals: plan.arrivals, released: plan.released } : null,
                    canvases: [...canvases.values()].map(({ canvas, ...entry }) => ({ ...entry, width: canvas.width, height: canvas.height, connected: canvas.isConnected, page: pageOf(canvas) })),
                    events: events.slice() };
            },
        };
    });
}
export const snapshotPdf = page => page.evaluate(() => {
    if (!window.__d1Outside) throw new Error('PDF outside observations were not installed');
    return window.__d1Outside.snapshot();
});
export const releaseForCleanup = page => page.evaluate(() => window.__d1Outside?.releaseForCleanup());
