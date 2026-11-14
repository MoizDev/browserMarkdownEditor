import { isLocked } from '../change/commands';
import { poseInParent, worldPose } from '../change/coordinates';
import type { ChangeGeometry, WorldPose } from '../change/coordinates';
import type { Op, Transaction } from '../change/ops';
import { isSheetParent } from '../model/doc';
import type { BoardDoc } from '../model/doc';
import type { NodeId } from '../model/ids';
import type { Node } from '../model/nodes';
import type { Vec2 } from './path';
import { constrainedTranslation } from './transforms';

export class TransformInvalidated extends Error {
    constructor() { super('The selection changed during the transform'); this.name = 'TransformInvalidated'; }
}
interface RootSnapshot { readonly node: Readonly<Node>; readonly pose: WorldPose; readonly centre: Vec2 }
interface Fingerprint { readonly id: NodeId; readonly values: readonly (readonly [string, unknown])[] }
export interface TranslationPreview { readonly ops: readonly Op[]; readonly delta: Vec2 }

// This plan is immutable with respect to the document: each preview is rebuilt
// from pointer-down records, and a changed root or ancestor invalidates it.
export class TranslationPlan {
    private readonly roots: readonly RootSnapshot[];
    private readonly fingerprints: readonly Fingerprint[];
    private readonly host: BoardDoc['host'];
    private cancelled = false;
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
