import { styleGeometryMetrics } from '../../geom/styleMetrics';
import { MAX_PRESSURE, SampleBuilder, SampleStore } from '../../ink/samples';
import type { SampleLease } from '../../model/samples';
import type { NodeBase, StrokeNode } from '../../model/nodes';
import { DASHES, FILLS, SIZES, SWATCHES, type Dash, type Fill, type Swatch } from '../../model/styles';
import type { ReportBuilder } from '../report';
import { decodeLegacySegment, type LegacyPoint, type LegacySegment } from '../segments';
import { object } from './envelope';
import type { LegacyShape } from './common';

function number(value: unknown, name: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid ${name}`);
    return value;
}
/** A field the older formats did not have yet (scale before tldraw's AddScale, scaleX/scaleY before 4.3). */
function numberOr(value: unknown, fallback: number, name: string): number {
    return value === undefined ? fallback : number(value, name);
}
function choice<T extends string>(value: unknown, choices: readonly T[], name: string): T {
    if (typeof value !== 'string' || !choices.includes(value as T)) throw new Error(`Unknown ${name}`);
    return value as T;
}
function bool(value: unknown, name: string): boolean {
    if (typeof value !== 'boolean') throw new Error(`Invalid ${name}`);
    return value;
}
function boolOr(value: unknown, fallback: boolean, name: string): boolean {
    return value === undefined ? fallback : bool(value, name);
}
function segmentOf(value: unknown): LegacySegment {
    const part = object(value);
    if (!part || (part.type !== 'free' && part.type !== 'straight')) throw new Error('Invalid stroke segment');
    if (typeof part.path === 'string') {
        if (part.dim !== undefined && part.dim !== 2 && part.dim !== 3) throw new Error('Invalid stroke segment');
        return { type: part.type, path: part.path, ...(part.dim === undefined ? {} : { dim: part.dim }) };
    }
    if (typeof part.points === 'string') return { type: part.type, points: part.points };
    if (Array.isArray(part.points)) return { type: part.type, points: part.points as readonly unknown[] };
    throw new Error('Invalid stroke segment');
}

// The former writer stored pen z as pressure × 1.25 rounded to 0.01, as a float32 first point plus float16 deltas from
// the TRUE previous value. The decoder's running sum drifts by up to ~1e-4 (min −1.8e-4 over 5,000 simulated strokes),
// so a pen lift at z = 0 decodes slightly negative in ~43 % of such strokes: that drift is the encoding, not damage, and
// is set to 0 silently. Refusing it was the user's "Invalid stroke coordinate or pressure" ×45 on one board.
const DRIFT = 2 ** -9;

export interface ReadStroke { readonly node: StrokeNode; readonly lease: SampleLease; readonly dropped: number }

// The returned lease belongs to the importer until the host accepts or discards the draft. Null is a stroke with no
// point at all (tldraw writes `path: ''` for one), which the caller drops as a counted repair.
export function readStroke(shape: LegacyShape, base: NodeBase, samples: SampleStore, report: ReportBuilder): ReadStroke | null {
    const p = shape.props, highlight = shape.type === 'highlight';
    if (shape.type !== 'draw' && !highlight) throw new Error('Not a stroke');
    const size = choice(p.size, SIZES, 'size'), color: Swatch = choice(p.color, SWATCHES, 'colour');
    const scale = numberOr(p.scale, 1, 'scale');
    const sx = numberOr(p.scaleX, 1, 'scaleX'), sy = numberOr(p.scaleY, 1, 'scaleY');
    const dash: Dash = highlight ? 'solid' : choice(p.dash, DASHES.filter(d => d !== 'none'), 'dash');
    const fill: Fill = highlight ? 'none' : choice(p.fill, FILLS, 'fill');
    const closed = highlight ? false : boolOr(p.isClosed, false, 'closed flag');
    const complete = boolOr(p.isComplete, true, 'completion flag');
    if (scale <= 0 || !Array.isArray(p.segments)) throw new Error('Invalid stroke segments or scale');
    let dropped = 0, count = 0;
    // `encoded`: the segment stores a pressure channel for every point, so a point without one lost it. A 2-D segment
    // (tldraw writes a pen's straight runs that way) or an object point with no z never had any: not a loss.
    const decoded: { readonly kind: 'free' | 'straight'; readonly points: readonly LegacyPoint[]; readonly encoded: boolean }[] = [];
    for (const value of p.segments) {
        const segment = segmentOf(value);
        const result = decodeLegacySegment(segment);
        dropped += result.dropped; count += result.points.length;
        if (count > 1_000_000) throw new Error('Stroke exceeds the point limit');
        const encoded = 'path' in segment ? segment.dim !== 2 : typeof segment.points === 'string';
        if (result.points.length) decoded.push({ kind: segment.type, points: result.points, encoded });
    }
    if (!count) return null;
    // Before tldraw's AddInPen there was no flag: a mouse wrote z 0 or 0.5 at its first points, a pen anything else.
    const first = decoded[0].points;
    const mouseZ = (point: LegacyPoint | undefined) => point === undefined || point.pressure === 0 || point.pressure === 0.5;
    const pen = p.isPen === undefined ? !mouseZ(first[0]) && (first.length < 2 || !mouseZ(first[1])) : bool(p.isPen, 'pen flag');
    // A pen stroke whose source never had pressure (object points without z, 2-D segments only) is drawn as what it is,
    // a stroke without pressure. One that had a channel and lost it all (first z NaN) keeps pressure, carried at 0.5.
    const pressured = pen && decoded.some(segment => segment.encoded || segment.points.some(point => point.pressure !== null));
    const builder = new SampleBuilder({ pressure: pressured, declaredMaxScale: 8, precision: 'float64' });
    // A point without pressure carries the last valid value (0.5 before any), so the stroke keeps its shape and width.
    let carried = 0.5, missing = 0, clamped = 0;
    for (const segment of decoded) for (const point of segment.points) {
        let pressure: number | undefined;
        if (pressured) {
            const z = point.pressure;
            if (z === null) { pressure = carried; if (segment.encoded) missing++; }
            else {
                pressure = Math.min(MAX_PRESSURE, Math.max(0, z));
                if (z < -DRIFT || z > MAX_PRESSURE) clamped++;
                carried = pressure;
            }
        }
        builder.append(point.x, point.y, pressure, segment.kind === 'straight' ? 'straight' : 'freehand');
    }
    if (missing) report.repair(shape.id, `Missing pressure on ${missing} point${missing === 1 ? '' : 's'} carried from the last valid value`, 'pressure lost', 'stroke');
    if (clamped) report.repair(shape.id, `Pressure outside 0…${MAX_PRESSURE} clamped on ${clamped} point${clamped === 1 ? '' : 's'}`);
    const width = styleGeometryMetrics.actualWidth(highlight ? 'stroke:highlighter' : 'stroke:pen', size, scale);
    const lease = samples.commit(builder);
    return { lease, dropped, node: { ...base, kind: 'stroke', tool: highlight ? 'highlighter' : 'pen', samples: lease.ref,
        pressure: pressured ? 'real' : 'none', widthModel: dash === 'solid' || !pressured
            ? { id: 'uniform' } : { id: 'pressure-linear-v1', rMin: 0, rMax: width / 2 },
        geomVersion: 1, fairTol: 0, closed, width, sx, sy, color, fill, dash, complete } };
}
