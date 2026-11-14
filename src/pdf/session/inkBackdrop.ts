import { fitWidthZ, pageAt, pageStack } from '../../platform/render';
import type { Rect, RenderToken, ViewState } from '../../platform/render';
import { awaitSessionDisposals, getSessionIdentity } from '../../utils/sessionIdentity';
import { assertPdfCaptureAllowed, assertPdfRenderAllowed, tiledPdfCapabilities } from '../../utils/pdfCapabilities';
import { getPdfFontEpoch, pdfVariantRevision, subscribePdfFontEpoch } from '../fonts/profiles';
import { pdfPageLayerDefinition } from '../layer/definition';
import { getPdfSessionMirrors } from '../layer/tileMirror';
import { createPdfTileProducer } from '../layer/tileProducer';
import type { PdfPool } from '../pool/types';
import { pdfDocKey } from '../worker/protocol';
import { PdfTiledDocumentSession, pdfGeometryDigest } from './documentSession';
import type { TiledDocumentPool } from './documentSession';
import { tiledPoolAdapter } from './poolAdapter';
import { pdfSessionCapturer } from './sessionCapture';
import { retainPdfFocus } from './startup';
import type { PdfInkBackdrop, PdfInkBackdropOptions } from './inkBackdrop.types';
export type { PdfInkBackdrop, PdfInkBackdropOptions } from './inkBackdrop.types';
interface ViewLease { visible: boolean; focused: boolean; enabled: boolean; pages: number[]; focusPage: number }
interface Owner {
    token: RenderToken;
    fingerprint: string;
    pool: PdfPool;
    session: PdfTiledDocumentSession;
    views: Set<ViewLease>;
    ready?: ReturnType<PdfTiledDocumentSession['open']>;
}
const slot = Symbol('pristine PDF ink backdrop');
const stale = () => new DOMException('PDF ink backdrop is no longer current', 'AbortError');
const sameToken = (a: RenderToken, b: RenderToken) => a.vaultEpoch === b.vaultEpoch && a.documentId === b.documentId &&
    a.bytesGeneration === b.bytesGeneration && a.session === b.session;
const currentToken = (token: RenderToken) => {
    const identity = getSessionIdentity(token.documentId);
    return !!identity && identity.serial === token.session && identity.bytesGeneration === token.bytesGeneration;
};
function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(signal.reason ?? stale());
    return new Promise<T>((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason ?? stale()); };
        signal.addEventListener('abort', abort, { once: true });
        void promise.then(value => { signal.removeEventListener('abort', abort); if (!signal.aborted) resolve(value); },
            error => { signal.removeEventListener('abort', abort); if (!signal.aborted) reject(error); });
    });
}

/** The App slot owns the pristine source. This view owns only its layer and subscriptions. */
export async function createPdfInkBackdrop(options: PdfInkBackdropOptions): Promise<PdfInkBackdrop> {
    const { source } = options, token = Object.freeze({ ...source.token });
    options.signal?.throwIfAborted();
    if (!options.isCurrent() || !currentToken(token)) throw stale();
    await waitFor(awaitSessionDisposals(token.documentId), options.signal);
    options.signal?.throwIfAborted();
    if (!options.isCurrent() || !currentToken(token)) throw stale();
    if (!(source.pristine instanceof Blob) || source.pristine.size < 1 || source.pristine.size > 0x7fffffff ||
        !/^[a-f0-9]{64}$/.test(source.pristineFingerprint) || source.docKey !== pdfDocKey({ ...token, source: 'original' })) {
        throw new Error('Invalid pristine PDF source');
    }
    const identity = getSessionIdentity(token.documentId);
    if (!identity) throw stale();
    let owner = identity.getSlot<Owner>(slot);
    if (owner && (!sameToken(owner.token, token) || owner.fingerprint !== source.pristineFingerprint || owner.pool !== options.pool)) {
        throw new Error('The PDF ink source does not match its retained session');
    }
    if (!owner) {
        const views = new Set<ViewLease>();
        const base = tiledPoolAdapter(options.pool, (document, emphasis) => {
            return createPdfTileProducer({ document, isCurrent: () => currentToken(token),
                isFocused: () => [...views].some(view => view.visible && view.focused),
                variant: request => request.key.contentRevision.startsWith('plain') ? { variant: 'plain', profileKey: 'plain' } : emphasis.variant(request.page),
                annotations: true, forms: true });
        });
        const pristine = source.pristine;
        const pool: TiledDocumentPool = { async open(_blob, key, role, signal, password) {
            return base.open(pristine, key, role, signal, password);
        } };
        const session = new PdfTiledDocumentSession(token, 'original', async signal => {
            signal.throwIfAborted();
            return { blob: pristine, stat: { lastModified: 0, size: pristine.size }, dispose() {} };
        }, pool, currentToken);
        owner = { token, fingerprint: source.pristineFingerprint, pool: options.pool, session, views };
        identity.setSlot(slot, owner, value => value.session.close());
    }
    const retained = owner;
    if (!retained.ready) {
        const ready = retained.session.open();
        retained.ready = ready;
        void ready.catch(() => { if (retained.ready === ready) retained.ready = undefined; });
    }
    const document = await waitFor(retained.ready, options.signal);
    if (!options.isCurrent() || !retained.session.isCurrent() || options.signal?.aborted) throw stale();
    const pdf = document.poolDocument, emphasis = document.emphasis;
    if (!emphasis || pdf.source !== 'original' || pdf.docKey !== source.docKey || !sameToken(pdf.token, token)) throw stale();
    const stack = pageStack(document.pages), geometryDigest = pdfGeometryDigest(document.pages);
    const mirror = getPdfSessionMirrors({ session: retained.session, token, currentToken: () => currentToken(token) ? token : null });
    const capturer = pdfSessionCapturer(retained.session, stack), focus = retainPdfFocus(token.documentId);
    const lease: ViewLease = { visible: options.isVisible(), focused: options.isFocused(), enabled: options.emphasisEnabled(), pages: [], focusPage: -1 };
    retained.views.add(lease);
    let disposed = false;
    const sync = () => {
        const views = [...retained.views].filter(view => view.visible);
        pdf.setVisible(views.length > 0);
        emphasis.setEnabled(views.some(view => view.enabled));
        const pages = [...new Set(views.flatMap(view => view.pages))];
        const focused = views.find(view => view.focused)?.focusPage ?? views[0]?.focusPage ?? -1;
        emphasis.setVisiblePages(pages, focused, views.length > 0);
    };
    focus.setFocused(lease.visible && lease.focused);
    sync();
    const isCurrent = () => !disposed && retained.session.isCurrent() && options.isCurrent();
    const mirrorView = (view: ViewState) => ({ token, sourceRole: 'original' as const,
        contentRevision: pdfVariantRevision(lease.enabled ? 'emphasis' : 'plain', getPdfFontEpoch(pdf.docKey)),
        colourVersion: 0, geometryDigest, nominalDpr: Math.min(view.viewport.dpr, 2), view });
    const layer = pdfPageLayerDefinition({ producer: { render(request, signal) {
        assertPdfRenderAllowed(tiledPdfCapabilities(pdf.info));
        return document.producer.render(request, signal);
    } }, isCurrent: () => isCurrent() && options.isVisible(), mirror: { store: mirror, view: view => lease.enabled ? null : mirrorView(view) },
    onError: error => options.onError(error), demand(view) {
        lease.visible = options.isVisible(); lease.focused = options.isFocused(); lease.enabled = options.emphasisEnabled();
        const top = view.camera.y, bottom = top + view.viewport.height / view.camera.z;
        const pages: number[] = [];
        for (let page = Math.max(0, pageAt(stack, top)); page < stack.rects.length && stack.rects[page].y < bottom; page++) pages.push(page);
        lease.pages = pages; lease.focusPage = pages[0] ?? -1;
        focus.setFocused(lease.visible && lease.focused); sync();
        return { token, source: 'original', variant: lease.enabled ? 'emphasis' : 'plain',
            pageVariant: page => emphasis.variant(page).variant, fontEpoch: getPdfFontEpoch(pdf.docKey), stack, geometryDigest,
            viewport: { x: view.camera.x, y: top, width: view.viewport.width / view.camera.z, height: view.viewport.height / view.camera.z },
            rasterScale: view.camera.z * Math.min(view.viewport.dpr, 2), fitWidthZoom: fitWidthZ(view.viewport, stack, { left: 0, right: 0, top: 0, bottom: 0 }),
            nominalDpr: Math.min(view.viewport.dpr, 2), moving: view.moving, velocity: { x: 0, y: 0 }, direction: { x: 0, y: 0 } };
    } });
    const setVisible = (visible: boolean, focused = false) => {
        if (disposed) return;
        lease.visible = visible; lease.focused = visible && focused;
        if (!visible) { lease.pages = []; lease.focusPage = -1; }
        focus.setFocused(lease.visible && lease.focused);
        sync();
        if (!visible) layer.current()?.hide();
        else layer.current()?.retry();
    };
    const definition = { ...layer.definition, create(host: Parameters<typeof layer.definition.create>[0]) {
        const instance = layer.definition.create(host), release = instance.releaseGpu.bind(instance);
        instance.releaseGpu = reason => {
            if (reason === 'hidden') setVisible(false);
            release(reason);
        };
        return instance;
    } };
    const refresh = () => { if (isCurrent()) layer.current()?.retry(); };
    const unsubscribeFont = subscribePdfFontEpoch(pdf.docKey, refresh), unsubscribeEmphasis = emphasis.subscribe(refresh);
    const check = (signal?: AbortSignal) => { signal?.throwIfAborted(); if (!isCurrent() || pdf.closed) throw stale(); };
    const captureRegion = async (rect: Rect, maxSide: number, signal?: AbortSignal) => {
        check(signal); assertPdfCaptureAllowed(tiledPdfCapabilities(pdf.info));
        const bitmap = await capturer.captureRegion(rect, Math.min(maxSide, 1568), { layers: ['pdf-page'], theme: 'light', inverted: false, signal });
        try { check(signal); return bitmap; } catch (error) { bitmap.close(); throw error; }
    };
    return { pages: document.pages.map(page => ({ width: page.width, height: page.height })), layers: [definition], setVisible,
        async resolveGeometry(page, signal) {
            check(signal);
            const geometry = await pdf.resolveGeometry(page, { priority: 0, signal });
            check(signal); return { ...geometry, toUserSpace: [...geometry.toUserSpace] };
        }, capture: { captureRegion, renderPage(page, maxSide, signal) {
            if (!Number.isSafeInteger(page) || page < 0 || page >= stack.rects.length) return Promise.reject(new RangeError('Invalid PDF page'));
            return captureRegion(stack.rects[page], maxSide, signal);
        } }, dispose() {
            if (disposed) return;
            disposed = true; unsubscribeFont(); unsubscribeEmphasis(); focus.dispose();
            layer.current()?.hide(); retained.views.delete(lease); sync();
        } };
}
