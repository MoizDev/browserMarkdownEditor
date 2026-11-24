/** Page-local CSS coordinates at the request's immutable layout scale. */
export interface PageRect {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
}

export interface RenderTarget {
    readonly emphasis: boolean;
    readonly scale: number;
    readonly dpr: number;
    /** Null means a whole page; otherwise preserve the full-resolution band. */
    readonly rect: PageRect | null;
    readonly need: PageRect | null;
    /** Half-margin hysteresis, except at an actual page edge. */
    readonly trigger: PageRect | null;
}

const contains = (outer: PageRect, inner: PageRect): boolean =>
    inner.x >= outer.x - 0.5 && inner.y >= outer.y - 0.5
    && inner.x + inner.w <= outer.x + outer.w + 0.5
    && inner.y + inner.h <= outer.y + outer.h + 0.5;

/** Old pixels must cover the latest need, not the other way around. */
export function satisfies(have: RenderTarget | undefined, want: RenderTarget): boolean {
    if (!have || have.scale !== want.scale || have.dpr !== want.dpr || have.emphasis !== want.emphasis) return false;
    if (want.rect === null) return have.rect === null;
    if (have.rect === null) return true;
    return have.trigger !== null && want.need !== null && contains(have.trigger, want.need);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Pure budget arithmetic, shared by the request and its raster dimensions. */
export function pageRenderRegion(page: Readonly<{ w: number; h: number }>, viewport: PageRect, dpr: number, maxPixels: number): Pick<RenderTarget, 'rect' | 'need' | 'trigger'> {
    const { w, h } = page;
    if (w * h * dpr * dpr <= maxPixels) return { rect: null, need: null, trigger: null };
    // Prefetch can be just past a page's bottom/right. Put its minimum strip
    // INSIDE that page, or the resulting band cannot satisfy its own need.
    const minW = Math.min(1, w), minH = Math.min(1, h);
    const x = clamp(viewport.x, 0, w - minW), y = clamp(viewport.y, 0, h - minH);
    const need: PageRect = { x, y,
        w: Math.max(minW, clamp(viewport.x + viewport.w, 0, w) - x),
        h: Math.max(minH, clamp(viewport.y + viewport.h, 0, h) - y) };
    const room = Math.max(0, maxPixels / (dpr * dpr) - need.w * need.h);
    const span = need.w + need.h;
    const m = (Math.sqrt(span * span + 4 * room) - span) / 4;
    const rx = Math.max(0, need.x - m), ry = Math.max(0, need.y - m);
    const rect: PageRect = { x: rx, y: ry,
        w: Math.min(w, need.x + need.w + m) - rx,
        h: Math.min(h, need.y + need.h + m) - ry };
    const edge = (lo: number, hi: number, limit: number) =>
        [lo <= 0.5 ? lo : lo + m / 2, hi >= limit - 0.5 ? hi : hi - m / 2] as const;
    const [tx0, tx1] = edge(rect.x, rect.x + rect.w, w);
    const [ty0, ty1] = edge(rect.y, rect.y + rect.h, h);
    return { rect, need, trigger: { x: tx0, y: ty0, w: tx1 - tx0, h: ty1 - ty0 } };
}
