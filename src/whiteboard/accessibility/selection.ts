import type { NodeId } from '../model/ids';
import type { SelectionState } from '../selection';

export interface BoardAccessibilityItem {
    readonly id: string; readonly label: string; readonly selected: boolean;
    readonly name: string; readonly kind: string; readonly locked: boolean; readonly order: number;
}
export interface BoardAccessibilitySnapshot {
    readonly sheetName: string; readonly total: number; readonly items: readonly BoardAccessibilityItem[];
    readonly selectedCount: number; readonly focusedId: string | null;
}
export interface BoardAccessibilitySource {
    getSnapshot(): BoardAccessibilitySnapshot;
    subscribe(listener: () => void): () => void;
}

export interface AccessibilityNode {
    readonly id: NodeId; readonly name: string; readonly kind: string; readonly locked: boolean; readonly order: number;
}
export interface AccessibilityWindow {
    readonly sheetName: string;
    readonly total: number;
    readonly items: readonly AccessibilityNode[];
}
export interface AccessibilityWindowSource {
    getSnapshot(): AccessibilityWindow;
    subscribe(listener: () => void): () => void;
    node(id: NodeId): AccessibilityNode | null;
    label(node: AccessibilityNode): string;
}

// The scene supplies its bounded viewport window; selection contributes at most
// 500 extra entries, not a synchronous document walk on every focus change.
export function selectionAccessibility(selection: SelectionState, window: AccessibilityWindowSource): BoardAccessibilitySource {
    return {
        getSnapshot(): BoardAccessibilitySnapshot {
            const view = window.getSnapshot(), state = selection.getSnapshot(), selected = new Set(state.selected);
            const byId = new Map<NodeId, BoardAccessibilityItem>();
            const put = (node: AccessibilityNode) => byId.set(node.id, { ...node, selected: selected.has(node.id), label: window.label(node) });
            for (const item of view.items) put(item);
            for (const id of state.selected.slice(0, 500)) {
                if (byId.has(id)) continue;
                const node = window.node(id);
                if (node) put(node);
            }
            if (state.active && !byId.has(state.active)) {
                const node = window.node(state.active);
                if (node) put(node);
            }
            const items = [...byId.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
            return { sheetName: view.sheetName, total: view.total, items, selectedCount: state.selected.length, focusedId: state.active };
        },
        subscribe(listener) {
            const a = selection.subscribe(listener), b = window.subscribe(listener);
            return () => { a(); b(); };
        },
    };
}
