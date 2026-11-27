import { isLocked } from '../change/commands';
import { poseInParent, worldPose, worldToLocal } from '../change/coordinates';
import type { ChangeGeometry, WorldPose } from '../change/coordinates';
import type { Op, Transaction } from '../change/ops';
import { childrenOf, isSheetParent } from '../model/doc';
import type { BoardDoc } from '../model/doc';
import type { NodeId, ParentId } from '../model/ids';
import type { ConnectorNode, Node } from '../model/nodes';
import type { Vec2 } from './path';
import { constrainedTranslation } from './transforms';

export class TransformInvalidated extends Error {
    constructor() { super('The selection changed during the transform'); this.name = 'TransformInvalidated'; }
}
interface RootSnapshot { readonly node: Readonly<Node>; readonly pose: WorldPose; readonly centre: Vec2 }
interface Fingerprint { readonly id: NodeId; readonly values: readonly (readonly [string, unknown])[] }
export interface TranslationPreview { readonly ops: readonly Op[]; readonly delta: Vec2 }

export class TranslationPlan {
    private readonly roots: readonly RootSnapshot[];
    private readonly fingerprints: readonly Fingerprint[];
    private readonly host: BoardDoc['host'];
    private cancelled = false;
    private readonly moving: ReadonlySet<NodeId>;
    constructor(private readonly doc: BoardDoc, ids: readonly NodeId[], private readonly geometry: ChangeGeometry) {
        const selected = new Set(ids), fingerprints = new Map<NodeId, Fingerprint>(), roots: RootSnapshot[] = [];
        for (const id of selected) {
            const node = doc.nodes.get(id);
            if (!node || node.kind === 'opaque' || isLocked(doc, node)) throw new RangeError('Selection contains a locked or missing node');
            let parent = node.parent, covered = false;
            for (let depth = 0; !isSheetParent(doc, parent); depth++) {
                if (depth >= 64) throw new RangeError('Parent hierarchy exceeds its depth limit');
                if (selected.has(parent as NodeId)) covered = true;
                const ancestor = doc.nodes.get(parent as NodeId);
                if (!ancestor) throw new RangeError('Selection has a missing ancestor');
                fingerprints.set(ancestor.id, { id: ancestor.id, values: Object.entries(ancestor) });
                parent = ancestor.parent;
            }
            fingerprints.set(id, { id, values: Object.entries(node) });
            if (!covered) roots.push({ node: { ...node }, pose: worldPose(doc, id), centre: { ...geometry.worldBoundsCenter(doc, node) } });
        }
        this.roots = roots; this.fingerprints = [...fingerprints.values()]; this.host = doc.host;
        const moving = new Set<NodeId>(selected), pending: NodeId[] = [...selected];
        for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
            for (const child of childrenOf(doc, next as ParentId)) if (!moving.has(child.id)) { moving.add(child.id); pending.push(child.id); }
        }
        this.moving = moving;
    }
    // A connector moved with none of the shapes it is bound to is a free arrow: its bound ends would re-resolve to their
    // targets, so the body never moved (measured: a bound arrow dragged alone stayed put and stayed bound). With a bound shape
    // in the move, both bindings persist, as they do when the shape is dragged on its own.
    private detachUnmovedEnds(node: Readonly<ConnectorNode>, ops: Op[]): void {
        if ([node.start.attach, node.end.attach].some(attach => attach && this.moving.has(attach.target))) return;
        for (const terminal of ['start', 'end'] as const) {
            if (!node[terminal].attach) continue;
            const local = worldToLocal(this.doc, node, this.geometry.resolvedTip(this.doc, node, terminal));
            ops.push({ t: 'set', id: node.id, key: terminal, value: { x: local.x, y: local.y, attach: null } });
        }
    }
    private validate(): void {
        if (this.cancelled || this.doc.host !== this.host) throw new TransformInvalidated();
        for (const record of this.fingerprints) {
            const current = this.doc.nodes.get(record.id);
            if (!current || record.values.some(([key, value]) => !Object.is((current as unknown as Record<string, unknown>)[key], value))) {
                this.cancelled = true; throw new TransformInvalidated();
            }
        }
    }
    preview(worldDelta: Vec2, shift = false): TranslationPreview {
        this.validate();
        const delta = constrainedTranslation(worldDelta, shift), ops: Op[] = [];
        for (const root of this.roots) {
            const desired = { x: root.pose.x + delta.x, y: root.pose.y + delta.y, rotation: root.pose.rotation };
            const geometry: ChangeGeometry = { resolvedTip: (doc, connector, terminal) => this.geometry.resolvedTip(doc, connector, terminal),
                worldBoundsCenter: () => ({ x: root.centre.x + delta.x, y: root.centre.y + delta.y }) };
            if (root.node.kind === 'connector') this.detachUnmovedEnds(root.node, ops);
            const next = poseInParent(this.doc, root.node, root.node.parent, desired, geometry);
            if (next.page !== root.node.page) ops.push({ t: 'set', id: root.node.id, key: 'page', value: next.page });
            if (next.x !== root.node.x) ops.push({ t: 'set', id: root.node.id, key: 'x', value: next.x });
            if (next.y !== root.node.y) ops.push({ t: 'set', id: root.node.id, key: 'y', value: next.y });
        }
        return { ops, delta };
    }
    transaction(worldDelta: Vec2, shift = false): Transaction {
        return { origin: 'tool', label: 'Move selection', ops: this.preview(worldDelta, shift).ops };
    }
    cancel(): void { this.cancelled = true; }
}
