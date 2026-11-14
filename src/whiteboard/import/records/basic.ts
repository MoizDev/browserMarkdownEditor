import type { Node, NodeBase, Point } from '../../model/nodes';
import { DASHES, SIZES, SWATCHES, type Size } from '../../model/styles';
import { object } from './envelope';
import type { LegacyShape } from './common';

function requiredNumber(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid ${field}`);
    return value;
}
function requiredString(value: unknown, field: string): string {
    if (typeof value !== 'string') throw new Error(`Invalid ${field}`);
    return value;
}
function choice<T extends string>(value: unknown, values: readonly T[], field: string): T {
    if (typeof value !== 'string' || !values.includes(value as T)) throw new Error(`Unknown ${field}`);
    return value as T;
}
const OUTLINE_WIDTHS: Readonly<Record<Size, number>> = { s: 2, m: 3.5, l: 5, xl: 10 };

export function readBasicShape(shape: LegacyShape, base: NodeBase): Node | null {
    const p = shape.props;
    switch (shape.type) {
        case 'group': return { ...base, kind: 'group' };
        case 'frame': return { ...base, kind: 'frame', w: requiredNumber(p.w, 'width'),
            h: requiredNumber(p.h, 'height'), name: requiredString(p.name, 'name'),
            color: choice(p.color, SWATCHES, 'colour') };
        case 'embed': return { ...base, kind: 'embed', w: requiredNumber(p.w, 'width'),
            h: requiredNumber(p.h, 'height'), url: requiredString(p.url, 'URL') };
        case 'line': {
            const points = object(p.points);
            if (!points) throw new Error('Invalid line points');
            const sorted = Object.values(points).map((item): Point & { index: string } => {
                const point = object(item);
                if (!point) throw new Error('Invalid line point');
                return { x: requiredNumber(point.x, 'point x'), y: requiredNumber(point.y, 'point y'),
                    index: requiredString(point.index, 'point order') };
            }).sort((a, b) => a.index < b.index ? -1 : a.index > b.index ? 1 : 0);
            const size = choice(p.size, SIZES, 'size');
            return { ...base, kind: 'polyline', points: sorted.map(({ x, y }) => ({ x, y })),
                spline: choice(p.spline, ['line', 'cubic'] as const, 'spline'),
                color: choice(p.color, SWATCHES, 'colour'), dash: choice(p.dash, DASHES.filter(d => d !== 'none'), 'dash'),
                size, width: OUTLINE_WIDTHS[size] * requiredNumber(p.scale, 'scale') };
        }
        default: return null;
    }
}
