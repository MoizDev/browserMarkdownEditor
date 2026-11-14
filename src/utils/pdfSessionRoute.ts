import { routeEngines } from './engineRouting';
import type { PdfViewer } from './engineRouting';
import type { PdfRouteSession } from './pdfSessionRoute.types';

const pdfRouteSlot = Symbol('PDF viewer route');

/** App chooses once when the session is created; graph/pane remounts only read it (C7.3). */
export function ensurePdfSessionRoute(session: PdfRouteSession, inherited?: PdfViewer): PdfViewer {
    const existing = session.getSlot<PdfViewer>(pdfRouteSlot);
    if (existing) return existing;
    const route = inherited ?? routeEngines().pdfViewer;
    session.setSlot(pdfRouteSlot, route);
    return route;
}

export function readPdfSessionRoute(session: PdfRouteSession): PdfViewer | undefined {
    return session.getSlot<PdfViewer>(pdfRouteSlot);
}
