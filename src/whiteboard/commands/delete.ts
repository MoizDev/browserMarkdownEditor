import { deleteNodes } from '../change/commands';
import type { DeleteResult } from '../change/commands';
import type { ChangeGeometry } from '../change/coordinates';
import { ApplyRefused } from '../change/errors';
import type { CommandBuilder } from '../change/ops';
import { hasOpaqueDescendant, sheetOf } from '../model/doc';
import type { BoardDoc } from '../model/doc';
import type { NodeId, SheetId } from '../model/ids';

export class DeleteRefused extends ApplyRefused {
    constructor(error: ApplyRefused) {
        super({ ok: false, code: error.code, opIndex: error.opIndex, nodeId: error.nodeId,
            reason: error.nodeId ? `${error.reason}: ${error.nodeId}` : error.reason });
        this.name = 'DeleteRefused';
    }
}
function refuse(code: ConstructorParameters<typeof ApplyRefused>[0]['code'], reason: string, id: string | null): never {
    throw new DeleteRefused(new ApplyRefused({ ok: false, code, reason, nodeId: id, opIndex: -1 }));
}

// The model command owns extraction/reparenting and removal in this same builder;
// it also rolls back its savepoint on refusal, so no caller can commit half a delete.
export function planDelete(doc: BoardDoc, builder: CommandBuilder, sheet: SheetId,
    roots: readonly NodeId[], geometry: ChangeGeometry): DeleteResult {
    if (!doc.sheets.has(sheet)) refuse('V-1', 'Sheet does not exist', sheet);
    for (const id of roots) {
        const node = doc.nodes.get(id);
        if (!node || sheetOf(doc, id) !== sheet) refuse('V-1', 'Node is not on this sheet', id);
        if (node.kind === 'opaque' || hasOpaqueDescendant(doc, node.id)) refuse('opaque', 'Opaque content cannot be deleted', id);
    }
    try { return deleteNodes(doc, builder, roots, geometry); }
    catch (error) { if (error instanceof ApplyRefused) throw new DeleteRefused(error); throw error; }
}
