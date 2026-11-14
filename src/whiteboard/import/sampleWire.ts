import { encodePoints, inspectPoints, pointExponent, type PointInspectionHeader, type SegmentRuns } from '../format/points';
import type { SampleStore } from '../ink/samples';
import type { StrokeNode } from '../model/nodes';
import type { SampleRef } from '../model/samples';

export interface LegacySampleWire {
    readonly workerRef: SampleRef;
    readonly pts: string;
    readonly header: PointInspectionHeader;
}

// R-W29/31: worker-local handles never cross realms; the host admits this native payload anew.
export function encodeLegacySample(node: StrokeNode, samples: SampleStore, declaredMaxScale: number): LegacySampleWire {
    const seq = samples.sequence(node.samples), count = seq.count;
    const exponent = pointExponent(declaredMaxScale, node.sx, node.sy);
    if (!exponent.ok) throw new Error(exponent.error.reason);
    const xy = new Float64Array(count * 2), pressure = node.pressure === 'real' ? new Float64Array(count) : null;
    const starts: number[] = [], kinds: number[] = [];
    for (let i = 0; i < count; i++) {
        xy[2 * i] = seq.x(i); xy[2 * i + 1] = seq.y(i);
        if (pressure) {
            const value = seq.pressure(i);
            if (value === undefined) throw new Error('Imported pen sample lost its pressure');
            pressure[i] = value;
        }
        if (i + 1 < count) {
            const kind = seq.segmentKind(i) === 'straight' ? 1 : 0;
            if (!kinds.length || kinds[kinds.length - 1] !== kind) { starts.push(i); kinds.push(kind); }
        }
    }
    const runs: SegmentRuns | null = kinds.some(kind => kind !== 0)
        ? { starts: Uint32Array.from(starts), kinds: Uint8Array.from(kinds) } : null;
    const encoded = encodePoints({ xy, pressure, runs }, exponent.value);
    if (!encoded.ok) throw new Error(encoded.error.reason);
    const inspected = inspectPoints(encoded.value.pts);
    if (!inspected.ok) throw new Error(inspected.error.reason);
    return { workerRef: node.samples, pts: encoded.value.pts, header: inspected.value.header };
}
