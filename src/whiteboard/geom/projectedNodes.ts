import type { NodeSetOp } from '../change/ops';
import { ARROWHEADS, SIZES } from '../model/styles';

const NUMBER_KEYS = new Set(['x', 'y', 'rotation', 'page', 'w', 'h', 'growY', 'sx', 'sy', 'scale', 'width', 'bend', 'elbowMid', 'labelScale']);
const BOOLEAN_KEYS = new Set(['flipX', 'flipY', 'autoSize']);
const MAX_POINTS = 5000;
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function pair(value: unknown): Readonly<{ x: number; y: number }> {
    if (!value || typeof value !== 'object') throw new TypeError('Invalid projected point');
    const point = value as { x?: unknown; y?: unknown };
    if (!finite(point.x) || !finite(point.y)) throw new TypeError('Invalid projected point');
    return Object.freeze({ x: point.x, y: point.y });
}
function attachment(value: unknown): unknown {
    if (value == null) return null;
    if (typeof value !== 'object') throw new TypeError('Invalid projected attachment');
    const a = value as { target?: unknown; anchor?: unknown; exact?: unknown; precise?: unknown; snap?: unknown };
    if (typeof a.target !== 'string' || !a.target || typeof a.exact !== 'boolean' || typeof a.precise !== 'boolean'
        || !['none', 'center', 'edge-point', 'edge'].includes(a.snap as string)) throw new TypeError('Invalid projected attachment');
    return Object.freeze({ target: a.target, anchor: pair(a.anchor), exact: a.exact, precise: a.precise, snap: a.snap });
}
/** Clone just the bounded geometry value, never a node or document graph. */
export async function copyProjectedValue(op: NodeSetOp, tick: () => Promise<void>, due: () => boolean): Promise<unknown> {
    const { key, value } = op;
    if (NUMBER_KEYS.has(key)) {
        if (!finite(value)) throw new TypeError(`Invalid projected ${key}`);
        if (key === 'page' && !Number.isSafeInteger(value)) throw new TypeError('Invalid projected page');
        return value;
    }
    if (BOOLEAN_KEYS.has(key)) { if (typeof value !== 'boolean') throw new TypeError(`Invalid projected ${key}`); return value; }
    if (key === 'size') {
        if (typeof value !== 'string' || !(SIZES as readonly string[]).includes(value)) throw new TypeError('Invalid projected size');
        return value;
    }
    if (key === 'points') {
        if (!Array.isArray(value) || value.length < 2 || value.length > MAX_POINTS) throw new TypeError('Invalid projected polyline points');
        const points: Readonly<{ x: number; y: number }>[] = [];
        for (const item of value) { points.push(pair(item)); if (due()) await tick(); }
        return Object.freeze(points);
    }
    if (key === 'crop') {
        if (value === null) return null;
        if (!value || typeof value !== 'object') throw new TypeError('Invalid projected crop');
        const c = value as { x0?: unknown; y0?: unknown; x1?: unknown; y1?: unknown; circle?: unknown };
        if (!finite(c.x0) || !finite(c.y0) || !finite(c.x1) || !finite(c.y1) || typeof c.circle !== 'boolean') throw new TypeError('Invalid projected crop');
        return Object.freeze({ x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, circle: c.circle });
    }
    // An arrowhead changes the arrow's reach (a closed head shortens its body), so a head toggle is projected like its ends.
    // Refused here, double-clicking an arrow's end handle never changed its head and showed this error instead.
    if (key === 'headStart' || key === 'headEnd') {
        if (typeof value !== 'string' || !(ARROWHEADS as readonly string[]).includes(value)) throw new TypeError(`Invalid projected ${key}`);
        return value;
    }
    if (key === 'startAttach' || key === 'endAttach') return attachment(value);
    if (key === 'start' || key === 'end') {
        if (!value || typeof value !== 'object') throw new TypeError('Invalid projected connector end');
        const end = value as { x?: unknown; y?: unknown; attach?: unknown };
        return Object.freeze({ ...pair(end), attach: attachment(end.attach) });
    }
    throw new Error(`Unsupported projected node property: ${key}`);
}
