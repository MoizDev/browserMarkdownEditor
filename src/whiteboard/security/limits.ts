// Resource limits are admission ceilings, not promises that every ceiling can be reserved at once.
export const SECURITY_LIMITS = Object.freeze({
    fileBytes: 1024 * 1024 * 1024,
    recordBytes: 64 * 1024 * 1024,
    records: 5_000_000,
    encodedPoints: 48 * 1024 * 1024,
    pointsPerStroke: 1_000_000,
    textCharacters: 1_000_000,
    jsonDepth: 128,
    richDepth: 32,
    idCharacters: 128,
    sheets: 1000,
    parentDepth: 64,
    world: 10_000_000,
    clipboardHtmlBytes: 64 * 1024 * 1024,
    htmlElements: 100_000,
    htmlDepth: 64,
    clipboardExpandedBytes: 256 * 1024 * 1024,
    clipboardRecords: 200_000,
    clipboardNodes: 100_000,
    inlineMediaBytes: 512 * 1024 * 1024,
    mediaBytes: 10 * 1024 * 1024,
    mediaPixels: 2 ** 26,
    svgBytes: 5 * 1024 * 1024,
    svgElements: 50_000,
    svgDepth: 64,
    mediaBatch: 100,
    previewBytes: 1024 * 1024,
    urlCharacters: 2048,
    pendingJobs: 8,
} as const);

export type BudgetResult<T> = { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly reason: string };
const refused = <T>(reason: string): BudgetResult<T> => ({ ok: false, reason });
const integer = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

/** Check before addition so a hostile length cannot overflow and wrap an admission counter. */
export function checkedAdd(current: number, amount: number, limit: number): BudgetResult<number> {
    if (!integer(current) || !integer(amount) || !integer(limit) || current > limit || amount > limit - current) {
        return refused('Resource budget exceeded or invalid');
    }
    return { ok: true, value: current + amount };
}

/** Check before multiplication, including the platform's exact-integer arithmetic ceiling. */
export function checkedMultiply(left: number, right: number, limit: number): BudgetResult<number> {
    if (!integer(left) || !integer(right) || !integer(limit) || (right !== 0 && left > Math.floor(limit / right))) {
        return refused('Resource budget exceeded or invalid');
    }
    return { ok: true, value: left * right };
}

export function checkMediaBytes(bytes: number, kind: 'raster' | 'video' | 'svg'): BudgetResult<number> {
    if (kind !== 'raster' && kind !== 'video' && kind !== 'svg') return refused('Unknown media admission kind');
    const limit = kind === 'svg' ? SECURITY_LIMITS.svgBytes : SECURITY_LIMITS.mediaBytes;
    if (!integer(bytes) || bytes > limit) return refused('Media exceeds its encoded-byte limit');
    return { ok: true, value: bytes };
}

/** Intrinsic dimensions must be known and admitted before invoking a browser decoder. */
export function checkMediaDimensions(width: number, height: number): BudgetResult<{ readonly pixels: number; readonly rgbaBytes: number }> {
    if (!integer(width) || !integer(height) || width === 0 || height === 0) return refused('Media dimensions must be positive integers');
    const pixels = checkedMultiply(width, height, SECURITY_LIMITS.mediaPixels);
    if (!pixels.ok) return pixels;
    const bytes = checkedMultiply(pixels.value, 4, Number.MAX_SAFE_INTEGER);
    if (!bytes.ok) return bytes;
    return { ok: true, value: { pixels: pixels.value, rgbaBytes: bytes.value } };
}

export type BudgetKey = 'encoded' | 'expanded' | 'records' | 'points' | 'pixels';
export type ByteBudget = Readonly<Record<BudgetKey, number>>;

/** One session/job owns one accumulator. A failed charge changes no counter. */
export class BudgetCounter {
    private readonly used: Record<BudgetKey, number> = { encoded: 0, expanded: 0, records: 0, points: 0, pixels: 0 };
    constructor(private readonly limits: ByteBudget) {
        for (const key of Object.keys(this.used) as BudgetKey[]) {
            if (!integer(limits[key])) throw new RangeError('Invalid resource budget');
        }
        this.limits = Object.freeze({ encoded: limits.encoded, expanded: limits.expanded, records: limits.records,
            points: limits.points, pixels: limits.pixels });
    }
    charge(key: BudgetKey, amount: number): BudgetResult<number> {
        if (!Object.hasOwn(this.used, key)) return refused('Unknown resource budget');
        const next = checkedAdd(this.used[key], amount, this.limits[key]);
        if (next.ok) this.used[key] = next.value;
        return next;
    }
    snapshot(): ByteBudget { return Object.freeze({ ...this.used }); }
}
