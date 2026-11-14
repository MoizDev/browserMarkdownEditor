import { isLocked } from '../change/commands';
import { worldPose, worldToLocal } from '../change/coordinates';
import { notebookGrowthOp } from '../commands/pagesAndSheets';
import { transformBox } from '../geom/bounds';
import { SampleBuilder, SampleStore } from '../ink/samples';
import type { NodeId, SheetId } from '../model/ids';
import type { BoardSession } from '../session/BoardSession';
import type { ToolState } from './gesture';
import type { RealSample } from './tool';

export interface InkContinuationOptions {
    readonly session: BoardSession;
    readonly samples: SampleStore;
    readonly tools: ToolState;
    readonly current: () => boolean;
    readonly sheet: () => string;
    readonly selection: () => unknown;
    readonly declaredMaxScale: () => number;
}

export type InkContinuation = (endpoint: RealSample, signal: AbortSignal) => Promise<boolean>;

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
        return async (endpoint, signal) => {
            const valid = () => !signal.aborted && options.current() && !session.isReadOnly && session.owner === owner
                && session.doc === doc && doc.rev === revision && options.sheet() === sheet && options.selection() === selection
                && options.tools.getLastStroke() === node.id && doc.nodes.get(node.id) === node && node.samples === original;
            const check = () => {
                signal.throwIfAborted();
                if (!valid()) throw new DOMException('Ink continuation became stale', 'AbortError');
            };
            check();
            const local = worldToLocal(doc, node, endpoint), x = local.x / node.sx, y = local.y / node.sy;
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
                try {
                    check();
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
                    applied.release();
                    return true;
                } finally { lease.release(); }
            } finally { previous.release(); }
        };
    };
}
