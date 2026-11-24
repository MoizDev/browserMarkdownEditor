/** Exact-area cells of closed outlines for the area route (union ink). The font-rs signed-area accumulation, written as the
 * per-pixel increments it produces, and then grouped: a constant run of increments is one instance, not one per pixel.
 *
 * An instance is four floats (x0, y, n, A). It adds to every device px x of its row at or after x0 the coverage
 *     f(x) = A · clamp(x − x0 + 1, 0, n),
 * which is the prefix of increments A on [x0, x0 + n): a single increment is n = 1, a constant run of n pixels is n.
 * Summed over all instances and clamped to [0, 1] in magnitude, the accumulator is the outline's nonzero coverage:
 * exact wherever one part of the outline covers a pixel. Where two non-adjacent parts overlap inside one pixel the clamp
 * double-counts; the overlap atlas (the next step) resolves those pixels, so this module only builds the cells.
 *
 * A contour is a closed polygon in band-local device px: x, y pairs, the last point joins the first. The contour's
 * orientation is its own sign (positive or negative area adds with the winding). */

/** The instance list: four floats per instance, `count` instances. */
export interface AreaCells {
    readonly cells: Float32Array;
    readonly count: number;
}

export interface AreaCellBuilder {
    /** Appends a contour (x, y pairs, closed) and returns the instances it added. */
    addContour(points: ArrayLike<number>): void;
    /** The finished list. The builder is reusable after a result is taken. */
    result(): AreaCells;
}

/** Cells for a band of `width` × `height` device px. Instances outside the band are dropped. An instance's increments that fall
 * left of the band are not kept one by one: their sum is a constant for every pixel of the row, so each row carries one instance
 * for all of them (the band's coverage is unchanged, and a stroke crossing a band from the left costs one cell per row). */
export function createAreaCellBuilder(width: number, height: number): AreaCellBuilder {
    let cells = new Float32Array(4 * 256);
    let count = 0;
    const carry = new Float64Array(Math.max(0, height));
    const push = (x: number, y: number, n: number, value: number): void => {
        if (x >= width || y < 0 || y >= height || !(n > 0) || value === 0) return;
        // The increments at x..x+n-1 that fall left of the band (x < 0) are a per-row carry; the rest stay as one instance.
        if (x < 0) {
            const left = Math.min(n, -x);
            carry[y] += value * left;
            if (left >= n) return;
            x += left; n -= left;
            if (x >= width) return;
        }
        if ((count + 1) * 4 > cells.length) {
            const grown = new Float32Array(cells.length * 2);
            grown.set(cells);
            cells = grown;
        }
        const o = count * 4;
        cells[o] = x; cells[o + 1] = y; cells[o + 2] = n; cells[o + 3] = value;
        count++;
    };
    /** One straight edge, from (x0, y0) to (x1, y1), in font-rs order. `dir` is the sign of its vertical direction. */
    const edge = (x0: number, y0: number, x1: number, y1: number): void => {
        if (y0 === y1) return;
        let dir = 1, ax = x0, ay = y0, bx = x1, by = y1;
        if (y0 > y1) { dir = -1; ax = x1; ay = y1; bx = x0; by = y0; }
        const dxdy = (bx - ax) / (by - ay);
        let x = ax;
        if (ay < 0) x = ax - ay * dxdy;
        const yStart = Math.max(0, Math.floor(ay)), yEnd = Math.min(height, Math.ceil(by));
        for (let y = yStart; y < yEnd; y++) {
            const dy = Math.min(y + 1, by) - Math.max(y, ay);
            if (dy <= 0) continue;
            const xnext = x + dxdy * dy;
            const d = dy * dir;
            const xa = Math.min(x, xnext), xb = Math.max(x, xnext);
            const xf0 = Math.floor(xa), x0i = xf0, x1i = Math.ceil(xb);
            if (x1i <= x0i + 1) {
                const xmf = 0.5 * (x + xnext) - xf0;
                push(x0i, y, 1, d - d * xmf);
                push(x0i + 1, y, 1, d * xmf);
            } else {
                const s = 1 / (xb - xa);
                const xf = xa - xf0;
                const a0 = 0.5 * s * (1 - xf) * (1 - xf);
                const xl = xb - x1i + 1;
                const am = 0.5 * s * xl * xl;
                push(x0i, y, 1, d * a0);
                if (x1i === x0i + 2) push(x0i + 1, y, 1, d * (1 - a0 - am));
                else {
                    const a1 = s * (1.5 - xf);
                    push(x0i + 1, y, 1, d * (a1 - a0));
                    // The constant run: x0i+2 .. x1i-2 each take d·s, one instance of n pixels.
                    push(x0i + 2, y, x1i - 1 - (x0i + 2), d * s);
                    const a2 = a1 + (x1i - x0i - 3) * s;
                    push(x1i - 1, y, 1, d * (1 - a2 - am));
                }
                push(x1i, y, 1, d * am);
            }
            x = xnext;
        }
    };
    return {
        addContour(points: ArrayLike<number>): void {
            const n = points.length >> 1;
            if (n < 2) return;
            for (let i = 0; i < n; i++) {
                const j = (i + 1) % n;
                edge(points[2 * i], points[2 * i + 1], points[2 * j], points[2 * j + 1]);
            }
        },
        result(): AreaCells {
            // The carries, one instance per row: increments at x = 0 of the row's total, which every pixel of the row inherits.
            let carried = 0;
            for (let y = 0; y < height; y++) if (carry[y] !== 0) carried++;
            const total = count + carried;
            const out = new Float32Array(total * 4);
            out.set(cells.subarray(0, count * 4));
            let o = count * 4;
            for (let y = 0; y < height; y++) {
                if (carry[y] === 0) continue;
                out[o] = 0; out[o + 1] = y; out[o + 2] = 1; out[o + 3] = carry[y];
                o += 4;
            }
            return { cells: out, count: total };
        },
    };
}

/** Whether the signed-area sum of these closed contours is exact: every point's winding number is 0 or ±1, so the clamp of the
 * sum is the nonzero coverage. The sum double-counts wherever two boundaries overlap, so the contours must not cross or touch,
 * and a contour nested in another must take the opposite sign (an annulus: the hole subtracts). Same-sign nesting and crossing
 * are the cases the overlap atlas exists for; they are refused here, and the caller falls back.
 *
 * Quadratic in the edges of contours whose boxes overlap, which is cheap for a shape's outline (a handful of edges). Stroke
 * outlines are not checked here: their boundaries come from the union outline. Degenerate contours (under three points, zero
 * or non-finite area) are refused. */
export function areaNestingExact(contours: readonly ArrayLike<number>[]): boolean {
    const m = contours.length;
    const minX = new Float64Array(m), minY = new Float64Array(m), maxX = new Float64Array(m), maxY = new Float64Array(m);
    const sign = new Int8Array(m);
    for (let i = 0; i < m; i++) {
        const c = contours[i];
        const n = c.length >> 1;
        if (n < 3) return false;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, twice = 0;
        for (let k = 0; k < n; k++) {
            const x = c[2 * k], y = c[2 * k + 1];
            const j = (k + 1) % n;
            twice += x * c[2 * j + 1] - c[2 * j] * y;
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
        if (!Number.isFinite(twice) || twice === 0) return false;
        minX[i] = x0; minY[i] = y0; maxX[i] = x1; maxY[i] = y1;
        sign[i] = twice > 0 ? 1 : -1;
    }
    // Crossing or touching: any pair of edges that meet, between contours whose boxes overlap.
    for (let i = 0; i < m; i++) {
        for (let j = i + 1; j < m; j++) {
            if (maxX[i] < minX[j] || maxX[j] < minX[i] || maxY[i] < minY[j] || maxY[j] < minY[i]) continue;
            const a = contours[i], b = contours[j];
            const na = a.length >> 1, nb = b.length >> 1;
            for (let p = 0; p < na; p++) {
                const pq = (p + 1) % na;
                for (let q = 0; q < nb; q++) {
                    const qr = (q + 1) % nb;
                    if (segmentsMeet(a[2 * p], a[2 * p + 1], a[2 * pq], a[2 * pq + 1], b[2 * q], b[2 * q + 1], b[2 * qr], b[2 * qr + 1])) return false;
                }
            }
        }
    }
    // Nesting depth: the contours that contain a contour's first point (no edges meet, so that point decides the whole contour).
    const depth = new Int32Array(m);
    for (let i = 0; i < m; i++) {
        const px = contours[i][0], py = contours[i][1];
        for (let j = 0; j < m; j++) {
            if (j === i) continue;
            if (px < minX[j] || px > maxX[j] || py < minY[j] || py > maxY[j]) continue;
            if (insidePolygon(px, py, contours[j])) depth[i]++;
        }
    }
    // Each nested contour takes the opposite sign to its immediate parent, the container one level up. Containers of one point
    // form a chain, so the parent is unique; the alternating signs keep every point's winding in {0, ±1}.
    for (let i = 0; i < m; i++) {
        if (depth[i] === 0) continue;
        const px = contours[i][0], py = contours[i][1];
        let parent = -1;
        for (let j = 0; j < m; j++) {
            if (j === i || depth[j] !== depth[i] - 1) continue;
            if (px < minX[j] || px > maxX[j] || py < minY[j] || py > maxY[j]) continue;
            if (insidePolygon(px, py, contours[j])) { parent = j; break; }
        }
        if (parent < 0 || sign[parent] === sign[i]) return false;
    }
    return true;
}

/** Whether the closed segments (ax, ay)–(bx, by) and (cx, cy)–(dx, dy) share a point, touching included. */
function segmentsMeet(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
    const side = (px: number, py: number, qx: number, qy: number, rx: number, ry: number): number =>
        Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
    const within = (px: number, py: number, qx: number, qy: number, rx: number, ry: number): boolean =>
        Math.min(px, qx) <= rx && rx <= Math.max(px, qx) && Math.min(py, qy) <= ry && ry <= Math.max(py, qy);
    const d1 = side(cx, cy, dx, dy, ax, ay), d2 = side(cx, cy, dx, dy, bx, by);
    const d3 = side(ax, ay, bx, by, cx, cy), d4 = side(ax, ay, bx, by, dx, dy);
    if (d1 * d2 < 0 && d3 * d4 < 0) return true;
    if (d1 === 0 && within(cx, cy, dx, dy, ax, ay)) return true;
    if (d2 === 0 && within(cx, cy, dx, dy, bx, by)) return true;
    if (d3 === 0 && within(ax, ay, bx, by, cx, cy)) return true;
    if (d4 === 0 && within(ax, ay, bx, by, dx, dy)) return true;
    return false;
}

/** Even-odd crossing test of (px, py) against a closed contour; the caller has ruled out points on its edges. */
function insidePolygon(px: number, py: number, c: ArrayLike<number>): boolean {
    const n = c.length >> 1;
    let inside = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = c[2 * i], yi = c[2 * i + 1], xj = c[2 * j], yj = c[2 * j + 1];
        if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}
