import type { NodeId } from '../../whiteboard/model/ids';
import type { SelectionState } from '../../whiteboard/selection';
import type { BoardAccessibilityItem, BoardAccessibilitySnapshot, BoardAccessibilitySource } from './BoardAccessibility';

export interface AccessibilityWindow {
    readonly sheetName: string;
    readonly total: number;
    readonly items: readonly Readonly<{ id: NodeId; label: string }>[];
}
export interface AccessibilityWindowSource {
    getSnapshot(): AccessibilityWindow;
    subscribe(listener: () => void): () => void;
    label(id: NodeId): string | null;
    rank(id: NodeId): number;
}

// The scene supplies its bounded viewport window; selection contributes at most
// 500 extra entries, not a synchronous document walk on every focus change.
export function selectionAccessibility(selection: SelectionState, window: AccessibilityWindowSource): BoardAccessibilitySource {
    return {
        getSnapshot(): BoardAccessibilitySnapshot {
            const view = window.getSnapshot(), state = selection.getSnapshot(), selected = new Set(state.selected);
            const byId = new Map<NodeId, BoardAccessibilityItem>();
            for (const item of view.items) byId.set(item.id, { id: item.id, label: item.label, selected: selected.has(item.id) });
            for (const id of state.selected.slice(0, 500)) {
                if (byId.has(id)) continue;
                const label = window.label(id);
                if (label !== null) byId.set(id, { id, label, selected: true });
            }
            if (state.active && !byId.has(state.active)) {
                const label = window.label(state.active);
                if (label !== null) byId.set(state.active, { id: state.active, label, selected: true });
            }
            const items = [...byId.values()].sort((a, b) => window.rank(a.id as NodeId) - window.rank(b.id as NodeId) || a.id.localeCompare(b.id));
            return { sheetName: view.sheetName, total: view.total, items, selectedCount: state.selected.length, focusedId: state.active };
        },
        subscribe(listener) {
            const a = selection.subscribe(listener), b = window.subscribe(listener);
            return () => { a(); b(); };
        },
    };
}
