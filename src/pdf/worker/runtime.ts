import { serve } from '../../platform/workers/serve';
import type { WorkerContext } from '../../platform/workers/serve';
import { PdfEngineError } from '../engine/types';
import type { BackendDoc, PdfBackend, RawPageText } from '../engine/types';
import { loadPdfiumBackend } from '../engine/pdfiumBackend';
import { buildEmphasisPlan } from '../emphasis/plan';
import { compositeEmphasis } from '../emphasis/composite';
import { compilePdfEngine } from './compileEngine';
import { PdfBlobSource } from './rangeSource';
import { runPdfRenderJob } from './renderJob';
import { buildWorkerPageText } from './text';
import { PDF_ENGINE_PROTOCOL, PDF_ENGINE_ROLE_VERSION, parsePdfDocKey } from './protocol';
import type { EngineInitArgs, PageTileArgs, PageTextReply } from './protocol';
import type { PdfWorkerBinding } from '../contained/protocol';

type OpenDoc = { doc: BackendDoc; source: PdfBlobSource; raw: Map<number, RawPageText>; clone?: BackendDoc };
const bad = (name: 'EngineBroken' | 'RangeError' | 'NotFoundError', message: string) => new PdfEngineError(name, message);
const record = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad('RangeError', 'Invalid PDF request');
    return value as Record<string, unknown>;
};
export function startPdfWorker(binding: PdfWorkerBinding): () => void {
    let backend: PdfBackend | undefined;
    let chain: Promise<unknown> = Promise.resolve();
    let closed = false;
    const docs = new Map<string, OpenDoc>();
    const channel = new MessageChannel();
    const yieldTurn = () => new Promise<void>(resolve => { channel.port1.onmessage = () => resolve(); channel.port2.postMessage(0); });
    const serial = (fn: (value: unknown, context: WorkerContext) => unknown | Promise<unknown>) =>
        (value: unknown, context: WorkerContext) => {
            const next = chain.then(() => { if (closed || context.cancelled) throw new DOMException('Cancelled', 'AbortError'); return fn(value, context); });
            chain = next.catch(() => {}); return next;
        };
    const lookup = (value: unknown) => {
        const args = record(value), key = args.docKey;
        if (typeof key !== 'string') throw bad('RangeError', 'Invalid PDF document key');
        parsePdfDocKey(key);
        const item = docs.get(key);
        if (!item) throw bad('NotFoundError', 'PDF document is not open');
        return { args, key, item };
    };
    const pageNumber = (value: unknown, item: OpenDoc): number => {
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value >= item.doc.pageCount()) throw bad('RangeError', 'Invalid PDF page');
        return value;
    };
    const rawPage = (item: OpenDoc, page: number): RawPageText => {
        let raw = item.raw.get(page);
        if (raw) item.raw.delete(page);
        else raw = item.doc.text(page);
        item.raw.set(page, raw);
        while (item.raw.size > 4) item.raw.delete(item.raw.keys().next().value!);
        return raw;
    };
    const geometry = (key: string, item: OpenDoc, page: number, ctx: WorkerContext) => {
        const result = item.doc.page(page); ctx.emit('page.geometry', { docKey: key, geometry: result }); return result;
    };
    const stop = serve({ endpoint: binding.port, protocol: PDF_ENGINE_PROTOCOL, buildId: binding.engine.buildId, yield: yieldTurn,
        handlers: {
            'engine.init': serial(async (value, ctx) => {
                const args = record(value) as unknown as EngineInitArgs;
                if (backend || args.role !== 'render' || args.protocol !== PDF_ENGINE_PROTOCOL || args.roleVersion !== PDF_ENGINE_ROLE_VERSION ||
                    JSON.stringify(args) !== JSON.stringify(binding.engine)) throw bad('EngineBroken', 'PDF engine initialization mismatch');
                const started = performance.now(), wasm = await compilePdfEngine(args, ctx.signal);
                backend = await loadPdfiumBackend({ wasm, glueUrl: binding.glueUrl, abi: binding.abi, role: args.role,
                    buildId: args.buildId, artifactSha256: args.artifactSha256 });
                const info = backend.init({ wasm, assetBase: args.assetBase, limits: args.limits, fonts: { request: () => undefined } });
                return { ...info, initMs: performance.now() - started, heapBytes: backend.heapBytes() };
            }),
            'doc.open': serial((value) => {
                const args = record(value); if (!backend || typeof args.docKey !== 'string' || !(args.source instanceof Blob) || args.source.size !== args.size ||
                    (args.password !== undefined && typeof args.password !== 'string')) throw bad('RangeError', 'Invalid PDF open');
                parsePdfDocKey(args.docKey); const existing = docs.get(args.docKey); if (existing) return existing.doc.info();
                const source = new PdfBlobSource(args.source);
                try { const doc = backend.open(source, { password: args.password as string | undefined }); docs.set(args.docKey, { doc, source, raw: new Map() }); return doc.info(); }
                catch (error) { source.close(); throw error; }
            }),
            'doc.close': serial(value => { const args = record(value); if (typeof args.docKey !== 'string') throw bad('RangeError', 'Invalid PDF document key');
                const item = docs.get(args.docKey); if (item) { docs.delete(args.docKey); item.clone?.close(); item.doc.close(); item.source.close(); } return {}; }),
            'page.text': serial(async (value, ctx): Promise<PageTextReply> => {
                const { args, key, item } = lookup(value), page = pageNumber(args.page, item), info = item.doc.info();
                if (info.encrypted && (info.permissions === null || (info.permissions & 16) === 0)) throw new PdfEngineError('NotSupported', 'PDF text extraction is not permitted');
                if (args.detail !== 'text' && args.detail !== 'model' && args.detail !== 'select') throw bad('RangeError', 'Invalid PDF text detail');
                return buildWorkerPageText(rawPage(item, page), geometry(key, item, page, ctx), { docKey: key, page, detail: args.detail }, ctx);
            }),
            'page.tile': serial(async (value, ctx) => {
                const { args, key, item } = lookup(value), page = pageNumber(args.page, item), request = args as unknown as PageTileArgs;
                if (!backend || (request.variant !== 'plain' && request.variant !== 'emphasis') || typeof request.profileKey !== 'string') throw bad('RangeError', 'Invalid PDF tile');
                const pageGeometry = geometry(key, item, page, ctx), start = performance.now();
                const req = { page, scale: request.scale, rect: request.rect, annotations: request.annotations, forms: request.forms };
                const bounds = { rect: req.rect, maxTileEdge: binding.engine.limits.maxTileEdge, maxTileBytes: binding.engine.limits.maxTileBytes };
                const hooks = { signal: ctx.signal, heartbeat: () => ctx.heartbeat(), cooperate: () => ctx.slice() };
                const off = await runPdfRenderJob(item.doc.render(req), bounds, hooks);
                let pixels = off.pixels, emphasisResult: { eligibleGlyphs: number; changedPixels: number } | undefined;
                if (request.variant === 'emphasis') {
                    const plan = buildEmphasisPlan(rawPage(item, page), { locale: request.emphasis.locale, deviceScale: request.scale });
                    let changedPixels = 0;
                    if (plan.eligibleGlyphs) {
                        item.clone ??= item.doc.openEmphasisClone?.();
                        if (!item.clone?.emphasisStroked) throw new PdfEngineError('NotSupported', 'PDF emphasis is unavailable');
                        const cloneGeometry = item.clone.page(page);
                        if (JSON.stringify(cloneGeometry) !== JSON.stringify(pageGeometry)) throw bad('EngineBroken', 'PDF clone geometry mismatch');
                        const on = await runPdfRenderJob(item.clone.emphasisStroked(req, plan.objectIndexes, request.emphasis.strokeEm), bounds, hooks);
                        const composed = compositeEmphasis(new Uint8Array(off.pixels), new Uint8Array(on.pixels), plan.cells,
                            { x: off.originX, y: off.originY, width: off.w, height: off.h, pageX: 0, pageY: 0, scale: req.scale });
                        pixels = composed.pixels.buffer as ArrayBuffer; changedPixels = composed.changedPixels;
                    }
                    emphasisResult = { eligibleGlyphs: plan.eligibleGlyphs, changedPixels };
                }
                ctx.transfer(pixels); return { ...request, pixels, w: off.w, h: off.h, heapBytes: backend.heapBytes(),
                    ms: { load: 0, render: performance.now() - start, copy: 0 }, ...(emphasisResult ? { emphasisResult } : {}) };
            }),
            'page.links': serial((value, ctx) => { const { args, key, item } = lookup(value), page = pageNumber(args.page, item); geometry(key, item, page, ctx); return item.doc.links(page); }),
            'page.complexity': serial(value => { const { args, item } = lookup(value); return item.doc.complexity(pageNumber(args.page, item)); }),
            'page.release': serial(value => { const { args, item } = lookup(value), page = pageNumber(args.page, item); item.raw.delete(page); item.doc.releasePage(page); item.clone?.releasePage(page); return {}; }),
            'doc.outline': serial(value => { const { item } = lookup(value); return item.doc.outline({ maxDepth: 64, maxNodes: 20_000 }); }),
            'doc.attachment': serial((value, ctx) => { const { args, item } = lookup(value); if (!Number.isSafeInteger(args.index) || !Number.isSafeInteger(args.maxBytes) || (args.maxBytes as number) < 0 || (args.maxBytes as number) > 0x7fffffff) throw bad('RangeError', 'Invalid attachment request'); const data = item.doc.attachment(args.index as number, args.maxBytes as number); const buffer = data.slice().buffer as ArrayBuffer; ctx.transfer(buffer); return buffer; }),
            'worker.stats': serial(() => ({ heapBytes: backend?.heapBytes() ?? 0, docs: docs.size, pagesLoaded: [...docs.values()].reduce((sum, item) => sum + item.raw.size, 0), blockCacheBytes: [...docs.values()].reduce((sum, item) => sum + item.source.cachedBytes, 0) })),
        } });
    return () => { if (closed) return; closed = true; stop(); for (const item of docs.values()) { item.clone?.close(); item.doc.close(); item.source.close(); } docs.clear(); channel.port1.close(); channel.port2.close(); };
}
