import { childrenOf, hasOpaqueDescendant, isSheetParent, sheetOf, type BoardDoc } from '../model/doc';
import type { NodeId, SheetId } from '../model/ids';
import type { Attachment, ConnectorNode, Node, Point } from '../model/nodes';
import { needsRekey } from '../model/orderKey';
import type { Op, OpSink, TouchedSet } from './ops';
import { finitePoint, requireGeometry, worldToLocal, type ChangeGeometry } from './coordinates';
import { rekeyParent, rekeySheets, stageReparent, setIfChanged } from './commands';

export interface CapturedEnd {
    readonly id: NodeId;
    readonly terminal: 'start' | 'end';
    readonly attachment: Attachment;
    readonly world: Point;
}
export interface NormalizationStep {
    readonly op: Op;
    readonly touched: TouchedSet;
    readonly captured: readonly CapturedEnd[];
}
const NO_ENDS: readonly CapturedEnd[] = Object.freeze([]);

// The last painted tip is captured WHILE the target still exists and its sheet
// still agrees with the connector (geometry §8.5). Captures live on ordinary staged
// entries, so savepoint rollback discards them without another restoration journal.
export function captureBeforeChange(doc: BoardDoc, op: Op, geometry?: ChangeGeometry): readonly CapturedEnd[] {
    if (op.t !== 'delete' && !(op.t === 'set' && (op.key === 'parent' || op.key === 'page'))) return NO_ENDS;
    const root = doc.nodes.get(op.id);
    if (!root) return NO_ENDS; // The validator supplies the actual refusal.
    if (op.t === 'set') {
        if (op.key === 'parent' && sheetOf(doc, root.id) === sheetOf(doc, op.value)) return NO_ENDS;
        // Accommodate paired page=-1, parent writes in either order. A negative
        // root page is a temporary state, not an origin on page zero to capture.
        if (op.key === 'page' && !(doc.kind !== 'whiteboard' && isSheetParent(doc, root.parent) && op.value === -1)) return NO_ENDS;
    }
    const connectors = new Set<NodeId>();
    const visit = (node: Node) => {
        if (node.kind === 'connector') connectors.add(node.id);
        for (const id of doc.attachedTo.get(node.id) ?? []) connectors.add(id);
        const children = childrenOf(doc, node.id);
        for (let i = 0; i < children.length; i++) visit(children[i]);
    };
    visit(root);
    const captured: CapturedEnd[] = [];
    const usableOrigin = (node: Node): boolean => {
        for (let depth = 0; depth <= 64; depth++) {
            if (isSheetParent(doc, node.parent)) return doc.kind === 'whiteboard' || node.page >= 0;
            const parent = doc.nodes.get(node.parent);
            if (!parent) return false;
            node = parent;
        }
        return false;
    };
    for (const id of connectors) {
        const node = doc.nodes.get(id);
        if (!node || node.kind !== 'connector' || !usableOrigin(node)) continue;
        for (const terminal of ['start', 'end'] as const) {
            const attachment = node[terminal].attach;
            if (!attachment) continue;
            const target = doc.nodes.get(attachment.target);
            if (!target || !usableOrigin(target) || sheetOf(doc, target.id) !== sheetOf(doc, node.id)) continue;
            captured.push({ id, terminal, attachment, world: finitePoint(requireGeometry(geometry).resolvedTip(doc, node, terminal)) });
        }
    }
    return captured.length ? captured : NO_ENDS;
}

export function normalizeChanges(doc: BoardDoc, builder: OpSink, steps: readonly NormalizationStep[], geometry?: ChangeGeometry): void {
    const groups = new Set<NodeId>(), longNodes = new Set<NodeId>(), longSheets = new Set<SheetId>();
    const ends = new Map<NodeId, { start?: CapturedEnd; end?: CapturedEnd }>();
    let index = 0;
    const scan = () => {
        // steps is the builder's live append-only array. Normalization pushes its
        // real follow-on ops through the same validator/inverse/sample path.
        for (; index < steps.length; index++) {
            const step = steps[index], op = step.op;
            for (const end of step.captured) {
                let pair = ends.get(end.id);
                if (!pair) ends.set(end.id, pair = {});
                pair[end.terminal] = end;
            }
            if (op.t === 'create' || op.t === 'delete' || (op.t === 'set' && op.key === 'parent')) {
                for (const id of step.touched.nodes) if (doc.nodes.get(id)?.kind === 'group') groups.add(id);
            }
            if ((op.t === 'create' && needsRekey(op.node.order)) || (op.t === 'set' && op.key === 'order' && needsRekey(op.value))) {
                const node = doc.nodes.get(op.t === 'create' ? op.node.id : op.id);
                if (node && needsRekey(node.order)) longNodes.add(node.id);
            }
            if (op.t === 'sheet' && ((op.op === 'create' && needsRekey(op.sheet.order)) || (op.op === 'set' && op.key === 'order' && needsRekey(op.value)))) longSheets.add(op.op === 'create' ? op.sheet.id : op.id);
        }
    };
    scan();
    while (groups.size || longNodes.size || longSheets.size) {
        if (groups.size) {
            const id = groups.values().next().value!;
            groups.delete(id);
            const group = doc.nodes.get(id);
            if (group?.kind === 'group' && !hasOpaqueDescendant(doc, id)) {
                const children = childrenOf(doc, id);
                if (children.length === 1) {
                    const child = children[0], opacity = child.opacity * group.opacity, locked = child.locked || group.locked;
                    stageReparent(doc, builder, child, group.parent, geometry, group.order);
                    setIfChanged(builder, child, 'opacity', opacity);
                    setIfChanged(builder, child, 'locked', locked);
                }
                if (childrenOf(doc, id).length === 0) builder.push({ t: 'delete', id });
            }
        } else if (longNodes.size) {
            const id = longNodes.values().next().value!;
            longNodes.delete(id);
            const node = doc.nodes.get(id);
            if (node && needsRekey(node.order)) rekeyParent(doc, builder, node.parent);
        } else {
            const id = longSheets.values().next().value!;
            longSheets.delete(id);
            const sheet = doc.sheets.get(id);
            if (sheet && needsRekey(sheet.order)) rekeySheets(doc, builder);
        }
        scan();
    }
    // Both members of a relationship may have moved together. Decide against
    // the FINAL sheet membership, never detach just because one moved first.
    for (const [id, pair] of ends) {
        const node = doc.nodes.get(id);
        if (!node || node.kind !== 'connector') continue;
        detach(node, 'start', pair.start);
        detach(node, 'end', pair.end);
    }
    function detach(node: ConnectorNode, terminal: 'start' | 'end', captured: CapturedEnd | undefined): void {
        const attachment = node[terminal].attach;
        if (!attachment || captured?.attachment !== attachment) return;
        if (doc.nodes.has(attachment.target) && sheetOf(doc, node.id) === sheetOf(doc, attachment.target)) return;
        const point = worldToLocal(doc, node, captured.world);
        builder.push({ t: 'set', id: node.id, key: terminal, value: { x: point.x, y: point.y, attach: null } });
    }
}
