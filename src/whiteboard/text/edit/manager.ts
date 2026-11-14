import type { NodeId, ParentId, SheetId } from '../../model/ids';
import { richTextOperations } from '../richOperations';
import { bindTextEditor } from './binding';
import type { EditSelection } from './host';
import type { TextEditBinding } from './bindingTypes';
import type { TextEditingManager, TextEditingManagerPorts } from './managerTypes';

/** Pane-owned editor lifecycle; all content and history remain session-owned. */
export function createTextEditingManager(ports: TextEditingManagerPorts): TextEditingManager {
    let current: TextEditBinding | null = null, disposed = false;
    const { session } = ports;
    function editable(id: NodeId): 'text' | 'label' | 'name' | null {
        const node = session.doc.nodes.get(id);
        if (!node || node.locked) return null;
        let parent: ParentId = node.parent;
        for (let depth = 0; depth < 64 && !session.doc.sheets.has(parent as SheetId); depth++) {
            const ancestor = session.doc.nodes.get(parent as NodeId);
            if (!ancestor || ancestor.locked) return null;
            parent = ancestor.parent;
        }
        if (!session.doc.sheets.has(parent as SheetId)) return null;
        if (node.kind === 'text' || node.kind === 'sticky') return 'text';
        if (node.kind === 'figure' || node.kind === 'connector') return 'label';
        return node.kind === 'frame' ? 'name' : null;
    }
    function close(commitComposition = true): void {
        const binding = current;
        current = null;
        binding?.close(commitComposition);
    }
    function start(id: NodeId, selection?: EditSelection, creationToken?: number): boolean {
        if (disposed) return false;
        close();
        const key = editable(id);
        if (!key) return false;
        const item = session.doc.nodes.get(id)!;
        const value = item.kind === 'frame' ? item.name : item.kind === 'text' || item.kind === 'sticky' ? richTextOperations.plain(item.text)
            : item.kind === 'figure' || item.kind === 'connector' ? item.label ? richTextOperations.plain(item.label) : '' : '';
        const initial = selection ?? { anchor: 0, focus: value.length };
        try {
            const supplied = ports.binding(id, key, initial, creationToken);
            const holder: { binding?: TextEditBinding } = {};
            const options = { ...supplied, view: { ...supplied.view, creationToken,
                finish: () => { if (current === holder.binding) current = null; supplied.view.finish(); } } };
            const binding = bindTextEditor(options);
            holder.binding = binding;
            current = binding;
            binding.editor.focus();
            return true;
        } catch (error) { ports.error(error); return false; }
    }
    function create(x: number, y: number, width: number | null): NodeId | null {
        if (disposed) return null;
        close();
        const history = session.history;
        let opened = false;
        try {
            const { node, transaction } = ports.createText(x, y, width);
            if (node.kind !== 'text' || !transaction.ops.some(op => op.t === 'create' && op.node.id === node.id)) throw new Error('Text creation transaction does not create its node');
            history.open('Create text'); opened = true;
            const receipt = session.apply(transaction);
            receipt.release();
            ports.select(node.id);
            const token = history.close(); opened = false;
            start(node.id, { anchor: 0, focus: 0 }, token ?? undefined);
            return node.id;
        } catch (error) {
            if (opened) {
                try { history.cancel(); } catch (rollback) { ports.error(rollback); }
            }
            ports.error(error);
            return null;
        }
    }
    return {
        get current() { return current; },
        start(id, selection) { return start(id, selection); },
        create,
        type(id, text) {
            if (!text || !start(id)) return false;
            current?.insertText(text);
            return true;
        },
        refresh() { current?.refresh(); },
        close,
        dispose() { if (!disposed) { close(); disposed = true; } },
    };
}
