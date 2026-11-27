import type { InkCoverage } from './outline';

const HEADER = 24;
const HEADER_BYTES = HEADER * 8;

type Box = Readonly<{ x: number; y: number; w: number; h: number }>;
export interface InkCoverageParts extends Omit<InkCoverage, 'segmentRunStarts'> {
    readonly segmentRunStarts: ArrayLike<number>;
}

export function packedInkCoverageBytes(coverage: Pick<InkCoverageParts, 'segments' | 'discs' | 'centreline' | 'segmentRunStarts'>): number {
    const doubles = coverage.segments.length + coverage.discs.length + coverage.centreline.length;
    return HEADER_BYTES + doubles * 8 + Math.ceil(coverage.segmentRunStarts.length / 2) * 8;
}

export function writePackedInkCoverage(coverage: InkCoverageParts, buffer: ArrayBuffer, offset: number): number {
    const bytes = packedInkCoverageBytes(coverage);
    if (offset % 8 || offset < 0 || offset + bytes > buffer.byteLength) throw new RangeError('Packed ink coverage does not fit its buffer');
    const { segments, discs, centreline, segmentRunStarts: runs } = coverage;
    if (segments.length % 6 || discs.length % 3 || centreline.length % 4) throw new RangeError('Invalid ink coverage rows');
    const header = new Float64Array(buffer, offset, HEADER);
    const boxAt = (at: number, box: Box) => { header[at] = box.x; header[at + 1] = box.y; header[at + 2] = box.w; header[at + 3] = box.h; };
    header[0] = segments.length / 6; header[1] = discs.length / 3; header[2] = centreline.length / 4; header[3] = runs.length;
    boxAt(4, coverage.boundsLocal); boxAt(8, coverage.centrelineBoundsLocal); boxAt(12, coverage.curveBoundsLocal);
    header[16] = coverage.centreErrorWorld; header[17] = coverage.radiusErrorWorld; header[18] = coverage.dashPhaseErrorWorld;
    header[19] = coverage.lengthWorld; header[20] = coverage.lengthLowerWorld; header[21] = coverage.lengthUpperWorld;
    header[22] = coverage.closed ? 1 : 0; header[23] = bytes;
    let at = offset + HEADER_BYTES;
    for (const rows of [segments, discs, centreline]) {
        new Float64Array(buffer, at, rows.length).set(rows); at += rows.byteLength;
    }
    const starts = new Uint32Array(buffer, at, runs.length);
    for (let i = 0; i < runs.length; i++) starts[i] = runs[i];
    return bytes;
}

export function readPackedInkCoverage(buffer: ArrayBuffer, offset: number): { readonly coverage: InkCoverage; readonly bytes: number } {
    if (offset % 8 || offset < 0 || offset + HEADER_BYTES > buffer.byteLength) throw new RangeError('Packed ink coverage is out of bounds');
    const header = new Float64Array(buffer, offset, HEADER);
    const [segmentRows, discRows, centreRows, runs] = [header[0], header[1], header[2], header[3]], bytes = header[23];
    if (![segmentRows, discRows, centreRows, runs].every(Number.isSafeInteger) || !Number.isSafeInteger(bytes) || offset + bytes > buffer.byteLength
        || bytes !== HEADER_BYTES + (6 * segmentRows + 3 * discRows + 4 * centreRows) * 8 + Math.ceil(runs / 2) * 8) {
        throw new RangeError('Invalid packed ink coverage header');
    }
    const box = (at: number): Box => Object.freeze({ x: header[at], y: header[at + 1], w: header[at + 2], h: header[at + 3] });
    let at = offset + HEADER_BYTES;
    const rows = (count: number) => { const view = new Float64Array(buffer, at, count); at += count * 8; return view; };
    const segments = rows(6 * segmentRows), discs = rows(3 * discRows), centreline = rows(4 * centreRows);
    const coverage: InkCoverage = Object.freeze({
        segments, discs, centreline, segmentRunStarts: new Uint32Array(buffer, at, runs),
        boundsLocal: box(4), centrelineBoundsLocal: box(8), curveBoundsLocal: box(12),
        centreErrorWorld: header[16], radiusErrorWorld: header[17], dashPhaseErrorWorld: header[18],
        lengthWorld: header[19], lengthLowerWorld: header[20], lengthUpperWorld: header[21], closed: header[22] === 1,
    });
    return { coverage, bytes };
}

export function packInkCoverage(coverage: InkCoverageParts): InkCoverage {
    const buffer = new ArrayBuffer(packedInkCoverageBytes(coverage));
    writePackedInkCoverage(coverage, buffer, 0);
    return readPackedInkCoverage(buffer, 0).coverage;
}

export function inkCoverageBytes(coverage: Pick<InkCoverage, 'segments' | 'discs' | 'centreline' | 'segmentRunStarts'>): number {
    return HEADER_BYTES + coverage.segments.byteLength + coverage.discs.byteLength + coverage.centreline.byteLength + coverage.segmentRunStarts.byteLength;
}
