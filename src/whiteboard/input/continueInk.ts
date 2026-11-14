import { isLocked } from '../change/commands';
import { worldPose, worldToLocal } from '../change/coordinates';
import { notebookGrowthOp } from '../commands/pagesAndSheets';
import { transformBox } from '../geom/bounds';
import { SampleBuilder, SampleStore } from '../ink/samples';
import type { NodeId, SheetId } from '../model/ids';
import type { BoardSession } from '../session/BoardSession';
import type { RealSample } from './tool';

const lastStroke = new WeakMap<BoardSession, NodeId>();

/** The session, not a pane, remembers the last authored stroke across view changes. */
export function rememberAuthoredStroke(session: BoardSession, id: NodeId): void { lastStroke.set(session, id); }

export interface InkContinuationOptions {
    readonly session: BoardSession;
    readonly samples: SampleStore;
    readonly current: () => boolean;
    readonly sheet: () => string;
    readonly declaredMaxScale: () => number;
}

/** A Shift continuation appends a straight run to the actual previous stroke. */
export function createInkContinuation(options: InkContinuationOptions): (sample: RealSample) => ((endpoint: RealSample) => boolean) | null {
    return () => {
        const { session, samples } = options, doc = session.doc, owner = session.owner, revision = doc.rev;
        const id = lastStroke.get(session), node = id ? doc.nodes.get(id) : undefined;
        if (!options.current() || session.isReadOnly || !node || node.kind !== 'stroke' || node.tool !== 'pen'
            || node.closed || isLocked(doc, node) || !samples.has(node.samples)) return null;
        let parent = node.parent;
        for (let depth = 0; !doc.sheets.has(parent as SheetId) && depth < 64; depth++) {
            const ancestor = doc.nodes.get(parent as NodeId); if (!ancestor) return null; parent = ancestor.parent;
        }
        if (parent !== options.sheet()) return null;
        const initialSheet = options.sheet(), original = node.samples;
        return endpoint => {
            if (!options.current() || session.isReadOnly || session.owner !== owner || session.doc !== doc || doc.rev !== revision
                || options.sheet() !== initialSheet || doc.nodes.get(node.id) !== node || node.samples !== original) return false;
            const local = worldToLocal(doc, node, endpoint), x = local.x / node.sx, y = local.y / node.sy;
            if (!Number.isFinite(x) || !Number.isFinite(y)) throw new RangeError('Ink continuation coordinate is invalid');
            const previous = samples.retain(original);
            try {
                const source = samples.sequence(original), pressure = samples.pressureMode(original) === 'real';
                const builder = new SampleBuilder({ pressure, declaredMaxScale: options.declaredMaxScale(), precision: 'float64' });
                for (let i = 0; i < source.count; i++) builder.append(source.x(i), source.y(i), source.pressure(i),
                    source.count > 1 ? source.segmentKind(Math.max(0, i - 1)) : 'freehand');
                const finalPressure = pressure ? source.pressure(source.count - 1) : undefined;
                builder.append(x, y, finalPressure, 'straight');
                const summary = builder.summary(), lease = samples.commit(builder);
                try {
                    const growth = (() => {
                        if (doc.host.kind !== 'notebook' || !summary) return null;
                        const [sx, sy, w, h] = summary.localBounds, pose = worldPose(doc, node.id);
                        const c = Math.cos(pose.rotation), s = Math.sin(pose.rotation), box = new Float64Array(4);
                        const x0 = sx * node.sx, y0 = sy * node.sy, x1 = (sx + w) * node.sx, y1 = (sy + h) * node.sy;
                        transformBox(box, 0, [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)],
                            0, [c, s, -s, c, pose.x, pose.y]);
                        return notebookGrowthOp(doc, box[3] + node.width + node.fairTol);
                    })();
                    const applied = session.apply({ origin: 'tool', label: 'Continue stroke', ops: [
                        ...(growth ? [growth] : []), { t: 'set', id: node.id, key: 'samples', value: lease.ref },
                    ] });
                    applied.release(); return true;
                } finally { lease.release(); }
            } finally { previous.release(); }
        };
    };
}
