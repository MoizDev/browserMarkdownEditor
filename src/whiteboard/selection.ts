import { childrenOf, sheetOf } from './model/doc';
import type { BoardDoc } from './model/doc';
import type { NodeId, ParentId, SheetId } from './model/ids';

export interface SelectionSnapshot {
    readonly sheet: SheetId;
    readonly focus: ParentId;
    readonly selected: readonly NodeId[];
    readonly active: NodeId | null;
}

// Selection is session state, not a document operation or a separate undo step.
export class SelectionState {
    private snapshot: SelectionSnapshot;
    private readonly listeners = new Set<() => void>();
    constructor(sheet: SheetId) { this.snapshot = Object.freeze({ sheet, focus: sheet, selected: Object.freeze([]), active: null }); }
    getSnapshot = (): SelectionSnapshot => this.snapshot;
    subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
    private publish(sheet: SheetId, focus: ParentId, selected: readonly NodeId[], active: NodeId | null): void {
        const ids = Object.freeze([...new Set(selected)]);
        if (active !== null && !ids.includes(active)) throw new RangeError('Active selection must be selected');
        const old = this.snapshot;
        if (old.sheet === sheet && old.focus === focus && old.active === active && old.selected.length === ids.length && old.selected.every((id, i) => id === ids[i])) return;
        this.snapshot = Object.freeze({ sheet, focus, selected: ids, active });
        for (const listener of this.listeners) listener();
    }
    setSheet(sheet: SheetId): void { this.publish(sheet, sheet, [], null); }
    setFocus(focus: ParentId): void { this.publish(this.snapshot.sheet, focus, [], null); }
    setScope(focus: ParentId, ids: readonly NodeId[], active: NodeId | null = ids[ids.length - 1] ?? null): void { this.publish(this.snapshot.sheet, focus, ids, active); }
    replace(ids: readonly NodeId[], active: NodeId | null = ids[ids.length - 1] ?? null): void { this.publish(this.snapshot.sheet, this.snapshot.focus, ids, active); }
    clear(): void { this.replace([]); }
    reconcile(doc: BoardDoc): void {
        const { sheet, selected, active } = this.snapshot;
        if (!doc.sheets.has(sheet)) { this.clear(); return; }
        const focus = this.snapshot.focus === sheet || sheetOf(doc, this.snapshot.focus) === sheet ? this.snapshot.focus : sheet;
        const eligible = selected.filter(id => selectableAtFocus(doc, id, focus, sheet) === id);
        this.publish(sheet, focus, eligible, active !== null && eligible.includes(active) ? active : eligible[eligible.length - 1] ?? null);
    }
    toggle(id: NodeId): void {
        const ids = this.snapshot.selected;
        if (ids.includes(id)) {
            const next = ids.filter(item => item !== id);
            this.replace(next, this.snapshot.active === id ? next[next.length - 1] ?? null : this.snapshot.active);
        } else this.replace([...ids, id], id);
    }
}

// Reject locked ancestors before promoting an unentered group; frames do not promote children.
export function selectableAtFocus(doc: BoardDoc, id: NodeId, focus: ParentId, sheet: SheetId, includeLocked = false): NodeId | null {
    if (sheetOf(doc, id) !== sheet) return null;
    let node = doc.nodes.get(id), candidate = node?.id ?? null, reached = false;
    for (let depth = 0; node && depth <= 64; depth++) {
        if (!includeLocked && node.locked) return null;
        if (node.parent === focus) reached = true;
        if (node.id === focus) reached = true;
        const parent = doc.nodes.get(node.parent as NodeId);
        if (!reached && parent?.kind === 'group' && parent.id !== focus) candidate = parent.id;
        node = parent;
    }
    return reached ? candidate : null;
}
export function selectAllAtFocus(doc: BoardDoc, sheet: SheetId, focus: ParentId): readonly NodeId[] {
    if (sheetOf(doc, focus) !== sheet && focus !== sheet) return [];
    return childrenOf(doc, focus).filter(node => selectableAtFocus(doc, node.id, focus, sheet) === node.id).map(node => node.id);
}

export function enterGroup(doc: BoardDoc, selection: SelectionState, group: NodeId, child: NodeId): boolean {
    const state = selection.getSnapshot(), node = doc.nodes.get(group);
    if (!node || node.kind !== 'group' || selectableAtFocus(doc, group, state.focus, state.sheet) !== group) return false;
    const resolved = selectableAtFocus(doc, child, group, state.sheet);
    if (!resolved || resolved === group) return false;
    selection.setScope(group, [resolved]);
    return true;
}
export function selectFirstChild(doc: BoardDoc, selection: SelectionState): boolean {
    const state = selection.getSnapshot(), id = state.active, node = id ? doc.nodes.get(id) : undefined;
    if (!node || node.kind !== 'group') return false;
    const child = childrenOf(doc, node.id).find(item => selectableAtFocus(doc, item.id, node.id, state.sheet) === item.id);
    if (!child) return false;
    selection.setScope(node.id, [child.id]);
    return true;
}
export function selectParent(doc: BoardDoc, selection: SelectionState): boolean {
    const state = selection.getSnapshot(), focus = doc.nodes.get(state.focus as NodeId);
    if (!focus || focus.kind !== 'group') return false;
    const parentFocus = focus.parent;
    if (selectableAtFocus(doc, focus.id, parentFocus, state.sheet) !== focus.id) return false;
    selection.setScope(parentFocus, [focus.id]);
    return true;
}
export function escapeSelection(doc: BoardDoc, selection: SelectionState): void {
    const state = selection.getSnapshot();
    if (state.selected.length) { selection.clear(); return; }
    const focus = doc.nodes.get(state.focus as NodeId);
    if (focus) selection.setFocus(focus.parent);
}
