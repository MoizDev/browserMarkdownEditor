import { childrenOf, hasOpaqueDescendant, isSheetParent, sheetOf, type BoardDoc } from '../model/doc';
import type { NodeId, SheetId } from '../model/ids';
import type { Attachment, ConnectorNode, Node, Point, PolylineNode } from '../model/nodes';
import { needsRekey } from '../model/orderKey';
import type { Op, OpSink, TouchedSet } from './ops';
import { finitePoint, requireGeometry, worldToLocal, type ChangeGeometry } from './coordinates';
import { ApplyFailed } from './errors';
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

/** A connector end or a polyline end: both carry one Attachment per terminal, stored differently. */
function attachmentOf(node: ConnectorNode | PolylineNode, terminal: 'start' | 'end'): Attachment | null | undefined {
    return node.kind === 'connector' ? node[terminal].attach : terminal === 'start' ? node.startAttach : node.endAttach;
}

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
    const attached = new Set<NodeId>();
    const visit = (node: Node) => {
        if (node.kind === 'connector' || node.kind === 'polyline') attached.add(node.id);
        for (const id of doc.attachedTo.get(node.id) ?? []) attached.add(id);
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
    for (const id of attached) {
        const node = doc.nodes.get(id);
        if (!node || (node.kind !== 'connector' && node.kind !== 'polyline') || !usableOrigin(node)) continue;
        // A tip is resolved from every shape the line is bound to. Once one of them is gone (deleted by an earlier op of this
        // same change, which captured both tips while both shapes stood) the line has no geometry to read, and the read failed
        // the whole change as a fault of the session: erasing the border of a frame that held two shapes joined by an arrow, or
        // deleting such a frame or both shapes, put "Could not open canvas: Geometry unavailable … connector target is pending"
        // in the board's place (measured: 3 of 3, also on the build before the eraser's rewrite). The earlier capture stands.
        if ((['start', 'end'] as const).some(terminal => { const bound = attachmentOf(node, terminal); return !!bound && !doc.nodes.has(bound.target); })) continue;
        for (const terminal of ['start', 'end'] as const) {
            const attachment = attachmentOf(node, terminal);
            if (!attachment) continue;
            const target = doc.nodes.get(attachment.target);
            if (!target || !usableOrigin(target) || sheetOf(doc, target.id) !== sheetOf(doc, node.id)) continue;
            const reader = requireGeometry(geometry);
            if (node.kind === 'polyline' && !reader.resolvedPolylineTip) throw new ApplyFailed('geometry-required', 'Polyline attachments need the session polyline reader');
            const tip = node.kind === 'connector' ? reader.resolvedTip(doc, node, terminal) : reader.resolvedPolylineTip!(doc, node, terminal);
            captured.push({ id, terminal, attachment, world: finitePoint(tip) });
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
        if (node?.kind === 'connector') {
            detach(node, 'start', pair.start);
            detach(node, 'end', pair.end);
        } else if (node?.kind === 'polyline') detachPolyline(node, pair);
    }
    function detach(node: ConnectorNode, terminal: 'start' | 'end', captured: CapturedEnd | undefined): void {
        const attachment = node[terminal].attach;
        if (!attachment || captured?.attachment !== attachment) return;
        if (doc.nodes.has(attachment.target) && sheetOf(doc, node.id) === sheetOf(doc, attachment.target)) return;
        const point = worldToLocal(doc, node, captured.world);
        builder.push({ t: 'set', id: node.id, key: terminal, value: { x: point.x, y: point.y, attach: null } });
    }
    // A polyline's ends live in its points array, so both moved ends share one points write.
    function detachPolyline(node: PolylineNode, pair: { start?: CapturedEnd; end?: CapturedEnd }): void {
        const points = node.points.map(point => ({ ...point }));
        let moved = false;
        for (const terminal of ['start', 'end'] as const) {
            const attachment = attachmentOf(node, terminal), captured = pair[terminal];
            if (!attachment || captured?.attachment !== attachment) continue;
            if (doc.nodes.has(attachment.target) && sheetOf(doc, node.id) === sheetOf(doc, attachment.target)) continue;
            const index = terminal === 'start' ? 0 : points.length - 1;
            if (index < 0) continue;
            const point = worldToLocal(doc, node, captured.world);
            points[index] = { x: point.x, y: point.y }; moved = true;
            builder.push({ t: 'set', id: node.id, key: terminal === 'start' ? 'startAttach' : 'endAttach', value: null });
        }
        if (moved) builder.push({ t: 'set', id: node.id, key: 'points', value: points });
    }
}
