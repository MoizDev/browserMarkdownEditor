import { isLocked } from '../change/commands';
import { worldPose, worldToLocal } from '../change/coordinates';
import { notebookGrowthOp } from '../commands/pagesAndSheets';
import { transformBox } from '../geom/bounds';
import { SampleBuilder, SampleStore } from '../ink/samples';
import type { NodeId, SheetId } from '../model/ids';
import type { BoardSession } from '../session/BoardSession';
import type { ToolState } from './gesture';
import type { RealSample } from './tool';
import { snapStraightEnd } from './straightInk';
import type { DryInkIdentity, InkIdentity, InkPresentation } from './liveInk';
import type { PaintClip } from '../render/paintStream';

export interface InkContinuationOptions {
    readonly session: BoardSession;
    readonly samples: SampleStore;
    readonly tools: ToolState;
    readonly current: () => boolean;
    readonly sheet: () => string;
    readonly selection: () => unknown;
    readonly declaredMaxScale: () => number;
    readonly captureDeviceScale: () => number;
}

export interface InkContinuation {
    readonly identity: InkIdentity;
    readonly presentation: InkPresentation;
    readonly first: Readonly<{ x: number; y: number }>;
    readonly declaredMaxScale: number;
    readonly captureDeviceScale: number;
    current(): boolean;
    toLocal(sample: RealSample): Readonly<{ x: number; y: number }>;
    commit(endpoint: RealSample, signal: AbortSignal, snapAngle: boolean): Promise<DryInkIdentity | null>;
}

/** The last real pen stroke is session-owned. Its original samples stay leased until
 * the complete continuation has been admitted or cancelled; no partial run is saved. */
export function createInkContinuation(options: InkContinuationOptions): (sample: RealSample) => InkContinuation | null {
    return () => {
        const { session, samples } = options, doc = session.doc, owner = session.owner, revision = doc.rev;
        const id = options.tools.getLastStroke(), node = id ? doc.nodes.get(id) : undefined;
        if (!options.current() || session.isReadOnly || !node || node.kind !== 'stroke' || node.tool !== 'pen'
            || node.closed || isLocked(doc, node) || !samples.has(node.samples)) return null;
        let parent = node.parent;
        for (let depth = 0; !doc.sheets.has(parent as SheetId) && depth < 64; depth++) {
            const ancestor = doc.nodes.get(parent as NodeId);
            if (!ancestor) return null;
            parent = ancestor.parent;
        }
        const sheet = options.sheet(), selection = options.selection(), original = node.samples;
        if (parent !== sheet) return null;
        const source = samples.sequence(original);
        if (!source.count) return null;
        const first = { x: source.x(source.count - 1), y: source.y(source.count - 1) };
        const pose = worldPose(doc, node.id), c = Math.cos(pose.rotation), s = Math.sin(pose.rotation);
        const clips: PaintClip[] = []; let opacity = node.opacity, ancestor = doc.nodes.get(node.parent as NodeId);
        for (let depth = 0; ancestor && depth < 64; depth++) {
            opacity *= ancestor.opacity;
            if (ancestor.kind === 'frame') {
                const frame = worldPose(doc, ancestor.id), fc = Math.cos(frame.rotation), fs = Math.sin(frame.rotation);
                clips.unshift({ key: `frame:${ancestor.id}`, fillRule: 'nonzero',
                    d: [['M', 0, 0], ['L', ancestor.w, 0], ['L', ancestor.w, ancestor.h], ['L', 0, ancestor.h], ['Z']],
                    localToWorld: [fc, fs, -fs, fc, frame.x, frame.y] });
            }
            ancestor = doc.nodes.get(ancestor.parent as NodeId);
        }
        const identity = { nodeId: node.id, gestureSequence: options.tools.nextInkSequence() };
        const presentation: InkPresentation = { tool: 'pen', color: node.color, width: node.width, fairTol: node.fairTol,
            localToWorld: [c * node.sx, s * node.sx, -s * node.sy, c * node.sy, pose.x, pose.y], opacity, clips };
        const toLocal = (sample: RealSample) => {
            const point = worldToLocal(doc, node, sample);
            return { x: point.x / node.sx, y: point.y / node.sy };
        };
        const current = () => options.current() && !session.isReadOnly && session.owner === owner
            && session.doc === doc && doc.rev === revision && options.sheet() === sheet && options.selection() === selection
            && options.tools.getLastStroke() === node.id && doc.nodes.get(node.id) === node && node.samples === original;
        return { identity, presentation, first, declaredMaxScale: options.declaredMaxScale(),
            captureDeviceScale: options.captureDeviceScale(), current, toLocal,
            async commit(endpoint, signal, snapAngle) {
            const check = () => {
                signal.throwIfAborted();
                if (!current()) throw new DOMException('Ink continuation became stale', 'AbortError');
            };
            check();
            const { x, y } = snapStraightEnd(first, toLocal(endpoint), snapAngle);
            if (!Number.isFinite(x) || !Number.isFinite(y)) throw new RangeError('Ink continuation coordinate is invalid');
            const previous = samples.retain(original);
            try {
                const source = samples.sequence(original), pressure = samples.pressureMode(original) === 'real';
                const builder = new SampleBuilder({ pressure, declaredMaxScale: options.declaredMaxScale(), precision: 'float64' });
                for (let i = 0; i < source.count; i++) {
                    check();
                    builder.append(source.x(i), source.y(i), source.pressure(i),
                        source.count > 1 ? source.segmentKind(Math.max(0, i - 1)) : 'freehand');
                    if ((i & 1023) === 1023) { await new Promise<void>(resolve => setTimeout(resolve, 0)); check(); }
                }
                check();
                const finalPressure = pressure ? source.pressure(source.count - 1) : undefined;
                builder.append(x, y, finalPressure, 'straight');
                const summary = builder.summary(), lease = samples.commit(builder);
                let wet: ReturnType<SampleStore['retain']> | undefined;
                try {
                    check(); wet = samples.retain(lease.ref);
                    const growth = (() => {
                        if (doc.host.kind !== 'notebook' || !summary) return null;
                        const [sx, sy, w, h] = summary.localBounds, pose = worldPose(doc, node.id);
                        const c = Math.cos(pose.rotation), s = Math.sin(pose.rotation), box = new Float64Array(4);
                        const x0 = sx * node.sx, y0 = sy * node.sy, x1 = (sx + w) * node.sx, y1 = (sy + h) * node.sy;
                        transformBox(box, 0, [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)],
                            0, [c, s, -s, c, pose.x, pose.y]);
                        return notebookGrowthOp(doc, box[3] + node.width + node.fairTol);
                    })();
                    check();
                    const applied = session.apply({ origin: 'tool', label: 'Continue stroke', ops: [
                        ...(growth ? [growth] : []), { t: 'set', id: node.id, key: 'samples', value: lease.ref },
                    ] });
                    let recorded: boolean;
                    try { recorded = applied.recorded; } finally { applied.release(); }
                    if (!recorded) return null;
                    const held = wet; wet = undefined;
                    return { ...identity, nodeRevision: doc.rev, release: () => held?.release() };
                } finally { wet?.release(); lease.release(); }
            } finally { previous.release(); }
        } };
    };
}
