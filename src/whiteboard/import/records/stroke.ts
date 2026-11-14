import { SampleBuilder, SampleStore } from '../../ink/samples';
import type { SampleLease } from '../../model/samples';
import type { NodeBase, StrokeNode } from '../../model/nodes';
import { DASHES, FILLS, SIZES, SWATCHES, type Dash, type Fill, type Size, type Swatch } from '../../model/styles';
import { decodeLegacySegment, type LegacySegment } from '../segments';
import { object } from './envelope';
import type { LegacyShape } from './common';

function number(value: unknown, name: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid ${name}`);
    return value;
}
function choice<T extends string>(value: unknown, choices: readonly T[], name: string): T {
    if (typeof value !== 'string' || !choices.includes(value as T)) throw new Error(`Unknown ${name}`);
    return value as T;
}
function bool(value: unknown, name: string): boolean {
    if (typeof value !== 'boolean') throw new Error(`Invalid ${name}`);
    return value;
}
const PEN_WIDTHS: Readonly<Record<Size, number>> = { s: 3, m: 4.5, l: 6, xl: 11 };
const HIGHLIGHT_WIDTHS: Readonly<Record<Size, number>> = { s: 20.16, m: 26.88, l: 40.32, xl: 49.28 };

// The returned lease belongs to the importer until the host accepts or discards the draft.
export function readStroke(shape: LegacyShape, base: NodeBase, samples: SampleStore): { node: StrokeNode; lease: SampleLease } {
    const p = shape.props, highlight = shape.type === 'highlight';
    if (shape.type !== 'draw' && !highlight) throw new Error('Not a stroke');
    const size = choice(p.size, SIZES, 'size'), color: Swatch = choice(p.color, SWATCHES, 'colour');
    const pen = bool(p.isPen, 'pen flag'), scale = number(p.scale, 'scale');
    const sx = number(p.scaleX, 'scaleX'), sy = number(p.scaleY, 'scaleY');
    const dash: Dash = highlight ? 'solid' : choice(p.dash, DASHES.filter(d => d !== 'none'), 'dash');
    const fill: Fill = highlight ? 'none' : choice(p.fill, FILLS, 'fill');
    const closed = highlight ? false : bool(p.isClosed, 'closed flag');
    const complete = bool(p.isComplete, 'completion flag');
    if (scale <= 0 || !Array.isArray(p.segments)) throw new Error('Invalid stroke segments or scale');
    const builder = new SampleBuilder({ pressure: pen, declaredMaxScale: 8, precision: 'float64' });
    for (const value of p.segments) {
        const part = object(value);
        if (!part || (part.type !== 'free' && part.type !== 'straight') || typeof part.path !== 'string'
            || (part.dim !== undefined && part.dim !== 2 && part.dim !== 3)) throw new Error('Invalid stroke segment');
        const segment: LegacySegment = { type: part.type, path: part.path, dim: part.dim };
        if (pen && segment.dim === 2) throw new Error('Pen segment has no pressure channel');
        const points = decodeLegacySegment(segment);
        if (builder.count + points.length > 1_000_000) throw new Error('Stroke exceeds the point limit');
        for (const point of points) {
            builder.append(point.x, point.y, pen ? point.pressure : undefined, segment.type === 'straight' ? 'straight' : 'freehand');
        }
    }
    if (!builder.count) throw new Error('Empty stroke');
    const width = (highlight ? HIGHLIGHT_WIDTHS[size] : PEN_WIDTHS[size]) * scale;
    const lease = samples.commit(builder);
    return { lease, node: { ...base, kind: 'stroke', tool: highlight ? 'highlighter' : 'pen', samples: lease.ref,
        pressure: pen ? 'real' : 'none', widthModel: dash === 'solid' || !pen
            ? { id: 'uniform' } : { id: 'pressure-linear-v1', rMin: 0, rMax: width / 2 },
        geomVersion: 1, fairTol: 0, closed, width, sx, sy, color, fill, dash, complete } };
}
