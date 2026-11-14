import { createApplyController, type ApplyController } from '../change/apply';
import type { TouchedSet } from '../change/ops';
import { createBoardDoc, type BoardDoc, type BoardDocInput } from '../model/doc';
import { isValidId, type NodeId } from '../model/ids';
import { isValidKey } from '../model/orderKey';
import type { SampleStoreReader } from '../model/samples';
import { validateCommit, validateOp } from '../model/validate';

export interface ImportedBoard { readonly doc: BoardDoc; readonly apply: ApplyController }

// The importer repairs ordered records first; only then may the model build its indexed tables.
export function admitImportedBoard(input: BoardDocInput, samples: SampleStoreReader): ImportedBoard {
    const sheets = Array.from(input.sheets), nodes = Array.from(input.nodes ?? []), media = Array.from(input.media ?? []);
    if (!sheets.length) throw new Error('A board needs a sheet');
    const ids = new Set<string>();
    for (const sheet of sheets) {
        if (!isValidId(sheet.id) || ids.has(sheet.id) || !isValidKey(sheet.order)
            || !sheet.name.trim() || sheet.name.length > 200) throw new Error('Invalid or duplicate imported sheet');
        ids.add(sheet.id);
    }
    for (const node of nodes) {
        if (!isValidId(node.id) || ids.has(node.id)) throw new Error('Invalid or duplicate imported node');
        ids.add(node.id);
    }
    const doc = createBoardDoc({ ...input, sheets, nodes, media });
    const context = { doc, samples, origin: 'host' as const };
    for (const node of nodes) {
        if (node.kind === 'opaque') throw new Error('Opaque legacy node requires explicit loss handling');
        for (const [key, value] of Object.entries(node)) {
            if (key === 'id' || key === 'kind' || key === 'ext') continue;
            const result = validateOp(context, { t: 'set', id: node.id, key, value }, 0);
            if (!result.ok) throw new Error(`${node.id}: ${result.reason}`);
        }
    }
    const touched: TouchedSet = { nodes: new Set<NodeId>(nodes.map(node => node.id)), sheets: new Set(), board: new Set(), media: new Set() };
    const final = validateCommit(context, touched, [], 0);
    if (!final.ok) throw new Error(final.reason);
    return { doc, apply: createApplyController(doc, samples) };
}
