import { createPlatformCapturer } from '../../platform/render/captureRuntime';
import { pageAt } from '../../platform/render';
import type { PageStack, Rect, RenderToken } from '../../platform/render';
import type { CaptureOptions, CaptureSnapshot } from '../../platform/render/capture';
import { assertPdfCaptureAllowed, tiledPdfCapabilities } from '../../utils/pdfCapabilities';
import { getReadingPreferences } from '../../utils/readingPreferences';
import { getPdfFontEpoch, pdfVariantRevision, subscribePdfFontEpoch } from '../fonts/profiles';
import { createPdfEmphasisController } from '../emphasis/controller';
import type { PdfEmphasisCapability, PdfEmphasisController } from '../emphasis/controller';
import { getPdfPageQuality } from '../quality/store';
import { createPdfCaptureSnapshot } from '../layer/captureSnapshot';
import { pdfDocKey } from '../worker/protocol';
import { consumePdfTileArrival } from '../pool/arrivalWindow';
import type { PdfTiledDocumentSession } from './documentSession';

const slot = Symbol('PDF session capturer');
const MAX_SIDE = 1568, MAX_REGION_AXIS = 10_000_000, MAX_CAPTURE_PAGES = 1024;
export type PdfSessionCapturer = Pick<ReturnType<typeof createPlatformCapturer>, 'captureRegion' | 'dispose'> & {
    capturePageWithInfo(page: number, maxSide: number, signal?: AbortSignal): Promise<{
        bitmap: ImageBitmap; emphasis: PdfEmphasisCapability; check(): void; release(): void;
    }>;
};
type CaptureLease = Awaited<ReturnType<PdfTiledDocumentSession['acquireCapture']>>;
type DocumentWithEmphasis = CaptureLease['document'] & { readonly emphasis?: PdfEmphasisController };
type Launch = { snapshot(request: Parameters<typeof createPdfCaptureSnapshot>[1], memory: Parameters<typeof createPdfCaptureSnapshot>[2]): CaptureSnapshot };

const stale = () => new DOMException('PDF capture source or rendering profile changed', 'AbortError');
const sameToken = (a: RenderToken, b: RenderToken) => a.vaultEpoch === b.vaultEpoch && a.documentId === b.documentId &&
    a.bytesGeneration === b.bytesGeneration && a.session === b.session;

function waitForPageEmphasis(controller: PdfEmphasisController, page: number, signal: AbortSignal,
    check: () => void): Promise<PdfEmphasisCapability> {
    return new Promise((resolve, reject) => {
        let done = false;
        const finish = (value?: PdfEmphasisCapability, error?: unknown) => {
            if (done) return;
            done = true; unsubscribe(); signal.removeEventListener('abort', abort);
            if (error !== undefined) reject(error); else resolve(value!);
        };
        const abort = () => finish(undefined, signal.reason ?? stale());
        const poll = () => {
            try {
                check();
                const capability = controller.capability(page);
                if (capability.kind !== 'unknown') finish(capability);
            } catch (error) { finish(undefined, error); }
        };
        const unsubscribe = controller.subscribe(poll);
        signal.addEventListener('abort', abort, { once: true });
        poll();
    });
}

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
        async capturePageWithInfo(page, maxSide, signal) {
            if (disposed || !session.isCurrent()) throw stale();
            if (!Number.isSafeInteger(page) || page < 0 || page >= stack.rects.length || !Number.isFinite(maxSide) || maxSide <= 0) {
                throw new RangeError('Invalid PDF capture page');
            }
            const combined = AbortSignal.any([session.lifetimeSignal, AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]);
            combined.throwIfAborted();
            const token = Object.freeze({ ...session.token }), source = session.source;
            const key = pdfDocKey({ ...token, source }), epoch = getPdfFontEpoch(key);
            const enabled = getReadingPreferences().emphasis.enabled;
            const lease = await session.acquireCapture(), pdf = lease.document.poolDocument;
            let temporary: PdfEmphasisController | undefined, selected: PdfEmphasisController | undefined;
            let released = false, profile: string | undefined, capabilityProfile: string | undefined;
            const release = () => { if (!released) { released = true; temporary?.dispose(); lease.release(); } };
            const check = () => {
                combined.throwIfAborted();
                if (released || disposed || lease.signal.aborted || !session.isCurrent() || !sameToken(session.token, token) ||
                    session.source !== source || pdf.closed || pdf.docKey !== key || pdf.source !== source || !sameToken(pdf.token, token) ||
                    getPdfFontEpoch(key) !== epoch || getReadingPreferences().emphasis.enabled !== enabled ||
                    (profile !== undefined && JSON.stringify(selected?.variant(page) ?? { variant: 'plain', profileKey: 'plain' }) !== profile) ||
                    (capabilityProfile !== undefined && JSON.stringify(selected?.capability(page)) !== capabilityProfile)) throw stale();
                assertPdfCaptureAllowed(tiledPdfCapabilities(pdf.info));
                if (getPdfPageQuality(key, page).state === 'degraded') throw new Error('This PDF page may be incomplete and cannot be captured as complete.');
            };
            try {
                check();
                let emphasis: PdfEmphasisCapability = { kind: 'inactive', reason: 'Word emphasis is turned off.' };
                if (enabled) {
                    const shared = lease.document.emphasis, known = shared.capability(page), painted = shared.variant(page);
                    if (known.kind !== 'unknown' && (known.kind === 'active') === (painted.variant === 'emphasis')) {
                        selected = shared; emphasis = known;
                    } else {
                        // A one-page P0 proof follows the preference even while the pane is hidden,
                        // without changing the displayed controller or starting a viewport.
                        temporary = createPdfEmphasisController(pdf); selected = temporary;
                        temporary.setEnabled(true); temporary.setVisiblePages([page], page, true);
                        emphasis = await waitForPageEmphasis(temporary, page, combined, check);
                        check();
                    }
                    capabilityProfile = JSON.stringify(emphasis);
                }
                const variant = selected?.variant(page) ?? { variant: 'plain' as const, profileKey: 'plain' as const };
                profile = JSON.stringify(variant);
                const frozenEmphasis = Object.freeze({ ...emphasis });
                const geometry = await pdf.resolveGeometry(page, { priority: 0, signal: combined });
                check();
                const scale = Math.min(maxSide, MAX_SIDE) / Math.max(geometry.width, geometry.height);
                const bitmap = await pdf.renderPage(page, scale, { priority: 0, ...variant, maxPixels: MAX_SIDE * MAX_SIDE, signal: combined });
                try {
                    check();
                    if (bitmap.width < 1 || bitmap.height < 1 || bitmap.width > MAX_SIDE || bitmap.height > MAX_SIDE) throw new RangeError('Invalid PDF capture dimensions');
                    return { bitmap, emphasis: frozenEmphasis, check, release };
                } catch (error) { bitmap.close(); throw error; }
            } catch (error) { release(); throw error; }
        },
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
