import type { Camera, Viewport } from '../../platform/types';
import type { ViewportInsets } from '../../platform/render/camera';
import { boardCameraInsets } from '../input/cameraZoom';
import type { Box } from '../geom/bounds';
import type { BoardRuntime } from '../host/runtime';
import type { BoardDoc } from '../model/doc';
import type { NodeId } from '../model/ids';
import { BoundsQuality } from '../scene/bounds';
import { boardPageStack } from '../model/pages';
import { acquireBoardGeometryScope } from './geometryScope';

export interface ContentRect { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface ContentBoundsOptions {
    readonly signal?: AbortSignal;
    /** Throws when the caller's view of the board has moved on; every await re-checks it. */
    readonly fence: () => void;
    readonly cooperate: () => Promise<void>;
}

/** The fit target for a set of roots: each root's exact ink box, cached first.
 * The scene's cached exact bounds answer every root they can; only a root the cache cannot answer exactly is realised
 * through the scene (which then caches it), and a root the scene still cannot bound is measured by the geometry scope.
 * Zoom to fit, Back to content, Zoom to selection and the View menu all read this one function, so they cannot diverge. */
export async function contentBounds(runtime: BoardRuntime, ids: readonly NodeId[], options: ContentBoundsOptions): Promise<ContentRect | null> {
    if (!ids.length) return null;
    const scene = runtime.scene ?? await runtime.ready;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const take = (box: Box) => {
        x0 = Math.min(x0, box[0]); y0 = Math.min(y0, box[1]); x1 = Math.max(x1, box[2]); y1 = Math.max(y1, box[3]);
    };
    const misses: NodeId[] = [];
    for (let i = 0; i < ids.length; i++) {
        options.fence();
        const cached = scene.worldBounds(ids[i]);
        if (cached?.quality === BoundsQuality.Exact && cached.ink) take(cached.ink); else misses.push(ids[i]);
        if ((i & 255) === 255) await options.cooperate();
    }
    const unresolved: NodeId[] = [];
    for (const id of misses) {
        options.fence();
        const exact = await scene.ensureExactBounds(id, options.signal);
        options.fence();
        if (exact?.quality === BoundsQuality.Exact && exact.ink) take(exact.ink); else unresolved.push(id);
    }
    if (unresolved.length) {
        const scope = await acquireBoardGeometryScope(runtime, unresolved, { signal: options.signal, cooperate: options.cooperate,
            current: () => { try { options.fence(); return true; } catch { return false; } } });
        try {
            for (const id of unresolved) {
                const b = scope.logicalBounds(id);
                take([b.x, b.y, b.x + b.width, b.y + b.height]);
            }
        } finally { scope.release(); }
    }
    return x0 === Infinity ? null : { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** The clearance a fit leaves around its target, in CSS px: a paper sheet keeps its gutters, a board keeps 64px per side
 * (at most 14% of an axis on a narrow view). */
export function fitEdges(doc: BoardDoc, view: Viewport, paper: boolean): ViewportInsets {
    if (paper) return { ...boardCameraInsets(doc) };
    const edge = Math.min(64, view.width * .14), vertical = Math.min(64, view.height * .14);
    return { left: edge, right: edge, top: vertical, bottom: vertical };
}

/** The largest zoom at which `box` fits inside the view minus `edges`; a zero-size target is not zoomed past 1. */
export function fitZoom(box: ContentRect, view: Viewport, edges: ViewportInsets): number {
    const width = Math.max(1, view.width - edges.left - edges.right), height = Math.max(1, view.height - edges.top - edges.bottom);
    const zx = box.width > 0 ? width / box.width : Infinity, zy = box.height > 0 ? height / box.height : Infinity;
    const target = Math.min(zx, zy);
    return Number.isFinite(target) && target > 0 ? target : 1;
}

/** The camera that centres `box` in the area the edges leave, at zoom `z`. */
export function centredCamera(box: ContentRect, z: number, view: Viewport, edges: ViewportInsets): Camera {
    const sx = (edges.left + view.width - edges.right) / 2, sy = (edges.top + view.height - edges.bottom) / 2;
    return { x: box.x + box.width / 2 - sx / z, y: box.y + box.height / 2 - sy / z, z };
}

/** The fit a target gets, for every route: natural (1:1, no clearance) or the largest zoom that fits with the clearance. */
export function fitTarget(doc: BoardDoc, view: Viewport, box: ContentRect, options: { readonly paper: boolean; readonly natural: boolean }): { readonly z: number; readonly edges: ViewportInsets } {
    if (options.natural) return { z: 1, edges: { left: 0, right: 0, top: 0, bottom: 0 } };
    const edges = fitEdges(doc, view, options.paper);
    return { z: fitZoom(box, view, edges), edges };
}

/** The union of a paper sheet's page stack, or null when it has none. */
export function pageStackBounds(doc: BoardDoc): ContentRect | null {
    const stack = boardPageStack(doc.host);
    if (!stack?.rects.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const page of stack.rects) {
        x0 = Math.min(x0, page.x); y0 = Math.min(y0, page.y);
        x1 = Math.max(x1, page.x + page.width); y1 = Math.max(y1, page.y + page.height);
    }
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export function unionRects(a: ContentRect | null, b: ContentRect | null): ContentRect | null {
    if (!a) return b;
    if (!b) return a;
    const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
    return { x: x0, y: y0, width: Math.max(a.x + a.width, b.x + b.width) - x0, height: Math.max(a.y + a.height, b.y + b.height) - y0 };
}
