import type { PathCommand, Rect } from '../../platform/types';
import type { FigureAttachmentSurface, PolylineGeometry } from '../geom/providers';
import type { PathOp, Vec2 } from '../geom/path';
import { CurveFlag, type CurveGeometry } from '../ink/curve';
import { INK_CAP_ERROR_DEVICE_PX } from '../ink/flatten';
import { InkCoverageJob, InkOutlineJob, type InkCoverage } from '../ink/outline';
import type { SampleSequence } from '../ink/samples';
import type { Node } from '../model/nodes';
import type { BoardVectorGeometry } from './vectorGeometry';
import { yieldToHost } from '../../platform/yieldToHost';

/** The contour approximates the actual filled coverage, not its AABB. The
 * bound is in node-local units and must travel with any boundary-certification
 * decision; existing vector providers own their own contour precision. */
export type BoardAttachmentSurface = FigureAttachmentSurface & { readonly boundaryErrorWorld: number };
export class AttachmentBoundaryUncertified extends Error {
    constructor(readonly boundaryErrorWorld: number, readonly toleranceWorld: number) {
        super(`Attachment boundary error ${boundaryErrorWorld} exceeds tolerance ${toleranceWorld}`);
        this.name = 'AttachmentBoundaryUncertified';
    }
}
export interface BoardAttachmentSurfaceOptions {
    readonly vector?: BoardVectorGeometry;
    readonly ink?: readonly InkCoverage[];
    readonly signal: AbortSignal;
    readonly cooperate?: () => Promise<void>;
    readonly deviceScale?: number;
    /** Maximum admitted contour error, in node-local units; default is the canonical 0.01. */
    readonly toleranceWorld?: number;
}
const MAX_COMMANDS = 65_536;
function pathOp(command: PathCommand): PathOp {
    switch (command[0]) {
        case 'M': case 'L': return { op: command[0], p: { x: command[1], y: command[2] } };
        case 'C': return { op: 'C', c1: { x: command[1], y: command[2] }, c2: { x: command[3], y: command[4] },
            p: { x: command[5], y: command[6] } };
        case 'Z': return { op: 'Z' };
    }
}
function union(a: Rect | null, b: Readonly<{ x: number; y: number; w: number; h: number }>): Rect {
    const right = b.x + b.w, bottom = b.y + b.h;
    if (![b.x, b.y, b.w, b.h, right, bottom].every(Number.isFinite) || b.w < 0 || b.h < 0) throw new RangeError('Invalid ink attachment bounds');
    if (!a) return { x: b.x, y: b.y, width: b.w, height: b.h };
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return { x, y, width: Math.max(a.x + a.width, right) - x, height: Math.max(a.y + a.height, bottom) - y };
}

/** One actual provider path segment becomes the same round-cap/round-join
 * coverage used by ink. Unioning those capsules is precisely the Canvas stroke
 * of the flattened centreline, including disconnected dash and dot subpaths. */
function segment(a: Vec2, b: Vec2, c1: Vec2, c2: Vec2, straight: boolean): { samples: SampleSequence; geometry: CurveGeometry; dot: boolean } {
    const values = [a.x, a.y, b.x, b.y, c1.x, c1.y, c2.x, c2.y];
    if (!values.every(Number.isFinite)) throw new RangeError('Invalid polyline attachment path');
    const x = Math.min(a.x, b.x, c1.x, c2.x), y = Math.min(a.y, b.y, c1.y, c2.y);
    const maxX = Math.max(a.x, b.x, c1.x, c2.x), maxY = Math.max(a.y, b.y, c1.y, c2.y);
    const geometry: CurveGeometry = { firstSpan: 0, spanCount: 1, originX: a.x, originY: a.y,
        cubics: new Float64Array([0, 0, c1.x - a.x, c1.y - a.y, c2.x - a.x, c2.y - a.y, b.x - a.x, b.y - a.y]),
        flags: new Uint8Array([CurveFlag.First | CurveFlag.Last | (straight ? CurveFlag.Straight : 0)]),
        boundsLocal: { x, y, w: maxX - x, h: maxY - y } };
    const samples: SampleSequence = { count: 2, x: i => i === 0 ? a.x : b.x, y: i => i === 0 ? a.y : b.y,
        pressure: () => undefined, segmentKind: () => straight ? 'straight' : 'freehand' };
    return { samples, geometry, dot: values[0] === values[2] && values[1] === values[3]
        && values[0] === values[4] && values[1] === values[5] && values[0] === values[6] && values[1] === values[7] };
}

function* attachmentSurface(node: Readonly<Node>, options: BoardAttachmentSurfaceOptions): Generator<void, BoardAttachmentSurface | null> {
    const { signal } = options;
    signal.throwIfAborted();
    const tolerance = options.toleranceWorld ?? 0.01;
    if (!Number.isFinite(tolerance) || tolerance <= 0) throw new RangeError('Invalid attachment contour tolerance');
    if (options.vector?.attachments) return { ...options.vector.attachments, boundaryErrorWorld: 0 };
    if (node.kind !== 'stroke' && node.kind !== 'polyline') return null;
    const scale = options.deviceScale ?? 64;
    if (!Number.isFinite(scale) || scale <= 0) throw new RangeError('Invalid attachment geometry scale');
    const outline: PathOp[] = [];
    let bounds: Rect | null = null, error = 0, work = 0, started = performance.now();
    const reset = () => { signal.throwIfAborted(); work = 0; started = performance.now(); };
    const due = () => ++work >= 256 || performance.now() - started >= 3;
    const emit = (command: PathCommand) => {
        if (outline.length >= MAX_COMMANDS) throw new RangeError('Attachment outline exceeds its contour budget');
        outline.push(pathOp(command));
    };
    const addCoverage = function* (coverage: InkCoverage): Generator<void, void> {
        const bound = coverage.centreErrorWorld + coverage.radiusErrorWorld + coverage.dashPhaseErrorWorld + INK_CAP_ERROR_DEVICE_PX / scale;
        if (!Number.isFinite(bound) || bound < 0) throw new RangeError('Attachment boundary error is invalid');
        if (bound > tolerance) throw new AttachmentBoundaryUncertified(bound, tolerance);
        error = Math.max(error, bound); bounds = union(bounds, coverage.boundsLocal);
        const remaining = MAX_COMMANDS - outline.length;
        if (remaining < 1) throw new RangeError('Attachment outline exceeds its contour budget');
        const job = new InkOutlineJob(coverage, scale, emit, remaining);
        try {
            for (;;) {
                signal.throwIfAborted();
                const status = job.step(1);
                if (status === 'complete') break;
                if (status !== 'pending') throw new DOMException('Attachment outline cancelled', 'AbortError');
                if (due()) { yield; reset(); }
            }
        } finally { job.cancel(); }
    };
    if (node.kind === 'stroke') {
        if (!options.ink) throw new Error('Stroke attachment coverage is unavailable');
        for (const coverage of options.ink) { signal.throwIfAborted(); yield* addCoverage(coverage); if (due()) { yield; reset(); } }
    } else {
        if (!options.vector) throw new Error('Polyline attachment geometry is unavailable');
        const vector = options.vector as PolylineGeometry;
        if (node.width <= 0) return null;
        for (const part of vector.paths) {
            if (due()) { yield; reset(); }
            if (part.role !== 'outline' || !Array.isArray(part.ops) || part.width !== node.width) throw new Error('Unexpected polyline stroke geometry');
            let current: Vec2 | null = null, start: Vec2 | null = null;
            for (const op of part.ops) {
                signal.throwIfAborted();
                if (op.op === 'M') { current = start = op.p; if (due()) { yield; reset(); } continue; }
                if (!current || !start) throw new Error('Polyline path does not start with a move');
                const end = op.op === 'Z' ? start : op.p;
                const line = op.op !== 'C';
                const first = op.op === 'C' ? op.c1 : { x: current.x + (end.x - current.x) / 3, y: current.y + (end.y - current.y) / 3 };
                const second = op.op === 'C' ? op.c2 : { x: current.x + 2 * (end.x - current.x) / 3, y: current.y + 2 * (end.y - current.y) / 3 };
                const input = segment(current, end, first, second, line);
                const job = new InkCoverageJob(input.samples, input.geometry, { width: node.width, model: { id: 'uniform' }, pressure: 'none' },
                    { deviceScale: scale, dot: input.dot ? { x: current.x, y: current.y, radius: node.width / 2 } : null });
                try {
                    for (;;) {
                        const status = job.step(1); signal.throwIfAborted();
                        if (status === 'complete') break;
                        if (status !== 'pending') throw new DOMException('Attachment coverage cancelled', 'AbortError');
                        if (due()) { yield; reset(); }
                    }
                    yield* addCoverage(job.result);
                } finally { job.cancel(); }
                current = end;
                if (due()) { yield; reset(); }
            }
        }
        // Anchor semantics are the real provider's un-stroked logical box.
        if (outline.length) bounds = vector.boxLocal;
    }
    signal.throwIfAborted();
    if (!outline.length || !bounds) return null;
    return Object.freeze({ outline: Object.freeze(outline), logicalBox: Object.freeze({ ...bounds }), boundaryErrorWorld: error });
}

export async function prepareBoardAttachmentSurface(node: Readonly<Node>, options: BoardAttachmentSurfaceOptions): Promise<BoardAttachmentSurface | null> {
    const job = attachmentSurface(node, options);
    try {
        for (;;) {
            options.signal.throwIfAborted();
            const next = job.next(); if (next.done) return next.value;
            await (options.cooperate?.() ?? yieldToHost());
            options.signal.throwIfAborted();
        }
    } finally { job.return(undefined as never); }
}

/** The same certified contour path, drained synchronously for capture. */
export function prepareBoardAttachmentSurfaceNow(node: Readonly<Node>, options: Omit<BoardAttachmentSurfaceOptions, 'cooperate'>): BoardAttachmentSurface | null {
    const job = attachmentSurface(node, options);
    try {
        for (;;) {
            options.signal.throwIfAborted();
            const next = job.next(); if (next.done) return next.value;
        }
    } finally { job.return(undefined as never); }
}
