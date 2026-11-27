const QUARTER = Math.PI / 2;
const QUADRANTS = [0, QUARTER, 2 * QUARTER, 3 * QUARTER, 4 * QUARTER] as const;
const ANGLE_GRID = 2 ** -50;

export class InexactTurn extends Error {
    constructor(what: string) { super(`A mark's ${what} cannot be turned exactly`); this.name = 'InexactTurn'; }
}

function subtractsExactly(a: number, b: number): boolean {
    const s = a - b, bb = s - a;
    return Number.isFinite(s) && (a - (s - bb)) + (-b - bb) === 0;
}

function gridFor(m: number): number {
    let e = Math.ceil(Math.log2(m));
    if (2 ** e <= m) e++;
    return 2 ** (e - 53);
}

type Round = 'nearest' | 'down' | 'up';
const rounders: Record<Round, (value: number) => number> = { nearest: Math.round, down: Math.floor, up: Math.ceil };

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

export function quarters(turns: number): 0 | 1 | 2 | 3 {
    if (!Number.isSafeInteger(turns)) throw new RangeError('Invalid quarter turns');
    return (((turns % 4) + 4) % 4) as 0 | 1 | 2 | 3;
}

export function turnPoint(q: 0 | 1 | 2 | 3, x: number, y: number, w: number, h: number): [number, number] {
    if (q === 0) return [x, y];
    const [sx] = onGrid(w, [x], 'nearest'), [sy] = onGrid(h, [y], 'nearest');
    switch (q) {
        case 1: return [h - sy, sx];
        case 2: return [w - sx, h - sy];
        case 3: return [sy, w - sx];
    }
}

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
    const [c, d] = onGrid(side, [a, b], 'nearest');
    if (c !== a || d !== b) throw new InexactTurn('bounds');
    return [a, b];
}

export function turnAngle(q: 0 | 1 | 2 | 3, angle: number): number {
    if (q === 0) return angle;
    if (!Number.isFinite(angle) || angle < 0 || angle >= QUADRANTS[4]) throw new InexactTurn('rotation');
    let k = angle < QUADRANTS[1] ? 0 : angle < QUADRANTS[2] ? 1 : angle < QUADRANTS[3] ? 2 : 3;
    let offset = Math.round((angle - QUADRANTS[k]) / ANGLE_GRID) * ANGLE_GRID;
    if (offset >= QUARTER) { offset = 0; k++; }
    const turned = QUADRANTS[(k + q) % 4] + offset;
    if (turned - QUADRANTS[(k + q) % 4] !== offset || turned >= QUADRANTS[4]) throw new InexactTurn('rotation');
    return turned;
}
