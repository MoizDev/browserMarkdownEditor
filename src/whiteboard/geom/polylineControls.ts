import { isLocked } from '../change/commands';
import { poseInParent, worldPose, worldToLocal, type ChangeGeometry } from '../change/coordinates';
import type { NodeSetOp } from '../change/ops';
import { acquireBoardGeometryScope, type BoardGeometryScope } from '../commands/geometryScope';
import type { BoardRuntime } from '../host/runtime';
import type { NodeId } from '../model/ids';
import type { Attachment, PolylineNode } from '../model/nodes';
import { projectBoardGeometrySets } from '../model/overlayDoc';
import type { Vec2 } from './path';
import { resolvePolylineAttachments } from './polylineAttachments';

type AttachedPolyline = Readonly<PolylineNode> & { readonly startAttach?: Attachment | null; readonly endAttach?: Attachment | null };
export type PolylineControlAction =
    | Readonly<{ kind: 'move'; index: number; point: Vec2; detach?: boolean }>
    | Readonly<{ kind: 'insert'; index: number; point: Vec2 }>
    | Readonly<{ kind: 'delete'; index: number }>;
export interface PolylineControlOptions {
    readonly runtime: BoardRuntime;
    readonly id: NodeId;
    readonly action: PolylineControlAction;
    readonly current: () => boolean;
    readonly signal?: AbortSignal;
    readonly cooperate?: () => Promise<void>;
}
export interface PolylineControlPreview {
    readonly ops: readonly NodeSetOp[];
    readonly doc: BoardRuntime['session']['doc'];
    commit(): void;
    release(): void;
}
function samePoints(a: readonly Vec2[], b: readonly Vec2[]): boolean {
    return a.length === b.length && a.every((point, index) => point.x === b[index].x && point.y === b[index].y);
}

/** Edit real polyline handles while retaining or explicitly detaching endpoint bindings. */
export async function preparePolylineControl(options: PolylineControlOptions): Promise<PolylineControlPreview> {
    const { runtime, action } = options, session = runtime.session, doc = session.doc, owner = session.owner, revision = doc.rev;
    const selection = runtime.selection.getSnapshot(), signal = options.signal ?? new AbortController().signal;
    let font: number | undefined, released = false;
    const current = () => !released && !signal.aborted && options.current() && session.owner === owner && session.doc === doc
        && doc.rev === revision && !session.isReadOnly && runtime.selection.getSnapshot() === selection
        && (font === undefined || runtime.render.text.fonts.epoch === font);
    const check = () => { signal.throwIfAborted(); if (!current()) throw new DOMException('Polyline control became stale', 'AbortError'); };
    check(); const node = doc.nodes.get(options.id) as AttachedPolyline | undefined;
    if (!node || node.kind !== 'polyline' || isLocked(doc, node)) throw new Error('Polyline control is not editable');
    const count = node.points.length, max = action.kind === 'insert' ? count : count - 1;
    if (!Number.isSafeInteger(action.index) || action.index < (action.kind === 'insert' ? 1 : 0) || action.index > max
        || (action.kind === 'delete' && count <= 2) || (action.kind === 'insert' && count >= 5000)) throw new RangeError('Invalid polyline vertex index');
    if (action.kind !== 'delete' && ![action.point.x, action.point.y].every(Number.isFinite)) throw new RangeError('Invalid polyline point');
    if (action.kind === 'delete' && ((action.index === 0 && node.startAttach) || (action.index === count - 1 && node.endAttach)))
        throw new Error('Detach the bound endpoint before deleting it');
    if (action.kind === 'insert' && action.index === count && node.endAttach)
        throw new Error('Insert before the bound endpoint or detach it first');
    const targets = [node.startAttach?.target, node.endAttach?.target].filter((id): id is NodeId => !!id);
    const source = await acquireBoardGeometryScope(runtime, [node.id, ...targets], { signal, current, cooperate: options.cooperate });
    let final: BoardGeometryScope | undefined;
    try {
        check(); font = runtime.render.text.fonts.epoch;
        const points = node.points.map(point => ({ ...point })), ops: NodeSetOp[] = [];
        if (action.kind === 'delete') points.splice(action.index, 1);
        else {
            const local = worldToLocal(doc, node, action.point);
            if (action.kind === 'insert') points.splice(action.index, 0, local); else points[action.index] = local;
            if (action.kind === 'move') {
                const field = action.index === 0 ? 'startAttach' : action.index === count - 1 ? 'endAttach' : null;
                const prior = field ? node[field] : null;
                if (field && prior) {
                    let attachment: Attachment | null = null;
                    if (!action.detach) {
                        const target = doc.nodes.get(prior.target); if (!target) throw new Error('Polyline attachment target disappeared');
                        const geometry = await runtime.render.prepareForPick(target, signal, doc); check();
                        const box = geometry.vector?.attachments?.logicalBox; if (!box) throw new Error('Polyline target has no attachment surface');
                        const p = worldToLocal(doc, target, action.point);
                        if (![p.x, p.y, box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width < 0 || box.height < 0)
                            throw new RangeError('Polyline target anchor geometry is invalid');
                        const coordinate = (value: number, origin: number, size: number) => {
                            if (!size) return 0.5; // default, calibration cut by owner
                            const raw = (value - origin) / size;
                            if (!Number.isFinite(raw)) throw new RangeError('Polyline attachment anchor overflows');
                            return Math.max(0, Math.min(1, raw));
                        };
                        attachment = { ...prior, precise: true, anchor: { x: coordinate(p.x, box.x, box.width), y: coordinate(p.y, box.y, box.height) } };
                    }
                    if (!attachment || !prior.precise || attachment.anchor.x !== prior.anchor.x || attachment.anchor.y !== prior.anchor.y)
                        ops.push({ t: 'set', id: node.id, key: field, value: attachment } as unknown as NodeSetOp);
                }
            }
        }
        const noChange = () => {
            const release = () => { if (!released) { released = true; source.release(); } };
            return Object.freeze({ ops: Object.freeze([]) as readonly NodeSetOp[], doc, commit() { try { check(); } finally { release(); } }, release });
        };
        if (!ops.length && samePoints(points, node.points)) return noChange();
        const pointsIndex = ops.length;
        ops.push({ t: 'set', id: node.id, key: 'points', value: points });
        const project = (changes: readonly NodeSetOp[]) => projectBoardGeometrySets(doc, changes, { signal, current, cooperate: options.cooperate });
        let candidate = await project(ops); check();
        const projected = candidate.nodes.get(node.id) as AttachedPolyline | undefined;
        if (!projected || projected.kind !== 'polyline') throw new Error('Polyline projection is unavailable');
        if (projected.startAttach || projected.endAttach) {
            const resolved = await resolvePolylineAttachments(projected, { runtime, doc: candidate, signal, current, cooperate: options.cooperate });
            try {
                check();
                if (ops.length === 1 && samePoints(resolved.points, node.points)) return noChange();
                ops[pointsIndex] = { t: 'set', id: node.id, key: 'points', value: resolved.points };
            }
            finally { resolved.release(); }
            candidate = await project(ops); check();
        }
        const staged = await acquireBoardGeometryScope(runtime, [node.id, ...targets], { doc: candidate, signal, current, cooperate: options.cooperate });
        try {
            check(); const b = staged.logicalBounds(node.id), pose = worldPose(candidate, node.id);
            const geometry: ChangeGeometry = { resolvedTip: (d, connector, terminal) => runtime.render.changeGeometry.resolvedTip(d, connector, terminal),
                worldBoundsCenter: () => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 }) };
            const placement = poseInParent(doc, node, node.parent, pose, geometry);
            if (placement.page !== node.page) ops.push({ t: 'set', id: node.id, key: 'page', value: placement.page });
            if (placement.x !== node.x) ops.push({ t: 'set', id: node.id, key: 'x', value: placement.x });
            if (placement.y !== node.y) ops.push({ t: 'set', id: node.id, key: 'y', value: placement.y });
            const resultDoc = await project(ops); check();
            final = await acquireBoardGeometryScope(runtime, [node.id, ...targets], { doc: resultDoc, signal, current, cooperate: options.cooperate }); check();
            const held = final, frozen = Object.freeze(ops.map(op => Object.freeze(op)));
            const release = () => { if (!released) { released = true; try { held.release(); } finally { source.release(); } } };
            return Object.freeze({ ops: frozen, doc: resultDoc,
                commit() { try { check(); const applied = session.apply({ origin: 'tool', label: 'Edit polyline', ops: frozen }); applied.release(); } finally { release(); } }, release });
        } finally { staged.release(); }
    } catch (error) { try { final?.release(); } finally { source.release(); } throw error; }
}
