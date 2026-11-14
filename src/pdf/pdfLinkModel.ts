import type { PageGeometry, Rect } from '../platform/types';
import { safePdfUri } from './pdfUriPolicy';

export type PdfLinkView = 'XYZ' | 'Fit' | 'FitH' | 'FitV' | 'FitR' | 'FitB' | 'FitBH' | 'FitBV';
export interface PdfLinkDestination {
    page: number;
    view: PdfLinkView;
    params: readonly number[];
    zoom?: number;
}
export interface PdfLinkPoint { x: number; y: number }
/** Coordinates from page.links are already in the rotated PageGeometry frame. */
export interface RawPdfLink {
    rect: Rect;
    quads?: readonly (readonly [PdfLinkPoint, PdfLinkPoint, PdfLinkPoint, PdfLinkPoint])[];
    uri?: string | Uint8Array;
    dest?: PdfLinkDestination;
    action: 'uri' | 'goto' | 'remote' | 'launch' | 'named' | 'other';
    name?: string;
}
export type PdfLinkTarget =
    | { kind: 'uri'; uri: string }
    | { kind: 'destination'; page: number; view?: PdfLinkView; params?: readonly number[]; zoom?: number }
    | { kind: 'named'; name: 'NextPage' | 'PrevPage' | 'FirstPage' | 'LastPage' };
export interface PdfPageLink {
    /** Separate clipped polygons: never combine disjoint quads into a bounding hit box. */
    regions: readonly (readonly PdfLinkPoint[])[];
    target: PdfLinkTarget;
}

const VIEWS: Readonly<Record<PdfLinkView, number>> = {
    XYZ: 2, Fit: 0, FitH: 1, FitV: 1, FitR: 4, FitB: 0, FitBH: 1, FitBV: 1,
};
const MAX_LINKS = 5000;

function targetOf(link: RawPdfLink, pageCount: number): PdfLinkTarget | null {
    if (link.action === 'uri') {
        const uri = link.uri === undefined ? null : safePdfUri(link.uri);
        return uri ? { kind: 'uri', uri } : null;
    }
    if (link.action === 'named') {
        switch (link.name) {
            case 'NextPage': case 'PrevPage': case 'FirstPage': case 'LastPage':
                return { kind: 'named', name: link.name };
            default: return null;
        }
    }
    if (link.action !== 'goto' || !link.dest) return null;
    const { page, view, params, zoom } = link.dest;
    if (!Number.isInteger(page) || page < 0 || page >= pageCount) return null;
    const fallback: PdfLinkTarget = { kind: 'destination', page };
    if (!Object.hasOwn(VIEWS, view) || !Array.isArray(params) || params.length !== VIEWS[view] ||
        !params.every(Number.isFinite) || (zoom !== undefined && (!Number.isFinite(zoom) || zoom <= 0))) return fallback;
    if (view === 'FitR' && (params[0] === params[2] || params[1] === params[3])) return fallback;
    return { kind: 'destination', page, view, params: [...params], ...(view === 'XYZ' && zoom !== undefined ? { zoom } : {}) };
}

function clipRegion(points: readonly PdfLinkPoint[], width: number, height: number): PdfLinkPoint[] {
    if (points.length < 3 || points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return [];
    let out = [...points];
    for (const [axis, edge, sign] of [['x', 0, 1], ['x', width, -1], ['y', 0, 1], ['y', height, -1]] as const) {
        const input = out; out = [];
        if (!input.length) break;
        let a = input[input.length - 1], aInside = (a[axis] - edge) * sign >= 0;
        for (const b of input) {
            const bInside = (b[axis] - edge) * sign >= 0;
            if (aInside !== bInside) {
                const t = (edge - a[axis]) / (b[axis] - a[axis]);
                out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
            }
            if (bInside) out.push(b);
            a = b; aInside = bInside;
        }
    }
    let area = 0;
    for (let i = 0; i < out.length; i++) {
        const a = out[i], b = out[(i + 1) % out.length]; area += a.x * b.y - a.y * b.x;
    }
    return Number.isFinite(area) && Math.abs(area) > 0 ? out : [];
}

/** Validate untrusted worker data into inert page-space targets. No DOM or navigation occurs here. */
export function pdfPageLinks(raw: readonly RawPdfLink[], page: Pick<PageGeometry, 'width' | 'height'>, pageCount: number): PdfPageLink[] {
    if (!Number.isFinite(page.width) || !Number.isFinite(page.height) || page.width <= 0 || page.height <= 0 ||
        !Number.isSafeInteger(pageCount) || pageCount <= 0) return [];
    const result: PdfPageLink[] = [];
    for (const link of raw.slice(0, MAX_LINKS)) {
        const target = targetOf(link, pageCount);
        if (!target) continue;
        const r = link.rect;
        const rect = r && r.width > 0 && r.height > 0 ? [
            { x: r.x, y: r.y }, { x: r.x + r.width, y: r.y },
            { x: r.x + r.width, y: r.y + r.height }, { x: r.x, y: r.y + r.height },
        ] : [];
        const source = link.quads?.length ? link.quads : [rect];
        const regions = source.map(points => clipRegion(points, page.width, page.height)).filter(points => points.length >= 3);
        if (regions.length) result.push({ regions, target });
    }
    return result;
}
