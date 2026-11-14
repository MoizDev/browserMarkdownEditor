import type { Rect } from '../types';
import type { CompositorLayer } from './compositor.types';
import type { RectI } from './gfx/api';
import type { PageStack } from './pageStack';
import { pageAt } from './pageStack';
import type { ScheduledFrame } from './scheduler';

export interface BenchmarkPaintDomain {
    readonly rects: readonly RectI[];
    readonly vector: boolean;
}

/** Geometry names the denominator only. Current/stand-in pixels come from executed paint. */
export function benchmarkPaintDomain(snapshot: { readonly layout: Readonly<PageStack> | null; readonly layers: readonly CompositorLayer[] }, frame: ScheduledFrame): BenchmarkPaintDomain {
    const view = frame.view;
    const width = Math.round(view.viewport.width * view.viewport.dpr);
    const height = Math.round(view.viewport.height * view.viewport.dpr);
    const rects: RectI[] = [];
    const append = (rect: Readonly<Rect>) => {
        // Single-sample GPU fragments are evaluated at pixel centres, not an AA envelope.
        const x = Math.max(0, Math.ceil(rect.x - 0.5));
        const y = Math.max(0, Math.ceil(rect.y - 0.5));
        const right = Math.min(width, Math.ceil(rect.x + rect.width - 0.5));
        const bottom = Math.min(height, Math.ceil(rect.y + rect.height - 0.5));
        if (right > x && bottom > y) rects.push(Object.freeze({ x, y, width: right - x, height: bottom - y }));
    };
    const custom = snapshot.layers.filter(layer => layer.group === 'document' && layer.benchmarkDomain);
    if (custom.length) {
        for (const layer of custom) for (const rect of layer.benchmarkDomain!(frame)) append(rect);
        return Object.freeze({ vector: false, rects: Object.freeze(rects) });
    }
    const layout = snapshot.layout;
    if (layout) {
        const scale = view.camera.z * view.viewport.dpr;
        const bottom = view.camera.y + view.viewport.height / view.camera.z;
        for (let index = Math.max(0, pageAt(layout, view.camera.y)); index < layout.rects.length; index++) {
            const rect = layout.rects[index];
            if (rect.y > bottom) break;
            append({ x: (rect.x - view.camera.x) * scale, y: (rect.y - view.camera.y) * scale,
                width: rect.width * scale, height: rect.height * scale });
        }
        return Object.freeze({ vector: false, rects: Object.freeze(rects) });
    }
    // An infinite vector document has no raster denominator or page gaps. Object fidelity
    // remains the separate canonical painter's responsibility, never a cache-coverage claim.
    if (snapshot.layers.some(layer => layer.group === 'document')) append({ x: 0, y: 0, width, height });
    return Object.freeze({ vector: true, rects: Object.freeze(rects) });
}
