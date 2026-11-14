import { renderTokenKey, tileKeyString } from '../../platform/render';
import type { Priority } from '../../platform/workers/envelope';
import type { PageTileArgs, PageTileResult } from '../worker/protocol';
import type { WithoutDocKey } from '../pool/types';
import { getPdfFontEpoch, pdfVariantRevision } from '../fonts/profiles';
import { markPdfTileArrived } from '../pool/arrivalWindow';
import type { PdfTileRequest } from './tileDemand';
import type { CreatePdfTileProducer, PdfTileProducerOptions } from './tileProducer.types';

interface Flight {
    readonly controller: AbortController;
    readonly promise: Promise<PageTileResult>;
    readonly args: WithoutDocKey<PageTileArgs>;
    waiters: number;
    priority: Priority;
    settled: boolean;
    result: PageTileResult | null;
}

let nextRequest = 0;

function abortError(signal: AbortSignal): unknown {
    return signal.reason ?? new DOMException('PDF tile cancelled', 'AbortError');
}

function priority(request: PdfTileRequest, focused: boolean): Priority {
    return request.priority === 'prefetch' ? 2 : focused ? 0 : 1;
}

/** One pool request can serve multiple consumers, but every consumer owns its own bitmap (C5.3). */
export const createPdfTileProducer: CreatePdfTileProducer = (options: PdfTileProducerOptions) => {
    const { document } = options;
    // The pool returns reply credit only when every bitmap conversion has finished (C5.3).
    const releaseTile = document.releaseTile.bind(document);
    const flights = new Map<string, Flight>();
    return {
        render(request, signal) {
            if (signal.aborted) return Promise.reject(abortError(signal));
            if (document.closed || !options.isCurrent() || request.key.documentToken !== renderTokenKey(document.token) ||
                request.key.sourceRole !== document.source) return Promise.reject(new DOMException('Stale PDF tile', 'AbortError'));
            const variant = options.variant(request);
            const epoch = getPdfFontEpoch(document.docKey);
            if (pdfVariantRevision(variant.variant, epoch) !== request.key.contentRevision) return Promise.reject(new DOMException('Stale PDF tile profile', 'AbortError'));
            const requestedPriority = priority(request, options.isFocused());
            const key = JSON.stringify([tileKeyString(request.key), variant, options.annotations, options.forms]);
            let flight = flights.get(key);
            if (!flight) {
                if (!Number.isSafeInteger(++nextRequest)) return Promise.reject(new RangeError('PDF tile request ids exhausted'));
                const interior = request.tile.interior;
                const args: WithoutDocKey<PageTileArgs> = { page: request.page, reqId: nextRequest, scale: request.scale.scale,
                    rect: { x: interior.x, y: interior.y, w: interior.width, h: interior.height },
                    ...variant, annotations: options.annotations, forms: options.forms };
                const controller = new AbortController();
                const promise = document.tile(args, { priority: requestedPriority, signal: controller.signal });
                const created: Flight = { controller, promise, args, waiters: 0, priority: requestedPriority, settled: false, result: null };
                flight = created;
                flights.set(key, created);
                void promise.then(result => {
                    created.settled = true;
                    created.result = result;
                    if (!created.waiters) {
                        if (flights.get(key) === created) flights.delete(key);
                        releaseTile(result); created.result = null;
                    }
                }, () => { created.settled = true; if (flights.get(key) === created) flights.delete(key); });
            } else if (requestedPriority < flight.priority) {
                flight.priority = requestedPriority;
                document.reprioritise(flight.promise, requestedPriority);
            }
            const active = flight;
            active.waiters++;
            return new Promise<ImageBitmap>((resolve, reject) => {
                let done = false, converting = false, waiterReleased = false;
                const releaseWaiter = () => {
                    if (waiterReleased) return;
                    waiterReleased = true;
                    active.waiters--;
                    if (active.waiters) return;
                    if (!active.settled) {
                        if (flights.get(key) === active) flights.delete(key);
                        active.controller.abort();
                    } else if (active.result) {
                        if (flights.get(key) === active) flights.delete(key);
                        releaseTile(active.result);
                        active.result = null;
                    }
                };
                const finish = () => {
                    if (done) return false;
                    done = true;
                    signal.removeEventListener('abort', abort);
                    return true;
                };
                const abort = () => {
                    // The caller's bitmap reservation stays held until an already-started decode settles (C5.3).
                    if (converting) return;
                    if (finish()) reject(abortError(signal));
                    releaseWaiter();
                };
                signal.addEventListener('abort', abort, { once: true });
                if (signal.aborted) { abort(); return; }
                void active.promise.then(async result => {
                    if (done) return;
                    const args = active.args;
                    const width = request.tile.textureWidth, height = request.tile.textureHeight;
                    if (result.docKey !== document.docKey || result.reqId !== args.reqId || result.page !== args.page ||
                        result.scale !== args.scale || result.rect.x !== args.rect.x || result.rect.y !== args.rect.y ||
                        result.rect.w !== args.rect.w || result.rect.h !== args.rect.h || result.variant !== args.variant ||
                        result.profileKey !== args.profileKey || result.annotations !== args.annotations || result.forms !== args.forms ||
                        JSON.stringify(result.emphasis) !== JSON.stringify(args.emphasis) || result.w !== width || result.h !== height ||
                        !(result.pixels instanceof ArrayBuffer) || result.pixels.byteLength !== width * height * 4) {
                        throw new Error('PDF tile reply does not match its request');
                    }
                    if (!options.isCurrent() || document.closed || getPdfFontEpoch(document.docKey) !== epoch) throw new DOMException('Stale PDF tile', 'AbortError');
                    converting = true;
                    const bitmap = await createImageBitmap(new ImageData(new Uint8ClampedArray(result.pixels), width, height),
                        { premultiplyAlpha: 'premultiply', colorSpaceConversion: 'none' });
                    if (signal.aborted || !options.isCurrent() || document.closed || getPdfFontEpoch(document.docKey) !== epoch || !finish()) {
                        bitmap.close();
                        if (finish()) reject(signal.aborted ? abortError(signal) : new DOMException('Stale PDF tile', 'AbortError'));
                        return;
                    }
                    markPdfTileArrived(bitmap);
                    resolve(bitmap);
                }).catch(error => { if (finish()) reject(error); }).finally(releaseWaiter);
            });
        },
    };
};
