// Exact quarter turns of a page frame: the arithmetic that moves a board's marks with a turned PDF page.
//
// A board stores its marks in the frame of the page AS DISPLAYED (origin top-left, y down, the page's
// displayed width × height). Turning the page a quarter clockwise maps (x, y) on a w×h page to (h − y, x)
// on the h×w page; a mark's rotation gains a quarter. That is one subtraction from a page side per
// coordinate, and floating point makes `h − (h − y)` come back as y only when the subtraction was exact:
// measured, y = 0.1 on a 792-point page returns 0.10000000000002274. Repeated turns would wander.
//
// So every value a turn touches is first put on a grid where the subtraction IS exact, and the grid is
// chosen from quantities a turn leaves unchanged (|v|, |side − v| and the side itself are swapped, never
// altered), so the next turn finds the value already on it and moves nothing. The snap is at most half a
// unit in the last place of the largest of those quantities (about 6e-14 points on a letter page, far
// below anything drawable) and happens at most once per value; from then on every turn is exact, and
// four quarter turns return the very same bits. A value that already subtracts exactly (integers, most
// halves) is never touched at all. Angles use the same idea on quadrants of π/2.

const QUARTER = Math.PI / 2;
// k·(π/2) is exact for k = 0…4: π/2's significand ends in three zero bits (0x…2D18), so 3·π/2 and 2π
// need no rounding, and every one of them is a multiple of 2⁻⁴⁹.
const QUADRANTS = [0, QUARTER, 2 * QUARTER, 3 * QUARTER, 4 * QUARTER] as const;
// Angles below 2π < 8 are exactly representable on a 2⁻⁵⁰ grid, which the quadrant bases also lie on.
const ANGLE_GRID = 2 ** -50;

export class InexactTurn extends Error {
    constructor(what: string) { super(`A mark's ${what} cannot be turned exactly`); this.name = 'InexactTurn'; }
}

/** a − b is representable (Knuth's two-sum error term is zero), so subtracting it again gives back b exactly. */
function subtractsExactly(a: number, b: number): boolean {
    const s = a - b, bb = s - a;
    return Number.isFinite(s) && (a - (s - bb)) + (-b - bb) === 0;
}

/** The finest power of two g such that every multiple of g with magnitude ≤ m is representable. */
function gridFor(m: number): number {
    // m < 2^e, so 53 significant bits reach down to 2^(e−53).
    let e = Math.ceil(Math.log2(m));
    if (2 ** e <= m) e++;
    return 2 ** (e - 53);
}

type Round = 'nearest' | 'down' | 'up';
const rounders: Record<Round, (value: number) => number> = { nearest: Math.round, down: Math.floor, up: Math.ceil };

/**
 * `values` placed on one grid on which `side − v` is exact for each, and stays exact for every later turn.
 * The grid comes from max(side, |v|, |side − v|): a turn maps v to side − v and back, so that maximum is
 * the same on every turn and the grid is found again. Values that already subtract exactly are kept.
 */
function onGrid(side: number, values: readonly number[], round: Round): number[] {
    if (!Number.isFinite(side) || side <= 0 || !values.every(Number.isFinite)) throw new InexactTurn('position');
    if (values.every(v => subtractsExactly(side, v))) return [...values];
    let result: readonly number[] = values;
    for (let pass = 0; pass < 4; pass++) {
        const m = Math.max(side, ...result.flatMap(v => [Math.abs(v), Math.abs(side - v)]));
        const grid = gridFor(m), next = result.map(v => rounders[round](v / grid) * grid);
        if (side % grid !== 0) throw new InexactTurn('position');
        const stable = next.every((v, i) => v === result[i]);
        result = next;
        if (stable && result.every(v => subtractsExactly(side, v))) return [...result];
    }
    throw new InexactTurn('position');
}

/** Normalized quarter turns, clockwise: 0…3. */
export function quarters(turns: number): 0 | 1 | 2 | 3 {
    if (!Number.isSafeInteger(turns)) throw new RangeError('Invalid quarter turns');
    return (((turns % 4) + 4) % 4) as 0 | 1 | 2 | 3;
}

/** A point of a w×h page frame, turned q quarters clockwise with the page (the new page is h×w when q is odd). */
export function turnPoint(q: 0 | 1 | 2 | 3, x: number, y: number, w: number, h: number): [number, number] {
    if (q === 0) return [x, y];
    const [sx] = onGrid(w, [x], 'nearest'), [sy] = onGrid(h, [y], 'nearest');
    switch (q) {
        case 1: return [h - sy, sx];
        case 2: return [w - sx, h - sy];
        case 3: return [sy, w - sx];
    }
}

/** An axis-aligned box [x, y, width, height] of the page frame, turned with it; snapped outward, so it still covers. */
export function turnBox(q: 0 | 1 | 2 | 3, box: readonly [number, number, number, number], w: number, h: number): [number, number, number, number] {
    if (q === 0) return [box[0], box[1], box[2], box[3]];
    const [x0, x1] = onEdges(w, box[0], box[0] + box[2]), [y0, y1] = onEdges(h, box[1], box[1] + box[3]);
    const width = x1 - x0, height = y1 - y0;
    if (!subtractsExactly(x1, x0) || !subtractsExactly(y1, y0)) throw new InexactTurn('bounds');
    switch (q) {
        case 1: return [h - y1, x0, height, width];
        case 2: return [w - x1, h - y1, width, height];
        case 3: return [y0, w - x1, height, width];
    }
}
function onEdges(side: number, low: number, high: number): [number, number] {
    if (subtractsExactly(side, low) && subtractsExactly(side, high) && subtractsExactly(high, low)) return [low, high];
    const [a] = onGrid(side, [low, high], 'down'), [, b] = onGrid(side, [low, high], 'up');
    // Both on the one grid both edges share (it depends only on the pair), so their difference is exact too.
    const [c, d] = onGrid(side, [a, b], 'nearest');
    if (c !== a || d !== b) throw new InexactTurn('bounds');
    return [a, b];
}

/** A node rotation in [0, 2π) turned q quarters clockwise, exactly: quadrant base plus an offset on a 2⁻⁵⁰ grid. */
export function turnAngle(q: 0 | 1 | 2 | 3, angle: number): number {
    if (q === 0) return angle;
    if (!Number.isFinite(angle) || angle < 0 || angle >= QUADRANTS[4]) throw new InexactTurn('rotation');
    let k = angle < QUADRANTS[1] ? 0 : angle < QUADRANTS[2] ? 1 : angle < QUADRANTS[3] ? 2 : 3;
    // Exact: for k ≥ 1 the angle lies within a factor of two of its quadrant base (Sterbenz).
    let offset = Math.round((angle - QUADRANTS[k]) / ANGLE_GRID) * ANGLE_GRID;
    if (offset >= QUARTER) { offset = 0; k++; }
    const turned = QUADRANTS[(k + q) % 4] + offset;
    if (turned - QUADRANTS[(k + q) % 4] !== offset || turned >= QUADRANTS[4]) throw new InexactTurn('rotation');
    return turned;
}
