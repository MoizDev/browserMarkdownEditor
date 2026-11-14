import { createPlatformCapturer } from '../../platform/render/captureRuntime';
import { pageAt } from '../../platform/render';
import type { PageStack, Rect, RenderToken } from '../../platform/render';
import type { CaptureOptions, CaptureSnapshot } from '../../platform/render/capture';
import { assertPdfCaptureAllowed, tiledPdfCapabilities } from '../../utils/pdfCapabilities';
import { getPdfFontEpoch, pdfVariantRevision, subscribePdfFontEpoch } from '../fonts/profiles';
import type { PdfEmphasisController } from '../emphasis/controller';
import { createPdfCaptureSnapshot } from '../layer/captureSnapshot';
import { pdfDocKey } from '../worker/protocol';
import { consumePdfTileArrival } from '../pool/arrivalWindow';
import type { PdfTiledDocumentSession } from './documentSession';

const slot = Symbol('PDF session capturer');
const MAX_SIDE = 1568, MAX_REGION_AXIS = 10_000_000, MAX_CAPTURE_PAGES = 1024;
export type PdfSessionCapturer = ReturnType<typeof createPlatformCapturer>;
type CaptureLease = Awaited<ReturnType<PdfTiledDocumentSession['acquireCapture']>>;
type DocumentWithEmphasis = CaptureLease['document'] & { readonly emphasis?: PdfEmphasisController };
type Launch = { snapshot(request: Parameters<typeof createPdfCaptureSnapshot>[1], memory: Parameters<typeof createPdfCaptureSnapshot>[2]): CaptureSnapshot };

const stale = () => new DOMException('PDF capture source or rendering profile changed', 'AbortError');
const sameToken = (a: RenderToken, b: RenderToken) => a.vaultEpoch === b.vaultEpoch && a.documentId === b.documentId &&
    a.bytesGeneration === b.bytesGeneration && a.session === b.session;

/** One capture queue participant per App document session, never per pane.
 * Closing the session cancels captures only after its source leases settle. */
export function pdfSessionCapturer(session: PdfTiledDocumentSession, stack: Readonly<PageStack>): PdfSessionCapturer {
    const previous = session.getSlot<PdfSessionCapturer>(slot);
    if (previous) return previous;
    let launch: Launch | undefined;
    const underlying = createPlatformCapturer({
        paneId: `pdf:${session.token.documentId}:${session.token.session}`,
        owner: session.token,
        snapshot: (request, memory) => {
            if (!launch) throw new Error('PDF capture has no retained source');
            return launch.snapshot(request, memory);
        },
    });
    let disposed = false;
    const capturer: PdfSessionCapturer = {
        async captureRegion(rect: Rect, maxSide: number, options: CaptureOptions): Promise<ImageBitmap> {
            if (disposed || !session.isCurrent()) throw stale();
            if (!rect || ![rect.x, rect.y, rect.width, rect.height, maxSide].every(Number.isFinite) ||
                rect.width <= 0 || rect.height <= 0 || rect.width > MAX_REGION_AXIS || rect.height > MAX_REGION_AXIS ||
                Math.abs(rect.x) > MAX_REGION_AXIS || Math.abs(rect.y) > MAX_REGION_AXIS || maxSide <= 0 ||
                !options || options.theme !== 'light' || options.inverted !== false || !Array.isArray(options.layers) ||
                options.layers.length !== 1 || options.layers[0] !== 'pdf-page') {
                throw new RangeError('Invalid PDF capture region');
            }
            options.signal?.throwIfAborted();
            const token = Object.freeze({ ...session.token }), source = session.source;
            const docKey = pdfDocKey({ ...token, source }), initialEpoch = getPdfFontEpoch(docKey);
            const lease = await session.acquireCapture();
            const doc = lease.document as DocumentWithEmphasis, pdf = doc.poolDocument;
            let claimed = false, detachFont: (() => void) | undefined, detachEmphasis: (() => void) | undefined;
            const controller = new AbortController();
            try {
                const emphasis = doc.emphasis;
                const profiles = new Map<number, string>(), variants = new Map<number, 'plain' | 'emphasis'>();
                for (let page = Math.max(0, pageAt(stack, rect.y)); page < stack.rects.length; page++) {
                    const box = stack.rects[page];
                    if (box.y >= rect.y + rect.height) break;
                    if (box.x >= rect.x + rect.width || box.x + box.width <= rect.x || box.y + box.height <= rect.y) continue;
                    if (profiles.size >= MAX_CAPTURE_PAGES) throw new RangeError('PDF capture spans too many pages');
                    const variant = emphasis?.variant(page) ?? { variant: 'plain' as const, profileKey: 'plain' as const };
                    profiles.set(page, JSON.stringify(variant)); variants.set(page, variant.variant);
                }
                const check = () => {
                    if (disposed || controller.signal.aborted || lease.signal.aborted || options.signal?.aborted || !session.isCurrent() ||
                        !sameToken(session.token, token) || session.source !== source || pdf.closed || pdf.docKey !== docKey ||
                        pdf.source !== source || !sameToken(pdf.token, token) || getPdfFontEpoch(docKey) !== initialEpoch || doc.emphasis !== emphasis) throw stale();
                    assertPdfCaptureAllowed(tiledPdfCapabilities(pdf.info));
                    for (const [page, profile] of profiles) {
                        if (JSON.stringify(emphasis?.variant(page) ?? { variant: 'plain', profileKey: 'plain' }) !== profile) throw stale();
                    }
                };
                check();
                const invalidate = () => { try { check(); } catch { controller.abort(stale()); } };
                detachFont = subscribePdfFontEpoch(docKey, invalidate);
                detachEmphasis = emphasis?.subscribe(invalidate);
                check();
                const producer = {
                    async render(request: Parameters<typeof doc.producer.render>[0], signal: AbortSignal): Promise<ImageBitmap> {
                        check();
                        const profile = profiles.get(request.page);
                        if (!profile) throw stale();
                        const variant = emphasis?.variant(request.page) ?? { variant: 'plain' as const, profileKey: 'plain' as const };
                        if (JSON.stringify(variant) !== profile || request.key.contentRevision !== pdfVariantRevision(variant.variant, initialEpoch)) throw stale();
                        const bitmap = await doc.producer.render(request, AbortSignal.any([signal, controller.signal]));
                        consumePdfTileArrival(bitmap);
                        try { check(); return bitmap; } catch (error) { bitmap.close(); throw error; }
                    },
                };
                const invocation: Launch = { snapshot(request, memory) {
                    check();
                    const snapshot = createPdfCaptureSnapshot({ token, source, variant: 'plain', fontEpoch: initialEpoch,
                        pageVariant: page => { check(); const variant = variants.get(page); if (!variant) throw stale(); return variant; },
                        revision: `${token.bytesGeneration}:${initialEpoch}`, stack,
                        retain: () => {
                            claimed = true;
                            return Promise.resolve({ document: { producer }, signal: AbortSignal.any([lease.signal, controller.signal]), release: lease.release });
                        } }, request, memory);
                    return { ...snapshot, signal: AbortSignal.any([snapshot.signal, controller.signal]),
                        async prepare(capture, route, signal) {
                            check();
                            const result = await snapshot.prepare(capture, route, signal);
                            check(); return result;
                        } };
                } };
                let pending: Promise<ImageBitmap>;
                launch = invocation;
                try { pending = underlying.captureRegion(rect, Math.min(maxSide, MAX_SIDE), { ...options, policy: 'exact' }); }
                finally { launch = undefined; }
                const bitmap = await pending;
                try {
                    check();
                    if (bitmap.width > MAX_SIDE || bitmap.height > MAX_SIDE || bitmap.width * bitmap.height > MAX_SIDE * MAX_SIDE) {
                        throw new RangeError('PDF capture exceeds its pixel limit');
                    }
                    return bitmap;
                } catch (error) { bitmap.close(); throw error; }
            } finally {
                detachFont?.(); detachEmphasis?.();
                if (!claimed) lease.release();
            }
        },
        dispose() { if (disposed) return; disposed = true; underlying.dispose(); },
    };
    try { session.setSlot(slot, capturer, () => capturer.dispose()); }
    catch (error) { capturer.dispose(); throw error; }
    return capturer;
}
