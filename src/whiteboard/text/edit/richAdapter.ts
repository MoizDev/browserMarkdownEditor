import type { Transaction } from '../../change/ops';
import type { NodeId } from '../../model/ids';
import type { Block, Marks, RichEdit, RichFragment, RichText, RichTextOperations } from '../rich';
import type { ToggleMark } from './format';
import type { EditSelection } from './host';

// TX-2 owns all rich-text transformations. The editor adapts its immutable
// fragments to the single transaction/apply path without another model.
export function richEditAdapter(id: NodeId, key: 'text' | 'label', read: () => RichText, rich: RichTextOperations) {
    const splice = (from: number, to: number, insert: RichFragment, label: string, replaceBlocks?: true): Transaction => ({
        origin: 'tool', label, ops: [{ t: 'splice', id, key, from, to, insert, ...(replaceBlocks ? { replaceBlocks } : {}) }],
    });
    const edit = (result: RichEdit, label: string) => ({
        transaction: splice(result.from, result.to, result.insert, label, result.replaceBlocks), selection: result.selection,
    });
    return {
        readText: read,
        plainText: () => rich.plain(read()),
        marksAt: (offset: number) => rich.marksAt(read(), offset),
        fragment: (from: number, value: string, marks: Marks | null) => rich.insertionFragment(read(), from, value, marks),
        format: (mark: ToggleMark, from: number, to: number) => from === to ? null : splice(from, to, rich.toggleMark(read(), from, to, mark), 'Format text'),
        link: (url: string, from: number, to: number) => from === to ? null : splice(from, to, rich.applyLink(read(), from, to, url), 'Apply text link'),
        enter: (selection: EditSelection) => edit(rich.enter(read(), selection), 'Enter paragraph'),
        blocks: (selection: EditSelection, kind: Block['kind'] | 'indent' | 'outdent') =>
            edit(rich.blocks(read(), Math.min(selection.anchor, selection.focus), Math.max(selection.anchor, selection.focus), kind), 'Format text blocks'),
    };
}
