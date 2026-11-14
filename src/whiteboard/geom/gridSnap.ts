import { dyadicRatioInterval } from './dyadicRatio';
import { dyadic, dyadicSubtract, type Dyadic } from './numeric';
import { compareSnapMagnitude, snapDeltaFromDyadic, type ExactSnapDelta } from './snapArithmetic';
import type { Vec2 } from './path';

/** The authoring lattice is supplied by the view; it is not the adaptive display grid. */
export interface BoardSnapGrid { readonly origin: Vec2; readonly step: Vec2 }
export interface GridSnapCandidate {
    readonly delta: ExactSnapDelta;
    readonly coordinate: number;
    readonly coordinateRepresentable: boolean;
    readonly latticeIndex: bigint;
}
const ONE: Dyadic = Object.freeze({ n: 1n, e: 0 });
function plus(a: Dyadic, b: Dyadic): Dyadic { return dyadicSubtract(a, { n: -b.n, e: b.e }); }
function coordinate(origin: Dyadic, step: Dyadic, index: bigint): Dyadic {
    return plus(origin, { n: step.n * index, e: step.e });
}
function floorRatio(numerator: Dyadic, denominator: Dyadic): bigint {
    const exponent = numerator.e - denominator.e;
    const n = exponent >= 0 ? numerator.n << BigInt(exponent) : numerator.n;
    const d = exponent >= 0 ? denominator.n : denominator.n << BigInt(-exponent);
    const quotient = n / d, remainder = n % d;
    return remainder < 0n ? quotient - 1n : quotient;
}
function candidate(source: Dyadic, origin: Dyadic, step: Dyadic, index: bigint): GridSnapCandidate {
    const position = coordinate(origin, step, index), value = dyadicRatioInterval(position, ONE);
    const finite = Number.isFinite(value.lo) && Number.isFinite(value.hi);
    return Object.freeze({ delta: snapDeltaFromDyadic(dyadicSubtract(position, source)),
        coordinate: finite ? (value.lo === value.hi ? value.lo : value.lo / 2 + value.hi / 2) : 0,
        coordinateRepresentable: finite && value.lo === value.hi, latticeIndex: index });
}

/** Compare adjacent lattice points in exact binary arithmetic, including negative
 * coordinates and indices beyond Number's integer range. */
export function nearestBoardGridCoordinate(source: number, origin: number, step: number): GridSnapCandidate {
    if (![source, origin, step].every(Number.isFinite) || step <= 0) throw new RangeError('Invalid board snap grid');
    const sourceValue = dyadic(source), originValue = dyadic(origin), stepValue = dyadic(step);
    const low = floorRatio(dyadicSubtract(sourceValue, originValue), stepValue);
    const before = candidate(sourceValue, originValue, stepValue, low);
    const after = candidate(sourceValue, originValue, stepValue, low + 1n);
    // Default, calibration cut by owner: an exact midpoint chooses the lower lattice coordinate.
    return compareSnapMagnitude(before.delta, after.delta) <= 0 ? before : after;
}
