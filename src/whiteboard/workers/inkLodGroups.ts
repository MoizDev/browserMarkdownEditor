import type { WorkerContext } from '../../platform/workers';

export interface DerivableLod { readonly segments: Float64Array; readonly centreErrorWorld: number; readonly radiusErrorWorld: number }
export interface DerivedLod {
    readonly segments: Float64Array;
    readonly centreErrorWorld: number;
    readonly certificate: Readonly<{ areaBoundWorld: number; referenceLowerWorld: number }>;
}

const SAFETY = 1 - 1e-9;
const BLOCK_ROWS = 32;
const MAX_GRID = 4096;
const WORK_LIMIT = 1 << 22;
const PI_UP = 22 / 7;

const clamp01 = (value: number) => value < 0 ? 0 : value > 1 ? 1 : value;

function hullDistance(px: number, py: number, ax: number, ay: number, ar: number,
    bx: number, by: number, br: number): number {
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const projected = len2 > 0 ? clamp01(((px - ax) * dx + (py - ay) * dy) / len2) : 0;
    let best = Infinity;
    for (const t of [0, 1, projected]) {
        const cx = ax + t * dx, cy = ay + t * dy, r = ar + t * (br - ar);
        best = Math.min(best, Math.max(0, Math.hypot(px - cx, py - cy) - r));
    }
    return best;
}

function continuesFrom(s: Float64Array, row: number): boolean {
    const i = row * 6, p = (row - 1) * 6;
    return s[i] === s[p + 3] && s[i + 1] === s[p + 4] && s[i + 2] === s[p + 5];
}

interface BlockOutcome { readonly accepted: boolean; readonly area: number; readonly work: number }

function certifyBlock(s: Float64Array, first: number, end: number, E: number): BlockOutcome {
    const rows = end - first;
    const ax = s[first * 6], ay = s[first * 6 + 1], ar = s[first * 6 + 2];
    const bx = s[(end - 1) * 6 + 3], by = s[(end - 1) * 6 + 4], br = s[(end - 1) * 6 + 5];
    const chord = Math.hypot(bx - ax, by - ay), radiusStep = Math.abs(br - ar);
    const limit = E * SAFETY;
    let work = 0;
    for (let k = first; k <= end; k++) {
        const row = k === end ? end - 1 : k;
        const px = k === end ? s[row * 6 + 3] : s[row * 6], py = k === end ? s[row * 6 + 4] : s[row * 6 + 1];
        const pr = k === end ? s[row * 6 + 5] : s[row * 6 + 2];
        work += 1;
        if (hullDistance(px, py, ax, ay, ar, bx, by, br) + pr > limit) return { accepted: false, area: 0, work };
    }
    const reach = chord + radiusStep;
    const steps = reach > 0 ? Math.ceil(4 * reach / E) : 1;
    if (!(steps <= MAX_GRID)) return { accepted: false, area: 0, work };
    const delta = reach / steps;
    for (let j = 0; j <= steps; j++) {
        const t = j / steps;
        const cx = ax + t * (bx - ax), cy = ay + t * (by - ay), rho = ar + t * (br - ar);
        let nearest = Infinity;
        for (let k = first; k < end; k++) {
            const i = k * 6;
            nearest = Math.min(nearest, hullDistance(cx, cy, s[i], s[i + 1], s[i + 2], s[i + 3], s[i + 4], s[i + 5]));
            work += 3;
        }
        if (nearest + rho + delta > limit) return { accepted: false, area: 0, work };
    }
    const perimeter = (x0: number, y0: number, x1: number, y1: number, r0: number, r1: number) =>
        2 * (Math.abs(x1 - x0) + Math.abs(y1 - y0)) + 8 * Math.max(r0, r1);
    let originals = 0;
    for (let k = first; k < end; k++) {
        const i = k * 6;
        originals += perimeter(s[i], s[i + 1], s[i + 3], s[i + 4], s[i + 2], s[i + 5]);
    }
    const area = E * (perimeter(ax, ay, bx, by, ar, br) + originals) + (rows + 1) * PI_UP * E * E;
    return { accepted: Number.isFinite(area), area, work };
}

export async function nestedInkLodGroups(fine: DerivableLod, scale: number, chunkCount: number,
    context: WorkerContext, scratch: (bytes: number) => void): Promise<DerivedLod | null> {
    const s = fine.segments, rows = s.length / 6;
    if (!Number.isSafeInteger(rows) || rows < 2 || !Number.isSafeInteger(chunkCount) || chunkCount < 1 ||
        !Number.isFinite(scale) || scale <= 0 || !Number.isFinite(fine.centreErrorWorld) || fine.centreErrorWorld < 0 ||
        !Number.isFinite(fine.radiusErrorWorld) || fine.radiusErrorWorld < 0) return null;
    const budget = nextDownSafe(1 / 16 / scale - fine.centreErrorWorld);
    if (!(budget > 0) || fine.radiusErrorWorld * scale > 1 / 16) return null;
    let maxRadius = 0;
    for (let i = 0; i < s.length; i += 6) {
        if (![s[i], s[i + 1], s[i + 2], s[i + 3], s[i + 4], s[i + 5]].every(Number.isFinite) || s[i + 2] < 0 || s[i + 5] < 0) return null;
        maxRadius = Math.max(maxRadius, s[i + 2], s[i + 5]);
    }
    const lower = nextDownSafe(3 * maxRadius * maxRadius);
    const allowed = nextDownSafe(nextDownSafe(lower / chunkCount) * nextDownSafe(0.02));
    if (!(lower > 0) || !(allowed > 0)) return null;
    scratch(2 * s.byteLength);
    const out = new Float64Array(s.length);
    let written = 0, total = 0, work = 0, started = performance.now(), accepted = 0;
    const cooperate = async () => {
        context.signal.throwIfAborted();
        if (work >= 4096 || performance.now() - started >= 3) {
            await context.slice(); work = 0; started = performance.now(); context.signal.throwIfAborted();
        }
    };
    let row = 0;
    while (row < rows) {
        let end = row + 1;
        while (end < rows && end - row < BLOCK_ROWS && continuesFrom(s, end)) end++;
        let outcome: BlockOutcome = { accepted: false, area: 0, work: 0 };
        if (end - row >= 2 && work < WORK_LIMIT) {
            outcome = certifyBlock(s, row, end, budget);
            work += outcome.work;
        }
        if (outcome.accepted && total + outcome.area <= allowed) {
            total += outcome.area; accepted++;
            out[written++] = s[row * 6]; out[written++] = s[row * 6 + 1]; out[written++] = s[row * 6 + 2];
            out[written++] = s[(end - 1) * 6 + 3]; out[written++] = s[(end - 1) * 6 + 4]; out[written++] = s[(end - 1) * 6 + 5];
        } else {
            for (let k = row * 6; k < end * 6; k++) out[written++] = s[k];
        }
        row = end;
        await cooperate();
    }
    if (!accepted) return null;
    return { segments: out.slice(0, written), centreErrorWorld: fine.centreErrorWorld + budget,
        certificate: Object.freeze({ areaBoundWorld: total, referenceLowerWorld: lower }) };
}

function nextDownSafe(value: number): number {
    return Number.isFinite(value) ? value * SAFETY : value;
}
