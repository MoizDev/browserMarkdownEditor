import type { Applied } from '../change/ops';
import type { BoardDoc } from '../model/doc';
import type { NodeId, SheetId } from '../model/ids';

export const enum SceneDirtyFlag {
    Paint = 1, Geometry = 2, Placement = 4, Order = 8, Inherited = 16,
    Bounds = 32, Text = 64, Structure = 128,
}
export interface SceneDirty {
    readonly nodes: ReadonlyMap<NodeId, number>;
    readonly sheets: ReadonlySet<SheetId>;
    readonly pages: boolean;
}
const GEOMETRY = SceneDirtyFlag.Paint | SceneDirtyFlag.Geometry | SceneDirtyFlag.Bounds;
const STRUCTURE = GEOMETRY | SceneDirtyFlag.Structure | SceneDirtyFlag.Order | SceneDirtyFlag.Placement | SceneDirtyFlag.Inherited;
function property(key: string, stroke = false): number {
    switch (key) {
        // C4's broad impact flags intentionally serve many consumers. Scene classifies the
        // actual forward keys so translating a 1M-point stroke never invalidates tessellation.
        case 'x': case 'y': case 'rotation': return SceneDirtyFlag.Paint | SceneDirtyFlag.Placement | SceneDirtyFlag.Bounds;
        case 'parent': case 'page': return SceneDirtyFlag.Paint | SceneDirtyFlag.Structure | SceneDirtyFlag.Order | SceneDirtyFlag.Placement | SceneDirtyFlag.Bounds | SceneDirtyFlag.Inherited;
        case 'order': return SceneDirtyFlag.Paint | SceneDirtyFlag.Order;
        case 'opacity': case 'locked': return SceneDirtyFlag.Paint | SceneDirtyFlag.Inherited;
        case 'color': case 'labelColor': case 'complete': case 'tool': return SceneDirtyFlag.Paint;
        case 'fill': return stroke ? SceneDirtyFlag.Paint : GEOMETRY;
        case 'text': case 'label': case 'font': case 'size': case 'align': case 'valign': case 'autoSize':
            return GEOMETRY | SceneDirtyFlag.Text;
        default: return GEOMETRY;
    }
}
export function sceneDirty(applied: Applied, doc: BoardDoc): SceneDirty {
    const nodes = new Map<NodeId, number>(), sheets = new Set(applied.touched.sheets), queue: NodeId[] = [];
    const add = (id: NodeId, flags: number) => {
        const old = nodes.get(id) ?? 0, next = old | flags;
        if (next !== old) { nodes.set(id, next); queue.push(id); }
    };
    let pages = false;
    for (const op of applied.forward) {
        switch (op.t) {
            case 'create': add(op.node.id, STRUCTURE); break;
            case 'delete': add(op.id, STRUCTURE); break;
            case 'set': add(op.id, property(op.key, doc.nodes.get(op.id)?.kind === 'stroke')); break;
            case 'splice': add(op.id, GEOMETRY | SceneDirtyFlag.Text); break;
            case 'board': if (op.key === 'host.paper') pages = true; break;
            case 'sheet': sheets.add(op.op === 'create' ? op.sheet.id : op.id); break;
            case 'media':
                for (const id of doc.mediaRefs.get(op.op === 'add' ? op.entry.id : op.id) ?? []) add(id, SceneDirtyFlag.Paint);
                break;
            case 'ext': break; // Preserved unknown tokens are not a second authoring/style channel.
        }
    }
    for (const id of applied.touched.nodes) if (!nodes.has(id)) add(id, SceneDirtyFlag.Paint);
    for (let i = 0; i < queue.length; i++) {
        const id = queue[i], flags = nodes.get(id)!;
        if (flags & (SceneDirtyFlag.Geometry | SceneDirtyFlag.Placement | SceneDirtyFlag.Structure)) {
            for (const attached of doc.attachedTo.get(id) ?? []) add(attached, GEOMETRY);
        }
    }
    return { nodes, sheets, pages };
}
