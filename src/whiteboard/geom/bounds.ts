// Packed scene/index boxes use [minX,minY,maxX,maxY], never Float32 absolute positions.
export type Box = readonly [number, number, number, number];
export function validBox(a: ArrayLike<number>, offset = 0): boolean {
    return Number.isFinite(a[offset]) && Number.isFinite(a[offset + 1]) && Number.isFinite(a[offset + 2])
        && Number.isFinite(a[offset + 3]) && a[offset] <= a[offset + 2] && a[offset + 1] <= a[offset + 3];
}
export function writeBox(out: Float64Array, offset: number, x0: number, y0: number, x1: number, y1: number): void {
    if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1) || x1 < x0 || y1 < y0) {
        throw new RangeError('Scene bounds must be finite and ordered');
    }
    out[offset] = x0; out[offset + 1] = y0; out[offset + 2] = x1; out[offset + 3] = y1;
}
export function unionBox(out: Float64Array, offset: number, a: ArrayLike<number>, ai: number, b: ArrayLike<number>, bi: number): void {
    out[offset] = Math.min(a[ai], b[bi]); out[offset + 1] = Math.min(a[ai + 1], b[bi + 1]);
    out[offset + 2] = Math.max(a[ai + 2], b[bi + 2]); out[offset + 3] = Math.max(a[ai + 3], b[bi + 3]);
}
export function intersects(a: ArrayLike<number>, ai: number, b: ArrayLike<number>, bi: number): boolean {
    return a[ai] <= b[bi + 2] && b[bi] <= a[ai + 2] && a[ai + 1] <= b[bi + 3] && b[bi + 1] <= a[ai + 3];
}
export function transformBox(out: Float64Array, offset: number, box: ArrayLike<number>, start: number, matrix: ArrayLike<number>, mi = 0): void {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < 4; i++) {
        const x = box[start + (i & 1 ? 2 : 0)], y = box[start + (i & 2 ? 3 : 1)];
        const wx = matrix[mi] * x + matrix[mi + 2] * y + matrix[mi + 4];
        const wy = matrix[mi + 1] * x + matrix[mi + 3] * y + matrix[mi + 5];
        minX = Math.min(minX, wx); minY = Math.min(minY, wy); maxX = Math.max(maxX, wx); maxY = Math.max(maxY, wy);
    }
    const numeric = 64 * Number.EPSILON * Math.max(1, Math.abs(minX), Math.abs(minY), Math.abs(maxX), Math.abs(maxY));
    writeBox(out, offset, minX - numeric, minY - numeric, maxX + numeric, maxY + numeric);
}
export function multiplyAffine(out: Float64Array, oi: number, a: ArrayLike<number>, ai: number, b: ArrayLike<number>, bi: number): void {
    const x0 = a[ai] * b[bi] + a[ai + 2] * b[bi + 1], y0 = a[ai + 1] * b[bi] + a[ai + 3] * b[bi + 1];
    const x1 = a[ai] * b[bi + 2] + a[ai + 2] * b[bi + 3], y1 = a[ai + 1] * b[bi + 2] + a[ai + 3] * b[bi + 3];
    const x = a[ai] * b[bi + 4] + a[ai + 2] * b[bi + 5] + a[ai + 4], y = a[ai + 1] * b[bi + 4] + a[ai + 3] * b[bi + 5] + a[ai + 5];
    if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x) || !Number.isFinite(y)) throw new RangeError('Scene transform overflows');
    out[oi] = x0; out[oi + 1] = y0; out[oi + 2] = x1; out[oi + 3] = y1; out[oi + 4] = x; out[oi + 5] = y;
}
export function inverseAffine(out: Float64Array, oi: number, source: ArrayLike<number>, si = 0): boolean {
    const a = source[si], b = source[si + 1], c = source[si + 2], d = source[si + 3], e = source[si + 4], f = source[si + 5];
    const determinant = a * d - b * c;
    if (!Number.isFinite(determinant) || determinant === 0) return false;
    out[oi] = d / determinant; out[oi + 1] = -b / determinant; out[oi + 2] = -c / determinant; out[oi + 3] = a / determinant;
    out[oi + 4] = (c * f - d * e) / determinant; out[oi + 5] = (b * e - a * f) / determinant;
    for (let i = 0; i < 6; i++) if (!Number.isFinite(out[oi + i])) return false;
    return true;
}

