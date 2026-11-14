import { routeEngines } from './engineRouting';
import type { PdfViewer } from './engineRouting';
import type { PdfRouteSession } from './pdfSessionRoute.types';

const pdfRouteSlot = Symbol('PDF viewer route');
type RouteSlot = { viewer: PdfViewer };
const listeners = new Set<() => void>();

export function subscribePdfSessionRoute(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

function routeValue(value: RouteSlot | PdfViewer | undefined): PdfViewer | undefined {
    const viewer = typeof value === 'string' ? value : value?.viewer;
    return viewer === 'classic' || viewer === 'tiled' ? viewer : undefined;
}

/** App chooses once when the session is created; graph/pane remounts only read it (C7.3). */
export function ensurePdfSessionRoute(session: PdfRouteSession, inherited?: PdfViewer): PdfViewer {
    const existing = session.getSlot<RouteSlot | PdfViewer>(pdfRouteSlot);
    const route = routeValue(existing) ?? inherited ?? routeEngines().pdfViewer;
    if (typeof existing === 'string' || !existing) session.setSlot(pdfRouteSlot, { viewer: route });
    else if (!routeValue(existing)) existing.viewer = route;
    return route;
}

export function readPdfSessionRoute(session: PdfRouteSession): PdfViewer | undefined {
    return routeValue(session.getSlot<RouteSlot | PdfViewer>(pdfRouteSlot));
}

/** The caller must bind this explicit choice to the live App session. */
export function choosePdfSessionRoute(session: PdfRouteSession, viewer: PdfViewer): void {
    if (viewer !== 'classic' && viewer !== 'tiled') throw new RangeError('Invalid PDF viewer');
    const existing = session.getSlot<RouteSlot | PdfViewer>(pdfRouteSlot);
    const previous = routeValue(existing);
    if (existing && typeof existing === 'object') existing.viewer = viewer;
    else session.setSlot(pdfRouteSlot, { viewer });
    if (previous === viewer) return;
    for (const listener of [...listeners]) { try { listener(); } catch { /* One observer cannot prevent the route change. */ } }
}
