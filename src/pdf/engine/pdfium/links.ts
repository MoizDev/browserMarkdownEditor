import type { PageGeometry, Rect } from '../../../platform/types';
import type { PdfLinkDestination, PdfLinkPoint, PdfLinkView, RawPdfLink } from '../../pdfLinkModel';
import { PdfEngineError } from '../types';
import type { EngineLimits } from '../types';
import type { PdfiumRuntime } from './loader';
import { pdfiumTransformBox, pdfiumTransformPoint, pdfiumUserToPage } from './geometry';
import { heapView, withPdfiumMemory } from './memory';

const VIEWS: ReadonlyArray<PdfLinkView | undefined> = [undefined, 'XYZ', 'Fit', 'FitH', 'FitV', 'FitR', 'FitB', 'FitBH', 'FitBV'];
const fallback = (page: number): PdfLinkDestination => ({ page, view: 'XYZ', params: [] });

/** PDFium destinations carry user-space coordinates; the reader gets page space. */
export function pdfiumDestination(runtime: PdfiumRuntime, document: number, destination: number, pageCount: number,
    geometryFor: (page: number) => PageGeometry): PdfLinkDestination | undefined {
    if (!destination) return undefined;
    const page = runtime.call('FPDFDest_GetDestPageIndex', document, destination);
    if (!Number.isSafeInteger(page) || page < 0 || page >= pageCount) return undefined;
    return withPdfiumMemory(runtime, 64, pointer => {
        const code = runtime.call('FPDFDest_GetView', destination, pointer, pointer + 4);
        const view = VIEWS[code];
        if (!view) return fallback(page);
        const data = heapView(runtime, pointer, 20), count = data.getUint32(0, true);
        if (count > 4) return fallback(page);
        const params = Array.from({ length: count }, (_, i) => data.getFloat32(4 + i * 4, true));
        if (!params.every(Number.isFinite)) return fallback(page);
        if (view === 'Fit' || view === 'FitB') return { page, view, params: [] };
        let geometry: PageGeometry;
        try { geometry = geometryFor(page); }
        catch (error) {
            if (error instanceof PdfEngineError && (error.name === 'PageError' || error.name === 'ResourceLimit')) return fallback(page);
            throw error;
        }
        const transform = pdfiumUserToPage(geometry);
        if (view === 'XYZ') {
            if (!runtime.call('FPDFDest_GetLocationInPage', destination, pointer, pointer + 4, pointer + 8, pointer + 12, pointer + 16, pointer + 20)) return fallback(page);
            const info = heapView(runtime, pointer, 24);
            if (!info.getInt32(0, true) || !info.getInt32(4, true)) return fallback(page);
            const xy = pdfiumTransformPoint(transform, info.getFloat32(12, true), info.getFloat32(16, true));
            if (!xy.every(Number.isFinite)) return fallback(page);
            const zoom = info.getFloat32(20, true);
            return { page, view, params: [...xy], ...(info.getInt32(8, true) && Number.isFinite(zoom) && zoom > 0 ? { zoom } : {}) };
        }
        if (view === 'FitR') {
            if (params.length !== 4) return fallback(page);
            const box = pdfiumTransformBox(transform, params[0], params[1], params[2], params[3]);
            return box[2] > box[0] && box[3] > box[1] ? { page, view, params: [...box] } : fallback(page);
        }
        // PDFium's public API cannot distinguish a null FitH/FitV coordinate
        // from a numeric zero. Prefer a page-only jump in that ambiguous case.
        if (params.length !== 1 || params[0] === 0) return fallback(page);
        const horizontal = view === 'FitH' || view === 'FitBH', bounding = view === 'FitBH' || view === 'FitBV';
        const point = horizontal ? pdfiumTransformPoint(transform, 0, params[0]) : pdfiumTransformPoint(transform, params[0], 0);
        const pageHorizontal = horizontal ? Math.abs(transform[3]) >= Math.abs(transform[2]) : Math.abs(transform[1]) > Math.abs(transform[0]);
        return { page, view: pageHorizontal ? (bounding ? 'FitBH' : 'FitH') : (bounding ? 'FitBV' : 'FitV'),
            params: [pageHorizontal ? point[1] : point[0]] };
    });
}

/** Raw URIs are copied as bytes; the privileged consumer owns URI policy. */
export function pdfiumLinks(runtime: PdfiumRuntime, document: number, page: number, geometry: PageGeometry,
    pageCount: number, geometryFor: (index: number) => PageGeometry, limits: Readonly<EngineLimits>): RawPdfLink[] {
    const transform = pdfiumUserToPage(geometry), result: RawPdfLink[] = [];
    return withPdfiumMemory(runtime, 64, pointer => {
        const view = () => heapView(runtime, pointer, 64);
        let position = 0, quadsSeen = 0, linksSeen = 0;
        while (true) {
            view().setInt32(0, position, true);
            if (!runtime.call('FPDFLink_Enumerate', page, pointer, pointer + 4)) break;
            const current = view(), next = current.getInt32(0, true), handle = current.getUint32(4, true);
            if (next <= position || !handle) throw new PdfEngineError('PageError', 'Invalid PDF link enumeration');
            position = next;
            if (++linksSeen > limits.maxLinks) throw new PdfEngineError('ResourceLimit', 'PDF page has too many links');
            if (!runtime.call('FPDFLink_GetAnnotRect', handle, pointer + 8)) continue;
            const rectData = view();
            const box = pdfiumTransformBox(transform, rectData.getFloat32(8, true), rectData.getFloat32(20, true), rectData.getFloat32(16, true), rectData.getFloat32(12, true));
            const rect: Rect = { x: box[0], y: box[1], width: box[2] - box[0], height: box[3] - box[1] };
            const count = runtime.call('FPDFLink_CountQuadPoints', handle);
            if (!Number.isSafeInteger(count) || count < 0 || count > 256 || quadsSeen + count > 20_000) throw new PdfEngineError('ResourceLimit', 'PDF link geometry exceeds its limit');
            quadsSeen += count;
            const quads: Array<readonly [PdfLinkPoint, PdfLinkPoint, PdfLinkPoint, PdfLinkPoint]> = [];
            for (let i = 0; i < count; i++) {
                if (!runtime.call('FPDFLink_GetQuadPoints', handle, i, pointer + 8)) continue;
                const quad = view(), points: PdfLinkPoint[] = [];
                for (const index of [0, 1, 3, 2]) {
                    const point = pdfiumTransformPoint(transform, quad.getFloat32(8 + index * 8, true), quad.getFloat32(12 + index * 8, true));
                    points.push({ x: point[0], y: point[1] });
                }
                if (points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))) quads.push([points[0], points[1], points[2], points[3]]);
            }
            const direct = runtime.call('FPDFLink_GetDest', document, handle) >>> 0;
            const action = runtime.call('FPDFLink_GetAction', handle) >>> 0;
            let item: RawPdfLink = { rect, action: 'other', ...(quads.length ? { quads } : {}) };
            if (direct) item = { ...item, action: 'goto', dest: pdfiumDestination(runtime, document, direct, pageCount, geometryFor) };
            else if (action) {
                const kind = runtime.call('FPDFAction_GetType', action);
                if (kind === 1) item = { ...item, action: 'goto', dest: pdfiumDestination(runtime, document, runtime.call('FPDFAction_GetDest', document, action) >>> 0, pageCount, geometryFor) };
                else if (kind === 2 || kind === 5) item = { ...item, action: 'remote' };
                else if (kind === 4) item = { ...item, action: 'launch' };
                else if (kind === 3) {
                    const bytes = runtime.call('FPDFAction_GetURIPath', document, action, 0, 0) >>> 0;
                    if (bytes > limits.maxUriBytes + 1) throw new PdfEngineError('ResourceLimit', 'PDF link URI is too long');
                    if (bytes > 0) {
                        const uri = withPdfiumMemory(runtime, bytes, buffer => {
                            if ((runtime.call('FPDFAction_GetURIPath', document, action, buffer, bytes) >>> 0) !== bytes) throw new PdfEngineError('PageError', 'PDF link URI is unreadable');
                            const data = heapView(runtime, buffer, bytes);
                            return new Uint8Array(new Uint8Array(data.buffer, data.byteOffset, Math.max(0, bytes - 1)));
                        });
                        item = { ...item, action: 'uri', uri };
                    }
                }
            }
            result.push(item);
        }
        return result;
    });
}
