import type { NodeId } from '../model/ids';
import { spliceRichText, type RichFragment } from '../text/richText';
import type { Op } from './ops';

/** Each inverse is paired with its forward op, including native-token restoration. */
export interface HistoryOperation { readonly forward: Op; readonly inverse: readonly Op[] }
function key(op: Op): string | null {
    switch (op.t) {
        case 'set': return `n\0${op.id}\0${op.key}`;
        case 'board': return `b\0${op.key}`;
        case 'sheet': return op.op === 'set' ? `s\0${op.id}\0${op.key}` : null;
        case 'ext': return `e\0${op.target}\0${op.id ?? ''}`;
        default: return null;
    }
}
function textLength(text: RichFragment): number {
    let length = text.blocks.length - 1;
    for (const block of text.blocks) for (const run of block.runs) length += run.text.length;
    return length;
}
function mergeSplices(first: HistoryOperation, last: HistoryOperation): HistoryOperation | undefined {
    const a = first.forward, b = last.forward;
    if (a.t !== 'splice' || b.t !== 'splice' || a.id !== b.id || a.key !== b.key) return;
    const original = first.inverse[0], previous = last.inverse[0];
    if (original?.t !== 'splice' || previous?.t !== 'splice' || !original.wholeBlocks || !previous.wholeBlocks
        || original.id !== a.id || previous.id !== a.id || original.key !== a.key || previous.key !== a.key
        || original.from !== previous.from) return;
    try {
        const relativeFrom = b.from - previous.from, relativeTo = b.to - previous.from;
        if (relativeFrom < 0 || relativeTo > textLength(previous.insert)) return;
        const next = spliceRichText(previous.insert, relativeFrom, relativeTo, b.insert, b.wholeBlocks === true || b.replaceBlocks === true).text;
        const forward: Op = { t: 'splice', id: a.id, key: a.key, from: original.from,
            to: original.from + textLength(original.insert), insert: next, wholeBlocks: true };
        const inverse: Op = { ...original, to: previous.to };
        return { forward, inverse: [inverse, ...first.inverse.slice(1)] };
    } catch { return; }
}

/** One instance per segment between history savepoints. */
export class OperationCoalescer {
    private readonly slots = new Map<string, number>();
    constructor(private readonly entries: HistoryOperation[], private readonly start: number) {}
    add(operation: HistoryOperation): void {
        const index = this.entries.length - 1;
        if (index >= this.start) {
            const merged = mergeSplices(this.entries[index], operation);
            if (merged) { this.entries[index] = merged; return; }
        }
        const id = key(operation.forward);
        if (id !== null) {
            const previous = this.slots.get(id);
            if (previous !== undefined) {
                this.entries[previous] = { forward: operation.forward, inverse: this.entries[previous].inverse };
                return;
            }
            this.slots.set(id, this.entries.length);
        } else this.slots.clear();
        this.entries.push(operation);
    }
}

export function operationOwner(op: Op): NodeId | undefined {
    if (op.t === 'create') return op.node.id;
    if (op.t === 'delete' || op.t === 'set' || op.t === 'splice') return op.id;
    if (op.t === 'ext' && op.target === 'node') return op.id as NodeId | undefined;
    return undefined;
}
/** Check references in both directions before removing any caller-owned history. */
export function mentionsNode(operation: HistoryOperation, id: NodeId): boolean {
    const pending: unknown[] = [operation.forward, ...operation.inverse], seen = new Set<object>();
    while (pending.length) {
        const value = pending.pop();
        if (typeof value === 'string' && value.includes(id)) return true;
        if (!value || typeof value !== 'object' || seen.has(value)) continue;
        seen.add(value);
        if (value instanceof Map) for (const [key, item] of value) pending.push(key, item);
        else if (Array.isArray(value)) for (const item of value) pending.push(item);
        else for (const item of Object.values(value)) pending.push(item);
    }
    return false;
}

/** Remove a created-and-deleted node only if no surviving operation refers to it. */
export function cancelTransientNodes(entries: readonly HistoryOperation[]): HistoryOperation[] {
    const created = new Set<NodeId>(), deleted = new Set<NodeId>();
    for (const { forward } of entries) {
        if (forward.t === 'create') created.add(forward.node.id);
        else if (forward.t === 'delete') deleted.add(forward.id);
    }
    const candidates = new Set([...created].filter(id => deleted.has(id)));
    if (!candidates.size) return [...entries];
    const blocked = new Set<NodeId>();
    for (const operation of entries) {
        const target = operationOwner(operation.forward), pending: unknown[] = [operation.forward, ...operation.inverse];
        const seen = new Set<object>();
        while (pending.length) {
            const value = pending.pop();
            if (typeof value === 'string') {
                if (value !== target && candidates.has(value as NodeId)) blocked.add(value as NodeId);
            } else if (value && typeof value === 'object' && !seen.has(value)) {
                seen.add(value);
                if (value instanceof Map) for (const [k, v] of value) pending.push(k, v);
                else if (Array.isArray(value)) for (const element of value) pending.push(element);
                else for (const property of Object.values(value)) pending.push(property);
            }
        }
    }
    return entries.filter(entry => { const id = operationOwner(entry.forward); return id === undefined || !candidates.has(id) || blocked.has(id); });
}
