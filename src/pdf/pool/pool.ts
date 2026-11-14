import { createWorkerClient } from '../../platform/workers/client';
import type { ContainedPort, Priority, WorkerClient } from '../../platform/workers/envelope';
import { PdfEngineError } from '../engine/types';
import type { DocInfo } from '../engine/types';
import type { PageGeometry } from '../../platform/types';
import { PDF_ENGINE_PROTOCOL, PDF_ENGINE_ROLE_VERSION, pdfDocKey, parsePdfDocKey } from '../worker/protocol';
import type { EngineInitArgs, PageTileArgs, PageTileResult, PdfArgs, PdfDocKey, PdfEngineOp, PdfResult, PdfWorkerStats } from '../worker/protocol';
import type { RenderToken } from '../../platform/render/types';
import type { WriterOperations } from '../writing/protocol';
import { validatePdfWriterReply } from '../writing/validateReply';
import { verifyPdfWriterOutput } from '../writing/verifyOutput';
import { hashNotebookOutput, notebookOutputSpec, verifyNotebookGeometry } from '../writing/verifyNotebookOutput';
import type { PdfDocumentOp, PdfOpenOptions, PdfPageBitmapOptions, PdfPool, PdfPoolDocument, PdfRequestOptions, PdfWriterSession, WithoutDocKey } from './types';
import type { PdfPoolOptions } from './broker.types';
import { TileCredits } from './credits';
import { pdfTileArrivalCount, subscribePdfTileArrivals } from './arrivalWindow';
import { beginPdfPageWork, failPdfPage, clearPdfPageFailure, releasePdfPageStatus } from './pageStatus';
import { canSteal, homeWorker, maximumWorkers, poolBudget, recycleCeiling } from './routing';
import { renderPdfPageBitmap } from './bitmap';
import { createPdfReplyValidators } from './validation';
import { validatePdfEngineInit, validatePdfWorkerStats, validatePdfProbe, validatePdfInkInspection, validatePdfInkMedia, validatePdfLegacyInspection } from './validateControl';
import { planEmphasisProbeGeometry } from '../emphasis/profile';
import { PDF_FONT_CATALOGUE } from '../fonts/catalogue';
import type { PdfFontId } from '../fonts/catalogue';
import { pdfFontCache } from '../fonts/cache';
import { notePdfFontProvided, releasePdfFontProfile } from '../fonts/profiles';
import { setPdfPageRegions, observePdfPageTile, releasePdfPageQuality, needsPdfPageRegions } from '../quality/store';
import type { PdfiumJbig2Regions } from '../engine/pdfium/imageRegions.types';
import { record, integer, boolean, invalidPdfReply } from './validationCommon';
import { rebuildPdfTextReply } from '../text/rebuildReply';
import type { PdfTextDetail } from '../worker/protocol';
import { reportWorkerMemory, releaseWorkerMemory } from '../../platform/render/workerMemory';

const validators = createPdfReplyValidators();
const workerOwners = new WeakMap<WorkerClient, BootstrapPort>();
const workerExtraBytes = new WeakMap<WorkerClient, number>();
function reportMemory(client: WorkerClient, bytes: number): void {
    const owner = workerOwners.get(client);
    if (owner) reportWorkerMemory(owner, bytes + (workerExtraBytes.get(client) ?? 0));
}

type Doc = { key: PdfDocKey; source: 'outer' | 'original'; blob: Blob; password?: string; refs: number; controller: AbortController;
    info?: DocInfo; signature?: string; opening?: Promise<DocInfo>; geometry: Map<number, Readonly<PageGeometry>>;
    pending: Set<Promise<unknown>>; leases: Set<Lease>; closing: boolean; fonts: Set<PdfFontId>; regions: Map<number, Promise<void>>;
    regionRequests: Map<number, { client: WorkerClient; request: Promise<unknown>; priority: Priority }>; regionsReady: Set<number>;
    rasterFailures: Set<number>; rasterEpoch: number };
type Slot = { id: number; client: WorkerClient; generation: number; opens: Map<string, Promise<DocInfo>>;
    openRequests: Map<string, { request: Promise<unknown>; priority: Priority }>;
    pages: Set<string>; inFlight: number; heapBytes: number; retiring: boolean; idleAt: number;
    fonts: Map<PdfFontId, Promise<void>>; needed: Map<PdfDocKey, PdfFontId[]>; fontEpoch: number };
type Job = { doc: Doc; lease?: Lease; op: PdfEngineOp; args: Record<string, unknown>; priority: Priority; signal: AbortSignal;
    asked: number; timeoutMs?: number; deadline?: number; controller: AbortController; resolve: (value: unknown) => void; reject: (error: unknown) => void;
    abort: () => void; timer?: ReturnType<typeof setTimeout>; posted?: Promise<unknown>; slot?: Slot;
    attempt?: { controller: AbortController; preempted: boolean }; attempts: number; settled: boolean; rasterEpoch: number; progress?: { finish(): void } };
const abortError = () => new DOMException('PDF request cancelled', 'AbortError');
const deadlineError = () => new DOMException('PDF request deadline expired', 'TimeoutError');
const pageKey = (key: string, page: number) => `${key}\0${page}`;
function sameGeometry(a: Readonly<PageGeometry>, b: Readonly<PageGeometry>): boolean {
    return !!a && !!b && a.index === b.index && a.width === b.width && a.height === b.height &&
        a.rotate === b.rotate && a.userUnit === b.userUnit && Array.isArray(a.toUserSpace) && Array.isArray(b.toUserSpace) &&
        a.toUserSpace.length === 6 && b.toUserSpace.length === 6 &&
        [0, 1, 2, 3, 4, 5].every(index => Number.isFinite(a.toUserSpace[index]) && a.toUserSpace[index] === b.toUserSpace[index]);
}
let poolSerial = 0;

type BootstrapPort = ContainedPort & { readonly engine: EngineInitArgs; compiled(): Promise<void> };

/** The broker supplies a direct worker port and trusted init metadata, never a same-origin fallback (C5.4). */
function pdfClient(options: PdfPoolOptions, name: string, role: 'render' | 'writer', id: number, onHeap?: (bytes: number) => void): WorkerClient {
    let port: BootstrapPort | null = null;
    const client = createWorkerClient({ name, protocol: PDF_ENGINE_PROTOCOL,
        spawn: async () => {
            const spawned = await options.broker.spawn(role, id);
            const candidate = spawned as Partial<BootstrapPort>;
            if (!candidate.engine || typeof candidate.compiled !== 'function' || candidate.engine.role !== role ||
                candidate.engine.protocol !== PDF_ENGINE_PROTOCOL || candidate.engine.roleVersion !== PDF_ENGINE_ROLE_VERSION) {
                spawned.terminate();
                throw new PdfEngineError('EngineBroken', 'The contained PDF engine could not initialise');
            }
            port = spawned as BootstrapPort;
            const owner = port;
            const terminate = owner.terminate.bind(owner);
            owner.terminate = () => { releaseWorkerMemory(owner); terminate(); };
            workerOwners.set(client, owner); workerExtraBytes.delete(client);
            return port;
        },
        onStart: async client => {
            const current = port;
            if (!current) throw new PdfEngineError('EngineBroken', 'The contained PDF engine could not initialise');
            const value = await client.request<unknown>('engine.init', current.engine,
                { priority: 0, cpu: 'light', deadlineMs: 10_000, terminateOnDeadline: true });
            const info = validatePdfEngineInit(value, current.engine);
            reportMemory(client, info.heapBytes);
            await current.compiled();
        },
        absoluteMs: role === 'writer' ? 120_000 : 60_000,
        silenceMs: { 0: 20_000, 1: 20_000, 2: 60_000, 3: 60_000 },
        restartPolicy: role === 'writer' ? { delaysMs: [0], maxFailures: 1, windowMs: 60_000 } :
            { delaysMs: [0, 250, 1000, 5000], maxFailures: 4, windowMs: 60_000 },
        events: role === 'render' ? ['font.needed', 'font.profile', 'page.geometry', 'dying', 'worker.memory'] : ['worker.memory'],
    });
    client.on('worker.memory', value => {
        try {
            const data = record(value, ['heapBytes', 'fontBytes', 'blockCacheBytes', 'textBytes', 'ownedBytes']);
            const heap = integer(data.heapBytes, 0, role === 'writer' ? 3.5 * 1024 ** 3 : 1024 ** 3);
            const extra = integer(data.fontBytes, 0, 64 * 1024 ** 2) + integer(data.blockCacheBytes, 0, Number.MAX_SAFE_INTEGER) +
                integer(data.textBytes, 0, 512 * 1024 ** 2);
            if (integer(data.ownedBytes, 0, Number.MAX_SAFE_INTEGER) !== heap + extra) invalidPdfReply();
            workerExtraBytes.set(client, extra); reportMemory(client, heap); onHeap?.(heap);
        } catch { void client.recycle('Invalid PDF worker memory report').catch(() => {}); }
    });
    return client;
}

function validInfo(value: unknown): value is DocInfo {
    if (!value || typeof value !== 'object') return false;
    const info = value as DocInfo;
    return Number.isSafeInteger(info.pageCount) && info.pageCount > 0 && info.pageCount <= 100_000 &&
        Array.isArray(info.pages) && info.pages.length === info.pageCount && info.pages.every((page, index) =>
            page.index === index && Number.isFinite(page.width) && page.width >= 1 && page.width <= 14_400 &&
            Number.isFinite(page.height) && page.height >= 1 && page.height <= 14_400) &&
        Array.isArray(info.attachments) && typeof info.encrypted === 'boolean' && Number.isSafeInteger(info.signatureCount);
}
function validGeometry(value: unknown, page: number): value is PageGeometry {
    if (!value || typeof value !== 'object') return false;
    const geometry = value as PageGeometry, matrix = geometry.toUserSpace;
    return geometry.index === page && Number.isFinite(geometry.width) && geometry.width >= 1 && geometry.width <= 14_400 &&
        Number.isFinite(geometry.height) && geometry.height >= 1 && geometry.height <= 14_400 &&
        [0, 90, 180, 270].includes(geometry.rotate) && Number.isFinite(geometry.userUnit) && geometry.userUnit > 0 &&
        Array.isArray(matrix) && matrix.length === 6 && matrix.every(Number.isFinite) &&
        Number.isFinite(matrix[0] * matrix[3] - matrix[1] * matrix[2]) && matrix[0] * matrix[3] - matrix[1] * matrix[2] !== 0;
}

function rememberGeometry(doc: Doc, value: unknown, page: number): Readonly<PageGeometry> {
    value = validators.geometry(value, page);
    if (!validGeometry(value, page)) throw new PdfEngineError('EngineBroken', 'Invalid PDF page geometry');
    const previous = doc.geometry.get(page);
    if (previous && JSON.stringify(previous) !== JSON.stringify(value)) {
        throw new PdfEngineError('EngineBroken', 'PDF workers disagree about page geometry');
    }
    if (previous) return previous;
    const result = Object.freeze({ ...value, toUserSpace: Object.freeze([...value.toUserSpace]) as PageGeometry['toUserSpace'] });
    doc.geometry.set(page, result);
    return result;
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
function imageRegions(value: unknown): PdfiumJbig2Regions {
    const data = record(value, ['regions', 'partial']);
    if (!Array.isArray(data.regions) || data.regions.length > 20_000) invalidPdfReply();
    return { partial: boolean(data.partial), regions: data.regions.map(item => {
        const region = record(item, ['id', 'box']);
        if (!Array.isArray(region.box) || region.box.length !== 4 || region.box.some(n => typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > 14_400)) invalidPdfReply();
        if (region.box[0] > region.box[2] || region.box[1] > region.box[3]) invalidPdfReply();
        return { id: integer(region.id, 0, 0x7fffffff), box: [...region.box] as [number, number, number, number] };
    }) };
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
    private readonly unsubscribeArrivals = subscribePdfTileArrivals(() => this.pump());
    private readonly writers = new Set<WorkerClient>();
    private writerTail: Promise<void> = Promise.resolve();
    private timer?: ReturnType<typeof setInterval>;
    private growth?: ReturnType<typeof setTimeout>;
    private disposed = false;
    private pumping = false;
    private repump = false;

    get geometryEngine(): Readonly<WriterOperations['writer.stageAnnotated']['result']['geometryEngine']> {
        const slot = this.slots.find(candidate => candidate.client.state === 'ready' && candidate.client.generation === candidate.generation &&
            [...candidate.opens.keys()].some(key => this.docs.get(key)?.info));
        const engine = slot && workerOwners.get(slot.client)?.engine;
        if (!engine || engine.role !== 'render' || !engine.buildId || !engine.artifactSha256) throw new PdfEngineError('EngineBroken', 'PDF geometry engine is not ready');
        return Object.freeze({ id: 'pdfium', build: `${engine.buildId}/${engine.artifactSha256}`, generation: 1 });
    }
    constructor(private readonly options: PdfPoolOptions) {
        this.maxWorkers = maximumWorkers(options.hardwareConcurrency ?? (typeof navigator === 'undefined' ? undefined : navigator.hardwareConcurrency));
        this.budget = poolBudget(options.deviceMemory ?? (typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { deviceMemory?: number }).deviceMemory));
    }
    private slot(): Slot {
        const id = ++this.nextSlot;
        const client = pdfClient(this.options, `pdf-render-${this.serial}-${id}`, 'render', id, heap => { slot.heapBytes = heap; });
        const slot: Slot = { id, client, generation: 0, opens: new Map(), openRequests: new Map(), pages: new Set(), inFlight: 0, heapBytes: 0, retiring: false, idleAt: Date.now(), fonts: new Map(), needed: new Map(), fontEpoch: 0 };
        client.on('font.needed', value => {
            try {
                const data = record(value, ['ids', 'docKey', 'page']);
                if (typeof data.docKey !== 'string' || !this.docs.has(data.docKey) || !slot.opens.has(data.docKey) ||
                    !Array.isArray(data.ids) || !data.ids.length || data.ids.length > 14 ||
                    data.ids.some(id => typeof id !== 'string' || !Object.hasOwn(PDF_FONT_CATALOGUE, id))) invalidPdfReply();
                if (data.page !== undefined) integer(data.page, 0, this.docs.get(data.docKey)!.info!.pageCount - 1);
                slot.needed.set(data.docKey, [...new Set(data.ids as PdfFontId[])]);
            } catch { slot.openRequests.clear(); void client.recycle('Invalid PDF font request').catch(() => {}); }
        });
        client.on('font.profile', value => {
            try {
                const data = record(value, ['docKey', 'ids']);
                if (typeof data.docKey !== 'string') invalidPdfReply();
                parsePdfDocKey(data.docKey);
                if (!Array.isArray(data.ids) || data.ids.length > 14 ||
                    data.ids.some(id => typeof id !== 'string' || !Object.hasOwn(PDF_FONT_CATALOGUE, id)) ||
                    new Set(data.ids).size !== data.ids.length) invalidPdfReply();
                const doc = this.docs.get(data.docKey);
                if (!doc || doc.closing) return;
                if (!slot.opens.has(data.docKey)) invalidPdfReply();
                for (const id of data.ids as PdfFontId[]) doc.fonts.add(id);
                for (const id of data.ids as PdfFontId[]) notePdfFontProvided(doc.key, id);
            } catch { slot.openRequests.clear(); void client.recycle('Invalid PDF font profile').catch(() => {}); }
        });
        client.on('page.geometry', value => {
            if (!value || typeof value !== 'object') return;
            const event = value as { docKey?: string; geometry?: PageGeometry }, doc = event.docKey ? this.docs.get(event.docKey) : undefined;
            const page = event.geometry;
            if (!doc?.info || !page || !Number.isSafeInteger(page.index) || page.index < 0 || page.index >= doc.info.pageCount ||
                !slot.opens.has(doc.key)) {
                slot.openRequests.clear(); void client.recycle('Invalid PDF geometry event').catch(() => {});
                return;
            }
            try { rememberGeometry(doc, page, page.index); }
            catch (error) {
                this.failedDocs.add(doc.key);
                for (const job of [...this.queue]) if (job.doc === doc) this.finish(job, error);
                slot.openRequests.clear(); void client.recycle('Invalid PDF geometry event').catch(() => {});
            }
        });
        this.slots.push(slot);
        this.timer ??= setInterval(() => this.maintain(), 1000);
        return slot;
    }
    private syncGeneration(slot: Slot): void {
        if (slot.client.generation !== slot.generation || (slot.client.state === 'idle' && slot.generation !== 0)) {
            slot.generation = slot.client.generation; slot.opens.clear(); slot.openRequests.clear(); slot.pages.clear(); slot.fonts.clear(); slot.needed.clear(); slot.fontEpoch = 0;
        }
    }
    private promoteOpen(slot: Slot, key: string, priority: Priority): void {
        const open = slot.openRequests.get(key);
        if (!open || priority >= open.priority) return;
        open.priority = priority;
        slot.client.reprioritise(open.request, priority);
    }
    private async openOn(slot: Slot, doc: Doc, priority: () => Priority, signal: AbortSignal): Promise<DocInfo> {
        this.syncGeneration(slot);
        this.promoteOpen(slot, doc.key, priority());
        for (const id of doc.fonts) await this.provideFont(slot, id, signal);
        this.syncGeneration(slot);
        let pending = slot.opens.get(doc.key);
        if (!pending) {
            const currentPriority = priority();
            const request = slot.client.request<unknown>('doc.open', { docKey: doc.key, source: doc.blob, size: doc.blob.size, ...(doc.password ? { password: doc.password } : {}) },
                { priority: currentPriority, signal: doc.controller.signal, cpu: 'governed', key: doc.key, deadlineMs: 60_000, terminateOnDeadline: true });
            slot.openRequests.set(doc.key, { request, priority: currentPriority });
            pending = request.then(value => validators.document(value));
            slot.generation = slot.client.generation;
            slot.opens.set(doc.key, pending);
            const promise = pending;
            void promise.then(info => {
                if (!validInfo(info)) throw new PdfEngineError('EngineBroken', 'Invalid PDF document information');
                if (doc.signature && doc.signature !== JSON.stringify(info)) throw new PdfEngineError('EngineBroken', 'PDF workers disagree about this document');
                doc.signature ??= JSON.stringify(info);
                doc.info ??= info;
                slot.generation = slot.client.generation;
            }).catch(() => {
                if (slot.opens.get(doc.key) === promise) { slot.opens.delete(doc.key); slot.openRequests.delete(doc.key); }
            });
        } else this.promoteOpen(slot, doc.key, priority());
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
        if (!doc) { doc = { key, source: options.source, blob: options.blob, password: options.password, refs: 0, controller: new AbortController(), geometry: new Map(), pending: new Set(), leases: new Set(), closing: false, fonts: new Set(), regions: new Map(), regionRequests: new Map(), regionsReady: new Set(), rasterFailures: new Set(), rasterEpoch: 0 }; this.docs.set(key, doc); }
        doc.refs++;
        const lease = new Lease(this, doc, options.token); doc.leases.add(lease);
        try {
            doc.opening ??= this.enqueue<DocInfo>(doc, undefined, 'doc.open', {}, { priority: options.priority });
            const openingJob = this.jobs.get(doc.opening);
            if (openingJob && options.priority < openingJob.priority) this.reprioritise(doc.opening, options.priority);
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
            abort: () => this.cancel(job, abortError()), attempts: 0, settled: false, rasterEpoch: doc.rasterEpoch };
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
        job.progress?.finish();
        if (error instanceof Error && job.op === 'page.tile' && job.rasterEpoch === job.doc.rasterEpoch && Number.isSafeInteger(job.args.page) &&
            !['AbortError', 'Cancelled'].includes(error.name)) failPdfPage(job.doc.key, job.args.page as number, 'failed', 'This page could not be drawn.');
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
    private promoteRegions(doc: Doc, page: number, priority: Priority): void {
        const request = doc.regionRequests.get(page);
        if (!request || priority >= request.priority) return;
        request.priority = priority;
        request.client.reprioritise(request.request, priority);
    }
    private preemptLower(slot: Slot, wanted: Job): void {
        // A governor-paused render holds the worker's serial chain at slice(); only cancelling
        // its native attempt releases the chain without cancelling the logical page request.
        if (wanted.priority > 1) return;
        for (const job of this.queue) {
            const attempt = job.attempt;
            if (job === wanted || job.slot !== slot || job.priority < 2 || job.settled || !job.posted || !attempt || attempt.preempted) continue;
            attempt.preempted = true;
            attempt.controller.abort();
        }
    }
    private preemptForWanted(wanted: Job): void {
        if (wanted.priority > 1) return;
        const live = this.slots.filter(slot => !slot.retiring), page = wanted.args.page;
        const slot = Number.isSafeInteger(page) && (page as number) >= 0
            ? homeWorker(live, wanted.doc.key, page as number)
            : live.find(candidate => this.queue.some(job => job.slot === candidate && job.priority >= 2 && job.attempt));
        if (slot) this.preemptLower(slot, wanted);
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
                if (job.op === 'page.tile') {
                    if (Number.isSafeInteger(page) && job.doc.rasterFailures.has(page as number)) {
                        this.finish(job, new PdfEngineError('PageError', 'This page could not be drawn. Retry to try it again.')); continue;
                    }
                    const arrived = pdfTileArrivalCount();
                    if (arrived >= 64 || (arrived > 32 && job.priority >= 2)) continue;
                }
                const slot = this.pick(job);
                if (!slot) { this.preemptForWanted(job); this.grow(job); continue; }
                this.preemptLower(slot, job);
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
    private totalHeap(): number { return this.slots.reduce((sum, slot) => sum + slot.heapBytes + (workerExtraBytes.get(slot.client) ?? 0), 0); }
    private dispatch(slot: Slot, job: Job, release: (() => void) | null): void {
        // A deadline starts at dispatch, not while a reader waits behind other work (security §5).
        if (job.deadline === undefined) {
            job.deadline = Date.now() + Math.min(job.timeoutMs ?? 60_000, 60_000);
            job.timer = setTimeout(() => this.cancel(job, deadlineError()), Math.max(0, job.deadline - Date.now()));
        }
        if (!job.progress && job.op === 'page.tile' && job.priority <= 1 && Number.isSafeInteger(job.args.page)) {
            job.progress = beginPdfPageWork(job.doc.key, job.args.page as number);
        }
        const attempt = { controller: new AbortController(), preempted: false };
        const signal = AbortSignal.any([job.signal, attempt.controller.signal]);
        let rasterFailurePage: number | undefined;
        slot.inFlight++; job.slot = slot; job.attempt = attempt;
        const task = (async () => {
            const info = await this.openOn(slot, job.doc, () => job.priority, signal);
            if (job.op === 'doc.open') return info;
            if (signal.aborted || job.settled) throw abortError();
            const payload = { ...job.args, docKey: job.doc.key };
            const page = job.args.page;
            const remaining = job.deadline === undefined ? 60_000 : Math.max(0, Math.min(60_000, job.deadline - Date.now()));
            let result: unknown;
            const installed = new Set<PdfFontId>();
            for (;;) {
                try {
                    if (job.op === 'page.tile') {
                        if (job.doc.regionsReady.has(page as number) && needsPdfPageRegions(job.doc.key, page as number)) {
                            job.doc.regions.delete(page as number); job.doc.regionsReady.delete(page as number);
                        }
                        let regions = job.doc.regions.get(page as number);
                        if (!regions) {
                            const request = slot.client.request<unknown>('page.imageRegions', { docKey: job.doc.key, page },
                                { priority: job.priority, signal, cpu: 'governed', deadlineMs: remaining, terminateOnDeadline: true });
                            job.posted = request;
                            job.doc.regionRequests.set(page as number, { client: slot.client, request, priority: job.priority });
                            regions = request.then(value => { setPdfPageRegions(job.doc.key, page as number, imageRegions(value)); job.doc.regionsReady.add(page as number); });
                            job.doc.regions.set(page as number, regions);
                            const pending = regions;
                            void regions.then(() => {
                                if (job.doc.regionRequests.get(page as number)?.request === request) job.doc.regionRequests.delete(page as number);
                            }, () => {
                                if (job.doc.regions.get(page as number) === pending) job.doc.regions.delete(page as number);
                                if (job.doc.regionRequests.get(page as number)?.request === request) job.doc.regionRequests.delete(page as number);
                            });
                        } else this.promoteRegions(job.doc, page as number, job.priority);
                        try { await waitFor(regions, signal); }
                        catch (error) {
                            if (!signal.aborted && error instanceof Error && ['AbortError', 'Cancelled'].includes(error.name)) {
                                if (job.doc.regions.get(page as number) === regions) job.doc.regions.delete(page as number);
                                continue;
                            }
                            throw error;
                        }
                    }
                    if (Number.isSafeInteger(page) && !job.doc.geometry.has(page as number) &&
                        (job.op === 'page.links' || job.op === 'page.emphasisProbe' || (job.op === 'page.text' && job.args.detail !== 'text'))) {
                        const geometryRequest = slot.client.request<unknown>('page.geometry', { docKey: job.doc.key, page },
                            { priority: job.priority, signal, cpu: 'governed', deadlineMs: remaining, terminateOnDeadline: true });
                        job.posted = geometryRequest;
                        rememberGeometry(job.doc, await geometryRequest, page as number);
                    }
                    const posted = slot.client.request<unknown>(job.op, payload, { priority: job.priority, signal, deadlineMs: remaining,
                        terminateOnDeadline: true, cpu: 'governed', key: Number.isSafeInteger(page) ? pageKey(job.doc.key, page as number) : job.doc.key });
                    job.posted = posted;
                    try { result = await posted; }
                    catch (error) {
                        if (job.op === 'page.tile' && !job.settled && !signal.aborted && job.rasterEpoch === job.doc.rasterEpoch &&
                            Number.isSafeInteger(page) && (page as number) >= 0 && (page as number) < info.pageCount && error instanceof Error &&
                            ['PageError', 'ResourceLimit', 'NotSupported'].includes(error.name)) rasterFailurePage = page as number;
                        throw error;
                    }
                    break;
                } catch (error) {
                    if (!(error instanceof Error) || error.name !== 'FontPending') throw error;
                    const ids = slot.needed.get(job.doc.key);
                    if (!ids?.length || ids.some(id => installed.has(id))) throw new PdfEngineError('NotSupported', 'A font needed by this page is unavailable');
                    for (const id of ids) {
                        installed.add(id); job.doc.fonts.add(id);
                        try { await this.provideFont(slot, id, signal); notePdfFontProvided(job.doc.key, id); }
                        catch {
                            if (signal.aborted) throw abortError();
                            throw new PdfEngineError('NotSupported', 'A font needed by this page is unavailable');
                        }
                    }
                    signal.throwIfAborted();
                }
            }
            if (job.settled || signal.aborted) throw abortError();
            if (job.op === 'page.tile') {
                const args = payload as PageTileArgs;
                if (job.doc.rasterFailures.has(args.page)) throw new PdfEngineError('PageError', 'This page could not be drawn. Retry to try it again.');
                result = validators.tile(result, args);
                if (!validTile(result, args)) throw new PdfEngineError('EngineBroken', 'Invalid PDF tile reply');
                reportMemory(slot.client, result.heapBytes);
                observePdfPageTile(job.doc.key, args.page, result);
                const before = slot.heapBytes; slot.heapBytes = Math.max(slot.heapBytes, result.heapBytes);
                const key = pageKey(job.doc.key, args.page);
                this.footprints.set(key, Math.max(this.footprints.get(key) ?? 0, result.heapBytes - before));
                slot.pages.add(key);
                if (job.settled || signal.aborted) throw abortError();
                this.credits.publish(result, release!); release = null;
            } else {
                result = await this.validateResult(slot, job, result, signal);
                if (signal.aborted || job.settled) throw abortError();
                if (Number.isSafeInteger(page)) {
                    const key = pageKey(job.doc.key, page as number);
                    if (job.op === 'page.release') slot.pages.delete(key); else slot.pages.add(key);
                }
            }
            return result;
        })();
        job.posted = task;
        let requeue = false;
        void task.then(value => {
            if (attempt.preempted || job.settled || job.signal.aborted) {
                if (job.op === 'page.tile') this.credits.release(value as PageTileResult);
                if (attempt.preempted && !job.settled && !job.signal.aborted) requeue = true;
                else if (!job.settled) this.finish(job, abortError());
            } else this.finish(job, undefined, value);
        }, error => {
            if (!attempt.preempted && !job.settled && !job.signal.aborted && rasterFailurePage !== undefined && job.rasterEpoch === job.doc.rasterEpoch) {
                job.doc.rasterFailures.add(rasterFailurePage);
            }
            if (attempt.preempted && !job.settled && !job.signal.aborted) requeue = true;
            else if (!job.settled && this.workerFailure(error) && this.recordDeath(job) && job.attempts++ < 1) {
                requeue = true; slot.opens.clear(); slot.openRequests.clear(); slot.pages.clear();
                if (slot.client.state === 'failed') slot.client.reset();
            } else this.finish(job, error);
        }).finally(() => {
            release?.(); slot.inFlight--; if (!slot.inFlight) slot.idleAt = Date.now();
            if (job.attempt === attempt) job.attempt = undefined;
            if (requeue && !job.settled && !job.signal.aborted) { job.posted = undefined; job.slot = undefined; }
            this.maintain(); this.pump();
        });
    }
    private provideFont(slot: Slot, id: PdfFontId, signal: AbortSignal): Promise<void> {
        let pending = slot.fonts.get(id);
        if (!pending) {
            pending = (async () => {
                const blob = await pdfFontCache.load(id, signal);
                const bytes = await blob.arrayBuffer(); signal.throwIfAborted();
                const result = await slot.client.request('font.provide', { id, bytes },
                    { priority: 0, signal, transfer: [bytes], cpu: 'light', deadlineMs: 60_000 });
                const reply = record(result, ['fontEpoch']);
                const epoch = integer(reply.fontEpoch, 1, 14);
                if (epoch < slot.fontEpoch) invalidPdfReply();
                slot.fontEpoch = epoch;
            })();
            slot.fonts.set(id, pending);
            const installed = pending;
            void pending.catch(() => { if (slot.fonts.get(id) === installed) slot.fonts.delete(id); });
        }
        const shared = pending;
        // The first waiter owns this shared installation; its preemption must not fail the others.
        return waitFor(shared, signal).catch(error => {
            if (!signal.aborted && error instanceof Error && ['AbortError', 'Cancelled'].includes(error.name)) {
                if (slot.fonts.get(id) === shared) slot.fonts.delete(id);
                return this.provideFont(slot, id, signal);
            }
            throw error;
        });
    }
    private async validateResult(slot: Slot, job: Job, value: unknown, signal: AbortSignal): Promise<unknown> {
        const page = job.args.page as number;
        switch (job.op) {
            case 'page.geometry': return rememberGeometry(job.doc, value, page);
            case 'page.text': {
                return rebuildPdfTextReply(value, { docKey: job.doc.key, page, detail: job.args.detail as PdfTextDetail,
                    geometry: job.doc.geometry.get(page) }, signal);
            }
            case 'page.links': {
                const geometry = job.doc.geometry.get(page);
                if (!geometry) invalidPdfReply();
                return validators.links(value, geometry, job.doc.info!.pageCount);
            }
            case 'doc.outline': return validators.outline(value, job.doc.info!.pageCount);
            case 'doc.inspectInk': return validatePdfInkInspection(value);
            case 'doc.inspectLegacyInk': return validatePdfLegacyInspection(value);
            case 'doc.inkMedia': return validatePdfInkMedia(value);
            case 'doc.attachment': return validators.attachmentBytes(value, job.args.maxBytes as number);
            case 'page.release': return record(value, []);
            case 'page.complexity': {
                const keys = ['objects', 'textObjects', 'imageObjects', 'imagePixels', 'pathObjects', 'formObjects'] as const;
                const data = record(value, keys);
                return Object.fromEntries(keys.map(key => [key, integer(data[key], 0, Number.MAX_SAFE_INTEGER)]));
            }
            case 'page.imageRegions': return imageRegions(value);
            case 'worker.stats': {
                const data = record(value, ['heapBytes', 'docs', 'pagesLoaded', 'blockCacheBytes']);
                const heapBytes = integer(data.heapBytes, 0, 1024 ** 3);
                slot.heapBytes = heapBytes; reportMemory(slot.client, heapBytes);
                return { heapBytes, docs: integer(data.docs, 0, 100_000), pagesLoaded: integer(data.pagesLoaded, 0, 100_000),
                    blockCacheBytes: integer(data.blockCacheBytes, 0, 1024 ** 3) };
            }
            case 'page.emphasisProbe': {
                const args = { ...job.args, docKey: job.doc.key } as PdfArgs<'page.emphasisProbe'>;
                const result = validatePdfProbe(value, args), geometry = job.doc.geometry.get(page);
                if (!geometry) invalidPdfReply();
                const planned = planEmphasisProbeGeometry(geometry.width, geometry.height, Math.min(args.maxPixels, 1_000_000), 2046);
                if (!planned.ok || result.probe.scale !== planned.geometry.scale || result.probe.w !== planned.geometry.w ||
                    result.probe.h !== planned.geometry.h) invalidPdfReply();
                return result;
            }
            default: invalidPdfReply();
        }
    }
    private workerFailure(error: unknown): boolean { return error instanceof Error && ['WorkerCrashed', 'WorkerDied', 'WorkerFailed', 'Deadline'].includes(error.name); }
    private recordDeath(job: Job): boolean {
        const now = Date.now(), failures = (this.deaths.get(job.doc.key) ?? []).filter(t => now - t < 60_000); failures.push(now); this.deaths.set(job.doc.key, failures);
        const page = job.args.page;
        if (Number.isSafeInteger(page)) {
            const key = pageKey(job.doc.key, page as number), count = (this.pageDeaths.get(key) ?? 0) + 1;
            this.pageDeaths.set(key, count); if (count >= 2) { this.quarantined.add(key); failPdfPage(job.doc.key, page as number, 'quarantined', 'This page could not be drawn. Retry to try it once more.'); return false; }
        }
        if (failures.length >= 3) { this.failedDocs.add(job.doc.key); return false; }
        return true;
    }
    reprioritise(promise: Promise<unknown>, priority: Priority): void {
        const job = this.jobs.get(promise); if (!job || job.settled) return;
        job.priority = priority;
        if (job.slot) {
            this.promoteOpen(job.slot, job.doc.key, priority);
            const region = job.op === 'page.tile' && Number.isSafeInteger(job.args.page) ? job.doc.regionRequests.get(job.args.page as number) : undefined;
            if (region) this.promoteRegions(job.doc, job.args.page as number, priority);
            if (job.posted && job.posted !== region?.request) job.slot.client.reprioritise(job.posted, priority);
            const wanted = priority <= 1 ? job : this.queue.find(item => item.slot === job.slot && !item.settled && item.priority <= 1);
            if (wanted) this.preemptLower(job.slot, wanted);
        }
        this.pump();
    }
    releaseTile(result: PageTileResult): void { this.credits.release(result); }
    async release(lease: Lease): Promise<void> {
        const doc = lease.doc; doc.leases.delete(lease); doc.refs--;
        if (doc.refs > 0) return;
        // A StrictMode cleanup may reacquire the same immutable document in the
        // next effect; only final ownership loss is a native doc.close.
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        if (doc.refs > 0 || this.docs.get(doc.key) !== doc) return;
        doc.closing = true;
        doc.controller.abort();
        doc.regionRequests.clear();
        await Promise.allSettled([...doc.pending]);
        await Promise.allSettled(this.slots.map(async slot => {
            slot.needed.delete(doc.key);
            slot.openRequests.delete(doc.key);
            for (const key of slot.pages) if (key.startsWith(doc.key + '\0')) slot.pages.delete(key);
            const opening = slot.opens.get(doc.key);
            if (!opening) return;
            await opening.catch(() => undefined);
            if (slot.opens.get(doc.key) !== opening) return;
            slot.opens.delete(doc.key);
            slot.openRequests.delete(doc.key);
            slot.needed.delete(doc.key);
            await slot.client.request('doc.close', { docKey: doc.key }, { priority: 0, cpu: 'light', deadlineMs: 60_000 });
        }));
        if (this.docs.get(doc.key) === doc) {
            this.docs.delete(doc.key);
            this.deaths.delete(doc.key); this.failedDocs.delete(doc.key);
            for (const key of this.footprints.keys()) if (key.startsWith(doc.key + '\0')) this.footprints.delete(key);
            for (const key of this.pageDeaths.keys()) if (key.startsWith(doc.key + '\0')) this.pageDeaths.delete(key);
            for (const key of this.quarantined) if (key.startsWith(doc.key + '\0')) this.quarantined.delete(key);
            releasePdfFontProfile(doc.key); releasePdfPageQuality(doc.key); releasePdfPageStatus(doc.key);
        }
        this.maintain();
    }
    private maintain(): void {
        if (this.disposed) return;
        const now = Date.now(), visible = [...this.docs.values()].some(doc => [...doc.leases].some(lease => lease.visible && !lease.closed));
        const ceiling = recycleCeiling(this.budget, this.slots.length);
        const idle = this.slots.filter(slot => !slot.inFlight).sort((a, b) => b.heapBytes - a.heapBytes);
        for (const slot of idle) {
            if (slot.heapBytes + (workerExtraBytes.get(slot.client) ?? 0) > ceiling || this.totalHeap() > this.budget ||
                (this.slots.length > 1 && now - slot.idleAt >= 20_000) || (!visible && now - slot.idleAt >= 60_000)) {
                slot.retiring = true; const at = this.slots.indexOf(slot); if (at >= 0) this.slots.splice(at, 1); slot.client.dispose();
            }
        }
        if (!this.slots.length && this.timer) { clearInterval(this.timer); this.timer = undefined; }
    }
    async writer(options: { signal?: AbortSignal } = {}): Promise<PdfWriterSession> {
        if (this.disposed || options.signal?.aborted) throw abortError();
        const previous = this.writerTail;
        let releaseTurn!: () => void;
        const turn = new Promise<void>(resolve => { releaseTurn = resolve; });
        this.writerTail = previous.then(() => turn);
        try { await waitFor(previous, options.signal); }
        catch (error) { releaseTurn(); throw error; }
        if (this.disposed || options.signal?.aborted) { releaseTurn(); throw abortError(); }
        const id = ++this.nextSlot;
        const client = pdfClient(this.options, `pdf-writer-${this.serial}-${id}`, 'writer', id);
        this.writers.add(client);
        let closed = false, nativeReleased = false;
        const lifetime = new AbortController();
        const sources = new Map<string, WriterOperations['writer.prepareSource']['result'] & { source: WriterOperations['writer.prepareSource']['args']['source'] }>();
        const stages = new Map<string, { sourceFingerprint: string; pageCount: number; revision: number; formatId: string }>();
        const releaseNative = () => {
            if (nativeReleased) return;
            nativeReleased = true;
            this.writers.delete(client); client.dispose(); sources.clear(); stages.clear(); releaseTurn();
        };
        const close = async () => {
            if (closed) return;
            closed = true; lifetime.abort(); options.signal?.removeEventListener('abort', abort); releaseNative();
        };
        const abort = () => { void close(); };
        options.signal?.addEventListener('abort', abort, { once: true });
        return {
            request: async <K extends keyof WriterOperations>(op: K, args: WriterOperations[K]['args'], requestOptions: PdfRequestOptions) => {
                if (closed || nativeReleased || this.disposed) throw abortError();
                const signal = AbortSignal.any([lifetime.signal, ...(options.signal ? [options.signal] : []), ...(requestOptions.signal ? [requestOptions.signal] : [])]);
                const notebookInput = op === 'writer.buildNotebook' ? args as WriterOperations['writer.buildNotebook']['args'] : undefined;
                const notebookSpec = notebookInput ? notebookOutputSpec(notebookInput) : undefined;
                const notebookIdentity = notebookInput ? { ...notebookInput, notebookSource: { path: notebookSpec!.path }, pages: [...notebookInput.pages] } : undefined;
                const verifyInput = op === 'writer.verifyNotebookOutput' ? args as WriterOperations['writer.verifyNotebookOutput']['args'] :
                    op === 'writer.verifyUnsignedCopy' ? args as WriterOperations['writer.verifyUnsignedCopy']['args'] : undefined;
                if (verifyInput && (!(verifyInput.bytes instanceof ArrayBuffer) || !verifyInput.bytes.byteLength)) throw new Error('Invalid notebook verification bytes');
                const verifyLength = verifyInput?.bytes.byteLength;
                const value = await client.request<unknown>(op, args, { ...requestOptions, signal, cpu: 'governed',
                    ...(verifyInput ? { transfer: [verifyInput.bytes] } : {}),
                    deadlineMs: Math.min(requestOptions.deadlineMs ?? 120_000, 120_000), terminateOnDeadline: true });
                if (closed || nativeReleased || this.disposed) throw abortError();
                signal.throwIfAborted();
                const result = validatePdfWriterReply(op, value, args);
                if (op === 'writer.prepareSource') {
                    const output = result as WriterOperations['writer.prepareSource']['result'];
                    sources.set(output.writerSession, { ...output, source: (args as WriterOperations['writer.prepareSource']['args']).source });
                } else if (op === 'writer.stageAnnotated') {
                    const input = args as WriterOperations['writer.stageAnnotated']['args'];
                    const output = result as WriterOperations['writer.stageAnnotated']['result'];
                    const prepared = sources.get(input.writerSession);
                    const engine = prepared?.source.geometryEngine, actual = output.geometryEngine;
                    if (!prepared || !engine || output.sourceFingerprint !== prepared.sourceFingerprint ||
                        actual.id !== engine.id || actual.build !== engine.build || actual.generation !== engine.generation ||
                        !Array.isArray(input.geometries) || input.geometries.length !== prepared.inspection.geometries.length ||
                        !prepared.inspection.geometries.every((page, index) => sameGeometry(input.geometries[index], page))) invalidPdfReply();
                    stages.set(output.stageId, { sourceFingerprint: prepared.sourceFingerprint, pageCount: prepared.inspection.pageCount, revision: input.revision, formatId: prepared.source.formatId });
                } else if (op === 'writer.finishAnnotated') {
                    const input = args as WriterOperations['writer.finishAnnotated']['args'];
                    const output = result as WriterOperations['writer.finishAnnotated']['result'];
                    const staged = stages.get(input.stageId); stages.delete(input.stageId);
                    if (!staged || staged.sourceFingerprint !== output.sourceFingerprint || staged.pageCount !== output.verification.pageCount || staged.revision !== output.revision ||
                        input.attachments.some(entry => entry.role === 'editable' && entry.format !== staged.formatId)) invalidPdfReply();
                } else if (op === 'writer.verifyNotebookOutput' || op === 'writer.verifyUnsignedCopy') {
                    if ((result as WriterOperations['writer.verifyNotebookOutput']['result'] | WriterOperations['writer.verifyUnsignedCopy']['result']).bytes.byteLength !== verifyLength) invalidPdfReply();
                } else if (op === 'writer.release') sources.delete((args as WriterOperations['writer.release']['args']).writerSession);
                if (op === 'writer.finishAnnotated') await verifyPdfWriterOutput(op,
                    args as WriterOperations['writer.finishAnnotated']['args'], result as WriterOperations['writer.finishAnnotated']['result'], signal);
                else if (op === 'writer.buildNotebook') {
                    const output = result as WriterOperations['writer.buildNotebook']['result'];
                    await verifyPdfWriterOutput(op, notebookIdentity!, output, signal);
                    const length = output.bytes.byteLength, hash = await hashNotebookOutput(output.bytes, signal);
                    signal.throwIfAborted();
                    if (closed || this.disposed) throw abortError();
                    // The verifier takes the same global writer turn only after the producing heap is gone.
                    releaseNative();
                    const verifier = await this.writer({ signal });
                    try {
                        signal.throwIfAborted();
                        const proof = await verifier.request('writer.verifyNotebookOutput',
                            { bytes: output.bytes, notebookSource: { path: notebookSpec!.path } }, { priority: requestOptions.priority, signal });
                        signal.throwIfAborted();
                        if (proof.bytes.byteLength !== length || proof.path !== notebookSpec!.path || proof.sha256 !== hash) invalidPdfReply();
                        verifyNotebookGeometry(notebookSpec!, proof.geometries);
                        if (await hashNotebookOutput(proof.bytes, signal) !== hash) invalidPdfReply();
                        signal.throwIfAborted();
                        if (closed || this.disposed) throw abortError();
                        output.bytes = proof.bytes;
                    } finally { await verifier.close(); }
                }
                signal.throwIfAborted();
                if (closed || this.disposed) throw abortError();
                return result;
            },
            reprioritise: (promise, priority) => client.reprioritise(promise, priority), close,
        };
    }
    async stats(): Promise<readonly PdfWorkerStats[]> {
        return Promise.all(this.slots.map(async slot => {
            const value = await slot.client.request<unknown>('worker.stats', {}, { priority: 3, deadlineMs: 60_000 });
            const stats = validatePdfWorkerStats(value);
            slot.heapBytes = stats.heapBytes; reportMemory(slot.client, stats.heapBytes);
            return stats;
        }));
    }
    async retry(docKey: PdfDocKey): Promise<void> {
        this.options.broker.reset?.();
        const doc = this.docs.get(docKey);
        if (doc) { doc.rasterEpoch++; doc.rasterFailures.clear(); }
        clearPdfPageFailure(docKey);
        this.deaths.delete(docKey);
        this.failedDocs.delete(docKey);
        for (const key of this.quarantined) if (key.startsWith(docKey + '\0')) this.quarantined.delete(key);
        for (const key of this.pageDeaths.keys()) if (key.startsWith(docKey + '\0')) this.pageDeaths.delete(key);
        for (const slot of this.slots) if (slot.client.state === 'failed') slot.client.reset();
    }
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.unsubscribeArrivals();
        if (this.timer) clearInterval(this.timer); if (this.growth) clearTimeout(this.growth);
        for (const job of [...this.queue]) this.finish(job, abortError());
        for (const doc of this.docs.values()) { for (const lease of doc.leases) lease.invalidate(); releasePdfFontProfile(doc.key); releasePdfPageQuality(doc.key); releasePdfPageStatus(doc.key); }
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
    peekGeometry(page: number): Readonly<PageGeometry> | undefined { return this.closed ? undefined : this.doc.geometry.get(page); }
    get info(): Readonly<DocInfo> { if (!this.doc.info) throw new PdfEngineError('NotFoundError', 'PDF is not open'); return this.doc.info; }
    async resolveGeometry(page: number, options: PdfRequestOptions): Promise<Readonly<PageGeometry>> {
        if (!Number.isSafeInteger(page) || page < 0 || page >= this.info.pageCount) throw new RangeError('Invalid PDF page');
        const cached = this.doc.geometry.get(page);
        if (cached) return cached;
        const result = await this.request('page.geometry', { page }, options);
        return rememberGeometry(this.doc, result, page);
    }
    request<K extends PdfDocumentOp>(op: K, args: WithoutDocKey<PdfArgs<K>>, options: PdfRequestOptions): Promise<PdfResult<K>> {
        return this.pool.enqueue<PdfResult<K>>(this.doc, this, op, args as Record<string, unknown>, options);
    }
    text(page: number, detail: PdfArgs<'page.text'>['detail'], options: PdfRequestOptions) { return this.request('page.text', { page, detail }, options); }
    tile(args: WithoutDocKey<PageTileArgs>, options: PdfRequestOptions) { return this.request('page.tile', args, options); }
    releaseTile(result: PageTileResult): void { this.pool.releaseTile(result); }
    retry(): Promise<void> { return this.closed ? Promise.reject(abortError()) : this.pool.retry(this.docKey); }
    renderPage(page: number, scale: number, options: PdfPageBitmapOptions): Promise<ImageBitmap> { return renderPdfPageBitmap(this, page, scale, options); }
    thumbnail(page: number, maxSidePx: number, options: Omit<PdfPageBitmapOptions, 'priority' | 'maxPixels'>): Promise<ImageBitmap> {
        const geometry = this.info.pages[page];
        if (!geometry) return Promise.reject(new RangeError('Invalid PDF page'));
        if (!Number.isFinite(maxSidePx) || maxSidePx <= 0) return Promise.reject(new RangeError('Invalid PDF thumbnail size'));
        const scale = maxSidePx / Math.max(geometry.width, geometry.height), maxPixels = Math.ceil(maxSidePx) ** 2;
        if (options.variant === 'emphasis') {
            if (!options.emphasis) return Promise.reject(new RangeError('Missing PDF emphasis profile'));
            return this.renderPage(page, scale, { ...options, variant: 'emphasis', emphasis: options.emphasis, priority: 3, maxPixels });
        }
        return this.renderPage(page, scale, { ...options, variant: 'plain', emphasis: undefined, priority: 3, maxPixels });
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
