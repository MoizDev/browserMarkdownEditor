import { createWorkerClient } from '../../platform/workers/client';
import type { Priority, WorkerClient } from '../../platform/workers/envelope';
import { PdfEngineError } from '../engine/types';
import type { DocInfo } from '../engine/types';
import { PDF_ENGINE_PROTOCOL, pdfDocKey } from '../worker/protocol';
import type { PageTileArgs, PageTileResult, PdfArgs, PdfDocKey, PdfEngineOp, PdfResult, PdfWorkerStats } from '../worker/protocol';
import type { RenderToken } from '../../platform/render/types';
import type { WriterOperations } from '../writing/protocol';
import type { PdfDocumentOp, PdfOpenOptions, PdfPageBitmapOptions, PdfPool, PdfPoolDocument, PdfRequestOptions, PdfWriterSession, WithoutDocKey } from './types';
import type { PdfPoolOptions } from './broker.types';
import { TileCredits } from './credits';
import { canSteal, homeWorker, maximumWorkers, poolBudget, recycleCeiling } from './routing';
import { renderPdfPageBitmap } from './bitmap';

type Doc = { key: PdfDocKey; source: 'outer' | 'original'; blob: Blob; password?: string; refs: number; controller: AbortController;
    info?: DocInfo; signature?: string; opening?: Promise<DocInfo>; pending: Set<Promise<unknown>>; leases: Set<Lease>; closing: boolean };
type Slot = { id: number; client: WorkerClient; generation: number; opens: Map<string, Promise<DocInfo>>;
    pages: Set<string>; inFlight: number; heapBytes: number; retiring: boolean; idleAt: number };
type Job = { doc: Doc; lease?: Lease; op: PdfEngineOp; args: Record<string, unknown>; priority: Priority; signal: AbortSignal;
    asked: number; timeoutMs?: number; deadline?: number; controller: AbortController; resolve: (value: unknown) => void; reject: (error: unknown) => void;
    abort: () => void; timer?: ReturnType<typeof setTimeout>; posted?: Promise<unknown>; slot?: Slot; attempts: number; settled: boolean };
const abortError = () => new DOMException('PDF request cancelled', 'AbortError');
const deadlineError = () => new DOMException('PDF request deadline expired', 'TimeoutError');
const pageKey = (key: string, page: number) => `${key}\0${page}`;
let poolSerial = 0;

function validInfo(value: unknown): value is DocInfo {
    if (!value || typeof value !== 'object') return false;
    const info = value as DocInfo;
    return Number.isSafeInteger(info.pageCount) && info.pageCount > 0 && info.pageCount <= 100_000 &&
        Array.isArray(info.pages) && info.pages.length === info.pageCount && info.pages.every((page, index) =>
            page.index === index && Number.isFinite(page.width) && page.width > 0 && Number.isFinite(page.height) && page.height > 0 &&
            [0, 90, 180, 270].includes(page.rotate) && Array.isArray(page.toUserSpace) && page.toUserSpace.length === 6 && page.toUserSpace.every(Number.isFinite)) &&
        Array.isArray(info.attachments) && typeof info.encrypted === 'boolean' && Number.isSafeInteger(info.signatureCount);
}
function validTile(value: unknown, args: PageTileArgs): value is PageTileResult {
    if (!value || typeof value !== 'object') return false;
    const tile = value as PageTileResult;
    return tile.docKey === args.docKey && tile.page === args.page && tile.reqId === args.reqId && tile.scale === args.scale &&
        tile.variant === args.variant && tile.profileKey === args.profileKey && tile.annotations === args.annotations && tile.forms === args.forms &&
        !!tile.rect && tile.rect.x === args.rect.x && tile.rect.y === args.rect.y && tile.rect.w === args.rect.w && tile.rect.h === args.rect.h &&
        tile.w === args.rect.w + 2 && tile.h === args.rect.h + 2 && tile.pixels instanceof ArrayBuffer && tile.pixels.byteLength === tile.w * tile.h * 4 &&
        Number.isFinite(tile.heapBytes) && tile.heapBytes >= 0 && JSON.stringify(tile.emphasis) === JSON.stringify(args.emphasis);
}
function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise<T>((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(abortError()); };
        signal.addEventListener('abort', abort, { once: true });
        void promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    });
}

class Pool implements PdfPool {
    private readonly serial = ++poolSerial;
    private nextSlot = 0;
    private readonly maxWorkers: number;
    private readonly budget: number;
    private readonly docs = new Map<string, Doc>();
    private readonly slots: Slot[] = [];
    private readonly queue: Job[] = [];
    private readonly jobs = new WeakMap<Promise<unknown>, Job>();
    private readonly footprints = new Map<string, number>();
    private readonly deaths = new Map<string, number[]>();
    private readonly pageDeaths = new Map<string, number>();
    private readonly quarantined = new Set<string>();
    private readonly failedDocs = new Set<string>();
    private readonly credits = new TileCredits(() => this.pump());
    private readonly writers = new Set<WorkerClient>();
    private timer?: ReturnType<typeof setInterval>;
    private growth?: ReturnType<typeof setTimeout>;
    private disposed = false;
    private pumping = false;
    private repump = false;

    constructor(private readonly options: PdfPoolOptions) {
        this.maxWorkers = maximumWorkers(options.hardwareConcurrency ?? (typeof navigator === 'undefined' ? undefined : navigator.hardwareConcurrency));
        this.budget = poolBudget(options.deviceMemory ?? (typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { deviceMemory?: number }).deviceMemory));
    }
    private slot(): Slot {
        const id = ++this.nextSlot;
        const client = createWorkerClient({ name: `pdf-render-${this.serial}-${id}`, protocol: PDF_ENGINE_PROTOCOL,
            spawn: () => this.options.broker.spawn('render', id), absoluteMs: 60_000,
            silenceMs: { 0: 20_000, 1: 20_000, 2: 60_000, 3: 60_000 },
            restartPolicy: { delaysMs: [0, 250, 1000, 5000], maxFailures: 4, windowMs: 60_000 },
            events: ['font.needed', 'page.geometry', 'dying'] });
        const slot: Slot = { id, client, generation: 0, opens: new Map(), pages: new Set(), inFlight: 0, heapBytes: 0, retiring: false, idleAt: Date.now() };
        client.on('page.geometry', value => {
            if (!value || typeof value !== 'object') return;
            const event = value as { docKey?: string; geometry?: DocInfo['pages'][number] }, doc = event.docKey && this.docs.get(event.docKey);
            const page = event.geometry;
            if (!doc?.info || !page || !Number.isSafeInteger(page.index) || page.index < 0 || page.index >= doc.info.pageCount ||
                !(page.width > 0 && page.height > 0) || !Array.isArray(page.toUserSpace) || page.toUserSpace.length !== 6 || !page.toUserSpace.every(Number.isFinite)) return;
            const pages = doc.info.pages.slice(); pages[page.index] = page; doc.info = { ...doc.info, pages };
        });
        this.slots.push(slot);
        this.timer ??= setInterval(() => this.maintain(), 1000);
        return slot;
    }
    private syncGeneration(slot: Slot): void {
        if (slot.client.generation !== slot.generation) { slot.generation = slot.client.generation; slot.opens.clear(); slot.pages.clear(); }
    }
    private async openOn(slot: Slot, doc: Doc, priority: Priority, signal: AbortSignal): Promise<DocInfo> {
        this.syncGeneration(slot);
        let pending = slot.opens.get(doc.key);
        if (!pending) {
            pending = slot.client.request<DocInfo>('doc.open', { docKey: doc.key, source: doc.blob, size: doc.blob.size, ...(doc.password ? { password: doc.password } : {}) },
                { priority, signal: doc.controller.signal, cpu: 'governed', key: doc.key, deadlineMs: 60_000, terminateOnDeadline: true });
            slot.generation = slot.client.generation;
            slot.opens.set(doc.key, pending);
            const promise = pending;
            void promise.then(info => {
                if (!validInfo(info)) throw new PdfEngineError('EngineBroken', 'Invalid PDF document information');
                if (doc.signature && doc.signature !== JSON.stringify(info)) throw new PdfEngineError('EngineBroken', 'PDF workers disagree about this document');
                doc.signature ??= JSON.stringify(info);
                doc.info ??= info;
                slot.generation = slot.client.generation;
            }).catch(() => { if (slot.opens.get(doc.key) === promise) slot.opens.delete(doc.key); });
        }
        const info = await waitFor(pending, signal);
        if (!validInfo(info)) throw new PdfEngineError('EngineBroken', 'Invalid PDF document information');
        if (doc.signature && doc.signature !== JSON.stringify(info)) throw new PdfEngineError('EngineBroken', 'PDF workers disagree about this document');
        doc.signature ??= JSON.stringify(info);
        doc.info ??= info;
        slot.generation = slot.client.generation;
        return info;
    }
    async open(options: PdfOpenOptions): Promise<PdfPoolDocument> {
        if (this.disposed) throw new PdfEngineError('EngineBroken', 'PDF pool is closed');
        if (!(options.blob instanceof Blob) || (typeof File !== 'undefined' && options.blob instanceof File) || !options.blob.size || options.blob.size >= 0x80000000) throw new PdfEngineError('ResourceLimit', 'Invalid PDF snapshot');
        const key = pdfDocKey({ vaultEpoch: options.token.vaultEpoch, documentId: options.token.documentId,
            bytesGeneration: options.token.bytesGeneration, source: options.source });
        let doc = this.docs.get(key);
        if (doc && (doc.blob.size !== options.blob.size || doc.password !== options.password || doc.closing)) throw new PdfEngineError('EngineBroken', 'Conflicting PDF source identity');
        if (!doc) { doc = { key, source: options.source, blob: options.blob, password: options.password, refs: 0, controller: new AbortController(), pending: new Set(), leases: new Set(), closing: false }; this.docs.set(key, doc); }
        doc.refs++;
        const lease = new Lease(this, doc, options.token); doc.leases.add(lease);
        try {
            doc.opening ??= this.enqueue<DocInfo>(doc, undefined, 'doc.open', {}, { priority: options.priority });
            await waitFor(doc.opening, options.signal);
            if (options.signal?.aborted || lease.closed) throw abortError();
            return lease;
        } catch (error) { await lease.close(); throw error; }
    }
    enqueue<T>(doc: Doc, lease: Lease | undefined, op: PdfEngineOp, args: Record<string, unknown>, options: PdfRequestOptions): Promise<T> {
        if (this.disposed || doc.closing || lease?.closed) return Promise.reject(abortError());
        const controller = new AbortController();
        const signal = AbortSignal.any([controller.signal, doc.controller.signal, ...(lease ? [lease.signal] : []), ...(options.signal ? [options.signal] : [])]);
        if (signal.aborted) return Promise.reject(abortError());
        let resolve!: (value: T) => void, reject!: (error: unknown) => void;
        const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
        if (options.deadlineMs !== undefined && (!Number.isFinite(options.deadlineMs) || options.deadlineMs < 0)) {
            return Promise.reject(new RangeError('Invalid PDF request deadline'));
        }
        const asked = Date.now();
        const job: Job = { doc, lease, op, args, priority: options.priority, signal, asked, timeoutMs: options.deadlineMs, controller, resolve: value => resolve(value as T), reject,
            abort: () => this.cancel(job, abortError()), attempts: 0, settled: false };
        this.jobs.set(promise, job); this.queue.push(job); doc.pending.add(promise);
        const cleanup = () => { doc.pending.delete(promise); };
        void promise.then(cleanup, cleanup);
        signal.addEventListener('abort', job.abort, { once: true });
        this.pump();
        return promise;
    }
    private cancel(job: Job, error: unknown): void {
        if (job.settled) return;
        job.controller.abort();
        this.finish(job, error);
    }
    private finish(job: Job, error?: unknown, value?: unknown): void {
        if (job.settled) return;
        job.settled = true; job.signal.removeEventListener('abort', job.abort);
        if (job.timer) clearTimeout(job.timer);
        const index = this.queue.indexOf(job); if (index >= 0) this.queue.splice(index, 1);
        if (error !== undefined) job.reject(error); else job.resolve(value);
        this.pump();
    }
    private pick(job: Job): Slot | undefined {
        const live = this.slots.filter(slot => !slot.retiring), page = job.args.page;
        if (Number.isSafeInteger(page) && (page as number) >= 0) {
            const home = homeWorker(live, job.doc.key, page as number);
            if (!home) return undefined;
            if (job.priority === 0 && home.inFlight > 0) {
                const key = pageKey(job.doc.key, page as number);
                const idle = live.find(slot => slot !== home && slot.inFlight === 0);
                if (idle && canSteal(key, this.footprints.get(key), job.doc.blob.size, live, this.budget)) return idle;
            }
            return home.inFlight < 2 ? home : undefined;
        }
        return live.filter(slot => slot.inFlight < 2).sort((a, b) => a.inFlight - b.inFlight)[0];
    }
    private pump(): void {
        if (this.disposed) return;
        if (this.pumping) { this.repump = true; return; }
        this.pumping = true;
        do {
            this.repump = false;
            if (this.queue.some(job => !job.settled && !job.posted) && !this.slots.length) this.slot();
            const candidates = this.queue.filter(job => !job.settled && !job.posted).sort((a, b) => a.priority - b.priority || a.asked - b.asked);
            for (const job of candidates) {
                if (job.signal.aborted) { this.finish(job, abortError()); continue; }
                const page = job.args.page;
                if (this.failedDocs.has(job.doc.key)) { this.finish(job, new PdfEngineError('EngineBroken', 'This PDF could not be displayed')); continue; }
                if (Number.isSafeInteger(page) && this.quarantined.has(pageKey(job.doc.key, page as number))) { this.finish(job, new PdfEngineError('PageError', 'This page could not be drawn')); continue; }
                const slot = this.pick(job);
                if (!slot) { this.grow(job); continue; }
                let release: (() => void) | null = null;
                try { if (job.op === 'page.tile') { release = this.credits.reserve({ ...job.args, docKey: job.doc.key } as PageTileArgs); if (!release) continue; } }
                catch (error) { this.finish(job, error); continue; }
                this.dispatch(slot, job, release);
            }
        } while (this.repump);
        this.pumping = false;
    }
    private grow(job: Job): void {
        if (job.priority > 1 || this.slots.length >= this.maxWorkers || this.growth || this.totalHeap() >= this.budget) return;
        this.growth = setTimeout(() => {
            this.growth = undefined;
            if (!this.disposed && this.queue.some(item => !item.settled && !item.posted && item.priority <= 1) &&
                this.slots.length < this.maxWorkers && this.totalHeap() < this.budget) { this.slot(); this.pump(); }
        }, 16);
    }
    private totalHeap(): number { return this.slots.reduce((sum, slot) => sum + slot.heapBytes, 0); }
    private dispatch(slot: Slot, job: Job, release: (() => void) | null): void {
        // A deadline starts at dispatch, not while a reader waits behind other work (security §5).
        if (job.deadline === undefined) {
            job.deadline = Date.now() + Math.min(job.timeoutMs ?? 60_000, 60_000);
            job.timer = setTimeout(() => this.cancel(job, deadlineError()), Math.max(0, job.deadline - Date.now()));
        }
        slot.inFlight++; job.slot = slot;
        const task = (async () => {
            const info = await this.openOn(slot, job.doc, job.priority, job.signal);
            if (job.op === 'doc.open') return info;
            if (job.signal.aborted || job.settled) throw abortError();
            const payload = { ...job.args, docKey: job.doc.key };
            const page = job.args.page;
            const remaining = job.deadline === undefined ? 60_000 : Math.max(0, Math.min(60_000, job.deadline - Date.now()));
            const posted = slot.client.request<unknown>(job.op, payload, { priority: job.priority, signal: job.signal, deadlineMs: remaining,
                terminateOnDeadline: true, cpu: 'governed', key: Number.isSafeInteger(page) ? pageKey(job.doc.key, page as number) : job.doc.key });
            job.posted = posted;
            const result = await posted;
            if (job.op === 'page.tile') {
                const args = payload as PageTileArgs;
                if (!validTile(result, args)) throw new PdfEngineError('EngineBroken', 'Invalid PDF tile reply');
                const before = slot.heapBytes; slot.heapBytes = Math.max(slot.heapBytes, result.heapBytes);
                const key = pageKey(job.doc.key, args.page);
                this.footprints.set(key, Math.max(this.footprints.get(key) ?? 0, result.heapBytes - before));
                slot.pages.add(key);
                if (job.settled || job.signal.aborted) throw abortError();
                this.credits.publish(result, release!); release = null;
            } else if (Number.isSafeInteger(page)) {
                const key = pageKey(job.doc.key, page as number);
                if (job.op === 'page.release') slot.pages.delete(key); else slot.pages.add(key);
            }
            return result;
        })();
        job.posted = task;
        void task.then(value => this.finish(job, undefined, value), error => {
            if (!job.settled && this.workerFailure(error) && this.recordDeath(job) && job.attempts++ < 1) {
                job.posted = undefined; job.slot = undefined; slot.opens.clear(); slot.pages.clear();
                if (slot.client.state === 'failed') slot.client.reset();
                this.pump();
            } else this.finish(job, error);
        }).finally(() => { release?.(); slot.inFlight--; if (!slot.inFlight) slot.idleAt = Date.now(); this.maintain(); this.pump(); });
    }
    private workerFailure(error: unknown): boolean { return error instanceof Error && ['WorkerCrashed', 'WorkerDied', 'WorkerFailed', 'Deadline'].includes(error.name); }
    private recordDeath(job: Job): boolean {
        const now = Date.now(), failures = (this.deaths.get(job.doc.key) ?? []).filter(t => now - t < 60_000); failures.push(now); this.deaths.set(job.doc.key, failures);
        const page = job.args.page;
        if (Number.isSafeInteger(page)) {
            const key = pageKey(job.doc.key, page as number), count = (this.pageDeaths.get(key) ?? 0) + 1;
            this.pageDeaths.set(key, count); if (count >= 2) { this.quarantined.add(key); return false; }
        }
        if (failures.length >= 3) { this.failedDocs.add(job.doc.key); return false; }
        return true;
    }
    reprioritise(promise: Promise<unknown>, priority: Priority): void {
        const job = this.jobs.get(promise); if (!job || job.settled) return;
        job.priority = priority; if (job.posted && job.slot) job.slot.client.reprioritise(job.posted, priority); this.pump();
    }
    releaseTile(result: PageTileResult): void { this.credits.release(result); }
    async release(lease: Lease): Promise<void> {
        const doc = lease.doc; doc.leases.delete(lease); doc.refs--;
        if (doc.refs > 0) return;
        doc.closing = true;
        doc.controller.abort();
        await Promise.allSettled([...doc.pending]);
        await Promise.allSettled(this.slots.map(async slot => {
            const opening = slot.opens.get(doc.key);
            if (!opening) return;
            await opening.catch(() => undefined);
            if (slot.opens.get(doc.key) !== opening) return;
            slot.opens.delete(doc.key);
            for (const key of slot.pages) if (key.startsWith(doc.key + '\0')) slot.pages.delete(key);
            await slot.client.request('doc.close', { docKey: doc.key }, { priority: 2, deadlineMs: 60_000 });
        }));
        if (this.docs.get(doc.key) === doc) this.docs.delete(doc.key);
        this.maintain();
    }
    private maintain(): void {
        if (this.disposed) return;
        const now = Date.now(), visible = [...this.docs.values()].some(doc => [...doc.leases].some(lease => lease.visible && !lease.closed));
        const ceiling = recycleCeiling(this.budget, this.slots.length);
        const idle = this.slots.filter(slot => !slot.inFlight).sort((a, b) => b.heapBytes - a.heapBytes);
        for (const slot of idle) {
            if (slot.heapBytes > ceiling || this.totalHeap() > this.budget ||
                (this.slots.length > 1 && now - slot.idleAt >= 20_000) || (!visible && now - slot.idleAt >= 60_000)) {
                slot.retiring = true; const at = this.slots.indexOf(slot); if (at >= 0) this.slots.splice(at, 1); slot.client.dispose();
            }
        }
        if (!this.slots.length && this.timer) { clearInterval(this.timer); this.timer = undefined; }
    }
    async writer(options: { signal?: AbortSignal } = {}): Promise<PdfWriterSession> {
        if (this.disposed || options.signal?.aborted) throw abortError();
        const id = ++this.nextSlot;
        const client = createWorkerClient({ name: `pdf-writer-${this.serial}-${id}`, protocol: PDF_ENGINE_PROTOCOL,
            spawn: () => this.options.broker.spawn('writer', id), absoluteMs: 120_000,
            silenceMs: { 0: 20_000, 1: 20_000, 2: 60_000, 3: 60_000 },
            restartPolicy: { delaysMs: [0], maxFailures: 1, windowMs: 60_000 } });
        this.writers.add(client);
        let closed = false;
        const close = async () => { if (closed) return; closed = true; options.signal?.removeEventListener('abort', abort); this.writers.delete(client); client.dispose(); };
        const abort = () => { void close(); };
        options.signal?.addEventListener('abort', abort, { once: true });
        return {
            request: <K extends keyof WriterOperations>(op: K, args: WriterOperations[K]['args'], requestOptions: PdfRequestOptions) => {
                if (closed) return Promise.reject(abortError());
                return client.request<WriterOperations[K]['result']>(op, args, { ...requestOptions, cpu: 'governed',
                    deadlineMs: Math.min(requestOptions.deadlineMs ?? 120_000, 120_000), terminateOnDeadline: true });
            },
            reprioritise: (promise, priority) => client.reprioritise(promise, priority), close,
        };
    }
    async stats(): Promise<readonly PdfWorkerStats[]> {
        return Promise.all(this.slots.map(slot => slot.client.request<PdfWorkerStats>('worker.stats', {}, { priority: 3, deadlineMs: 60_000 })));
    }
    async retry(docKey: PdfDocKey): Promise<void> {
        this.deaths.delete(docKey);
        this.failedDocs.delete(docKey);
        for (const key of this.quarantined) if (key.startsWith(docKey + '\0')) this.quarantined.delete(key);
        for (const key of this.pageDeaths.keys()) if (key.startsWith(docKey + '\0')) this.pageDeaths.delete(key);
        for (const slot of this.slots) if (slot.client.state === 'failed') slot.client.reset();
    }
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        if (this.timer) clearInterval(this.timer); if (this.growth) clearTimeout(this.growth);
        for (const job of [...this.queue]) this.finish(job, abortError());
        for (const doc of this.docs.values()) for (const lease of doc.leases) lease.invalidate();
        for (const slot of this.slots) slot.client.dispose();
        for (const writer of this.writers) writer.dispose();
        this.options.broker.dispose(); this.slots.length = 0; this.docs.clear(); this.writers.clear();
    }
}

class Lease implements PdfPoolDocument {
    private readonly controller = new AbortController();
    closed = false;
    visible = true;
    constructor(private readonly pool: Pool, readonly doc: Doc, readonly token: RenderToken) {}
    get signal(): AbortSignal { return this.controller.signal; }
    get docKey(): PdfDocKey { return this.doc.key; }
    get source(): 'outer' | 'original' { return this.doc.source; }
    get info(): Readonly<DocInfo> { if (!this.doc.info) throw new PdfEngineError('NotFoundError', 'PDF is not open'); return this.doc.info; }
    geometry(page: number): Readonly<DocInfo['pages'][number]> {
        const result = this.info.pages[page]; if (!result || result.index !== page) throw new RangeError('Invalid PDF page'); return result;
    }
    request<K extends PdfDocumentOp>(op: K, args: WithoutDocKey<PdfArgs<K>>, options: PdfRequestOptions): Promise<PdfResult<K>> {
        return this.pool.enqueue<PdfResult<K>>(this.doc, this, op, args as Record<string, unknown>, options);
    }
    text(page: number, detail: PdfArgs<'page.text'>['detail'], options: PdfRequestOptions) { return this.request('page.text', { page, detail }, options); }
    tile(args: WithoutDocKey<PageTileArgs>, options: PdfRequestOptions) { return this.request('page.tile', args, options); }
    releaseTile(result: PageTileResult): void { this.pool.releaseTile(result); }
    renderPage(page: number, scale: number, options: PdfPageBitmapOptions): Promise<ImageBitmap> { return renderPdfPageBitmap(this, page, scale, options); }
    thumbnail(page: number, maxSidePx: number, options: Omit<PdfPageBitmapOptions, 'priority' | 'maxPixels'>): Promise<ImageBitmap> {
        const geometry = this.geometry(page);
        if (!Number.isFinite(maxSidePx) || maxSidePx <= 0) return Promise.reject(new RangeError('Invalid PDF thumbnail size'));
        return this.renderPage(page, maxSidePx / Math.max(geometry.width, geometry.height), { ...options, priority: 3, maxPixels: Math.ceil(maxSidePx) ** 2 });
    }
    links(page: number, options: PdfRequestOptions) { return this.request('page.links', { page }, options); }
    outline(options: PdfRequestOptions) { return this.request('doc.outline', {}, options); }
    complexity(page: number, options: PdfRequestOptions) { return this.request('page.complexity', { page }, options); }
    probe(args: Omit<PdfArgs<'page.emphasisProbe'>, 'docKey'>, options: PdfRequestOptions) { return this.request('page.emphasisProbe', args, options); }
    attachment(index: number, maxBytes: number, options: PdfRequestOptions) { return this.request('doc.attachment', { index, maxBytes }, options); }
    releasePage(page: number): void { void this.request('page.release', { page }, { priority: 3 }).catch(() => {}); }
    reprioritise(promise: Promise<unknown>, priority: Priority): void { this.pool.reprioritise(promise, priority); }
    setVisible(visible: boolean): void { this.visible = visible; }
    invalidate(): void { if (!this.closed) { this.closed = true; this.controller.abort(); } }
    async close(): Promise<void> { if (this.closed) return; this.invalidate(); await this.pool.release(this); }
}

/** The broker must be a contained-frame implementation; no same-origin fallback. */
export function createPdfPool(options: PdfPoolOptions): PdfPool { return new Pool(options); }
